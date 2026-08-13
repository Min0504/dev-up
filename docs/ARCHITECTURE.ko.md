# DevUp 아키텍처

[English](ARCHITECTURE.md) | **한국어**

코드를 읽거나 기여하려는 사람을 위한 내부 구조 문서입니다.

## 설계 원칙

1. **선언과 실행의 분리** — YAML은 "무엇이 필요한가"만 선언하고, 실행 방법·순서·추적은 전부 DevUp이 책임진다.
2. **자기가 만든 것만 관리** — 모든 시작 리소스를 state 파일에 지문과 함께 기록하고, 종료는 그 기록에 있는 것만 대상으로 한다. 시스템 전역을 뒤지는 코드는 없다.
3. **얇은 오케스트레이터** — 컨테이너는 docker compose가, 터미널 멀티플렉싱은 tmux가, 프로세스는 OS가 관리한다. DevUp은 이들을 순서대로 조율하고 상태를 추적할 뿐, 어느 것도 재구현하지 않는다.
4. **부분 실패 허용** — 한 서비스가 실패해도 이미 올라온 것은 유지하고, 의존 서비스만 skip한 뒤 정확한 exit code로 알린다.

## 디렉터리 구조

```text
dev-up/
├── bin/            # 명령별 shim (dev, devup, devdown, ...) → dist/src/cli.js
├── src/
│   ├── cli.ts          # Commander 정의, 별칭 매핑, 오류 → exit code 변환
│   ├── config.ts       # YAML 파싱·검증, 위상정렬, env 병합
│   ├── orchestrator.ts # up / down / restart 핵심 흐름
│   ├── proc.ts         # 프로세스 시작·종료·지문(lstart) 검사
│   ├── state.ts        # ~/.devup/state/*.json 읽기/쓰기 (atomic)
│   ├── docker.ts       # docker compose 연동
│   ├── tmux.ts         # tmux 세션/window 관리
│   ├── health.ts       # 6종 헬스 프로브 + 폴링
│   ├── status.ts       # 실시간 상태 수집·렌더링·JSON 직렬화
│   ├── logs.ts         # devlogs (tail / compose logs / fzf 선택)
│   ├── doctor.ts       # 환경 진단
│   ├── commands.ts     # list / init / register / unregister
│   ├── completion.ts   # zsh/bash 자동완성 스크립트 생성
│   ├── paths.ts        # ~/.devup 경로, ~ 확장, 상대경로 해석
│   └── ui.ts           # ANSI 색상, CJK 폭 계산, 테이블, 로거
└── test/           # node:test 기반 (아래 '테스트' 참조)
```

의존 방향은 단방향입니다: `cli → orchestrator/status/logs/... → docker/tmux/health/proc → state/config/paths/ui`. 런타임 의존성은 `commander`와 `yaml` 둘뿐이며, 나머지는 Node 내장 모듈과 외부 CLI(docker, tmux, fzf) 호출입니다.

## 런타임 데이터 레이아웃

```text
~/.devup/                  # DEVUP_HOME으로 변경 가능
├── projects/              # 프로젝트 설정 (yaml 또는 repo로의 심링크)
│   └── myapp.yaml
├── state/                 # 프로젝트별 런타임 상태
│   └── myapp.json
└── logs/
    └── myapp/
        ├── backend.log    # command 서비스 stdout+stderr
        └── expo.log       # tmux 서비스도 tee로 동일하게 기록
```

### state 파일 스키마

```jsonc
// ~/.devup/state/myapp.json — devup이 시작한 것의 유일한 장부
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
      "lstart": "Thu Aug 14 01:00:00 2026",  // ← PID 재사용 감지의 핵심
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

쓰기는 항상 **tmp 파일 작성 후 rename**으로 원자적입니다. Ctrl-C로 중단돼도 절반만 쓰인 state가 남지 않고, 그때까지 시작된 서비스는 기록되어 있어 `devdown`으로 정리할 수 있습니다.

## devup 실행 시퀀스

```text
설정 로드·검증 (config.ts)          실패 → 문제 전부 나열 후 exit 2
  ↓
checks 도구 존재 확인, docker 서비스 있으면 daemon 확인
  ↓
위상정렬 → 병렬 레벨 (topoLevels, Kahn)
  예: [[postgres, redis], [backend], [expo]]
  ↓
레벨 단위로 반복:
  각 서비스를 병렬 시작
    ├─ docker  → compose up -d <svc>
    ├─ command → detach 프로세스 그룹 + 로그 파일   (proc.spawnBackground)
    ├─ tmux    → tmux window에서 실행, tee로 로그 병기
    └─ script  → 완료까지 동기 실행, exit≠0이면 실패
  각 서비스 state 기록 (pid·pgid·lstart)
  healthcheck 있으면 healthy까지 폴링 (health.waitHealthy)
  실패 시: 그 서비스에 의존하는 모든 서비스 skip 마킹
  ↓
tmux 세션 구성 (shell/logs window) → 최종 상태 테이블 출력
  ↓
