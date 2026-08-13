# DevUp

[English](README.md) | **한국어**

프로젝트 개발환경(Docker, DB, backend, frontend, tmux)을 **명령 한 줄로 올리고 내리는** 개인용 오케스트레이터.

```bash
devup myapp      # 전체 개발환경 시작 (의존성 순서 보장)
devstatus myapp  # 실시간 상태 (health 포함)
devlogs myapp    # 서비스 로그 (fzf로 선택)
devrestart myapp # 재시작
devdown myapp    # devup이 띄운 것만 깨끗하게 종료
```

- 서비스 간 `depends_on` — PostgreSQL이 healthy 되기 전에 backend가 뜨지 않음
- **DevUp이 띄운 프로세스만 종료** — PID 재사용까지 감지(`ps lstart` 대조)해서 남의 프로세스를 절대 죽이지 않음
- tmux 세션 자동 구성 (서비스별 window + shell + logs)
- TCP / HTTP / PostgreSQL / Redis / Docker health check
- `--json` 출력으로 외부 도구 연동 가능

## 문서

| 문서 | 내용 |
|---|---|
| [docs/USAGE.ko.md](docs/USAGE.ko.md) | 사용법 전체 — 설치, YAML 스키마, 모든 명령·플래그, 레시피 |
| [docs/FEATURES.ko.md](docs/FEATURES.ko.md) | 기능 카탈로그 — 각 기능이 해결하는 문제와 동작 방식 |
| [docs/ARCHITECTURE.ko.md](docs/ARCHITECTURE.ko.md) | 내부 구조 — 모듈, state 파일, 실행 시퀀스, 안전장치 설계 |

## 설치

```bash
npm install -g @minseokchae/dev-up   # dev, devup, devdown, devrestart, devstatus, devlogs 설치
```

소스에서 설치:

```bash
git clone https://github.com/Min0504/dev-up.git
cd dev-up
npm install && npm link
```

요구사항: Node ≥ 18. tmux / Docker / fzf는 선택(없으면 해당 기능만 비활성).

```bash
dev doctor      # 환경 점검 + 문제 해결법 출력
```

셸 자동완성(프로젝트 이름 포함):

```bash
echo 'eval "$(dev completion zsh)"' >> ~/.zshrc
```

제거: `npm rm -g @minseokchae/dev-up`

## 초기 설정

```bash
dev init myapp                # ~/.devup/projects/myapp.yaml 템플릿 생성
dev init --local              # 또는 repo 안에 ./devup.yaml 생성
dev register ./devup.yaml     # repo 로컬 설정을 심링크로 등록
dev list                      # 등록된 프로젝트 목록
```

설정 탐색 순서: ① `devup <이름>` → `~/.devup/projects/<이름>.yaml` ② `devup ./path.yaml` → 해당 파일 ③ 인자 없이 `devup` → 현재 디렉터리에서 위로 올라가며 `devup.yaml`(또는 `.devup.yaml`) 탐색.

## YAML Schema

