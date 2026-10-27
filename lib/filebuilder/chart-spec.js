// 원본: 계정 스킬 sys-file-builder — 업무 에이전트 중계 서버의 lib/filebuilder/는 이 파일의 사본이다(사본을 직접 고치지 않는다).
// 막대 차트 명세(```chart 블록 JSON) 정리 — Excel 차트(xlsx-bar.js)와 Word용 그림(scripts/chart-png.py)이 같은 결과를 쓴다.
// 형식은 업무 에이전트 ```chart 블록(type·title·unit·x·x_name·series[{name,data}]·source)을 그대로 받고, 아래를 더 받는다.
//   type: "bar"(세로 막대)·"hbar"(가로 막대)·"stacked"(누적 세로) — 업무 에이전트 ```chart와 같은 뜻. orient "h"·"v"로 덮어쓸 수 있다
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
  return Math.ceil(v / m - 1e-9) * m;
}

const PALETTE = ["2E5395", "2A9478", "D2601A"];

const BAR_TYPES = ["bar", "hbar", "stacked"];
function isBar(raw) { return !!raw && typeof raw === "object" && !raw.option && BAR_TYPES.indexOf(String(raw.type || "bar").toLowerCase()) >= 0; }
function normalize(raw, opt) {
  opt = opt || {};
  if (!raw || typeof raw !== "object") throw new Error("차트 명세가 JSON 객체가 아닙니다");
  const type = String(raw.type || "bar").toLowerCase();
  if (!isBar(raw)) throw new Error(`이 명령은 막대 차트(bar·hbar·stacked)만 그립니다(type: ${raw.type})`);
  const PAL = Array.isArray(opt.palette) && opt.palette.length ? opt.palette.map(c => color(c, "2E5395")) : PALETTE;
  const x = (raw.x || []).map(String);
  if (!x.length) throw new Error("x(범주)가 없습니다");
  const series = (raw.series || []).map((s, k) => {
    const data = (s.data || []).map(v => (v == null || v === "" ? null : Number(v)));
    if (data.length !== x.length) throw new Error(`계열 '${s.name || k + 1}'의 값 개수(${data.length})가 범주 수(${x.length})와 다릅니다`);
    return { name: String(s.name || `계열${k + 1}`), data, color: color(s.color, PAL[k % PAL.length]),
      formula: s.formula || null, formulas: Array.isArray(s.formulas) ? s.formulas : null };
  });
  if (!series.length) throw new Error("series가 없습니다");
  const stacked = (!!raw.stacked || type === "stacked") && series.length > 1;
  const n = x.length;
  let pointColors = null;
  if (Array.isArray(raw.point_colors)) {
    if (series.length !== 1) throw new Error("point_colors는 계열이 하나일 때만 씁니다");
    if (raw.point_colors.length !== n) throw new Error("point_colors 개수가 범주 수와 다릅니다");
    pointColors = raw.point_colors.map(c => color(c, series[0].color));
  }
  const sumRow = !!raw.sum_row;
  // 합계 행 값 검증(명세의 값이 위 행 합과 다르면 오류 — 표·그림·엑셀 숫자가 어긋나지 않게)
  if (sumRow) series.forEach(s => {
    const sum = s.data.slice(0, n - 1).reduce((a, b) => a + (b || 0), 0);
    if (Math.abs(sum - (s.data[n - 1] || 0)) > 0.051) throw new Error(`계열 '${s.name}'의 합계 행 값(${s.data[n - 1]})이 위 행 합(${+sum.toFixed(4)})과 다릅니다`);
  });
  const totals = x.map((_, i) => series.reduce((a, s) => a + (s.data[i] || 0), 0));
  const showTotal = stacked && raw.show_total !== false;
  const peak = stacked ? Math.max(...totals) : Math.max(...series.flatMap(s => s.data.filter(v => v != null)));
  const legend = Array.isArray(raw.legend) ? raw.legend.map(l => ({ color: l.color === null ? null : color(l.color, "404040"), text: String(l.text || "") }))
    : (series.length > 1 ? series.map(s => ({ color: s.color, text: s.name })) : []);
  const labelFormat = raw.label_format || "#,##0";
  const spec = {
    title: String(raw.title || ""), fig_no: raw.fig_no != null ? Number(raw.fig_no) : null,
    unit: raw.unit ? String(raw.unit) : "", x_name: String(raw.x_name || "구분"), x, n, series, stacked, sumRow, showTotal,
    orient: raw.orient ? (String(raw.orient).toLowerCase() === "v" ? "v" : "h") : (type === "hbar" ? "h" : "v"),
    pointColors, legend, labelFormat, labelFormats: raw.label_formats || {}, innerFormat: raw.inner_format || "#,##0",
    totalFormat: raw.total_format || labelFormat, totalColor: color(raw.total_color, series[series.length - 1].color),
    totals, peak,
    axisTitle: raw.axis_title != null ? String(raw.axis_title) : (raw.unit ? String(raw.unit) : ""),
    axisMax: raw.axis_max != null ? Number(raw.axis_max) : niceCeil(peak * (stacked ? 1.2 : 1.18)),
    extra: (raw.extra_columns || []).map(c => ({ name: String(c.name), data: c.data || [], format: c.format || "#,##0.0", formulas: Array.isArray(c.formulas) ? c.formulas : null })),
    inputs: (raw.inputs || []).map(a => ({ label: String(a.label || ""), value: Number(a.value), format: a.format || "#,##0.0" })),
    sheet: raw.sheet ? String(raw.sheet) : "",
    boldRows: Array.isArray(raw.bold_rows) ? raw.bold_rows.map(Number) : [],
    note: raw.note ? String(raw.note) : "", source: raw.source ? String(raw.source).replace(/^\s*자료\s*[:：]\s*/, "") : "",
    heightIn: raw.height_in != null ? Number(raw.height_in) : null, labelOffset: raw.label_offset != null ? Number(raw.label_offset) : null,
    legendTop: raw.legend_top != null ? Number(raw.legend_top) : null,
  };
  spec.labelFmtAt = (i) => spec.labelFormats[String(i)] || spec.labelFormat;
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

module.exports = { normalize, isBar, fmt, niceCeil, color, ROLE, figuresFromMarkdown };
