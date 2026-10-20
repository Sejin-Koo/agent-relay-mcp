// lib/agents.json(에이전트 설정)이 쓰는 도구가 모두 lib/backends.js 허용 목록에 있는지 확인한다.
// push 전에 node scripts/check-catalog.js 로 돌린다. 어긋나면 종료코드 1.
const { ROUTE } = require("../lib/backends");
const LOCAL = new Set([require("../lib/dcf").TOOL.name]); // 중계 서버 자체 도구
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
  names.forEach(n => { if (!ROUTE[n] && !LOCAL.has(n)) errs.push(`${a.id}: 중계 서버 허용 목록에 없는 도구 ${n}`); });
}
for (const k of ["single", "composite", "doc_on", "doc_off"]) if (cat.prompts && cat.prompts[k] && !Array.isArray(cat.prompts[k])) errs.push(`prompts.${k}는 줄 배열이어야 함`);
for (const [k, v] of Object.entries(cat.icons || {})) if (!/^\s*<svg[\s>]/i.test(v) || v.length > 8000) errs.push(`icons.${k}: <svg>로 시작하는 8000자 이내 SVG여야 함`);
if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
console.log(`catalog ${cat.version}: 에이전트 ${cat.agents.length}개, 도구 참조 모두 허용 목록 안`);
