// 업무 에이전트 중계 MCP 서버.
// 여러 자체 MCP 서버를 주소 하나로 묶는다. 요청을 받아 도구 이름으로 담당 서버를 찾고 그대로 넘긴다.
// SDK 없이 JSON-RPC를 직접 구현했으므로 규격상 필요한 세 가지를 직접 처리한다:
//   ① initialize 버전 협상(지원 목록과 대조) ② 미지원 MCP-Protocol-Version 헤더에 400 ③ 알림에 202

const { BACKENDS, ROUTE, UPSTREAM } = require("../lib/backends");
const usage = require("../lib/usage");
const files = require("../lib/files");
const LOCAL = { files }; // 이 서버가 직접 수행하는 도구 묶음(backends.js의 local 항목 module 이름) — 페이지 전용 파일 만들기만 남긴다
const localOf = (b) => LOCAL[b.module];
const { coerceArgs, missingRequired } = require("../lib/coerce");
const CATALOG = require("../lib/agents.json");

const SERVER_INFO = { name: "agent-relay-mcp", version: "1.0.0" };
// @modelcontextprotocol/sdk 1.32.1 의 SUPPORTED_PROTOCOL_VERSIONS 와 같은 값으로 맞춘다
const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const LATEST = SUPPORTED[0];

const GATE_KEYS = (process.env.MCP_GATE_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
const GATE_MODE = (process.env.MCP_GATE_MODE || "observe").trim().toLowerCase();
// 자동 점검 전용 키(비공개 점검 저장소의 GitHub Actions가 매일 도구를 시험 호출). MCP_GATE_KEYS와 따로 둬서
// 기존 목록을 건드리지 않고 넣고 뺄 수 있게 했다. 이 키의 호출은 사용량 합계에 넣지 않고, 실패만 '개선 필요 오류'에 남긴다.
const MONITOR_KEYS = (process.env.RELAY_MONITOR_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
const isMonitor = (caller) => MONITOR_KEYS.some(k => keyLabel(k) === caller);

const LIST_TTL_MS = 10 * 60 * 1000;   // 백엔드 도구 정의 캐시
const CALL_TIMEOUT_MS = 280 * 1000;   // vercel.json maxDuration(300초)보다 짧게
const LIST_TIMEOUT_MS = 20 * 1000;

// 사용현황 도구(relay_usage)를 볼 수 있는 키 식별자. 키 형식 plk_<식별자>_… 의 식별자 부분이다.
const ADMIN_LABELS = (process.env.RELAY_ADMIN_LABELS || "koo").split(",").map(s => s.trim()).filter(Boolean);
const isAdmin = (caller) => ADMIN_LABELS.includes(caller);

function keyLabel(k) {
  if (!k) return "(none)";
  const m = String(k).match(/^plk_([A-Za-z0-9]+)_/);
  return m ? m[1] : `${String(k).slice(0, 8)}…`;
}

function backendKey(b) {
  if (b.noKey) return "";
  // strictKey: 그 서버 전용 키(keyEnv)만 쓴다. 없을 때 BACKEND_KEY로 대신 접속하면 범위 제한이 풀릴 수 있어 빈 값으로 둔다
  if (b.strictKey) return (b.keyEnv && process.env[b.keyEnv]) || "";
  return (b.keyEnv && process.env[b.keyEnv]) || process.env.BACKEND_KEY || "";
}

// envHeaders: { 헤더이름: 환경변수이름 } — 그 환경변수가 있을 때만 헤더로 보낸다(값은 코드·저장소에 두지 않는다)
function envHeaders(b) {
  const out = {};
  for (const [h, env] of Object.entries(b.envHeaders || {})) {
    const v = process.env[env];
    if (v && String(v).trim()) out[h] = String(v).trim();
  }
  return out;
}

function backendUrl(b) {
  const k = backendKey(b);
  return k ? `${b.url}${b.url.includes("?") ? "&" : "?"}k=${encodeURIComponent(k)}` : b.url;
}

// 백엔드 응답은 JSON 또는 SSE(text/event-stream)로 온다. 요청 id에 맞는 JSON-RPC 메시지를 꺼낸다.
function parseRpc(text, contentType, id) {
  const tryJson = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  if (/event-stream/i.test(contentType || "")) {
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const msg = tryJson(line.slice(5).trim());
      if (!msg) continue;
      if (msg.id === id && (msg.result !== undefined || msg.error !== undefined)) return msg;
      if (msg.result !== undefined || msg.error !== undefined) last = msg;
    }
    return last;
  }
  const j = tryJson(text);
  if (Array.isArray(j)) return j.find(m => m && m.id === id) || j[0] || null;
  return j;
}

async function rpcToBackend(b, method, params, timeoutMs, caller) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const id = Date.now() % 1e9;
  try {
    const r = await fetch(backendUrl(b), {
      method: "POST",
      // sendCaller 서버(web-reader-mcp)는 사람별 한도를 이 헤더의 사용자 식별자로 센다
      headers: Object.assign({ "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
        b.sendCaller && caller ? { "X-Relay-Caller": String(caller) } : {}, envHeaders(b)),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }),
      signal: ctl.signal
    });
    const text = await r.text();
    if (!r.ok) {
      const err = new Error(`${b.label} 서버 응답 HTTP ${r.status}`);
      err.httpStatus = r.status; err.body = text.slice(0, 300);
      throw err;
    }
    const msg = parseRpc(text, r.headers.get("content-type"), id);
    // 응답이 비었거나 SSE가 결과 없이 끝난 경우 — 대부분 뒤 서버의 함수 실행 한도 초과로 강제 종료된 것이다
    // (2026-11-04 건설 서버 60초 한도 실측). 같은 인자로 되풀이하지 않도록 대처를 함께 알린다.
    if (!msg) throw new Error(`${b.label} 서버 응답이 결과 없이 끊겼습니다(그 서버의 처리 시간 한도를 넘겼을 수 있음) — 같은 인자로 되풀이하지 말고 조회 범위(기간·페이지·건수)를 줄여 다시 부르세요`);
    return msg;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`${b.label} 서버가 ${Math.round(timeoutMs / 1000)}초 안에 응답하지 않았습니다`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 시간 초과 시 나눠 다시 부르기(splitRetry) ----------
// 외부 서버처럼 함수 실행 한도(60초)가 짧은 곳은 종목이 많거나 평가기준일 캐시가 없으면 504로 끊긴다(2026-11-05 실측).
// 그 오류일 때만 종목을 3개씩(3개 이하면 1개씩) 나눠 동시에 다시 부르고, 1종목이면 한 번 더 부른다. 결과는 종목 행 배열로 합치고,
// 끝내 못 받은 종목은 {code, error} 행으로 넣어 에이전트가 무엇이 빠졌는지 알게 한다. 뒤 서버 호출은 SPLIT_MAX_CALLS까지,
// 새 호출은 처음부터 SPLIT_DEADLINE_MS 안에서만 시작한다(함수 한도 300초 안에 끝내기 위함 — 끊김 한 번이 약 60초).
const SPLIT_MAX_CALLS = 16;
const SPLIT_DEADLINE_MS = 170 * 1000;
const jsonOr = (t) => { try { return JSON.parse(t); } catch (e) { return null; } };
function isCutOff(e) {
  return !!e && (e.httpStatus === 504 || e.httpStatus === 502 || /결과 없이 끊겼/.test(String(e.message || "")));
}
function rowsOfResult(result) {
  const text = ((result && result.content) || []).filter(c => c && c.type === "text" && c.text).map(c => c.text).join("\n");
  const j = jsonOr(text);
  if (Array.isArray(j)) return j;
  if (j && typeof j === "object") return [j];
  return null;
}
async function callSplitRetry(b, upName, args, caller, budget) {
  const sr = b.splitRetry;
  let codes = args[sr.arg] !== undefined ? args[sr.arg] : args.stock_code;
  if (typeof codes === "string") { const j = jsonOr(codes); codes = Array.isArray(j) ? j : [codes]; }
  if (!Array.isArray(codes) || !codes.length) return rpcToBackend(b, "tools/call", { name: upName, arguments: args }, CALL_TIMEOUT_MS, caller);
  const one = async (list, retry) => {
    budget.n++;
    const a = Object.assign({}, args); delete a.stock_code; a[sr.arg] = list.length === 1 ? list[0] : list;
    try {
      const msg = await rpcToBackend(b, "tools/call", { name: upName, arguments: a }, CALL_TIMEOUT_MS, caller);
      if (msg.error || (msg.result && msg.result.isError)) return { msg, codes: list };
      const rows = rowsOfResult(msg.result);
      return rows ? { rows, msg, codes: list } : { msg, codes: list };
    } catch (e) {
      if (!isCutOff(e) || budget.n >= SPLIT_MAX_CALLS || Date.now() - budget.t0 > SPLIT_DEADLINE_MS) return { err: e, codes: list };
      if (list.length === 1) {
        if (!retry) return { err: e, codes: list };
        console.log(`[split] tool=${upName} retry code=${list[0]} why=${e.message}`);
        return one(list, false);
      }
      const size = list.length > 3 ? 3 : 1; const chunks = [];
      for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
      console.log(`[split] tool=${upName} n=${list.length} -> ${chunks.map(c => c.length).join("+")} why=${e.message}`);
      const parts = await Promise.all(chunks.map(c => one(c, true)));
      return { parts };
    }
  };
  const flat = (r, out) => { if (r.parts) r.parts.forEach(p => flat(p, out)); else out.push(r); return out; };
  const res = flat(await one(codes, true), []);
  if (res.length === 1 && res[0].msg) return res[0].msg;          // 한 번에 받았거나 1종목 재시도로 받음 — 뒤 서버 답 그대로
  if (res.length === 1 && res[0].err) throw res[0].err;           // 나눌 수 없거나 한도 — 원래 오류 그대로
  const rows = []; const missed = [];
  for (const r of res) {
    if (r.rows) rows.push(...r.rows);
    else if (r.err) { missed.push(...r.codes); r.codes.forEach(c => rows.push({ code: c, error: `${b.label} 서버가 처리 시간 한도 안에 답하지 못해 이 종목을 받지 못했습니다 — 이 종목만 따로 한 번 더 부르거나, 이자부부채는 dart_interest_bearing_debt로 보완하세요` })); }
    else if (r.msg) r.codes.forEach(c => rows.push({ code: c, error: oneLine(errTextOf(r.msg)) }));
  }
  if (!rows.some(x => !x.error)) { const e = (res.find(r => r.err) || {}).err; if (e) throw e; }
  console.log(`[split] tool=${upName} merged rows=${rows.length} missed=${missed.length} calls=${budget.n}`);
  return { result: { content: [{ type: "text", text: JSON.stringify(rows) }] } };
}

// ---------- tools/list: 서버별 도구 정의를 받아 허용 목록만 남긴다 ----------
const listCache = {}; // id -> { at, tools }
async function backendTools(id) {
  const b = BACKENDS[id];
  if (b.local) return localOf(b).TOOLS.filter(t => b.tools.includes(t.name));
  // staticTools: 범위 제한 키처럼 tools/list를 부를 수 없는 서버는 도구 정의를 설정에 둔다
  if (Array.isArray(b.staticTools)) return b.staticTools.filter(t => b.tools.includes(t.name));
  const c = listCache[id];
  if (c && Date.now() - c.at < LIST_TTL_MS) return c.tools;
  try {
    const msg = await rpcToBackend(b, "tools/list", {}, LIST_TIMEOUT_MS);
    if (msg.error) throw new Error(msg.error.message || "tools/list 오류");
    const all = (msg.result && msg.result.tools) || [];
    const allow = new Set(b.tools);
    const picked = all.filter(t => allow.has(t.name));
    const missing = b.tools.filter(n => !picked.some(t => t.name === n));
    if (missing.length) console.log(`[list] ${id} 허용 목록에 있으나 서버에 없는 도구: ${missing.join(",")}`);
    // prefix 가 있는 서버는 공개 이름으로 바꿔 내보낸다(호출 때 UPSTREAM 으로 되돌린다)
    const tools = b.prefix
      ? picked.map(t => Object.assign({}, t, { name: b.prefix + t.name, description: String(t.description || "") + (b.descNote || "") }))
      : picked;
    listCache[id] = { at: Date.now(), tools };
    return tools;
  } catch (e) {
    console.log(`[list] ${id} 실패: ${e.message}`);
    return c ? c.tools : []; // 실패하면 직전 캐시라도 쓴다
  }
}

// 이 서버는 에이전트 페이지 전용이다. 일반 채팅(관리자 포함)에는 조회 도구를 보이지 않고 페이지가 쓰는 두 도구만 내보낸다.
// 관리자 계정은 각 서버를 커넥터로 직접 연결해 쓰므로, 이 서버를 지워도 계정 업무에는 영향이 없어야 한다(사용자 결정 2026-10-24).
async function listTools(caller) {
  const tools = [CONFIG_TOOL, CALL_TOOL];
  if (isAdmin(caller)) tools.push(USAGE_TOOL, USERS_TOOL, FAILURES_TOOL);
  if (isAdmin(caller) || isMonitor(caller)) tools.push(MONITOR_TOOL);
  return tools;
}
// 페이지 확인 값: 원본 페이지 코드에 넣어 둔 값과 같아야 relay_config·relay_call을 받는다(2026-10-24 사용자 결정).
// 환경변수 RELAY_PAGE_KEYS(쉼표 구분 — 바꿀 때 옛 값과 새 값을 함께 두면 옛 사본이 바로 끊기지 않는다)가 비어 있으면 검사하지 않는다.
const PAGE_KEYS = (process.env.RELAY_PAGE_KEYS || "").split(",").map(x => x.trim()).filter(Boolean);
function pageOk(a) {
  if (!a || !a.page) return false;
  if (!PAGE_KEYS.length) return true;
  return typeof a.pk === "string" && PAGE_KEYS.includes(a.pk);
}
// 거절 사유 기록(진단용) — 값 자체는 남기지 않고 없음/형식/길이만 남긴다
function pageRejectWhy(a) {
  if (!a || !a.page) return "no-page";
  if (typeof a.pk !== "string" || !a.pk) return "no-pk";
  return `bad-pk len=${a.pk.length} prefix_ok=${a.pk.startsWith("pgk_")}`;
}
// 옛 페이지(page 인자 없이 부르는 첫 페이지와 그 사본)에는 종료 안내만 담은 설정을 내려보낸다(2026-10-24 사용자 결정).
// 옛 페이지 코드가 받아들이는 형식(agents·groups·servers·ui)에 맞추되, 조회 도구는 하나도 없다.
const RETIRED_MSG = "이 에이전트 페이지는 더 이상 작동하지 않습니다. 에이전트 고도화 작업이 진행 중이니 완료되는 대로 다시 공유해 드리겠습니다. 아티팩트에 있는 이 페이지는 삭제해 주세요. 다만 설정에 등록해 둔 '업무 에이전트 MCP' 커넥터는 지우지 말고 그대로 두세요. 서버 주소가 바뀌지 않아, 새 페이지를 열면 그 커넥터에 그대로 연결됩니다.";
const RETIRED_VERSION = "2026-10-24-retired2";
function retiredCatalog() {
  return {
    version: RETIRED_VERSION,
    ui: { title: "업무 에이전트(종료)", brand: "업무 에이전트", tag: "종료", heading: "이 에이전트 페이지는 더 이상 작동하지 않습니다", intro: "에이전트 고도화 작업이 진행 중이니 완료되는 대로 다시 공유해 드리겠습니다. 아티팩트에 있는 이 페이지는 삭제해 주세요. 다만 설정에 등록해 둔 '업무 에이전트 MCP' 커넥터는 지우지 말고 그대로 두세요. 서버 주소가 바뀌지 않아, 새 페이지를 열면 그 커넥터에 그대로 연결됩니다.", dept: "업무 에이전트" },
    groups: [{ id: "notice", title: "안내", sub: "" }],
    servers: {},
    agents: [{
      id: "retired", name: "이 페이지는 종료되었습니다", short: "종료", group: "notice", desc: "",
      tools: [], examples: [], attach: false, folder: false,
      guide: "**" + RETIRED_MSG + "**",
      rules: "이 페이지는 종료되었다. 어떤 질문에도 내용을 답하지 말고, 다음 문장만 그대로 답한다: " + RETIRED_MSG
    }]
  };
}
const PAGE_ONLY_MSG = "이 서버의 조회 도구는 업무 에이전트 페이지 안에서만 쓸 수 있습니다. 일반 채팅에서는 쓸 수 없으니, 업무 에이전트 페이지에서 해당 에이전트에게 질문해 주세요.";

// ---------- 에이전트 페이지 전용: 설정 내려주기 · 대신 호출 ----------
// 페이지 사본에는 이 두 도구 이름만 적어 두고, 에이전트 목록·도구 배정·규칙(lib/agents.json)과
// 실제로 부를 수 있는 도구(lib/backends.js)는 이 서버가 정한다. 그래서 이 서버만 고치면 사본에도 반영된다.
const CONFIG_TOOL = {
  name: "relay_config",
  description: "업무 에이전트 페이지가 내부적으로 쓰는 설정 도구다. 일반 채팅의 질문에는 절대 호출하지 않는다 — 페이지 밖에서 부르면 거절된다.",
  inputSchema: { type: "object", properties: {
    since_version: { type: "string", description: "페이지가 이미 가진 설정 버전" },
    page: { type: "string", description: "페이지 내부 값(페이지가 채운다)" },
    pk: { type: "string", description: "페이지 내부 값(페이지가 채운다)" },
    part: { type: "string", enum: ["catalog", "tools", "rules", "q"], description: "tools면 도구 찾기용 전체 도구 목록만, rules면 agents에 적은 에이전트의 상세 지침만 돌려준다. q는 페이지가 질문 1건을 알리는 사용 기록용(질문 내용은 보내지 않음)" },
    agents: { type: "array", items: { type: "string" }, description: "part=rules일 때 지침을 받을 에이전트 id 목록" },
    agent: { type: "string", description: "part=q일 때 질문을 받은 에이전트 id(페이지가 채운다)" },
    mode: { type: "string", enum: ["fg", "bg"], description: "part=q일 때 화면 실행(fg)·클라우드 실행(bg)" }
  }, additionalProperties: false },
  annotations: { readOnlyHint: true }
};
const CALL_TOOL = {
  name: "relay_call",
  description: "업무 에이전트 페이지가 내부적으로 쓰는 호출 도구다. 일반 채팅의 질문에는 절대 호출하지 않는다 — 페이지 밖에서 부르면 거절된다.",
  inputSchema: { type: "object", properties: {
    tool: { type: "string", description: "호출할 도구 이름(이 서버 tools/list에 있는 이름)" },
    arguments: { type: "object", description: "그 도구의 인자" },
    page: { type: "string", description: "페이지 내부 값(페이지가 채운다)" },
    pk: { type: "string", description: "페이지 내부 값(페이지가 채운다)" },
    agent: { type: "string", description: "페이지 내부 값(사용 기록용 에이전트 id — 페이지가 채운다)" },
    via: { type: "string", description: "페이지 내부 값(다른 에이전트가 맡겨서 부를 때 맡긴 에이전트 id — 사용 기록용)" }
  }, required: ["tool"], additionalProperties: false }
};
// 공지는 받는 사람과 페이지에 맞는 것만 내려보낸다. audience: "all"(기본) | "v1"(옛 페이지) | "v2"(새 페이지) | 키 식별자 배열
function verGte(a, b) {
  const x = String(a).split("."), y = String(b).split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0);
    if (d) return d > 0;
  }
  return true;
}
function noticesFor(caller, page) {
  return (CATALOG.notices || []).filter(n => {
    // page_min: 그 버전 이상 페이지에만(새 기능 안내를 옛 사본에 띄우지 않으려고)
    if (n && n.page_min && !(page && verGte(page, n.page_min))) return false;
    const au = n && n.audience;
    if (!au || au === "all") return true;
    if (au === "v1") return !page;
    if (au === "v2") return !!page;
    if (Array.isArray(au)) return au.includes(caller);
    return false;
  });
}
// 도구 찾기(8-2)용 전체 도구 목록. 설명과 인자 설명은 길이를 줄여 보낸다
const TOOLCAT_DESC = 400, TOOLCAT_ARG = 70;
// 형식·범위를 설명 끝에 붙인다(페이지의 도구 설명은 description 만 보여 주므로)
function argHint(v) {
  const h = [];
  const ty = Array.isArray(v.type) ? v.type.join("|") : v.type;
  if (ty === "string" && v.pattern) h.push(`문자열, 형식 ${v.pattern}`);
  else if (ty === "string" && !Array.isArray(v.enum)) h.push("문자열");
  if ((ty === "integer" || ty === "number") && (v.minimum !== undefined || v.maximum !== undefined)) {
    h.push(`${ty === "integer" ? "정수" : "숫자"} ${v.minimum !== undefined ? v.minimum : ""}~${v.maximum !== undefined ? v.maximum : ""}`);
  }
  return h.length ? `[${h.join(", ")}]` : "";
}
function slimSchema(sc) {
  if (!sc || typeof sc !== "object") return { type: "object" };
  const out = { type: "object" };
  if (sc.properties && typeof sc.properties === "object") {
    out.properties = {};
    for (const [k, v] of Object.entries(sc.properties)) {
      const p = {};
      if (v && typeof v === "object") {
        if (v.type) p.type = v.type;
        if (Array.isArray(v.enum)) p.enum = v.enum.slice(0, 30);
        if (v.items && v.items.type) p.items = { type: v.items.type };
        if (v.description) p.description = String(v.description).slice(0, TOOLCAT_ARG);
        const hint = argHint(v);
        if (hint) p.description = (p.description ? p.description + " " : "") + hint;
      }
      out.properties[k] = p;
    }
  }
  if (Array.isArray(sc.required)) out.required = sc.required;
  return out;
}
async function toolCatalog() {
  const ids = Object.keys(BACKENDS).filter(id => !BACKENDS[id].hidden);
  const parts = await Promise.all(ids.map(backendTools));
  const tools = [];
  ids.forEach((id, i) => (parts[i] || []).forEach(t => tools.push({
    name: t.name, server: BACKENDS[id].label,
    description: String(t.description || "").replace(/\s+/g, " ").slice(0, TOOLCAT_DESC),
    inputSchema: slimSchema(t.inputSchema)
  })));
  return tools;
}
async function configResult(args, caller) {
  const page = args && args.page ? String(args.page).slice(0, 20) : "";
  if (args && args.part === "tools") {
    const tools = await toolCatalog();
    return {
      content: [{ type: "text", text: `도구 목록 ${tools.length}개 (설정 ${CATALOG.version}). 전체 내용은 structuredContent에 있다.` }],
      structuredContent: { version: CATALOG.version, tools }
    };
  }
  // 페이지 3 이상은 설정에서 에이전트별 상세 지침을 빼고 받은 뒤, 쓰는 에이전트의 지침만 따로 받는다(설정 응답 크기를 줄임)
  if (args && args.part === "rules") {
    const want = new Set((Array.isArray(args.agents) ? args.agents : []).map(String).slice(0, 40));
    const rules = {};
    (CATALOG.agents_v2 || []).forEach(a => { if (want.has(a.id) && typeof a.rules === "string") rules[a.id] = a.rules; });
    return {
      content: [{ type: "text", text: `에이전트 지침 ${Object.keys(rules).length}개 (설정 ${CATALOG.version}). 전체 내용은 structuredContent에 있다.` }],
      structuredContent: { version: CATALOG.version, rules }
    };
  }
  const since = args && args.since_version;
  if (since && since === CATALOG.version) {
    return { content: [{ type: "text", text: `에이전트 설정 ${CATALOG.version} — 변경 없음` }], structuredContent: { version: CATALOG.version, unchanged: true } };
  }
  // 옛 페이지에는 옛 항목만, 새 페이지에는 새 항목과 공통 항목만 보낸다(응답 크기를 줄이고 서로 영향이 없게)
  const V2_KEYS = ["ui_v2", "sections_v2", "groups_v2", "agents_v2", "sources", "features", "notices", "page_min", "tool_labels", "tool_notes", "prompts_v2", "doc_style", "models"];
  const V1_ONLY = ["ui", "groups", "agents", "servers", "prompts"];
  const out = Object.assign({}, CATALOG);
  if (page) V1_ONLY.forEach(k => { delete out[k]; });
  else V2_KEYS.forEach(k => { delete out[k]; });
  if (page) out.notices = noticesFor(caller, page);
  if (page && Number(page) >= 3 && Array.isArray(out.agents_v2)) {
    out.agents_v2 = out.agents_v2.map(a => { const b = Object.assign({}, a); if (typeof b.rules === "string") { b.rules_len = b.rules.length; delete b.rules; } return b; });
    out.rules_lazy = true;
  }
  return {
    content: [{ type: "text", text: `에이전트 설정 ${CATALOG.version} — 에이전트 ${(page && CATALOG.agents_v2 ? CATALOG.agents_v2 : CATALOG.agents).length}개. 전체 내용은 structuredContent에 있다.` }],
    structuredContent: out
  };
}

