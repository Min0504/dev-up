# DevUp Architecture

**English** | [한국어](ARCHITECTURE.ko.md)

Internal structure documentation for anyone reading the code or contributing.

## Design principles

1. **Separate declaration from execution** — the YAML only declares *what is needed*; how, in what order, and with what tracking is entirely DevUp's job.
2. **Manage only what it created** — every started resource is recorded in a state file with a fingerprint, and shutdown only ever targets what that record contains. There is no code that scans the whole system.
3. **A thin orchestrator** — docker compose manages containers, tmux multiplexes terminals, the OS manages processes. DevUp coordinates them in order and tracks state; it reimplements none of them.
4. **Tolerate partial failure** — when one service fails, whatever came up stays up, only dependents are skipped, and the exit code says so.

## Directory layout

```text
dev-up/
├── bin/            # per-command shims (dev, devup, devdown, ...) → dist/src/cli.js
├── src/
│   ├── cli.ts          # Commander definitions, alias mapping, error → exit code
│   ├── config.ts       # YAML parse/validate, topological sort, env merging
│   ├── orchestrator.ts # the core up / down / restart flows
│   ├── proc.ts         # process start/stop and fingerprint (lstart) checks
│   ├── state.ts        # ~/.devup/state/*.json read/write (atomic)
│   ├── docker.ts       # docker compose integration
│   ├── tmux.ts         # tmux session/window management
│   ├── health.ts       # the 6 health probes + polling
│   ├── status.ts       # live status gathering, rendering, JSON serialization
│   ├── logs.ts         # devlogs (tail / compose logs / fzf picker)
│   ├── doctor.ts       # environment diagnostics
│   ├── commands.ts     # list / init / register / unregister
│   ├── completion.ts   # zsh/bash completion script generation
│   ├── paths.ts        # ~/.devup paths, ~ expansion, relative path resolution
│   └── ui.ts           # ANSI colors, CJK width handling, tables, logger
└── test/           # node:test based (see 'Tests' below)
```

Dependencies point one way: `cli → orchestrator/status/logs/... → docker/tmux/health/proc → state/config/paths/ui`. The only runtime dependencies are `commander` and `yaml`; everything else is Node built-ins plus external CLIs (docker, tmux, fzf).

## Runtime data layout

```text
~/.devup/                  # overridable via DEVUP_HOME
├── projects/              # project configs (yaml files or symlinks into repos)
│   └── myapp.yaml
├── state/                 # per-project runtime state
│   └── myapp.json
└── logs/
    └── myapp/
        ├── backend.log    # command service stdout+stderr
        └── expo.log       # tmux services write here too, via tee
```

### State file schema

```jsonc
// ~/.devup/state/myapp.json — the single ledger of what devup started
{
  "name": "myapp",
  "configPath": "/Users/me/.devup/projects/myapp.yaml",
  "tmuxSession": "myapp",
  "updatedAt": "2026-08-14T01:00:00.000Z",
  "services": {
    "backend": {
      "name": "backend",
      "type": "command",
      "runMode": "background",        // background | tmux | docker | script
      "pid": 12345,
      "pgid": 12345,
      "lstart": "Thu Aug 14 01:00:00 2026",  // ← the key to PID-reuse detection
      "startedAt": "2026-08-14T01:00:00.000Z",
      "logFile": "/Users/me/.devup/logs/myapp/backend.log"
    },
    "postgres": {
      "runMode": "docker",
      "composeService": "postgres",
      "composeFile": "/Users/me/dev/myapp/backend/docker-compose.yml",
      "composeDir": "/Users/me/dev/myapp/backend"
    }
  }
}
```

Writes are always atomic — **write to a tmp file, then rename**. A Ctrl-C never leaves a half-written state file, and everything started up to that point is recorded, so `devdown` can still clean up.

## The devup sequence

