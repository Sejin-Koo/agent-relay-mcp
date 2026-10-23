// 원본: 계정 스킬 sys-file-builder — 업무 에이전트 중계 서버의 lib/filebuilder/는 이 파일의 사본이다(사본을 직접 고치지 않는다).
// PowerPoint 범위 차트(풋볼필드) — Excel·Word와 같은 색·라벨 규칙을 고칠 수 있는 PowerPoint 차트로.
// pptxgenjs로 누적 가로막대 3계열(투명 하단 · 범위 · 투명 라벨자리)을 만든 뒤, 차트 XML을 xlsx-chart.js의
// rangeChartXml(고정 글자 라벨)로 바꿔 쓴다. 데이터는 차트에 내장된 통합문서에 그대로 남는다.
//
//   const { addRangeChart, finalizeRangeCharts } = require("./pptx-chart");
//   addRangeChart(slide, pres, { title, rows: [{ name, lo, mid, hi, color }], x, y, w, h, font });
//   await pres.writeFile({ fileName }); await finalizeRangeCharts(fileName);
//
// rows 값은 억원. 라벨: 하단(막대 왼쪽)·상단(오른쪽)은 막대 색, 중앙값은 막대 안 흰 글자(막대에 맞춰 9→6pt, 안 되면 생략).

const fs = require("fs");
const JSZip = require("jszip");
const { rangeChartXml } = require("./xlsx-chart");

const PENDING = new WeakMap(); // pres → [spec] (차트를 만든 순서)
const fmt = (v) => Math.round(v).toLocaleString("en-US");

function rangeData(rows, plotPx) {
  const ok = (r) => [r.lo, r.mid, r.hi].every(v => typeof v === "number" && isFinite(v));
  const maxE = Math.max(...rows.filter(ok).map(r => r.hi), 0);
  const AXIS = 1.25, CH_PX = 0.733;
  const d = { cats: [], lo: [], wd: [], gap: [], llo: [], lmid: [], lhi: [], colors: [], midSize: [] };
  rows.forEach(r => {
    const good = ok(r), same = good && Math.round(r.lo) === Math.round(r.hi);
    const w = good ? Math.max(r.hi - r.lo, maxE * 0.006) : 0;
    const txt = good ? fmt(r.mid) : "";
    const fit = Math.floor(((maxE ? w / (maxE * AXIS) : 0) * plotPx - 4) / (CH_PX * Math.max(1, txt.length)));
    const nomid = !good || same || Math.round(r.mid) === Math.round(r.lo) || Math.round(r.mid) === Math.round(r.hi) || fit < 6;
    d.cats.push(r.name); d.lo.push(good ? r.lo : 0); d.wd.push(w); d.gap.push(maxE * 0.15);
    d.llo.push(!good || same ? "" : fmt(r.lo)); d.lmid.push(nomid ? "" : txt); d.lhi.push(!good ? "" : same ? fmt(r.mid) : fmt(r.hi));
    d.colors.push(r.color || "2E5395"); d.midSize.push(Math.min(9, Math.max(6, fit)));
  });
  return d;
}

function addRangeChart(slide, pres, o) {
  const plotPx = Math.round((o.w || 8) * 96 * 0.62);
  const d = rangeData(o.rows, plotPx);
  slide.addChart(pres.charts.BAR, [
    { name: "하단", labels: d.cats, values: d.lo },
    { name: "범위", labels: d.cats, values: d.wd },
    { name: "라벨", labels: d.cats, values: d.gap }
  ], { x: o.x, y: o.y, w: o.w, h: o.h, barDir: "bar", barGrouping: "stacked", showLegend: false, showTitle: false });
  const list = PENDING.get(pres) || [];
  list.push(Object.assign({ title: o.title || "", font: o.font || "맑은 고딕" }, d));
  PENDING.set(pres, list);
  pres.__rangeCharts = list; // writeFile 뒤 finalizeRangeCharts가 읽음
}

// pres.writeFile 뒤에 부른다. 차트 파일 순서 = addRangeChart 순서(다른 차트가 섞이면 chartIndex로 지정)
async function finalizeRangeCharts(fileName, pres, opts) {
  const list = (pres && pres.__rangeCharts) || (opts && opts.list) || [];
  if (!list.length) return;
  const zip = await JSZip.loadAsync(fs.readFileSync(fileName));
  const files = Object.keys(zip.files).filter(f => /^ppt\/charts\/chart\d+\.xml$/.test(f)).sort((a, b) => +a.match(/(\d+)\.xml$/)[1] - +b.match(/(\d+)\.xml$/)[1]);
  const idx = (opts && opts.chartFiles) || files.slice(0, list.length);
  for (let i = 0; i < list.length; i++) {
    const old = await zip.file(idx[i]).async("string");
    const tail = (old.match(/<c:externalData[\s\S]*?<\/c:externalData>|<c:externalData[^>]*\/>/) || [""])[0];
    const s = list[i], n = s.cats.length;
    const xml = rangeChartXml(Object.assign({ sheet: "Sheet1", r1: 2, r2: n + 1, cols: { lo: "B", wd: "C", gap: "D", llo: "B", lmid: "C", lhi: "D" }, midText: "FFFFFF", midFill: null, staticLabels: true, tail }, s));
    zip.file(idx[i], xml);
  }
  fs.writeFileSync(fileName, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

module.exports = { addRangeChart, finalizeRangeCharts, rangeData };