// ---------- 관리자 전용: 사용자별 사용현황 ----------
const USAGE_TOOL = {
  name: "relay_usage",
  description: "업무 에이전트 중계 서버의 사용자별 사용현황을 조회합니다(관리자 전용). 사용자는 게이트키 식별자(예: kangyunkyung)로 표시되며, 호출 수·실패 수·평균 소요시간을 집계합니다. 질문 내용은 기록되지 않습니다(실패한 호출만 원인 확인용으로 오류 문구와 인자 요약을 남깁니다 — group_by=failures). 기록은 한국시간 날짜 기준이며 " + usage.RETENTION_DAYS + "일이 지나면 자동 삭제됩니다.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "시작일 YYYY-MM-DD (기본: 오늘 포함 최근 30일의 첫날)" },
      to: { type: "string", description: "종료일 YYYY-MM-DD (기본: 오늘)" },
      user: { type: "string", description: "failures에서 이 사용자(게이트키 식별자)의 실패만 보기" },
      status: { type: "string", enum: ["open", "mine", "closed", "all"], description: "issues에서 open: 열린 항목 전체(직접 조치 필요·수정 대기·재발·확인 필요·관찰 중, 기본), mine: 사용자가 할 일만(직접 조치 필요·수정 대기), closed: 개선완료·조치불필요, all: 전체" },
      group_by: { type: "string", enum: ["user", "user_tool", "day", "day_user", "user_page", "agent", "user_agent", "day_agent", "agent_tool", "failures", "issues", "opens", "questions", "agent_questions", "day_questions", "via", "web_paths", "day_web_paths", "web_vendor", "web_vendor_summary", "web_vendor_sources", "web_vendor_daily", "web_vendor_monthly"], description: "집계 단위 — web_vendor_daily: Tavily·Nimble 날짜별 사용(지난달 1일부터 — Nimble은 회사 일별 집계 UTC, Tavily는 매일 저장한 누적값의 전날 대비 차, 저장 시작 전 날짜는 비어 있음), web_vendor_monthly: 월별 합계(최근 3개월 — Tavily는 그 달 마지막 저장값, Nimble은 회사 월 합계, 커넥터 직접·전용 키·본인 키 구분), web_vendor_summary: Tavily·Nimble 서비스별 이번 달(1일~오늘) 사용·무료 제공·사용률·과금 사용·월말 추정, web_vendor_sources: 같은 달의 출처별 내역(계정 채팅 커넥터 직접 호출 / 계정 웹 도구 커넥터 / 업무 에이전트 사용자별 / 본인 키 서버 / 미분류 — 더하면 계정 전체), web_vendor: Tavily·Nimble 회사가 집계한 이번 달 사용량(계정 전체 / 웹 도구 서버 전용 키 / 그 밖 — 계정 채팅에서 Tavily·Nimble 커넥터를 직접 부른 것 등. Tavily는 크레딧, Nimble은 요청 수. from·to는 쓰지 않음), web_paths: 사용자×경로(계정 커넥터/업무 에이전트)별 웹 도구 호출과 Tavily·Nimble 외부 요청 수(웹 도구 서버 기록, 2026-11-07 이후분), day_web_paths: 날짜×경로별 같은 값, questions: 사용자×에이전트 질문 수(화면·클라우드 실행 구분, 페이지 17판 이후분 — 통합 질문과 개별 에이전트 중 어디에 묻는지 보는 용도), agent_questions: 에이전트별 질문 수·질문한 사용자 수, day_questions: 날짜×에이전트 질문 수, via: 맡긴 에이전트(주로 통합 질문)×맡은 에이전트별 조회 호출(맡은 에이전트 집계와 중복), opens: 사용자×페이지 버전별로 페이지를 연 기록(처음·마지막 연 날, 연 날수, 설정 받기 횟수 — 질문하지 않고 열어만 본 사본도 나옴, 2026-11-06 배포 이후분. 이름표에 있는데 기간 중 기록이 없는 사람은 '기록 없음' 행), issues: 실패 원인별 묶음(상태 확인 필요·재발·개선완료·조치불필요, status로 거름), failures: 실패한 호출 한 건씩(시각·사용자·에이전트·도구·소요·오류 문구·인자 요약, 2026-11-02 배포 이후 실패분부터), user: 사용자별(기본), user_tool: 사용자×도구, day: 날짜별, day_user: 날짜×사용자, user_page: 사용자×페이지 버전(v1 = 옛 페이지), agent: 에이전트별, user_agent: 사용자×에이전트, day_agent: 날짜×에이전트, agent_tool: 에이전트×도구(에이전트 구분은 에이전트 id를 함께 보내는 페이지 사본부터 기록되고, 그 전 호출은 (미구분))" }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: true }
};

