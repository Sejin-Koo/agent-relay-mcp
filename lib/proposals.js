// 개선 제안 보관·승인 — 평일 밤 '개선 목록 자동 처리' 작업이 스킬·에이전트 지침 수정 제안을 쌓고, 사용자가 메일의 링크로 승인한다
// (2026-11-17 사용자 결정: 출장 등으로 바로 승인하지 못해도 제안이 중복되지 않게 한곳에 누적하고, 마지막 메일만 보면 되게 한다).
//
// 저장(usage.js와 같은 Redis):
//   prop:all          SET   제안 id 목록
//   prop:<id>         HASH  kind(skill|agent|server|other)·target·key·summary·detail·status·first_at·last_at·seen·decided_at·applied_at·note·link
//                     status: pending(결정 대기) → approved(승인, 다음 실행이 반영) → carded(스킬 카드를 만들어 둠, 사용자가 카드를 눌러야 반영)
//                             → applied(반영 끝) / rejected(삭제). 끝난 상태(applied·rejected)는 그때부터 보존기간 뒤 자동 삭제, 나머지는 무기한.
// 링크: /api/approve?t=<서명 값> — 서명 값에 id(또는 all)·동작·만든 시각·만료(30일)를 담고 APPROVE_SECRET로 HMAC 서명한다.
//   링크를 열면 확인 화면만 뜨고, 화면의 단추(POST)를 눌러야 바뀐다 — 메일 보안 검사기가 링크를 미리 열어도 승인되지 않게.
const crypto = require("crypto");
const usage = require("./usage");

const LINK_DAYS = 30;
const BASE = process.env.RELAY_PUBLIC_URL || "https://agent-relay-mcp.vercel.app";
const KINDS = ["skill", "agent", "server", "other"];
const STATES = ["pending", "approved", "carded", "applied", "rejected"];
const OPEN = ["pending", "approved", "carded"];
const TTL = usage.RETENTION_DAYS * 86400;
const clean = (t, n) => String(t == null ? "" : t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, n);

function secret() {
  const s = process.env.APPROVE_SECRET || "";
  if (s.length < 16) throw new Error("APPROVE_SECRET(16자 이상)이 설정되지 않았습니다");
  return s;
}
const b64u = b => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = b64u(crypto.createHmac("sha256", secret()).update(body).digest()).slice(0, 32);
  return `${body}.${mac}`;
}
function verify(token) {
  const [body, mac] = String(token || "").split(".");
  if (!body || !mac) throw new Error("링크가 올바르지 않습니다");
  const want = b64u(crypto.createHmac("sha256", secret()).update(body).digest()).slice(0, 32);
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) throw new Error("링크가 올바르지 않습니다");
  const p = JSON.parse(unb64u(body).toString("utf8"));
  if (!(p.e > Date.now())) throw new Error("링크 유효 기간(30일)이 지났습니다 — 가장 최근 메일의 링크를 쓰세요");
  return p;
}
function link(id, action, issuedAt) {
  return `${BASE}/api/approve?t=${sign({ i: id, a: action, s: issuedAt || Date.now(), e: Date.now() + LINK_DAYS * 86400000 })}`;
}

const idOf = (kind, target, key) => crypto.createHash("sha1").update(`${kind}|${target}|${key}`).digest("hex").slice(0, 10);

async function read(id) {
  const r = await usage.pipeline([["HGETALL", `prop:${id}`]], 8000);
  const flat = r[0] || [];
  if (!flat.length) return null;
  const m = { id };
  for (let k = 0; k + 1 < flat.length; k += 2) m[flat[k]] = flat[k + 1];
  m.seen = Number(m.seen) || 1;
  return m;
}

