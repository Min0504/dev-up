# DevUp

**English** | [한국어](README.ko.md)

A personal orchestrator that brings a project's dev environment (Docker, DB, backend, frontend, tmux) **up and down with one command**.

```bash
devup myapp      # start the whole dev environment (dependency order guaranteed)
devstatus myapp  # live status (including health)
devlogs myapp    # service logs (pick with fzf)
devrestart myapp # restart
devdown myapp    # cleanly stop only what devup started
```

- `depends_on` between services — the backend never starts before PostgreSQL is healthy
- **Only stops processes DevUp started** — detects PID reuse (compares `ps lstart`), so it never kills anyone else's process
- Automatic tmux session layout (a window per service + shell + logs)
- TCP / HTTP / PostgreSQL / Redis / Docker health checks
- `--json` output for integration with external tools

## Documentation

| Document | Contents |
|---|---|
| [docs/USAGE.md](docs/USAGE.md) | Full usage — install, YAML schema, every command and flag, recipes |
| [docs/FEATURES.md](docs/FEATURES.md) | Feature catalog — what each feature solves and how it behaves |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Internals — modules, state files, startup sequence, safety design |

## Install

```bash
npm install -g @min0504/dev-up   # installs dev, devup, devdown, devrestart, devstatus, devlogs
```

Or from source:

```bash
git clone https://github.com/Min0504/dev-up.git
cd dev-up
npm install && npm link
```

Requirements: Node ≥ 18. tmux / Docker / fzf are optional (missing tools only disable their feature).

```bash
dev doctor      # check the environment, with fixes for anything wrong
```

Shell completion (including project names):

```bash
echo 'eval "$(dev completion zsh)"' >> ~/.zshrc
```

Uninstall: `npm rm -g @min0504/dev-up`

## Getting started

```bash
dev init myapp                # create a template at ~/.devup/projects/myapp.yaml
dev init --local              # or create ./devup.yaml inside the repo
dev register ./devup.yaml     # symlink a repo-local config into the registry
dev list                      # list registered projects
```

Config resolution order: ① `devup <name>` → `~/.devup/projects/<name>.yaml` ② `devup ./path.yaml` → that file ③ bare `devup` → walk up from the current directory looking for `devup.yaml` (or `.devup.yaml`).

## YAML Schema