// 사용자 한글 이름표 관리(관리자 전용). 새 게이트키를 발급할 때 함께 등록하면 사용량 조회 결과에 '사용자명' 열로 붙는다.
const USERS_TOOL = {
  name: "relay_users",
  description: "사용자 표시 이름(게이트키 식별자 → 한글 이름)을 관리합니다(관리자 전용). relay_usage 결과의 '사용자명' 열이 여기서 옵니다. 새 게이트키를 발급할 때 이름도 함께 등록하세요. 이름은 코드 저장소가 아니라 사용 기록 저장소에 두며, 자동 삭제되지 않습니다.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "set", "delete"], description: "list: 등록된 이름 전체, set: 이름 등록·변경, delete: 이름 삭제" },
      label: { type: "string", description: "게이트키 식별자(plk_<식별자>_… 의 식별자, 예: kangyunkyung). set·delete에 필요" },
      name: { type: "string", description: "표시할 한글 이름(1~40자). set에 필요" }
    },
    required: ["action"],
    additionalProperties: false
  }
};

async function usersAdmin(args) {
  const action = args.action;
  if (action === "set") await usage.setName(args.label, args.name);
  else if (action === "delete") await usage.deleteName(args.label);
  else if (action !== "list") throw new Error("action은 list·set·delete 중 하나여야 합니다");
  const names = await usage.readNames();
  const rows = Object.keys(names).sort().map(k => ({ 식별자: k, 이름: names[k] }));
  const text = [`사용자 표시 이름 ${rows.length}건` + (action === "list" ? "" : ` (${action} 완료: ${args.label})`), "", "| 식별자 | 이름 |", "|---|---|", ...rows.map(r => `| ${r.식별자} | ${r.이름} |`)].join("\n");
  return { content: [{ type: "text", text }], structuredContent: { names: rows } };
}

