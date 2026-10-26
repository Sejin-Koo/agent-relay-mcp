// 원고(마크다운) → 파일. 계정 스킬 sys-file-builder의 핵심 모듈(원본).
// 업무 에이전트 중계 서버는 이 폴더의 사본(lib/filebuilder/)을 가져다 쓴다 — 고칠 때는 이 원본을 고치고 사본을 다시 복사한다.
//   buildXlsx(md, meta, style)        ```valuation-model JSON 블록이 있으면 수식 연결 가치평가 모델, 없으면 표 → 시트
//   buildHwpx(md, meta, figures, style)  한글(HWPX). figures = 원고의 그림 블록 순서대로 {data(base64 PNG), w, h} 또는 null
//   buildDocx(md, meta, figures, style)  Word. 도식(```diagram)은 고칠 수 있는 도형으로 바꾸고 그림은 대체본으로 남긴다
//   buildPptx(md, meta, figures, style)  PowerPoint. 도식은 도형·글상자·연결선, 차트는 그림
//   buildPdf(md, meta, figures, style)   PDF(글자가 살아 있는 PDF, 본고딕). 표지·목차는 본문 10쪽 이상(경계 9쪽)
//   그림 PNG가 없는 그림 블록은 차트는 자료 표로, 도식은 관계 문장으로 바꿔 넣는다
// style = 문서 서식 설정(없으면 기본값). meta = { subtitle, header, fallbackTitle, brand, agent, date, dept, images, estimate:{pages}, cover:true|false }
// 한글: 본문 추정 10쪽 이상(경계 9쪽)이면 표지·목차, 바닥글 쪽 번호. estimate.pages가 오면 추정 대신 그 값, cover로 강제할 수 있다
const { marked } = require("marked");
const JSZip = require("jszip");
const DocExport = require("./docexport");
const { buildGenericWorkbook } = require("./xlsx-generic");
const { buildValuationWorkbook } = require("./xlsx-valuation");

const VAL_RE = /```valuation-model\s*\n([\s\S]*?)```/;
const useStyle = (st) => { DocExport.setStyle(st && typeof st === "object" ? st : null); return DocExport.getStyle(); };
const eok = (v) => (typeof v === "number" && isFinite(v)) ? Math.round(v / 100).toLocaleString("en-US") : "n/a";

// 모델이 계산한 핵심 값(억원) 한 줄 — 답변 숫자와 비교하는 데 쓴다
function summaryLine(x) {
  return `Excel 모델 계산값(억원) ${x.name}: ` + [
    isFinite(x.dcf.mid) ? `DCF ${eok(x.dcf.lo)}~${eok(x.dcf.hi)}(중앙 ${eok(x.dcf.mid)})` : "",
    isFinite(x.comp.mid) ? `상대가치 종합 ${eok(x.comp.mid)}` : "",
    `적정가치 ${eok(x.fair.lo)}~${eok(x.fair.hi)}(중앙 ${eok(x.fair.mid)})`,
    x.market ? `시가총액 ${eok(x.market.mid)}` + (x.base_price ? `(기준주가 ${Math.round(x.base_price).toLocaleString("en-US")}원)` : "") : "",
    x.refs ? `참고가격 — 최근 거래가격 ${eok(x.refs.tx.mid)}, 보충적 평가액 ${eok(x.refs.supp.mid)}, 장부 순자산 ${eok(x.refs.book.mid)}(비교 기준: ${x.refs.sel})` : ""
  ].filter(Boolean).join(", ");
}

async function buildXlsx(md, meta, style) {
  meta = meta || {};
  const warnings = [];
  const st = useStyle(style);
  const m = String(md).match(VAL_RE);
  if (m) {
    let spec = null;
    try { spec = JSON.parse(m[1]); } catch (e) { warnings.push("가치평가 모델 블록의 JSON을 읽지 못해 표만 시트로 만들었습니다: " + e.message); }
    if (spec) {
      try {
        // 원고에 '표지 작성자: 없음'이 있으면 표지 시트에도 작성 주체(브랜드·에이전트·부서)를 쓰지 않는다
        const noAuth = /^[*_\s]*표지\s*작성자\s*[:：]\s*(없음|표시\s*안\s*함|표시하지\s*않음)/m.test(String(md));
        const r = await buildValuationWorkbook(spec, { font: st.font, confidential: st.elements && st.elements.confidential, brand: noAuth ? "" : meta.brand, agent: noAuth ? "" : meta.agent, date: meta.date, dept: noAuth ? "" : meta.dept });
        r.summary.forEach(x => warnings.push(summaryLine(x)));
        return { buffer: r.buffer, title: r.title, kind: "valuation", summary: r.summary, warnings };
      } catch (e) {
        if (e.code !== "bad_model") throw e;
        warnings.push(e.message + " — 표만 시트로 만들었습니다.");
      }
    }
  }
  const model = DocExport.mdToModel(String(md).replace(VAL_RE, ""), s => marked.lexer(s), {
    subtitle: meta.subtitle || "", header: meta.header || "", fallbackTitle: meta.fallbackTitle || "에이전트 답변"
  });
  const buffer = await buildGenericWorkbook(model, DocExport, st, meta);
  return { buffer, title: model.title, kind: "tables", warnings };
}

