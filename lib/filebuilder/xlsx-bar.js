// 원본: 계정 스킬 sys-file-builder — 업무 에이전트 중계 서버의 lib/filebuilder/는 이 파일의 사본이다(사본을 직접 고치지 않는다).
// 보고서 그림자료 Excel — 막대 차트 명세(chart-spec.js)마다 시트 하나: 표(값·수식) + 의미 범례(셀) + 고칠 수 있는 Excel 차트.
// 차트 규칙은 ref-report-visualization 3·4절 — 막대마다 같은 색·굵은 숫자 라벨(셀 값과 연결), 누적 막대는 안쪽 흰 숫자 + 오른쪽 합계,
// 범례는 색의 의미를 차트 위 셀에, 글꼴 맑은 고딕. Word 그림(scripts/chart-png.py)과 같은 명세에서 나온다.
"use strict";
const ExcelJS = require("exceljs");
const { normalize, fmt } = require("./chart-spec");
const { injectCharts } = require("./xlsx-chart");

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const COL = (i) => { let s = ""; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const wch = (s) => { let w = 0; String(s == null ? "" : s).split("").forEach(c => { w += c.charCodeAt(0) > 0x2e80 ? 2 : 1; }); return w; };
const R0 = 4; // 자료 첫 행(1행 제목, 2행 범례, 3행 머리행)

function sheetNameFor(spec, no, used) {
  let base = spec.sheet || (no != null ? `그림${no}` : "차트");
  base = base.replace(/[\\/?*[\]:']/g, "").slice(0, 31) || "차트";
  let name = base, k = 2;
  while (used.has(name)) name = base.slice(0, 28) + "_" + k++;
  used.add(name); return name;
}

// ---------- 차트 XML ----------
function rpr(font, sz, color, b) {
  return `<a:defRPr sz="${sz}" b="${b ? 1 : 0}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${esc(font)}"/><a:ea typeface="${esc(font)}"/><a:cs typeface="${esc(font)}"/></a:defRPr>`;
}
function txpr(font, sz, color, b) {
  return `<c:txPr><a:bodyPr wrap="none" lIns="0" rIns="0"/><a:lstStyle/><a:p><a:pPr>${rpr(font, sz, color, b)}</a:pPr><a:endParaRPr lang="ko-KR"/></a:p></c:txPr>`;
}
const fill = (c) => `<c:spPr><a:solidFill><a:srgbClr val="${c}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>`;
const NOFILL = '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>';
const show = (v) => `<c:showLegendKey val="0"/><c:showVal val="${v}"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>`;
const C15 = 'xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart"';
function strRef(f, vals) { return `<c:strRef><c:f>${esc(f)}</c:f><c:strCache><c:ptCount val="${vals.length}"/>` + vals.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join("") + "</c:strCache></c:strRef>"; }
function numRef(f, vals) { return `<c:numRef><c:f>${esc(f)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>` + vals.map((v, i) => (v == null ? "" : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join("") + "</c:numCache></c:numRef>"; }

function chartXml(sp, sheet, cols, font, title, seed) {
  const sh = `'${sheet.replace(/'/g, "''")}'`, r1 = R0 + sp.n - 1;
  const cat = `<c:cat>${strRef(`${sh}!$A$${R0}:$A$${r1}`, sp.x)}</c:cat>`;
  let sers = "";
  sp.series.forEach((s, k) => {
    let x = `<c:ser><c:idx val="${k}"/><c:order val="${k}"/><c:tx><c:v>${esc(s.name)}</c:v></c:tx>${fill(s.color)}<c:invertIfNegative val="0"/>`;
    for (let i = 0; i < sp.n; i++) x += `<c:dPt><c:idx val="${i}"/><c:invertIfNegative val="0"/><c:bubble3D val="0"/>${fill(sp.barColor(k, i))}</c:dPt>`;
    const inner = sp.stacked, sz = inner ? 800 : 900;
    x += "<c:dLbls>";
    for (let i = 0; i < sp.n; i++) {
      if (s.data[i] == null) { x += `<c:dLbl><c:idx val="${i}"/><c:delete val="1"/></c:dLbl>`; continue; }
      const col = inner ? "FFFFFF" : sp.barColor(k, i), f = inner ? sp.innerFormat : sp.labelFmtAt(i);
      x += `<c:dLbl><c:idx val="${i}"/><c:numFmt formatCode="${esc(f)}" sourceLinked="0"/>${NOFILL}${txpr(font, sz, col, true)}<c:dLblPos val="${inner ? "ctr" : "outEnd"}"/>${show(1)}</c:dLbl>`;
    }
    x += `<c:numFmt formatCode="${esc(inner ? sp.innerFormat : sp.labelFormat)}" sourceLinked="0"/>${NOFILL}${txpr(font, sz, inner ? "FFFFFF" : s.color, true)}<c:dLblPos val="${inner ? "ctr" : "outEnd"}"/>${show(1)}</c:dLbls>`;
    x += cat + `<c:val>${numRef(`${sh}!$${cols.series[k]}$${R0}:$${cols.series[k]}$${r1}`, s.data)}</c:val></c:ser>`;
    sers += x;
  });
  if (sp.stacked && sp.showTotal) { // 합계 라벨: 투명 막대(라벨자리)에 합계 셀 값을 막대 바로 오른쪽(inBase)에 쓴다
    const k = sp.series.length, ph = sp.totals.map(() => +(Math.max(...sp.totals) * 0.15).toFixed(4));
    const tt = sp.totals.map(t => fmt(t, sp.totalFormat));
    let x = `<c:ser><c:idx val="${k}"/><c:order val="${k}"/><c:tx><c:v>라벨자리</c:v></c:tx>${NOFILL}<c:invertIfNegative val="0"/><c:dLbls>`;
    for (let i = 0; i < sp.n; i++) {
      const g = "{" + [(seed >>> 0).toString(16).padStart(8, "0").slice(-8), "2B3C", "4D5E", "8F90", (seed * 100 + i).toString(16).padStart(12, "0").slice(-12)].join("-").toUpperCase() + "}";
      x += `<c:dLbl><c:idx val="${i}"/><c:layout/><c:tx><c:rich><a:bodyPr wrap="none" lIns="0" rIns="0"/><a:lstStyle/><a:p>` +
        `<a:fld id="${g}" type="CELLRANGE"><a:rPr lang="ko-KR" sz="900" b="1"><a:solidFill><a:srgbClr val="${sp.totalColor}"/></a:solidFill><a:latin typeface="${esc(font)}"/><a:ea typeface="${esc(font)}"/></a:rPr><a:t>[CELLRANGE]</a:t></a:fld>` +
        `</a:p></c:rich></c:tx>${NOFILL}<c:dLblPos val="inBase"/>${show(0)}` +
        `<c:extLst><c:ext uri="{CE6537A1-D6FC-4f65-9D91-7224C49458BB}" ${C15}><c15:dlblFieldTable/><c15:showDataLabelsRange val="1"/></c:ext></c:extLst></c:dLbl>`;
    }
    x += `${NOFILL}${txpr(font, 900, sp.totalColor, true)}<c:dLblPos val="inBase"/>${show(0)}` +
      `<c:extLst><c:ext uri="{CE6537A1-D6FC-4f65-9D91-7224C49458BB}" ${C15}><c15:showDataLabelsRange val="1"/><c15:showLeaderLines val="0"/></c:ext></c:extLst></c:dLbls>`;
    x += cat + `<c:val>${numRef(`${sh}!$${cols.holder}$${R0}:$${cols.holder}$${r1}`, ph)}</c:val>` +
      `<c:extLst><c:ext uri="{02D57815-91ED-43cb-92C2-25804820EDAC}" ${C15}><c15:datalabelsRange><c15:f>${esc(`${sh}!$${cols.total}$${R0}:$${cols.total}$${r1}`)}</c15:f>` +
      `<c15:dlblRangeCache><c:ptCount val="${sp.n}"/>` + tt.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join("") + `</c15:dlblRangeCache></c15:datalabelsRange></c:ext></c:extLst></c:ser>`;
    sers += x;
  }
  const H = sp.orient === "h";
  const gray = '<c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="BFBFBF"/></a:solidFill></a:ln></c:spPr>';
  const ttl = (t, sz, c, b) => `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr>${rpr(font, sz, c, b)}</a:pPr><a:r><a:rPr lang="ko-KR" sz="${sz}" b="${b ? 1 : 0}"><a:solidFill><a:srgbClr val="${c}"/></a:solidFill><a:latin typeface="${esc(font)}"/><a:ea typeface="${esc(font)}"/></a:rPr><a:t>${esc(t)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<c:roundedCorners val="0"/><c:chart>' + ttl(title, wch(title) > 56 ? 1000 : 1100, "1F3864", true) + '<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>' +
    `<c:barChart><c:barDir val="${H ? "bar" : "col"}"/><c:grouping val="${sp.stacked ? "stacked" : "clustered"}"/><c:varyColors val="0"/>${sers}<c:gapWidth val="45"/>${sp.stacked ? '<c:overlap val="100"/>' : ""}<c:axId val="111"/><c:axId val="222"/></c:barChart>` +
    `<c:catAx><c:axId val="111"/><c:scaling><c:orientation val="${H ? "maxMin" : "minMax"}"/></c:scaling><c:delete val="0"/><c:axPos val="${H ? "l" : "b"}"/><c:numFmt formatCode="General" sourceLinked="0"/>` +
    `<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${gray}${txpr(font, 900, "262626")}<c:crossAx val="222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>` +
    `<c:valAx><c:axId val="222"/><c:scaling><c:orientation val="minMax"/><c:max val="${sp.axisMax}"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="${H ? "b" : "l"}"/>` +
    '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E5E5E5"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>' +
    (sp.axisTitle ? ttl(sp.axisTitle, 900, "404040", false) : "") +
    `<c:numFmt formatCode="#,##0" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${gray}${txpr(font, 900, "404040")}<c:crossAx val="111"/><c:crosses val="${H ? "max" : "autoZero"}"/><c:crossBetween val="between"/></c:valAx>` +
    '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>' +
    `<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>${txpr(font, 900, "262626")}` +
    '<c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings></c:chartSpace>';
}

// ---------- 시트 ----------
const thin = { style: "thin", color: { argb: "FFBFBFBF" } };
const BOX = { top: thin, left: thin, bottom: thin, right: thin };
const fill1 = (hex) => ({ type: "pattern", pattern: "solid", fgColor: { argb: "FF" + hex } });
const tpl = (t, r, ins) => String(t).replace(/^=/, "").replace(/\{r\}/g, r).replace(/\{in(\d+)\}/g, (m, k) => {
  const a = ins && ins[Number(k) - 1]; if (!a) throw new Error(`수식의 ${m}에 해당하는 inputs가 없습니다`); return a; });

function writeSheet(ws, sp, title, font) {
  const F = (o) => Object.assign({ name: font, size: 10 }, o || {});
  ws.getCell("A1").value = title; ws.getCell("A1").font = F({ bold: true, size: 12, color: { argb: "FF1F3864" } });
  if (sp.legend.length) {
    const rich = [];
    sp.legend.forEach(l => {
      if (l.color == null) { rich.push({ text: "(" + l.text + ")    ", font: F({ color: { argb: "FF404040" } }) }); return; }
      rich.push({ text: "■ ", font: F({ bold: true, color: { argb: "FF" + l.color } }) }, { text: l.text + "    ", font: F({ color: { argb: "FF404040" } }) });
    });
    ws.getCell("H2").value = { richText: rich };
  }
  // 열 배치: A 범주, 계열, 추가 열, (누적 합계) 합계·라벨자리
  const cols = { series: [], extra: [] }; let c = 1;
  const heads = [sp.x_name];
  sp.series.forEach(s => { cols.series.push(COL(c++)); heads.push(s.name); });
  sp.extra.forEach(e => { cols.extra.push(COL(c++)); heads.push(e.name); });
  if (sp.stacked && sp.showTotal) { cols.total = COL(c++); heads.push("합계"); cols.holder = COL(c++); heads.push("라벨자리"); }
  heads.forEach((h, j) => {
    const cell = ws.getCell(3, j + 1); cell.value = h; cell.font = F({ bold: true, color: { argb: "FFFFFFFF" } }); cell.fill = fill1("2E5395");
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true }; cell.border = BOX;
  });
  const r1 = R0 + sp.n - 1, widths = heads.map(h => wch(h) + 2);
  // 입력값(inputs): 표 아래 두 줄 띄우고 A=이름, B=값 — 수식에서 {in1}·{in2}…로 참조($B$행)
  const insAt = sp.inputs.map((_, q) => `$B$${r1 + 2 + q}`);
  const put = (r, j, v, numFmt, bold) => {
    const cell = ws.getCell(r, j + 1); cell.value = v; cell.border = BOX; cell.font = F({ bold: !!bold });
    if (numFmt) { cell.numFmt = numFmt; cell.alignment = { horizontal: "right" }; } else cell.alignment = { horizontal: "left" };
    const shown = numFmt ? fmt(v && typeof v === "object" ? v.result : v, numFmt) : String(v);
    widths[j] = Math.max(widths[j], wch(shown) + 2);
  };
  for (let i = 0; i < sp.n; i++) {
    const r = R0 + i, last = sp.sumRow && i === sp.n - 1, bold = last || sp.boldRows.indexOf(i) >= 0;
    put(r, 0, sp.x[i], null, bold);
    sp.series.forEach((s, k) => {
      const col = cols.series[k], v = s.data[i];
      let f = null;
      if (s.formulas && s.formulas[i]) f = tpl(s.formulas[i], r, insAt);
      else if (last) f = `SUM(${col}${R0}:${col}${r - 1})`;
      else if (s.formula) f = tpl(s.formula, r, insAt);
      put(r, 1 + k, f ? { formula: f, result: v } : v, sp.cellFormat || sp.labelFmtAt(i), bold);
    });
    sp.extra.forEach((e, q) => {
      const v = e.data[i]; let f = e.formulas && e.formulas[i] ? tpl(e.formulas[i], r, insAt) : null;
      put(r, 1 + sp.series.length + q, f ? { formula: f, result: v } : (v == null ? null : v), e.format, bold);
    });
    if (cols.total) {
      const j = heads.length - 2;
      put(r, j, { formula: `SUM(${cols.series[0]}${r}:${cols.series[cols.series.length - 1]}${r})`, result: sp.totals[i] }, sp.totalFormat, bold);
      put(r, j + 1, { formula: `MAX($${cols.total}$${R0}:$${cols.total}$${r1})*0.15`, result: +(Math.max(...sp.totals) * 0.15).toFixed(4) }, "#,##0.0", false);
    }
  }
  let rr = r1 + 2;
  sp.inputs.forEach(a => { put(rr, 0, a.label, null, false); put(rr, 1, a.value, a.format, false); rr++; });
  if (sp.inputs.length) rr++;
  const small = (t) => { ws.getCell(rr, 1).value = t; ws.getCell(rr, 1).font = F({ size: 9, color: { argb: "FF808080" } }); rr++; };
  if (sp.note) small(sp.note);
  if (cols.holder) small("라벨자리: 합계 숫자를 막대 오른쪽에 쓰기 위한 투명 막대(그래프에는 보이지 않음)");
  if (sp.source) small("자료: " + sp.source);
  widths.forEach((w, j) => { ws.getColumn(j + 1).width = Math.min(j === 0 ? 40 : 18, Math.max(j === 0 ? 12 : 10, w)); });
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printArea: `A1:R${Math.max(20, rr + 2)}` };
  return cols;
}

// figures: [{ spec(원본 명세), no(그림 번호, 없으면 null) }]
// opt.wb: 이 통합문서에 시트를 더한다(표 시트와 합칠 때), opt.returnWb: 쓰지 않고 { wb, charts, sheets, skipped }를 돌려준다
// opt.palette: 계열 색을 정하지 않은 명세의 기본 색 순서(중계 서버는 서식 설정의 차트 색 — 페이지가 그린 그림과 같게)
// 막대가 아닌 차트(선·원 등)나 형식이 틀린 명세는 건너뛰고 skipped에 이유를 남긴다(표 시트로는 들어갈 수 있음)
async function buildChartWorkbook(figures, opt) {
  opt = opt || {};
  const font = opt.font || "맑은 고딕";
  const wb = opt.wb || new ExcelJS.Workbook();
  wb.calcProperties.fullCalcOnLoad = true;
  const used = new Set(), charts = [], out = [], skipped = [];
  figures.forEach((f, k) => {
    let sp;
    try { sp = normalize(f.spec, { palette: opt.palette }); } catch (e) { skipped.push({ k, no: f.no, reason: e.message }); return; }
    if (f.spec.cell_format) sp.cellFormat = f.spec.cell_format;
    const name = sheetNameFor(sp, f.no, used), title = sp.fullTitle(f.no);
    const ws = wb.addWorksheet(name, { views: [{ showGridLines: true }] });
    const cols = writeSheet(ws, sp, title, font);
    charts.push({ sheetName: name, anchor: { c1: 7, r1: 2, c2: 17, r2: 17 }, xml: chartXml(sp, name, cols, font, title, 0x5A10 + k) });
    out.push({ k, sheet: name, title, labels: sp.series.length * sp.n + (sp.stacked && sp.showTotal ? sp.n : 0) });
  });
  if (opt.returnWb) return { wb, charts, sheets: out, skipped };
  const buf = await wb.xlsx.writeBuffer();
  return { buffer: await injectCharts(Buffer.from(buf), charts), sheets: out, skipped };
}

module.exports = { buildChartWorkbook, chartXml, injectCharts };
