# 서버 팩의 시작 키 (`defaultKeys`)

플레이어의 `options.txt`는 서버를 바꿔도 그대로 따라옵니다. 그래서 팩이 `config/yosbr/options.txt`로 정해 둔
시작 키는 YOSBR가 "`options.txt`가 없을 때만" 쓰기 때문에 이미 게임을 해 본 플레이어에게는 적용되지 않고,
모드들이 자기 기본 키로 돌아가 서로 겹칩니다(예: Cobblemon 요약과 Xaero 월드맵이 둘 다 M).

런처는 플레이어의 `options.txt`를 복원한 직후(`src/main/key-defaults.ts`) 다음을 합니다.

1. 팩의 시작 키 = 인스턴스의 `config/yosbr/options.txt`의 `key_*` 줄 + 매니페스트의 `defaultKeys`(뒤쪽이 이깁니다).
2. 플레이어 파일에 **없는** 키는 팩의 값으로 채웁니다.
3. 같은 키에 둘 이상이 묶여 있으면(`key.keyboard.unknown`은 제외) 팩의 값이 있고, 그 값이 비어 있는 키를
   팩의 값으로 옮깁니다. 이미 옮긴 키는 `<인스턴스>/.bweeep/key-defaults-applied.json`에 팩별로 기록하고
   다시는 건드리지 않습니다. 그래서 플레이어가 나중에 직접 바꾼 키는 그대로 남습니다.
4. 고친 파일은 공유 `options.txt`에도 바로 씁니다. 다른 서버에도 같은 키로 따라갑니다.

`key_*` 줄 밖은 건드리지 않고, 줄바꿈(CRLF/LF)과 마지막 줄 형식을 그대로 둡니다. `options.txt`가 아예 없으면 아무것도 하지 않습니다.

## 매니페스트 예시 (Cobblemon 팩)

```json
"defaultKeys": { "key.craftingtweaks.refill_last_stack": "key.keyboard.h" }
```

- 이름은 `options.txt`의 `key_` 뒤쪽 전부입니다. Crafting Tweaks의 항목은 `key_key.craftingtweaks.refill_last_stack`이므로
  `key.craftingtweaks.refill_last_stack`입니다(앞의 `key.`가 이름의 일부입니다).
- 값은 `key.keyboard.<키>` 또는 `key.mouse.<버튼>` 형식만 받습니다(`key.keyboard.unknown`은 "비움").
- 이 값 하나로 Tab 중복(Crafting Tweaks 마지막 스택 채우기 ↔ 플레이어 목록)이 풀립니다. H는 팩에서 쓰이지 않는 키입니다.
- 카탈로그에 넣는 것은 이 런처가 배포된 뒤 따로 합니다. 이 기능이 없는 옛 런처는 `defaultKeys`를 무시하므로 해가 없습니다.

## 팩 설정만으로 풀리는 것 (Cobblemon 1.8.2 기준)

| 키 | 겹치는 동작 | 해결 |
|---|---|---|
| M | Cobblemon 요약 / Xaero 월드맵 | 월드맵을 N으로 (팩 yosbr) |
| O | Cobblemon 파티 숨기기 / Iris 셰이더 선택 | Iris 키 해제 (팩 yosbr) |
| R | Cobblemon 포켓몬 던지기 / Iris 리로드 | Iris 키 해제 (팩 yosbr) |
| Tab | 플레이어 목록 / Crafting Tweaks 채우기 | `defaultKeys`로 H |

남는 겹침은 JEI가 JEI 화면 안에서만 쓰는 키들(`JeiKeyConflictContext`)이라 실제로는 부딪치지 않지만, 마인크래프트 설정 화면에는 빨갛게 보입니다.
