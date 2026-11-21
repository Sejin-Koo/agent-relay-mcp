// 대화 옮기기(페이지 24.2판, 2026-11-21 사용자 결정)
// 옛 사본의 '최신판 확인' 창에서 '대화 옮기고 새 사본 만들기'를 누르면, 페이지가 대화 보관함(내보내기와 같은 JSON)을 조각으로 올린다.
// 같은 사람(같은 커넥터 키)의 새 사본이 처음 열릴 때 받아 보관함에 넣고 mv_done으로 지운다.
// - 중계 서버의 '질문 내용 저장 안 함' 원칙의 예외다. 그래서 ① 서버 키로 암호화(AES-256-GCM)해 두고 ② 같은 키(사람)만 받으며
//   ③ 받으면 바로 지우고 ④ 받지 않아도 24시간(features.mv_hours) 뒤 저절로 지워진다.
// - 서버 관리자는 원리상 내용을 볼 수 있다(사용자에게 코드 입력을 요구하지 않는 대가 — 사용자 결정 '1번').
// - 한 사람에 옮기는 묶음은 하나만 둔다. 새로 올리면 앞 묶음은 지운다.

const crypto = require("crypto");
const CATALOG = require("./agents.json");

const PART_MAX = 150000;      // 조각 하나의 글자 수(한글이 많아도 저장소 요청 한도 1MB 안쪽 — 암호화·base64 뒤 약 0.6MB)
const MAX_PARTS = 200;        // 최대 3,000만 자
const feat = () => (CATALOG.features && typeof CATALOG.features === "object" ? CATALOG.features : {});
const ttl = () => { const h = Number(feat().mv_hours); return Math.round((h >= 1 && h <= 72 ? h : 24) * 3600); };

const TOOLS = [
  {
    name: "mv_put",
    description: "업무 에이전트 페이지 전용: 새 사본으로 옮길 대화 보관함(JSON 글)을 조각으로 올린다. 마지막에 commit: true와 count로 마무리한다.",
    inputSchema: { type: "object", properties: {
      tid: { type: "string", description: "옮기기 묶음 id(24자리 16진수)" },
      part: { type: "integer", minimum: 0 }, total: { type: "integer", minimum: 1 },
      data: { type: "string" },
      commit: { type: "boolean" }, count: { type: "integer", minimum: 0 }, from: { type: "string" }
    }, required: ["tid"], additionalProperties: false }
  },
  {
    name: "mv_get",
    description: "업무 에이전트 페이지 전용: 이 사람이 올려 둔 옮기기 묶음을 확인한다(part 없이 부르면 묶음 정보, tid·part를 주면 그 조각).",
    inputSchema: { type: "object", properties: { tid: { type: "string" }, part: { type: "integer", minimum: 0 } }, additionalProperties: false }
  },
  {
    name: "mv_done",
    description: "업무 에이전트 페이지 전용: 받은 옮기기 묶음(또는 버릴 묶음)을 지운다.",
    inputSchema: { type: "object", properties: { tid: { type: "string" } }, required: ["tid"], additionalProperties: false }
  }
];
const NAMES = TOOLS.map(t => t.name);