async function buildHwpx(md, meta, figures, style) {
  meta = meta || {};
  useStyle(style);
  const model = DocExport.mdToModel(String(md), s => marked.lexer(s), { subtitle: meta.subtitle || "", header: meta.header || "", fallbackTitle: meta.fallbackTitle || "에이전트 답변", images: !!meta.images, date: meta.date || "" });
  const figs = (Array.isArray(figures) ? figures : []).map(f => (f && typeof f.data === "string" && f.data.length > 100) ? { data: f.data.replace(/^data:image\/png;base64,/, ""), w: Number(f.w) || 16, h: Number(f.h) || 9 } : null);
  const buffer = await DocExport.buildHwpx(model, JSZip, require("./hwpx-tpl.json"), { figures: figs, nodebuffer: true, creator: meta.brand || meta.agent || "업무 에이전트", date: meta.date || "", dept: meta.dept || "", estimate: meta.estimate || null, cover: meta.cover });
  const nFig = model.sections.reduce((n, s) => n + s.blocks.filter(b => b.type === "figure").length, 0);
  const placed = figs.filter(Boolean).length;
  return { buffer, title: model.title, kind: "document", model, warnings: nFig > placed ? [`그림 ${nFig}개 중 ${placed}개만 그림으로 넣고 나머지는 그림 자료를 표로 넣었습니다`] : [] };
}

// ---------- Word·PowerPoint·PDF ----------
const DEFAULT_DEPT = "업무 에이전트 작성 자료";
function docModel(md, meta, figures) {
  DocExport.setLabels({ dept: meta.dept || DEFAULT_DEPT, creator: meta.brand || meta.agent || "업무 에이전트" });
  const model = DocExport.mdToModel(String(md), s => marked.lexer(s), { subtitle: meta.subtitle || "", header: meta.header || "", fallbackTitle: meta.fallbackTitle || "에이전트 답변", images: !!meta.images, date: meta.date || "" });
  const figs = Array.isArray(figures) ? figures : [];
  let i = 0, placed = 0, total = 0;
  const Diagram = require("./diagram");
  model.sections.forEach(sec => {
    sec.blocks = sec.blocks.flatMap(b => {
      if (b.type !== "figure") return [b];
      total++;
      const f = figs[i++];
      if (f && typeof f.data === "string" && f.data.length > 100) {
        const data = f.data.replace(/^data:image\/png;base64,/, "");
        b.img = { bytes: Buffer.from(data, "base64"), dataUrl: "data:image/png;base64," + data, w: Number(f.w) || 16, h: Number(f.h) || 9 };
        if (b.kind === "diagram") { try { b.img.lay = Diagram.layout(b.spec); } catch (e) { /* 배치하지 못하면 그림만 넣는다 */ } }
        placed++;
        return [b];
      }
      if (b.kind === "image" && b.src) return [b];
      // 그림이 없으면: 차트는 자료 표, 도식은 관계 문장
      const out = [];
      if (b.title) out.push({ type: "p", role: "caption", text: "[그림 자료] " + b.title });
      if (b.kind === "diagram") {
        let lines = [];
        try { lines = Diagram.describe(b.spec); } catch (e) { lines = []; }
        if (lines.length) out.push({ type: "bullets", items: lines.map(t => ({ text: t, level: 0 })) });
      } else {
        const t = DocExport.figureTable(b.spec);
        if (t) out.push({ type: "table", headers: t.headers, rows: t.rows });
      }
      if (b.source) out.push({ type: "p", role: "src", text: "자료: " + b.source });
      return out;
    });
  });
  // 파일 경로 그림(명령줄 ![캡션](파일.png)) — 원고 파일 기준 경로를 읽는다
  if (meta.images && meta.base) {
    const fs = require("fs"), path = require("path");
    model.sections.forEach(sec => sec.blocks.forEach(b => {
      if (b.type === "figure" && b.kind === "image" && b.src && !b.img) {
        try {
          const buf = fs.readFileSync(path.resolve(meta.base, b.src));
          const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
          b.img = { bytes: buf, dataUrl: "data:image/png;base64," + buf.toString("base64"), w, h }; placed++;
        } catch (e) { /* 읽지 못한 그림은 빠진다 */ }
      }
    }));
  }
  const warnings = total > placed ? [`그림 ${total}개 중 ${placed}개만 그림으로 넣고 나머지는 그림 자료를 표·문장으로 넣었습니다`] : [];
  return { model, warnings };
}

