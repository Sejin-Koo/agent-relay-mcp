// 매일 20:00(한국시간) 자동 점검(비공개 저장소 agent-relay-monitor의 daily-check)을 바로 시작시킨다.
// GitHub 예약 실행(schedule)은 4~8시간씩 밀려 20:00 점검이 다음 날 새벽 4시대에 돌았다(2026-11-18~20 실측) —
// 그래서 22:00 개선 목록 자동 처리가 그날 점검 결과를 못 봤다. Vercel 예약 실행(vercel.json crons, UTC 11:00)이
// 이 주소를 부르면 GitHub API workflow_dispatch로 바로 시작한다(2026-11-20 사용자 결정).
//   토큰: 환경변수 MONITOR_DISPATCH_TOKEN — fine-grained 토큰, 대상 저장소 agent-relay-monitor 하나, 권한 Actions 읽기·쓰기만.
//   CRON_SECRET이 있으면 Vercel이 보내는 Authorization: Bearer <값>만 받는다. 없어도 하루 한 번만 시작되도록
//   Redis 표시(mon:dispatch, 6시간)로 막는다 — 남이 주소를 불러도 점검이 한 번 더 도는 것이 전부다.
//   결과는 mon:dispatch:last(JSON)에 남긴다. 점검 저장소의 GitHub 예약 실행은 예비로 남고, 14시간 안에 이 실행이 있었으면 스스로 건너뛴다.
const usage = require("../lib/usage");

const REPO = process.env.MONITOR_REPO || "Sejin-Koo/agent-relay-monitor";
const WORKFLOW = process.env.MONITOR_WORKFLOW || "daily-check.yml";
const LOCK_SEC = 6 * 3600; // 수동 시험(낮)이 그날 20:00 실행을 막지 않게 6시간
const kst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");

async function note(o) {
  try { await usage.pipeline([["SET", "mon:dispatch:last", JSON.stringify(Object.assign({ at: kst() }, o)), "EX", String(90 * 86400)]], 2000); } catch (e) { /* 기록 실패는 무시 */ }
}

module.exports = async (req, res) => {
  const send = (code, o) => { res.statusCode = code; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(o)); };
  const secret = process.env.CRON_SECRET;
  if (secret && String(req.headers["authorization"] || "") !== `Bearer ${secret}`) return send(401, { ok: false, reason: "unauthorized" });
  const token = process.env.MONITOR_DISPATCH_TOKEN;
  if (!token) { await note({ ok: false, reason: "MONITOR_DISPATCH_TOKEN 없음" }); return send(200, { ok: false, reason: "MONITOR_DISPATCH_TOKEN 환경변수가 없습니다" }); }
  if (usage.configured()) {
    try {
      const got = (await usage.pipeline([["SET", "mon:dispatch", kst(), "NX", "EX", String(LOCK_SEC)]], 2000))[0];
      if (got !== "OK") return send(200, { ok: true, skipped: "최근 6시간 안에 이미 시작함" });
    } catch (e) { /* 저장소가 안 되면 막지 않고 진행 */ }
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "agent-relay-mcp", "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main" })
    });
    const ok = r.status === 204;
    const reason = ok ? null : `GitHub HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`;
    if (!ok && usage.configured()) { try { await usage.pipeline([["DEL", "mon:dispatch"]], 2000); } catch (e) {} }
    await note({ ok, reason });
    console.log(`[dispatch] ${REPO} ${WORKFLOW} ok=${ok}${reason ? " " + reason : ""}`);
    return send(200, { ok, reason });
  } catch (e) {
    if (usage.configured()) { try { await usage.pipeline([["DEL", "mon:dispatch"]], 2000); } catch (x) {} }
    await note({ ok: false, reason: e.message });
    return send(200, { ok: false, reason: e.message });
  }
};