전체 필드 레퍼런스는 [docs/USAGE.ko.md](docs/USAGE.ko.md#yaml-스키마-레퍼런스), 실행 가능한 예시는 [examples/fullstack.yaml](examples/fullstack.yaml) 참고.

```yaml
name: myapp                  # 필수. [a-z0-9._-]
root: ~/dev/myapp            # 필수. ~ / 상대경로(설정파일 기준) 지원

env:                         # 모든 서비스 공통 환경변수 (선택)
  NODE_ENV: development
env_file: .env.development   # root 기준 상대경로 (선택)

checks: [pnpm]               # devup 전에 존재 확인할 CLI 도구 (선택)

services:
  postgres:
    type: docker             # docker | command | script
    compose_file: backend/docker-compose.yml   # 생략 시 cwd에서 compose 기본 탐색
    compose_service: postgres
    healthcheck: postgres    # shorthand (아래 참조)

  backend:
    type: command            # devup이 직접 띄우고 추적하는 프로세스
    cwd: backend             # root 기준 상대경로
    command: npm run start:dev
    stop: ""                 # (선택) 종료 전 실행할 명령. 기본은 SIGTERM→SIGKILL
    restart: ""              # (선택) devrestart 시 커스텀 명령
    env: { PORT: "3000" }
    depends_on: [postgres]
    auto_start: true         # false면 devup 기본 실행에서 제외 (--only로만)
    stop_grace: 10           # SIGTERM 후 대기 초
    healthcheck:
      type: tcp              # tcp | http | postgres | redis | docker | command
      port: 3000
      timeout: 120           # healthy까지 기다릴 총 시간(초), 기본 60
      interval: 1            # 프로브 간격(초)

  expo:
    type: command
    command: npm start
    tmux: true               # tmux window 안에서 실행 → 인터랙티브 키 입력 가능
    depends_on: [backend]
    healthcheck: tcp:8081

  migrate:
    type: script             # devup마다 완료까지 실행, 실패 시 의존 서비스 중단
    cwd: backend
    command: npx prisma migrate dev
    depends_on: [postgres]

tmux:
  enabled: true              # 기본 true (tmux 미설치 시 자동 비활성)
  session: myapp             # 기본값은 프로젝트 이름
  attach: false              # devup 완료 후 자동 attach
  shell_window: true         # 프로젝트 루트에서 여는 shell window
  logs_window: true          # background 서비스 로그를 tail하는 window
```

### healthcheck shorthand

| 표기 | 의미 |
|---|---|
| `postgres` / `postgres:5433` | `pg_isready`(호스트에 없으면 컨테이너 내부 실행, 최후엔 TCP) |
| `redis` / `redis:6380` | `redis-cli ping` (동일한 폴백) |
| `tcp:8081` | TCP 연결 |
| `http://localhost:3000/health` | HTTP 응답 상태 < 500 (`expect_status`로 고정 가능) |
| `docker` | 컨테이너의 자체 HEALTHCHECK 상태 |

## 명령어

| 명령 | 설명 |
|---|---|
| `devup <p>` | 의존성 순서대로 시작, 각 단계 health 대기. `--only backend`(의존성 포함), `--no-deps`, `--no-tmux`, `--force`(재시작), `-a`(attach) |
| `devdown <p>` | 역순 종료. `--only postgres`는 **그것에 의존하는 서비스까지** 같이 내림. `--keep-tmux` |
| `devrestart <p> [svc]` | 전체 또는 단일 서비스 재시작 |
| `devstatus [p]` | 상태 테이블(+git branch/dirty, tmux, uptime, port). 인자 없으면 전체 프로젝트 요약. `--json` |
| `devlogs <p> [svc]` | 로그 보기. 서비스 생략 + fzf 있으면 선택 UI. `-f`(follow), `-n 200`, `--clear` |
| `dev list / doctor / init / register / unregister / validate / completion` | 관리 명령 |

상태 값: `healthy · running · starting · unhealthy · stopped · failed`
(프로세스가 살아있어도 health probe가 실패하면 unhealthy로 표시)

Exit code: `0` 정상 / `1` 일부 실패·런타임 오류 / `2` 설정 오류·잘못된 사용

## 동작 방식

- **command 서비스**: 자체 process group으로 detach 실행, 로그는 `~/.devup/logs/<p>/<svc>.log`. PID + `ps lstart`(프로세스 시작시각)를 state에 기록 → devdown 시 시작시각이 다르면(PID 재사용) **절대 죽이지 않음**.
- **tmux: true 서비스**: 전용 tmux window에서 실행하되 `tee`로 같은 로그 파일에도 기록. Expo처럼 키 입력이 필요한 서비스에 적합.
- **docker 서비스**: `docker compose up -d <svc>` / `stop <svc>`. 해당 compose 서비스만 제어하므로 다른 프로젝트 컨테이너는 건드리지 않음.
- **script 서비스**: 매 devup마다 완료까지 실행(마이그레이션 등). 실패하면 의존 서비스는 시작하지 않음.
- 실패한 서비스가 있으면 그 의존 서비스는 `skipped` 처리되고 exit 1. 이미 시작된 것은 유지 → `devdown`으로 정리.
- state는 `~/.devup/state/<p>.json` (atomic write). Ctrl-C로 중단해도 지금까지의 state는 저장됨.

자세한 내부 구조는 [docs/ARCHITECTURE.ko.md](docs/ARCHITECTURE.ko.md) 참고.

## tmux 구성

```text
myapp (session)
├── shell   ← 프로젝트 루트
├── expo    ← tmux: true 서비스 (인터랙티브)
└── logs    ← background 서비스 로그 tail -F
```

이미 세션이 있으면 재사용(중복 window 생성 안 함). `devdown`이 세션까지 정리, `devrestart`는 세션 유지.

## Troubleshooting

| 증상 | 해결 |
|---|---|
| `Docker daemon is not running` | `open -a Docker` 후 재시도. `dev doctor`로 확인 |
| 서비스가 `failed` | `devlogs <p> <svc>`로 원인 확인. devup이 실패 시점의 로그 끝부분을 바로 보여줌 |
| health timeout | `healthcheck.timeout` 상향 (nest/expo 첫 부팅은 느림) |
| `unknown project` | `dev list`로 이름 확인, `dev init <name>`으로 생성 |
| 포트 충돌 | `devstatus`의 포트 컬럼으로 어떤 프로젝트가 점유 중인지 확인 |
| tmux 없이 쓰고 싶음 | `tmux.enabled: false` 또는 `devup --no-tmux` |
| 외부에서 죽인 프로세스 | `devstatus`에 `failed`로 표시, `devup`이 그 서비스만 다시 올림 |

## 새 Mac에서 설정 복사

설정은 전부 `~/.devup/projects/*.yaml` (또는 각 repo의 `devup.yaml`).

```bash
# 이전 Mac
tar czf devup-config.tgz -C ~ .devup/projects

# 새 Mac
npm install -g @minseokchae/dev-up
tar xzf devup-config.tgz -C ~
dev doctor          # 부족한 도구 확인
devup <project>     # root 경로가 다르면 yaml에서 ~ 기준으로 수정
```

절대경로 대신 `~`/상대경로를 쓰면 수정 없이 그대로 동작한다. repo에 `devup.yaml`을 커밋해두면 `dev register`만으로 끝.

## 개발

```bash
npm run build       # tsc (strict)
npm test            # 유닛 + 통합 (실제 프로세스/tmux/docker 기동)
```

테스트는 `DEVUP_HOME`·`DEVUP_TMUX_SOCKET` 격리 하에 실행되며 사용자 환경을 오염시키지 않는다.

## 라이선스

[MIT](LICENSE)
