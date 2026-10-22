# 기여 가이드

## 개발 환경

- Node.js **20 이상** (CI는 20/22/24를 검증합니다)
- `npm ci` 후 `npm run check`

```bash
npm ci
npm test          # tsx --test test/*.test.ts
npm run typecheck
npm run check     # test + typecheck + format:check + pack-check
```

`npm run check`가 이 저장소의 유일한 완료 게이트입니다. 통과하지 않은 변경은 "완료"가 아닙니다.

## 테스트 원칙

- **실패를 먼저 재현**한 뒤 고칩니다. 재현 테스트 없이 들어온 수정은 리뷰에서 되돌리기 쉽습니다.
- 인용·경로 매핑·설정 파싱은 **동작으로 검증**합니다. 예를 들어 `test/quote.test.ts`는 문자열 비교가 아니라 `sh`에 실제로 넘겨 결과를 확인합니다.
- `test/integration.test.ts`는 ROS가 설치된 환경에서만 실행되고 없으면 skip됩니다. skip은 통과가 아니므로, 원격 관련 변경은 실패 시 로그에 skip 사유를 남기세요.
- 원격 시험이 필요하면 로컬 sshd를 쓰되, **`~/.ssh/config`나 `known_hosts`를 건드리지 말고** 테스트용 디렉터리에서 대체 `ssh` 실행 파일을 PATH 앞에 두는 방식을 사용합니다(`test/transport.test.ts` 참고).

## 코드 규칙

- TypeScript strict, Prettier(`npm run format`) 기준을 따릅니다.
- **pi API는 `extensions/index.ts`에만** 둡니다. 판단 로직은 `src/`에 두고 테스트합니다.
- 원격 셸 문자열을 만들 때는 반드시 `shQuote`/`shJoin`(`src/ssh/quote.ts`)을 거칩니다. 예외는 사용자가 준 `ssh_exec`의 `command` 하나뿐입니다.
- 경로 매핑은 `mapPathPrefix`의 fail-closed 계약을 유지합니다. 매핑 실패를 fallback 경로로 바꾸지 마세요.
- `allowMutating`의 기본값은 `false`입니다. 기본값을 바꾸거나 게이트를 한 단계로 줄이는 변경은 보안 변경으로 다룹니다.
- 주석은 **왜**를 적습니다. 무엇을 하는지는 코드가 말하게 두고, 에이전트 독백·군더더기는 넣지 않습니다.

## 커밋·PR

- Conventional Commits 형식을 사용하고, 타입 접두사는 영어로 둡니다: `feat(ssh): 원격 prelude를 probe에도 적용`
- 본문은 한국어로 적고, **무엇이 왜 바뀌었는지**와 검증 방법을 한두 줄로 남깁니다.
- PR에는 다음을 포함합니다: 변경 요약, 검증 결과(`npm run check` 출력 요약), 위험도 변화(있다면), 관련 이슈.
- 사용자에게 보이는 동작이 바뀌면 `README.md`와 `CHANGELOG.md`의 `[Unreleased]`를 함께 갱신합니다.

## 릴리스

`package.json` 버전을 올리고 CHANGELOG를 옮긴 뒤 `v<version>` 태그를 푸시하면 `.github/workflows/publish.yml`이 npm provenance와 함께 배포합니다.

**최초 배포만 수동이어야 합니다.** npm Trusted Publishing은 아직 존재하지 않는 패키지의 첫 버전을 만들 수 없습니다(trusted publisher는 기존 패키지에만 설정 가능). 첫 배포에서 OIDC를 쓰면 `ENEEDAUTH`가 나며, 이는 인증 설정 오류처럼 보이지만 실제 원인은 그게 아닙니다. 자세한 절차는 `README.md`의 "릴리스" 절을 참고하세요.

## 보안

취약점은 공개 이슈가 아니라 [`SECURITY.md`](SECURITY.md)의 절차로 신고해 주세요.
