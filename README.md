# agent-relay-mcp

업무 에이전트용 중계 MCP 서버. 여러 자체 MCP 서버의 **허용된 도구만** 주소 하나로 제공한다.

- 엔드포인트: `/api/mcp?k=<게이트키>`
- 서버·도구 목록: `lib/backends.js` — 서버를 추가하거나 도구를 열고 닫으려면 이 파일만 고친 뒤 push한다.
- 목록 밖 도구는 `relay_call`로도 부를 수 없다.
- **에이전트 페이지 전용(2026-10-24)**: `tools/list`에는 `relay_config`·`relay_call`(관리자는 `relay_usage` 포함)만 나온다. 조회 도구를 `tools/call`로 직접 부르거나, `page` 없이 `relay_config`·`relay_call`을 부르면 "페이지 안에서만 쓸 수 있다"는 안내로 거절한다. 일반 채팅(관리자 계정 포함)에서 이 서버의 조회 도구가 쓰이지 않게 하기 위함이다. 관리자 계정은 각 서버를 커넥터로 직접 연결해 쓰므로 이 서버가 없어도 계정 업무에 영향이 없다.

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
- `agents.json`의 `notices`는 `audience`("all" | "v1" | "v2" | 키 식별자 배열)에 맞는 것만 내려보낸다. `page_min`(예: "4")이 있으면 그 버전 이상 페이지에만 내려보낸다(새 기능 안내를 옛 사본에 띄우지 않기 위함).
- 공지 본문은 `<details><summary>내용 보기</summary>` + 빈 줄 + 본문(마크다운) + 빈 줄 + `</details>`로 감싸 접어 둔다(2026-11-04 사용자 결정 — 제목 목록만 보이고 누르면 펼침). 페이지는 본문을 marked + DOMPurify로 그리므로 모든 판(7판 포함)에서 그대로 접힌다(시험 확인). 빈 줄을 빼면 안쪽 마크다운이 글자 그대로 보인다.
- `page` 없는 `relay_config`·`relay_call`(옛 페이지·일반 채팅)은 거절한다(2026-10-24부터 — 종전 `legacy_until` 날짜 방식은 폐지).
- 옛 페이지(첫 페이지와 그 사본 — `page` 없이 `relay_config`를 부름)에는 종료 안내만 담은 설정(`retiredCatalog`, 조회 도구 없음)을 내려보낸다. 옛 페이지 화면에 "더 이상 작동하지 않으니 삭제해 달라, 단 '업무 에이전트 MCP' 커넥터는 그대로 두라(주소가 같아 새 페이지에서도 그대로 연결됨)"는 안내가 뜬다(2026-10-24). 안내 문구를 바꾸면 `RETIRED_VERSION`도 바꿔야 이미 안내를 받아 둔 페이지에 새 문구가 내려간다.
- 페이지 확인 값(2026-10-24): 환경변수 `RELAY_PAGE_KEYS`(쉼표 구분)가 있으면 `relay_config`·`relay_call`은 인자 `pk`가 그 목록에 있을 때만 받는다. 값은 원본 페이지 코드(`PAGE_KEY`)에 들어 있고 사용자가 입력하지 않는다. 값을 바꿀 때는 새 값을 목록에 더해 새 페이지를 게시하고, 동료들이 사본을 다시 만든 뒤 옛 값을 뺀다.
- 사용 기록에 `@page:<버전>` 카운터를 더한다(v1 = 옛 페이지). `relay_usage {group_by: "user_page"}`로 본다.
- 화면 안내 문구는 `ui_v2.msgs`로 서버에서 고친다(2026-10-30). 글 항목은 키마다 문구 하나(`{min}`·`{n}` 같은 자리표시는 페이지가 값으로 바꾼다), 표 항목은 `names`(`fmt`·`fmt_short` = 파일 형식 이름, `tier` = 답변 등급 이름), `sample_copy`·`dl_copy`(오류 안내, 오류 코드 → 문구). 비우거나 빼면 페이지 기본 문구를 쓴다. 이 문구 방식이 들어간 페이지(이 변경 이후 사본)에서만 반영된다.
- 화면 모양 규칙은 `ui_v2.css`로 서버에서 고친다(2026-11-03, 페이지 8판부터). CSS 글 또는 줄 배열(60,000자 이내)로 적고, 페이지는 받은 규칙을 기본 모양 위에 덧씌운다(글자·여백 크기, 색, 숨기기, 배치 순서, `@media (max-width: 760px)` 같은 휴대폰 폭 규칙). 코드는 실행되지 않는다. 바깥 자원을 부르는 구문(`url(`·`image-set(`·`image(`·`src(`·`@import`·`@font-face`)·`expression(`·`javascript:`과 역슬래시(그런 구문을 숨기는 이스케이프 — 특수문자는 이스케이프 없이 그 글자를 직접 쓴다)가 있으면 페이지가 통째로 적용하지 않고 `scripts/check-catalog.js`도 실패한다. 적용 여부는 페이지 '연결 상태 확인'의 "화면 모양 규칙 적용 N자 / 없음 / 적용 안 함" 줄로 본다. 새 동작(누르면 이동하는 단추 같은 기능)은 이 방식으로 만들 수 없다 — 페이지 코드를 고친다.
- 단추는 `ui_v2.buttons`로 서버에서 고친다(2026-11-04, 페이지 9판부터). 항목마다 `id`가 있고,
  - 기본 단추(`hist_top` 상단 이전 대화, `notice` 공지, `jobs` 작업함, `setup` 사용 준비 — 상단 바 / `back` 목록, `agent_hist` 이전 대화, `agent_info` 에이전트 안내, `new_chat` 새 대화 — 에이전트 머리줄)는 `label`(24자 이내)·`hidden`(true면 숨김)·`before`|`after`(같은 자리의 다른 단추 id 앞·뒤로 옮김)만 바꾼다.
  - 새 단추는 `slot`(`top` 상단 바, `pane` 에이전트 머리줄, `home` 첫 화면 공지 아래), `label`, `action`(페이지에 들어 있는 동작 중 하나: `history_all` 전체 이전 대화, `history` 지금 화면의 이전 대화, `notices` 공지, `jobs` 작업함, `setup` 사용 준비, `home` 첫 화면, `agent` 에이전트 열기(`agent` id, 선택 `q`는 입력창에 넣기만 하고 보내지 않음), `new_chat`, `agent_info`, `group` 첫 화면의 묶음으로 이동(`group` id), `link` 새 창으로 https 주소 열기(`url`))를 적는다. 선택 `title`(마우스 올리면 보이는 설명), `agents`(pane 단추를 그 에이전트 화면에서만 보이기), `before`|`after`.
  - 서버는 값만 보낸다. 목록에 없는 동작은 페이지가 무시하고 `check-catalog`도 실패한다. 새 '동작'이 필요하면 페이지 코드(`BTN_ACTIONS`)에 더하고 이 목록과 검사도 함께 고친다. 적용 결과는 '연결 상태 확인'의 "서버 단추 적용 N개(무시 M개)" 줄로 본다.
