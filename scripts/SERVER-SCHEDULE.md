# 서버 운영 시간(시간표)

서버마다 열려 있는 시간을 정해 두면, 그 시간이 아닐 때는 **꺼져 있는 서버를 켜지 않고** 런처의 시작 버튼도 막힙니다.
정하는 곳은 게이트 설정(`/home/dev/servers/bweeep-gate/<유닛>.json`) 한 곳뿐입니다. 시간표가 없으면 지금처럼 항상 열려 있습니다.

## 하지 않는 일

- 켜져 있는 서버를 끄지 않습니다. RCON `stop`도, 강제 종료도, 접속 끊기도 없습니다. 시간이 끝났을 때 서버가 켜져 있으면 그대로 두고, 평소처럼 비면 게이트가 스스로 재웁니다.
- 시간이 끝났어도 이미 켜진 서버에는 접속할 수 있습니다. 막는 것은 "꺼진 서버를 켜는 일"뿐입니다.
- 게이트가 대답하지 않거나, 시간 정보가 없거나, 옛 게이트면 런처는 지금처럼 동작합니다(상태를 못 읽었다고 사람을 막지 않습니다).

## 설정 모양

```json
"schedule": {
  "startsOn": "2026-10-23",
  "open": [{ "from": "fri 12:00", "to": "sun 12:00" }]
}
```

- 시간은 모두 **한국 시간**입니다(서머타임 없음).
- `from` 이상 `to` 미만이 열려 있습니다. `to` 가 더 앞이면 주를 넘어 이어집니다(`"sun 12:00"` → `"fri 12:00"`).
- `startsOn` (한국 날짜, 선택): 이 날짜 전에는 항상 열려 있습니다. 코블몬 테스트 기간(테스터 전용, 항상 열림)을 이렇게 둡니다.
- `open` 은 1~14개, 요일은 `mon tue wed thu fri sat sun`. 알 수 없는 항목이나 잘못된 시각이 있으면 게이트가 시작하지 않고 이유를 말합니다(재시작 전에 `show` 로 확인하세요).

## 지금 정해 둔 시간

`scripts/gate-schedule.mjs` 맨 위의 상수 세 개가 전부입니다.

| 상수 | 값 | 뜻 |
|---|---|---|
| `OPEN_HOUR` | `12:00` | 금·일 "오후" 경계. 사용자가 정확한 시각을 말하지 않아 낮 12시로 뒀습니다 |
| `STARTS_ON` | `2026-10-23` | 시간표가 시작되는 첫 금요일. "2주 후 오픈"을 2026-10-09~11 주말 기준으로 읽은 **추정**입니다 |
| `STANDARD_HOURS` | 아래 | 유닛별 시간대 |

- 코블몬 `bweeep-cobblemon-fabric`: 금 12:00 → 일 12:00
- 선릿벨리 `bweeep-society-server`: 일 12:00 → 금 12:00

두 서버는 겹치지도 비지도 않습니다(검증 스크립트가 3주치를 1분 단위로 확인합니다). `STARTS_ON` 이 틀렸다면 그 한 줄만 고치면 됩니다.

## 동작표

| 상황 | 게이트 | 런처 |
|---|---|---|
| 시간 안, 꺼져 있음 | 지금처럼 깨움 | 지금처럼 |
| 시간 밖, 꺼져 있음 | 켜지 않음. 접속은 "지금은 열려 있지 않아요. 금 12:00에 열려요"로 거절, 상태 핑은 `closed` + `nextOpen` | 상단 바 "금 12:00 열림", 시작 버튼 위 한 줄, 시작 버튼 비활성. 메인 프로세스도 같은 답이면 거절(화면이 낡아도 못 우회) |
| 시간 밖, 이미 켜져 있음 | 건드리지 않음. 접속·플레이 그대로 | 켜진 서버로 보임 |
| 시간이 끝나는 순간 접속자가 있음 | 아무 일 없음 | — |
| 시간 밖에 비어서 잠듦 | 다시 켜지 않음(`closed`) | 닫힘 표시 |
| 꺼지는 중(stopping)에 시간 밖 접속 | 거절하고, 다 꺼진 뒤 다시 켜지도 않음 | — |
| 관리자가 손으로 열기 | `<유닛>.open-until` 이 미래면 시간과 상관없이 켜짐 | 상태가 닫힘이면 버튼은 막힘(아래 참고) |

