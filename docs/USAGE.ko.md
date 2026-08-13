# DevUp 사용법

[English](USAGE.md) | **한국어**

설치부터 YAML 스키마, 모든 명령어와 플래그까지의 전체 레퍼런스입니다.
처음이라면 [README](../README.ko.md)의 빠른 시작을 먼저 보세요.

## 목차

- [설치](#설치)
- [프로젝트 설정 만들기](#프로젝트-설정-만들기)
- [YAML 스키마 레퍼런스](#yaml-스키마-레퍼런스)
- [명령어 레퍼런스](#명령어-레퍼런스)
- [상태 값과 exit code](#상태-값과-exit-code)
- [환경변수](#환경변수)
- [실전 레시피](#실전-레시피)
- [Troubleshooting](#troubleshooting)

## 설치

요구사항: **Node.js ≥ 18.17**. tmux / Docker / fzf는 선택 사항이며, 없으면 해당 기능만 자동 비활성화됩니다.

```bash
npm install -g @minseokchae/dev-up   # dev, devup, devdown, devrestart, devstatus, devlogs 설치
```

소스에서 설치:

```bash
git clone https://github.com/Min0504/dev-up.git
cd dev-up
npm install && npm link
```

설치 확인과 환경 점검:

```bash
dev doctor
```

셸 자동완성(서브커맨드 + 등록된 프로젝트 이름):

```bash
# zsh
echo 'eval "$(dev completion zsh)"' >> ~/.zshrc

# bash
echo 'eval "$(dev completion bash)"' >> ~/.bashrc
```

제거:

```bash
npm rm -g @minseokchae/dev-up
rm -rf ~/.devup     # 설정·상태·로그까지 지우려면
```

## 프로젝트 설정 만들기

설정 파일 하나가 프로젝트 하나입니다. 두 가지 보관 방식을 지원합니다.

**A. 홈 디렉터리에 보관** — 개인 Mac 전역에서 이름으로 접근:

```bash
dev init myapp          # ~/.devup/projects/myapp.yaml 템플릿 생성
$EDITOR ~/.devup/projects/myapp.yaml
devup myapp
```

**B. 저장소 안에 보관** — 팀/저장소와 함께 버전 관리:

```bash
cd ~/dev/myapp
dev init --local        # ./devup.yaml 생성
dev register ./devup.yaml   # ~/.devup/projects/에 심링크 → 어디서든 `devup myapp`
```

### 설정 탐색 순서

`devup <ref>`의 `<ref>`는 다음 순서로 해석됩니다.

1. `/`를 포함하거나 `.yaml`/`.yml`로 끝나면 → 그 파일 자체
2. 이름이면 → `~/.devup/projects/<이름>.yaml` (또는 `.yml`)
3. 인자가 없으면 → 현재 디렉터리부터 상위로 올라가며 `devup.yaml` · `.devup.yaml` · `devup.yml` · `.devup.yml` 탐색

## YAML 스키마 레퍼런스

전체 예시는 [`examples/fullstack.yaml`](../examples/fullstack.yaml)을 참고하세요.

### 프로젝트 (최상위)

| 키 | 필수 | 설명 |
|---|---|---|
| `name` | ✓ | 프로젝트 이름. `[a-z0-9][a-z0-9._-]*` |
| `root` | ✓ | 프로젝트 루트 디렉터리. `~`와 **설정 파일 기준** 상대경로 지원 |
| `env` | | 모든 서비스에 주입할 공통 환경변수 (`KEY: value` 매핑) |
| `env_file` | | `.env` 파일 경로 (**root 기준** 상대경로). `KEY=VALUE`, `#` 주석, 따옴표, `export` 접두어 지원 |
| `services` | ✓ | 서비스 정의 매핑 (1개 이상) |
| `tmux` | | tmux 세션 설정 (아래 참조) |
| `checks` | | `devup` 실행 전에 존재를 확인할 CLI 도구 목록 (예: `[pnpm, npx]`) |

알 수 없는 키는 오류가 아니라 **경고 후 무시**됩니다(오타 감지용).

### 서비스

```yaml
services:
  <서비스이름>:        # [a-z0-9][a-z0-9._-]*
    type: command      # 필수: docker | command | script
    ...
```

| 키 | 기본값 | 적용 타입 | 설명 |
|---|---|---|---|
| `type` | — (필수) | 전체 | `docker` \| `command` \| `script` |
| `command` | — | command·script 필수 | 실행할 셸 명령. docker 타입에서는 `compose_service` 대신 커스텀 시작 명령으로 사용 가능 |
| `stop` | SIGTERM→SIGKILL | command | 종료 시 기본 시그널 대신 실행할 명령 |
| `restart` | stop 후 start | 전체 | `devrestart` 시 실행할 커스텀 명령 |
| `cwd` | `.` | 전체 | 작업 디렉터리 (**root 기준** 상대경로) |
| `env` | `{}` | 전체 | 이 서비스에만 주입할 환경변수 |
| `compose_service` | — | docker 필수 | docker compose의 서비스 이름 |
| `compose_file` | compose 기본 탐색 | docker | compose 파일 경로 (root 기준) |
| `depends_on` | `[]` | 전체 | 먼저 healthy/실행되어야 하는 서비스 목록 |
| `healthcheck` | 없음 | docker·command | 아래 참조. script 타입에서는 무시(경고) |
| `auto_start` | `true` | 전체 | `false`면 기본 `devup`에서 제외 (`--only`로만 시작) |
| `tmux` | `false` | command 전용 | `true`면 tmux window 안에서 실행 (인터랙티브 키 입력 가능) |
| `stop_grace` | `10` | command | SIGTERM 후 SIGKILL까지 대기할 초 |

**환경변수 병합 우선순위** (뒤가 이김): 현재 셸 env → 프로젝트 `env` → `env_file` → 서비스 `env`

### healthcheck

객체 형태와 단축 문자열 두 가지를 지원합니다.

```yaml
# 단축형
healthcheck: postgres              # pg_isready (기본 포트 5432)
healthcheck: redis:6380            # redis-cli ping, 포트 지정
healthcheck: tcp:8081              # TCP 연결
healthcheck: http://localhost:3000/health
healthcheck: docker                # 컨테이너 자체 HEALTHCHECK 상태

# 전체형
healthcheck:
  type: tcp          # tcp | http | postgres | redis | docker | command
  host: 127.0.0.1    # 기본값
  port: 3000         # tcp 필수 · postgres/redis는 기본 5432/6379
  url: ...           # http 필수
  command: ...       # command 필수 (exit 0 = healthy)
  expect_status: 200 # http: 특정 상태코드 요구 (기본: < 500이면 통과)
  timeout: 60        # healthy까지 기다릴 총 시간(초)
  interval: 1        # 프로브 간격(초)
```

제약: `type: docker`는 docker 서비스에서만 사용 가능. `postgres`/`redis` 프로브는 호스트에 클라이언트가 없으면 컨테이너 내부 실행으로, 그것도 안 되면 TCP 연결로 폴백합니다.

### tmux

```yaml
tmux:
  enabled: true        # 기본 true (tmux 미설치 시 자동 비활성)
  session: myapp       # 기본값: 프로젝트 이름
  attach: false        # devup 완료 후 자동 attach
  shell_window: true   # 프로젝트 루트에서 여는 shell window
  logs_window: true    # background 서비스 로그를 tail하는 window
```

## 명령어 레퍼런스

`devup` 등 5개 단축 명령은 `dev up` 등 서브커맨드의 별칭입니다. 어느 쪽을 써도 동일합니다.

### devup [project]

의존성 순서대로 서비스를 시작하고, 각 단계에서 healthcheck 통과를 기다립니다.

| 플래그 | 설명 |
|---|---|
| `--only <a,b>` | 지정 서비스만 시작 — **의존성도 자동 포함** |
| `--no-deps` | `--only`와 함께: 의존성을 시작하지 않음 |
| `--no-tmux` | tmux 세션/window 생성 생략 |
| `-a, --attach` | 완료 후 tmux 세션에 attach |
| `--force` | 이미 실행 중인 서비스도 재시작 |

이미 실행 중인 서비스는 건너뜁니다(멱등). 실패한 서비스의 의존 서비스는 `skipped` 처리되고 exit 1로 종료하되, 이미 시작된 것은 유지됩니다.

### devdown [project]

`devup`이 시작한 리소스만, 시작의 역순으로 종료합니다.

| 플래그 | 설명 |
|---|---|
| `--only <a,b>` | 지정 서비스만 종료 — **그것에 의존하는 서비스까지** 함께 내림 |
| `--keep-tmux` | tmux 세션은 남겨둠 |

command 서비스는 SIGTERM → (`stop_grace`초 대기) → SIGKILL 순서로, 프로세스 그룹 전체에 시그널을 보냅니다. 종료 전 state에 기록된 프로세스 시작시각(`lstart`)을 대조해 **PID가 재사용된 경우 절대 종료하지 않습니다.**

### devrestart [project] [service]

전체 프로젝트 또는 단일 서비스를 재시작합니다. 전체 재시작 시 의존성 순서를 유지하며 tmux 세션은 유지됩니다. 서비스에 `restart` 명령이 정의되어 있으면 그것을 실행합니다.

### devstatus [project]

| 플래그 | 설명 |
|---|---|
| `--json` | machine-readable 출력 (dev-cockpit 등 연동용) |

프로젝트 인자가 있으면 서비스별 상태 테이블(+git branch/dirty, tmux 세션, uptime, 포트)을, 없으면 현재 디렉터리에서 설정을 찾고 그것도 없으면 **모든 프로젝트 요약**을 출력합니다. `failed`나 `unhealthy` 서비스가 있으면 exit 1 — 스크립트에서 상태 확인 용도로 쓸 수 있습니다.

### devlogs [project] [service]

| 플래그 | 설명 |
|---|---|
| `-f, --follow` | 실시간 follow |
| `-n, --lines <n>` | 출력 줄 수 (기본 100) |
| `--clear` | 로그 파일 비우기 |

서비스를 생략하면 fzf(설치 시)로 선택합니다. command 서비스 로그는 `~/.devup/logs/<프로젝트>/<서비스>.log`, docker 서비스는 `docker compose logs`를 사용합니다.

### dev 관리 명령

| 명령 | 설명 |
|---|---|
| `dev list` | 등록된 프로젝트 목록 (서비스 수 · root 경로) |
| `dev doctor` | 도구·데몬·설정 전반 점검, 문제 시 해결법 출력 |
| `dev init [name] [--local]` | 설정 템플릿 생성 (`--local`: 현재 디렉터리에 `devup.yaml`) |
| `dev register <file> [--force]` | repo 로컬 설정을 `~/.devup/projects/`에 심링크로 등록 |
| `dev unregister <name> [--force]` | 등록 해제 (`--force`: 심링크가 아닌 실제 파일도 삭제) |
| `dev validate [project]` | 아무것도 시작하지 않고 설정 파싱·검증만 |
| `dev completion [zsh\|bash]` | 자동완성 스크립트 출력 |

공통 플래그: `-v, --verbose`(디버그 로그 + 스택트레이스), `--help`, `--version`

## 상태 값과 exit code

| 상태 | 의미 |
|---|---|
| `healthy` | healthcheck 통과 |
| `running` | 프로세스/컨테이너 실행 중 (healthcheck 미정의) |
| `starting` | 실행 중이나 아직 healthcheck 미통과 |
| `unhealthy` | 실행 중이지만 healthcheck 실패 |
| `stopped` | 정상 종료됨 (또는 시작한 적 없음) |
| `failed` | 비정상 종료 (외부에서 죽었거나 시작 실패) |

exit code: `0` 성공 · `1` 일부 서비스 실패/런타임 오류 · `2` 설정 오류·잘못된 사용

## 환경변수

| 변수 | 설명 |
|---|---|
| `DEVUP_HOME` | 기본 `~/.devup` 대신 사용할 홈 디렉터리 (테스트 격리에도 사용) |
| `DEVUP_TMUX_SOCKET` | tmux를 별도 소켓에서 실행 (테스트 격리용) |
| `NO_COLOR` | ANSI 색상 비활성화 |

## 실전 레시피

**DB만 올리고 앱은 직접 실행:**

```bash
devup myapp --only postgres,redis
```

**백엔드가 이상할 때 그것만 재시작:**

```bash
devrestart myapp backend
```

**Expo처럼 키 입력이 필요한 서비스** — `tmux: true`로 선언하면 전용 tmux window에서 실행되어 `i`/`a`/`r` 같은 키가 동작하고, 로그도 파일에 동시 기록됩니다:

```bash
devup myapp -a       # 올리고 바로 attach
```

**새 Mac으로 이전:**

```bash
# 이전 Mac
tar czf devup-config.tgz -C ~ .devup/projects

# 새 Mac
npm install -g @minseokchae/dev-up
tar xzf devup-config.tgz -C ~
dev doctor           # 부족한 도구 확인
```

설정에서 절대경로 대신 `~`/상대경로를 쓰면 수정 없이 그대로 동작합니다. repo에 `devup.yaml`을 커밋해뒀다면 clone 후 `dev register`만 하면 됩니다.

**CI/스크립트에서 상태 확인:**

```bash
devstatus myapp --json | jq '.services[] | select(.status != "healthy")'
```

## Troubleshooting

| 증상 | 해결 |
|---|---|
| `Docker daemon is not running` | `open -a Docker` 후 재시도. `dev doctor`로 확인 |
| 서비스가 `failed` | `devlogs <p> <svc>`로 원인 확인. devup이 실패 시점 로그 끝부분을 바로 보여줌 |
| health timeout | `healthcheck.timeout` 상향 (프레임워크 첫 부팅은 느릴 수 있음) |
| `unknown project` | `dev list`로 이름 확인, `dev init <name>`으로 생성 |
| 포트 충돌 | `devstatus`의 포트 컬럼으로 어떤 프로젝트가 점유 중인지 확인 |
| tmux 없이 쓰고 싶음 | `tmux.enabled: false` 또는 `devup --no-tmux` |
| 외부에서 죽인 프로세스 | `devstatus`에 `failed`로 표시, `devup`이 그 서비스만 다시 올림 |
| 설정이 맞는지만 확인 | `dev validate <p>` — 아무것도 실행하지 않음 |