- **통합 질문(통합 에이전트, 2026-11-07, 페이지 16판부터).** 에이전트에 `"hub": true`(+ `"consultable": false` — 다른 에이전트가 되묻지 않게)를 두면 그 에이전트는 직접 조회하지 않고 질문을 분야별로 나눠 다른 에이전트들에 맡기고 종합한다. 16판 페이지는 그 에이전트에 페이지 도구 `assign_agents`(items [{agent, task, question}] — 한꺼번에 맡기고 동시에 진행, 답은 `wait_agent`로 받음)를 주고, 답변 칸 위에 **작업 배정 칸**(맡긴 에이전트·맡긴 내용·대기/검토 중/완료/실패)을 보인다. 클라우드 실행은 실행기가 `jp_` 문서에 `plan`([{n 이름, t 맡긴 내용, s wait·run·ok·fail, m 짧은 결과}])을 쓰고(`prompts_v2.runner.main` 5절의 [작업 배정 칸] 줄), 페이지가 그대로 그린다. 배정 칸은 대화 저장에도 남는다(`g`). `features.hub_panel`(배정 칸·assign_agents 켜기, 기본 true)·`hub_parallel`(동시에 진행하는 묻기 수 1~8, 기본 3)·`hub_max`(한 번에 맡기는 수 1~10, 기본 6), 문구 `ui_v2.msgs`의 `plan_title`·`plan_count`(`{done}`·`{total}`)·`plan_wait`·`plan_run`·`plan_ok`·`plan_fail`, 도구 설명 `prompts_v2.tool_docs.assign_agents`(`{{n}}`). 15판 이하 사본에서도 통합 에이전트는 보이고 `ask_agent`로 묻지만 배정 칸은 없다.
- 답변 중 다음 질문 예약·답변 중 새 대화(2026-11-04, 페이지 10판부터)는 `features`로 켜고 끈다: `queue`(답변 중 입력창에 쓴 질문을 '예약'해 두었다가 답변이 끝나면 같은 대화에 이어 보냄, 기본 true), `queue_max`(대화당 예약 개수 1~10, 기본 3), `bg_detach`(클라우드 실행 중 '새 대화'·다른 이전 대화 열기를 허용 — 진행 중인 답변은 클라우드에서 계속되고 끝나면 원래 대화에 저장됨, 기본 true. 화면 안 실행은 떼어 낼 수 없어 해당 없음). 사용자가 중지했거나 답변이 실패하면 예약은 멈추고 '지금 보내기'를 기다린다. 그 에이전트 화면이 아닐 때 끝나면 그 에이전트를 열 때 보낸다(모델 선택이 화면 기준이라). 문구는 `ui_v2.msgs`의 `queue_btn`·`queue_btn_title`·`stop_btn_title`·`queue_note`·`queue_paused`·`queue_send_now`·`queue_cancel`·`queue_full`(`{n}`)·`queue_wait`(`{agent}`)·`detach_note`·`detach_queue_dropped`(`{n}`)·`detach_title`·`detach_local`로 바꾼다.
- 파일·폴더 추가(2026-11-04, 페이지 12판부터): 첨부는 페이지가 브라우저 안에서만 읽고 어디에도 저장하지 않는다. 폴더 단추를 누르면 브라우저의 고정 확인창("이 사이트에 파일을 업로드하시겠습니까?" — 페이지가 바꿀 수 없음) 전에 페이지 안내창을 먼저 띄운다. `features.att_guide`(안내창 켜기, 기본 true), `att_max_files`(1~1000, 기본 300)·`att_max_mb`(1~200, 기본 80). 문구는 `ui_v2.msgs`의 `att_guide_title`·`att_guide_lead`·`att_guide_body`(줄바꿈으로 항목 구분, `{files}`·`{mb}`)·`att_guide_browser`·`att_guide_skip`·`att_guide_cancel`·`att_guide_go`·`att_note`(입력창 아래 한 줄)·`att_file_btn`·`att_dir_btn`(단추 이름)·`hist_att_note`(이전 대화 안내)·`hist_att_reattach`(첨부가 있던 대화를 열 때)·`att_drop_reading`·`att_drop_fail`. 안내 문구 키 중 `att_note`·`att_guide_browser`·`hist_att_reattach`는 빈 글("")로 두면 그 안내를 끈다. 11판 이하 사본에는 같은 내용을 공지 `att-local-1`(첨부 가능한 에이전트 화면)로 알린다 — 사본 재생성이 끝나면 내려도 된다.
- 첨부 이어 쓰기 확인·대화 삭제(2026-11-04, 페이지 13판부터): 첨부 파일은 대화가 아니라 에이전트 화면에 붙어 있어 페이지를 닫기 전까지 새 대화·다른 이전 대화에서도 함께 쓰인다. 그래서 대화를 바꿀 때(새 대화·다른 이전 대화 열기) 첨부가 남아 있으면 [계속 쓰기]·[빼고 진행]·[취소]를 묻는다 — `features.att_carry_ask`(기본 true), 문구 `ui_v2.msgs`의 `att_carry_title`·`att_carry_body`(`{n}`·`{target}`)·`att_carry_new`·`att_carry_open`·`att_carry_keep`·`att_carry_drop`·`att_carry_cancel`. 지금 열려 있는 대화도 목록에서 지울 수 있고(지우면 그 화면은 새 대화, 답변 중에는 막음 — `hist_del_cur_title`), 상단 '이전 대화' 전체 목록에서도 이름 바꾸기·삭제를 한다.
- **페이지에 남아 있던 문구·숫자를 서버로 옮김(2026-11-04, 페이지 14판부터).** 페이지에는 동작 코드와 기본값만 남기고, 아래는 서버 값이 있으면 그 값을 쓴다. 서버 값은 13판 페이지 문구를 그대로 옮겨 두었으므로(설정 2026-11-04.15) 옮긴 직후 모델에 가는 지침·도구 설명은 13판과 글자 단위로 같다(26개 에이전트 × 화면/클라우드/다른 에이전트 질문/첨부/앞선 답변/파일 저장 유무 729가지 비교 일치). 옛 페이지 사본은 새 키를 읽지 않으므로 영향이 없다.
  - `prompts_v2.base` — 모든 에이전트 공통 지침(`system`: [공통 원칙]부터 [문서 파일 요청]까지 지침 전체의 순서·문구), 도구 설명 머리말(`tool_head`·`tool_head_bg`·`tool_group`), 첨부 현황(`attach`·`attach_none`·`attach_more`·`notes_head`), 문서 요청 규칙(`doc`·`doc_off`), 이어하기(`cont`), 확인 문구(`ack`), 다른 에이전트 질문 머리(`consult_q`·`consult_target`), 이전 대화 줄임 안내(`hist_clip`·`hist_skip`·`hist_clip_fg`·`hist_skip_fg`), 지침 미수신 문구(`no_rules`). 키마다 글 또는 줄 배열. 줄 앞 `[조건]`은 조건을 모두 만족할 때만 그 줄을 넣는다(`[!조건]`은 아닐 때): `bg` 클라우드 실행, `by` 다른 에이전트의 질문에 답하는 중, `consult` 물을 수 있는 에이전트 있음, `find` 도구 찾기, `past` 이전 대화 찾기, `prev` 앞선 답변 있음, `dl` 파일 저장 가능, `att` 첨부 현황 있음, `folder` 폴더 첨부 가능, `notes` 첨부 요약 노트 있음, `draft` 초안 쌓기. `{{이름}}`은 페이지가 채운다(`system`: `name`·`now`·`others`·`by_name`·`max`·`targets`·`tool_docs`·`agent_rules`·`report`·`figure`·`attach`·`runner_consult`·`runner_doc`·`doc`). `system`에는 `{{tool_docs}}`와 `{{agent_rules}}`가 있어야 한다. 키가 없거나 형식이 틀리면 페이지 기본값을 쓴다.
  - 다른 에이전트의 질문에 답할 때는 [답변 구성](`prompts_v2.report`)이 빠지므로(보고서 골격 때문), 그중 웹 검색·부재 판정·최신 상황·원문·첨부·집계 검산 줄을 `prompts_v2.base.system`에 `[by]` 사본으로 둔다(설정 2026-11-04.16, 14판부터 — 13판 이하 사본은 이 경우 해당 줄 없음). 사본을 둔 report 줄 번호는 `prompts_v2.by_shared`이고, report를 고치면 사본도 같이 고쳐야 `check-catalog`를 통과한다.
  - `prompts_v2.tool_docs` — 페이지 자체 도구(more_result·read_answer·make_report·create_document·첨부 3종·초안 2종·묶음 도구 `_group`·`query`·find_tools·use_tool·ask_agent·wait_agent·past_chats)의 설명. 인자 설명은 `도구.인자`(예: `past_chats.query`). 값 자리: `_group`의 `{{key}}`·`{{n}}`·`{{kb}}`, `ask_agent`의 `{{max}}`, `past_chats`의 `{{days}}`, `create_document`의 `{{draft_note}}`(초안 쓰는 에이전트에만 `create_document._draft` 문구가 들어감).
  - `ui_v2.text` — 화면 문구 바꾸기 `{"원래 문구": "새 문구"}`. 화면 글자 칸과 `title`·`placeholder`·`aria-label` 값이 원래 문구와(앞뒤 공백 빼고) 정확히 같을 때만 바꾼다. 답변 본문·사용자 메시지·코드·입력 내용은 바꾸지 않는다. 글자로만 넣으므로(마크업 해석 없음) 코드가 실행되지 않는다. 새 문구가 다시 다른 원래 문구이면 되풀이를 막으려고 적용하지 않는다. 문구를 키(`ui_v2.msgs`)로 바꾸는 쪽이 있으면 그쪽을 먼저 쓰고, 키가 없는 고정 문구에 이 표를 쓴다.
  - 숫자(`features`, 범위를 벗어나면 기본값): `hist_days` 이전 대화 보관 일수(7~365, 기본 90 — 줄이면 그보다 오래된 대화가 지워진다), `hist_list` 목록에 읽어 오는 대화 수(20~300, 100), `hist_board_show` 이전 대화 목록에서 처음 펼쳐 보이는 수(1~30, 5), `past_scan`·`past_read` 이전 대화 찾기 도구가 훑는 대화 수(5~100, 40)·한 번에 읽는 글자 수(2000~60000, 20000), `convo_in_max` 대화 종합 보고서가 읽는 답변 전문 상한(20000~400000자, 120000), `ctx_turns`·`ctx_last_max`·`ctx_prev_max` 모델에 싣는 이전 대화 메시지 수(2~40, 12)·마지막 답변 글자 수(2000~60000, 20000)·그 앞 답변 글자 수(500~20000, 4000).
  - 페이지 14판은 Word·PowerPoint·PDF·Excel·한글 파일을 이 서버(`build_file`)로만 만든다. 페이지 안의 대체 변환 코드(약 130KB)와 한글 양식(73KB)을 걷어 냈으므로 서버가 실패하면 "파일을 만들지 못했습니다…"(`ui_v2.msgs.file_server_fail`) 안내만 나온다. 13판 이하 사본은 대체 경로가 그대로 있다. 페이지에 내장한 설정 사본은 첫 화면용 간이본(에이전트 소개·화면 설정, 지침·도구·문구 제외)이고, 질문을 보내기 전에는 항상 서버 설정을 받는다.
