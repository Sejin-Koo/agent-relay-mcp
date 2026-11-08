// 에이전트 지침·도구 안내에 적힌 `도구(인자=값, …)` 표기의 인자 이름이 실제 담당 서버 스키마에 있는지 확인한다.
// 지침이 틀린 인자 이름을 가르치면 에이전트가 그대로 따라 해 입력 검증 오류가 난다(2026-11-07 실패 10건 계기).
//
// 쓰는 법:
//   node scripts/check-tool-args.js <도구 목록 JSON>     — relay_config {part:"tools"} 의 structuredContent 를 저장한 파일
//   RELAY_KEY=… RELAY_PAGE_KEY=… node scripts/check-tool-args.js   — 배포된 중계 서버에서 직접 받아 검사
// 어긋나면 종료코드 1. 도구 목록을 받지 못하면 검사를 건너뛰고 0(배포를 막지 않음).
const fs = require("fs");
const cat = require("../lib/agents.json");

async function loadTools() {
  const f = process.argv[2];
  if (f) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    return (j.result && j.result.structuredContent ? j.result.structuredContent : j).tools;
  }
  const key = process.env.RELAY_KEY, pk = process.env.RELAY_PAGE_KEY;
  if (!key || !pk) return null;
  const url = (process.env.RELAY_URL || "https://agent-relay-mcp.vercel.app/api/mcp") + "?k=" + key;
  const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "relay_config", arguments: { part: "tools", page: "check", pk } } };
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
  const t = await r.text();
  const line = t.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5)).pop() || t;
  const j = JSON.parse(line);
  return j.result && j.result.structuredContent ? j.result.structuredContent.tools : null;
}

// 검사할 글: 에이전트 지침·상세·소개, 도구 안내, 공통 규칙
function texts() {
  const out = [];
  const flat = (v) => Array.isArray(v) ? v.map(flat).join("\n") : (v && typeof v === "object") ? Object.values(v).map(flat).join("\n") : String(v == null ? "" : v);
  for (const a of cat.agents_v2 || []) for (const k of ["rules", "deep", "limits"]) if (a[k]) out.push([`${a.id}.${k}`, flat(a[k])]);
  for (const [k, v] of Object.entries(cat.tool_notes || {})) out.push([`tool_notes.${k}`, flat(v)]);
  if (cat.prompts_v2) for (const k of ["report", "base", "runner", "figure", "doc"]) if (cat.prompts_v2[k]) out.push([`prompts_v2.${k}`, flat(cat.prompts_v2[k])]);
  return out;
}

(async () => {
  let tools;
  try { tools = await loadTools(); } catch (e) { console.warn(`(건너뜀) 도구 목록을 받지 못함: ${e.message}`); process.exit(0); }
  if (!tools) { console.warn("(건너뜀) 도구 목록이 없어 지침 인자 검사를 하지 않음 — RELAY_KEY·RELAY_PAGE_KEY 또는 파일 경로 필요"); process.exit(0); }
  const schema = new Map(tools.map(t => [t.name, t.inputSchema || {}]));
  const errs = [];
  let checked = 0;
  for (const [where, txt] of texts()) {
    // 도구 이름 바로 뒤의 괄호만 본다: dart_get_document_text(mode=extract, keyword "…")
    const re = /\b([a-z][a-z0-9_]{2,})\(([^()]{0,200})\)/g;
    let m;
    while ((m = re.exec(txt))) {
      const tool = m[1];
      if (!schema.has(tool)) continue;
      const props = (schema.get(tool).properties) || {};
      // `이름=` 또는 `이름:` 꼴만 인자로 본다(맨 이름·값·한글 설명은 판단하지 않음)
      const re2 = /(?:^|[\s,(·/])([A-Za-z_][A-Za-z0-9_]*)\s*[=:]/g;
      let n;
      while ((n = re2.exec(m[2]))) {
        const arg = n[1];
        if (/^https?$/i.test(arg)) continue;
        checked++;
        if (!props[arg]) errs.push(`${where}: ${tool}(${arg}=…) — 이 도구에 없는 인자. 받는 인자: ${Object.keys(props).join(", ")}`);
      }
    }
  }
  if (errs.length) { console.error([...new Set(errs)].join("\n")); console.error(`지침 인자 검사 실패 ${new Set(errs).size}건`); process.exit(1); }
  console.log(`지침 인자 검사: 인자 표기 ${checked}곳 모두 담당 서버 스키마에 있음 (도구 ${schema.size}개 기준)`);
})();