function kv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}
async function pipeline(cmds) {
  const c = kv();
  if (!c) throw new Error("저장소가 설정되지 않았습니다");
  const r = await fetch(`${c.url}/pipeline`, { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error(`저장소 응답 HTTP ${r.status}`);
  const j = await r.json();
  return j.map(x => { if (x && x.error) throw new Error(x.error); return x ? x.result : null; });
}

// 암호화 키: 환경변수 MOVE_KEY가 있으면 그것, 없으면 저장소 토큰에서 끌어낸다(저장소 내용만 새어 나가도 읽히지 않게)
function key() {
  const base = process.env.MOVE_KEY || ("agent-move|" + (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || ""));
  return crypto.createHash("sha256").update(base).digest();
}
function seal(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(Buffer.from(text, "utf8")), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
function open(b64) {
  const buf = Buffer.from(b64, "base64"), iv = buf.subarray(0, 12), tag = buf.subarray(12, 28);
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

const who = (caller) => String(caller || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
const okTid = (t) => /^[0-9a-f]{24}$/.test(String(t || ""));
const kMeta = (u) => `mv:${u}:m`;
const kPart = (u, tid, i) => `mv:${u}:${tid}:${i}`;

async function readMeta(u) {
  const [m] = await pipeline([["GET", kMeta(u)]]);
  if (!m) return null;
  try { return JSON.parse(m); } catch (e) { return null; }
}
async function dropParts(u, tid, total) {
  const n = Math.min(MAX_PARTS, Math.max(0, Number(total) || MAX_PARTS));
  const cmds = [];
  for (let i = 0; i < n; i++) cmds.push(["DEL", kPart(u, tid, i)]);
  for (let i = 0; i < cmds.length; i += 50) await pipeline(cmds.slice(i, i + 50));
}

async function mvPut(a, u) {
  const tid = String(a.tid || "");
  if (!okTid(tid)) throw new Error("tid가 올바르지 않습니다");
  const ex = ttl(), m = await readMeta(u);
  if (a.commit) {
    const total = Number(a.total);
    if (!m || m.tid !== tid || !Number.isInteger(total) || total < 1 || total > MAX_PARTS) throw new Error("올린 조각 정보가 맞지 않습니다");
    const keys = []; for (let i = 0; i < total; i++) keys.push(["EXISTS", kPart(u, tid, i)]);
    const have = []; for (let i = 0; i < keys.length; i += 50) have.push(...await pipeline(keys.slice(i, i + 50)));
    const miss = have.map((x, i) => (Number(x) ? -1 : i)).filter(i => i >= 0);
    if (miss.length) throw new Error(`빠진 조각이 있습니다: ${miss.slice(0, 10).join(", ")}`);
    const meta = { tid, st: "ok", total, count: Math.max(0, Number(a.count) || 0), from: String(a.from || "").slice(0, 20), at: Date.now(), exp: Date.now() + ex * 1000 };
    await pipeline([["SET", kMeta(u), JSON.stringify(meta), "EX", String(ex)]]);
    return { ok: true, tid, st: "ok", total: meta.total, count: meta.count, hours: Math.round(ex / 3600) };
  }
  const part = Number(a.part), total = Number(a.total), data = String(a.data || "");
  if (!Number.isInteger(part) || part < 0 || !Number.isInteger(total) || total < 1 || total > MAX_PARTS || part >= total) throw new Error("part·total이 올바르지 않습니다");
  if (!data || data.length > PART_MAX) throw new Error(`data는 ${PART_MAX}자 이하여야 합니다`);
  const cmds = [];
  // 새 묶음의 첫 조각이면 앞 묶음을 지우고 '올리는 중'으로 표시한다(새 사본이 먼저 열려도 기다리게)
  if (!m || m.tid !== tid) {
    if (m && m.tid && okTid(m.tid)) await dropParts(u, m.tid, m.total);
    cmds.push(["SET", kMeta(u), JSON.stringify({ tid, st: "up", total, at: Date.now(), exp: Date.now() + ex * 1000 }), "EX", String(ex)]);
  }
  cmds.push(["SET", kPart(u, tid, part), seal(data), "EX", String(ex)]);
  await pipeline(cmds);
  return { ok: true, tid, part, size: data.length };
}

async function mvGet(a, u) {
  const m = await readMeta(u);
  if (a.part === undefined || a.part === null) {
    if (!m) return { found: false };
    return { found: true, tid: m.tid, st: m.st, total: m.total, count: m.count || 0, from: m.from || "", at: m.at, exp: m.exp };
  }
  const tid = String(a.tid || ""), part = Number(a.part);
  if (!okTid(tid) || !Number.isInteger(part) || part < 0 || part >= MAX_PARTS) throw new Error("tid·part가 올바르지 않습니다");
  if (!m || m.tid !== tid) throw new Error("옮기기 묶음이 없거나 보관 시간이 지났습니다");
  const [v] = await pipeline([["GET", kPart(u, tid, part)]]);
  if (v == null) throw new Error("조각이 없거나 보관 시간이 지났습니다");
  return { tid, part, data: open(v) };
}

async function mvDone(a, u) {
  const tid = String(a.tid || "");
  if (!okTid(tid)) throw new Error("tid가 올바르지 않습니다");
  const m = await readMeta(u);
  if (m && m.tid === tid) {
    await dropParts(u, tid, m.total);
    await pipeline([["DEL", kMeta(u)]]);
    return { ok: true, removed: true };
  }
  return { ok: true, removed: false };
}

async function call(name, args, caller) {
  const u = who(caller);
  if (!u) throw new Error("사람별 키로 부른 경우에만 쓸 수 있습니다");
  const a = args || {};
  const sc = name === "mv_put" ? await mvPut(a, u) : name === "mv_get" ? await mvGet(a, u) : name === "mv_done" ? await mvDone(a, u) : null;
  if (!sc) throw new Error(`알 수 없는 도구: ${name}`);
  // 대화 내용은 응답 글(content)에 싣지 않는다(실패 기록·로그에 남지 않게) — 페이지는 structuredContent만 읽는다
  const txt = name === "mv_get" && sc.data !== undefined ? `조각 ${sc.part} 보냄` : JSON.stringify(Object.assign({}, sc, { data: undefined })).slice(0, 300);
  return { content: [{ type: "text", text: txt }], structuredContent: sc };
}

module.exports = { TOOLS, NAMES, call, _test: { seal, open, PART_MAX } };