- **이전 대화 목록 접기(2026-11-05, 페이지 15판부터).** 상단 '이전 대화' 전체 목록과 에이전트 화면 '이전 대화'의 '다른 에이전트 대화'에서 에이전트별 묶음마다 [접기]/[펼치기](머리줄을 눌러도 됨), 목록 위에 [전체 접기]/[전체 펼치기]. 접은 상태는 사람·기기별로 브라우저에 기억(`histFoldV1`, 두 목록 따로). `features.hist_fold`(기본 true — false면 단추 없이 모두 펼침), `features.hist_fold_default`(처음 상태, 기본 false=펼침), 문구 `ui_v2.msgs`의 `hist_fold`·`hist_unfold`·`hist_fold_all`·`hist_unfold_all`, 모양은 `ui_v2.css`(`.hist-fold`·`.hist-foldall`·`.hist-ag-row`·`.hist-grp`).

## 웹 도구 (2026-10-22)

`lib/web.js`의 `web_search`·`fetch_page`는 다른 서버로 넘기지 않고 이 서버가 직접 수행한다(`lib/backends.js`의 `web` 항목, `local: true`).

- `fetch_page`: 직접 접속(무료) → 본문이 거의 없거나 접속이 막히면 Nimble extract(브라우저 렌더, 국내 IP, 월 상한) → 그래도 안 되면 Tavily extract(basic, 월 무료 크레딧). PDF는 Nimble을 건너뛰고 Tavily로.
- `web_search`: Tavily search(basic, 1크레딧) → 실패·한도 소진이면 Nimble search(lite).
- robots.txt가 막은 주소는 어느 경로로도 읽지 않는다. 사설망·루프백·메타데이터 주소는 DNS 해석 결과까지 확인해 막고, 리다이렉트마다 다시 확인한다.
- 한도(Redis 카운터, 키 `w:<날짜>:<사용자>:<종류>`·`w:nimble:<월>`): 사람별 하루 `WEB_SEARCH_DAILY`(기본 60)·`WEB_FETCH_DAILY`(기본 400)·`WEB_PAID_FETCH_DAILY`(대체 경로, 기본 40), 서버 전체 월 `NIMBLE_MONTHLY_MAX`(기본 5000). 실패한 호출은 한도에서 되돌린다.
- 이 도구들도 커넥터를 등록한 사람의 일반 채팅에서 쓰인다(같은 한도가 적용된다).

