// 원본: 계정 스킬 sys-file-builder — 업무 에이전트 중계 서버의 lib/filebuilder/는 이 파일의 사본이다(사본을 직접 고치지 않는다).
// 보고서 그림자료 Excel — 차트 명세(chart-spec.js — 막대·꺾은선·영역·원·도넛·혼합)마다 시트 하나: 표(값·수식) + 의미 범례(셀) + 고칠 수 있는 Excel 차트.
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

const guid = (seed, i) => "{" + [(seed >>> 0).toString(16).padStart(8, "0").slice(-8), "2B3C", "4D5E", "8F90", (seed * 100 + i).toString(16).padStart(12, "0").slice(-12)].join("-").toUpperCase() + "}";
// 셀 값 라벨(Excel 2013 datalabelsRange) — 점마다 [CELLRANGE] 글자, 계열 끝에 라벨 칸 범위와 캐시
function cellLbl(i, font, sz, color, pos, seed) {
  return `<c:dLbl><c:idx val="${i}"/><c:layout/><c:tx><c:rich><a:bodyPr wrap="none" lIns="0" rIns="0"/><a:lstStyle/><a:p>` +
    `<a:fld id="${guid(seed, i)}" type="CELLRANGE"><a:rPr lang="ko-KR" sz="${sz}" b="1"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${esc(font)}"/><a:ea typeface="${esc(font)}"/></a:rPr><a:t>[CELLRANGE]</a:t></a:fld>` +
    `</a:p></c:rich></c:tx>${NOFILL}${pos ? `<c:dLblPos val="${pos}"/>` : ""}${show(0)}` +
    `<c:extLst><c:ext uri="{CE6537A1-D6FC-4f65-9D91-7224C49458BB}" ${C15}><c15:dlblFieldTable/><c15:showDataLabelsRange val="1"/></c:ext></c:extLst></c:dLbl>`;
}
function cellLblEnd(font, sz, color, pos) {
  return `${NOFILL}${txpr(font, sz, color, true)}${pos ? `<c:dLblPos val="${pos}"/>` : ""}${show(0)}` +
    `<c:extLst><c:ext uri="{CE6537A1-D6FC-4f65-9D91-7224C49458BB}" ${C15}><c15:showDataLabelsRange val="1"/><c15:showLeaderLines val="0"/></c:ext></c:extLst></c:dLbls>`;
}
function rangeExt(f, texts) {
  return `<c:extLst><c:ext uri="{02D57815-91ED-43cb-92C2-25804820EDAC}" ${C15}><c15:datalabelsRange><c15:f>${esc(f)}</c15:f>` +
    `<c15:dlblRangeCache><c:ptCount val="${texts.length}"/>` + texts.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join("") + `</c15:dlblRangeCache></c15:datalabelsRange></c:ext></c:extLst>`;
}
// 숫자 라벨(값) — 점마다 서식·색, 빼는 점은 delete
function valLbls(sp, k, font, sz, colorAt, pos, fmtAt, defColor, defFmt, inset) {
  let x = "<c:dLbls>";
  const on = sp.x.map((_, i) => sp.labelAt(k, i)), first = on.indexOf(true), last = on.lastIndexOf(true);
  for (let i = 0; i < sp.n; i++) {
    if (!on[i]) { x += `<c:dLbl><c:idx val="${i}"/><c:delete val="1"/></c:dLbl>`; continue; }
    // inset: 누적 영역의 양 끝 라벨을 영역 안쪽으로 옮긴다(차트 폭 대비 비율)
    const dx = inset && first !== last ? (i === first ? inset : i === last ? -inset : 0) : 0;
    x += `<c:dLbl><c:idx val="${i}"/>${dx ? `<c:layout><c:manualLayout><c:x val="${dx}"/><c:y val="0"/></c:manualLayout></c:layout>` : ""}<c:numFmt formatCode="${esc(fmtAt(i))}" sourceLinked="0"/>${NOFILL}${txpr(font, sz, colorAt(i), true)}${pos ? `<c:dLblPos val="${pos}"/>` : ""}${show(1)}</c:dLbl>`;
  }
  return x + `<c:numFmt formatCode="${esc(defFmt)}" sourceLinked="0"/>${NOFILL}${txpr(font, sz, defColor, true)}${pos ? `<c:dLblPos val="${pos}"/>` : ""}${show(1)}</c:dLbls>`;
}
const lineSp = (c, w) => `<c:spPr><a:ln w="${w || 28575}" cap="rnd"><a:solidFill><a:srgbClr val="${c}"/></a:solidFill><a:round/></a:ln></c:spPr>`;
const marker = (c) => `<c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr><a:solidFill><a:srgbClr val="${c}"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:marker>`;

