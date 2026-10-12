# 서버 팩의 시작 키 (`defaultKeys`)

플레이어의 `options.txt`는 서버를 바꿔도 그대로 따라옵니다. 그래서 팩이 `config/yosbr/options.txt`로 정해 둔
시작 키는 YOSBR가 "`options.txt`가 없을 때만" 쓰기 때문에 이미 게임을 해 본 플레이어에게는 적용되지 않고,
모드들이 자기 기본 키로 돌아가 서로 겹칩니다(예: Cobblemon 요약과 Xaero 월드맵이 둘 다 M).

런처는 플레이어의 `options.txt`를 복원한 직후(`src/main/key-defaults.ts`) 다음을 합니다.

1. 팩의 시작 키 = 인스턴스의 `config/yosbr/options.txt`의 `key_*` 줄 + 매니페스트의 `defaultKeys`.
   같은 키가 둘 다 있으면 **매니페스트가 이깁니다**(서버 주인이 정한 값이 팩 제작자의 값보다 우선).
2. 플레이어 파일에 **없는** 키는 팩의 값으로 채웁니다.
3. `defaultKeys`에 적은 키는 **한 번만** 그 값으로 맞춥니다. 충돌이 없어도 맞춥니다(새 플레이어의 YOSBR 파일에는
   충돌이 없지만 서버 주인은 정한 키를 원하기 때문입니다). 그 값을 이미 다른 키가 쓰고 있으면 건드리지 않습니다.
   이름 순서와 상관없이 같은 결과가 나옵니다(요약이 M을 비운 뒤에 지도가 M을 가져갑니다).
4. 그 밖에 같은 키에 둘 이상이 묶여 있으면(`key.keyboard.unknown`은 제외) 팩의 값이 있고 그 값이 비어 있는 키를
   팩의 값으로 옮깁니다(Iris를 해제하는 팩 제작자의 yosbr 선택이 이쪽입니다).
5. 맞춘 키는 `<인스턴스>/.bweeep/key-defaults-applied.json`에 팩별로 기록하고 다시는 건드리지 않습니다.
   그래서 플레이어가 나중에 직접 바꾼 키는 충돌이 있어도 그대로 남습니다.
6. 고친 파일은 공유 `options.txt`에도 바로 씁니다. 다른 서버에도 같은 키로 따라갑니다.

`key_*` 줄 밖은 건드리지 않고, 줄바꿈(CRLF/LF)과 마지막 줄 형식을 그대로 둡니다. `options.txt`가 아예 없으면 아무것도 하지 않습니다.

## 매니페스트 예시 (Cobblemon 팩)

```json
"defaultKeys": { "key.cobblemon.summary": "key.keyboard.i", "gui.xaero_open_map": "key.keyboard.m" }
```

- 이름은 `options.txt`의 `key_` 뒤쪽 전부입니다(Cobblemon 요약은 `key_key.cobblemon.summary`이므로 `key.cobblemon.summary`).
- 값은 `key.keyboard.<키>` 또는 `key.mouse.<버튼>` 형식만 받습니다(`key.keyboard.unknown`은 "비움").
- 요약은 I, 월드맵은 M입니다. I는 팩의 `options.txt`(모드 기본값, 팩 yosbr)와 EMI 설정 어디에서도 쓰이지 않는 키입니다.
  팩 yosbr는 요약 M, 월드맵 N으로 갈라 두었는데, 이 값이 그것을 덮어씁니다.
- 카탈로그에 넣는 것은 이 런처가 배포된 뒤 따로 합니다. 이 기능이 없는 옛 런처는 `defaultKeys`를 무시하므로 해가 없습니다.

## 팩 설정과 함께 풀리는 것 (Cobblemon 1.8.2 기준)

| 키 | 겹치는 동작 | 해결 |
|---|---|---|
| M | Cobblemon 요약 / Xaero 월드맵 | `defaultKeys`: 요약 I, 월드맵 M |
| O | Cobblemon 파티 숨기기 / Iris 셰이더 선택 | Iris 키 해제 (팩 yosbr) |
| R | Cobblemon 포켓몬 던지기 / Iris 리로드 | Iris 키 해제 (팩 yosbr) |

남는 겹침은 JEI가 JEI 화면 안에서만 쓰는 키들(`JeiKeyConflictContext`)과, 이번에 손대지 않기로 한 키들입니다.
JEI 키는 실제로는 부딪치지 않지만 마인크래프트 설정 화면에는 빨갛게 보입니다.