## 파일 변환기 — 원본은 계정 스킬

`build_file`(Word·PowerPoint·PDF·한글 HWPX 문서, Excel 가치평가 모델·표 → 시트)이 쓰는 변환기의 **원본은 계정 스킬 `sys-file-builder`**이고,
`lib/filebuilder/`는 그 사본이다. 이 서버는 사용자에게 계정의 기능을 공유하는 통로이므로 기능을 이 저장소에서 먼저
만들거나 사본을 직접 고치지 않는다. 원본 스킬을 고친 뒤 `node scripts/sync-filebuilder.js <스킬 폴더>`로 다시 복사하고,
`SOURCE.json`(버전·해시)이 함께 바뀐다. `scripts/check-catalog.js`는 사본이 기록과 다르면 실패한다.

서버가 만들 형식은 설정 `features.server_files`가 정한다(2026-10-26부터 다섯 형식 전부). 페이지는 그림 블록을 PNG로 그려
`figures`로 보내고(서버에는 그림 엔진이 없다), Word 표지·목차 판단값(`meta.estimate`)을 함께 보낸다. 도식은 서버가 배치를
다시 계산해 Word·PowerPoint에서 고칠 수 있는 도형으로 넣는다. PDF는 본고딕(Noto Sans KR) 글꼴을 함께 싣는다(`vercel.json`의
`includeFiles`). 서버 호출이 실패하면 13판 이하 페이지는 자기 변환 코드로 만들고(대체 경로 — 대외비 줄·핵심 메시지 상자·소제목 번호는
서버 경로에만 있다), 14판부터는 대체 경로 없이 실패 안내를 띄운다.