function chartXml(sp, sheet, cols, font, title, seed) {
  const sh = `'${sheet.replace(/'/g, "''")}'`, r1 = R0 + sp.n - 1;
  const cat = `<c:cat>${strRef(`${sh}!$A$${R0}:$A$${r1}`, sp.x)}</c:cat>`;
  const val = (k) => `<c:val>${numRef(`${sh}!$${cols.series[k]}$${R0}:$${cols.series[k]}$${r1}`, sp.series[k].data)}</c:val>`;
  const head = (k, name) => `<c:idx val="${k}"/><c:order val="${k}"/><c:tx><c:v>${esc(name)}</c:v></c:tx>`;
  const H = sp.kind === "bar" && sp.orient === "h";
  // 막대 계열(막대 차트 전부, 혼합 차트의 막대)
  const barSers = (ks) => ks.map(k => {
    const s = sp.series[k];
    let x = `<c:ser>${head(k, s.name)}${fill(s.color)}<c:invertIfNegative val="0"/>`;
    for (let i = 0; i < sp.n; i++) x += `<c:dPt><c:idx val="${i}"/><c:invertIfNegative val="0"/><c:bubble3D val="0"/>${fill(sp.barColor(k, i))}</c:dPt>`;
    const inner = sp.stacked;
    x += valLbls(sp, k, font, inner ? 800 : 900, i => (inner ? "FFFFFF" : sp.barColor(k, i)), inner ? "ctr" : "outEnd", i => (inner ? sp.innerFormat : sp.labelFmtAt(i, k)), inner ? "FFFFFF" : s.color, inner ? sp.innerFormat : s.labelFormat);
    return x + cat + val(k) + "</c:ser>";
  }).join("");
  let plot = "";
  const AX = { cat: 111, val: 222, cat2: 333, val2: 444 };
  if (sp.kind === "bar" || sp.kind === "combo") {
    const ks = sp.series.map((s, k) => (s.type === "bar" ? k : -1)).filter(k => k >= 0);
    let sers = barSers(ks);
    if (sp.stacked && sp.showTotal) { // 합계 라벨: 투명 막대(라벨자리)에 합계 셀 값을 막대 바로 오른쪽(inBase)에 쓴다
      const k = sp.series.length, ph = sp.totals.map(() => +(Math.max(...sp.totals) * 0.15).toFixed(4));
      let x = `<c:ser>${head(k, "라벨자리")}${NOFILL}<c:invertIfNegative val="0"/><c:dLbls>`;
      for (let i = 0; i < sp.n; i++) x += cellLbl(i, font, 900, sp.totalColor, "inBase", seed);
      x += cellLblEnd(font, 900, sp.totalColor, "inBase");
      x += cat + `<c:val>${numRef(`${sh}!$${cols.holder}$${R0}:$${cols.holder}$${r1}`, ph)}</c:val>` +
        rangeExt(`${sh}!$${cols.total}$${R0}:$${cols.total}$${r1}`, sp.totals.map(t => fmt(t, sp.totalFormat))) + "</c:ser>";
      sers += x;
    }
    if (ks.length) plot += `<c:barChart><c:barDir val="${H ? "bar" : "col"}"/><c:grouping val="${sp.stacked ? "stacked" : "clustered"}"/><c:varyColors val="0"/>${sers}<c:gapWidth val="45"/>${sp.stacked ? '<c:overlap val="100"/>' : ""}<c:axId val="${AX.cat}"/><c:axId val="${AX.val}"/></c:barChart>`;
  }
  const lineSers = (ks) => ks.map(k => {
    const s = sp.series[k];
    return `<c:ser>${head(k, s.name)}${lineSp(s.color)}${marker(s.color)}` +
      valLbls(sp, k, font, 900, () => s.color, "t", i => sp.labelFmtAt(i, k), s.color, s.labelFormat) + cat + val(k) + '<c:smooth val="0"/></c:ser>';
  }).join("");
  const lineChart = (ks, a, b) => `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${lineSers(ks)}<c:marker val="1"/><c:axId val="${a}"/><c:axId val="${b}"/></c:lineChart>`;
  if (sp.kind === "line") plot += lineChart(sp.series.map((_, k) => k), AX.cat, AX.val);
  if (sp.kind === "combo") {
    const k0 = sp.series.map((s, k) => (s.type === "line" && s.axis === 0 ? k : -1)).filter(k => k >= 0);
    const k1 = sp.series.map((s, k) => (s.type === "line" && s.axis === 1 ? k : -1)).filter(k => k >= 0);
    if (k0.length) plot += lineChart(k0, AX.cat, AX.val);
    if (k1.length) plot += lineChart(k1, AX.cat2, AX.val2);
  }
  if (sp.kind === "area") {
    // 누적 영역: 띠 가운데 흰 숫자. 겹친 영역: 채움은 영역 차트(라벨 없음), 선·숫자 라벨(점 위)은 같은 계열의 꺾은선(표식 없음)으로 겹쳐 그린다 — Word 그림과 같은 모양
    const sers = sp.series.map((s, k) => `<c:ser>${head(k, s.name)}<c:spPr><a:solidFill><a:srgbClr val="${s.color}"><a:alpha val="${sp.stacked ? 85000 : 35000}"/></a:srgbClr></a:solidFill><a:ln w="19050"><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill></a:ln></c:spPr>` +
      (sp.stacked ? valLbls(sp, k, font, 800, () => "FFFFFF", null, i => sp.labelFmtAt(i, k), "FFFFFF", s.labelFormat, 0.03) : '<c:dLbls><c:delete val="1"/></c:dLbls>') + cat + val(k) + "</c:ser>").join("");
    plot += `<c:areaChart><c:grouping val="${sp.stacked ? "stacked" : "standard"}"/><c:varyColors val="0"/>${sers}<c:axId val="${AX.cat}"/><c:axId val="${AX.val}"/></c:areaChart>`;
    if (!sp.stacked) {
      const n0 = sp.series.length;
      const ls = sp.series.map((s, k) => `<c:ser>${head(n0 + k, s.name)}${lineSp(s.color, 19050)}<c:marker><c:symbol val="none"/></c:marker>` +
        valLbls(sp, k, font, 900, () => s.color, "t", i => sp.labelFmtAt(i, k), s.color, s.labelFormat) + cat + val(k) + '<c:smooth val="0"/></c:ser>').join("");
      plot += `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${ls}<c:marker val="1"/><c:axId val="${AX.cat}"/><c:axId val="${AX.val}"/></c:lineChart>`;
    }
  }
  if (sp.kind === "pie") {
    const s = sp.series[0];
    let x = `<c:ser>${head(0, s.name)}`;
    for (let i = 0; i < sp.n; i++) x += `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${sp.barColor(0, i)}"/></a:solidFill><a:ln w="19050"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`;
    const pos = sp.hole ? null : "outEnd", lc = (i) => (sp.hole ? "FFFFFF" : sp.barColor(0, i));
    if (sp.pieLabel === "none") x += '<c:dLbls><c:delete val="1"/></c:dLbls>';
    else {
      x += "<c:dLbls>";
      for (let i = 0; i < sp.n; i++) x += cellLbl(i, font, 900, lc(i), pos, seed);
      x += cellLblEnd(font, 900, lc(0), pos);
    }
    x += cat + val(0) + (sp.pieLabel === "none" ? "" : rangeExt(`${sh}!$${cols.label}$${R0}:$${cols.label}$${r1}`, sp.x.map((_, i) => sp.pieText(i)))) + "</c:ser>";
    plot += sp.hole ? `<c:doughnutChart><c:varyColors val="1"/>${x}<c:firstSliceAng val="0"/><c:holeSize val="${Math.round(sp.hole * 100)}"/></c:doughnutChart>`
      : `<c:pieChart><c:varyColors val="1"/>${x}<c:firstSliceAng val="0"/></c:pieChart>`;
  }
  const gray = '<c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="BFBFBF"/></a:solidFill></a:ln></c:spPr>';
  const ttl = (t, sz, c, b) => `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr>${rpr(font, sz, c, b)}</a:pPr><a:r><a:rPr lang="ko-KR" sz="${sz}" b="${b ? 1 : 0}"><a:solidFill><a:srgbClr val="${c}"/></a:solidFill><a:latin typeface="${esc(font)}"/><a:ea typeface="${esc(font)}"/></a:rPr><a:t>${esc(t)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
  const catAx = (id, cross, del) => `<c:catAx><c:axId val="${id}"/><c:scaling><c:orientation val="${H ? "maxMin" : "minMax"}"/></c:scaling><c:delete val="${del ? 1 : 0}"/><c:axPos val="${H ? "l" : "b"}"/><c:numFmt formatCode="General" sourceLinked="0"/>` +
    `<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="${sp.axisMin < 0 ? "low" : "nextTo"}"/>${gray}${txpr(font, 900, "262626")}<c:crossAx val="${cross}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
  const valAx = (id, cross, max, min, title, right, grid) => `<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/><c:max val="${max}"/><c:min val="${min}"/></c:scaling><c:delete val="0"/><c:axPos val="${H ? "b" : right ? "r" : "l"}"/>` +
    (grid ? '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E5E5E5"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>' : "") +
    (title ? ttl(title, 900, "404040", false) : "") +
    `<c:numFmt formatCode="${esc(sp.kind === "bar" ? "#,##0" : axisFmt(max - min))}" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${gray}${txpr(font, 900, "404040")}<c:crossAx val="${cross}"/><c:crosses val="${H || right ? "max" : "autoZero"}"/><c:crossBetween val="between"/></c:valAx>`;
  let axes = "";
  if (sp.kind !== "pie") {
    axes = catAx(AX.cat, AX.val, false) + valAx(AX.val, AX.cat, sp.axisMax, sp.axisMin, sp.axisTitle, false, true);
    if (sp.kind === "combo" && sp.comboAxis) axes += catAx(AX.cat2, AX.val2, true) + valAx(AX.val2, AX.cat2, sp.axis2Max, sp.axis2Min, sp.axis2Title, true, false);
  }
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<c:roundedCorners val="0"/><c:chart>' + ttl(title, wch(title) > 56 ? 1000 : 1100, "1F3864", true) + '<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>' +
    plot + axes +
    '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>' +
    `<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>${txpr(font, 900, "262626")}` +
    '<c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings></c:chartSpace>';
}
// 값축 숫자 서식 — 범위가 작으면(비율 등) 소수 한 자리
function axisFmt(range) { return range > 0 && range < 10 ? "#,##0.0" : "#,##0"; }

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
  if (sp.kind === "pie") { cols.pct = COL(c++); heads.push("비율"); if (sp.pieLabel !== "none") { cols.label = COL(c++); heads.push("라벨"); } }
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
      put(r, 1 + k, f ? { formula: f, result: v } : v, sp.cellFormat || sp.labelFmtAt(i, k), bold);
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
    if (cols.pct) { // 원·도넛: 비율 = 값 / 합계, 라벨 = 조각에 쓰는 글자(수식 — 값을 바꾸면 그래프 라벨도 바뀐다)
      const v = cols.series[0], jp = 1 + sp.series.length + sp.extra.length, q = (f) => f.replace(/"/g, '""');
      put(r, jp, { formula: `${v}${r}/SUM($${v}$${R0}:$${v}$${r1})`, result: sp.percents[i] }, sp.percentFormat, bold);
      if (cols.label) {
        const tv = `TEXT(${v}${r},"${q(sp.labelFmtAt(i))}")`, tp = `TEXT(${cols.pct}${r},"${q(sp.percentFormat)}")`;
        const f = sp.pieLabel === "both" ? `${tv}&" ("&${tp}&")"` : sp.pieLabel === "percent" ? tp : tv;
        put(r, jp + 1, { formula: f, result: sp.pieText(i) }, null, false);
      }
    }
  }
  let rr = r1 + 2;
  sp.inputs.forEach(a => { put(rr, 0, a.label, null, false); put(rr, 1, a.value, a.format, false); rr++; });
  if (sp.inputs.length) rr++;
  const small = (t) => { ws.getCell(rr, 1).value = t; ws.getCell(rr, 1).font = F({ size: 9, color: { argb: "FF808080" } }); rr++; };
  if (sp.note) small(sp.note);
  if (cols.holder) small("라벨자리: 합계 숫자를 막대 오른쪽에 쓰기 위한 투명 막대(그래프에는 보이지 않음)");
  if (cols.label) small("라벨: 그래프 조각에 쓰는 글자(값·비율에서 수식으로 만듦)");
  if (sp.comboAxis) small("오른쪽 축: " + sp.series.filter(s => s.axis === 1).map(s => s.name).join("·"));
  if (sp.source) small("자료: " + sp.source);
  widths.forEach((w, j) => { ws.getColumn(j + 1).width = Math.min(j === 0 ? 40 : 18, Math.max(j === 0 ? 12 : 10, w)); });
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printArea: `A1:R${Math.max(20, rr + 2)}` };
  return cols;
}

