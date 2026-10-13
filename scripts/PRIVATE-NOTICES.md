# 개인 공지(한 멤버에게만 보이는 공지)

관리 탭 공지에서 "받는 사람"을 고르면 그 멤버의 런처에만 공지가 보이고, 그 멤버가 접속해 있는
서버에서는 게임 화면 배너로도 한 번 나옵니다. "모두"를 고르면 지금까지처럼 모든 멤버에게 보입니다.

## 구성

| 부분 | 파일 | 하는 일 |
|---|---|---|
| 데이터베이스 | `supabase/migrations/20261012120000_add_private_notices.sql` | 공지 표에 `target_user_id`, 대상별 활성 공지 1개, `launcher_admin_set_notice`/`clear_notice`의 선택 인자 |
| 서버 함수 | `supabase/functions/launcher-access/{notice,admin,index}.ts` | `setNotice`·`clearNotice`의 `targetUserId`, 멤버별 `notice` 응답, 관리자용 `adminNotices` |
| 런처 | `src/renderer/AdminPanel.tsx`, `src/main/admin-ipc.ts`, `src/renderer/useNotice.ts` | 받는 사람 선택, 지금 공지 목록, 개인 공지 표시 |
| 게임 배너 | `scripts/notice-relay.mjs`, `scripts/bweeep-notify.mjs` | 모두 공지는 `tellraw @a`, 개인 공지는 접속 중인 그 사람에게만 `tellraw <게임 이름>` |

## 운영에 반영하는 순서 (순서가 중요합니다)

지금 운영에서 도는 공지 중계는 "가장 최근 공지 1개"를 모두에게 보냅니다. 개인 공지가 올라온 뒤에도
그 옛 중계가 돌고 있으면 개인 공지가 모두에게 방송될 수 있으므로, 아래 순서를 지킵니다.

1. **마이그레이션 적용** (`20261012120000_add_private_notices.sql`). 이 시점에는 개인 공지를
   올릴 수 있는 곳이 아직 없습니다(옛 서버 함수는 대상을 모릅니다).
2. **중계 다시 설치**: `node scripts/notice-relay.mjs --install` 로 새 `notice-relay.mjs`·
   `bweeep-notify.mjs`를 게이트 폴더에 복사하고 `systemctl --user restart bweeep-notice-relay`.
   새 중계는 모두 공지만 모두에게 보내고(`target_user_id`가 없는 행), 마이그레이션 전의 표 모양도 읽습니다.
3. **서버 함수 배포** (`launcher-access`, `--no-verify-jwt`). 이후부터 개인 공지를 올릴 수 있습니다.
4. 런처 릴리스. 새 런처는 서버 함수가 개인 공지를 아는지(`adminNotices`가 되는지) 먼저 확인한 뒤에만
   개인 공지를 보내고, 모르는 서버에서는 받는 사람 선택이 잠깁니다.

되돌리기: 개인 공지를 모두 내리고 서버 함수를 이전 버전으로 되돌린 뒤 마이그레이션은 그대로 둬도
됩니다(새 함수 인자는 기본값이 있어 이전 호출이 그대로 동작합니다).

## 확인

- `bash scripts/verify-private-notices.sh` — 일회용 Postgres에서 마이그레이션 두 개와 25개 검사
- `npx -y deno@2 test` (`supabase/functions/launcher-access`) — 서버 함수
- `node scripts/verify-notice.mjs`, `node scripts/verify-notice-relay.mjs`, 화면 미리보기(`BWEEP_PREVIEW_ADMIN=true`)