**MD(마크다운)도 서버가 만든다**(설정 2026-11-04.4, 페이지 11판부터 — 그 전 사본은 원고 그대로 저장). 원고는 그대로 두고
```` ```chart ```` 블록은 `[그림 N] 제목` + 자료 표, ```` ```diagram ```` 블록은 관계 글로 바꾼다(`DocExport.toMarkdown`). 그림을 MD에
넣지 않는 것은 사용자 결정이다(마크다운 뷰어는 그림 블록을 그리지 못하고, 그림을 글자로 넣으면 그래프당 약 90KB씩 커짐).

## 대화 종합 보고서 설정 — `prompts_v2.convo`(페이지 11판부터)

| 키 | 형식 | 뜻 |
|---|---|---|
| `plan` | 문장 배열 | 목차 설계 규칙(`[설계 규칙]`). JSON 출력 형식 줄은 페이지에 고정 |
| `section` | 문장 배열 | 절 작성 규칙(`[작성 규칙]`). `{{h}}` = 지금 쓸 절 제목(빠지면 `check-catalog` 실패) |
| `sources` | `auto`·`list`·`line`·`none` | 절마다 쓴 `출처:` 줄을 끝에 어떻게 붙일지. `auto`(기본): 목차에 '출처' 절이 있으면 붙이지 않고, 없으면 `## 출처` 절에 한 건씩(띄어쓰기·괄호·조회일 꼬리가 달라도 같은 출처는 한 번). `line`은 옛 방식 한 줄 |

