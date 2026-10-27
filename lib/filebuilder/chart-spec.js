// 원본: 계정 스킬 sys-file-builder — 업무 에이전트 중계 서버의 lib/filebuilder/는 이 파일의 사본이다(사본을 직접 고치지 않는다).
// 막대 차트 명세(```chart 블록 JSON) 정리 — Excel 차트(xlsx-bar.js)와 Word용 그림(scripts/chart-png.py)이 같은 결과를 쓴다.
// 형식은 업무 에이전트 ```chart 블록(type·title·unit·x·x_name·series[{name,data}]·source)을 그대로 받고, 아래를 더 받는다.
//   type: "bar"(세로 막대)·"hbar"(가로 막대)·"stacked"(누적 세로)·"line"(꺾은선)·"area"(영역, stacked면 누적)·"pie"(원)·"donut"(도넛)·
//         "combo"(혼합 — series[].type "bar"|"line", series[].axis 1 = 오른쪽 보조축) — 업무 에이전트 ```chart와 같은 뜻. 막대는 orient "h"·"v"로 덮어쓸 수 있다
//   labels: "all"·"last"·"none"(꺾은선·영역·혼합 선의 숫자 라벨), pie_label: "both"(값 (비율), 원 기본)·"percent"(도넛 기본)·"value"·"none",
//   percent_format("0%"), axis_min, axis2_max·axis2_min·axis2_title(보조축)
//   stacked, show_total(누적 막대 오른쪽(위) 합계), sum_row(마지막 행 = 위 행들의 합계)
//   series[].color, series[].formula("=ROUND(C{r}*D{r},1)" — {r}=행 번호, 모든 행), series[].formulas(행별, null=값)
//   point_colors(계열이 하나일 때 막대별 색), legend[{color,text}], label_format("#,##0.0"), label_formats({"5":"0"}),
//   inner_format(누적 막대 안 숫자), axis_title, axis_max, extra_columns[{name,data,format,formulas}], note, fig_no, sheet(시트 이름), bold_rows(굵게 쓸 행 번호, 0부터)
//   inputs[{label,value,format}] — 표 아래 입력값 칸. 수식에서 {in1}·{in2}…로 참조, cell_format(자료 칸 표시형식)
//   그림 미세조정(Word 그림만): height_in, label_offset(값축 단위), legend_top(0~1)
// 색은 16진수 또는 의미 이름 — main(남색 2E5395)·detail(청록 2A9478)·compare(주황 D2601A) (ref-report-visualization 3절).
"use strict";

const ROLE = { main: "2E5395", detail: "2A9478", compare: "D2601A", navy: "2E5395", teal: "2A9478", orange: "D2601A", gray: "7F7F7F" };
const HEX = /^#?[0-9A-Fa-f]{6}$/;

function color(c, fallback) {
  if (c == null || c === "") return fallback;
  const k = String(c).trim();
  if (ROLE[k.toLowerCase()]) return ROLE[k.toLowerCase()];
  if (HEX.test(k)) return k.replace(/^#/, "").toUpperCase();
  throw new Error(`색을 알 수 없습니다: ${c} (16진수 6자리 또는 main·detail·compare)`);
}

// Excel 표시형식 → 숫자 문자열(Word 그림·라벨 캐시용). "#,##0.0" "0" "0%" "#,##0" 정도만 쓴다.
function fmt(v, f) {
  if (v == null || !isFinite(v)) return "";
  f = f || "#,##0";
  const pct = /%$/.test(f);
  const m = f.match(/\.(0+)/);
  const dec = m ? m[1].length : 0;
  const x = pct ? v * 100 : v;
  let s = Math.abs(x).toFixed(dec);
  if (/,/.test(f)) { const p = s.split("."); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ","); s = p.join("."); }
  return (x < 0 ? "-" : "") + s + (pct ? "%" : "");
}

function niceCeil(v) {
  if (!(v > 0)) return 1;
  const m = Math.pow(10, Math.floor(Math.log10(v)) - 1);
  return +(Math.ceil(v / m - 1e-9) * m).toPrecision(12);
}

const PALETTE = ["2E5395", "2A9478", "D2601A"];
// 계열·조각이 셋보다 많을 때 이어 쓰는 색(앞 셋 + 보라·황토·자주 — dataviz validate_palette.js 6색 검증 통과, 흰 배경)
const PALETTE6 = ["2E5395", "2A9478", "D2601A", "7B4FA8", "B5892E", "C2477A"];

