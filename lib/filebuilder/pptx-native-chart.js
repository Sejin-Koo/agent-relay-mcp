// 원본: 계정 스킬 sys-file-builder — 업무 에이전트 중계 서버의 lib/filebuilder/는 이 파일의 사본이다(사본을 직접 고치지 않는다).
// PowerPoint 그래프를 그림이 아니라 고칠 수 있는 PowerPoint 차트(데이터가 든 내장 통합문서 포함)로 넣는다(2026-11-12).
// 명세는 Excel 그림자료·Word 그림과 같은 ```chart 블록(chart-spec.normalize 결과)을 쓴다 — 색·라벨 형식·축 최대값·범례가 같다.
//   addChart(slide, pres, spec, box, font)  슬라이드에 차트를 넣는다(pptxgenjs addChart)
//   finalize(buf, specs)                     pptxgenjs가 못 하는 부분을 차트 XML에서 고친다:
//       누적 막대 합계 라벨용 보조 계열(선)을 안 보이게 + 범례에서 빼기, 꺾은선 라벨 "last"(끝 점만) 처리
// 그리지 않는 차트(scatter·ECharts option)는 이 모듈을 거치지 않고 그림(PNG)으로 들어간다.
"use strict";

const TOTAL_NAME = "합계";

function base(spec, box, font) {
  return {
    x: box.x, y: box.y, w: box.w, h: box.h,
    showTitle: false,
    showLegend: spec.legend.length > 1 || spec.kind === "pie", legendPos: "t", legendFontSize: 11, legendFontFace: font, legendColor: "404040",
    catAxisLabelFontSize: 11, catAxisLabelFontFace: font, catAxisLabelColor: "404040",
    valAxisLabelFontSize: 10, valAxisLabelFontFace: font, valAxisLabelColor: "7F7F7F",
    catAxisLineShow: true, catAxisLineColor: "BFBFBF", valAxisLineShow: false,
    valGridLine: { color: "E5E5E5", size: 0.75 }, catGridLine: { style: "none" },
    dataLabelFontFace: font, dataLabelFontSize: 11,
  };
}

function valAxis(spec, o) {
  if (spec.axisMax != null && isFinite(spec.axisMax)) o.valAxisMaxVal = spec.axisMax;
  if (spec.axisMin != null && isFinite(spec.axisMin)) o.valAxisMinVal = spec.axisMin;
  o.valAxisLabelFormatCode = spec.labelFormat.replace(/\.0+/, "") || "#,##0";
  if (spec.axisTitle) { o.showValAxisTitle = true; o.valAxisTitle = spec.axisTitle; o.valAxisTitleFontSize = 10; o.valAxisTitleColor = "7F7F7F"; o.valAxisTitleFontFace = o.dataLabelFontFace; }
  return o;
}

const rows = (spec, ss) => ss.map(s => ({ name: s.name, labels: spec.x, values: s.data.map(v => (v == null ? null : v)) }));