'출처' 절 안에 쓴 `출처:` 줄은 그 절의 본문으로 남는다. 키가 없거나 형식이 틀리면 페이지 기본값을 쓴다.

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

사용자 한글 이름(2026-11-02): `relay_usage`의 사용자 열(식별자) 옆에 `사용자명` 열이 붙는다. 이름은 코드 저장소가 공개라서 코드가 아니라 사용 기록 저장소의 `user:names` 해시에 두며(자동 삭제 없음), 관리자 전용 도구 `relay_users`(action: list·set·delete, label, name)로 등록·변경·삭제한다. **새 게이트키를 발급할 때 이름도 함께 `set`한다**(등록하지 않으면 `사용자명`이 비어 화면에는 식별자가 그대로 나온다). 이름은 `agents.json`에 넣지 않는다 — 설정 전체가 페이지로 내려가기 때문이다.

실패 상세(2026-11-02): 실패한 호출은 집계와 별도로 한 건씩 `f:<날짜>` 리스트에 남긴다(시각·사용자·에이전트·도구·소요·오류 문구 300자·인자 요약 300자, 하루 최대 500건, 보존기간은 사용 기록과 같음). Vercel 로그는 1시간만 남아서 몇 시간 뒤에는 원인을 볼 수 없었기 때문이다. 관리자가 `relay_usage`에 `group_by: "failures"`(필요하면 `user`로 사용자 지정)를 주면 표로 나온다. 서버 로그에도 `[fail]` 줄로 같은 내용을 찍는다. 성공한 호출의 인자는 남기지 않는다.

