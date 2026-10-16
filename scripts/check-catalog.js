// lib/agents.json(에이전트 설정)이 쓰는 도구가 모두 lib/backends.js 허용 목록에 있는지 확인한다.
// push 전에 node scripts/check-catalog.js 로 돌린다. 어긋나면 종료코드 1.
const { ROUTE } = require("../lib/backends");
const cat = require("../lib/agents.json");
const errs = [];
const ids = new Set();
for (const a of cat.agents) {
  if (!a.id || !a.name) errs.push(`id·name 누락: ${JSON.stringify(a).slice(0, 60)}`);
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
if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
console.log(`catalog ${cat.version}: 에이전트 ${cat.agents.length}개, 도구 참조 모두 허용 목록 안`);
