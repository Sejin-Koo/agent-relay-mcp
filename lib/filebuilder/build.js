// 원고(마크다운) → 파일. 계정 스킬 sys-file-builder의 핵심 모듈(원본).
// 업무 에이전트 중계 서버는 이 폴더의 사본(lib/filebuilder/)을 가져다 쓴다 — 고칠 때는 이 원본을 고치고 사본을 다시 복사한다.
//   buildXlsx(md, meta, style)        ```valuation-model JSON 블록이 있으면 수식 연결 가치평가 모델, 없으면 표 → 시트
//   buildHwpx(md, meta, figures, style)  한글(HWPX). figures = 원고의 그림 블록 순서대로 {data(base64 PNG), w, h} 또는 null
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
        const r = await buildValuationWorkbook(spec, { font: st.font, confidential: st.elements && st.elements.confidential, brand: meta.brand, agent: meta.agent, date: meta.date, dept: meta.dept });
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
  const model = DocExport.mdToModel(String(md), s => marked.lexer(s), { subtitle: meta.subtitle || "", header: meta.header || "", fallbackTitle: meta.fallbackTitle || "에이전트 답변", images: !!meta.images });
  const figs = (Array.isArray(figures) ? figures : []).map(f => (f && typeof f.data === "string" && f.data.length > 100) ? { data: f.data.replace(/^data:image\/png;base64,/, ""), w: Number(f.w) || 16, h: Number(f.h) || 9 } : null);
  const buffer = await DocExport.buildHwpx(model, JSZip, require("./hwpx-tpl.json"), { figures: figs, nodebuffer: true, creator: meta.brand || meta.agent || "업무 에이전트", date: meta.date || "", dept: meta.dept || "", estimate: meta.estimate || null, cover: meta.cover });
  const nFig = model.sections.reduce((n, s) => n + s.blocks.filter(b => b.type === "figure").length, 0);
  const placed = figs.filter(Boolean).length;
  return { buffer, title: model.title, kind: "document", model, warnings: nFig > placed ? [`그림 ${nFig}개 중 ${placed}개만 그림으로 넣고 나머지는 그림 자료를 표로 넣었습니다`] : [] };
}

module.exports = { buildXlsx, buildHwpx, summaryLine, VAL_RE, DocExport };
