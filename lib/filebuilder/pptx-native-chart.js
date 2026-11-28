// 원본: 계정 스킬 sys-file-builder — 업무 에이전트 중계 서버의 lib/filebuilder/는 이 파일의 사본이다(사본을 직접 고치지 않는다).
// PowerPoint 그래프를 그림이 아니라 고칠 수 있는 PowerPoint 차트(데이터가 든 내장 통합문서 포함)로 넣는다(2026-11-12).
// 명세는 Excel 그림자료·Word 그림과 같은 ```chart 블록(chart-spec.normalize 결과)을 쓴다 — 색·라벨 형식·축 최대값·범례가 같다.
//   addChart(slide, pres, spec, box, font)  슬라이드에 차트를 넣는다(pptxgenjs addChart)
//   finalize(buf, specs)                     pptxgenjs가 못 하는 부분을 차트 XML에서 고친다:
//       누적 막대 합계 라벨용 보조 계열(선)을 안 보이게 + 범례에서 빼기, 꺾은선 라벨 "last"(끝 점만) 처리
// 그리지 않는 차트(scatter·ECharts option)는 이 모듈을 거치지 않고 그림(PNG)으로 들어간다.
"use strict";

// 값 축 범위가 10 미만이면 눈금 간격을 직접 정하고 그 간격의 소수 자리로 눈금 서식을 맞춘다.
// Office는 이런 축에 0.5 간격을 고르는데 서식이 정수(#,##0)라 눈금이 '1, 1, 2, 2'로 겹쳐 보였다(2026-11-28 Office 변환 확인).
function smallAxis(range) {
  if (!(range > 0 && range < 10)) return null;
  const raw = range / 5, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
  const step = +((m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p).toFixed(6);
  const dec = (String(step).split(".")[1] || "").length;
  return { step, fmt: dec ? "#,##0." + "0".repeat(dec) : "#,##0" };
}
const TOTAL_NAME = "합계";
const HOLDER_NAME = "합계(라벨자리)"; // 가로 누적 막대 합계 글자를 다는 투명 막대
const { fmt, niceCeil, inkOn } = require("./chart-spec");
const Butterfly = require("./butterfly");

// ---------- 라벨 겹침 계산용 크기(인치) — 2026-11-13 ----------
// 차트 상자 안의 그림 영역 크기 추정: 위 범례·아래 범주 축·왼쪽 값 축(보조축이면 오른쪽도)을 뺀다
function plotDims(spec) {
  const b = spec.__box || { w: 8, h: 4.5 };
  const legend = spec.kind === "pie" ? false : spec.legend.length > 1;
  return {
    w: Math.max(1, b.w - 0.85 - (spec.comboAxis ? 0.75 : 0) - 0.15),
    h: Math.max(1, b.h - (legend ? 0.5 : 0.15) - 0.42 - (spec.axisTitle ? 0.12 : 0)),
    boxH: b.h, boxW: b.w,
  };
}
// 숫자 라벨 글자 폭(인치) — 맑은 고딕 숫자 0.55em, 쉼표·점 0.28em
function labelW(t, pt) {
  let w = 0;
  for (const ch of String(t)) w += /[0-9]/.test(ch) ? 0.56 : /[,.]/.test(ch) ? 0.28 : ch === "%" ? 0.85 : ch === "-" ? 0.36 : ch.charCodeAt(0) >= 0x1100 ? 0.95 : 0.6;
  return w * pt / 72;
}
const LABEL_PT = 11;
const PIE_LEADER = "7F7F7F"; // 원 바깥 라벨 이끌선 색(모든 형식 같음)
const PIE_PT = 16; // 원·도넛 조각 라벨 — 원 크기에 비해 작다는 사용자 의견(2026-11-13)으로 11 → 16

function base(spec, box, font) {
  return {
    x: box.x, y: box.y, w: box.w, h: box.h,
    showTitle: false,
    showLegend: spec.legend.length > 1 || spec.kind === "pie", legendPos: "t", legendFontSize: 11, legendFontFace: font, legendColor: "404040",
    catAxisLabelFontSize: 11, catAxisLabelFontFace: font, catAxisLabelColor: "404040", catAxisLabelFrequency: 1, // 항목 이름을 건너뛰지 않음(항목이 많은 가로 막대에서 하나 걸러 보이던 것)
    valAxisLabelFontSize: 10, valAxisLabelFontFace: font, valAxisLabelColor: "7F7F7F",
    catAxisLineShow: true, catAxisLineColor: "BFBFBF", valAxisLineShow: false,
    valGridLine: { color: "D9D9D9", size: 0.75 }, catGridLine: { style: "none" },
    dataLabelFontFace: font, dataLabelFontSize: 11,
  };
}

function valAxis(spec, o) {
  if (spec.axisMax != null && isFinite(spec.axisMax)) o.valAxisMaxVal = spec.axisMax;
  if (spec.axisMin != null && isFinite(spec.axisMin)) o.valAxisMinVal = spec.axisMin;
  o.valAxisLabelFormatCode = spec.labelFormat.replace(/\.0+/, "") || "#,##0";
  const sa = spec.kind !== "pie" ? smallAxis((spec.axisMax - (spec.axisMin || 0))) : null;
  if (sa) { o.valAxisMajorUnit = sa.step; o.valAxisLabelFormatCode = sa.fmt; }
  if (spec.axisTitle) { o.showValAxisTitle = true; o.valAxisTitle = spec.axisTitle; o.valAxisTitleFontSize = 10; o.valAxisTitleColor = "7F7F7F"; o.valAxisTitleFontFace = o.dataLabelFontFace; }
  return o;
}

// 묶은 세로 막대: 막대 폭보다 숫자가 넓으면 숫자를 세워(90도) 막대 위에 둔다 — 옆 막대 숫자와 겹치지 않게(2026-11-13 사용자 지적).
// 세운 숫자가 그림 위로 넘치지 않게 값 축 최대값을 늘린다
function rotateIfCrowded(spec, bars, o) {
  const P = plotDims(spec), nb = Math.max(1, bars.length);
  const barW = P.w / Math.max(1, spec.n) / (nb + 0.6);
  let maxW = 0, peak = 0;
  bars.forEach((s) => s.data.forEach((v, i) => { if (v == null) return; maxW = Math.max(maxW, labelW(fmt(v, spec.labelFmtAt(i, spec.series.indexOf(s))), LABEL_PT)); peak = Math.max(peak, v); }));
  if (maxW <= barW * 1.05) return false;
  spec.__rot = true;
  const room = 0.95 - (maxW + 0.12) / P.h;
  if (peak > 0 && room > 0.35) { const need = niceCeil(peak / room); if (!(o.valAxisMaxVal >= need)) o.valAxisMaxVal = need; }
  return true;
}

const rows = (spec, ss) => ss.map(s => ({ name: s.name, labels: spec.x, values: s.data.map(v => (v == null ? null : v)) }));

function addChart(slide, pres, spec, box, font) {
  if (spec.kind === "butterfly") { spec.__font = font; Butterfly.addPptx(slide, pres, spec, box, font); return; }
  const T = pres.ChartType || pres.charts;
  spec.__box = { w: box.w, h: box.h };
  const o = base(spec, box, font);
  if (spec.kind === "pie") {
    Object.assign(o, {
      chartColors: spec.pointColors, showLegend: true, legendPos: "r",
      showValue: spec.pieLabel === "both" || spec.pieLabel === "value", showPercent: spec.pieLabel === "both" || spec.pieLabel === "percent",
      dataLabelFormatCode: spec.pieLabel === "percent" ? spec.percentFormat : spec.labelFormat,
      dataLabelPosition: spec.hole || spec.pieInside ? "ctr" : "outEnd", dataLabelColor: spec.hole || spec.pieInside ? "FFFFFF" : "404040", dataLabelFontBold: true, dataLabelFontSize: PIE_PT,
      showLeaderLines: !spec.hole, firstSliceAng: 0,
    });
    if (spec.hole) o.holeSize = Math.round(spec.hole * 100);
    // 원(구멍 있음): 그림 영역을 고정해(오른쪽 범례 자리를 빼고 가운데 정사각형) 구멍 가운데에 합계 원을 정확히 얹는다
    const legW = Math.min(2.6, Math.max(...spec.x.map(t => labelW(t, 11))) + 0.55);
    const S = Math.max(1, Math.min(box.h - (spec.x.some((_, i) => spec.pieOut(i)) ? 0.9 : 0.3), box.w - legW - 0.5)), cx = (box.w - legW) / 2, cy = box.h / 2;
    if (spec.hole || spec.x.some((_, i) => spec.pieOut(i))) spec.__plot = { x: (cx - S / 2) / box.w, y: (cy - S / 2) / box.h, w: S / box.w, h: S / box.h };
    slide.addChart(spec.hole ? T.doughnut : T.pie, rows(spec, spec.series), o);
    const cl = spec.centerLines && spec.centerLines();
    if (cl) {
      const c = S * spec.hole * 0.9, f1 = Math.max(9, Math.min(20, Math.floor(c * 0.6 / labelW(cl[0], 1)))), f2 = Math.max(9, Math.round(f1 * 0.7));
      slide.addText([{ text: cl[0], options: { bold: true, fontSize: f1, color: "1F3864", breakLine: true } }, { text: cl[1], options: { fontSize: f2, color: "595959" } }],
        { shape: "ellipse", x: +(box.x + cx - c / 2).toFixed(3), y: +(box.y + cy - c / 2).toFixed(3), w: +c.toFixed(3), h: +c.toFixed(3), fill: { color: "FFFFFF" }, line: { color: "D9E2F3", width: 1 },
          fontFace: font, align: "center", valign: "middle", margin: 0 });
    }
    // 바깥으로 뺀 얇은 조각 라벨에 이끌선 — PowerPoint 도넛 차트는 이끌선을 그리지 않아 선 도형으로 직접 그린다(2026-11-13 사용자 지적)
    if (spec.__plot && spec.x.some((_, i) => spec.pieOut(i))) {
      const R = S / 2, lh = PIE_PT * 1.35 / 72;
      spec.__outOff = spec.pieOutOffsets(R, lh, (j) => labelW(spec.pieText(j), PIE_PT) + 0.08);
      for (let i = 0; i < spec.n; i++) {
        if (!spec.pieOut(i) || !spec.pieText(i)) continue;
        const a = spec.pieMid(i), rm = R * (1 + spec.hole) / 2, off = spec.__outOff[i] || [0, 0];
        const hw = (labelW(spec.pieText(i), PIE_PT) + 0.08) / 2, hh = lh / 2;
        // 차트 상자 밖으로 나가는 라벨은 PowerPoint가 상자 안으로 끌어오므로 미리 상자 안 자리로 맞춘다(이끌선 끝과 라벨 자리를 같게)
        const lx = Math.max(-cx + hw + 0.05, Math.min(box.w - cx - hw - 0.05, off[0] + Math.sin(a) * rm)), ly = Math.max(-cy + hh + 0.05, Math.min(box.h - cy - hh - 0.05, off[1] - Math.cos(a) * rm));
        spec.__outOff[i] = [lx - Math.sin(a) * rm, ly + Math.cos(a) * rm];
        const p0 = [Math.sin(a) * R * 0.97, -Math.cos(a) * R * 0.97];
        // 라벨 상자에서 조각에 가장 가까운 점까지(0.04in 띄움)
        let p1 = [Math.max(lx - hw, Math.min(lx + hw, p0[0])), Math.max(ly - hh, Math.min(ly + hh, p0[1]))];
        const d = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        // 라벨은 글상자로 직접 놓는다(차트 라벨 자리는 PowerPoint·LibreOffice마다 달라 선 끝과 어긋남) — 차트 쪽 라벨은 fixChartXml에서 지움
        spec.__outBox = spec.__outBox || {};
        spec.__outBox[i] = 1;
        slide.addText(spec.pieText(i), { x: +(box.x + cx + lx - hw).toFixed(3), y: +(box.y + cy + ly - hh).toFixed(3), w: +(hw * 2).toFixed(3), h: +(hh * 2).toFixed(3),
          fontFace: font, fontSize: PIE_PT, bold: true, color: "404040", align: "center", valign: "middle", margin: 0 });
        if (d < 0.08) continue;
        p1 = [p1[0] - (p1[0] - p0[0]) / d * 0.04, p1[1] - (p1[1] - p0[1]) / d * 0.04];
        const X0 = box.x + cx + p0[0], Y0 = box.y + cy + p0[1], X1 = box.x + cx + p1[0], Y1 = box.y + cy + p1[1];
        slide.addShape(pres.shapes ? pres.shapes.LINE : "line", { x: +Math.min(X0, X1).toFixed(3), y: +Math.min(Y0, Y1).toFixed(3), w: +Math.max(0.001, Math.abs(X1 - X0)).toFixed(3), h: +Math.max(0.001, Math.abs(Y1 - Y0)).toFixed(3),
          flipH: (X1 - X0) * (Y1 - Y0) < 0, line: { color: PIE_LEADER, width: 1 } });
      }
    }
    return;
  }
  const bars = spec.series.filter(s => s.type === "bar"), lines = spec.series.filter(s => s.type !== "bar");
  const horiz = spec.orient === "h" && spec.kind === "bar";
  const barOpts = {
    barDir: horiz ? "bar" : "col", barGrouping: spec.stacked ? "stacked" : "clustered", // 막대 사이 간격(2026-11-24 — 막대가 붙어 답답하다는 지적, Word 그림(막대 폭 = 칸의 60%)과 같은 느낌으로): 계열 하나면 칸의 40%, 묶은 막대는 묶음 사이 80%·막대 사이 8%
    barGapWidthPct: spec.stacked ? 90 : bars.length > 1 ? 80 : 70, overlap: spec.stacked ? 100 : bars.length > 1 ? -8 : undefined,
    chartColors: spec.pointColors && bars.length === 1 ? spec.pointColors : bars.map(s => s.color),
    showValue: true, dataLabelFormatCode: spec.stacked ? spec.innerFormat : spec.labelFormat,
    dataLabelPosition: spec.stacked ? "ctr" : "outEnd", dataLabelColor: spec.stacked ? "FFFFFF" : null, dataLabelFontBold: true,
  };
  if (horiz) { o.catAxisOrientation = "maxMin"; o.valAxisLabelPos = "high"; } // 값 축 제목 위치는 finalize에서 crosses=max로 아래에
  // 항목이 많은 가로 막대(13개 이상)는 항목 이름·숫자를 9pt로 — 차트 높이에 이름이 다 들어가게(계정 보고서 실측 2026-11-24, 17개 항목이 하나 걸러 보임)
  if (horiz && spec.x.length > 12) { o.catAxisLabelFontSize = 9; o.dataLabelFontSize = 9; }
  const lineOpts = (ss) => ({
    chartColors: ss.map(s => s.color), lineSize: 2.25, lineDataSymbol: "circle", lineDataSymbolSize: 7,
    showValue: spec.labels !== "none", dataLabelFormatCode: ss[0] ? ss[0].labelFormat : spec.labelFormat, dataLabelPosition: "t", dataLabelFontBold: true,
  });
  // 차트 범례 대신 위쪽에 색 네모 + 글로 범례를 직접 그린다(막대별 색, 가로 누적 + 합계의 투명 막대처럼 차트 범례로는 맞게 안 되는 경우)
  const drawLegend = () => {
    o.showLegend = false; o.y = +(o.y + 0.32).toFixed(3); o.h = +(o.h - 0.32).toFixed(3);
    const items = spec.legend.filter(l => l.text), tw = items.map(l => labelW(l.text, 11) + 0.38);
    let lx = box.x + (box.w - tw.reduce((a, c) => a + c, 0)) / 2;
    items.forEach((l, i) => {
      slide.addShape(pres.shapes ? pres.shapes.RECTANGLE : "rect", { x: +lx.toFixed(3), y: +(box.y + 0.1).toFixed(3), w: 0.12, h: 0.12, fill: { color: l.color || "404040" }, line: { type: "none" } });
      slide.addText(l.text, { x: +(lx + 0.16).toFixed(3), y: +(box.y + 0.02).toFixed(3), w: +(tw[i] - 0.18).toFixed(3), h: 0.28, fontFace: font, fontSize: 11, color: "404040", margin: 0, valign: "middle" });
      lx += tw[i];
    });
  };
  if (spec.kind === "bar" && !spec.showTotal) {
    Object.assign(o, barOpts);
    if (!spec.stacked && bars.length === 1 && !spec.pointColors) o.dataLabelColor = bars[0].color;
    // 막대별 색(point_colors) + 의미 범례(legend): 차트 범례는 계열 이름 하나만 보여 주므로(실측 2026-11-24 — '실적·정부 목표' 대신 '충전기'), 차트 범례를 끄고 위쪽에 색 네모 + 글로 직접 그린다
    if (spec.pointColors && bars.length === 1 && spec.legend.length) drawLegend();
    valAxis(spec, o);
    if (!spec.stacked && !horiz) rotateIfCrowded(spec, bars, o);
    slide.addChart(T.bar, rows(spec, bars), o);
    return;
  }
  if (spec.kind === "bar" && spec.showTotal && horiz) {
    // 가로 누적 막대 + 합계(2026-11-28 사용자 지적 — 합계 위치가 이상함): PowerPoint는 가로 막대에 꺾은선을 겹치면 선을 가로 방향 범주축에
    // 따로 그려 합계 숫자가 막대 끝이 아닌 엉뚱한 자리에 찍힌다. 엑셀 그림자료와 같게 막대 끝에 투명 막대(HOLDER_NAME, 최대 합계의 15%)를
    // 쌓고 그 막대 안쪽 시작점(inBase)에 합계 글자를 단다(글자·투명 처리·범례 빼기는 finalize)
    const ph = Math.max(...spec.totals.map(t => Math.abs(t || 0))) * 0.15;
    const hold = { name: HOLDER_NAME, labels: spec.x, values: spec.totals.map(() => +ph.toFixed(4)) };
    if (spec.legend.length > 1) drawLegend(); // 차트 범례에서 투명 막대만 빼는 legendEntry는 보기 프로그램마다 지우는 항목이 달라(LibreOffice 실측) 직접 그린다
    slide.addChart(T.bar, rows(spec, bars).concat([hold]), valAxis(spec, Object.assign(o, barOpts, { chartColors: barOpts.chartColors.concat(["FFFFFF"]) })));
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
      valGridLine: { style: "none" }, valAxisLabelFormatCode: (l1[0].labelFormat || "#,##0").replace(/\.0+/, "") + (spec.axis2HideNeg ? ";;0" : "") };
    if (spec.axis2Step) a1.valAxisMajorUnit = spec.axis2Step;
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
  // 1-1) 가로 누적 막대 합계: 투명 막대(HOLDER_NAME)를 안 보이게, 막대마다 합계 글자를 고정 글로 안쪽 시작점(inBase)에, 범례에서 뺀다
  if (spec.showTotal && spec.kind === "bar" && spec.orient === "h") {
    xml = xml.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (ser) => {
      if (serName(ser) !== HOLDER_NAME) return ser;
      ser = ser.replace(/(<\/c:tx>\s*)<c:spPr>[\s\S]*?<\/c:spPr>/, "$1<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>");
      ser = ser.replace(/<c:dPt>[\s\S]*?<\/c:dPt>/g, "");
      const lbl = (i) => `<c:dLbl><c:idx val="${i}"/><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr><a:r><a:rPr lang="ko-KR" altLang="en-US" sz="${LABEL_PT * 100}" b="1"><a:solidFill><a:srgbClr val="${spec.totalColor}"/></a:solidFill></a:rPr><a:t>${esc(fmt(spec.totals[i], spec.totalFormat))}</a:t></a:r></a:p></c:rich></c:tx><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr><c:dLblPos val="inBase"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbl>`;
      const dl = `<c:dLbls>${spec.x.map((_, i) => lbl(i)).join("")}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr><c:dLblPos val="inBase"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>`;
      return /<c:dLbls>[\s\S]*?<\/c:dLbls>/.test(ser) ? ser.replace(/<c:dLbls>[\s\S]*?<\/c:dLbls>/, dl) : ser.replace(/(<c:invertIfNegative[^>]*\/>)/, `$1${dl}`);
    });
  }
  // 2) 원·도넛 조각 라벨: Word 그림·Excel 그림자료와 같은 글자(spec.pieText — "139,299 (66%)")를 조각마다 고정 글로 단다.
  //    표시형식 하나가 값·비율 둘 다에 걸려 비율이 0이 되거나(형식 있음) 천 단위 쉼표가 빠지던(형식 없음) 문제 — 2026-11-13 사용자 지적
  if (spec.kind === "pie" && spec.pieLabel !== "none") {
    let k = 0;
    // 글상자로 직접 놓은 바깥 라벨은 차트 라벨을 지운다
    if (spec.__outBox) xml = xml.replace(/<c:dLbl>\s*<c:idx val="(\d+)"\/>[\s\S]*?<\/c:dLbl>/g, (blk, i) => (spec.__outBox[Number(i)] ? `<c:dLbl><c:idx val="${i}"/><c:delete val="1"/></c:dLbl>` : blk));
    xml = xml.replace(/<c:dLbl>\s*<c:idx val="(\d+)"\/>/g, (m, i) => {
      const t = spec.pieText(Number(i)); k++;
      if (!t) return m;
      if (spec.__outBox && spec.__outBox[Number(i)]) return m;
      const out = spec.pieOut(Number(i)), col = (spec.hole || spec.pieInside) && !out ? inkOn(spec.pointColors[Number(i)]) : "404040";
      // 얇은 조각은 고리 바깥으로 옮긴다(기본 자리 = 고리 가운데 → 바깥 반지름 1.2배 자리)
      let lay = "";
      if (out && spec.__plot && spec.__box) {
        const R = spec.__plot.w * spec.__box.w / 2;
        spec.__outOff = spec.__outOff || spec.pieOutOffsets(R, PIE_PT * 1.35 / 72, (j) => labelW(spec.pieText(j), PIE_PT) + 0.08);
        const o = spec.__outOff[Number(i)] || [0, 0];
        lay = `<c:layout><c:manualLayout><c:x val="${(o[0] / spec.__box.w).toFixed(4)}"/><c:y val="${(o[1] / spec.__box.h).toFixed(4)}"/></c:manualLayout></c:layout>`;
      }
      // 고리 안 라벨은 두 줄(값 / (비율))
      const ps = (spec.hole && !out ? spec.pieLines(Number(i)) : t).split("\n").map(line => `<a:p><a:pPr><a:defRPr/></a:pPr><a:r><a:rPr lang="ko-KR" altLang="en-US" sz="${PIE_PT * 100}" b="1"><a:solidFill><a:srgbClr val="${col}"/></a:solidFill></a:rPr><a:t>${esc(line)}</a:t></a:r></a:p>`).join("");
      return `<c:dLbl><c:idx val="${i}"/>${lay}<c:tx><c:rich><a:bodyPr/><a:lstStyle/>${ps}</c:rich></c:tx>`;
    });
    // 구멍 없는 원(비율만): 얇은 조각 라벨만 바깥(outEnd), 나머지는 조각 안(ctr)
    if (!spec.hole && spec.pieInside) xml = xml.replace(/<c:dLbl><c:idx val="(\d+)"\/>[\s\S]*?<\/c:dLbl>/g, (blk, i) => blk.replace(/<c:dLblPos val="[A-Za-z]+"\/>/, `<c:dLblPos val="${spec.pieOut(Number(i)) ? "outEnd" : "ctr"}"/>`));
    if (spec.__plot) { const L = spec.__plot; xml = xml.replace("<c:plotArea><c:layout/>", `<c:plotArea><c:layout><c:manualLayout><c:layoutTarget val="inner"/><c:xMode val="edge"/><c:yMode val="edge"/><c:x val="${L.x.toFixed(4)}"/><c:y val="${L.y.toFixed(4)}"/><c:w val="${L.w.toFixed(4)}"/><c:h val="${L.h.toFixed(4)}"/></c:manualLayout></c:layout>`); }
    if (!k) xml = xml.replace(/<c:dLbls>[\s\S]*?<\/c:dLbls>/g, (blk) => blk.replace(/<c:numFmt [^>]*\/>/g, ""));
  }
  // 2-1) 막대: 묶은 막대 숫자는 계열 색(Word 그림과 같음), 막대 폭보다 넓으면 세워서. 누적 막대 안 숫자는 막대 색에 맞춰 흰색·짙은 색,
  //      숫자보다 얇거나 좁은 조각은 숫자를 뺀다(겹쳐 읽히지 않음 — 합계는 위에 그대로)
  if (spec.kind === "bar" || spec.kind === "combo") {
    const P = plotDims(spec), range = (spec.axisMax - spec.axisMin) || 1;
    const bars = spec.series.filter(z => z.type === "bar");
    const barW = P.w / Math.max(1, spec.n) / (spec.stacked ? 1.6 : bars.length + 0.6);
    xml = xml.replace(/<c:barChart>[\s\S]*?<\/c:barChart>/, (bc) => bc.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (ser) => {
      const s = spec.series.find(z => z.name === serName(ser));
      if (!s || !/<c:dLbls>/.test(ser)) return ser;
      const k = spec.series.indexOf(s);
      if (spec.stacked) {
        const ink = inkOn(s.color);
        ser = ser.replace(/(<c:dLbls>[\s\S]*?<a:defRPr[^>]*>\s*<a:solidFill><a:srgbClr val=")[0-9A-Fa-f]{6}/, `$1${ink}`);
        // 조각 길이는 값 방향(세로 막대 = 높이, 가로 막대 = 너비), 막대 굵기는 그 반대 방향으로 잰다
        // (2026-11-28: 가로 막대에도 세로 기준을 써서 B사 기타 10처럼 숫자가 들어가는 조각까지 지웠다 — Office 변환으로 확인)
        const H = spec.orient === "h", lenAx = H ? P.w : P.h, thick = (H ? P.h : P.w) / Math.max(1, spec.n) / 1.6;
        const del = s.data.map((v, i) => {
          if (v == null || v === 0) return i;
          const seg = Math.abs(v) / range * lenAx, t = fmt(v, spec.innerFormat), tw = labelW(t, LABEL_PT), th = LABEL_PT * 1.3 / 72;
          return (H ? (seg < tw * 1.1 || thick < th) : (seg < th || tw > thick * 0.98)) ? i : -1;
        }).filter(i => i >= 0);
        if (del.length) ser = ser.replace(/<c:dLbls>/, "<c:dLbls>" + del.map(i => `<c:dLbl><c:idx val="${i}"/><c:delete val="1"/></c:dLbl>`).join(""));
        return ser;
      }
      if (bars.length > 1 && !spec.pointColors) ser = ser.replace(/(<c:dLbls>[\s\S]*?<a:defRPr[^>]*>\s*<a:solidFill><a:srgbClr val=")[0-9A-Fa-f]{6}/, `$1${s.color}`);
      if (spec.__rot) ser = ser.replace(/(<c:dLbls>[\s\S]*?<c:txPr>\s*)<a:bodyPr\/>/, '$1<a:bodyPr rot="-5400000" vert="horz"/>');
      return ser;
    }));
  }
  // 2-1-1) 가로 막대: 범주를 위→아래(maxMin)로 뒤집으면 값 축이 위로 올라가 축 제목이 그림 위에 뜬다(2026-11-28 Office 변환 확인).
  //        값 축이 범주 축의 끝(max)에서 만나게 하고 눈금은 high로 둬야 눈금·제목이 모두 아래에 온다
  //        (Office 변환 실측: max+high 아래·아래, max+nextTo 위·아래, autoZero+high 아래·위, autoZero+low 위·위)
  if ((spec.kind === "bar" || spec.kind === "combo") && spec.orient === "h") {
    xml = xml.replace(/(<c:valAx>[\s\S]*?)<c:crosses val="autoZero"\/>/, '$1<c:crosses val="max"/>');
  }
  // 2-2) 누적 막대 계열선: 막대 사이를 조각 경계끼리 가는 회색 선으로 잇는다(pptxgenjs에 옵션이 없어 XML에 넣음, 2026-11-28).
  //      규격 순서상 barChart 안 axId 앞(gapWidth·overlap 뒤). 가로 누적 + 합계는 넣지 않는다 — 계열을 고를 수 없어 합계용 투명 막대 끝에도 선이 생김(엑셀 그림자료와 같음)
  if (spec.seriesLines && !(spec.showTotal && spec.orient === "h")) xml = xml.replace(/<c:barChart>[\s\S]*?<\/c:barChart>/, (bc) => /<c:serLines>/.test(bc) ? bc : bc.replace(/<c:axId /, '<c:serLines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="7F7F7F"/></a:solidFill></a:ln></c:spPr></c:serLines><c:axId '));
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
  // 4) 꺾은선 숫자 겹침: 같은 범주에서 숫자가 겹치는 계열은 위아래로 벌려 놓고(끝 점만 다는 경우는 점 오른쪽에), 숫자 색은 선 색으로.
  //    차트를 고쳐도 라벨은 데이터에 붙어 있다(위치만 옮김) — 2026-11-13 사용자 지적(영업이익률 끝 점 숫자 겹침)
  if (spec.kind === "line" || spec.kind === "combo") xml = spreadLineLabels(xml, spec);
  return xml;
}


const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// 계열 묶음 라벨 설정(<c:dLbls> 안의 numFmt~show…)으로 점 하나의 라벨(<c:dLbl>)을 만든다 — 위치(layout)·자리(dLblPos)만 바꿔서
function pointLabel(dl, idx, dy, pos) {
  let inner = dl.replace(/^<c:dLbls>|<\/c:dLbls>$/g, "").replace(/<c:dLbl>[\s\S]*?<\/c:dLbl>/g, "").replace(/<c:showLeaderLines[^>]*\/>|<c:leaderLines>[\s\S]*?<\/c:leaderLines>/g, "");
  if (pos) inner = /<c:dLblPos /.test(inner) ? inner.replace(/<c:dLblPos val="[a-zA-Z]+"\/>/, `<c:dLblPos val="${pos}"/>`) : inner.replace(/(<c:showLegendKey)/, `<c:dLblPos val="${pos}"/>$1`);
  const lay = dy ? `<c:layout><c:manualLayout><c:x val="0"/><c:y val="${dy.toFixed(4)}"/></c:manualLayout></c:layout>` : "";
  return `<c:dLbl><c:idx val="${idx}"/>${lay}${inner}</c:dLbl>`;
}
function spreadLineLabels(xml, spec) {
  const P = plotDims(spec);
  const lines = spec.series.map((s, k) => ({ s, k })).filter(z => z.s.type === "line");
  if (!lines.length) return xml;
  const axisOf = (s) => (s.axis === 1 && spec.comboAxis ? [spec.axis2Min || 0, spec.axis2Max || 1] : [spec.axisMin, spec.axisMax]);
  const H = LABEL_PT * 1.35 / 72; // 라벨 한 줄 높이(인치)
  const moves = {}; // 계열 이름 → {idx: {dy, pos}}
  for (let i = 0; i < spec.n; i++) {
    const pts = lines.filter(z => spec.labelAt(z.k, i)).map(z => {
      const [lo, hi] = axisOf(z.s), y = (z.s.data[i] - lo) / ((hi - lo) || 1) * P.h; // 그림 영역 아래에서의 높이(인치)
      return { name: z.s.name, y, p: y };
    });
    if (pts.length < 2) continue;
    pts.sort((a, b) => a.y - b.y);
    let clash = false;
    for (let j = 1; j < pts.length; j++) if (pts[j].y - pts[j - 1].y < H) clash = true;
    if (!clash) continue;
    // 겹치는 무리만 벌린다: 위로 밀고, 무리의 가운데가 원래 자리 가운데에 오게 내린다
    for (let j = 1; j < pts.length; j++) if (pts[j].p < pts[j - 1].p + H) pts[j].p = pts[j - 1].p + H;
    let a = 0;
    while (a < pts.length) {
      let b = a; while (b + 1 < pts.length && pts[b + 1].p - pts[b].p <= H + 1e-6) b++;
      const grp = pts.slice(a, b + 1), shift = grp.reduce((t, q) => t + q.p - q.y, 0) / grp.length;
      grp.forEach(q => { q.p -= shift; });
      a = b + 1;
    }
    const last = spec.labels === "last";
    pts.forEach(q => {
      const dy = -(q.p - q.y) / P.boxH;
      if (Math.abs(dy) < 0.002 && !last) return;
      (moves[q.name] = moves[q.name] || {})[i] = { dy, pos: last ? "r" : null };
    });
  }
  return xml.replace(/<c:lineChart>[\s\S]*?<\/c:lineChart>/g, (blk) => blk.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (ser) => {
    const nm = serName(ser), s = spec.series.find(z => z.name === nm);
    if (!s || nm === TOTAL_NAME) return ser;
    ser = ser.replace(/(<c:dLbls>[\s\S]*?<a:defRPr[^>]*>\s*<a:solidFill><a:srgbClr val=")[0-9A-Fa-f]{6}/, `$1${s.color}`);
    const mv = moves[nm];
    if (!mv) return ser;
    return ser.replace(/<c:dLbls>[\s\S]*?<\/c:dLbls>/, (dl) => {
      let out = dl;
      Object.keys(mv).forEach(i => {
        const re = new RegExp(`<c:dLbl><c:idx val="${i}"/><c:delete val="1"/></c:dLbl>`);
        out = out.replace(re, "");
        out = out.replace(/<c:dLbls>/, "<c:dLbls>" + pointLabel(dl, i, mv[i].dy, mv[i].pos));
      });
      // 같은 idx가 앞뒤로 생기지 않게 idx 순으로 정리
      const items = out.match(/<c:dLbl>[\s\S]*?<\/c:dLbl>/g) || [];
      items.sort((x, y) => Number(x.match(/<c:idx val="(\d+)"/)[1]) - Number(y.match(/<c:idx val="(\d+)"/)[1]));
      return "<c:dLbls>" + items.join("") + out.replace(/<c:dLbl>[\s\S]*?<\/c:dLbl>/g, "").replace(/^<c:dLbls>/, "");
    });
  }));
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
    const y = spec.kind === "butterfly" ? Butterfly.fixPptxXml(x, spec, spec.__font) : fixChartXml(x, spec);
    if (y !== x) zip.file(names[i], y);
    if (spec.kind === "butterfly") { try { await noteEmbedded(zip, names[i], Butterfly.note(spec), spec.n); } catch (e) { warn.push(`차트 ${i + 1}: 데이터 표 안내 줄을 넣지 못함 — ${e.message}`); } }
  }
  return warn;
}

// 차트의 내장 통합문서('데이터 편집'으로 여는 표)에 읽는 법 한 줄을 표 아래에 넣는다(양쪽 가로 막대 — 음수·간격 열 설명)
async function noteEmbedded(zip, chartName, text, n) {
  const rel = chartName.replace(/charts\/(chart\d+\.xml)$/, "charts/_rels/$1.rels");
  const rx = zip.file(rel) && await zip.file(rel).async("string");
  const m = rx && rx.match(/Target="([^"]+\.xlsx)"/);
  if (!m) throw new Error("내장 통합문서를 찾지 못함");
  const path = require("path").posix.normalize(require("path").posix.join("ppt/charts", m[1]));
  const f = zip.file(path); if (!f) throw new Error("내장 통합문서 파일 없음: " + path);
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await f.async("nodebuffer"));
  const ws = wb.worksheets[0];
  const c = ws.getCell(n + 3, 1); c.value = text; c.font = { size: 9, color: { argb: "FF808080" } };
  zip.file(path, Buffer.from(await wb.xlsx.writeBuffer()));
}

module.exports = { addChart, finalize, fixChartXml, TOTAL_NAME };