```text
load + validate config (config.ts)        on failure → list every problem, exit 2
  ↓
verify `checks` tools exist; if any docker service, verify the daemon
  ↓
topological sort → parallel levels (topoLevels, Kahn's algorithm)
  e.g. [[postgres, redis], [backend], [expo]]
  ↓
per level:
  start each service in parallel
    ├─ docker  → compose up -d <svc>
    ├─ command → detached process group + log file   (proc.spawnBackground)
    ├─ tmux    → run in a tmux window, tee to the log file
    └─ script  → run synchronously to completion; non-zero exit = failure
  record each service's state (pid·pgid·lstart)
  if a healthcheck exists, poll until healthy (health.waitHealthy)
  on failure: mark every dependent service as skipped
  ↓
build the tmux session (shell/logs windows) → print the final status table
  ↓
all good → exit 0 · anything failed → exit 1
```

Already-running services are skipped after a fingerprint check, so `devup` is idempotent. `--only` computes its target set via `dependencyClosure` (selection + transitive dependencies); `devdown --only` uses the mirror image, `dependentClosure` (selection + everything that depends on it) — bring the foundations up with you, take the things standing on you down with you.

## Process safety (proc.ts)

Three layers prevent `devdown` from ever killing someone else's process:

1. **Process groups**: command services start with `detached: true`, getting their own pgid. Stopping sends the signal to `kill(-pgid)` — the whole group — so grandchildren spawned by `npm run dev` are cleaned up too.
2. **lstart fingerprint**: right after spawn, `ps -o lstart= -p <pid>` (the process start time, second resolution) is stored in state. Before signalling, the current lstart is compared — **a mismatch means the PID was reused, so it is left alone** and only the state entry is dropped.
3. **Staged shutdown**: SIGTERM → wait up to `stop_grace` seconds → SIGKILL if still alive. A service with a custom `stop` command runs that first.

docker services never deal with pids at all: `docker compose stop <svc>` addresses exactly that compose service. Containers of other projects on the same Mac belong to different compose projects and are unaffected.

## Health checks (health.ts)

| Type | Probe | Fallback |
|---|---|---|
| `tcp` | socket connect | — |
| `http` | `fetch(url)`, default: status < 500 (pin with `expect_status`) | — |
| `postgres` | `pg_isready` | not on host → `compose exec pg_isready` → plain tcp |
| `redis` | `redis-cli ping` == PONG | same two-stage fallback |
| `docker` | container health from `compose ps` | running state when no HEALTHCHECK defined |
| `command` | arbitrary command, exit 0 | — |

`waitHealthy` polls every `interval` seconds up to `timeout`. `devstatus` prefers the user-defined probe over Docker's own periodic health: if the container still says `starting` but the real probe passes, the service reports `healthy`.

## tmux integration (tmux.ts)

- One session per project (`tmux.session`, default: project name). An existing session is reused; only windows are added or reused.
- A `tmux: true` service runs as `<command> 2>&1 | tee <logfile>` inside its window — screen and log file get the same bytes, so `devlogs` works for tmux services too. The window id is stored in state so exactly that window is cleaned up.
- The `shell` window (project root) and `logs` window (`tail -F` of background logs) can each be toggled.
- Every tmux call honors `DEVUP_TMUX_SOCKET`, letting tests run on an isolated socket without touching the user's tmux server.

## Status gathering (status.ts)

`devstatus` reconciles the state file (the record) against live checks (reality):

```text
pid in state + alive + lstart matches + probe passes   → healthy
pid in state + alive + no probe defined                → running
pid in state + dead                                    → failed (external kill detected)
not in state                                           → stopped
```

It also collects git branch/dirty, ports, uptime, and tmux session existence. `--json` serializes the same structure (a stable schema for external tools).

## Tests (test/)

| File | Covers |
|---|---|
| `config.test.ts` | YAML parsing, validation error messages, topological sort, cycle detection |
| `state.test.ts` | State save/load, atomic writes |
| `proc.test.ts` | spawn/terminate, **refusing to kill a reused PID** |
| `integration.test.ts` | Full lifecycle through the real CLI: up→status→logs→down, idempotency, stale recovery, failure propagation, exit codes |
| `tmux.test.ts` | Real tmux binary: session/window/tee logs/teardown (isolated socket) |
| `docker.test.ts` | Real docker compose: start/health/logs/stop (skipped without a daemon) |

Everything runs under a temporary `DEVUP_HOME` and an isolated tmux socket — the user's real environment is never touched. `npm test` builds and runs the whole suite.