const BAR_TYPES = ["bar", "hbar", "stacked"];
const CHART_TYPES = BAR_TYPES.concat(["line", "area", "pie", "donut", "combo"]);
function isBar(raw) { return !!raw && typeof raw === "object" && !raw.option && BAR_TYPES.indexOf(String(raw.type || "bar").toLowerCase()) >= 0; }
// 이 변환기가 Excel 차트·Word 그림으로 그리는 차트(막대·꺾은선·영역·원·도넛·혼합). 그 밖(scatter·ECharts option)은 자료 표
function isChart(raw) { return !!raw && typeof raw === "object" && !raw.option && CHART_TYPES.indexOf(String(raw.type || "bar").toLowerCase()) >= 0; }
function niceFloorNeg(v) { return v < 0 ? -niceCeil(-v) : 0; }
function normalize(raw, opt) {
  opt = opt || {};
  if (!raw || typeof raw !== "object") throw new Error("차트 명세가 JSON 객체가 아닙니다");
  const type = String(raw.type || "bar").toLowerCase();
  if (!isChart(raw)) throw new Error(`이 명령이 그리는 차트는 bar·hbar·stacked·line·area·pie·donut·combo입니다(type: ${raw.option ? "ECharts option" : raw.type})`);
  const kind = BAR_TYPES.indexOf(type) >= 0 ? "bar" : type === "donut" ? "pie" : type;
  const custom = Array.isArray(opt.palette) && opt.palette.length;
  const PAL = custom ? opt.palette.map(c => color(c, "2E5395")) : ((raw.series || []).length > 3 || kind === "pie" ? PALETTE6 : PALETTE);
  const x = (raw.x || []).map(String);
  if (!x.length) throw new Error("x(범주)가 없습니다");
  const series = (raw.series || []).map((s, k) => {
    const data = (s.data || []).map(v => (v == null || v === "" ? null : Number(v)));
    if (data.length !== x.length) throw new Error(`계열 '${s.name || k + 1}'의 값 개수(${data.length})가 범주 수(${x.length})와 다릅니다`);
    return { name: String(s.name || `계열${k + 1}`), data, color: color(s.color, PAL[k % PAL.length]), labelFormat: s.label_format ? String(s.label_format) : "",
      formula: s.formula || null, formulas: Array.isArray(s.formulas) ? s.formulas : null };
  });
  if (!series.length) throw new Error("series가 없습니다");
  const stacked = (!!raw.stacked || type === "stacked") && series.length > 1 && (kind === "bar" || kind === "area");
  const n = x.length;
  if (kind === "pie") {
    if (series.length !== 1) throw new Error("원·도넛 차트는 계열이 하나여야 합니다(x 순서에 맞춘 값 한 계열)");
    if (series[0].data.some(v => v == null || v < 0)) throw new Error("원·도넛 차트 값은 비어 있지 않은 0 이상 숫자여야 합니다");
    if (!(series[0].data.reduce((a, b) => a + b, 0) > 0)) throw new Error("원·도넛 차트 값의 합이 0입니다");
    if (!Array.isArray(raw.point_colors) && n > PAL.length) throw new Error(`원·도넛 차트 조각이 ${n}개입니다 — 색을 돌려 쓰지 않도록 ${PAL.length}개 이하로(작은 조각은 '기타'로 묶어) 명세에 넣으세요`);
    if (raw.sum_row) throw new Error("원·도넛 차트에는 sum_row를 쓰지 않습니다");
  }
  if (kind === "combo") series.forEach((s, k) => {
    const t = String((raw.series[k] || {}).type || (k === 0 ? "bar" : "line")).toLowerCase();
    if (t !== "bar" && t !== "line") throw new Error(`혼합 차트 계열 '${s.name}'의 type은 bar 또는 line입니다`);
    s.type = t; s.axis = Number((raw.series[k] || {}).axis) === 1 ? 1 : 0;
  });
  else series.forEach(s => { s.type = kind === "line" ? "line" : kind === "area" ? "area" : "bar"; s.axis = 0; });
  let pointColors = null;
  if (Array.isArray(raw.point_colors)) {
    if (series.length !== 1) throw new Error("point_colors는 계열이 하나일 때만 씁니다");
    if (raw.point_colors.length !== n) throw new Error("point_colors 개수가 범주 수와 다릅니다");
    pointColors = raw.point_colors.map(c => color(c, series[0].color));
  } else if (kind === "pie") pointColors = x.map((_, i) => PAL[i]);
  const sumRow = !!raw.sum_row;
  // 합계 행 값 검증(명세의 값이 위 행 합과 다르면 오류 — 표·그림·엑셀 숫자가 어긋나지 않게)
  if (sumRow) series.forEach(s => {
    const sum = s.data.slice(0, n - 1).reduce((a, b) => a + (b || 0), 0);
    if (Math.abs(sum - (s.data[n - 1] || 0)) > 0.051) throw new Error(`계열 '${s.name}'의 합계 행 값(${s.data[n - 1]})이 위 행 합(${+sum.toFixed(4)})과 다릅니다`);
  });
  const totals = x.map((_, i) => series.reduce((a, s) => a + (s.data[i] || 0), 0));
  const showTotal = stacked && kind === "bar" && raw.show_total !== false;
  const vals = (ss) => ss.flatMap(s => s.data.filter(v => v != null));
  const ax0 = series.filter(s => s.axis === 0), ax1 = series.filter(s => s.axis === 1);
  const peak = stacked ? Math.max(...totals) : Math.max(0, ...vals(ax0.length ? ax0 : series));
  const low = stacked ? Math.min(0, ...totals) : Math.min(0, ...vals(ax0.length ? ax0 : series));
  const comboAxis = kind === "combo" && ax1.length > 0;
  const legend = Array.isArray(raw.legend) ? raw.legend.map(l => ({ color: l.color === null ? null : color(l.color, "404040"), text: String(l.text || "") }))
    : kind === "pie" ? x.map((c, i) => ({ color: pointColors[i], text: c }))
    : (series.length > 1 ? series.map(s => ({ color: s.color, text: s.name + (comboAxis && s.axis === 1 ? "(오른쪽 축)" : "") })) : []);
  // 라벨 표시형식 기본: 소수가 있는 값이면 한 자리("#,##0.0"), 정수만이면 "#,##0". 계열마다 series[].label_format, 범주마다 label_formats
  const autoFmt = (arr) => (arr.some(v => v != null && Math.abs(v - Math.round(v)) > 1e-9) ? "#,##0.0" : "#,##0");
  const labelFormat = raw.label_format || autoFmt(vals(series));
  series.forEach(s => { if (!s.labelFormat) s.labelFormat = raw.label_format || autoFmt(s.data); });
  // 숫자 라벨: all(점마다) · last(계열 끝 점만) · none. 꺾은선·영역 기본은 점이 8개 이하이고 계열이 셋 이하면 all, 아니면 last
  const labels = ["all", "last", "none"].indexOf(String(raw.labels || "")) >= 0 ? String(raw.labels)
    : (kind === "line" || kind === "area" || kind === "combo") && (n > 8 || series.length > 3) ? "last" : "all";
  const hole = type === "donut" ? 0.55 : 0;
  const pieLabel = ["both", "percent", "value", "none"].indexOf(String(raw.pie_label || "")) >= 0 ? String(raw.pie_label) : (hole ? "percent" : "both");
  const percentFormat = raw.percent_format || "0%";
  const pieSum = kind === "pie" ? series[0].data.reduce((a, b) => a + b, 0) : 0;
  const percents = kind === "pie" ? series[0].data.map(v => v / pieSum) : [];
  const spec = {
    title: String(raw.title || ""), fig_no: raw.fig_no != null ? Number(raw.fig_no) : null,
    unit: raw.unit ? String(raw.unit) : "", x_name: String(raw.x_name || "구분"), x, n, series, stacked, sumRow, showTotal,
    orient: raw.orient ? (String(raw.orient).toLowerCase() === "v" ? "v" : "h") : (type === "hbar" ? "h" : "v"),
    pointColors, legend, labelFormat, labelFormats: raw.label_formats || {}, innerFormat: raw.inner_format || "#,##0",
    totalFormat: raw.total_format || labelFormat, totalColor: color(raw.total_color, series[series.length - 1].color),
    totals, peak, kind, type, labels, hole, pieLabel, percentFormat, percents, comboAxis,
    axisTitle: raw.axis_title != null ? String(raw.axis_title) : (raw.unit ? String(raw.unit) : ""),
    // 혼합(보조축): 막대는 아래쪽(축의 약 57%까지), 꺾은선은 위쪽(보조축 0~최대×1.12)에 놓아 숫자 라벨이 겹치지 않게
    axisMax: raw.axis_max != null ? Number(raw.axis_max) : niceCeil(peak * (stacked ? 1.2 : comboAxis && series.some(s => s.type === "bar") ? 1.75 : 1.18)),
    axisMin: raw.axis_min != null ? Number(raw.axis_min) : niceFloorNeg(low * 1.18),
    axis2Max: comboAxis ? (raw.axis2_max != null ? Number(raw.axis2_max) : niceCeil(Math.max(0, ...vals(ax1)) * 1.12)) : null,
    axis2Min: comboAxis ? (raw.axis2_min != null ? Number(raw.axis2_min) : niceFloorNeg(Math.min(0, ...vals(ax1)) * 1.18)) : null,
    axis2Title: raw.axis2_title != null ? String(raw.axis2_title) : "",
    extra: (raw.extra_columns || []).map(c => ({ name: String(c.name), data: c.data || [], format: c.format || "#,##0.0", formulas: Array.isArray(c.formulas) ? c.formulas : null })),
    inputs: (raw.inputs || []).map(a => ({ label: String(a.label || ""), value: Number(a.value), format: a.format || "#,##0.0" })),
    sheet: raw.sheet ? String(raw.sheet) : "",
    boldRows: Array.isArray(raw.bold_rows) ? raw.bold_rows.map(Number) : [],
    note: raw.note ? String(raw.note) : "", source: raw.source ? String(raw.source).replace(/^\s*자료\s*[:：]\s*/, "") : "",
    heightIn: raw.height_in != null ? Number(raw.height_in) : null, labelOffset: raw.label_offset != null ? Number(raw.label_offset) : null,
    legendTop: raw.legend_top != null ? Number(raw.legend_top) : null,
  };
  spec.labelFmtAt = (i, k) => spec.labelFormats[String(i)] || (k != null ? spec.series[k].labelFormat : spec.labelFormat);
  // 꺾은선·영역·혼합의 선 계열: 라벨을 달 점인가(labels 규칙). 막대·원은 늘 단다(빈 값 제외)
  spec.labelAt = (k, i) => {
    const s = spec.series[k];
    if (s.data[i] == null || spec.labels === "none") return false;
    if (spec.labels === "all" || s.type === "bar") return true;
    let last = -1; s.data.forEach((v, j) => { if (v != null) last = j; }); return i === last;
  };
  // 원·도넛 조각 라벨 글자(Excel 라벨 칸의 수식 결과와 같은 글자)
  spec.pieText = (i) => {
    const v = fmt(spec.series[0].data[i], spec.labelFmtAt(i)), p = fmt(spec.percents[i], spec.percentFormat);
    return spec.pieLabel === "both" ? `${v} (${p})` : spec.pieLabel === "percent" ? p : spec.pieLabel === "value" ? v : "";
  };
  spec.barColor = (k, i) => (spec.pointColors && k === 0 ? spec.pointColors[i] : spec.series[k].color);
  spec.fullTitle = (no) => {
    const f = no != null ? no : spec.fig_no;
    const unit = spec.unit && spec.title.indexOf("(" + spec.unit) < 0 ? `(${spec.unit})` : "";
    return (f != null ? `[그림 ${f}] ` : "") + spec.title + unit;
  };
  return spec;
}

