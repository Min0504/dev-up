# DevUp 기능

[English](FEATURES.md) | **한국어**

각 기능이 무엇을 해결하고 어떻게 동작하는지 정리한 카탈로그입니다.
플래그·스키마의 정확한 표기는 [USAGE.ko.md](USAGE.ko.md), 내부 동작은 [ARCHITECTURE.ko.md](ARCHITECTURE.ko.md)를 참고하세요.

## 한 줄 기동 / 종료

```bash
devup myapp && devdown myapp
```

프로젝트를 열 때마다 Docker Desktop 확인 → compose up → DB 대기 → 백엔드 → 프론트엔드 → 터미널 배치를 손으로 반복하는 대신, YAML에 한 번 선언하면 명령 한 줄로 같은 환경이 재현됩니다. `devup`은 멱등이라 이미 떠 있는 서비스는 건너뛰고 죽은 것만 다시 올립니다.

## 선언적 YAML 설정

- 프로젝트 = YAML 파일 하나. `~/.devup/projects/`에 두거나 repo에 `devup.yaml`로 커밋 후 `dev register`.
- 경로는 `~`와 상대경로를 지원해 **다른 Mac에 복사해도 그대로 동작**합니다.
- 오타(알 수 없는 키)는 경고로, 실제 오류는 전부 모아 한 번에 보여줍니다. `dev validate`로 실행 없이 검증만 할 수 있습니다.

## 의존성 오케스트레이션

`depends_on`으로 서비스 그래프를 선언하면:

- 위상정렬로 **레벨별 병렬 기동** — postgres와 redis는 동시에, backend는 둘 다 healthy 된 후에.
- 사이클은 설정 오류로 즉시 거부.
- 실패 시 그 위에 얹힌 서비스만 자동 skip — DB가 안 떴는데 마이그레이션이 도는 일이 없습니다.
- `--only backend`는 필요한 의존성까지 함께 올리고, `devdown --only postgres`는 반대로 postgres에 의존하는 것까지 함께 내립니다.

## 서비스 타입 3종

| 타입 | 용도 | 수명 관리 |
|---|---|---|
| `docker` | compose 스택의 특정 서비스 | `compose up -d` / `stop` — 해당 서비스만 |
| `command` | dev 서버 등 장기 실행 프로세스 | 프로세스 그룹 + PID 추적, 로그 파일 자동 |
| `script` | 마이그레이션 등 일회성 작업 | 매 `devup`마다 완료까지 실행, 실패 시 의존 서비스 중단 |

## 실제 준비 상태를 보는 헬스체크

프로세스가 떠 있다는 것과 요청을 받을 수 있다는 것을 구분합니다.

- 6종 프로브: `tcp` · `http` · `postgres`(pg_isready) · `redis`(PING) · `docker`(컨테이너 HEALTHCHECK) · `command`(임의 명령)
- `healthcheck: postgres` 같은 단축 표기, `timeout`/`interval` 조정 가능
- 호스트에 pg/redis 클라이언트가 없으면 컨테이너 내부 실행 → TCP 순으로 자동 폴백
- 상태는 `healthy / running / starting / unhealthy / stopped / failed` 6단계로 구분

## 내 것만 종료하는 프로세스 관리

`devdown`이 절대 하지 않는 일: 이름으로 프로세스 찾기, 포트로 프로세스 죽이기, `pkill node`.

시작한 프로세스의 PID·프로세스 그룹·시작 시각(`ps lstart`)을 state 파일에 기록하고, 종료 시 시각까지 일치해야만 시그널을 보냅니다. PID가 다른 프로세스에 재사용됐다면 종료하지 않습니다. SIGTERM 후 유예시간(`stop_grace`)을 주고 남으면 SIGKILL, 프로세스 그룹 전체에 보내므로 자식 프로세스도 남지 않습니다.

외부에서 서비스를 직접 죽였다면? `devstatus`가 `failed`로 감지하고, 다음 `devup`이 그 서비스만 다시 올립니다.

## tmux 자동 구성

```text
myapp (session)
├── shell   ← 프로젝트 루트에서 열린 작업용 셸
├── expo    ← tmux: true 서비스 (키 입력 가능, 로그는 tee로 파일에도 기록)
└── logs    ← background 서비스 로그 tail -F
```

세션이 이미 있으면 재사용하고, `devdown`이 세션까지 정리합니다(`--keep-tmux`로 유지 가능). Expo CLI처럼 인터랙티브 키가 필요한 서비스에 `tmux: true` 하나만 붙이면 됩니다. tmux가 없으면 전부 background 모드로 동작합니다.

## 로그 시스템

- command/tmux 서비스: stdout+stderr가 `~/.devup/logs/<프로젝트>/<서비스>.log`로.
- docker 서비스: `docker compose logs`로 위임.
- `devlogs myapp` → fzf로 서비스 선택, `-f` follow, `-n` 줄 수, `--clear` 비우기.
- 서비스 시작 실패 시 해당 로그의 끝부분을 즉시 보여줘 원인을 바로 확인할 수 있습니다.

## 상태 대시보드

```text
myapp                    branch: feat/auth (dirty)   tmux: myapp

● postgres   docker   :5432   healthy   up 2h
● backend    command  :3000   healthy   up 2h   pid 4242
● expo       tmux     :8081   running   up 2h
```

`devstatus`(인자 없음)는 전 프로젝트 요약을, `--json`은 동일 정보를 안정된 스키마로 출력해 다른 도구에서 소비할 수 있습니다.

## 환경 진단 (dev doctor)

Node/Git/tmux/Docker CLI·데몬/fzf 존재와 버전, `~/.devup` 쓰기 권한, 등록된 모든 프로젝트 설정의 유효성, CLI PATH 등록 여부를 검사하고, 문제마다 **구체적인 해결 명령**을 함께 출력합니다.

## 셸 자동완성

`dev completion zsh|bash`가 서브커맨드와 **등록된 프로젝트 이름**까지 완성하는 스크립트를 생성합니다.

## 안전한 실패

- 설정 오류는 발견된 문제를 전부 모아 exit 2.
- 일부 서비스 실패는 성공한 것을 유지한 채 exit 1 — 다시 `devup` 하면 실패분만 재시도.
- Ctrl-C 중단에도 state는 원자적으로 저장되어 `devdown`으로 깔끔하게 정리 가능.
- Docker 데몬 꺼짐, 도구 없음 등은 원인과 해결법을 함께 안내.
