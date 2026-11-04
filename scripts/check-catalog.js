// lib/agents.json(에이전트 설정)이 쓰는 도구가 모두 lib/backends.js 허용 목록에 있는지 확인한다.
// push 전에 node scripts/check-catalog.js 로 돌린다. 어긋나면 종료코드 1.
const { ROUTE } = require("../lib/backends");
const cat = require("../lib/agents.json");
const errs = [];
const ids = new Set();
const SAFE_ID = /^[a-z0-9_-]{1,40}$/, COLOR = /^#[0-9a-fA-F]{3,8}$/;
const BUILTIN_ICONS = ["weather", "naver", "dart", "law", "rfp", "bid", "award", "company", "legal"];
for (const a of cat.agents) {
  if (!a.id || !a.name) errs.push(`id·name 누락: ${JSON.stringify(a).slice(0, 60)}`);
  if (a.id && !SAFE_ID.test(a.id)) errs.push(`${a.id}: id는 영문 소문자·숫자·-·_만 (40자 이내)`);
  const ik = a.icon || a.id;
  if (!(cat.icons && cat.icons[ik]) && !BUILTIN_ICONS.includes(ik)) console.warn(`(참고) ${a.id}: 아이콘 '${ik}'이 icons에 없어 기본 문서 아이콘으로 나옴`);
  if (a.color) for (const k of ["hue", "tint", "hue_dark", "tint_dark"]) if (a.color[k] && !COLOR.test(a.color[k])) errs.push(`${a.id}: color.${k}는 #RRGGBB 형식`);
  if (ids.has(a.id)) errs.push(`id 중복: ${a.id}`);
  ids.add(a.id);
  if (!cat.groups.some(g => g.id === a.group)) errs.push(`${a.id}: 없는 group ${a.group}`);
  const names = [];
  if (a.use) {
    for (const k of Object.keys(a.use)) {
      const S = cat.servers[k];
      if (!S) { errs.push(`${a.id}: servers에 없는 묶음 ${k}`); continue; }
      for (const t of a.use[k]) { names.push(t); if (!S.tools[t]) errs.push(`${a.id}: servers.${k}에 설명 없는 도구 ${t}`); }
    }
  } else if (Array.isArray(a.tools)) {
    a.tools.forEach(t => names.push(t.name));
  } else errs.push(`${a.id}: tools·use 둘 다 없음`);
  names.forEach(n => { if (!ROUTE[n]) errs.push(`${a.id}: 중계 서버 허용 목록에 없는 도구 ${n}`); });
}
for (const k of ["single", "composite", "doc_on", "doc_off"]) if (cat.prompts && cat.prompts[k] && !Array.isArray(cat.prompts[k])) errs.push(`prompts.${k}는 줄 배열이어야 함`);
for (const [k, v] of Object.entries(cat.icons || {})) if (!/^\s*<svg[\s>]/i.test(v) || v.length > 8000) errs.push(`icons.${k}: <svg>로 시작하는 8000자 이내 SVG여야 함`);
if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
console.log(`catalog ${cat.version}: 에이전트 ${cat.agents.length}개, 도구 참조 모두 허용 목록 안`);

