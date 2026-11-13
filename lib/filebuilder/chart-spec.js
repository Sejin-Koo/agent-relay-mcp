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

// ECharts option으로 쓴 단순 차트(범주 축 + 막대·꺾은선, 또는 원 하나)를 이 명세로 바꾼다(2026-11-13).
// 에이전트가 강조색·회사별 구성 누적을 option으로 그리면 숫자 라벨·그림자료 엑셀·PowerPoint 차트 규칙이 빠졌다
// (실측: 누적 세로 막대에 숫자가 하나도 없고 범례가 넘겨 보기로 잘림). 투명 막대(폭포·간트)·다른 종류가 섞인 설정은 바꾸지 않는다(null).
function optColor(c) {
  if (typeof c !== "string") return null;
  const k = c.trim();
  if (/^#?[0-9A-Fa-f]{6}$/.test(k)) return k.replace(/^#/, "").toUpperCase();
  if (/^#[0-9A-Fa-f]{3}$/.test(k)) return k.slice(1).split("").map(ch => ch + ch).join("").toUpperCase();
  return null;
}
function optNum(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) v = v.value;
  if (Array.isArray(v)) return null;
  if (v == null || v === "" || v === "-") return null;
  const x = Number(v); return isFinite(x) ? x : null;
}
function fromOption(raw) {
  const o = raw && raw.option;
  if (!o || typeof o !== "object") return null;
  const arr = (a) => (Array.isArray(a) ? a : a ? [a] : []);
  const ser = arr(o.series);
  if (!ser.length || ser.some(s => !s || typeof s !== "object")) return null;
  const transparent = (st) => st && (st.color === "transparent" || st.color === "none" || st.opacity === 0 || /rgba\([^)]*,\s*0\s*\)/.test(String(st.color || "")));
  const base = { title: raw.title, source: raw.source, unit: raw.unit, fig_no: raw.fig_no, note: raw.note };
  if (ser.every(s => s.type === "pie")) {
    if (ser.length !== 1 || !Array.isArray(ser[0].data)) return null;
    const d = ser[0].data.filter(p => p && typeof p === "object" && optNum(p.value) != null);
    if (!d.length || d.length !== ser[0].data.length || d.length > 6) return null;
    const rad = ser[0].radius, inner = Array.isArray(rad) ? parseFloat(rad[0]) : 0;
    const pc = d.map(p => optColor(p.itemStyle && p.itemStyle.color));
    const out = Object.assign(base, { type: inner > 0 ? "donut" : "pie", x: d.map(p => String(p.name)), series: [{ name: String(ser[0].name || raw.title || "값"), data: d.map(p => optNum(p.value)) }] });
    if (pc.every(Boolean)) out.point_colors = pc;
    return out;
  }
  if (!ser.every(s => s.type === "bar" || s.type === "line")) return null;
  if (ser.some(s => transparent(s.itemStyle) || (Array.isArray(s.data) && s.data.some(p => p && typeof p === "object" && transparent(p.itemStyle))))) return null;
  const xa = arr(o.xAxis), ya = arr(o.yAxis);
  const xc = xa.find(a => a && a.type === "category" && Array.isArray(a.data)), yc = ya.find(a => a && a.type === "category" && Array.isArray(a.data));
  const cat = xc || yc;
  if (!cat || (xc && yc)) return null;
  const horiz = !!yc;
  const x = cat.data.map(v => String(v && typeof v === "object" ? v.value : v));
  if (!x.length) return null;
  const series = [];
  for (const s of ser) {
    if (!Array.isArray(s.data) || s.data.length > x.length) return null;
    const data = x.map((_, i) => optNum(s.data[i]));
    series.push({ s, data });
  }
  const bars = ser.filter(s => s.type === "bar"), lines = ser.filter(s => s.type === "line");
  const stacks = bars.map(s => s.stack).filter(v => v != null);
  const stacked = bars.length > 1 && stacks.length === bars.length && stacks.every(v => v === stacks[0]);
  if (bars.length > 1 && stacks.length && !stacked) return null; // 묶음이 여럿인 누적은 그대로 둔다
  if (horiz && lines.length) return null;
  let type;
  if (!lines.length) type = stacked ? "stacked" : horiz ? "hbar" : "bar";
  else if (!bars.length) type = ser.some(s => s.areaStyle) ? "area" : "line";
  else type = "combo";
  const out = Object.assign(base, { type, x, series: series.map(({ s, data }) => {
    const r = { name: String(s.name || ""), data };
    const c = optColor((s.itemStyle && s.itemStyle.color) || (s.lineStyle && s.lineStyle.color));
    if (c) r.color = c;
    if (type === "combo") { r.type = s.type; if (Number(s.yAxisIndex) === 1) r.axis = 1; }
    return r;
  }) });
  if (horiz && stacked) { out.type = "stacked"; out.orient = "h"; }
  if (type === "area" && lines.every(s => s.stack != null)) out.stacked = true;
  // 계열이 하나이고 막대마다 색을 준 강조 막대 → point_colors
  if (series.length === 1 && bars.length === 1) {
    const pc = x.map((_, i) => { const p = ser[0].data[i]; return optColor(p && typeof p === "object" && p.itemStyle && p.itemStyle.color); });
    if (pc.some(Boolean)) out.point_colors = pc.map(c => c || out.series[0].color || PALETTE[0]);
  }
  const vAxis = horiz ? xa[0] : ya[0];
  if (!out.unit && vAxis && typeof vAxis.name === "string" && vAxis.name.trim()) out.unit = vAxis.name.trim();
  if (type === "combo" && ya[1] && typeof ya[1].name === "string") out.axis2_title = ya[1].name;
  if (out.series.some(s => !s.name)) out.series.forEach((s, k) => { if (!s.name) s.name = `계열${k + 1}`; });
  return out;
}
// option 차트 중 바꿀 수 있는 것은 명세로, 아니면 그대로
function simplify(raw) {
  if (!raw || typeof raw !== "object" || !raw.option || (Array.isArray(raw.series) && raw.series.length)) return raw;
  try { return fromOption(raw) || raw; } catch (e) { return raw; }
}
function isBar(raw) { raw = simplify(raw); return !!raw && typeof raw === "object" && !raw.option && BAR_TYPES.indexOf(String(raw.type || "bar").toLowerCase()) >= 0; }
// 이 변환기가 Excel 차트·Word 그림으로 그리는 차트(막대·꺾은선·영역·원·도넛·혼합). 그 밖(scatter·ECharts option)은 자료 표
function isChart(raw) { raw = simplify(raw); return !!raw && typeof raw === "object" && !raw.option && CHART_TYPES.indexOf(String(raw.type || "bar").toLowerCase()) >= 0; }
// 막대·조각 색 위 숫자 색: 밝은 색이면 짙은 글자, 어두운 색이면 흰 글자(누적 막대 안 숫자·도넛 안 비율)
function inkOn(hex) {
  const h = String(hex || "").replace(/^#/, "");
  if (!/^[0-9A-Fa-f]{6}$/.test(h)) return "FFFFFF";
  const c = [0, 2, 4].map(i => { const v = parseInt(h.substr(i, 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return L > 0.36 ? "262626" : "FFFFFF";
}
function niceFloorNeg(v) { return v < 0 ? -niceCeil(-v) : 0; }
function normalize(raw, opt) {
  opt = opt || {};
  raw = simplify(raw);
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
  // 원: 가운데에 작은 원(구멍)을 두고 전체 합계와 (100%)를 쓰며 조각 숫자는 조각 안에(2026-11-13 사용자 결정, 끄기 pie_center: false).
  // 도넛도 가운데에 합계를 쓴다
  const hole = type === "donut" ? 0.55 : type === "pie" && raw.pie_center !== false ? 0.42 : 0;
  const pieLabel = ["both", "percent", "value", "none"].indexOf(String(raw.pie_label || "")) >= 0 ? String(raw.pie_label) : (type === "donut" ? "percent" : "both");
  const percentFormat = raw.percent_format || "0%";
  const pieSum = kind === "pie" ? series[0].data.reduce((a, b) => a + b, 0) : 0;
  const percents = kind === "pie" ? series[0].data.map(v => v / pieSum) : [];
  const spec = {
    title: String(raw.title || ""), fig_no: raw.fig_no != null ? Number(raw.fig_no) : null,
    unit: raw.unit ? String(raw.unit) : "", x_name: String(raw.x_name || "구분"), x, n, series, stacked, sumRow, showTotal,
    orient: raw.orient ? (String(raw.orient).toLowerCase() === "v" ? "v" : "h") : (type === "hbar" ? "h" : "v"),
    pointColors, legend, labelFormat, labelFormats: raw.label_formats || {}, innerFormat: raw.inner_format || "#,##0",
    totalFormat: raw.total_format || labelFormat, totalColor: color(raw.total_color, series[series.length - 1].color),
    totals, peak, kind, type, labels, hole, pieLabel, percentFormat, percents, comboAxis, pieSum,
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
  // 구멍 안 조각 라벨은 두 줄("139,299" / "(66%)") — 고리 폭에 맞게
  spec.pieLines = (i) => {
    const t = spec.pieText(i);
    return spec.pieLabel === "both" ? t.replace(/ \(/, "\n(") : t;
  };
  // 얇은 조각(6% 미만)은 고리 안에 글자가 들어가지 않으므로 바깥에 한 줄로 단다. pieMid = 조각 가운데 각도(위에서 시계 방향, 라디안)
  spec.pieOut = (i) => !!spec.hole && spec.percents[i] < 0.06;
  // 바깥 라벨 자리: 반지름 R(그림 단위)의 1.2배 지점에서 시작해, 앞서 놓은 바깥 라벨과 겹치면 원 둘레 방향(시계 방향)으로 민다.
  // 돌려주는 값 = 조각 i → [dx, dy](기본 자리 = 고리 가운데에서의 이동, 같은 단위). w(i) = 라벨 폭, lh = 줄 높이
  spec.pieOutOffsets = (R, lh, w) => {
    const out = {}, placed = [], rm = R * (1 + spec.hole) / 2;
    for (let i = 0; i < spec.n; i++) {
      if (!spec.pieOut(i)) continue;
      const a = spec.pieMid(i), wi = w(i);
      let x = Math.sin(a) * R * 1.2 + Math.sin(a) * wi / 2, y = -Math.cos(a) * R * 1.2 - (Math.cos(a) > 0 ? lh / 2 : -lh / 2);
      for (let k = 0; k < 20 && placed.some(p => Math.abs(p[0] - x) < (p[2] + wi) / 2 + 2 && Math.abs(p[1] - y) < lh); k++) { x += Math.cos(a) * lh * 0.8; y += Math.sin(a) * lh * 0.8; }
      placed.push([x, y, wi]);
      out[i] = [x - Math.sin(a) * rm, y + Math.cos(a) * rm];
    }
    return out;
  };
  spec.pieMid = (i) => { let a = 0; for (let j = 0; j < i; j++) a += spec.percents[j]; return (a + spec.percents[i] / 2) * 2 * Math.PI; };
  // 가운데 글: 전체 합계와 (100%)
  spec.centerLines = () => (spec.kind === "pie" && spec.hole ? [fmt(spec.pieSum, spec.series[0].labelFormat || spec.labelFormat), "(100%)"] : null);
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

module.exports = { normalize, isBar, isChart, simplify, fromOption, inkOn, fmt, niceCeil, color, ROLE, PALETTE6, CHART_TYPES, figuresFromMarkdown };
