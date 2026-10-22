# agent-relay-mcp

업무 에이전트용 중계 MCP 서버. 여러 자체 MCP 서버의 **허용된 도구만** 주소 하나로 제공한다.

- 엔드포인트: `/api/mcp?k=<게이트키>`
- 서버·도구 목록: `lib/backends.js` — 서버를 추가하거나 도구를 열고 닫으려면 이 파일만 고친 뒤 push한다.
- 목록 밖 도구는 `tools/list`에 나오지 않고 `tools/call`도 거부된다.

## 에이전트 설정 (업무 에이전트 페이지용)

- `lib/agents.json`: 에이전트 목록·묶음(groups)·에이전트별 도구 배정(tools 또는 use)·조회 규칙(rules)·안내문(guide).
  페이지는 열릴 때 `relay_config`로 이 내용을 받아 쓰고, 도구는 `relay_call`(tool, arguments)로 이 서버를 거쳐 부른다.
  페이지 사본에는 이 두 도구 이름만 들어 있으므로 **에이전트 추가·삭제, 도구 배정, 규칙 수정은 이 파일만 고쳐 push하면 사본에도 반영된다.**
- 고친 뒤에는 `version` 값을 올리고 `node scripts/check-catalog.js`로 배정된 도구가 모두 허용 목록 안에 있는지 확인한다.

`lib/agents.json` 항목 (모두 페이지 재게시 없이 반영된다)

| 항목 | 내용 |
|---|---|
| `version` | 설정 버전. 고칠 때마다 올린다(페이지가 같은 버전이면 다시 받지 않는다) |
| `ui` | 페이지 제목(title)·상단 이름(brand)·옆 표시(tag, 빈 값이면 숨김)·첫 화면 제목(heading)·안내문(intro)·문서 표지의 작성 주체(dept) |
| `theme` | 색 변수 덮어쓰기. `{"light": {"--accent": "#2346b8"}, "dark": {...}}` 형태, 변수명은 `--영문`, 값은 색·숫자만 |
| `groups` | 첫 화면 묶음(id·title·sub). 배열 순서 = 화면 순서 |
| `agents` | 에이전트. 배열 순서 = 화면 순서. `group`, `icon`(icons의 키), `color`(hue·tint·hue_dark·tint_dark), `tools`(단일형) 또는 `use`(묶음형), `rules`, `guide`, `maxResult`, `attach`·`folder`·`draft`, `digest`(digests의 키) |
| `servers` | 묶음형 에이전트가 쓰는 도구 묶음과 각 도구 설명 |
| `prompts` | Claude에게 주는 지침 틀(single·composite·doc_on·doc_off 줄 배열). `{{name}}` `{{now}}` `{{agent_names}}` `{{rules}}` `{{tool_docs}}` `{{attach_section}}` `{{doc_rules}}` 자리표시, `?attach ` `?draft ` 등으로 시작하는 줄은 그 기능이 있는 에이전트에만 들어감 |
| `digests` | 첨부 파일 자동 요약 지시문(키별 줄 배열, `{name}` `{range}` `{text}` 자리표시) |
| `limits` | 도구 결과를 Claude에게 넘길 때의 최대 크기(바이트) |
| `icons` | 아이콘 SVG(키별). 페이지가 위험 요소를 걸러 낸 뒤 표시한다 |

페이지 코드에 남아 있어 바꾸려면 재게시가 필요한 것: 화면 배치·글꼴, Word·PPT·PDF 서식(색·여백·표지 구성), 첨부 파일 읽기·검색 방식, 결과 줄이기 규칙(TRIM), 오류 안내 문구.
- 화면·문서 서식·첨부 처리 같은 페이지 코드, 그리고 페이지에 없는 새 기능(새 첨부 요약 방식 등)은 페이지를 다시 게시하고 사본을 다시 받아야 한다.

## 계산 도구

- `dcf_calculate`(DCF 계산기)는 **valuation-mcp에 있고** 이 서버는 그대로 넘겨 준다(2026-10-21 dart-mcp에서 옮김 — dart-mcp의 같은 도구는 삭제). 계산 코드는 valuation-mcp 한 벌만 둔다.
- 키를 보내면 안 되는 서버(외부 서버)는 `lib/backends.js` 항목에 `noKey: true`를 둔다.
- `dcfpeer`는 외부 공개 서버(DCF Peer Group, 주소 krvaluation.procpa.co.kr)다. 우리 소유가 아니므로 `noKey: true`로 접근 키를 보내지 않는다. 수집 데이터가 필요한 `search_by_industry`·`peergroup_get_population`·`valuation_get_data`만 열고, 베타·사업의 내용은 `valuation` 서버(valuation-mcp)의 `beta_regression`·`dart_business_section`을 쓴다. 운영자가 서버를 바꾸거나 내리면 이 도구들도 같이 멈춘다.
- `accwiki`는 외부 공개 서버(회계위키, accountingwiki.co.kr)다. `noKey: true`이고, 도구 이름이 `search`·`fetch`처럼 일반적이라 `prefix: "accwiki_"`로 이름을 바꿔 공개한다(호출 때 원래 이름으로 넘김). `tools`에는 원래 이름을 적고, 에이전트 배정(`lib/agents.json`)에는 접두어가 붙은 이름을 쓴다.
- `prefix`를 둔 서버는 `descNote`로 도구 설명 끝에 이름 안내를 붙일 수 있다(설명 속 원래 도구 이름을 새 이름으로 읽게 하기 위함).