// 실패한 호출 한 건씩. 시각은 한국시간.
async function failureReport(from, to, user) {
  const names = await usage.readNames();
  const list = (await usage.readFailures(from, to)).filter(f => !user || f.caller === user);
  const kst = iso => { const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString(); return `${d.slice(0, 10)} ${d.slice(11, 19)}`; };
  const rows = list.map(f => {
    const ag = ((CATALOG && CATALOG.agents_v2) || []).find(x => x.id === f.agent);
    return { "시각": kst(f.at), "사용자": f.caller, "사용자명": names[f.caller] || "", "에이전트": f.agent || "", "에이전트명": ag ? ag.name : "", "도구": f.tool, "소요(초)": Math.round((f.ms || 0) / 100) / 10, "오류": f.err || "", "인자": f.args || "" };
  });
  const head = ["시각", "사용자명", "에이전트명", "도구", "소요(초)", "오류", "인자"];
  const esc = v => String(v === undefined ? "" : v).replace(/\|/g, "\\|");
  const md = [`중계 서버 실패 호출 ${from} ~ ${to} (한국시간${user ? `, 사용자 ${user}` : ""}) — ${rows.length}건`, "", "| " + head.join(" | ") + " |", "|" + head.map(() => "---").join("|") + "|",
    ...rows.map(o => "| " + head.map(h => esc(o[h] || (h === "사용자명" ? o["사용자"] : h === "에이전트명" ? o["에이전트"] : o[h]))).join(" | ") + " |")];
  if (!rows.length) md.push("", "이 기간에 기록된 실패 상세가 없습니다(실패 상세는 2026-11-02 배포 이후 실패분부터 남습니다).");
  return { content: [{ type: "text", text: md.join("\n") }], structuredContent: { from, to, group_by: "failures", total_failures: rows.length, rows } };
}

const STATE_KO = { open: "확인 필요", reopened: "재발", pending: "수정 대기", needs_user: "직접 조치 필요", watching: "관찰 중", resolved: "개선완료", ignored: "조치불필요" };
// 열린 상태 정렬 순서 — 사용자가 할 일(직접 조치·승인)이 먼저
const OPEN_ORDER = { needs_user: 0, pending: 1, reopened: 2, open: 3, watching: 4 };
// 실패 원인별 묶음. 열린 것은 열린 건수가 많은 순, 닫힌 것은 최근에 닫은 순.
async function issueReport(which) {
  if (!["open", "closed", "all", "mine"].includes(which)) throw new Error("status는 open·mine·closed·all 중 하나여야 합니다");
  const names = await usage.readNames();
  const all = await usage.readIssues();
  const isOpen = i => i.state in OPEN_ORDER;
  const isMine = i => i.state === "needs_user" || i.state === "pending";
  const list = all.filter(i => which === "all" || (which === "mine" ? isMine(i) : which === "open" ? isOpen(i) : !isOpen(i)))
    .sort((a, b) => (isOpen(a) !== isOpen(b) ? (isOpen(a) ? -1 : 1) : isOpen(a) ? (OPEN_ORDER[a.state] - OPEN_ORDER[b.state]) || (b.open_count - a.open_count) || (a.last_at < b.last_at ? 1 : -1) : (a.closed_at < b.closed_at ? 1 : -1)));
  const kst = iso => { if (!iso) return ""; const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString(); return `${d.slice(0, 10)} ${d.slice(11, 16)}`; };
  const rows = list.map(i => {
    const ag = ((CATALOG && CATALOG.agents_v2) || []).find(x => x.id === i.last_agent);
    const be = BACKENDS[i.backend];
    return { "상태": STATE_KO[i.state] || i.state, "도구": i.tool, "담당 서버": be ? be.label : i.backend, "오류": i.err, "열린 건수": i.open_count, "누적 건수": i.count,
      "처음": kst(i.first_at), "마지막": kst(i.last_at), "마지막 사용자": names[i.last_caller] || i.last_caller || "", "마지막 에이전트": ag ? ag.name : (i.last_agent || ""),
      "마지막 인자": i.last_args || "", "닫은 시각": kst(i.closed_at), "조치 메모": i.note || "", "링크": i.link || "", "서명": i.sig };
  });
  const hasMemo = rows.some(o => o["조치 메모"] || o["링크"]);
  const head = which === "closed" ? ["상태", "도구", "오류", "누적 건수", "닫은 시각", "조치 메모", "서명"]
    : ["상태", "도구", "오류", "열린 건수", "마지막", "마지막 사용자", ...(hasMemo ? ["조치 메모", "링크"] : []), "서명"];
  const esc = v => String(v === undefined ? "" : v).replace(/\|/g, "\\|");
  const label = { open: "개선 필요 오류(직접 조치 필요·수정 대기·재발·확인 필요·관찰 중)", mine: "구전무님 확인이 필요한 항목(직접 조치 필요·수정 대기)", closed: "개선 완료된 오류(개선완료·조치불필요)", all: "오류 전체" }[which];
  // 열린 항목 상태별 건수 한 줄
  const openAll = all.filter(isOpen);
  const countLine = openAll.length ? "열린 항목: " + Object.keys(OPEN_ORDER).map(s => [STATE_KO[s], openAll.filter(i => i.state === s).length]).filter(x => x[1]).map(x => `${x[0]} ${x[1]}`).join(" · ") : "";
  let beatLine = "";
  try {
    const b = await usage.readMonitorBeat();
    if (b && b.at) {
      const hrs = (Date.now() - new Date(b.at).getTime()) / 3600000;
      const nums = ["tested", "failed", "skipped", "changed"].filter(k => b[k] !== undefined).map(k => `${{ tested: "시험", failed: "실패", skipped: "건너뜀", changed: "인자 변경" }[k]} ${b[k]}`).join(", ");
      beatLine = `자동 점검 마지막 실행: ${kst(b.at)}${nums ? ` (${nums})` : ""}${hrs > 48 ? " — ⚠ 48시간 넘게 실행되지 않음(점검 저장소의 Actions 확인 필요)" : ""}`;
    } else beatLine = "자동 점검 실행 기록 없음";
  } catch (e) { beatLine = ""; }
  const md = [`${label} — ${rows.length}건`, ...(beatLine ? [beatLine] : []), ...(countLine && which !== "closed" ? [countLine] : []), "", "| " + head.join(" | ") + " |", "|" + head.map(() => "---").join("|") + "|", ...rows.map(o => "| " + head.map(h => esc(o[h])).join(" | ") + " |")];
  if (!rows.length) md.push("", "해당하는 오류가 없습니다.");
  return { content: [{ type: "text", text: md.join("\n") }], structuredContent: { group_by: "issues", status: which, total: rows.length, rows } };
}

// 실패 원인 상태 변경(관리자 전용) — 개선해서 배포했으면 resolved, 외부 일시 장애·잘못된 입력이면 ignored.
const FAILURES_TOOL = {
  name: "relay_failures",
  description: "실패 원인의 상태를 바꿉니다(관리자 전용). 실패는 담당 서버·도구·오류 문구가 같으면 한 원인으로 묶입니다(relay_usage group_by=issues로 조회). 원인을 고쳐 배포했으면 resolved, 외부 서버 일시 장애·잘못된 입력처럼 고칠 것이 없으면 ignored로 닫습니다. 닫은 뒤 같은 원인으로 또 실패하면 '재발'로 다시 열린 목록에 나오고, 닫은 뒤 " + usage.RETENTION_DAYS + "일 동안 재발이 없으면 자동 삭제됩니다.",
  inputSchema: {
    type: "object",
    properties: {
      sig: { type: "string", description: "원인 서명(12자리, group_by=issues 결과의 '서명')" },
      status: { type: "string", enum: ["resolved", "ignored", "open", "pending", "needs_user", "watching"], description: "resolved: 개선완료, ignored: 조치불필요, open: 다시 열기(확인 필요), pending: 수정 대기(PR을 만들어 승인을 기다림 — link에 PR 주소), needs_user: 직접 조치 필요(키·환경변수·외부 서버처럼 사용자가 해야 함 — note에 할 일), watching: 관찰 중(일시 장애로 보고 재발을 지켜봄)" },
      note: { type: "string", description: "조치 내용·할 일 한두 줄(300자까지). 닫을 때, pending·needs_user·watching으로 둘 때 적는다" },
      link: { type: "string", description: "변경 링크(PR 주소 등, 선택)" }
    },
    required: ["sig", "status"],
    additionalProperties: false
  }
};