실패 원인 관리(2026-11-02): 실패는 담당 서버·도구·오류 문구(4자리 이상 숫자는 #로 바꿈, HTTP 상태코드는 남김)가 같으면 한 원인으로 묶여 `iss:<서명>` 해시에 쌓인다. 상태는 확인 필요·개선완료·조치불필요이며(대시보드에서는 '개선 필요 오류'·'개선 이력'으로 표시), 닫은 뒤 같은 원인으로 또 실패하면 '재발'로 다시 열린다. 조회는 `relay_usage` `group_by: "issues"`(`status`: open 기본·closed·all), 상태 변경은 관리자 전용 `relay_failures`(sig, status: resolved·ignored·open, note, link). 열린 원인은 지워지지 않고, 닫힌 원인은 닫은 뒤 보존기간(90일) 동안 재발이 없으면 자동 삭제된다. 대시보드의 호출·실패 숫자는 이 상태와 무관하게 실제 발생 건수 그대로다.

페이지 열기 기록(2026-11-06): 도구 호출만 세면 사본을 만들어 열어만 보고 질문하지 않은 사람은 기록에 없다. 그래서 `relay_config`(part 없음·`catalog` — 페이지를 열 때와 질문 전에 설정을 받는 호출)를 받을 때마다 `o:<날짜>` 해시의 `<사용자>|<페이지 버전>`을 1 올린다(`page` 없는 옛 페이지는 `v1`, 지침·도구 목록 조각 요청은 세지 않음, 보존기간은 사용 기록과 같음). `relay_usage {group_by: "opens"}`가 사용자×페이지 버전별로 처음·마지막 연 날, 연 날수, 설정 받기 횟수를 보여 주고, 이름표(`user:names`)에 있는데 기간 중 기록이 없는 사람은 '기록 없음' 행으로 붙인다. 도구 호출 집계(`user`·`user_page` 등)에는 섞지 않는다.

에이전트별 사용량(2026-10-30): 페이지(7판 이후 새로 만든 사본)가 `relay_call`에 `agent`(에이전트 id)를 함께 보내면 `@agent:<id>`(호출·실패·소요)와 `@at:<id>|<도구>`를 더 쌓는다. 에이전트 간 통신은 묻는 쪽이 아니라 받는 쪽 에이전트로 센다. `relay_usage`의 `group_by`에 `agent`·`user_agent`·`day_agent`·`agent_tool`이 있고, id를 보내지 않은 호출은 `(미구분)`으로 나온다. 질문 내용은 저장하지 않는다.

Vercel 함수 로그의 `[call] caller=… tool=…` 줄은 무료 요금제에서 1시간만 보관되므로 즉시 확인용으로만 쓴다.

## 배포

main 브랜치에 push하면 Vercel이 운영 배포를 자동으로 만든다(2026-10-16 Git 연결).