Full field reference: [docs/USAGE.md](docs/USAGE.md#yaml-schema-reference). Runnable example: [examples/fullstack.yaml](examples/fullstack.yaml).

```yaml
name: myapp                  # required. [a-z0-9._-]
root: ~/dev/myapp            # required. supports ~ and paths relative to the config file

env:                         # env vars shared by every service (optional)
  NODE_ENV: development
env_file: .env.development   # path relative to root (optional)

checks: [pnpm]               # CLI tools that must exist before devup runs (optional)

services:
  postgres:
    type: docker             # docker | command | script
    compose_file: backend/docker-compose.yml   # omit to use compose's default discovery from cwd
    compose_service: postgres
    healthcheck: postgres    # shorthand (see below)

  backend:
    type: command            # a process devup starts and tracks itself
    cwd: backend             # relative to root
    command: npm run start:dev
    stop: ""                 # (optional) command to run on stop; default is SIGTERM→SIGKILL
    restart: ""              # (optional) custom command for devrestart
    env: { PORT: "3000" }
    depends_on: [postgres]
    auto_start: true         # false = excluded from a plain devup (start via --only)
    stop_grace: 10           # seconds to wait after SIGTERM
    healthcheck:
      type: tcp              # tcp | http | postgres | redis | docker | command
      port: 3000
      timeout: 120           # total seconds to wait for healthy, default 60
      interval: 1            # seconds between probes

  expo:
    type: command
    command: npm start
    tmux: true               # run inside a tmux window → interactive keys work
    depends_on: [backend]
    healthcheck: tcp:8081

  migrate:
    type: script             # runs to completion on every devup; failure blocks dependents
    cwd: backend
    command: npx prisma migrate dev
    depends_on: [postgres]

tmux:
  enabled: true              # default true (auto-disabled when tmux is missing)
  session: myapp             # defaults to the project name
  attach: false              # attach to the session after devup finishes
  shell_window: true         # a shell window opened at the project root
  logs_window: true          # a window tailing background service logs
```

### healthcheck shorthand

| Notation | Meaning |
|---|---|
| `postgres` / `postgres:5433` | `pg_isready` (falls back to running it inside the container, then to TCP) |
| `redis` / `redis:6380` | `redis-cli ping` (same fallback chain) |
| `tcp:8081` | TCP connect |
| `http://localhost:3000/health` | HTTP status < 500 (pin with `expect_status`) |
| `docker` | the container's own HEALTHCHECK status |

## Commands

| Command | Description |
|---|---|
| `devup <p>` | Start in dependency order, waiting for health at each level. `--only backend` (includes dependencies), `--no-deps`, `--no-tmux`, `--force` (restart running ones), `-a` (attach) |
| `devdown <p>` | Stop in reverse order. `--only postgres` also stops **everything that depends on it**. `--keep-tmux` |
| `devrestart <p> [svc]` | Restart the whole project or a single service |
| `devstatus [p]` | Status table (+git branch/dirty, tmux, uptime, ports). Without an argument: summary of all projects. `--json` |
| `devlogs <p> [svc]` | View logs. Omit the service to pick with fzf. `-f` (follow), `-n 200`, `--clear` |
| `dev list / doctor / init / register / unregister / validate / completion` | Management commands |

Statuses: `healthy · running · starting · unhealthy · stopped · failed`
(a live process whose health probe fails shows as unhealthy)

Exit codes: `0` success / `1` partial failure or runtime error / `2` config error or bad usage

## How it works

- **command services**: detached into their own process group, logs at `~/.devup/logs/<p>/<svc>.log`. The PID plus `ps lstart` (process start time) is recorded in state → on devdown, a mismatched start time (PID reuse) means **it is never killed**.
- **tmux: true services**: run in a dedicated tmux window while `tee` writes the same log file. Ideal for services that need keystrokes, like Expo.
- **docker services**: `docker compose up -d <svc>` / `stop <svc>`. Only that compose service is touched, so other projects' containers are untouched.
- **script services**: run to completion on every devup (migrations, etc.). On failure, dependent services do not start.
- If a service fails, its dependents are marked `skipped` and the exit code is 1. Whatever already started stays up → clean up with `devdown`.
- State lives at `~/.devup/state/<p>.json` (atomic writes). Even after Ctrl-C, state written so far survives.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full internals.

## tmux layout

```text
myapp (session)
├── shell   ← project root
├── expo    ← tmux: true service (interactive)
└── logs    ← tail -F of background service logs
```

An existing session is reused (no duplicate windows). `devdown` also cleans up the session; `devrestart` keeps it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Docker daemon is not running` | `open -a Docker`, retry. Check with `dev doctor` |
| A service shows `failed` | `devlogs <p> <svc>` — devup already printed the tail of the log at failure time |
| Health timeout | Raise `healthcheck.timeout` (first boot of nest/expo can be slow) |
| `unknown project` | Check names with `dev list`, create with `dev init <name>` |
| Port conflict | The port column in `devstatus` shows which project holds it |
| Don't want tmux | `tmux.enabled: false` or `devup --no-tmux` |
| Process killed externally | Shows as `failed` in `devstatus`; the next `devup` restarts only that service |

## Moving to a new Mac

All config lives in `~/.devup/projects/*.yaml` (or each repo's `devup.yaml`).

```bash
# old Mac
tar czf devup-config.tgz -C ~ .devup/projects

# new Mac
npm install -g @min0504/dev-up
tar xzf devup-config.tgz -C ~
dev doctor          # see what tools are missing
devup <project>     # if the root moved, adjust the yaml (~-based paths usually just work)
```

Stick to `~`/relative paths instead of absolute ones and configs work unchanged. If a repo ships `devup.yaml`, a single `dev register` is enough.

## Development

```bash
npm run build       # tsc (strict)
npm test            # unit + integration (spawns real processes/tmux/docker)
```

Tests run under isolated `DEVUP_HOME` and `DEVUP_TMUX_SOCKET`, so they never pollute your environment.

## License

[MIT](LICENSE)
