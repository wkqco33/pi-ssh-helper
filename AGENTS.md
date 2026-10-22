# AGENTS.md — pi-ssh-helper 개발 가이드

이 파일은 이 저장소에서 작업하는 에이전트가 따르는 규칙입니다. 사용자 지침(`~/.pi/agent/AGENTS.md`)이 있으면 그쪽이 우선합니다.

## 이 패키지가 하는 일

`pi-helper-core`의 **transport seam**에 SSH 구현을 등록해, `pi-ros-helper` / `pi-python-helper` / `pi-rust-helper`의 모든 서브프로세스를 원격에서 실행합니다. 그 위에 원격 도구 3개와 명령 1개를 제공합니다.

```
extensions/index.ts   pi API만 (도구·명령 등록)
src/commands/         /ssh-remote
src/tools/            ssh_host_status, ssh_detect_capabilities, ssh_exec
src/ssh/              transport(seam 구현), command/quote(원격 셸 조립), profile/config(해석), capability(probe), shell(임의 셸 1줄)
src/session.ts        활성화 상태 (사용자 명령으로만 설치)
src/hosts.ts          설정 로드·프로필 해석
```

## 반드시 지킬 계약

1. **seam은 한 곳**: 원격 라우팅은 `src/ssh/transport.ts`의 `CommandTransport` 구현으로만 한다. `src/tools/`나 `src/commands/`에서 별도 ssh 실행 경로를 만들지 않는다.
2. **인용**: 원격 셸 문자열에 값을 넣을 때는 `shQuote`/`shJoin`만 사용한다. 예외는 `ssh_exec`의 `command`(사용자가 준 셸 한 줄) 하나뿐이다.
3. **경로 매핑 fail-closed**: 매핑 불가 cwd는 실행하지 않고 실패한다. fallback 디렉터리로 대체하지 않는다.
4. **원격 변경 2단계 옵트인**: 호스트 `allowMutating` + 호출 `allowMutating`. 기본값 `false`를 바꾸지 않는다. 위험도는 `classifyCommand`로 판정한다.
5. **활성화는 사용자만**: 모델이 스스로 transport를 설치할 수 있게 만들지 않는다(`/ssh-remote on`만).
6. **환경 미전달**: 로컬 `process.env`를 통째로 보내지 않는다. 호출별 overlay만 보낸다.
7. **pi API 격리**: `@earendil-works/pi-coding-agent` import는 `extensions/`와 `src/tools/`·`src/commands/`의 타입/등록 지점에만 둔다. 판단 로직은 pi 없이 테스트 가능해야 한다.

## 검증

```bash
npm run check     # 이 저장소의 유일한 완료 게이트: test + typecheck + format:check + pack-check
```

- 완료를 선언하기 전에 **실제로 실행**했는지 확인한다. 프리뷰·dry-run은 통과가 아니다.
- 원격/SSH 관련 변경은 가능하면 실제 sshd로 확인한다. 자격 증명이 없으면 `test/transport.test.ts`의 대체 `ssh` 방식으로 seam까지만 검증하고, **실 원격 미검증임을 보고**한다.
- `test/integration.test.ts`는 ROS 미설치 환경에서 skip된다. skip을 통과로 보고하지 않는다.
- 실패를 먼저 재현하는 테스트를 추가한 뒤 수정한다.

## 문서·커밋

- 사용자 동작 변경 시 `README.md`와 `CHANGELOG.md`의 `[Unreleased]`를 함께 갱신한다.
- Conventional Commits, 타입 접두사 영어 + 본문 한국어.
- 테스트 개수·지원 매트릭스처럼 README에 적힌 사실이 바뀌면 README도 같이 고친다.

## 하지 말 것

- 로컬 read/write/edit/bash 라우팅, SFTP, 포트포워딩 재구현 (이 패키지의 범위가 아니다)
- `StrictHostKeyChecking=no`·`UserKnownHostsFile=/dev/null` 같은 검증 우회 옵션 추가
- `~/.ssh/config`·`known_hosts`를 테스트가 수정하게 만들기
- 비밀번호/passphrase 대화형 인증 추가 (BatchMode 계약을 깬다)
- 토큰·키·개인 경로를 코드·테스트·문서에 커밋
