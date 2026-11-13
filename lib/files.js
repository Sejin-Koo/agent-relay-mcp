// 파일 만들기 — 업무 에이전트 페이지가 원고(마크다운)를 보내면 이 서버가 파일을 만들어 돌려준다.
// 페이지는 파일 형식별 변환 코드를 갖지 않아도 된다. 변환기 원본은 계정 스킬 sys-file-builder이고 이 서버는 사본(lib/filebuilder/)을 쓴다.
// - 어떤 형식을 서버가 만들지는 설정 features.server_files(형식 목록)로 정한다. 목록 밖 형식은 unsupported를
//   돌려주고, 페이지는 자기 변환 코드로 만든다(대체 경로).
// - 결과가 크면 조각으로 나눠 잠시(10분) 저장소에 두고 file_chunk로 이어 받게 한다. 마지막 조각을 받으면 지운다.
//   원고와 파일 내용은 그 밖에는 저장하지 않는다.

const crypto = require("crypto");
const CATALOG = require("./agents.json");
// 변환 라이브러리는 파일을 만들 때만 불러온다(다른 도구 호출의 시작 시간을 늘리지 않게)
const lazy = () => require("./filebuilder/build");

const MIME = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  hwpx: "application/hwp+zip",
  pdf: "application/pdf",
  md: "text/markdown"
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
        format: { type: "string", enum: ["xlsx", "docx", "pptx", "hwpx", "pdf", "md"] },
        markdown: { type: "string", description: "문서 원고(마크다운)" },
        meta: { type: "object", description: "subtitle·header·fallbackTitle·agent·date·brand·dept·estimate·figures_only(xlsx — 그래프마다 그림 시트만 담은 그림자료 엑셀)" },
        figures: { type: "array", items: {}, description: "원고의 그림 블록 순서대로 페이지가 그린 PNG {data(base64), w, h} 또는 null. fig_put으로 올린 그림은 {up(조각 수), w, h}" },
        fig_id: { type: "string", description: "fig_put으로 그림을 올릴 때 쓴 id(24자리 16진수)" }
      },
      required: ["format", "markdown"],
      additionalProperties: false
    }
  },
  {
    name: "fig_put",
    description: "업무 에이전트 페이지 전용: 파일에 넣을 그림(PNG base64)을 한 장씩(크면 조각으로) 잠시(10분) 올려 둔다. build_file에 fig_id와 figures[k] = {up: 조각 수, w, h}로 가리킨다.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, k: { type: "integer", minimum: 0 }, part: { type: "integer", minimum: 0 }, data: { type: "string" } }, required: ["id", "k", "part", "data"], additionalProperties: false }
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
// 변환기는 계정 스킬 sys-file-builder가 원본이고, lib/filebuilder/는 그 사본이다(scripts/sync-filebuilder.js로 복사).
// 여기서는 문서 서식 설정(doc_style)만 넘기고 변환은 사본에 맡긴다.
const docStyle = () => (CATALOG.doc_style && typeof CATALOG.doc_style === "object" ? CATALOG.doc_style : null);
const buildXlsx = (md, meta) => lazy().buildXlsx(md, meta, docStyle());
const buildHwpxFile = (md, meta, figures) => lazy().buildHwpx(md, meta, figures, docStyle());
// Word·PowerPoint·PDF(2026-10-26 서버로 이전 — 문서 서식을 바꿀 때 사본을 다시 만들지 않게). 그림은 페이지가 그린 PNG(figures)
const buildDocFile = (fmt, md, meta, figures) => {
  const b = lazy();
  const fn = { docx: b.buildDocx, pptx: b.buildPptx, pdf: b.buildPdf }[fmt];
  // 명령줄용 옵션(파일 경로 그림)은 받지 않는다
  const m = Object.assign({}, meta); delete m.images; delete m.base;
  return fn(md, m, figures, docStyle());
};

async function buildFile(args) {
  const fmt = String(args.format || "").toLowerCase();
  const md = String(args.markdown || "");
  let meta = args.meta && typeof args.meta === "object" ? args.meta : {};
  // 받은 보고서를 바로 공유할 수 있게 표지·머리글·바닥글·파일 속성에 '업무 에이전트'·에이전트 이름·질의를 쓰지 않는다
  // (2026-11-13 사용자 결정 — 변환기 옵션 no_author, 원고의 '표지 작성자: 없음'과 같음). 끄기: features.file_no_author = false
  const feat = CATALOG.features || {};
  if (feat.file_no_author !== false) {
    meta = Object.assign({}, meta, { no_author: true, header: "", subtitle: "", brand: "", agent: "", dept: "", question: "" });
    if (!meta.fallbackTitle || /답변$/.test(String(meta.fallbackTitle))) meta.fallbackTitle = "보고서";
  }
  if (!supported().includes(fmt)) {
    return { structuredContent: { ok: false, unsupported: true, format: fmt, message: `서버에서 만들지 않는 형식입니다: ${fmt}` } };
  }
  if (!md.trim()) throw new Error("markdown이 비어 있습니다");
  if (Array.isArray(args.figures) && args.figures.some(f => f && f.up)) args = Object.assign({}, args, { figures: await resolveFigures(args.figures, args.fig_id) });
  let r;
  if (fmt === "xlsx") r = await buildXlsx(md, meta);
  else if (fmt === "hwpx") r = await buildHwpxFile(md, meta, args.figures);
  else if (fmt === "docx" || fmt === "pptx" || fmt === "pdf") r = await buildDocFile(fmt, md, meta, args.figures);
  // md: 그림 블록은 자료 표, 도식은 관계 글로 바꾼 원고(서식 설정을 쓰지 않는다)
  else if (fmt === "md") r = await lazy().buildMd(md, meta);
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

// ---------- 그림 올리기(2026-11-13) ----------
// 페이지가 그림 PNG를 build_file 한 번에 다 실으면 요청이 너무 커져, 페이지는 그림 합계 900,000자(base64)에서 뒤 그림을 빼 왔다
// (차트 6개 뒤의 도식이 Word에서 빠진 사고). 25판부터 그림을 한 장씩 fig_put으로 올리고 build_file은 id만 받는다.
const FIG_PART_MAX = 1000000, FIG_MAX_K = 200, FIG_MAX_PART = 30;
async function figPut(args) {
  const id = String(args.id || ""), k = Number(args.k), part = Number(args.part), data = String(args.data || "");
  if (!/^[0-9a-f]{24}$/.test(id) || !Number.isInteger(k) || k < 0 || k >= FIG_MAX_K || !Number.isInteger(part) || part < 0 || part >= FIG_MAX_PART) throw new Error("id·k·part가 올바르지 않습니다");
  if (!data || data.length > FIG_PART_MAX || !/^[A-Za-z0-9+/=]+$/.test(data)) throw new Error(`data는 base64 글자 ${FIG_PART_MAX}자 이하여야 합니다`);
  await pipeline([["SET", `g:${id}:${k}:${part}`, data, "EX", String(TTL_SEC)]]);
  return { structuredContent: { ok: true, id, k, part, size: data.length } };
}
// figures 중 {up: n}인 항목을 올려 둔 그림으로 바꾼다(받은 뒤 지운다). 못 찾은 그림은 null(관계 문장·표로 대신 들어감)
async function resolveFigures(figures, figId) {
  if (!Array.isArray(figures)) return figures;
  if (!/^[0-9a-f]{24}$/.test(String(figId || ""))) return figures.map(f => (f && f.up ? null : f));
  const out = figures.slice(), keys = [];
  figures.forEach((f, k) => { const n = f && Number(f.up); if (n > 0 && n <= FIG_MAX_PART && k < FIG_MAX_K) for (let p = 0; p < n; p++) keys.push([k, p]); });
  if (!keys.length) return out;
  const vals = [];
  for (let i = 0; i < keys.length; i += 20) vals.push(...await pipeline(keys.slice(i, i + 20).map(([k, p]) => ["GET", `g:${figId}:${k}:${p}`])));
  const parts = {};
  keys.forEach(([k, p], i) => { (parts[k] = parts[k] || [])[p] = vals[i]; });
  Object.keys(parts).forEach(k => {
    const ps = parts[k], f = figures[k];
    out[k] = ps.every(x => typeof x === "string") ? { data: ps.join(""), w: f.w, h: f.h } : null;
  });
  pipeline(keys.map(([k, p]) => ["DEL", `g:${figId}:${k}:${p}`])).catch(() => {});
  return out;
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
  const res = name === "build_file" ? await buildFile(args || {}) : name === "file_chunk" ? await fileChunk(args || {}) : name === "fig_put" ? await figPut(args || {}) : null;
  if (!res) throw new Error(`알 수 없는 도구: ${name}`);
  const sc = res.structuredContent;
  const txt = name === "fig_put" ? `그림 ${sc.k}-${sc.part} 받음` : sc.inline ? `파일 ${sc.format} ${sc.size}바이트(본문 생략)` : sc.data ? `조각 ${sc.index}` : JSON.stringify(sc).slice(0, 400);
  return { content: [{ type: "text", text: txt }], structuredContent: sc };
}

module.exports = { TOOLS, NAMES, call, buildXlsx, buildHwpxFile, buildDocFile, _test: { buildXlsx, buildFile, resolveFigures } };