// 제안 등록 — 같은 kind·target·key면 새로 만들지 않고 '다시 확인됨'(last_at·seen)만 올린다. 요지·자세한 내용을 주면 최신으로 바꾼다.
async function upsert(a) {
  const kind = KINDS.includes(a.kind) ? a.kind : "other";
  const target = clean(a.target, 120), key = clean(a.key, 120);
  if (!target || !key) throw new Error("propose에는 target(대상)·key(같은 제안을 가리키는 짧은 이름)가 필요합니다");
  const id = a.id && /^[0-9a-f]{10}$/.test(a.id) ? a.id : idOf(kind, target, key);
  const now = new Date().toISOString();
  const old = await read(id);
  if (old && (old.status === "applied" || old.status === "rejected")) {
    // 끝난 제안이 또 나오면: 삭제한 것은 다시 올리지 않고(사용자 결정 존중), 반영한 것은 새 제안으로 다시 연다
    if (old.status === "rejected") return { id, created: false, status: "rejected", skipped: "사용자가 삭제한 제안이라 다시 올리지 않음" };
  }
  const cmds = [["SADD", "prop:all", id]];
  if (!old || old.status === "applied") {
    cmds.push(["DEL", `prop:${id}`]);
    cmds.push(["HSET", `prop:${id}`, "kind", kind, "target", target, "key", key, "summary", clean(a.summary, 300), "detail", clean(a.detail, 6000),
      "status", "pending", "first_at", now, "last_at", now, "seen", "1"]);
  } else {
    const set = ["last_at", now];
    if (a.summary) set.push("summary", clean(a.summary, 300));
    if (a.detail) set.push("detail", clean(a.detail, 6000));
    cmds.push(["HSET", `prop:${id}`, ...set], ["HINCRBY", `prop:${id}`, "seen", "1"]);
  }
  cmds.push(["PERSIST", `prop:${id}`]);
  await usage.pipeline(cmds, 8000);
  return { id, created: !old || old.status === "applied", status: old && old.status !== "applied" ? old.status : "pending" };
}

async function list(filter) {
  const ids = (await usage.pipeline([["SMEMBERS", "prop:all"]], 8000))[0] || [];
  if (!ids.length) return [];
  const hs = await usage.pipeline(ids.map(i => ["HGETALL", `prop:${i}`]), 10000);
  const out = [], gone = [];
  ids.forEach((id, n) => {
    const flat = hs[n] || [];
    if (!flat.length) { gone.push(id); return; }
    const m = { id };
    for (let k = 0; k + 1 < flat.length; k += 2) m[flat[k]] = flat[k + 1];
    m.seen = Number(m.seen) || 1;
    out.push(m);
  });
  if (gone.length) { try { await usage.pipeline([["SREM", "prop:all", ...gone]], 5000); } catch (e) { /* 다음에 정리 */ } }
  const want = filter === "all" ? STATES : filter === "open" || !filter ? OPEN : String(filter).split(",");
  return out.filter(p => want.includes(p.status)).sort((x, y) => (x.first_at < y.first_at ? -1 : 1));
}

async function setStatus(id, status, note, lnk) {
  if (!/^[0-9a-f]{10}$/.test(String(id || ""))) throw new Error("id는 10자리 제안 번호여야 합니다");
  if (!STATES.includes(status)) throw new Error(`status는 ${STATES.join("·")} 중 하나여야 합니다`);
  const old = await read(id);
  if (!old) throw new Error(`없는 제안입니다: ${id}`);
  const now = new Date().toISOString();
  const set = ["status", status];
  if (note !== undefined) set.push("note", clean(note, 400));
  if (lnk !== undefined) set.push("link", clean(lnk, 300));
  if (status === "approved" || status === "rejected") set.push("decided_at", now);
  if (status === "applied") set.push("applied_at", now);
  const cmds = [["HSET", `prop:${id}`, ...set]];
  cmds.push(status === "applied" || status === "rejected" ? ["EXPIRE", `prop:${id}`, String(TTL)] : ["PERSIST", `prop:${id}`]);
  await usage.pipeline(cmds, 8000);
  return Object.assign(old, { status });
}

// 메일에 넣을 링크를 붙여 돌려준다
function withLinks(items) {
  const issued = Date.now();
  return {
    items: items.map(p => Object.assign({}, p, p.status === "pending" ? { approve_url: link(p.id, "approve", issued), reject_url: link(p.id, "reject", issued) } : {})),
    approve_all_url: items.some(p => p.status === "pending") ? link("all", "approve", issued) : ""
  };
}

module.exports = { upsert, list, setStatus, withLinks, verify, sign, link, read, OPEN, STATES, KINDS };
