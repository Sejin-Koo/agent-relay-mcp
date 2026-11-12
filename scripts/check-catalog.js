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
    if (a.hub !== undefined && typeof a.hub !== "boolean") e2.push(`${a.id}: hub는 true|false`);
    if (a.consultable !== undefined && typeof a.consultable !== "boolean") e2.push(`${a.id}: consultable은 true|false`);
    if (a.hub === true && a.consultable !== false) e2.push(`${a.id}: 통합 에이전트(hub)는 consultable false여야 함(다른 에이전트가 되묻는 고리 방지)`);
  }
  if (cat.prompts_v2 && cat.prompts_v2.report && !Array.isArray(cat.prompts_v2.report)) e2.push("prompts_v2.report는 문장 배열");
  const P2 = cat.prompts_v2 || {};
  if (P2.figure && !(Array.isArray(P2.figure) && P2.figure.every(x => typeof x === "string"))) e2.push("prompts_v2.figure는 문장 배열");
  if (P2.runner) {
    for (const k of ["main", "consult", "doc", "trigger_prompt"]) if (!(Array.isArray(P2.runner[k]) && P2.runner[k].length && P2.runner[k].every(x => typeof x === "string"))) e2.push(`prompts_v2.runner.${k}는 문장 배열`);
    if (P2.runner.main && !P2.runner.main.join("\n").includes("{{job}}")) e2.push("prompts_v2.runner.main에 {{job}} 자리표시자가 없음");
    if (P2.runner.main && !P2.runner.main.some(x => x.includes("{{url_hint}}"))) e2.push("prompts_v2.runner.main에 {{url_hint}} 자리표시자가 없음");
    // 초안 에이전트를 클라우드에서 실행할 때 지침에 넣는 줄(페이지 18판, 없으면 페이지 기본 문구)
    if (P2.runner.draft !== undefined && !(Array.isArray(P2.runner.draft) && P2.runner.draft.length && P2.runner.draft.every(x => typeof x === "string"))) e2.push("prompts_v2.runner.draft는 문장 배열");
  }
  if (cat.features && cat.features.background && !(P2.runner && Array.isArray(P2.runner.main))) e2.push("features.background가 켜져 있는데 prompts_v2.runner가 없음");
  // 다음 질문 예약·답변 중 새 대화(페이지 10판)
  if (cat.features) {
    for (const k of ["queue", "bg_detach"]) if (cat.features[k] !== undefined && typeof cat.features[k] !== "boolean") e2.push(`features.${k}는 true|false`);
    for (const k of ["att_guide", "att_carry_ask"]) if (cat.features[k] !== undefined && typeof cat.features[k] !== "boolean") e2.push(`features.${k}는 true|false`);
    const amf = cat.features.att_max_files, amm = cat.features.att_max_mb;
    if (amf !== undefined && !(Number.isInteger(amf) && amf >= 1 && amf <= 1000)) e2.push("features.att_max_files는 1~1000 정수");
    if (amm !== undefined && !(Number.isInteger(amm) && amm >= 1 && amm <= 200)) e2.push("features.att_max_mb는 1~200 정수");
    const qm = cat.features.queue_max;
    if (qm !== undefined && !(Number.isInteger(qm) && qm >= 1 && qm <= 10)) e2.push("features.queue_max는 1~10 정수");
    // 통합 에이전트(페이지 16판부터): 작업 배정 칸 켜기, 동시에 진행하는 묻기 수, assign_agents 한 번에 맡기는 수
    if (cat.features.hub_panel !== undefined && typeof cat.features.hub_panel !== "boolean") e2.push("features.hub_panel은 true|false");
    const hp = cat.features.hub_parallel, hm = cat.features.hub_max;
    if (hp !== undefined && !(Number.isInteger(hp) && hp >= 1 && hp <= 8)) e2.push("features.hub_parallel은 1~8 정수");
    if (hm !== undefined && !(Number.isInteger(hm) && hm >= 1 && hm <= 10)) e2.push("features.hub_max는 1~10 정수");
    // 이전 대화 목록 접기(페이지 15판부터): 켜기·처음 상태(true면 접힌 채로 시작)
    // 받지 못한 파일 보관(페이지 19판부터): 켜기·받으면 지우기
    for (const k of ["hist_fold", "hist_fold_default", "bg_draft", "file_keep", "file_keep_drop_on_get"]) if (cat.features[k] !== undefined && typeof cat.features[k] !== "boolean") e2.push(`features.${k}는 true/false`);
    // 숫자 설정(페이지 14판부터, 페이지 applyNumbers와 같은 범위 — 벗어나면 페이지가 기본값을 쓴다)
    const NUMS = { hist_days: [7, 365], hist_list: [20, 300], hist_board_show: [1, 30], past_scan: [5, 100], past_read: [2000, 60000], convo_in_max: [20000, 400000], ctx_turns: [2, 40], ctx_last_max: [2000, 60000], ctx_prev_max: [500, 20000], draft_days: [1, 365], file_keep_days: [1, 90], file_keep_max: [1, 30] };
    for (const [k, [lo, hi]] of Object.entries(NUMS)) { const v = cat.features[k]; if (v !== undefined && !(typeof v === "number" && v >= lo && v <= hi)) e2.push(`features.${k}는 ${lo}~${hi} 숫자(벗어나면 페이지가 기본값을 씀)`); }
  }
  if (cat.features && cat.features.background) for (const k of ["bg_stale_min", "bg_start_min", "bg_keep_days"]) if (!(Number(cat.features[k]) > 0)) e2.push(`features.${k}는 양수`);
  if (P2.convo) {
    for (const k of ["plan", "section"]) if (P2.convo[k] !== undefined && !(Array.isArray(P2.convo[k]) && P2.convo[k].length && P2.convo[k].every(x => typeof x === "string"))) e2.push(`prompts_v2.convo.${k}는 문장 배열`);
    if (P2.convo.sources !== undefined && !["auto", "list", "line", "none"].includes(P2.convo.sources)) e2.push("prompts_v2.convo.sources는 auto·list·line·none 중 하나");
    if (Array.isArray(P2.convo.section) && !P2.convo.section.join("\n").includes("{{h}}")) e2.push("prompts_v2.convo.section에 {{h}}(절 제목) 자리표시자가 없음");
  }
  // 지침 문구(prompts_v2.base)·페이지 자체 도구 설명(prompts_v2.tool_docs), 페이지 14판부터. 페이지 BASE_DEF·TDS와 같은 기준
  if (P2.base !== undefined) {
    if (!P2.base || typeof P2.base !== "object" || Array.isArray(P2.base)) e2.push("prompts_v2.base는 객체");
    else {
      const KNOWN = ["system", "consult_target", "no_rules", "ack", "consult_q", "tool_head", "tool_head_bg", "tool_group", "attach_none", "attach", "attach_more", "notes_head", "doc", "doc_off", "cont", "hist_clip", "hist_skip", "hist_clip_fg", "hist_skip_fg"];
      const FLAGS = ["bg", "by", "consult", "find", "past", "prev", "dl", "att", "folder", "notes", "draft"];
      for (const [k, v] of Object.entries(P2.base)) {
        if (!KNOWN.includes(k)) e2.push(`prompts_v2.base.${k}: 페이지가 쓰지 않는 키`);
        if (!(typeof v === "string" || (Array.isArray(v) && v.every(x => typeof x === "string")))) { e2.push(`prompts_v2.base.${k}는 글 또는 줄 배열`); continue; }
        (Array.isArray(v) ? v : [v]).forEach(l => {
          let m, t = l;
          while ((m = t.match(/^\[(!?)([a-z_]+)\]/))) { if (!FLAGS.includes(m[2])) e2.push(`prompts_v2.base.${k}: 모르는 조건 [${m[1]}${m[2]}] — 페이지는 그 줄을 빼 버림`); t = t.slice(m[0].length); }
        });
      }
      if (P2.base.system !== undefined) {
        const sysT = Array.isArray(P2.base.system) ? P2.base.system.join("\n") : String(P2.base.system);
        for (const ph of ["{{tool_docs}}", "{{agent_rules}}"]) if (!sysT.includes(ph)) e2.push(`prompts_v2.base.system에 ${ph} 자리표시자가 없음`);
      }
    }
  }
  // 다른 에이전트의 질문에 답할 때도 지킬 공통 줄(2026-11-04): [답변 구성](report)은 그때 빠지므로, 웹 검색·근거 확인 줄을
  // base.system에 "[by]" 사본으로 둔다(페이지 14판부터). by_shared는 사본을 둔 report 줄 번호 — report를 고치면 사본도 같이 고친다
  if (P2.by_shared !== undefined) {
    if (!Array.isArray(P2.by_shared) || !P2.by_shared.every(i => Number.isInteger(i) && Array.isArray(P2.report) && P2.report[i] !== undefined)) e2.push("prompts_v2.by_shared는 prompts_v2.report 줄 번호 배열");
    else {
      const sysL = P2.base && Array.isArray(P2.base.system) ? P2.base.system : [];
      P2.by_shared.forEach(i => { if (!sysL.includes("[by]" + P2.report[i])) e2.push(`prompts_v2.report[${i}]와 prompts_v2.base.system의 [by] 사본이 다름 — 둘을 같이 고치거나 by_shared 번호를 맞출 것`); });
    }
  }
  if (P2.tool_docs !== undefined) {
    if (!P2.tool_docs || typeof P2.tool_docs !== "object" || Array.isArray(P2.tool_docs)) e2.push("prompts_v2.tool_docs는 객체");
    else for (const [k, v] of Object.entries(P2.tool_docs)) if (typeof v !== "string" || !v.trim()) e2.push(`prompts_v2.tool_docs.${k}는 빈 글이 아닌 글`);
  }
  // 화면 문구 바꾸기(ui_v2.text, 페이지 14판부터): {"원래 문구": "새 문구"}. 페이지 applyTextMap과 같은 기준
  const utx = cat.ui_v2 && cat.ui_v2.text;
  if (utx !== undefined) {
    if (!utx || typeof utx !== "object" || Array.isArray(utx)) e2.push("ui_v2.text는 {\"원래 문구\": \"새 문구\"} 객체");
    else {
      const ks = Object.keys(utx);
      if (ks.length > 2000) e2.push("ui_v2.text는 2,000개 이내");
      const keys = new Set(ks.map(k => k.trim()));
      ks.forEach(k => {
        const v = utx[k], w = `ui_v2.text["${k.slice(0, 30)}"]`;
        if (!k.trim() || k.length > 2000 || typeof v !== "string" || v.length > 2000) e2.push(`${w}: 원래 문구와 새 문구는 2,000자 이내 글`);
        else if (v && v !== k && keys.has(v.trim())) e2.push(`${w}: 새 문구가 다른 원래 문구와 같아 페이지가 적용하지 않음(되풀이 방지)`);
      });
    }
  }
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