async function buildDocx(md, meta, figures, style) {
  meta = meta || {};
  useStyle(style);
  const d = require("docx");
  const { model, warnings } = docModel(md, meta, figures);
  // 표지·목차 여부: 페이지가 잰 값(meta.estimate.cover·headPages)이 있으면 그 값, 없으면 meta.cover, 그것도 없으면 쪽수 추정
  const est = meta.estimate && typeof meta.estimate === "object" ? meta.estimate : null;
  let cover;
  if (meta.cover === true || meta.cover === false) cover = meta.cover;
  else if (est) cover = !!est.cover;
  else cover = estimateWordPages(model) >= DocExport.coverMin();
  const opt = cover ? { cover: true, pages: (est && Array.isArray(est.headPages)) ? est.headPages : [] } : {};
  let buf = await d.Packer.toBuffer(DocExport.buildDocx(model, d, opt));
  const diagRep = [];
  if (cover || (model._diag && model._diag.length)) buf = await DocExport.finalizeDocx(buf, JSZip, cover ? DocExport.headList(model).length : 0, "nodebuffer", model._diag, diagRep);
  // 도형으로 넣으면 글자가 넘쳐 그림이 더 나은 도식은 그림으로 남는다 — 고칠 수 있는 도형은 PPT 파일에 있다고 알린다
  const kept = diagRep.filter(r => !r.shapes).length;
  if (kept) warnings.push(`도식 ${diagRep.length}개 중 ${kept}개는 도형으로 넣으면 글자가 도형 밖으로 넘쳐 그림으로 넣었습니다. 고칠 수 있는 도형은 같은 답변을 PPT 파일로 받으면 들어 있습니다`);
  return { buffer: buf, title: model.title, kind: "document", warnings, diagrams: diagRep };
}
// 쪽수 대강 추정(페이지가 잰 값이 없을 때만) — 한글 추정과 같은 방식(글자 수·표 행·그림)
function estimateWordPages(model) {
  let lines = 0;
  model.sections.forEach(s => {
    lines += 3;
    s.blocks.forEach(b => {
      if (b.type === "table") lines += 2 + b.rows.length * 1.6;
      else if (b.type === "figure") lines += 18;
      else if (b.type === "bullets") b.items.forEach(it => { lines += Math.ceil(DocExport.plain(it.text).length / 52) + 0.3; });
      else if (b.text) lines += Math.ceil(DocExport.plain(b.text).length / 55) + 0.4;
    });
  });
  return Math.ceil(lines / 38);
}

async function buildPptx(md, meta, figures, style) {
  meta = meta || {};
  useStyle(style);
  const P = require("pptxgenjs");
  const { model, warnings } = docModel(md, meta, figures);
  const pres = DocExport.buildPptx(model, P);
  const buf = await pres.write({ outputType: "nodebuffer" });
  return { buffer: Buffer.from(buf), title: model.title, kind: "document", warnings };
}

async function buildPdf(md, meta, figures, style) {
  meta = meta || {};
  useStyle(style);
  const { model, warnings } = docModel(md, meta, figures);
  const r = await require("./pdf").buildPdf(model, DocExport, { date: meta.date || "", cover: meta.cover });
  warnings.push(`PDF 글꼴: ${r.font}`);
  return { buffer: r.buffer, title: model.title, kind: "document", warnings, pages: r.pages };
}

module.exports = { buildXlsx, buildHwpx, buildDocx, buildPptx, buildPdf, summaryLine, VAL_RE, DocExport };
