"use strict";
// ```chart 명세 → Word 그래프 그림(scripts/chart-png.py) 입력 JSON.
// 계정 chart.js png와 차트 서버(chart-mcp의 acct_basic — 업무 에이전트 기본 그래프)가 같은 입력을 쓰도록 lib에 둔다(2026-11-26).
// 그리지 않는 명세(scatter·ECharts option 등)는 null.
const { normalize, isChart, simplify } = require("./chart-spec");
const Butterfly = require("./butterfly");

function plain(sp) {
  return { title: sp.title, n: sp.n, x: sp.x, orient: sp.orient, stacked: sp.stacked, showTotal: sp.showTotal, seriesLines: !!sp.seriesLines,
    series: sp.series.map(s => ({ name: s.name, data: s.data, color: s.color })),
    barColors: sp.series.map((s, k) => sp.x.map((_, i) => sp.barColor(k, i))),
    legend: sp.legend, labelFormat: sp.labelFormat, labelFormats: sp.labelFormats, innerFormat: sp.innerFormat,
    totalFormat: sp.totalFormat, totalColor: sp.totalColor, totals: sp.totals, axisMax: sp.axisMax, axisTitle: sp.axisTitle,
    heightIn: sp.heightIn, labelOffset: sp.labelOffset, legendTop: sp.legendTop,
    kind: sp.kind, axisMin: sp.axisMin, axis2Max: sp.axis2Max, axis2Min: sp.axis2Min, axis2Title: sp.axis2Title, comboAxis: sp.comboAxis, axis2HideNeg: !!sp.axis2HideNeg, axis2Step: sp.axis2Step || null,
    seriesType: sp.series.map(s => s.type), seriesAxis: sp.series.map(s => s.axis),
    labelMask: sp.series.map((s, k) => sp.x.map((_, i) => sp.labelAt(k, i))),
    labelFmts: sp.x.map((_, i) => sp.labelFmtAt(i)), seriesFmts: sp.series.map((s, k) => sp.x.map((_, i) => sp.labelFmtAt(i, k))),
    hole: sp.hole, pieTexts: sp.kind === "pie" ? sp.x.map((_, i) => sp.pieText(i)) : [],
    pieLines: sp.kind === "pie" && sp.hole ? sp.x.map((_, i) => sp.pieLines(i)) : [], pieOut: sp.kind === "pie" ? sp.x.map((_, i) => sp.pieOut(i)) : [],
    center: sp.centerLines ? sp.centerLines() : null, pieInside: !!sp.pieInside };
}

function pngInput(spec, opt) {
  if (!spec || typeof spec !== "object") return null;
  const bf = Butterfly.detect(spec);
  if (bf) return { kind: "butterfly", title: bf.title, n: bf.n, x: bf.x, series: [], orient: "h", legend: [], axisMax: bf.max,
    left: bf.left, right: bf.right, labelFormat: bf.labelFormat, heightIn: spec.height_in || null };
  const s2 = simplify ? simplify(spec) : spec;
  if (!s2 || s2.option || !Array.isArray(s2.series) || !s2.series.length || !isChart(s2)) return null;
  return plain(normalize(s2, opt || {}));
}

module.exports = { pngInput, plain };