function addChart(slide, pres, spec, box, font) {
  const T = pres.ChartType || pres.charts;
  const o = base(spec, box, font);
  if (spec.kind === "pie") {
    Object.assign(o, {
      chartColors: spec.pointColors, showLegend: true, legendPos: "r",
      showValue: spec.pieLabel === "both" || spec.pieLabel === "value", showPercent: spec.pieLabel === "both" || spec.pieLabel === "percent",
      dataLabelFormatCode: spec.pieLabel === "percent" ? spec.percentFormat : spec.labelFormat,
      dataLabelPosition: spec.hole ? "ctr" : "outEnd", dataLabelColor: spec.hole ? "FFFFFF" : "404040", dataLabelFontBold: true,
      showLeaderLines: !spec.hole, firstSliceAng: 0,
    });
    if (spec.hole) o.holeSize = Math.round(spec.hole * 100);
    slide.addChart(spec.hole ? T.doughnut : T.pie, rows(spec, spec.series), o);
    return;
  }
  const bars = spec.series.filter(s => s.type === "bar"), lines = spec.series.filter(s => s.type !== "bar");
  const horiz = spec.orient === "h" && spec.kind === "bar";
  const barOpts = {
    barDir: horiz ? "bar" : "col", barGrouping: spec.stacked ? "stacked" : "clustered", barGapWidthPct: 60, overlap: spec.stacked ? 100 : undefined,
    chartColors: spec.pointColors && bars.length === 1 ? spec.pointColors : bars.map(s => s.color),
    showValue: true, dataLabelFormatCode: spec.stacked ? spec.innerFormat : spec.labelFormat,
    dataLabelPosition: spec.stacked ? "ctr" : "outEnd", dataLabelColor: spec.stacked ? "FFFFFF" : null, dataLabelFontBold: true,
  };
  if (horiz) { o.catAxisOrientation = "maxMin"; o.valAxisLabelPos = "high"; }
  const lineOpts = (ss) => ({
    chartColors: ss.map(s => s.color), lineSize: 2.25, lineDataSymbol: "circle", lineDataSymbolSize: 7,
    showValue: spec.labels !== "none", dataLabelFormatCode: ss[0] ? ss[0].labelFormat : spec.labelFormat, dataLabelPosition: "t", dataLabelFontBold: true,
  });
  if (spec.kind === "bar" && !spec.showTotal) {
    Object.assign(o, barOpts);
    if (!spec.stacked && bars.length === 1 && !spec.pointColors) o.dataLabelColor = bars[0].color;
    slide.addChart(T.bar, rows(spec, bars), valAxis(spec, o));
    return;
  }
  if (spec.kind === "bar" && spec.showTotal) {
    // 누적 막대 + 합계: 같은 축에 '합계' 선 계열을 겹쳐 그 라벨만 보이게 한다(선·점·범례는 finalize에서 지움)
    const tot = { name: TOTAL_NAME, labels: spec.x, values: spec.totals };
    slide.addChart([
      { type: T.bar, data: rows(spec, bars), options: barOpts },
      { type: T.line, data: [tot], options: { chartColors: [spec.totalColor], lineSize: 0, lineDataSymbol: "none", showValue: true,
        dataLabelFormatCode: spec.totalFormat, dataLabelPosition: horiz ? "r" : "t", dataLabelColor: spec.totalColor, dataLabelFontBold: true } },
    ], valAxis(spec, Object.assign(o, { barDir: barOpts.barDir })));
    return;
  }
  if (spec.kind === "line") {
    Object.assign(o, lineOpts(lines));
    slide.addChart(T.line, rows(spec, lines), valAxis(spec, o));
    return;
  }
  if (spec.kind === "area") {
    Object.assign(o, { chartColors: lines.map(s => s.color), chartColorsOpacity: spec.stacked ? 85 : 35, barGrouping: spec.stacked ? "stacked" : "standard",
      showValue: spec.labels !== "none", dataLabelFormatCode: spec.labelFormat, dataLabelColor: spec.stacked ? "FFFFFF" : "404040", dataLabelFontBold: true });
    slide.addChart(T.area, rows(spec, lines), valAxis(spec, o));
    return;
  }
  // 혼합: 막대 + 꺾은선(보조축이면 오른쪽 축)
  const sec = spec.comboAxis;
  const parts = [];
  if (bars.length) parts.push({ type: T.bar, data: rows(spec, bars), options: Object.assign({}, barOpts, { chartColors: bars.map(s => s.color), dataLabelFormatCode: bars[0].labelFormat }) });
  const l0 = lines.filter(s => s.axis !== 1), l1 = lines.filter(s => s.axis === 1);
  if (l0.length) parts.push({ type: T.line, data: rows(spec, l0), options: lineOpts(l0) });
  if (l1.length) parts.push({ type: T.line, data: rows(spec, l1), options: Object.assign(lineOpts(l1), { secondaryValAxis: true, secondaryCatAxis: true }) });
  valAxis(spec, o);
  if (sec && l1.length) {
    const a0 = { valAxisMaxVal: o.valAxisMaxVal, valAxisMinVal: o.valAxisMinVal, showValAxisTitle: !!spec.axisTitle, valAxisTitle: spec.axisTitle || undefined, valAxisLabelFormatCode: o.valAxisLabelFormatCode };
    const a1 = { valAxisMaxVal: spec.axis2Max, valAxisMinVal: spec.axis2Min, showValAxisTitle: !!spec.axis2Title, valAxisTitle: spec.axis2Title || undefined,
      valGridLine: { style: "none" }, valAxisLabelFormatCode: (l1[0].labelFormat || "#,##0").replace(/\.0+/, "") };
    o.valAxes = [a0, a1]; o.catAxes = [{ catAxisTitle: "" }, { catAxisHidden: true }];
  }
  slide.addChart(parts, o);
}

