# DevUp Usage

**English** | [한국어](USAGE.ko.md)

The complete reference: installation, the YAML schema, and every command and flag.
New here? Start with the quick start in the [README](../README.md).

## Table of contents

- [Install](#install)
- [Creating a project config](#creating-a-project-config)
- [YAML schema reference](#yaml-schema-reference)
- [Command reference](#command-reference)
- [Statuses and exit codes](#statuses-and-exit-codes)
- [Environment variables](#environment-variables)
- [Recipes](#recipes)
- [Troubleshooting](#troubleshooting)

## Install

Requirements: **Node.js ≥ 18.17**. tmux / Docker / fzf are optional — a missing tool only disables its own feature.

```bash
npm install -g @minseokchae/dev-up   # installs dev, devup, devdown, devrestart, devstatus, devlogs
```

Or from source:

```bash
git clone https://github.com/Min0504/dev-up.git
cd dev-up
npm install && npm link
```

Verify the environment:

```bash
dev doctor
```

Shell completion (subcommands + registered project names):

```bash
# zsh
echo 'eval "$(dev completion zsh)"' >> ~/.zshrc

# bash
echo 'eval "$(dev completion bash)"' >> ~/.bashrc
```

Uninstall:

```bash
npm rm -g @minseokchae/dev-up
rm -rf ~/.devup     # also removes configs, state, and logs
```

## Creating a project config

One config file = one project. Two storage styles are supported.

**A. In your home directory** — accessible by name from anywhere on this Mac:

```bash
dev init myapp          # creates a template at ~/.devup/projects/myapp.yaml
$EDITOR ~/.devup/projects/myapp.yaml
devup myapp
```

**B. Inside the repository** — versioned together with the project:

```bash
cd ~/dev/myapp
dev init --local        # creates ./devup.yaml
dev register ./devup.yaml   # symlinks it into ~/.devup/projects/ → `devup myapp` from anywhere
```

### Config resolution order

A `<ref>` passed to `devup <ref>` resolves as:

1. Contains `/` or ends with `.yaml`/`.yml` → that file
2. A name → `~/.devup/projects/<name>.yaml` (or `.yml`)
3. No argument → walk up from the current directory looking for `devup.yaml` · `.devup.yaml` · `devup.yml` · `.devup.yml`

## YAML schema reference

See [`examples/fullstack.yaml`](../examples/fullstack.yaml) for a complete example.

### Project (top level)

| Key | Required | Description |
|---|---|---|
| `name` | ✓ | Project name. `[a-z0-9][a-z0-9._-]*` |
| `root` | ✓ | Project root directory. Supports `~` and paths **relative to the config file** |
| `env` | | Env vars injected into every service (`KEY: value` mapping) |
| `env_file` | | A `.env` file (path **relative to root**). Supports `KEY=VALUE`, `#` comments, quotes, `export` prefix |
| `services` | ✓ | Service definitions (at least one) |
| `tmux` | | tmux session settings (below) |
| `checks` | | CLI tools that must exist before `devup` runs (e.g. `[pnpm, npx]`) |

Unknown keys are **warned about and ignored**, not fatal (typo detection).

### Services

```yaml
services:
  <service-name>:    # [a-z0-9][a-z0-9._-]*
    type: command    # required: docker | command | script
    ...
```

| Key | Default | Applies to | Description |
|---|---|---|---|
| `type` | — (required) | all | `docker` \| `command` \| `script` |
| `command` | — | required for command·script | Shell command to run. For docker services it can replace `compose_service` as a custom start command |
| `stop` | SIGTERM→SIGKILL | command | Command to run on stop instead of signalling |
| `restart` | stop then start | all | Custom command used by `devrestart` |
| `cwd` | `.` | all | Working directory (**relative to root**) |
| `env` | `{}` | all | Env vars for this service only |
| `compose_service` | — | required for docker | Service name inside docker compose |
| `compose_file` | compose default discovery | docker | Compose file path (relative to root) |
| `depends_on` | `[]` | all | Services that must be healthy/running first |
| `healthcheck` | none | docker·command | See below. Ignored (with a warning) on script services |
| `auto_start` | `true` | all | `false` = excluded from a plain `devup` (start via `--only`) |
| `tmux` | `false` | command only | `true` = run inside a tmux window (interactive keys work) |
| `stop_grace` | `10` | command | Seconds between SIGTERM and SIGKILL |

**Environment merge order** (later wins): current shell env → project `env` → `env_file` → service `env`

### healthcheck

Both an object form and shorthand strings are supported.

```yaml
# shorthand
healthcheck: postgres              # pg_isready (default port 5432)
healthcheck: redis:6380            # redis-cli ping on a custom port
healthcheck: tcp:8081              # TCP connect
healthcheck: http://localhost:3000/health
healthcheck: docker                # the container's own HEALTHCHECK status

# full form
healthcheck:
  type: tcp          # tcp | http | postgres | redis | docker | command
  host: 127.0.0.1    # default
  port: 3000         # required for tcp · postgres/redis default to 5432/6379
  url: ...           # required for http
  command: ...       # required for command (exit 0 = healthy)
  expect_status: 200 # http: require an exact status (default: anything < 500 passes)
  timeout: 60        # total seconds to wait for healthy
  interval: 1        # seconds between probes
```

Constraints: `type: docker` is only valid on docker services. The `postgres`/`redis` probes fall back to running the client inside the container when it's missing on the host, and to a plain TCP connect after that.

### tmux

```yaml
tmux:
  enabled: true        # default true (auto-disabled when tmux is missing)
  session: myapp       # default: project name
  attach: false        # attach after devup finishes
  shell_window: true   # a shell window at the project root
  logs_window: true    # a window tailing background service logs
```

## Command reference

The five short commands (`devup` etc.) are aliases of `dev up` etc. — use either form.

### devup [project]

Starts services in dependency order, waiting for health checks at each level.

| Flag | Description |
|---|---|
| `--only <a,b>` | Start only these services — **dependencies included automatically** |
| `--no-deps` | With `--only`: do not start dependencies |
| `--no-tmux` | Skip tmux session/window handling |
| `-a, --attach` | Attach to the tmux session when done |
| `--force` | Restart services that are already running |

Already-running services are skipped (idempotent). When a service fails, its dependents are marked `skipped` and the exit code is 1, but whatever started stays up.

### devdown [project]

Stops only what devup started, in reverse startup order.

| Flag | Description |
|---|---|
| `--only <a,b>` | Stop only these — **plus everything that depends on them** |
| `--keep-tmux` | Leave the tmux session alive |

command services get SIGTERM → (`stop_grace` seconds) → SIGKILL, sent to the whole process group. Before signalling, the recorded process start time (`lstart`) is compared — **a reused PID is never killed.**

### devrestart [project] [service]

Restarts the whole project or one service. A full restart preserves dependency order and keeps the tmux session. A service with a custom `restart` command runs that instead.

### devstatus [project]

| Flag | Description |
|---|---|
| `--json` | Machine-readable output |

With a project: a per-service status table (+git branch/dirty, tmux session, uptime, ports). Without: looks for a config in the current directory, else prints a **summary of all projects**. Exits 1 when anything is `failed`/`unhealthy` — usable as a scripted health probe.

### devlogs [project] [service]

| Flag | Description |
|---|---|
| `-f, --follow` | Follow output live |
| `-n, --lines <n>` | Number of lines (default 100) |
| `--clear` | Truncate log files |

Omit the service to pick with fzf (when installed). command-service logs live at `~/.devup/logs/<project>/<service>.log`; docker services use `docker compose logs`.

### dev management commands

| Command | Description |
|---|---|
| `dev list` | Registered projects (service count · root path) |
| `dev doctor` | Check tools, daemons, and every registered config; prints fixes |
| `dev init [name] [--local]` | Create a config template (`--local`: `./devup.yaml` in the current directory) |
| `dev register <file> [--force]` | Symlink a repo-local config into `~/.devup/projects/` |
| `dev unregister <name> [--force]` | Remove a registration (`--force`: delete even a real file, not just a symlink) |
| `dev validate [project]` | Parse and validate a config without starting anything |
| `dev completion [zsh\|bash]` | Print the completion script |

Common flags: `-v, --verbose` (debug logs + stack traces), `--help`, `--version`

## Statuses and exit codes

| Status | Meaning |
|---|---|
| `healthy` | Health check passing |
| `running` | Process/container alive (no health check defined) |
| `starting` | Alive but health check not passing yet |
| `unhealthy` | Alive but health check failing |
| `stopped` | Cleanly stopped (or never started) |
| `failed` | Died unexpectedly (killed externally or failed to start) |

Exit codes: `0` success · `1` partial failure / runtime error · `2` config error / bad usage

## Environment variables

| Variable | Description |
|---|---|
| `DEVUP_HOME` | Use this directory instead of `~/.devup` (also used for test isolation) |
| `DEVUP_TMUX_SOCKET` | Run tmux on a separate socket (test isolation) |
| `NO_COLOR` | Disable ANSI colors |

## Recipes

**Bring up only the databases and run the app yourself:**

```bash
devup myapp --only postgres,redis
```

**Backend acting up? Restart just that:**

```bash
devrestart myapp backend
```

**A service that needs keystrokes (like Expo)** — declare `tmux: true` and it runs in its own tmux window where `i`/`a`/`r` work, while logs still go to the file:

```bash
devup myapp -a       # bring it up and attach right away
```

**Moving to a new Mac:**

```bash
# old Mac
tar czf devup-config.tgz -C ~ .devup/projects

# new Mac
npm install -g @minseokchae/dev-up
tar xzf devup-config.tgz -C ~
dev doctor           # see which tools are missing
```

Use `~`/relative paths instead of absolute ones and configs work unchanged. If the repo ships a `devup.yaml`, `dev register` after cloning is all it takes.

**Health gating in CI/scripts:**

```bash
devstatus myapp --json | jq '.services[] | select(.status != "healthy")'
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Docker daemon is not running` | `open -a Docker`, retry. Confirm with `dev doctor` |
| A service shows `failed` | `devlogs <p> <svc>` — devup already printed the log tail at failure time |
| Health timeout | Raise `healthcheck.timeout` (framework first boots can be slow) |
| `unknown project` | Check names with `dev list`, create with `dev init <name>` |
| Port conflict | The port column in `devstatus` shows which project holds it |
| Don't want tmux | `tmux.enabled: false` or `devup --no-tmux` |
| Process killed externally | Shows as `failed`; the next `devup` restarts only that service |
| Just want to check the config | `dev validate <p>` — runs nothing |
