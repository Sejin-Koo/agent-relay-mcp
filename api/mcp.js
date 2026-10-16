// 업무 에이전트 중계 MCP 서버.
// 여러 자체 MCP 서버를 주소 하나로 묶는다. 요청을 받아 도구 이름으로 담당 서버를 찾고 그대로 넘긴다.
// SDK 없이 JSON-RPC를 직접 구현했으므로 규격상 필요한 세 가지를 직접 처리한다:
//   ① initialize 버전 협상(지원 목록과 대조) ② 미지원 MCP-Protocol-Version 헤더에 400 ③ 알림에 202

const { BACKENDS, ROUTE } = require("../lib/backends");
const usage = require("../lib/usage");
const CATALOG = require("../lib/agents.json");

const SERVER_INFO = { name: "agent-relay-mcp", version: "1.0.0" };
// @modelcontextprotocol/sdk 1.32.1 의 SUPPORTED_PROTOCOL_VERSIONS 와 같은 값으로 맞춘다
const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const LATEST = SUPPORTED[0];

const GATE_KEYS = (process.env.MCP_GATE_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
const GATE_MODE = (process.env.MCP_GATE_MODE || "observe").trim().toLowerCase();

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
  return (b.keyEnv && process.env[b.keyEnv]) || process.env.BACKEND_KEY || "";
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

async function rpcToBackend(b, method, params, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const id = Date.now() % 1e9;
  try {
    const r = await fetch(backendUrl(b), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
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
    if (!msg) throw new Error(`${b.label} 서버 응답을 해석하지 못했습니다`);
    return msg;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`${b.label} 서버가 ${Math.round(timeoutMs / 1000)}초 안에 응답하지 않았습니다`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- tools/list: 서버별 도구 정의를 받아 허용 목록만 남긴다 ----------
const listCache = {}; // id -> { at, tools }
async function backendTools(id) {
  const b = BACKENDS[id];
  const c = listCache[id];
  if (c && Date.now() - c.at < LIST_TTL_MS) return c.tools;
  try {
    const msg = await rpcToBackend(b, "tools/list", {}, LIST_TIMEOUT_MS);
    if (msg.error) throw new Error(msg.error.message || "tools/list 오류");
    const all = (msg.result && msg.result.tools) || [];
    const allow = new Set(b.tools);
    const tools = all.filter(t => allow.has(t.name));
    const missing = b.tools.filter(n => !tools.some(t => t.name === n));
    if (missing.length) console.log(`[list] ${id} 허용 목록에 있으나 서버에 없는 도구: ${missing.join(",")}`);
    listCache[id] = { at: Date.now(), tools };
    return tools;
  } catch (e) {
    console.log(`[list] ${id} 실패: ${e.message}`);
    return c ? c.tools : []; // 실패하면 직전 캐시라도 쓴다
  }
}

async function listTools(caller) {
  const ids = Object.keys(BACKENDS);
  const parts = await Promise.all(ids.map(backendTools));
  const tools = [].concat(...parts);
  tools.push(CONFIG_TOOL, CALL_TOOL);
  if (isAdmin(caller)) tools.push(USAGE_TOOL);
  return tools;
}

// ---------- 에이전트 페이지 전용: 설정 내려주기 · 대신 호출 ----------
// 페이지 사본에는 이 두 도구 이름만 적어 두고, 에이전트 목록·도구 배정·규칙(lib/agents.json)과
// 실제로 부를 수 있는 도구(lib/backends.js)는 이 서버가 정한다. 그래서 이 서버만 고치면 사본에도 반영된다.
const CONFIG_TOOL = {
  name: "relay_config",
  description: "업무 에이전트 페이지 전용: 에이전트 목록, 에이전트별 도구 배정과 조회 규칙을 돌려준다. since_version이 현재 버전과 같으면 unchanged만 돌려준다. 일반 질문에는 쓰지 않는다.",
  inputSchema: { type: "object", properties: { since_version: { type: "string", description: "페이지가 이미 가진 설정 버전" } }, additionalProperties: false },
  annotations: { readOnlyHint: true }
};
const CALL_TOOL = {
  name: "relay_call",
  description: "업무 에이전트 페이지 전용: 이 서버가 연 다른 도구를 이름으로 대신 호출한다. tool에 도구 이름, arguments에 그 도구의 인자 객체를 넣는다. 결과는 그 도구를 직접 부른 것과 같다. 일반 채팅에서는 해당 도구를 직접 부르면 된다.",
  inputSchema: { type: "object", properties: {
    tool: { type: "string", description: "호출할 도구 이름(이 서버 tools/list에 있는 이름)" },
    arguments: { type: "object", description: "그 도구의 인자" }
  }, required: ["tool"], additionalProperties: false }
};
function configResult(args) {
  const since = args && args.since_version;
  if (since && since === CATALOG.version) {
    return { content: [{ type: "text", text: `에이전트 설정 ${CATALOG.version} — 변경 없음` }], structuredContent: { version: CATALOG.version, unchanged: true } };
  }
  return {
    content: [{ type: "text", text: `에이전트 설정 ${CATALOG.version} — 에이전트 ${CATALOG.agents.length}개(${CATALOG.agents.map(a => a.name).join(", ")}). 전체 내용은 structuredContent에 있다.` }],
    structuredContent: CATALOG
  };
}

// ---------- 관리자 전용: 사용자별 사용현황 ----------
const USAGE_TOOL = {
  name: "relay_usage",
  description: "업무 에이전트 중계 서버의 사용자별 사용현황을 조회합니다(관리자 전용). 사용자는 게이트키 식별자(예: kangyunkyung)로 표시되며, 호출 수·실패 수·평균 소요시간을 집계합니다. 질문 내용은 기록되지 않습니다. 기록은 한국시간 날짜 기준이며 " + usage.RETENTION_DAYS + "일이 지나면 자동 삭제됩니다.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "시작일 YYYY-MM-DD (기본: 오늘 포함 최근 30일의 첫날)" },
      to: { type: "string", description: "종료일 YYYY-MM-DD (기본: 오늘)" },
      group_by: { type: "string", enum: ["user", "user_tool", "day", "day_user"], description: "집계 단위 — user: 사용자별(기본), user_tool: 사용자×도구, day: 날짜별, day_user: 날짜×사용자" }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: true }
};

async function usageReport(args) {
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const to = args.to || usage.kstDate();
  const from = args.from || usage.kstDate(new Date(Date.now() - 29 * 86400000));
  if (!DAY.test(from) || !DAY.test(to)) throw new Error("from·to는 YYYY-MM-DD 형식이어야 합니다");
  if (from > to) throw new Error("from이 to보다 늦습니다");
  const by = args.group_by || "user";
  const rows = await usage.readUsage(from, to);
  const keyOf = { user: r => [r.caller], user_tool: r => [r.caller, r.tool], day: r => [r.date], day_user: r => [r.date, r.caller] }[by];
  if (!keyOf) throw new Error(`group_by 값이 올바르지 않습니다: ${by}`);
  const cols = { user: ["사용자"], user_tool: ["사용자", "도구"], day: ["날짜"], day_user: ["날짜", "사용자"] }[by];
  const agg = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    const id = k.join("\u0000");
    const a = agg.get(id) || { key: k, calls: 0, errors: 0, ms: 0, tools: new Set(), days: new Set() };
    a.calls += r.calls; a.errors += r.errors; a.ms += r.ms; a.tools.add(r.tool); a.days.add(r.date);
    agg.set(id, a);
  }
  const list = [...agg.values()].sort((x, y) => (by.startsWith("day") ? (x.key[0] < y.key[0] ? -1 : x.key[0] > y.key[0] ? 1 : y.calls - x.calls) : y.calls - x.calls));
  const out = list.map(a => {
    const o = {};
    cols.forEach((c, i) => { o[c] = a.key[i]; });
    o["호출"] = a.calls; o["실패"] = a.errors;
    o["평균 소요(초)"] = a.calls ? Math.round(a.ms / a.calls / 100) / 10 : 0;
    if (by === "user") { o["사용일수"] = a.days.size; o["사용 도구 수"] = a.tools.size; }
    return o;
  });
  const total = rows.reduce((s, r) => s + r.calls, 0);
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

// ---------- tools/call: 담당 서버로 그대로 넘긴다 ----------
async function callTool(params, caller) {
  const name = params && params.name;
  if (name === "relay_usage") {
    if (!isAdmin(caller)) return { error: { code: -32602, message: `이 서버에서 쓸 수 없는 도구입니다: ${name}` } };
    try {
      return { result: await usageReport((params && params.arguments) || {}) };
    } catch (e) {
      return { result: { isError: true, content: [{ type: "text", text: `사용현황 조회 오류: ${e.message}` }] } };
    }
  }
  if (name === "relay_config") return { result: configResult((params && params.arguments) || {}) };
  if (name === "relay_call") {
    const a = (params && params.arguments) || {};
    const inner = String(a.tool || "");
    if (!inner || inner.startsWith("relay_") || !ROUTE[inner]) {
      return { result: { isError: true, content: [{ type: "text", text: `relay_call로 부를 수 없는 도구입니다: ${inner || "(없음)"}` }] } };
    }
    let innerArgs = a.arguments;
    if (typeof innerArgs === "string") { try { innerArgs = JSON.parse(innerArgs); } catch (e) { innerArgs = null; } }
    if (innerArgs !== undefined && (innerArgs === null || typeof innerArgs !== "object" || Array.isArray(innerArgs))) {
      return { result: { isError: true, content: [{ type: "text", text: "arguments는 JSON 객체여야 합니다" }] } };
    }
    return callTool({ name: inner, arguments: innerArgs || {} }, caller);
  }
  const id = ROUTE[name];
  if (!id) {
    return { error: { code: -32602, message: `이 서버에서 쓸 수 없는 도구입니다: ${name}` } };
  }
  const b = BACKENDS[id];
  const t0 = Date.now();
  try {
    const msg = await rpcToBackend(b, "tools/call", { name, arguments: (params && params.arguments) || {} }, CALL_TIMEOUT_MS);
    const ok = !msg.error && !(msg.result && msg.result.isError);
    console.log(`[call] caller=${caller} tool=${name} backend=${id} ms=${Date.now() - t0} ok=${ok}`);
    await usage.recordCall(caller, name, Date.now() - t0, ok);
    if (msg.error) return { error: msg.error };
    return { result: msg.result };
  } catch (e) {
    console.log(`[call] caller=${caller} tool=${name} backend=${id} ms=${Date.now() - t0} fail=${e.message}`);
    await usage.recordCall(caller, name, Date.now() - t0, false);
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
        instructions: "업무 에이전트 중계 서버입니다. 공시·기업정보·법령·거래소 규정·회계기준·나라장터·네이버 뉴스·기상청 도구를 한 주소에서 제공합니다."
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
  const allowed = GATE_KEYS.length === 0 || (!!gk && GATE_KEYS.includes(gk));
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