// ---------- 차트 XML 다듬기(pptxgenjs가 만든 파일을 받아서) ----------
function serBlocks(xml, tag) {
  const out = [];
  const re = new RegExp(`<c:${tag}>([\\s\\S]*?)</c:${tag}>`, "g");
  let m; while ((m = re.exec(xml))) out.push({ start: m.index, end: m.index + m[0].length, body: m[0] });
  return out;
}
const serName = (ser) => { const m = ser.match(/<c:tx>[\s\S]*?<c:v>([\s\S]*?)<\/c:v>/); return m ? m[1] : ""; };

function fixChartXml(xml, spec) {
  // 1) 누적 막대 합계 계열: 선·표식을 지우고 범례에서 뺀다
  if (spec.showTotal) {
    xml = xml.replace(/<c:lineChart>[\s\S]*?<\/c:lineChart>/, (lc) => lc.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (ser) => {
      if (serName(ser) !== TOTAL_NAME) return ser;
      ser = ser.replace(/(<\/c:tx>\s*)<c:spPr>[\s\S]*?<\/c:spPr>/, "$1<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>");
      if (!/<c:marker>/.test(ser)) ser = ser.replace(/(<c:spPr><a:ln><a:noFill\/><\/a:ln><\/c:spPr>)/, "$1<c:marker><c:symbol val=\"none\"/></c:marker>");
      return ser;
    }));
    const tot = (xml.match(/<c:ser>[\s\S]*?<\/c:ser>/g) || []).find(ser => serName(ser) === TOTAL_NAME);
    const idx = tot && (tot.match(/<c:idx val="(\d+)"\/>/) || [])[1];
    if (idx != null) xml = xml.replace(/<c:legend>\s*<c:legendPos val="([a-z]+)"\/>/, `<c:legend><c:legendPos val="$1"/><c:legendEntry><c:idx val="${idx}"/><c:delete val="1"/></c:legendEntry>`);
  }
  // 2) 원 '값 (비율)': 라벨 표시형식을 지워 값은 원래 형식, 비율은 기본 백분율로(표시형식 하나가 둘 다에 걸려 비율이 0으로 보이는 것 방지)
  if (spec.kind === "pie" && spec.pieLabel === "both") xml = xml.replace(/<c:dLbls>[\s\S]*?<\/c:dLbls>/g, (blk) => blk.replace(/<c:numFmt [^>]*\/>/g, ""));
  // 3) 꺾은선·영역·혼합 선의 라벨 "last": 끝 점 말고는 지운다
  if (spec.labels === "last" && spec.kind !== "pie") {
    xml = xml.replace(/<c:(lineChart|areaChart)>[\s\S]*?<\/c:\1>/g, (blk) => blk.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (ser) => {
      const s = spec.series.find(z => z.name === serName(ser));
      if (!s) return ser;
      let last = -1; s.data.forEach((v, j) => { if (v != null) last = j; });
      const del = s.data.map((_, j) => j).filter(j => j !== last).map(j => `<c:dLbl><c:idx val="${j}"/><c:delete val="1"/></c:dLbl>`).join("");
      return ser.replace(/<c:dLbls>/, "<c:dLbls>" + del);
    }));
  }
  return xml;
}

async function finalize(zip, specs) {
  const names = Object.keys(zip.files).filter(n => /^ppt\/charts\/chart\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  // pptxgenjs의 차트 번호는 프로그램 전체에서 이어지므로(1차 배치에서 쓴 번호를 건너뜀) 파일 이름 순서 = 이번 파일에 넣은 순서
  const warn = [];
  for (let i = 0; i < names.length && i < specs.length; i++) {
    const x = await zip.file(names[i]).async("string");
    const spec = specs[i];
    const want = spec.kind === "pie" ? spec.series[0].name : spec.series[0].name;
    if (x.indexOf(`<c:v>${want.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</c:v>`) < 0) { warn.push(`차트 ${i + 1}: 계열 이름이 맞지 않아 다듬기를 건너뜀`); continue; }
    const y = fixChartXml(x, spec);
    if (y !== x) zip.file(names[i], y);
  }
  return warn;
}

module.exports = { addChart, finalize, fixChartXml, TOTAL_NAME };
