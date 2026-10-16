// 업무 에이전트 중계 MCP 서버.
// 여러 자체 MCP 서버를 주소 하나로 묶는다. 요청을 받아 도구 이름으로 담당 서버를 찾고 그대로 넘긴다.
// SDK 없이 JSON-RPC를 직접 구현했으므로 규격상 필요한 세 가지를 직접 처리한다:
//   ① initialize 버전 협상(지원 목록과 대조) ② 미지원 MCP-Protocol-Version 헤더에 400 ③ 알림에 202

const { BACKENDS, ROUTE } = require("../lib/backends");

const SERVER_INFO = { name: "agent-relay-mcp", version: "1.0.0" };
// @modelcontextprotocol/sdk 1.32.1 의 SUPPORTED_PROTOCOL_VERSIONS 와 같은 값으로 맞춘다
const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const LATEST = SUPPORTED[0];

const GATE_KEYS = (process.env.MCP_GATE_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
const GATE_MODE = (process.env.MCP_GATE_MODE || "observe").trim().toLowerCase();

const LIST_TTL_MS = 10 * 60 * 1000;   // 백엔드 도구 정의 캐시
const CALL_TIMEOUT_MS = 280 * 1000;   // vercel.json maxDuration(300초)보다 짧게
const LIST_TIMEOUT_MS = 20 * 1000;

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

async function listTools() {
  const ids = Object.keys(BACKENDS);
  const parts = await Promise.all(ids.map(backendTools));
  return [].concat(...parts);
}

// ---------- tools/call: 담당 서버로 그대로 넘긴다 ----------
async function callTool(params, caller) {
  const name = params && params.name;
  const id = ROUTE[name];
  if (!id) {
    return { error: { code: -32602, message: `이 서버에서 쓸 수 없는 도구입니다: ${name}` } };
  }
  const b = BACKENDS[id];
  const t0 = Date.now();
  try {
    const msg = await rpcToBackend(b, "tools/call", { name, arguments: (params && params.arguments) || {} }, CALL_TIMEOUT_MS);
    console.log(`[call] caller=${caller} tool=${name} backend=${id} ms=${Date.now() - t0} ok=${!msg.error && !(msg.result && msg.result.isError)}`);
    if (msg.error) return { error: msg.error };
    return { result: msg.result };
  } catch (e) {
    console.log(`[call] caller=${caller} tool=${name} backend=${id} ms=${Date.now() - t0} fail=${e.message}`);
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
      return reply({ result: { tools: await listTools() } });
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

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(m => handleMessage(m, caller)))).filter(Boolean);
    if (!out.length) { res.statusCode = 202; res.end(); return; }
    sendJson(res, 200, out);
    return;
  }
  const out = await handleMessage(body, caller);
  if (!out) { res.statusCode = 202; res.end(); return; }
  sendJson(res, 200, out);
};
