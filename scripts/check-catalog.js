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
    (n.agents || []).forEach(id => { if (!v2ids.has(id)) e2.push(`notices[${i}]: 없는 에이전트 ${id}`); });
  });
  if (cat.legacy_until && !day.test(cat.legacy_until)) e2.push("legacy_until은 YYYY-MM-DD");
  if (e2.length) { console.error(e2.join("\n")); process.exit(1); }
  console.log(`새 페이지 설정: 에이전트 ${cat.agents_v2.length}개, 출처 ${Object.keys(src).length}개, 공지 ${(cat.notices || []).length}건 검사 통과`);
}
