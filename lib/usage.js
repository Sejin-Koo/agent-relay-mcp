// 사용자별 사용 기록 — Upstash Redis(REST)에 날짜·사용자·도구별 카운터를 쌓는다.
// 질문 내용·조회 결과는 저장하지 않는다. 호출 수·실패 수·소요시간 합계만 남긴다.
//
// 키 구조 (날짜는 한국시간 기준 YYYY-MM-DD)
//   u:<날짜>:callers          SET   그날 호출한 사용자 식별자
//   u:<날짜>:<사용자>          HASH  <도구>=호출수, <도구>#err=실패수, <도구>#ms=소요시간 합계(ms),
//                              @page:<페이지 버전>=relay_call 호출수(v1 = 페이지 버전 표시 없는 옛 페이지)
//                              @agent:<에이전트 id>=그 에이전트 화면에서 한 호출수(#err·#ms 포함, 에이전트 간 통신은 받는 쪽),
//                              @at:<에이전트 id>|<도구>=에이전트×도구 호출수
//                              @q:<에이전트 id>=그 에이전트에 보낸 질문 수(페이지 17판부터, 질문 내용은 남기지 않음),
//                              @qm:<에이전트 id>|<fg|bg>=그중 화면 실행·클라우드 실행 수,
//                              @via:<묻는 에이전트 id>|<맡은 에이전트 id>=다른 에이전트(주로 통합 질문)가 맡겨서 한 조회 호출수(#err 포함).
//                              맡은 에이전트의 @agent·@at에도 똑같이 들어가므로 합계에 더하면 중복이다
// 모든 키는 마지막 기록 시점부터 RETENTION_DAYS 뒤 자동 삭제된다.
//   f:<날짜>                  LIST  실패한 호출의 상세(시각·사용자·에이전트·도구·소요·오류 문구·인자 요약 JSON), 하루 최대 FAIL_KEEP건.
//                              원인을 나중에 확인하려는 것이라 실패한 호출만 남기며, 인자는 값마다 잘라서 요약만 둔다.
//   iss:all                   SET   실패 원인(서명) 목록
//   iss:<서명>                HASH  원인 하나: tool·backend·err(대표 문구)·count(누적 실패)·first_at·last_at·last_args·last_caller·last_agent,
//                              status(open|pending|needs_user|watching|resolved|ignored)·closed_at·closed_count(닫을 때의 count)·note·link.
//                              서명 = 담당 서버|도구|오류 문구(접수번호·시각처럼 4자리 이상 숫자를 #으로 바꾼 것, HTTP 상태코드는 남김)의 해시. 열린 원인은 지워지지 않고,
//                              닫힌 원인은 닫은 뒤 RETENTION_DAYS 동안 재발하지 않으면 자동 삭제된다(재발하면 다시 무기한).
//   o:<날짜>                  HASH  <사용자>|<페이지 버전>=그날 페이지가 설정을 받아 간 횟수(relay_config, part 없음·catalog만 —
//                              지침·도구 목록 조각 요청은 세지 않음. 페이지를 열 때와 질문 전에 받으므로 '연 횟수'의 근사).
//                              질문하지 않고 열어만 본 사본도 남기려는 것(2026-11-06). 도구 호출이 아니라 사용량 합계에는 넣지 않는다.
//   o:last                    HASH  <사용자>|<페이지 버전>=그 판을 마지막으로 받아 간 시각(한국시간 YYYY-MM-DD HH:MM).
//                              같은 날 두 판을 열었을 때 어느 쪽이 나중인지 가리려는 것(2026-11-09). 쓸 때마다 보관 기간을 다시 건다.
//   user:names                HASH  <사용자 식별자>=한글 표시 이름 (자동 삭제 없음 — 사람이 직접 지울 때까지 남는다.
//                              저장소가 공개라서 이름은 코드가 아니라 여기에 둔다)
//   mon:last                  STRING 자동 점검 마지막 실행(JSON: 시각·시험 수·실패 수 등). 자동 삭제 없음

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
async function recordCall(caller, tool, ms, ok, page, agent) {
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
  const ag = agent ? String(agent).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) : "";
  if (ag) {
    cmds.splice(3, 0, ["HINCRBY", h, `@agent:${ag}`, "1"], ["HINCRBY", h, `@agent:${ag}#ms`, String(Math.max(0, Math.round(ms)))], ["HINCRBY", h, `@at:${ag}|${tool}`, "1"]);
    if (!ok) cmds.splice(3, 0, ["HINCRBY", h, `@agent:${ag}#err`, "1"]);
  }
  try {
    await pipeline(cmds, WRITE_TIMEOUT_MS);
  } catch (e) {
    console.log(`[usage] 기록 실패: ${e.message}`);
  }
}