// 자동 점검 결과 기록(점검 키·관리자). report: 시험 호출 밖에서 찾은 문제(도구 인자 변경 등)를 '개선 필요 오류'에 올린다.
// beat: 점검 1회가 끝났음을 남긴다 — relay_usage issues 결과 맨 위에 마지막 실행 시각이 나오고, 오래 안 돌면 경고가 붙는다.
const MONITOR_TOOL = {
  name: "relay_monitor",
  description: "자동 점검 결과를 기록합니다(점검 키·관리자 전용). report는 도구 인자 변경처럼 시험 호출 밖에서 찾은 문제를 개선 필요 오류 목록에 올리고, beat는 점검 1회 완료(시험 수·실패 수 등)를 남깁니다.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["report", "beat"], description: "report: 문제 1건 기록, beat: 점검 완료 기록" },
      tool: { type: "string", description: "report — 문제가 난 도구 이름" },
      err: { type: "string", description: "report — 문제 문구(같은 문구면 한 원인으로 묶임)" },
      detail: { type: "string", description: "report — 자세한 내용(바뀐 인자 등, 300자까지)" },
      summary: { type: "object", description: "beat — {tested, failed, skipped, changed, weekly} 같은 숫자 요약" }
    },
    required: ["action"],
    additionalProperties: false
  }
};

// 페이지를 연 기록(relay_config) — 사용자×페이지 버전. 질문하지 않아 도구 호출이 없는 사람도 사본을 열었는지 볼 수 있다.
async function openReport(from, to) {
  const rows = await usage.readOpens(from, to);
  const names = await usage.readNames();
  const agg = new Map();
  for (const r of rows) {
    const id = r.caller + "\u0000" + r.page;
    const a = agg.get(id) || { caller: r.caller, page: r.page, first: r.date, last: r.date, days: new Set(), n: 0 };
    if (r.date < a.first) a.first = r.date;
    if (r.date > a.last) a.last = r.date;
    a.days.add(r.date); a.n += r.n;
    agg.set(id, a);
  }
  const list = [...agg.values()].sort((x, y) => (x.caller < y.caller ? -1 : x.caller > y.caller ? 1 : y.last < x.last ? -1 : y.last > x.last ? 1 : 0));
  const out = list.map(a => ({ "사용자": a.caller, "사용자명": names[a.caller] || "", "페이지": a.page, "처음 연 날": a.first, "마지막 연 날": a.last, "연 날수": a.days.size, "설정 받기": a.n }));
  const seen = new Set(list.map(a => a.caller));
  Object.keys(names).filter(l => !seen.has(l)).sort().forEach(l => out.push({ "사용자": l, "사용자명": names[l], "페이지": "기록 없음", "처음 연 날": "", "마지막 연 날": "", "연 날수": 0, "설정 받기": 0 }));
  const head = ["사용자", "사용자명", "페이지", "처음 연 날", "마지막 연 날", "연 날수", "설정 받기"];
  const md = [
    `페이지 열기 기록 ${from} ~ ${to} (한국시간, 사용자×페이지 버전, v1 = 옛 페이지) — 2026-11-06 배포 이후분만 있습니다`,
    "",
    "| " + head.join(" | ") + " |",
    "|" + head.map(() => "---").join("|") + "|",
    ...out.map(o => "| " + head.map(h => o[h]).join(" | ") + " |")
  ];
  if (!out.length) md.push("| " + head.map(() => "-").join(" | ") + " |");
  return { content: [{ type: "text", text: md.join("\n") }], structuredContent: { from, to, group_by: "opens", rows: out } };
}

// 질문 수·경유 호출 집계 — 질문 내용은 기록하지 않고 건수만 센다(페이지 17판부터)
async function questionReport(from, to, by) {
  const all = await usage.readUsage(from, to);
  const agName = id => { const ag = ((CATALOG && CATALOG.agents_v2) || []).find(x => x.id === id); return ag ? ag.name : ""; };
  const names = await usage.readNames();
  const agg = new Map();
  const get = (key, init) => { const id = key.join("\u0000"); let a = agg.get(id); if (!a) { a = Object.assign({ key }, init); agg.set(id, a); } return a; };
  let head, title;
  if (by === "via") {
    for (const r of all.filter(r => r.tool.startsWith("@via:"))) {
      const t = r.tool.slice(5), i = t.indexOf("|"), a = get([t.slice(0, i), t.slice(i + 1)], { n: 0, e: 0, users: new Set(), days: new Set() });
      a.n += r.calls; a.users.add(r.caller); a.days.add(r.date);
    }
    const list = [...agg.values()].sort((x, y) => y.n - x.n);
    head = ["맡긴 에이전트", "맡긴 에이전트명", "맡은 에이전트", "맡은 에이전트명", "조회 호출", "사용자 수", "사용일수"];
    title = `다른 에이전트가 맡겨서 한 조회 ${from} ~ ${to} (한국시간) — 맡은 에이전트의 사용현황에도 같은 호출이 들어 있어 더하면 중복입니다. 페이지 17판 이후분`;
    const out = list.map(a => ({ "맡긴 에이전트": a.key[0], "맡긴 에이전트명": agName(a.key[0]), "맡은 에이전트": a.key[1], "맡은 에이전트명": agName(a.key[1]), "조회 호출": a.n, "사용자 수": a.users.size, "사용일수": a.days.size }));
    return mdTable(title, head, out, { from, to, group_by: by, total_calls: out.reduce((s, o) => s + o["조회 호출"], 0), rows: out });
  }
  const q = all.filter(r => r.tool.startsWith("@q:")), qm = all.filter(r => r.tool.startsWith("@qm:"));
  const keyOf = { questions: r => [r.caller, r.ag], agent_questions: r => [r.ag], day_questions: r => [r.date, r.ag] }[by];
  for (const r of q) { r.ag = r.tool.slice(3); const a = get(keyOf(r), { n: 0, fg: 0, bg: 0, users: new Set(), days: new Set() }); a.n += r.calls; a.users.add(r.caller); a.days.add(r.date); }
  for (const r of qm) { const t = r.tool.slice(4), i = t.lastIndexOf("|"); r.ag = t.slice(0, i); const m = t.slice(i + 1); const a = get(keyOf(r), { n: 0, fg: 0, bg: 0, users: new Set(), days: new Set() }); a[m === "bg" ? "bg" : "fg"] += r.calls; }
  const list = [...agg.values()].sort((x, y) => (by === "day_questions" ? (x.key[0] < y.key[0] ? -1 : x.key[0] > y.key[0] ? 1 : y.n - x.n) : by === "questions" ? (x.key[0] < y.key[0] ? -1 : x.key[0] > y.key[0] ? 1 : y.n - x.n) : y.n - x.n));
  const out = list.map(a => {
    const o = {};
    if (by === "questions") { o["사용자"] = a.key[0]; o["사용자명"] = names[a.key[0]] || ""; }
    if (by === "day_questions") o["날짜"] = a.key[0];
    const ag = a.key[a.key.length - 1]; o["에이전트"] = ag; o["에이전트명"] = agName(ag);
    o["질문"] = a.n; o["화면 실행"] = a.fg; o["클라우드 실행"] = a.bg;
    if (by === "agent_questions") { o["질문한 사용자 수"] = a.users.size; o["사용일수"] = a.days.size; }
    return o;
  });
  head = Object.keys(out[0] || { [by === "questions" ? "사용자" : by === "day_questions" ? "날짜" : "에이전트"]: "", "에이전트명": "", "질문": 0 });
  title = `에이전트별 질문 수 ${from} ~ ${to} (한국시간, ${by} 기준, 질문 내용은 기록하지 않음) — 페이지 17판 이후분`;
  return mdTable(title, head, out, { from, to, group_by: by, total_questions: out.reduce((s, o) => s + o["질문"], 0), rows: out });
}
// 웹 도구 서버의 경로별 기록 — 계정 커넥터와 업무 에이전트를 나눠 웹 도구 호출과 Tavily·Nimble 외부 요청 수를 본다
async function webPathReport(from, to, by) {
  const rows = await usage.readWebPaths(from, to);
  const names = await usage.readNames();
  const COLS = [["tool.web_search", "웹 검색 호출"], ["tool.fetch_page", "웹페이지 읽기 호출"], ["tavily.search", "Tavily 검색"], ["tavily.extract", "Tavily 읽기"], ["nimble.search", "Nimble 검색"], ["nimble.extract", "Nimble 읽기"]];
  const CH = { account: "계정", agent: "업무 에이전트" };
  const agg = new Map();
  for (const r of rows) {
    const key = by === "web_paths" ? [r.caller, r.channel] : [r.date, r.channel];
    const id = key.join("\u0000");
    let a = agg.get(id); if (!a) { a = { key, v: {}, e: 0 }; agg.set(id, a); }
    a.v[r.item] = (a.v[r.item] || 0) + r.n;
    if (!r.item.startsWith("tool.")) a.e += r.errors;
  }
  const out = [...agg.values()].sort((x, y) => (x.key[0] < y.key[0] ? -1 : x.key[0] > y.key[0] ? 1 : x.key[1] < y.key[1] ? -1 : 1)).map(a => {
    const o = {};
    if (by === "web_paths") { o["사용자"] = a.key[0]; o["사용자명"] = names[a.key[0]] || ""; } else o["날짜"] = a.key[0];
    o["경로"] = CH[a.key[1]] || a.key[1];
    for (const [k, label] of COLS) o[label] = a.v[k] || 0;
    o["Tavily 합계"] = (a.v["tavily.search"] || 0) + (a.v["tavily.extract"] || 0);
    o["Nimble 합계"] = (a.v["nimble.search"] || 0) + (a.v["nimble.extract"] || 0);
    o["외부 요청 실패"] = a.e;
    return o;
  });
  const head = (by === "web_paths" ? ["사용자", "사용자명"] : ["날짜"]).concat(["경로"], COLS.map(c => c[1]), ["Tavily 합계", "Nimble 합계", "외부 요청 실패"]);
  const title = `웹 도구 경로별 사용 ${from} ~ ${to} (한국시간, ${by} 기준) — 계정은 계정 채팅의 웹 도구 커넥터, 업무 에이전트는 에이전트 페이지. Tavily·Nimble 커넥터를 계정 채팅에서 직접 부른 것과 기본 웹 검색은 포함되지 않음. 2026-11-07 이후분`;
  return mdTable(title, head, out, { from, to, group_by: by, rows: out });
}
// Tavily·Nimble 회사 측 사용량 — 키를 가진 웹 도구 서버의 관리자 전용 도구(web_vendor_usage)를 중계 서버 내부 키로 부른다.
// 이 도구는 backends.js의 web 도구 목록에 넣지 않는다(에이전트·사용자에게 열리지 않게 — relay_usage는 관리자 전용).
async function webVendorReport(by) {
  const view = by === "web_vendor_daily" ? "daily" : by === "web_vendor_monthly" ? "monthly" : "current";
  const msg = await rpcToBackend(BACKENDS.web, "tools/call", { name: "web_vendor_usage", arguments: { view } }, 60000, null);
  if (msg.error) throw new Error(`웹 도구 서버: ${msg.error.message}`);
  const r = msg.result || {};
  if (r.isError) throw new Error(((r.content || [])[0] || {}).text || "웹 도구 서버 오류");
  const sc = r.structuredContent || {};
  if (by === "web_vendor") return { content: r.content || [], structuredContent: Object.assign({ group_by: by }, sc) };
  if (by === "web_vendor_daily" || by === "web_vendor_monthly") return { content: r.content || [], structuredContent: Object.assign({ group_by: by }, sc) };
  // 과금 관리용 표: 요약(서비스별) / 출처별(사용자 식별자 옆에 사용자명)
  let rows = (by === "web_vendor_summary" ? sc.summary : sc.sources) || [], head;
  if (by === "web_vendor_sources") {
    const names = await usage.readNames();
    rows = rows.map(o => Object.assign({}, o, { "사용자명": names[o["사용자"]] || (o["사용자"] === "(계정)" ? "계정" : o["사용자"]) }));
    head = ["경로", "사용자", "사용자명", "Tavily", "Nimble", "비고"];
  } else head = ["서비스", "단위", "이번 달 사용", "무료 제공", "사용률", "과금 표시", "월말 추정", "기준"];
  const title = by === "web_vendor_summary"
    ? `Tavily·Nimble 이번 달 사용과 과금 (${sc.month || ""}, 1일~오늘) — Tavily는 크레딧, Nimble은 요청 수. 월말 추정은 지금까지의 일평균 × 그 달 일수`
    : `Tavily·Nimble 이번 달 출처별 사용 (${sc.month || ""}, 1일~오늘) — 행을 더하면 계정 전체. Tavily 열은 직접 호출·미분류·합계 행이 크레딧, 그 밖은 요청 수`;
  return mdTable(title, head, rows, { group_by: by, month: sc.month || null, rows });
}
function mdTable(title, head, out, sc) {
  const md = [title, "", "| " + head.join(" | ") + " |", "|" + head.map(() => "---").join("|") + "|", ...out.map(o => "| " + head.map(h => o[h]).join(" | ") + " |")];
  if (!out.length) md.push("| " + head.map(() => "-").join(" | ") + " |", "", "이 기간에 기록이 없습니다.");
  return { content: [{ type: "text", text: md.join("\n") }], structuredContent: sc };
}