// 원고(마크다운)에서 그림 블록을 순서대로 찾는다 — Word 그림 번호와 같게 매기기 위해 이미지 문단도 센다.
// 결과: [{ no, kind:"chart"|"diagram"|"image", spec }]
function figuresFromMarkdown(md) {
  const out = []; let no = 0;
  const lines = String(md).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^```(chart|diagram)\s*$/i);
    if (fence) {
      let j = i + 1, body = [];
      while (j < lines.length && !/^```\s*$/.test(lines[j])) body.push(lines[j++]);
      no++;
      let spec = null; try { spec = JSON.parse(body.join("\n")); } catch (e) { throw new Error(`그림 ${no}의 ${fence[1]} 블록 JSON을 읽지 못했습니다: ${e.message}`); }
      out.push({ no, kind: fence[1].toLowerCase(), spec });
      i = j; continue;
    }
    if (/^```/.test(lines[i])) { let j = i + 1; while (j < lines.length && !/^```\s*$/.test(lines[j])) j++; i = j; continue; }
    if (/^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(lines[i])) { no++; out.push({ no, kind: "image", spec: null }); }
  }
  return out;
}

module.exports = { normalize, isBar, isChart, fmt, niceCeil, color, ROLE, PALETTE6, CHART_TYPES, figuresFromMarkdown };
