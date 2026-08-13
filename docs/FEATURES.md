# DevUp Features

**English** | [한국어](FEATURES.ko.md)

A catalog of what each feature solves and how it behaves.
For exact flags and schema, see [USAGE.md](USAGE.md); for internals, see [ARCHITECTURE.md](ARCHITECTURE.md).

## One-line up / down

```bash
devup myapp && devdown myapp
```

Instead of repeating the manual dance — check Docker Desktop, `compose up`, wait for the DB, start the backend, start the frontend, arrange terminals — you declare it once in YAML and reproduce the same environment with one command. `devup` is idempotent: running services are skipped and only dead ones are brought back.

## Declarative YAML config

- One project = one YAML file. Keep it in `~/.devup/projects/` or commit `devup.yaml` in the repo and `dev register` it.
- Paths support `~` and relative form, so **a copied config works on another Mac**.
- Typos (unknown keys) become warnings; real errors are collected and reported all at once. `dev validate` checks a config without starting anything.

## Dependency orchestration

Declare a service graph with `depends_on` and you get:

- **Level-parallel startup** via topological sorting — postgres and redis start together; the backend starts only after both are healthy.
- Cycles rejected immediately as config errors.
- On failure, only the services standing on top of the failed one are skipped — a migration never runs against a DB that didn't come up.
- `--only backend` brings needed dependencies with it; `devdown --only postgres` takes down everything that depends on postgres with it.

## Three service types

| Type | For | Lifecycle |
|---|---|---|
| `docker` | one service of a compose stack | `compose up -d` / `stop` — that service only |
| `command` | long-running processes like dev servers | process group + PID tracking, automatic log file |
| `script` | one-shot work like migrations | runs to completion on every `devup`; failure blocks dependents |

## Health checks that mean "actually ready"

A process existing and a service accepting requests are different things.

- Six probes: `tcp` · `http` · `postgres` (pg_isready) · `redis` (PING) · `docker` (container HEALTHCHECK) · `command` (anything)
- Shorthand like `healthcheck: postgres`, tunable `timeout`/`interval`
- Missing pg/redis client on the host? Falls back to running inside the container, then to TCP
- Status is reported on a six-level scale: `healthy / running / starting / unhealthy / stopped / failed`

## Process management that only stops what's yours

Things `devdown` never does: find processes by name, kill by port, `pkill node`.

Each started process's PID, process group, and start time (`ps lstart`) are recorded in a state file; a stop signal is sent only when the time still matches. A reused PID is never killed. SIGTERM comes first, then a grace period (`stop_grace`), then SIGKILL — sent to the whole process group so no children survive.

Killed a service yourself? `devstatus` flags it as `failed`, and the next `devup` restarts just that one.

## Automatic tmux layout

```text
myapp (session)
├── shell   ← a working shell at the project root
├── expo    ← tmux: true service (interactive keys; logs still tee'd to file)
└── logs    ← tail -F of background service logs
```

An existing session is reused, and `devdown` cleans the session up (`--keep-tmux` to keep it). For anything that needs keystrokes — like the Expo CLI — a single `tmux: true` is enough. Without tmux installed, everything runs in background mode instead.

## Logging

- command/tmux services: stdout+stderr → `~/.devup/logs/<project>/<service>.log`
- docker services: delegated to `docker compose logs`
- `devlogs myapp` → pick a service with fzf, `-f` to follow, `-n` for line count, `--clear` to truncate
- When a service fails to start, the tail of its log is printed immediately.

## Status dashboard

```text
myapp                    branch: feat/auth (dirty)   tmux: myapp

● postgres   docker   :5432   healthy   up 2h
● backend    command  :3000   healthy   up 2h   pid 4242
● expo       tmux     :8081   running   up 2h
```

`devstatus` with no argument summarizes every project; `--json` emits the same data with a stable schema for other tools to consume.

## Environment diagnostics (dev doctor)

Checks Node/Git/tmux/Docker CLI + daemon/fzf presence and versions, write access to `~/.devup`, the validity of every registered project config, and whether the CLIs are on PATH — printing a **concrete fix command** for each problem.

## Shell completion

`dev completion zsh|bash` generates a script that completes subcommands and **registered project names**.

## Failing safely

- Config errors: every problem collected, exit 2.
- Partial failures: keep what succeeded, exit 1 — rerun `devup` to retry just the failures.
- Ctrl-C: state is written atomically, so `devdown` still cleans up.
- Docker daemon down, missing tools, etc. are reported with cause and fix.
