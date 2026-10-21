// 사용자별 사용 기록 — Upstash Redis(REST)에 날짜·사용자·도구별 카운터를 쌓는다.
// 질문 내용·조회 결과는 저장하지 않는다. 호출 수·실패 수·소요시간 합계만 남긴다.
//
// 키 구조 (날짜는 한국시간 기준 YYYY-MM-DD)
//   u:<날짜>:callers          SET   그날 호출한 사용자 식별자
//   u:<날짜>:<사용자>          HASH  <도구>=호출수, <도구>#err=실패수, <도구>#ms=소요시간 합계(ms),
//                              @page:<페이지 버전>=relay_call 호출수(v1 = 페이지 버전 표시 없는 옛 페이지)
// 모든 키는 마지막 기록 시점부터 RETENTION_DAYS 뒤 자동 삭제된다.

const RETENTION_DAYS = Number(process.env.USAGE_RETENTION_DAYS || 90);
const TTL = RETENTION_DAYS * 86400;
const WRITE_TIMEOUT_MS = 1500;

function conf() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

function kstDate(d) {
  return new Date((d ? d.getTime() : Date.now()) + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

async function pipeline(cmds, timeoutMs) {
  const c = conf();
  if (!c) throw new Error("사용 기록 저장소(KV_REST_API_URL·KV_REST_API_TOKEN)가 설정되지 않았습니다");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${c.url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmds),
      signal: ctl.signal
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`저장소 응답 HTTP ${r.status}`);
    return j.map(x => {
      if (x && x.error) throw new Error(x.error);
      return x ? x.result : null;
    });
  } finally {
    clearTimeout(timer);
  }
}

// 도구 호출 1건 기록. 실패해도 호출 자체에는 영향을 주지 않는다.
async function recordCall(caller, tool, ms, ok, page) {
  if (!conf()) return;
  const day = kstDate();
  const h = `u:${day}:${caller}`;
  const s = `u:${day}:callers`;
  const cmds = [
    ["SADD", s, caller],
    ["HINCRBY", h, tool, "1"],
    ["HINCRBY", h, `${tool}#ms`, String(Math.max(0, Math.round(ms)))],
    ["EXPIRE", s, String(TTL)],
    ["EXPIRE", h, String(TTL)]
  ];
  if (!ok) cmds.splice(3, 0, ["HINCRBY", h, `${tool}#err`, "1"]);
  if (page) cmds.splice(3, 0, ["HINCRBY", h, `@page:${String(page).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 20)}`, "1"]);
  try {
    await pipeline(cmds, WRITE_TIMEOUT_MS);
  } catch (e) {
    console.log(`[usage] 기록 실패: ${e.message}`);
  }
}

function dayRange(from, to) {
  const out = [];
  const start = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
  for (let d = start; d <= end && out.length <= RETENTION_DAYS + 1; d = new Date(d.getTime() + 86400000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// 기간 내 기록을 [{date, caller, tool, calls, errors, ms}] 행으로 돌려준다.
async function readUsage(from, to) {
  const days = dayRange(from, to);
  if (!days.length) return [];
  const callers = await pipeline(days.map(d => ["SMEMBERS", `u:${d}:callers`]), 10000);
  const pairs = [];
  days.forEach((d, i) => (callers[i] || []).forEach(c => pairs.push([d, c])));
  if (!pairs.length) return [];
  const hashes = await pipeline(pairs.map(([d, c]) => ["HGETALL", `u:${d}:${c}`]), 10000);
  const rows = [];
  pairs.forEach(([date, caller], i) => {
    const flat = hashes[i] || [];
    const m = {};
    for (let k = 0; k + 1 < flat.length; k += 2) m[flat[k]] = Number(flat[k + 1]) || 0;
    Object.keys(m).filter(k => !k.includes("#")).forEach(tool => {
      rows.push({ date, caller, tool, calls: m[tool], errors: m[`${tool}#err`] || 0, ms: m[`${tool}#ms`] || 0 });
    });
  });
  return rows;
}

module.exports = { recordCall, readUsage, kstDate, RETENTION_DAYS, configured: () => !!conf() };
