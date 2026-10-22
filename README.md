# pi-ssh-helper

SSH 너머의 장비(로봇, 워크스테이션, 임베디드 보드)에서 pi의 헬퍼 도구를 그대로 쓰기 위한 확장입니다.

두 가지를 합니다.

1. **원격 진단** — `ssh_host_status`, `ssh_detect_capabilities`, `ssh_exec`로 원격의 도달성·툴체인·명령 결과를 확인합니다.
2. **도구 라우팅** — `/ssh-remote on <host>` 한 번으로 `pi-ros-helper` / `pi-python-helper` / `pi-rust-helper`의 모든 서브프로세스가 원격에서 실행되게 합니다.

## 왜 별도 패키지인가

`pi-helper-core` 0.1.3의 **transport seam**을 사용합니다. 코어의 모든 명령은 `runCommand()` 한 곳을 지나고, 여기에 transport를 등록하면 호출부 30여 곳을 고치지 않고도 전체가 원격을 보게 됩니다. 이 확장은 그 transport의 SSH 구현체입니다.

```
pi-ssh-helper  ──setTransport()──►  pi-helper-core
                                        │  runCommand()
                                        ▼
                     pi-ros-helper / pi-python-helper / pi-rust-helper (무수정)
```

로컬 read/write/edit/bash 라우팅, SFTP, 포트포워딩은 구현하지 않습니다. 그 영역에는 이미 상위 품질의 확장이 있고, 재구현은 손실입니다.

## 설치

```bash
pi install npm:pi-ssh-helper
```

저장소에서 직접 설치하거나 개발 중에 쓸 때:

```bash
pi install git:github.com/wkqco33/pi-ssh-helper
pi install ./pi-ssh-helper          # 이 저장소를 클론한 디렉터리에서
```

## 설정

연결 정보는 `~/.ssh/config`를 그대로 재사용하고, ssh에 없는 개념만 `~/.pi/agent/ssh-helper.json`에 적습니다.

```json
{
  "defaultHost": "robot-01",
  "hosts": {
    "robot-01": {
      "hostname": "10.0.0.5",
      "user": "robot",
      "port": 22,
      "remoteWorkspace": "/home/robot/ws",
      "localWorkspace": "/home/me/ws",
      "prelude": ["source /opt/ros/humble/setup.bash"],
      "allowMutating": false
    }
  }
}
```

| 키 | 의미 |
|---|---|
| `hostname` / `user` / `port` / `identityFile` / `proxyJump` | 생략하면 `~/.ssh/config`의 같은 alias 값이 쓰입니다. ssh 규칙대로 **먼저 나온 값이 이깁니다** |
| `remoteWorkspace` | 같은 프로젝트의 원격 경로. **필수** — 추측하지 않습니다 |
| `localWorkspace` | `remoteWorkspace`에 대응하는 로컬 경로. 생략하면 `/ssh-remote on` 시점의 pi cwd |
| `prelude` | 매 명령 전에 실행할 셸 라인. ROS `setup.bash`가 여기 들어갑니다 |
| `allowMutating` | `mutating`/`irreversible` 명령 허용 여부. 기본 `false` |
| `connectTimeoutSeconds` | ssh 연결 타임아웃. 기본 10 |

설정 파일의 **오타는 거부**됩니다. `remoteWorksapce`처럼 무시되면 나중에 "엉뚱한 디렉터리에서 빌드했다"로 나타나기 때문입니다. `PI_SSH_HELPER_CONFIG`로 경로를 바꿀 수 있습니다.

`Match`/`Include`/`ProxyCommand`/`!` 부정 패턴은 해석하지 않습니다. 그런 설정에 의존하는 호스트는 helper 설정에 직접 적어야 합니다.

## 사용

```
/ssh-remote on robot-01        # 활성화 (도달성 probe 성공 후에만)
/ssh-remote status             # 현재 대상
/ssh-remote hosts              # 설정된 alias 목록
/ssh-remote off                # 로컬로 복귀
```

활성화는 **사용자 명령으로만** 됩니다. 모델이 스스로 모든 헬퍼 도구를 다른 장비로 돌리면 잘못 조준한 것을 알아챌 방법이 없기 때문입니다.

| 도구 | 위험도 | 설명 |
|---|---|---|
| `ssh_host_status` | read-only | 도달성, 지연, 원격 userland(bash/ros2/python3/rsync/timeout/sftp/docker) 유무 |
| `ssh_detect_capabilities` | read-only | 커널, bash/python 버전, `/opt/ros` 배포판 |
| `ssh_exec` | 명령에 따라 다름 | 원격 셸 명령 1회 실행, 출력 상한 적용 |

## 안전 규칙