// figures: [{ spec(원본 명세), no(그림 번호, 없으면 null) }]
// opt.wb: 이 통합문서에 시트를 더한다(표 시트와 합칠 때), opt.returnWb: 쓰지 않고 { wb, charts, sheets, skipped }를 돌려준다
// opt.palette: 계열 색을 정하지 않은 명세의 기본 색 순서(중계 서버는 서식 설정의 차트 색 — 페이지가 그린 그림과 같게)
// 그리지 않는 차트(scatter·ECharts option)나 형식이 틀린 명세는 건너뛰고 skipped에 이유를 남긴다(표 시트로는 들어갈 수 있음)
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
    const nl = sp.kind === "pie" ? (sp.pieLabel === "none" ? 0 : sp.n) : sp.series.reduce((a, s, q) => a + sp.x.filter((_, i) => sp.labelAt(q, i)).length, 0);
    out.push({ k, sheet: name, title, kind: sp.type, labels: nl + (sp.stacked && sp.showTotal ? sp.n : 0) });
  });
  if (opt.returnWb) return { wb, charts, sheets: out, skipped };
  const buf = await wb.xlsx.writeBuffer();
  return { buffer: await injectCharts(Buffer.from(buf), charts), sheets: out, skipped };
}

module.exports = { buildChartWorkbook, chartXml, injectCharts };