// 질문 1건 기록(페이지가 질문을 보낼 때 relay_config part=q로 알림). 질문 내용은 받지도 남기지도 않는다.
function cleanId(x, n) { return String(x || "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, n || 40); }
async function recordQuestion(caller, agent, mode) {
  if (!conf()) return;
  const ag = cleanId(agent), md = mode === "bg" ? "bg" : "fg";
  if (!ag) return;
  const day = kstDate(), h = `u:${day}:${caller}`, s = `u:${day}:callers`;
  try {
    await pipeline([["SADD", s, caller], ["HINCRBY", h, `@q:${ag}`, "1"], ["HINCRBY", h, `@qm:${ag}|${md}`, "1"], ["EXPIRE", s, String(TTL)], ["EXPIRE", h, String(TTL)]], WRITE_TIMEOUT_MS);
  } catch (e) {
    console.log(`[usage] 질문 기록 실패: ${e.message}`);
  }
}
// 다른 에이전트가 맡겨서 한 조회 1건(경유 표시). 맡은 에이전트 몫은 recordCall이 따로 센다
async function recordVia(caller, via, agent, ok) {
  if (!conf()) return;
  const v = cleanId(via), ag = cleanId(agent) || "(미구분)";
  if (!v) return;
  const day = kstDate(), h = `u:${day}:${caller}`, s = `u:${day}:callers`;
  const cmds = [["SADD", s, caller], ["HINCRBY", h, `@via:${v}|${ag}`, "1"], ["EXPIRE", s, String(TTL)], ["EXPIRE", h, String(TTL)]];
  if (!ok) cmds.splice(2, 0, ["HINCRBY", h, `@via:${v}|${ag}#err`, "1"]);
  try { await pipeline(cmds, WRITE_TIMEOUT_MS); } catch (e) { console.log(`[usage] 경유 기록 실패: ${e.message}`); }
}

// 페이지가 설정을 받아 간 기록(사용자×페이지 버전×날짜). 실패해도 설정 응답에는 영향을 주지 않는다.
async function recordOpen(caller, page) {
  if (!conf()) return;
  const k = `o:${kstDate()}`;
  const pg = String(page || "v1").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 20) || "v1";
  const who = String(caller || "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "unknown";
  try {
    const at = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
    await pipeline([["HINCRBY", k, `${who}|${pg}`, "1"], ["EXPIRE", k, String(TTL)], ["HSET", "o:last", `${who}|${pg}`, at], ["EXPIRE", "o:last", String(TTL)]], WRITE_TIMEOUT_MS);
  } catch (e) {
    console.log(`[usage] 열기 기록 실패: ${e.message}`);
  }
}

// 기간 내 열기 기록을 [{date, caller, page, n, at}] 행으로 돌려준다. at = 그 판을 마지막으로 받아 간 시각(2026-11-09 이후 기록분만).
async function readOpens(from, to) {
  const days = dayRange(from, to);
  if (!days.length) return [];
  const hs = await pipeline(days.map(d => ["HGETALL", `o:${d}`]).concat([["HGETALL", "o:last"]]), 10000);
  const lastFlat = hs[days.length] || [], last = {};
  for (let k = 0; k + 1 < lastFlat.length; k += 2) last[String(lastFlat[k])] = String(lastFlat[k + 1]);
  const rows = [];
  days.forEach((date, i) => {
    const flat = hs[i] || [];
    for (let k = 0; k + 1 < flat.length; k += 2) {
      const f = String(flat[k]), j = f.lastIndexOf("|");
      rows.push({ date, caller: f.slice(0, j), page: f.slice(j + 1), n: Number(flat[k + 1]) || 0, at: last[f] || "" });
    }
  });
  return rows;
}

// 실패한 호출 1건의 상세. 서버 로그(Vercel)는 1시간만 남아서 나중에 원인을 보려면 여기 남겨야 한다.
const FAIL_KEEP = 500;
async function recordFailure(f) {
  if (!conf()) return;
  const k = `f:${kstDate()}`;
  const item = JSON.stringify(Object.assign({ at: new Date().toISOString() }, f));
  try {
    await pipeline([["LPUSH", k, item], ["LTRIM", k, "0", String(FAIL_KEEP - 1)], ["EXPIRE", k, String(TTL)]], WRITE_TIMEOUT_MS);
  } catch (e) {
    console.log(`[usage] 실패 상세 기록 실패: ${e.message}`);
  }
  // robots.txt로 수집을 막은 사이트는 정책대로 읽지 않는 정상 거부라 고칠 것이 없다 — 실패 상세에는 남기되 오류 원인 목록에는 올리지 않는다(2026-11-09 사용자 결정)
  if (isPolicyRefusal(f.err)) return;
  try {
    await bumpIssue(f);
  } catch (e) {
    console.log(`[usage] 실패 원인 기록 실패: ${e.message}`);
  }
}

// 정책상 정상 거부(robots.txt 차단). 주소마다 오류 문구가 달라 원인이 주소별로 따로 생기므로 문구 패턴으로 가른다
const POLICY_REFUSAL_RE = /robots\.txt로 (자동 )?수집을 막|robots\.txt로 막혀/;
function isPolicyRefusal(err) { return POLICY_REFUSAL_RE.test(String(err || "")); }

// ---- 실패 원인(묶음) ----
const crypto = require("crypto");
function normErr(err) {
  return String(err || "").replace(/\d{4,}/g, "#").replace(/\s+/g, " ").trim().slice(0, 160);
}
function issueSig(backend, tool, err) {
  return crypto.createHash("sha1").update(`${backend}|${tool}|${normErr(err)}`).digest("hex").slice(0, 12);
}
async function bumpIssue(f) {
  const sig = issueSig(f.backend, f.tool, f.err);
  const k = `iss:${sig}`;
  const now = new Date().toISOString();
  await pipeline([
    ["SADD", "iss:all", sig],
    ["HSETNX", k, "first_at", now],
    ["HSETNX", k, "status", "open"],
    ["HSET", k, "tool", f.tool, "backend", f.backend, "err", normErr(f.err), "last_at", now, "last_args", f.args || "", "last_caller", f.caller || "", "last_agent", f.agent || ""],
    ["HINCRBY", k, "count", "1"],
    ["PERSIST", k] // 열려 있거나 재발한 원인은 지우지 않는다
  ], WRITE_TIMEOUT_MS);
  return sig;
}

// 원인 전체를 읽어 상태를 계산해 돌려준다. 재발 = 닫힌 뒤 실패가 더 생긴 것.
async function readIssues() {
  const sigs = (await pipeline([["SMEMBERS", "iss:all"]], 10000))[0] || [];
  if (!sigs.length) return [];
  const hs = await pipeline(sigs.map(s => ["HGETALL", `iss:${s}`]), 10000);
  const out = [], gone = [];
  sigs.forEach((sig, i) => {
    const flat = hs[i] || [];
    if (!flat.length) { gone.push(sig); return; }
    const m = {};
    for (let k = 0; k + 1 < flat.length; k += 2) m[flat[k]] = flat[k + 1];
    const count = Number(m.count) || 0, closedCount = Number(m.closed_count) || 0;
    const closed = m.status === "resolved" || m.status === "ignored";
    const since = closed ? count - closedCount : count;
    // pending(수정 대기)·needs_user(직접 조치 필요)·watching(관찰 중)은 열린 상태의 세부 구분 — 자동 수정 작업이 붙인다
    const state = !closed ? (OPEN_SUBSTATES.includes(m.status) ? m.status : "open") : since > 0 ? "reopened" : m.status;
    out.push(Object.assign(m, { sig, count, open_count: closed ? since : count, state }));
  });
  if (gone.length) { try { await pipeline([["SREM", "iss:all", ...gone]], 5000); } catch (e) { /* 다음에 정리 */ } }
  return out;
}

const SIG_RE = /^[0-9a-f]{12}$/;
const OPEN_SUBSTATES = ["pending", "needs_user", "watching"];
// 원인을 닫거나(resolved·ignored) 다시 연다(open). 닫으면 그 시점 누적 건수를 기억하고 보존기간 뒤 자동 삭제되게 한다.
async function setIssueStatus(sig, status, note, link) {
  if (!SIG_RE.test(String(sig || ""))) throw new Error("sig는 12자리 원인 서명이어야 합니다(group_by=issues 결과의 서명)");
  if (!["resolved", "ignored", "open", ...OPEN_SUBSTATES].includes(status)) throw new Error("status는 resolved·ignored·open·pending·needs_user·watching 중 하나여야 합니다");
  const k = `iss:${sig}`;
  const r = await pipeline([["HGET", k, "count"]], 5000);
  if (r[0] === null || r[0] === undefined) throw new Error(`없는 원인입니다: ${sig}`);
  const clean = (t, n) => String(t || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
  if (status === "open") {
    await pipeline([["HSET", k, "status", "open"], ["HDEL", k, "closed_at", "closed_count"], ["PERSIST", k]], 5000);
  } else if (OPEN_SUBSTATES.includes(status)) {
    // 열린 상태 그대로 두되 무엇을 기다리는지(메모·PR 링크)를 붙인다. 자동 삭제하지 않는다
    await pipeline([
      ["HSET", k, "status", status, "note", clean(note, 300), "link", clean(link, 300), "marked_at", new Date().toISOString()],
      ["HDEL", k, "closed_at", "closed_count"], ["PERSIST", k]
    ], 5000);
  } else {
    await pipeline([
      ["HSET", k, "status", status, "closed_at", new Date().toISOString(), "closed_count", String(r[0]), "note", clean(note, 300), "link", clean(link, 300)],
      ["EXPIRE", k, String(TTL)]
    ], 5000);
  }
  return { sig, status };
}

// 기간 내 실패 상세를 시각 오름차순으로 돌려준다.
async function readFailures(from, to) {
  const days = dayRange(from, to);
  if (!days.length) return [];
  const lists = await pipeline(days.map(d => ["LRANGE", `f:${d}`, "0", "-1"]), 10000);
  const out = [];
  days.forEach((d, i) => (lists[i] || []).forEach(x => { try { out.push(Object.assign({ date: d }, JSON.parse(x))); } catch (e) { /* 깨진 항목은 건너뛴다 */ } }));
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
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

// ---- 웹 도구 서버(web-reader-mcp)의 경로별 사용 기록 읽기 — 같은 저장소의 wu: 키(그 서버 lib/usage.js recordPath가 씀)
// 행: {date, caller, channel(account|agent), item(tool.web_search·tavily.search 등), n, errors}
async function readWebPaths(from, to) {
  const days = dayRange(from, to);
  if (!days.length) return [];
  const callers = await pipeline(days.map(d => ["SMEMBERS", `wu:${d}:callers`]), 10000);
  const pairs = [];
  days.forEach((d, i) => (callers[i] || []).forEach(c => pairs.push([d, c])));
  if (!pairs.length) return [];
  const hashes = await pipeline(pairs.map(([d, c]) => ["HGETALL", `wu:${d}:${c}`]), 10000);
  const rows = [];
  pairs.forEach(([date, caller], i) => {
    const flat = hashes[i] || [], m = {};
    for (let k = 0; k + 1 < flat.length; k += 2) m[flat[k]] = Number(flat[k + 1]) || 0;
    Object.keys(m).filter(k => !k.includes("#")).forEach(f => {
      const j = f.indexOf("|");
      rows.push({ date, caller, channel: f.slice(0, j), item: f.slice(j + 1), n: m[f], errors: m[`${f}#err`] || 0 });
    });
  });
  return rows;
}

// ---- 사용자 표시 이름(식별자 → 한글 이름). 조회 실패는 이름 없이 진행한다.
const NAMES_KEY = "user:names";
const LABEL_RE = /^[A-Za-z0-9]{1,40}$/;

async function readNames() {
  try {
    const flat = (await pipeline([["HGETALL", NAMES_KEY]], 5000))[0] || [];
    const m = {};
    for (let k = 0; k + 1 < flat.length; k += 2) m[flat[k]] = String(flat[k + 1]);
    return m;
  } catch (e) {
    console.log(`[usage] 사용자 이름표 조회 실패: ${e.message}`);
    return {};
  }
}

function checkLabel(label) {
  if (!LABEL_RE.test(String(label || ""))) throw new Error("label은 게이트키 식별자(영문·숫자, 예: kangyunkyung)여야 합니다");
  return String(label);
}

async function setName(label, name) {
  const l = checkLabel(label);
  const n = String(name || "").trim();
  if (!n || n.length > 40 || /[\u0000-\u001f\u007f]/.test(n)) throw new Error("name은 1~40자의 한글 이름이어야 합니다");
  await pipeline([["HSET", NAMES_KEY, l, n]], 5000);
  return { label: l, name: n };
}

async function deleteName(label) {
  const l = checkLabel(label);
  const r = await pipeline([["HDEL", NAMES_KEY, l]], 5000);
  return { label: l, removed: Number(r[0]) || 0 };
}

// 자동 점검 마지막 실행(점검 저장소의 GitHub Actions가 매일 남김). 자동 삭제 없음 — 한 키만 덮어쓴다.
async function setMonitorBeat(o) {
  await pipeline([["SET", "mon:last", JSON.stringify(o)]], WRITE_TIMEOUT_MS * 2);
}
async function readMonitorBeat() {
  if (!conf()) return null;
  const v = (await pipeline([["GET", "mon:last"]], 5000))[0];
  try { return v ? JSON.parse(v) : null; } catch (e) { return null; }
}

module.exports = { isPolicyRefusal, setMonitorBeat, readMonitorBeat, readWebPaths, recordQuestion, recordVia, recordOpen, readOpens, recordFailure, readFailures, readIssues, setIssueStatus, issueSig, normErr, readNames, setName, deleteName, recordCall, readUsage, kstDate, pipeline, RETENTION_DAYS, configured: () => !!conf() };