전부 성공 exit 0 · 일부 실패 exit 1
```

이미 실행 중인 서비스는 지문 검사 후 건너뛰므로 `devup`은 멱등입니다. `--only`는 `dependencyClosure`(선택 + 전이적 의존성)로, `devdown --only`는 반대로 `dependentClosure`(선택 + 그것에 의존하는 것들)로 대상을 계산합니다 — 올릴 때는 발판을 같이 올리고, 내릴 때는 위에 얹힌 것을 같이 내리는 대칭 구조입니다.

## 프로세스 안전장치 (proc.ts)

`devdown`이 남의 프로세스를 죽이는 사고를 막기 위한 3중 장치:

1. **프로세스 그룹**: command 서비스는 `detached: true`로 시작해 자체 pgid를 가집니다. 종료 시 `kill(-pgid)`로 그룹 전체(자식 포함)에 시그널을 보내므로, `npm run dev`가 낳은 손자 프로세스도 함께 정리됩니다.
2. **lstart 지문**: 시작 직후 `ps -o lstart= -p <pid>`(프로세스 시작 시각, 초 단위 문자열)를 state에 저장합니다. 종료 전 현재 lstart와 대조해 **다르면 PID가 재사용된 것이므로 건드리지 않고** state만 정리합니다.
3. **단계적 종료**: SIGTERM → `stop_grace`초 내 종료 대기 → 남아 있으면 SIGKILL. 커스텀 `stop` 명령이 정의된 서비스는 그것을 우선 실행합니다.

docker 서비스는 pid를 아예 다루지 않고 `docker compose stop <svc>`로 해당 compose 서비스만 지목합니다. 같은 Mac에서 돌던 다른 프로젝트의 컨테이너는 compose project가 다르므로 영향이 없습니다.

## 헬스체크 (health.ts)

| 타입 | 프로브 | 폴백 |
|---|---|---|
| `tcp` | 소켓 연결 시도 | — |
| `http` | `fetch(url)`, 기본 status < 500 (`expect_status`로 고정) | — |
| `postgres` | `pg_isready` | 호스트에 없으면 `compose exec pg_isready` → 그것도 안 되면 tcp |
| `redis` | `redis-cli ping` == PONG | 동일한 2단 폴백 |
| `docker` | `compose ps`의 컨테이너 health 상태 | HEALTHCHECK 미정의 시 running 여부 |
| `command` | 임의 명령 exit 0 | — |

`waitHealthy`가 `interval`초 간격으로 `timeout`초까지 폴링합니다. `devstatus`는 사용자가 정의한 프로브를 Docker의 주기적 내부 health보다 우선합니다 — 컨테이너 HEALTHCHECK가 아직 `starting`이어도 실제 프로브가 통과하면 `healthy`로 보고합니다.

## tmux 통합 (tmux.ts)

- 프로젝트당 세션 하나(`tmux.session`, 기본 프로젝트명). 이미 있으면 재사용하고 window만 추가/재사용합니다.
- `tmux: true` 서비스는 전용 window에서 `<command> 2>&1 | tee <logfile>` 형태로 실행됩니다. 화면과 로그 파일이 동시에 기록되므로 `devlogs`가 tmux 서비스에도 동작합니다. window id를 state에 저장해 정확히 그 window만 정리합니다.
- `shell` window(프로젝트 루트)와 `logs` window(background 로그 `tail -F`)는 옵션으로 켜고 끕니다.
- 모든 tmux 호출은 `DEVUP_TMUX_SOCKET` 환경변수로 소켓을 분리할 수 있어, 테스트가 사용자 tmux 서버를 오염시키지 않습니다.

## 상태 수집 (status.ts)

`devstatus`는 state 파일(기록)과 실시간 검사(현실)를 대조합니다:

```text
state에 pid 있음 + 살아있음 + lstart 일치 + probe 통과   → healthy
state에 pid 있음 + 살아있음 + probe 없음                 → running
state에 pid 있음 + 죽어 있음                             → failed (외부 종료 감지)
state에 없음                                             → stopped
```

git branch/dirty, 포트, uptime, tmux 세션 존재 여부도 함께 수집하며, `--json`은 이 구조를 그대로 직렬화합니다(외부 도구 연동용 안정 스키마).

## 테스트 (test/)

| 파일 | 검증 대상 |
|---|---|
| `config.test.ts` | YAML 파싱, 검증 오류 메시지, 위상정렬, 사이클 감지 |
| `state.test.ts` | state 저장/로드, atomic write |
| `proc.test.ts` | spawn/terminate, **PID 재사용 시 종료 거부** |
| `integration.test.ts` | 실제 CLI로 up→status→logs→down 전체 수명주기, 멱등성, stale 복구, 실패 전파, exit code |
| `tmux.test.ts` | 실제 tmux 바이너리로 세션/window/tee 로그/정리 (격리 소켓) |
| `docker.test.ts` | 실제 docker compose로 기동/헬스/로그/정지 (데몬 없으면 skip) |

모든 테스트는 임시 `DEVUP_HOME`과 격리 tmux 소켓에서 실행되어 실제 사용자 환경을 건드리지 않습니다. `npm test`로 빌드 후 전체 실행.