// ---------- 새 페이지(v2) 설정 검사 ----------
if (cat.agents_v2) {
  const e2 = [];
  const gids = new Set((cat.groups_v2 || []).map(g => g.id));
  const v2ids = new Set();
  const src = cat.sources || {};
  (cat.sections_v2 || []).forEach(s => (s.groups || []).forEach(g => { if (!gids.has(g)) e2.push(`sections_v2.${s.id}: 없는 그룹 ${g}`); }));
  const FMT = ["docx", "pptx", "pdf", "xlsx", "hwpx", "html"], KINDS = ["doc", "sheet", "slide", "image", "zip"];
  for (const a of cat.agents_v2) {
    if (!a.id || !SAFE_ID.test(a.id)) e2.push(`agents_v2: 잘못된 id ${a.id}`);
    if (v2ids.has(a.id)) e2.push(`agents_v2: id 중복 ${a.id}`);
    v2ids.add(a.id);
    if (!gids.has(a.group)) e2.push(`${a.id}: groups_v2에 없는 group ${a.group}`);
    if (!["live", "soon", "demo"].includes(a.status || "live")) e2.push(`${a.id}: status는 live|soon|demo`);
    (a.src || []).forEach(k => { if (!src[k]) e2.push(`${a.id}: sources에 없는 출처 키 ${k}`); });
    if (a.color) for (const k of ["hue", "tint", "hue_dark", "tint_dark"]) if (a.color[k] && !COLOR.test(a.color[k])) e2.push(`${a.id}: color.${k} 형식`);
    (a.out || []).forEach(f => { if (!FMT.includes(f)) e2.push(`${a.id}: out 형식 ${f}`); });
    if (a.attach && a.attach.types) a.attach.types.forEach(t => { if (!KINDS.includes(t)) e2.push(`${a.id}: attach.types ${t}`); });
    const use = a.use || {};
    let n = 0;
    for (const k of Object.keys(use)) for (const t of use[k]) {
      n++;
      if (!ROUTE[t]) e2.push(`${a.id}: 허용 목록에 없는 도구 ${t}`);
      else if (ROUTE[t] !== k) e2.push(`${a.id}: 도구 ${t}는 묶음 ${ROUTE[t]} 소속인데 ${k}에 적힘`);
    }
    if (a.status === "soon" && !n) e2.push(`${a.id}: 준비 중 에이전트에 도구가 비어 있음`);
    if ((a.status || "live") === "live" && !n && a.attach === false) e2.push(`${a.id}: 도구도 첨부도 없음`);
    if ((a.status || "live") !== "soon" && typeof a.rules !== "string") e2.push(`${a.id}: rules 없음`);
    if (a.tier && !["quick", "default", "complex"].includes(a.tier)) e2.push(`${a.id}: tier는 quick|default|complex`);
    const OUTL = (cat.prompts_v2 && cat.prompts_v2.outlines) || {};
    (a.outlines || []).forEach(t => { if (!OUTL[t]) e2.push(`${a.id}: prompts_v2.outlines에 없는 골격 ${t}`); });
    if (a.rules && /\bMCP\b|plk_|vercel/i.test(a.rules)) e2.push(`${a.id}: 규칙에 내부 서버·키 표기`);
  }
  if (cat.prompts_v2 && cat.prompts_v2.report && !Array.isArray(cat.prompts_v2.report)) e2.push("prompts_v2.report는 문장 배열");
  const P2 = cat.prompts_v2 || {};
  if (P2.figure && !(Array.isArray(P2.figure) && P2.figure.every(x => typeof x === "string"))) e2.push("prompts_v2.figure는 문장 배열");
  if (P2.runner) {
    for (const k of ["main", "consult", "doc", "trigger_prompt"]) if (!(Array.isArray(P2.runner[k]) && P2.runner[k].length && P2.runner[k].every(x => typeof x === "string"))) e2.push(`prompts_v2.runner.${k}는 문장 배열`);
    if (P2.runner.main && !P2.runner.main.join("\n").includes("{{job}}")) e2.push("prompts_v2.runner.main에 {{job}} 자리표시자가 없음");
    if (P2.runner.main && !P2.runner.main.some(x => x.includes("{{url_hint}}"))) e2.push("prompts_v2.runner.main에 {{url_hint}} 자리표시자가 없음");
  }
  if (cat.features && cat.features.background && !(P2.runner && Array.isArray(P2.runner.main))) e2.push("features.background가 켜져 있는데 prompts_v2.runner가 없음");
  // 다음 질문 예약·답변 중 새 대화(페이지 10판)
  if (cat.features) {
    for (const k of ["queue", "bg_detach"]) if (cat.features[k] !== undefined && typeof cat.features[k] !== "boolean") e2.push(`features.${k}는 true|false`);
    const qm = cat.features.queue_max;
    if (qm !== undefined && !(Number.isInteger(qm) && qm >= 1 && qm <= 10)) e2.push("features.queue_max는 1~10 정수");
  }
  if (cat.features && cat.features.background) for (const k of ["bg_stale_min", "bg_start_min", "bg_keep_days"]) if (!(Number(cat.features[k]) > 0)) e2.push(`features.${k}는 양수`);
  if (P2.doc) for (const k of ["rules", "pptx", "other", "tail"]) if (P2.doc[k] && !(Array.isArray(P2.doc[k]) && P2.doc[k].every(x => typeof x === "string"))) e2.push(`prompts_v2.doc.${k}는 문장 배열`);
  if (cat.models !== undefined) {
    if (!Array.isArray(cat.models) || !cat.models.length) e2.push("models는 비어 있지 않은 배열");
    else cat.models.forEach((m, i) => {
      if (!m || !/^[a-z0-9.\-]{3,60}$/.test(String(m.id || ""))) e2.push(`models[${i}].id 형식(Claude API 모델 id)`);
      if (["quick", "default", "complex"].indexOf(m && m.tier) < 0) e2.push(`models[${i}].tier는 quick|default|complex`);
      if (!m || !String(m.label || "").trim()) e2.push(`models[${i}].label 없음`);
    });
  }
  if (cat.doc_style) {
    const ds = cat.doc_style, HEXC = /^([0-9A-Fa-f]{6}|auto)$/;
    Object.entries(ds.colors || {}).forEach(([k, v]) => { if (!HEXC.test(String(v))) e2.push(`doc_style.colors.${k} 형식(6자리 색)`); });
    ((ds.chart || {}).colors || []).forEach((v, i) => { if (!/^[0-9A-Fa-f]{6}$/.test(String(v))) e2.push(`doc_style.chart.colors[${i}] 형식`); });
    const walk = (o, path) => Object.entries(o || {}).forEach(([k, v]) => { if (typeof v === "number" && (!isFinite(v) || v < 0 || v > 100000)) e2.push(`doc_style.${path}${k} 범위`); else if (v && typeof v === "object" && !Array.isArray(v)) walk(v, path + k + "."); });
    walk(ds, "");
  }
  for (const a of cat.agents_v2) {
    (a.consult || []).forEach(id => { if (!v2ids.has(id)) e2.push(`${a.id}: consult 대상 없음 ${id}`); });
    (a.pro || []).forEach(p => { if (p.via && !v2ids.has(p.via)) e2.push(`${a.id}: pro.via 대상 없음 ${p.via}`); });
    const links = String(a.rules || "").match(/agent:([a-z0-9_-]+)/g) || [];
    links.forEach(l => { if (!v2ids.has(l.slice(6))) e2.push(`${a.id}: 규칙 속 agent: 링크 대상 없음 ${l}`); });
  }
  const day = /^\d{4}-\d{2}-\d{2}$/;
  (cat.notices || []).forEach((n, i) => {
    if (!n.title) e2.push(`notices[${i}]: title 없음`);
    if (n.from && !day.test(n.from)) e2.push(`notices[${i}]: from은 YYYY-MM-DD`);
    if (n.to && !day.test(n.to)) e2.push(`notices[${i}]: to는 YYYY-MM-DD`);
    if (n.from && n.to && n.from > n.to) e2.push(`notices[${i}]: 기간이 거꾸로(${n.from} > ${n.to})`);
    if (n.level && !["안내", "주의", "장애"].includes(n.level)) e2.push(`notices[${i}]: level은 안내|주의|장애`);
    if (n.page_min !== undefined && !/^\d+(\.\d+)*$/.test(String(n.page_min))) e2.push(`notices[${i}]: page_min은 숫자 버전(예: "4")`);
    (n.agents || []).forEach(id => { if (!v2ids.has(id)) e2.push(`notices[${i}]: 없는 에이전트 ${id}`); });
  });
  if (cat.legacy_until && !day.test(cat.legacy_until)) e2.push("legacy_until은 YYYY-MM-DD");
  // 화면 모양 규칙(ui_v2.css, 페이지 8판부터): CSS 글 또는 줄 배열, 60,000자 이내. 바깥 자원을 부르는 구문과 역슬래시는 금지
  // (페이지 applyServerCss와 같은 기준 — 페이지는 이런 구문이 있으면 통째로 적용하지 않는다)
  const ucss = cat.ui_v2 && cat.ui_v2.css;
  if (ucss !== undefined) {
    const ok = typeof ucss === "string" || (Array.isArray(ucss) && ucss.every(x => typeof x === "string"));
    if (!ok) e2.push("ui_v2.css는 CSS 글 또는 줄 배열");
    else {
      const t = Array.isArray(ucss) ? ucss.join("\n") : ucss;
      if (t.length > 60000) e2.push("ui_v2.css는 60,000자 이내");
      if (/url\s*\(|image-set\s*\(|image\s*\(|src\s*\(|@import|@font-face|expression\s*\(|javascript:|behavior\s*:|-moz-binding|\\/i.test(t.replace(/\/\*[\s\S]*?\*\//g, "")))
        e2.push("ui_v2.css에 허용하지 않는 구문(url( · image-set( · @import · @font-face · 역슬래시 등) — 페이지가 통째로 적용하지 않음");
      const open = (t.match(/\{/g) || []).length, close = (t.match(/\}/g) || []).length;
      if (open !== close) e2.push(`ui_v2.css 중괄호 짝이 맞지 않음({ ${open}개, } ${close}개)`);
    }
  }
  // 서버 단추(ui_v2.buttons, 페이지 9판부터): 기본 단추의 이름·숨기기·위치, 새 단추(정해진 동작 중 하나). 페이지 applyButtons와 같은 기준
  const ub = cat.ui_v2 && cat.ui_v2.buttons;
  if (ub !== undefined) {
    const BUILTIN = { hist_top: "top", notice: "top", jobs: "top", setup: "top", back: "pane", agent_hist: "pane", agent_info: "pane", new_chat: "pane" };
    const ACTIONS = ["history_all", "history", "notices", "jobs", "setup", "home", "agent", "new_chat", "agent_info", "group", "link"];
    const gids2 = new Set((cat.groups_v2 || []).map(g => g.id));
    if (!Array.isArray(ub)) e2.push("ui_v2.buttons는 배열");
    else {
      if (ub.length > 40) e2.push("ui_v2.buttons는 40개 이내");
      const slotOf = {}, seen = new Set();
      ub.forEach(b => { if (b && b.id) slotOf[b.id] = BUILTIN[b.id] || b.slot; });
      ub.forEach((b, i) => {
        const w = `ui_v2.buttons[${i}]${b && b.id ? "(" + b.id + ")" : ""}`;
        if (!b || typeof b !== "object" || !SAFE_ID.test(String(b.id || ""))) { e2.push(`${w}: id는 영문 소문자·숫자·-·_`); return; }
        if (seen.has(b.id)) e2.push(`${w}: id 중복`); seen.add(b.id);
        if (b.label !== undefined && !(typeof b.label === "string" && b.label.trim() && b.label.length <= 24)) e2.push(`${w}: label은 24자 이내 글`);
        if (b.hidden !== undefined && typeof b.hidden !== "boolean") e2.push(`${w}: hidden은 true|false`);
        if (!BUILTIN[b.id]) {
          if (!["top", "pane", "home"].includes(b.slot)) e2.push(`${w}: 새 단추의 slot은 top|pane|home`);
          if (!ACTIONS.includes(b.action)) e2.push(`${w}: action은 ${ACTIONS.join("|")} 중 하나`);
          if (!b.label) e2.push(`${w}: 새 단추에는 label 필요`);
          if (b.action === "agent" && !v2ids.has(b.agent)) e2.push(`${w}: agent 대상 없음 ${b.agent}`);
          if (b.action === "group" && !gids2.has(b.group)) e2.push(`${w}: group 대상 없음 ${b.group}`);
          if (b.action === "link" && !/^https:\/\/[^\s"'<>]+$/.test(String(b.url || ""))) e2.push(`${w}: url은 https 주소`);
          if (b.q !== undefined && !(typeof b.q === "string" && b.q.length <= 2000)) e2.push(`${w}: q는 2000자 이내 글`);
          (b.agents || []).forEach(id => { if (!v2ids.has(id)) e2.push(`${w}: agents에 없는 에이전트 ${id}`); });
          if (b.agents && b.slot !== "pane") e2.push(`${w}: agents(에이전트별 표시)는 slot pane에서만`);
        } else if (b.slot || b.action) e2.push(`${w}: 기본 단추는 slot·action을 바꿀 수 없음(label·hidden·before·after만)`);
        const ref = b.before || b.after;
        if (b.before && b.after) e2.push(`${w}: before와 after는 하나만`);
        if (ref) {
          if (!slotOf[ref] && !BUILTIN[ref]) e2.push(`${w}: 위치 기준 단추 없음 ${ref}`);
          else if ((slotOf[ref] || BUILTIN[ref]) !== slotOf[b.id]) e2.push(`${w}: 위치 기준 ${ref}가 다른 자리(slot)에 있음`);
        }
      });
    }
  }
  if (e2.length) { console.error(e2.join("\n")); process.exit(1); }
  console.log(`새 페이지 설정: 에이전트 ${cat.agents_v2.length}개, 출처 ${Object.keys(src).length}개, 공지 ${(cat.notices || []).length}건 검사 통과`);
}

// 파일 변환기 사본(lib/filebuilder/)이 계정 스킬 원본에서 복사한 그대로인지 — 사본을 직접 고치면 실패
{
  const r = require("child_process").spawnSync(process.execPath, [require("path").join(__dirname, "sync-filebuilder.js"), "--check"], { encoding: "utf8" });
  process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
  if (r.status !== 0) process.exit(1);
}
