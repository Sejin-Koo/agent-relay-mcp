# agent-relay-mcp

업무 에이전트용 중계 MCP 서버. 여러 자체 MCP 서버의 **허용된 도구만** 주소 하나로 제공한다.

- 엔드포인트: `/api/mcp?k=<게이트키>`
- 서버·도구 목록: `lib/backends.js` — 서버를 추가하거나 도구를 열고 닫으려면 이 파일만 고친 뒤 push한다.
- 목록 밖 도구는 `tools/list`에 나오지 않고 `tools/call`도 거부된다.

## 환경변수

| 이름 | 용도 |
|---|---|
| `MCP_GATE_KEYS` | 이 서버에 접속할 수 있는 키 목록(쉼표 구분, 사람별 키) |
| `MCP_GATE_MODE` | `enforce`면 키 없는 요청을 401로 차단 |
| `BACKEND_KEY` | 중계 서버가 각 백엔드 서버를 부를 때 쓰는 접근 키 |

백엔드마다 다른 키가 필요하면 `lib/backends.js`의 항목에 `keyEnv: "환경변수명"`을 지정한다.

## 로그

함수 로그에 `[call] caller=<키 식별자> tool=<도구> backend=<서버> ms=<소요> ok=<성공>`이 남으므로 사람별 사용량을 볼 수 있다.

## 배포

main 브랜치에 push하면 Vercel이 운영 배포를 자동으로 만든다(2026-10-16 Git 연결).