async function usageReport(args) {
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const to = args.to || usage.kstDate();
  const from = args.from || usage.kstDate(new Date(Date.now() - 29 * 86400000));
  if (!DAY.test(from) || !DAY.test(to)) throw new Error("from·to는 YYYY-MM-DD 형식이어야 합니다");
  if (from > to) throw new Error("from이 to보다 늦습니다");
  const by = args.group_by || "user";
  if (by === "failures") return failureReport(from, to, args.user);
  if (by === "issues") return issueReport(args.status || "open");
  if (by === "opens") return openReport(from, to);
  if (["questions", "agent_questions", "day_questions", "via"].includes(by)) return questionReport(from, to, by);
  if (by === "web_paths" || by === "day_web_paths") return webPathReport(from, to, by);
  if (/^web_vendor/.test(by)) return webVendorReport(by);
  const all = await usage.readUsage(from, to);
  const isPage = r => r.tool.startsWith("@page:");
  const isAgent = r => r.tool.startsWith("@agent:");
  const isAt = r => r.tool.startsWith("@at:");
  const isMeta = r => r.tool.startsWith("@");
  const AGENT_BY = ["agent", "user_agent", "day_agent"];
  let rows;
  if (by === "user_page") rows = all.filter(isPage).map(r => Object.assign({}, r, { tool: r.tool.slice(6) }));
  else if (AGENT_BY.includes(by)) rows = all.filter(isAgent).map(r => Object.assign({}, r, { tool: r.tool.slice(7) }));
  else if (by === "agent_tool") rows = all.filter(isAt).map(r => { const t = r.tool.slice(4), i = t.indexOf("|"); return Object.assign({}, r, { agent: t.slice(0, i), tool: t.slice(i + 1) }); });
  else rows = all.filter(r => !isMeta(r));
  const keyOf = { user: r => [r.caller], user_tool: r => [r.caller, r.tool], day: r => [r.date], day_user: r => [r.date, r.caller], user_page: r => [r.caller, r.tool],
    agent: r => [r.tool], user_agent: r => [r.caller, r.tool], day_agent: r => [r.date, r.tool], agent_tool: r => [r.agent, r.tool] }[by];
  if (!keyOf) throw new Error(`group_by 값이 올바르지 않습니다: ${by}`);
  const cols = { user: ["사용자"], user_tool: ["사용자", "도구"], day: ["날짜"], day_user: ["날짜", "사용자"], user_page: ["사용자", "페이지"],
    agent: ["에이전트"], user_agent: ["사용자", "에이전트"], day_agent: ["날짜", "에이전트"], agent_tool: ["에이전트", "도구"] }[by];
  const agg = new Map();
  const bump = (k, r) => {
    const id = k.join("\u0000");
    const a = agg.get(id) || { key: k, calls: 0, errors: 0, ms: 0, tools: new Set(), days: new Set(), users: new Set() };
    a.calls += r.calls; a.errors += r.errors; a.ms += r.ms; if (r.tool) a.tools.add(r.tool); if (r.date) a.days.add(r.date); if (r.caller) a.users.add(r.caller);
    agg.set(id, a);
  };
  for (const r of rows) bump(keyOf(r), r);
  // 에이전트 id를 보내지 않은 호출(옛 사본)은 같은 단위의 전체 호출(도구별 기록)에서 에이전트 호출을 빼서 (미구분)으로 보인다.
  // 호출 수·실패 수·소요시간 모두 같은 방식으로 뺀다. 음수가 되면(기록 시점 차이) 넣지 않는다.
  const tools = all.filter(r => !isMeta(r));
  if (AGENT_BY.includes(by)) {
    const restOf = { agent: () => [], user_agent: r => [r.caller], day_agent: r => [r.date] }[by];
    const tot = new Map(), ag = new Map();
    const add = (m, r) => { const k = restOf(r), id = k.join("\u0000"); const o = m.get(id) || { k, n: 0, e: 0, ms: 0 }; o.n += r.calls; o.e += r.errors; o.ms += r.ms; m.set(id, o); };
    tools.forEach(r => add(tot, r));
    rows.forEach(r => add(ag, r));
    tot.forEach((o, id) => {
      const g = ag.get(id) || { n: 0, e: 0, ms: 0 };
      const diff = o.n - g.n;
      if (diff > 0) bump(by === "agent" ? ["(미구분)"] : [o.k[0], "(미구분)"], { calls: diff, errors: Math.max(0, o.e - g.e), ms: Math.max(0, o.ms - g.ms), tool: "", date: "", caller: "" });
    });
  } else if (by === "agent_tool") {
    const tot = new Map(), ag = new Map();
    const add = (m, r) => { const o = m.get(r.tool) || { n: 0, e: 0, ms: 0 }; o.n += r.calls; o.e += r.errors; o.ms += r.ms; m.set(r.tool, o); };
    tools.forEach(r => add(tot, r));
    rows.forEach(r => add(ag, r));
    tot.forEach((o, t) => {
      const g = ag.get(t) || { n: 0, e: 0, ms: 0 };
      const diff = o.n - g.n;
      if (diff > 0) bump(["(미구분)", t], { calls: diff, errors: Math.max(0, o.e - g.e), ms: Math.max(0, o.ms - g.ms), tool: t, date: "", caller: "" });
    });
  }
  const list = [...agg.values()].sort((x, y) => (by.startsWith("day") ? (x.key[0] < y.key[0] ? -1 : x.key[0] > y.key[0] ? 1 : y.calls - x.calls) : y.calls - x.calls));
  const userCol = cols.indexOf("사용자");
  const names = userCol >= 0 ? await usage.readNames() : {};
  const out = list.map(a => {
    const o = {};
    cols.forEach((c, i) => { o[c] = a.key[i]; if (i === userCol) o["사용자명"] = names[a.key[i]] || ""; });
    const ai = cols.indexOf("에이전트");
    if (ai >= 0) { const ag = ((CATALOG && CATALOG.agents_v2) || []).find(x => x.id === a.key[ai]); o["에이전트명"] = ag ? ag.name : ""; }
    o["호출"] = a.calls; o["실패"] = a.errors;
    o["평균 소요(초)"] = a.calls ? Math.round(a.ms / a.calls / 100) / 10 : 0;
    if (by === "user") { o["사용일수"] = a.days.size; o["사용 도구 수"] = a.tools.size; }
    if (by === "agent") { o["사용자 수"] = a.users.size; o["사용일수"] = a.days.size; }
    return o;
  });
  const total = out.reduce((s, o) => s + o["호출"], 0);
  const head = Object.keys(out[0] || Object.fromEntries(cols.map(c => [c, ""]).concat([["호출", 0], ["실패", 0], ["평균 소요(초)", 0]])));
  const md = [
    `중계 서버 사용현황 ${from} ~ ${to} (한국시간, ${by} 기준) — 총 ${total}회`,
    "",
    "| " + head.join(" | ") + " |",
    "|" + head.map(() => "---").join("|") + "|",
    ...out.map(o => "| " + head.map(h => o[h]).join(" | ") + " |")
  ];
  if (!out.length) md.push("| " + head.map(() => "-").join(" | ") + " |", "", "이 기간에 기록된 도구 호출이 없습니다.");
  return { content: [{ type: "text", text: md.join("\n") }], structuredContent: { from, to, group_by: by, total_calls: total, rows: out } };
}

