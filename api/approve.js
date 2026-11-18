// 개선 제안 승인 화면 — 결과 메일의 [승인]·[삭제]·[전체 승인] 링크가 여기로 온다(lib/proposals.js 참고).
// GET: 무엇을 바꾸는지 보여 주고 확인 단추만 둔다(메일 보안 검사기가 링크를 미리 열어도 바뀌지 않게).
// POST(단추): 상태를 바꾸고, 반영 시점과 '지금 실행' 경로를 안내한다.
const props = require("../lib/proposals");

const TASK_URL = process.env.TRIAGE_TASK_URL || "https://claude.ai/scheduled-task/trig_012cMCDLtRotVJZ5uisiWUTD";
const KIND_KO = { skill: "계정 스킬", agent: "에이전트 지침", server: "서버 코드", other: "기타" };
const STATE_KO = { pending: "결정 대기", approved: "승인됨(다음 실행이 반영)", carded: "승인됨 — 스킬 카드 대기", applied: "반영 끝", rejected: "삭제됨" };
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const kst = iso => { const d = new Date(new Date(iso).getTime() + 9 * 3600000); return isNaN(d) ? "" : d.toISOString().slice(0, 16).replace("T", " "); };

function page(title, body) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&display=swap">
<style>body{font-family:'Noto Sans KR',sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#1f2937;line-height:1.6}
h1{font-size:20px}.item{border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;margin:10px 0}.meta{color:#6b7280;font-size:13px}
.btn{display:inline-block;border:0;border-radius:6px;padding:10px 18px;font-size:15px;font-family:inherit;cursor:pointer;margin-right:8px;text-decoration:none}
.ok{background:#1d4ed8;color:#fff}.no{background:#e5e7eb;color:#111}.note{background:#f3f4f6;border-radius:8px;padding:12px 14px;margin-top:16px}
details pre{white-space:pre-wrap;font-size:13px;background:#f9fafb;padding:8px;border-radius:6px}</style></head><body>${body}</body></html>`;
}
function itemHtml(p) {
  return `<div class="item"><b>[${esc(KIND_KO[p.kind] || p.kind)}] ${esc(p.target)}</b> <span class="meta">— ${esc(STATE_KO[p.status] || p.status)}</span><br>${esc(p.summary)}
<div class="meta">처음 제안 ${esc(kst(p.first_at))} · 다시 확인 ${esc(p.seen)}회(마지막 ${esc(kst(p.last_at))})</div>
${p.detail ? `<details><summary class="meta">자세한 수정안</summary><pre>${esc(p.detail)}</pre></details>` : ""}</div>`;
}
const nextNote = () => `<div class="note">반영은 이 예약 작업이 합니다. 오늘 밤 22:00(평일) 정기 실행을 기다리지 않으려면 <a href="${esc(TASK_URL)}" target="_blank">예약 작업 화면</a>에서 <b>지금 실행</b>을 누르세요.<br>
계정 스킬은 실행이 스킬마다 수정 카드를 만들어 둡니다 — 같은 화면의 실행 기록을 열어 카드를 눌러야 반영됩니다(결과 메일에도 안내).</div>`;

async function targets(p) {
  if (Array.isArray(p.ids)) return (await Promise.all(p.ids.map(i => props.read(i)))).filter(Boolean);
  if (p.i === "all") return (await props.list("pending")).filter(x => !(new Date(x.first_at).getTime() > p.s));
  const one = await props.read(p.i);
  return one ? [one] : [];
}
function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise(resolve => { let s = ""; req.on("data", c => { s += c; }); req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(s)))); req.on("error", () => resolve({})); });
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  try {
    const q = new URL(req.url, "http://localhost").searchParams;
    const body = req.method === "POST" ? await readBody(req) : {};
    const token = (body && body.t) || q.get("t");
    const p = props.verify(token);
    const items = await targets(p);
    const label = p.a === "approve" ? (p.i === "all" ? "전체 승인" : "승인") : p.a === "reject" ? "삭제" : "승인 취소";
    if (!items.length) { res.statusCode = 200; return res.end(page("처리할 제안 없음", `<h1>처리할 제안이 없습니다</h1><p>이미 처리됐거나 삭제된 제안입니다.</p>`)); }
    if (req.method !== "POST") {
      const actionable = items.filter(x => (p.a === "approve" ? x.status === "pending" : p.a === "reject" ? ["pending", "approved"].includes(x.status) : x.status === "approved"));
      const form = actionable.length
        ? `<form method="post"><input type="hidden" name="t" value="${esc(token)}"><button class="btn ${p.a === "reject" ? "no" : "ok"}" type="submit">${esc(label)} ${actionable.length}건 확정</button></form>`
        : `<p>지금 상태에서는 ${esc(label)}할 것이 없습니다.</p>`;
      return res.end(page(label, `<h1>${esc(label)} 확인</h1>${items.map(itemHtml).join("")}${form}`));
    }
    const done = [];
    for (const x of items) {
      if (p.a === "approve" && x.status === "pending") done.push(await props.setStatus(x.id, "approved"));
      else if (p.a === "reject" && ["pending", "approved"].includes(x.status)) done.push(await props.setStatus(x.id, "rejected", "사용자가 메일 링크로 삭제"));
      else if (p.a === "undo" && x.status === "approved") done.push(await props.setStatus(x.id, "pending", "사용자가 승인 취소"));
    }
    const undo = p.a === "approve" && done.length
      ? `<form method="post"><input type="hidden" name="t" value="${esc(props.sign({ i: "list", ids: done.map(d => d.id), a: "undo", s: p.s, e: Date.now() + 86400000 }))}"><button class="btn no" type="submit">방금 승인 취소</button></form>` : "";
    const head = done.length ? `${esc(label)} ${done.length}건 완료` : `바뀐 것 없음(이미 처리된 상태)`;
    res.end(page(head, `<h1>${head}</h1>${done.map(itemHtml).join("")}${p.a === "approve" && done.length ? nextNote() : ""}${undo}`));
  } catch (e) {
    res.statusCode = 400;
    res.end(page("링크 오류", `<h1>열 수 없는 링크입니다</h1><p>${esc(e.message)}</p>`));
  }
};
