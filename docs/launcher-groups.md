# 런처 무리와 서버 배정

무리는 `original`, `friend-a`, `friend-b` 세 개입니다. 기존 회원·초대코드와 `groupId`가 없는 기존 서버 manifest는 모두 `original`에 속합니다. `friend-a`, `friend-b`는 서버를 배정하기 전까지 빈 목록이 정상입니다.

- 관리자는 친구 초대 화면에서 초대코드의 무리를 고릅니다. 일반 회원이 만든 코드는 자신의 무리를 그대로 따릅니다. 코드 사용 시 무리는 데이터베이스 함수가 코드에서 복사합니다.
- 새 서버의 manifest에 `"groupId": "friend-a"` 또는 `"friend-b"`를 지정하고 평소대로 릴리스를 게시합니다. 목록과 개별 manifest 요청 모두 회원의 무리를 검사합니다.
- 게임 로그인 API도 무리를 검사합니다. `original` 서버는 기존 `/functions/v1/yggdrasil` 주소를 그대로 사용합니다. 새 무리 서버는 각각 `/functions/v1/yggdrasil/groups/friend-a`, `/functions/v1/yggdrasil/groups/friend-b`를 서버의 authlib-injector API 주소로 사용해야 합니다. 테스트 전용 서버는 뒤에 `/testers`를 붙입니다. 런처는 선택한 manifest에 맞는 주소로 게임을 실행합니다.
- 관리자는 모든 무리의 서버를 볼 수 있고 접속할 수 있습니다. 일반 회원은 자기 무리만 볼 수 있고 접속할 수 있습니다.

배포 순서: 데이터베이스 마이그레이션 → `launcher-access`와 `yggdrasil` Edge Function → 해당 기능이 포함된 런처. 기존 서버는 변경할 필요가 없습니다. 새 무리 서버를 게시하기 전에 그 서버의 인증 API 주소를 확인하세요.