// 업무 에이전트 페이지는 구조화 결과(structuredContent)가 있으면 그것만 읽는다.
// 본문은 글(content text)에만 두고 구조화 결과에는 요약 필드만 넣는 서버가 있어(예: 사업의 내용)
// 본문이 페이지에 전달되지 않았다. 글이 JSON 이 아니고 구조화 결과보다 내용이 많으면 글을 text 로 함께 넣는다.
function attachText(result) {
  try {
    if (!result || result.isError) return result;
    const sc = result.structuredContent;
    if (!sc || typeof sc !== "object" || Array.isArray(sc)) return result;
    const text = (result.content || []).filter(c => c && c.type === "text" && c.text).map(c => c.text).join("\n");
    if (!text) return result;
    const head = text.trim()[0];
    if (head === "{" || head === "[") { try { JSON.parse(text); return result; } catch (e) { /* 글이다 */ } }
    if (JSON.stringify(sc).length >= text.length * 0.6) return result; // 구조화 결과가 이미 내용을 담고 있다
    const key = sc.text === undefined ? "text" : "content_text";
    return Object.assign({}, result, { structuredContent: Object.assign({}, sc, { [key]: text }) });
  } catch (e) {
    return result;
  }
}

// ---------- 실패 상세: 오류 문구와 인자 요약 ----------
// 담당 서버가 돌려준 오류 문구(JSON-RPC error 또는 isError 결과의 글)를 한 줄로 줄인다.
function errTextOf(msg) {
  try {
    if (msg && msg.error) return oneLine(`[${msg.error.code}] ${msg.error.message || ""}`);
    const r = msg && msg.result;
    if (r && r.isError) {
      const t = (r.content || []).filter(c => c && c.type === "text" && c.text).map(c => c.text).join(" ");
      return oneLine(t || "(오류 문구 없음)");
    }
  } catch (e) { /* 아래로 */ }
  return "";
}
function oneLine(t, n) { const s = String(t || "").replace(/\s+/g, " ").trim(); const max = n || 300; return s.length > max ? s.slice(0, max) + "…" : s; }
// 인자 요약: 값마다 80자, 전체 300자까지. 어떤 문서·대상을 불렀는지 알아보는 용도다.
function argSummary(args) {
  try {
    const o = {};
    Object.keys(args || {}).slice(0, 12).forEach(k => {
      const v = args[k];
      o[k] = typeof v === "string" ? oneLine(v, 80) : (v && typeof v === "object" ? oneLine(JSON.stringify(v), 80) : v);
    });
    return oneLine(JSON.stringify(o), 300);
  } catch (e) {
    return "";
  }
}
async function noteFail(caller, name, id, ms, err, args, agent) {
  console.log(`[fail] caller=${caller} tool=${name} backend=${id} ms=${ms} agent=${agent || "-"} err=${err} args=${argSummary(args)}`);
  await usage.recordFailure({ caller, tool: name, backend: id, agent: agent || "", ms, err, args: argSummary(args) });
}

// 자동 점검 키의 호출은 사용량 합계(사용자별·도구별)에 넣지 않는다 — 실패는 noteFail로 따로 남는다
async function recordCallFor(caller, ...rest) {
  if (isMonitor(caller)) return;
  return usage.recordCall(caller, ...rest);
}