## 새 페이지 지원 (2026-10-21)

- `relay_config`·`relay_call`은 선택 인자 `page`(페이지 버전)를 받는다. 새 페이지만 보내고 옛 페이지는 보내지 않는다.
- `relay_config {part: "tools"}`는 도구 찾기용 전체 도구 목록(이름·서버·짧은 설명·간추린 입력 형식)을 돌려준다.
- `agents.json`의 `notices`는 `audience`("all" | "v1" | "v2" | 키 식별자 배열)에 맞는 것만 내려보낸다.
- `agents.json`의 `legacy_until`(한국시간 YYYY-MM-DD)이 지나면 `page` 없는 `relay_call`을 `legacy_message` 문구로 거절한다.
- 사용 기록에 `@page:<버전>` 카운터를 더한다(v1 = 옛 페이지). `relay_usage {group_by: "user_page"}`로 본다.

## 웹 도구 (2026-10-22)

`lib/web.js`의 `web_search`·`fetch_page`는 다른 서버로 넘기지 않고 이 서버가 직접 수행한다(`lib/backends.js`의 `web` 항목, `local: true`).

- `fetch_page`: 직접 접속(무료) → 본문이 거의 없거나 접속이 막히면 Tavily extract(basic, 월 무료 크레딧) → 그래도 안 되면 Nimble extract(브라우저 렌더, 국내 IP, 유료). PDF는 Tavily까지만.
- `web_search`: Tavily search(basic, 1크레딧) → 실패·한도 소진이면 Nimble search(lite).
- robots.txt가 막은 주소는 어느 경로로도 읽지 않는다. 사설망·루프백·메타데이터 주소는 DNS 해석 결과까지 확인해 막고, 리다이렉트마다 다시 확인한다.
- 한도(Redis 카운터, 키 `w:<날짜>:<사용자>:<종류>`·`w:nimble:<월>`): 사람별 하루 `WEB_SEARCH_DAILY`(기본 60)·`WEB_FETCH_DAILY`(기본 400)·`WEB_PAID_FETCH_DAILY`(대체 경로, 기본 40), 서버 전체 월 `NIMBLE_MONTHLY_MAX`(기본 1000). 실패한 호출은 한도에서 되돌린다.
- 이 도구들도 커넥터를 등록한 사람의 일반 채팅에서 쓰인다(같은 한도가 적용된다).

## 환경변수

| 이름 | 용도 |
|---|---|
| `MCP_GATE_KEYS` | 이 서버에 접속할 수 있는 키 목록(쉼표 구분, 사람별 키) |
| `MCP_GATE_MODE` | `enforce`면 키 없는 요청을 401로 차단 |
| `BACKEND_KEY` | 중계 서버가 각 백엔드 서버를 부를 때 쓰는 접근 키 |
| `KV_REST_API_URL`·`KV_REST_API_TOKEN` | 사용 기록 저장소(Upstash Redis, Vercel 마켓플레이스 연결 시 자동 등록) |
| `USAGE_RETENTION_DAYS` | 사용 기록 보관 일수(기본 90) |
| `TAVILY_API_KEY`·`NIMBLE_API_KEY` | 웹 도구의 검색·대체 읽기 경로(에이전트 전용으로 발급한 키). 없으면 그 경로만 건너뛴다 |
| `WEB_SEARCH_DAILY`·`WEB_FETCH_DAILY`·`WEB_PAID_FETCH_DAILY`·`NIMBLE_MONTHLY_MAX` | 웹 도구 한도(위 절 참조) |
| `RELAY_ADMIN_LABELS` | 사용현황 도구를 볼 수 있는 키 식별자(쉼표 구분, 기본 `koo`) |

백엔드마다 다른 키가 필요하면 `lib/backends.js`의 항목에 `keyEnv: "환경변수명"`을 지정한다.

## 사용 기록

도구 호출마다 날짜(한국시간)·사용자(키 식별자)·도구별 호출 수, 실패 수, 소요시간 합계를 Upstash Redis에 더한다
(`lib/usage.js`). 질문 내용·조회 결과는 저장하지 않으며, 기록은 `USAGE_RETENTION_DAYS`일 뒤 자동 삭제된다.

조회는 관리자 전용 도구 `relay_usage`(from·to·group_by)로 한다. 관리자 키가 아니면 `tools/list`에 보이지 않고 호출도 거부된다.

Vercel 함수 로그의 `[call] caller=… tool=…` 줄은 무료 요금제에서 1시간만 보관되므로 즉시 확인용으로만 쓴다.

## 배포

main 브랜치에 push하면 Vercel이 운영 배포를 자동으로 만든다(2026-10-16 Git 연결).