- **경로 매핑은 fail-closed**입니다. 로컬 cwd가 매핑 루트 밖이면 명령을 실행하지 않고 실패합니다. 엉뚱한 트리에서 빌드/테스트가 도는 것보다 낫습니다.
- **`BatchMode=yes`** — 비밀번호·호스트키 질문은 도구 호출을 매달리게 하므로 즉시 실패시킵니다. 키 인증이 전제입니다.
- **원격 변경은 2단계 opt-in** — 호스트 설정의 `allowMutating: true` **그리고** 호출의 `allowMutating: true`가 모두 있어야 실행됩니다.
- **환경은 전달하지 않습니다** — 호출별 overlay만 원격으로 보냅니다. 로컬 `PATH`를 보내면 같은 이름의 로컬 바이너리가 원격 툴체인을 가립니다.
- **출력 상한** — stdout/stderr는 100KB에서 잘리고, 모델에게는 16KB까지만 전달합니다.
- **타임아웃은 로컬** — 로컬 타이머가 ssh 클라이언트 프로세스 그룹을 종료합니다. 원격에 GNU `timeout`이 없어도 동작합니다. 원격 프로세스가 남을 수 있는 것은 알려진 한계입니다.

## 지원 범위

| 항목 | 지원 |
|---|---|
| Node.js | 20 / 22 / 24 (CI가 세 버전 모두에서 `npm run check`를 실행) |
| pi | `pi-package` 확장 API (`pi.extensions`) |
| 원격 OS | POSIX 셸 + `bash`가 있는 Linux/macOS. Windows 원격은 미지원 |
| 인증 | SSH 키 / ssh-agent (`BatchMode=yes`) |
| 의존성 | `pi-helper-core@^0.1.3` (transport seam) |

**0.y.z 단계입니다.** 공개 도구 이름(`ssh_*`, `/ssh-remote`)은 유지하되, 설정 키·출력 `data` 필드·오류 코드는 마이너 릴리스에서 바뀔 수 있습니다. 버전 규칙은 [SemVer](https://semver.org/)를 따르고 변경 내역은 [`CHANGELOG.md`](CHANGELOG.md)에 남깁니다.

## 제한 (알려진 것)

- 비밀번호/passphrase 대화형 인증 미지원 (키 인증 + ssh-agent 전제)
- 원격 `Match`/`Include`/`ProxyCommand` 미지원
- DDS 도달성 트리아지(로컬↔원격 graph 비교)와 로그/rosbag 회수는 다음 단계입니다
- Windows 원격 미지원 (POSIX 경로·셸 전제)

## 개발

```bash
npm ci
npm test              # 42 tests
npm run typecheck
npm run check         # test + typecheck + format:check + pack-check
```

기여 규칙과 테스트 원칙은 [`CONTRIBUTING.md`](CONTRIBUTING.md), 에이전트용 개발 규칙은 [`AGENTS.md`](AGENTS.md)에 있습니다. 취약점 신고는 [`SECURITY.md`](SECURITY.md)의 절차를 따릅니다.

## 릴리스

`package.json` 버전을 올리고 CHANGELOG를 옮긴 뒤 `v<version>` 태그를 푸시하면 [`.github/workflows/publish.yml`](.github/workflows/publish.yml)이 npm provenance와 함께 배포합니다. 릴리스는 로컬이 아니라 CI에서만 수행합니다.

### 최초 배포만 수동이어야 합니다 (중요)

**npm Trusted Publishing(OIDC)은 패키지의 최초 버전을 만들 수 없습니다.** trusted publisher는 이미 존재하는 패키지에만 설정할 수 있기 때문에, 신규 패키지의 첫 배포는 OIDC로 실패하고 `ENEEDAUTH`가 나옵니다(npm/cli#8544, npm/documentation#1926). 인증 설정 오류처럼 보이지만 실제 원인은 그게 아닙니다.

최초 1회만:

1. `npm login` (패키지 소유자 계정)
2. `npm publish --access public` — **provenance 없이** 올라갑니다
3. npmjs.com → 패키지 → Settings → **Trusted Publisher** → GitHub Actions
   - Organization or user: `wkqco33`
   - Repository: `pi-ssh-helper`
   - Workflow filename: `publish.yml` (경로가 아니라 파일명만, 대소문자 구분)
   - Allowed actions: `npm publish`
4. 이후 태그 푸시는 OIDC + provenance로 자동 배포됩니다

부트스트랩 후에는 Settings → Publishing access에서 **"Require two-factor authentication and disallow tokens"**를 켜 두는 것이 권장됩니다.

> 워크플로에 `actions/setup-node`의 `registry-url`을 쓰지 마세요. `_authToken=${NODE_AUTH_TOKEN}` 줄을 써 넣고, 토큰이 없을 때 빈 값으로 확장되어 **OIDC 대신 일반 인증을 시도**합니다(ENEEDAUTH/E404의 가장 흔한 원인).

## 상태

- `0.1.0` — 최초 배포 전. 위 "최초 배포" 절차 후 `latest`가 됩니다.
- TypeScript 소스를 그대로 실행합니다(빌드 단계 없음). pi 확장 생태계가 TS를 직접 로드하기 때문입니다.
- `pi-helper-core`의 transport seam을 소비하는 첫 패키지입니다.
