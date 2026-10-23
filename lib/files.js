// 파일 만들기 — 업무 에이전트 페이지가 원고(마크다운)를 보내면 이 서버가 파일을 만들어 돌려준다.
// 페이지는 파일 형식별 변환 코드를 갖지 않아도 되고, 시트 구성·서식·수식·차트는 이 서버만 고쳐서 바꾼다.
// - 어떤 형식을 서버가 만들지는 설정 features.server_files(형식 목록)로 정한다. 목록 밖 형식은 unsupported를
//   돌려주고, 페이지는 자기 변환 코드로 만든다(대체 경로).
// - 결과가 크면 조각으로 나눠 잠시(10분) 저장소에 두고 file_chunk로 이어 받게 한다. 마지막 조각을 받으면 지운다.
//   원고와 파일 내용은 그 밖에는 저장하지 않는다.

const crypto = require("crypto");
const CATALOG = require("./agents.json");
// 변환 라이브러리는 파일을 만들 때만 불러온다(다른 도구 호출의 시작 시간을 늘리지 않게)
const lazy = () => ({ marked: require("marked").marked, DocExport: require("./docexport"), buildGenericWorkbook: require("./xlsx-generic").buildGenericWorkbook, buildValuationWorkbook: require("./xlsx-valuation").buildValuationWorkbook });

const MIME = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  hwpx: "application/hwp+zip",
  pdf: "application/pdf"
};
const TTL_SEC = 600;

const feat = () => (CATALOG.features && typeof CATALOG.features === "object" ? CATALOG.features : {});
const supported = () => (Array.isArray(feat().server_files) ? feat().server_files : []).filter(f => MIME[f]);
const inlineMax = () => { const n = Number(feat().file_inline_max); return isFinite(n) && n >= 4000 ? Math.min(n, 4000000) : 24000; };

const TOOLS = [
  {
    name: "build_file",
    description: "업무 에이전트 페이지 전용: 문서 원고(마크다운)로 파일을 만들어 base64로 돌려준다. 크면 id·chunks를 돌려주고 file_chunk로 이어 받는다. 서버가 만들지 않는 형식이면 unsupported를 돌려준다.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["xlsx", "docx", "pptx", "hwpx", "pdf"] },
        markdown: { type: "string", description: "문서 원고(마크다운)" },
        meta: { type: "object", description: "subtitle·header·fallbackTitle·agent·date·brand·dept·estimate" },
        figures: { type: "array", items: {}, description: "원고의 그림 블록 순서대로 페이지가 그린 PNG {data(base64), w, h} 또는 null" }
      },
      required: ["format", "markdown"],
      additionalProperties: false
    }
  },
  {
    name: "file_chunk",
    description: "업무 에이전트 페이지 전용: build_file이 나눠 둔 파일 조각을 받는다.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, index: { type: "integer", minimum: 0 } }, required: ["id", "index"], additionalProperties: false }
  }
];
const NAMES = TOOLS.map(t => t.name);