// ---------- tools/call: 담당 서버로 그대로 넘긴다 ----------
async function callTool(params, caller, page, viaPage, agent) {
  const name = params && params.name;
  if (name === "relay_usage") {
    if (!isAdmin(caller)) return { error: { code: -32602, message: `이 서버에서 쓸 수 없는 도구입니다: ${name}` } };
    try {
      return { result: await usageReport((params && params.arguments) || {}) };
    } catch (e) {
      return { result: { isError: true, content: [{ type: "text", text: `사용현황 조회 오류: ${e.message}` }] } };
    }
  }
  if (name === "relay_failures") {
    if (!isAdmin(caller)) return { error: { code: -32602, message: `이 서버에서 쓸 수 없는 도구입니다: ${name}` } };
    try {
      const a = (params && params.arguments) || {};
      const r = await usage.setIssueStatus(a.sig, a.status, a.note, a.link);
      return { result: { content: [{ type: "text", text: `오류 ${r.sig}의 상태를 '${STATE_KO[r.status] || r.status}'(으)로 바꿨습니다.` }], structuredContent: r } };
    } catch (e) {
      return { result: { isError: true, content: [{ type: "text", text: `실패 원인 상태 변경 오류: ${e.message}` }] } };
    }
  }
  if (name === "relay_monitor") {
    if (!isAdmin(caller) && !isMonitor(caller)) return { error: { code: -32602, message: `이 서버에서 쓸 수 없는 도구입니다: ${name}` } };
    const a = (params && params.arguments) || {};
    try {
      if (a.action === "report") {
        if (!a.tool || !a.err) throw new Error("report에는 tool·err가 필요합니다");
        await usage.recordFailure({ caller, tool: String(a.tool).slice(0, 80), backend: "monitor", agent: "", ms: 0, err: oneLine(a.err, 300), args: oneLine(a.detail || "", 300) });
        return { result: { content: [{ type: "text", text: "기록했습니다." }], structuredContent: { ok: true } } };
      }
      if (a.action === "beat") {
        await usage.setMonitorBeat(Object.assign({ at: new Date().toISOString(), caller }, (a.summary && typeof a.summary === "object") ? a.summary : {}));
        return { result: { content: [{ type: "text", text: "점검 완료를 기록했습니다." }], structuredContent: { ok: true } } };
      }
      throw new Error("action은 report·beat 중 하나여야 합니다");
    } catch (e) {
      return { result: { isError: true, content: [{ type: "text", text: `점검 기록 오류: ${e.message}` }] } };
    }
  }
  if (name === "relay_users") {
    if (!isAdmin(caller)) return { error: { code: -32602, message: `이 서버에서 쓸 수 없는 도구입니다: ${name}` } };
    try {
      return { result: await usersAdmin((params && params.arguments) || {}) };
    } catch (e) {
      return { result: { isError: true, content: [{ type: "text", text: `사용자 이름표 오류: ${e.message}` }] } };
    }
  }
  if (name === "relay_config") {
    const ca = (params && params.arguments) || {};
    if (!ca.page) {
      console.log(`[pagekey] reject tool=relay_config caller=${caller} why=no-page(retired) part=${ca.part || ""}`);
      if (!ca.part || ca.part === "catalog") await usage.recordOpen(caller, "v1");
      if (ca.since_version === RETIRED_VERSION) return { result: { content: [{ type: "text", text: RETIRED_MSG }], structuredContent: { version: RETIRED_VERSION, unchanged: true } } };
      return { result: { content: [{ type: "text", text: RETIRED_MSG }], structuredContent: retiredCatalog() } };
    }
    if (!pageOk(ca)) { console.log(`[pagekey] reject tool=relay_config caller=${caller} why=${pageRejectWhy(ca)}`); return { result: { isError: true, content: [{ type: "text", text: PAGE_ONLY_MSG }] } }; }
    if (!ca.part || ca.part === "catalog") await usage.recordOpen(caller, ca.page);
    if (ca.part === "q") {
      await usage.recordQuestion(caller, ca.agent, ca.mode);
      return { result: { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } } };
    }
    try {
      return { result: await configResult((params && params.arguments) || {}, caller) };
    } catch (e) {
      return { result: { isError: true, content: [{ type: "text", text: `설정 조회 오류: ${e.message}` }] } };
    }
  }
  if (name === "relay_call") {
    const a = (params && params.arguments) || {};
    const inner = String(a.tool || "");
    const page = a.page ? String(a.page).slice(0, 20) : "";
    if (!pageOk(a)) { console.log(`[pagekey] reject tool=relay_call inner=${inner.slice(0, 60)} caller=${caller} why=${pageRejectWhy(a)}`); return { result: { isError: true, content: [{ type: "text", text: PAGE_ONLY_MSG }] } }; }
    if (!inner || inner.startsWith("relay_") || !ROUTE[inner]) {
      return { result: { isError: true, content: [{ type: "text", text: `relay_call로 부를 수 없는 도구입니다: ${inner || "(없음)"}` }] } };
    }
    let innerArgs = a.arguments;
    if (typeof innerArgs === "string") { try { innerArgs = JSON.parse(innerArgs); } catch (e) { innerArgs = null; } }
    if (innerArgs !== undefined && (innerArgs === null || typeof innerArgs !== "object" || Array.isArray(innerArgs))) {
      return { result: { isError: true, content: [{ type: "text", text: "arguments는 JSON 객체여야 합니다" }] } };
    }
    const ag = a.agent ? String(a.agent).slice(0, 40) : "";
    const res = await callTool({ name: inner, arguments: innerArgs || {} }, caller, page, true, ag);
    if (a.via) await usage.recordVia(caller, String(a.via), ag, !!(res && res.result && !res.result.isError));
    return res;
  }
  // 조회 도구를 relay_call 없이 직접 부르는 것은 일반 채팅이므로 거절한다
  if (!viaPage) {
    return { result: { isError: true, content: [{ type: "text", text: PAGE_ONLY_MSG }] } };
  }
  const id = ROUTE[name];
  if (!id) {
    return { error: { code: -32602, message: `이 서버에서 쓸 수 없는 도구입니다: ${name}` } };
  }
  const b = BACKENDS[id];
  const t0 = Date.now();
  // 인자를 담당 서버 스키마에 맞춘다(형 변환·범위 맞춤). 스키마를 못 받으면 그대로 넘긴다
  let args = (params && params.arguments) || {};
  // 실패 기록에는 보정 전 인자와 보정 내역을 함께 남긴다(보정이 인자를 지워 원인을 못 보는 일이 있었다 — 2026-11-07 {} 기록)
  const rawArgs = args;
  let fixNote = "";
  let missing = [], schemaDef = null;
  try {
    const def = (await backendTools(id)).find(t => t.name === name);
    if (def) {
      schemaDef = def.inputSchema;
      const fixed = coerceArgs(def.inputSchema, args, UPSTREAM[name] || name);
      if (fixed.changes.length) {
        console.log(`[coerce] tool=${name} ${fixed.changes.join("; ")}`);
        fixNote = fixed.changes.join("; ");
      }
      args = fixed.args;
      missing = missingRequired(def.inputSchema, args, b.forceArgs);
    }
  } catch (e) {
    console.log(`[coerce] tool=${name} 건너뜀: ${e.message}`);
  }
  const failArgs = fixNote ? Object.assign({}, rawArgs, { "(보정)": fixNote }) : rawArgs;
  // 필수 인자가 비어 있으면 담당 서버에 보내지 않고, 받을 이름과 형식을 바로 알려 준다
  if (missing.length && schemaDef && schemaDef.properties) {
    const want = missing.map(p => {
      const s = schemaDef.properties[p] || {};
      const d = String(s.description || "").replace(/\s+/g, " ").slice(0, 80);
      const en = Array.isArray(s.enum) ? ` 값: ${s.enum.slice(0, 12).join("|")}` : "";
      return `${p}${d ? ` (${d})` : ""}${en}`;
    }).join(" / ");
    const got = Object.keys(rawArgs || {}).join(", ") || "없음";
    const text = `필수 인자가 비어 있습니다: ${want}. 받은 인자 이름: ${got}. 이 도구가 받는 인자 이름: ${Object.keys(schemaDef.properties).join(", ")}. 이름을 고쳐 다시 부르세요(같은 인자로 되풀이하지 마세요).`;
    const ms = Date.now() - t0;
    await recordCallFor(caller, name, ms, false, page, agent);
    await noteFail(caller, name, id, ms, `필수 인자 누락: ${missing.join(", ")}`, failArgs, agent);
    return { result: { isError: true, content: [{ type: "text", text }] } };
  }
  if (b.local) {
    try {
      const result = await localOf(b).call(name, args, caller);
      const ms = Date.now() - t0;
      console.log(`[call] caller=${caller} tool=${name} backend=${id} ms=${ms} ok=${!result.isError}`);
      await recordCallFor(caller, name, ms, !result.isError, page, agent);
      if (result.isError) await noteFail(caller, name, id, ms, errTextOf({ result }), failArgs, agent);
      return { result };
    } catch (e) {
      const ms = Date.now() - t0;
      console.log(`[call] caller=${caller} tool=${name} backend=${id} ms=${ms} fail=${e.message}`);
      await recordCallFor(caller, name, ms, false, page, agent);
      await noteFail(caller, name, id, ms, oneLine(`중계 예외: ${e.message}`), failArgs, agent);
      return { result: { isError: true, content: [{ type: "text", text: `${b.label} 도구 오류: ${e.message}` }] } };
    }
  }
  // forceArgs: 이 서버 호출에는 항상 이 인자 값을 넣는다(예: 공개 컬렉션 하나로 고정)
  if (b.forceArgs) args = Object.assign({}, args || {}, b.forceArgs);
  if (b.strictKey && !backendKey(b)) {
    console.log(`[call] caller=${caller} tool=${name} backend=${id} 전용 키 없음`);
    await recordCallFor(caller, name, Date.now() - t0, false, page, agent);
    await noteFail(caller, name, id, Date.now() - t0, "중계 서버에 이 담당 서버의 전용 키가 설정되지 않음", failArgs, agent);
    return { result: { isError: true, content: [{ type: "text", text: `${b.label} 도구가 아직 준비되지 않았습니다(서버 설정 필요). 이 도구 없이 진행하고 확인하지 못한 항목으로 밝히세요.` }] } };
  }
  try {
    const msg = (b.splitRetry && b.splitRetry.tool === name)
      ? await callSplitRetry(b, UPSTREAM[name] || name, args || {}, caller, { n: 0, t0: Date.now() })
      : await rpcToBackend(b, "tools/call", { name: UPSTREAM[name] || name, arguments: args }, CALL_TIMEOUT_MS, caller);
    const ok = !msg.error && !(msg.result && msg.result.isError);
    const ms = Date.now() - t0;
    console.log(`[call] caller=${caller} tool=${name} backend=${id} ms=${ms} ok=${ok}`);
    await recordCallFor(caller, name, ms, ok, page, agent);
    if (!ok) await noteFail(caller, name, id, ms, errTextOf(msg), failArgs, agent);
    if (msg.error) return { error: msg.error };
    return { result: attachText(msg.result) };
  } catch (e) {
    const ms = Date.now() - t0;
    console.log(`[call] caller=${caller} tool=${name} backend=${id} ms=${ms} fail=${e.message}`);
    await recordCallFor(caller, name, ms, false, page, agent);
    await noteFail(caller, name, id, ms, oneLine(`중계 예외: ${e.message}`), failArgs, agent);
    return { result: { isError: true, content: [{ type: "text", text: `중계 오류: ${e.message}` }] } };
  }
}

// ---------- JSON-RPC 처리 ----------
async function handleMessage(m, caller) {
  const isNotification = m && m.id === undefined;
  const reply = (body) => (isNotification ? null : Object.assign({ jsonrpc: "2.0", id: m.id }, body));
  if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
    return { jsonrpc: "2.0", id: (m && m.id) ?? null, error: { code: -32600, message: "Invalid Request" } };
  }
  switch (m.method) {
    case "initialize": {
      const req = m.params && m.params.protocolVersion;
      return reply({ result: {
        protocolVersion: SUPPORTED.includes(req) ? req : LATEST,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "업무 에이전트 페이지 전용 서버입니다. 일반 채팅에서 쓸 수 있는 조회 도구는 제공하지 않으며, 이 서버의 도구는 일반 채팅의 질문에 호출하지 않습니다."
      } });
    }
    case "ping":
      return reply({ result: {} });
    case "tools/list":
      return reply({ result: { tools: await listTools(caller) } });
    case "tools/call":
      return reply(await callTool(m.params, caller));
    default:
      if (isNotification) return null;
      return reply({ error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
}

function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return Promise.resolve(typeof req.body === "string" ? req.body : (Buffer.isBuffer(req.body) ? req.body.toString("utf8") : JSON.stringify(req.body)));
  }
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => { s += c; });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  // 게이트 (sys-mcp-gatekey 2-2 표준 코드)
  let gk = (req.query && req.query.k) || null;
  if (!gk) {
    try { gk = new URL(req.url, "http://localhost").searchParams.get("k"); } catch (e) { gk = null; }
  }
  const allowed = GATE_KEYS.length === 0 || (!!gk && (GATE_KEYS.includes(gk) || MONITOR_KEYS.includes(gk)));
  const caller = keyLabel(gk);
  console.log(`[gate] mode=${GATE_MODE} method=${req.method} caller=${caller} allowed=${allowed}`);
  if (!allowed && GATE_MODE === "enforce") {
    sendJson(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } });
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    sendJson(res, 405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed. Use POST." } });
    return;
  }

  const pv = req.headers["mcp-protocol-version"];
  if (pv && !SUPPORTED.includes(String(pv))) {
    sendJson(res, 400, { jsonrpc: "2.0", id: null, error: {
      code: -32600, message: `Bad Request: Unsupported protocol version (supported versions: ${SUPPORTED.join(", ")})`
    } });
    return;
  }

  let raw, body;
  try {
    raw = await readBody(req);
    body = JSON.parse(raw);
  } catch (e) {
    sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  const msgs = Array.isArray(body) ? body : [body];
  const hasRequest = msgs.some(m => m && m.id !== undefined);
  if (!hasRequest) {
    await Promise.all(msgs.map(m => handleMessage(m, caller)));
    res.statusCode = 202; res.end(); return;
  }

  // 오래 걸리는 호출(공시 원문·나라장터 7일 조회 등)은 30초를 넘는다. 그동안 바이트가 전혀 흐르지 않으면
  // 중간 프록시가 연결을 끊는 일이 실측됐다(2026-10-16). 클라이언트가 SSE를 받으면 10초마다
  // keepalive 주석을 보내고 끝에 결과 한 건을 event로 보낸다. 백엔드 서버들과 같은 방식이다.
  const accept = String(req.headers["accept"] || "");
  if (/text\/event-stream/i.test(accept)) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (res.flushHeaders) res.flushHeaders();
    const ka = setInterval(() => { try { res.write(": keepalive\n\n"); } catch (e) {} }, 10000);
    try {
      const outs = (await Promise.all(msgs.map(m => handleMessage(m, caller)))).filter(Boolean);
      const payload = Array.isArray(body) ? outs : outs[0];
      res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    } finally {
      clearInterval(ka);
      res.end();
    }
    return;
  }

  const outs = (await Promise.all(msgs.map(m => handleMessage(m, caller)))).filter(Boolean);
  sendJson(res, 200, Array.isArray(body) ? outs : outs[0]);
};
