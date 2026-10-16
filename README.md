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
- 화면·문서 서식·첨부 처리 같은 페이지 코드, 그리고 페이지에 없는 새 기능(새 첨부 요약 방식 등)은 페이지를 다시 게시하고 사본을 다시 받아야 한다.

## 환경변수

| 이름 | 용도 |
|---|---|
| `MCP_GATE_KEYS` | 이 서버에 접속할 수 있는 키 목록(쉼표 구분, 사람별 키) |
| `MCP_GATE_MODE` | `enforce`면 키 없는 요청을 401로 차단 |
| `BACKEND_KEY` | 중계 서버가 각 백엔드 서버를 부를 때 쓰는 접근 키 |
| `KV_REST_API_URL`·`KV_REST_API_TOKEN` | 사용 기록 저장소(Upstash Redis, Vercel 마켓플레이스 연결 시 자동 등록) |
| `USAGE_RETENTION_DAYS` | 사용 기록 보관 일수(기본 90) |
| `RELAY_ADMIN_LABELS` | 사용현황 도구를 볼 수 있는 키 식별자(쉼표 구분, 기본 `koo`) |

백엔드마다 다른 키가 필요하면 `lib/backends.js`의 항목에 `keyEnv: "환경변수명"`을 지정한다.

## 사용 기록

도구 호출마다 날짜(한국시간)·사용자(키 식별자)·도구별 호출 수, 실패 수, 소요시간 합계를 Upstash Redis에 더한다
(`lib/usage.js`). 질문 내용·조회 결과는 저장하지 않으며, 기록은 `USAGE_RETENTION_DAYS`일 뒤 자동 삭제된다.

조회는 관리자 전용 도구 `relay_usage`(from·to·group_by)로 한다. 관리자 키가 아니면 `tools/list`에 보이지 않고 호출도 거부된다.

Vercel 함수 로그의 `[call] caller=… tool=…` 줄은 무료 요금제에서 1시간만 보관되므로 즉시 확인용으로만 쓴다.

## 배포

main 브랜치에 push하면 Vercel이 운영 배포를 자동으로 만든다(2026-10-16 Git 연결).