참고: 게이트가 먹통이 된 서버를 다시 시작하는 `recover` 는 그대로입니다(이미 켜져 있던 서버를 되살리는 동작이라 "새로 켜기"가 아닙니다).

## 관리자가 닫힌 서버를 켜야 할 때(테스트 등)

런처 버튼은 닫힘이면 누구에게나 막힙니다(관리자 예외는 런처에 넣지 않았습니다. 게이트가 사용자 권한을 알 방법이 없기 때문입니다). 대신 게이트 쪽에서 손으로 엽니다.

```
node scripts/gate-schedule.mjs open --config /home/dev/servers/bweeep-gate/<유닛>.json --hours 3          # 미리보기
node scripts/gate-schedule.mjs open --config /home/dev/servers/bweeep-gate/<유닛>.json --hours 3 --write  # 3시간 동안 열림
node scripts/gate-schedule.mjs close-by-hand --config ... --write                                            # 끝내기(켜진 서버는 그대로)
```

열어 둔 동안 런처 상태 핑은 `closed` 가 아니므로 버튼도 풀립니다.

## 운영에 켜는 순서(아직 하지 않았습니다)

게이트 프로세스는 코드를 시작할 때만 읽고, 접속이 전부 게이트를 거쳐 가므로 **게이트를 다시 시작하면 그 사람들의 접속이 끊깁니다.** 그래서 아래 순서를 지킵니다.

1. 확인만: `node scripts/gate-schedule.mjs show --config /home/dev/servers/bweeep-gate/bweeep-cobblemon-fabric.json` (시간표는 아직 없음)
2. 새 게이트 코드 깔기, **서버가 비었을 때만**: `node scripts/gate-schedule.mjs install --config <gate.json>` 로 미리보기 → 접속자가 있으면 스스로 멈춥니다 → 비면 `--write`. 유닛마다 한 번씩(코블몬, 선릿벨리).
3. 시간표 쓰기: `apply --config <gate.json>` 미리보기 → `--write` (백업 `gate.json.bak-<시각>` 자동). `startsOn` 전에는 항상 열려 있어서 이 단계는 오늘 해도 아무 일도 일어나지 않습니다.
4. 실행 중인 게이트가 읽게 하기: `reload --config <gate.json> --write` (SIGHUP, 접속은 끊기지 않음). 2번에서 막 다시 시작했다면 이미 읽은 상태라 필요 없습니다.
5. 확인: `show --config <gate.json> --at 2026-10-27T10:00+09:00` 처럼 미래 시각을 넣어 동작을 미리 봅니다.
6. 런처: 이 PR이 병합돼 릴리스된 뒤부터 버튼이 막힙니다. 옛 런처는 닫힌 서버를 "열린 서버"로 보여 주지만, 게이트가 켜지 않고 접속도 거절하므로 서버는 안전합니다.

되돌리기: `clear --config <gate.json> --write` 뒤 `reload --write`. 또는 `gate.json.bak-…` 를 되돌리고 `reload`.

## 검증

`node scripts/verify-server-schedule.mjs` (시간 계산, 경계, 주 넘김, 한국 시간, 엄격한 설정 검사, 가짜 서버로 하는 게이트 시나리오, 도구, 실제 게이트 프로세스의 SIGHUP),
`node scripts/verify-server-gate.mjs`, `node scripts/verify-server-status.mjs`, 런처 화면은 `BWEEP_PREVIEW_SERVER_CLOSED=true node scripts/capture-preview.mjs`.