// ---------- 임시 저장소(조각) ----------
function kv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}
async function pipeline(cmds) {
  const c = kv();
  if (!c) throw new Error("파일 조각 저장소가 설정되지 않았습니다");
  const r = await fetch(`${c.url}/pipeline`, { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error(`조각 저장소 응답 HTTP ${r.status}`);
  const j = await r.json();
  return j.map(x => { if (x && x.error) throw new Error(x.error); return x ? x.result : null; });
}

// ---------- 원고 → 파일 ----------
const VAL_RE = /```valuation-model\s*\n([\s\S]*?)```/;

async function buildXlsx(md, meta) {
  const { marked, DocExport, buildGenericWorkbook, buildValuationWorkbook } = lazy();
  const warnings = [];
  const st = CATALOG.doc_style && typeof CATALOG.doc_style === "object" ? CATALOG.doc_style : null;
  DocExport.setStyle(st);
  const style = DocExport.getStyle();
  const m = String(md).match(VAL_RE);
  if (m) {
    let spec = null;
    try { spec = JSON.parse(m[1]); } catch (e) { warnings.push("가치평가 모델 블록의 JSON을 읽지 못해 표만 시트로 만들었습니다: " + e.message); }
    if (spec) {
      try {
        const r = await buildValuationWorkbook(spec, { font: style.font, confidential: style.elements && style.elements.confidential, brand: meta.brand, agent: meta.agent, date: meta.date, dept: meta.dept });
        // 모델이 계산한 핵심 값(억원)을 알려 답변 숫자와 다르면 에이전트가 사용자에게 밝히게 한다
        const e = (v) => (typeof v === "number" && isFinite(v)) ? Math.round(v / 100).toLocaleString("en-US") : "n/a";
        r.summary.forEach(x => warnings.push(`Excel 모델 계산값(억원) ${x.name}: DCF ${e(x.dcf.lo)}~${e(x.dcf.hi)}(중앙 ${e(x.dcf.mid)}), 상대가치 종합 ${e(x.comp.mid)}, 적정가치 ${e(x.fair.lo)}~${e(x.fair.hi)}(중앙 ${e(x.fair.mid)})` + (x.market ? `, 시가총액 ${e(x.market.mid)}` : "")));
        return { buffer: r.buffer, title: r.title, kind: "valuation", warnings };
      } catch (e) {
        if (e.code !== "bad_model") throw e;
        warnings.push(e.message + " — 표만 시트로 만들었습니다.");
      }
    }
  }
  const model = DocExport.mdToModel(String(md).replace(VAL_RE, ""), s => marked.lexer(s), {
    subtitle: meta.subtitle || "", header: meta.header || "", fallbackTitle: meta.fallbackTitle || "에이전트 답변"
  });
  const buffer = await buildGenericWorkbook(model, DocExport, style, meta);
  return { buffer, title: model.title, kind: "tables", warnings };
}

async function buildFile(args) {
  const fmt = String(args.format || "").toLowerCase();
  const md = String(args.markdown || "");
  const meta = args.meta && typeof args.meta === "object" ? args.meta : {};
  if (!supported().includes(fmt)) {
    return { structuredContent: { ok: false, unsupported: true, format: fmt, message: `서버에서 만들지 않는 형식입니다: ${fmt}` } };
  }
  if (!md.trim()) throw new Error("markdown이 비어 있습니다");
  let r;
  if (fmt === "xlsx") r = await buildXlsx(md, meta);
  else return { structuredContent: { ok: false, unsupported: true, format: fmt, message: `준비 중인 형식입니다: ${fmt}` } };
  const b64 = r.buffer.toString("base64");
  const base = { ok: true, format: fmt, mime: MIME[fmt], title: r.title, kind: r.kind, size: r.buffer.length, warnings: r.warnings };
  const max = inlineMax();
  if (b64.length <= max) return { structuredContent: Object.assign(base, { inline: b64 }) };
  const id = crypto.randomBytes(12).toString("hex");
  const n = Math.ceil(b64.length / max);
  const cmds = [];
  for (let i = 0; i < n; i++) cmds.push(["SET", `f:${id}:${i}`, b64.slice(i * max, (i + 1) * max), "EX", String(TTL_SEC)]);
  for (let i = 0; i < cmds.length; i += 20) await pipeline(cmds.slice(i, i + 20));
  return { structuredContent: Object.assign(base, { id, chunks: n }) };
}

async function fileChunk(args) {
  const id = String(args.id || "");
  const i = Number(args.index);
  if (!/^[0-9a-f]{24}$/.test(id) || !Number.isInteger(i) || i < 0) throw new Error("id·index가 올바르지 않습니다");
  const [data] = await pipeline([["GET", `f:${id}:${i}`]]);
  if (data == null) throw new Error("파일 조각이 없거나 보관 시간(10분)이 지났습니다. 파일을 다시 만들어 주세요.");
  // 받은 조각은 바로 지운다
  pipeline([["DEL", `f:${id}:${i}`]]).catch(() => {});
  return { structuredContent: { id, index: i, data } };
}

async function call(name, args) {
  const res = name === "build_file" ? await buildFile(args || {}) : name === "file_chunk" ? await fileChunk(args || {}) : null;
  if (!res) throw new Error(`알 수 없는 도구: ${name}`);
  const sc = res.structuredContent;
  const txt = sc.inline ? `파일 ${sc.format} ${sc.size}바이트(본문 생략)` : sc.data ? `조각 ${sc.index}` : JSON.stringify(sc).slice(0, 400);
  return { content: [{ type: "text", text: txt }], structuredContent: sc };
}

module.exports = { TOOLS, NAMES, call, _test: { buildXlsx, buildFile } };
