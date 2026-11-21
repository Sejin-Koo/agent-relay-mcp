// 원본: 계정 스킬 sys-file-builder — 업무 에이전트 중계 서버의 lib/filebuilder/는 이 파일의 사본이다(사본을 직접 고치지 않는다).
// 양쪽 가로 막대(나비형·토네이도) — 같은 항목을 두 대상으로 비교하는 그래프를 PowerPoint·Excel에서 고칠 수 있는 차트로 만든다(2026-11-21).
// 화면·Word·PDF 그림은 업무 에이전트 페이지가 ECharts option(그리드 셋 — 왼쪽 막대 눈금 뒤집음·가운데 항목 이름·오른쪽 막대)으로 그리고,
// 이 모듈은 같은 option(또는 명세 type "butterfly")을 알아보고 PowerPoint·Excel 차트로 바꾼다. chart-spec.js는 페이지에 그대로 들어 있어
// 고치지 않으려고 따로 둔다(페이지를 바꾸지 않고 서버만으로 적용).
// 차트 구조: 가로 누적 막대 하나에 계열 셋 — ① 간격(투명, 음수, 가운데 항목 이름표) ② 왼쪽 대상(음수로 넣고 표시형식으로 양수 표시)
// ③ 오른쪽 대상. 항목 이름은 '간격' 막대의 범주 이름 라벨이라 데이터 표의 항목 열을 고치면 따라 바뀐다. 값 축은 숨긴다(간격만큼 밀려 있음).
"use strict";

const { ROLE, fmt, niceCeil, inkOn } = require("./chart-spec");

const GAP_NAME = "간격";
const arr = (a) => (Array.isArray(a) ? a : a == null ? [] : [a]);
function hex(c) {
  if (typeof c !== "string") return null;
  const k = c.trim();
  if (/^#?[0-9A-Fa-f]{6}$/.test(k)) return k.replace(/^#/, "").toUpperCase();
  if (/^#[0-9A-Fa-f]{3}$/.test(k)) return k.slice(1).split("").map(ch => ch + ch).join("").toUpperCase();
  if (ROLE[k]) return ROLE[k];
  return null;
}
function num(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) v = v.value;
  if (v == null || v === "" || v === "-" || Array.isArray(v)) return null;
  const x = Number(v); return isFinite(x) ? x : null;
}
const sameList = (a, b) => a.length === b.length && a.every((v, i) => String(v) === String(b[i]));
const catData = (ax) => arr(ax && ax.data).map(v => String(v && typeof v === "object" ? v.value : v));

// 원고의 그림 명세가 양쪽 가로 막대인지 본다. 맞으면 정리한 명세, 아니면 null
//   { kind: "butterfly", title, source, unit, x(위에서 아래 순서), left/right: { name, data(양수), color }, labelFormat }
function detect(raw) {
  if (!raw || typeof raw !== "object") return null;
  const done = (o) => finish(Object.assign({ title: raw.title, source: raw.source, unit: raw.unit, note: raw.note, fig_no: raw.fig_no }, o), raw);
  // 1) 명세 type "butterfly": x와 계열 둘(앞 = 왼쪽)
  if (String(raw.type || "").toLowerCase() === "butterfly" && !raw.option) {
    const ss = arr(raw.series);
    if (ss.length !== 2 || !Array.isArray(raw.x) || !raw.x.length) return null;
    const side = (s) => ({ name: String(s.name || ""), data: raw.x.map((_, i) => { const v = num(arr(s.data)[i]); return v == null ? null : Math.abs(v); }), color: hex(s.color) });
    return done({ x: raw.x.map(String), left: side(ss[0]), right: side(ss[1]) });
  }
  // 2) ECharts option: 막대 계열이 정확히 둘이고(그 밖은 투명 이름표용 scatter만), 같은 항목 축을 공유하며, 한쪽 막대의 값 축이 뒤집혔거나(inverse) 값이 음수
  const o = raw.option;
  if (!o || typeof o !== "object") return null;
  const ser = arr(o.series).filter(s => s && typeof s === "object");
  const bars = ser.filter(s => s.type === "bar"), rest = ser.filter(s => s.type !== "bar");
  if (bars.length !== 2 || rest.some(s => s.type !== "scatter")) return null;
  if (bars.some(s => s.stack != null && bars.some(t => t !== s && t.stack === s.stack) && !bars.some(t => arr(t.data).some(v => num(v) < 0)))) return null;
  const xa = arr(o.xAxis), ya = arr(o.yAxis);
  const yOf = (s) => ya[Number(s.yAxisIndex) || 0], xOf = (s) => xa[Number(s.xAxisIndex) || 0];
  const cy = bars.map(yOf);
  if (cy.some(a => !a || a.type !== "category" || !Array.isArray(a.data) || !a.data.length)) return null;
  const cats = catData(cy[0]);
  if (!sameList(cats, catData(cy[1]))) return null;
  if (bars.some(s => { const a = xOf(s); return !a || (a.type && a.type !== "value"); })) return null;
  const vals = bars.map(s => cats.map((_, i) => num(arr(s.data)[i])));
  const neg = vals.map(d => d.some(v => v != null && v < 0) && d.every(v => v == null || v <= 0));
  const inv = bars.map(s => !!(xOf(s) && xOf(s).inverse));
  let li;
  if (inv[0] !== inv[1]) li = inv[0] ? 0 : 1;
  else if (neg[0] !== neg[1]) li = neg[0] ? 0 : 1;
  else return null;
  // ECharts 항목 축: inverse면 첫 항목이 위, 아니면 아래 — 위에서 아래 순서로 맞춘다
  const top = !!cy[0].inverse, order = cats.map((_, i) => (top ? i : cats.length - 1 - i));
  const side = (k) => ({ name: String(bars[k].name || ""), data: order.map(i => (vals[k][i] == null ? null : Math.abs(vals[k][i]))), color: hex(bars[k].itemStyle && bars[k].itemStyle.color) });
  const unit = raw.unit || [xOf(bars[0]), xOf(bars[1])].map(a => (a && typeof a.name === "string" ? a.name.trim() : "")).find(Boolean) || "";
  return done({ x: order.map(i => cats[i]), left: side(li), right: side(1 - li), unit });
}

function finish(sp, raw) {
  sp.kind = "butterfly";
  sp.left.color = sp.left.color || ROLE.main;
  sp.right.color = sp.right.color || ROLE.compare;
  if (!sp.left.name) sp.left.name = "왼쪽";
  if (!sp.right.name) sp.right.name = "오른쪽";
  if (sp.left.name === sp.right.name) sp.right.name += " ";
  sp.n = sp.x.length;
  const all = sp.left.data.concat(sp.right.data).filter(v => v != null);
  if (!all.length) return null;
  sp.max = Math.max(...all);
  const dec = all.some(v => Math.round(v) !== v);
  const f = typeof raw.label_format === "string" ? raw.label_format : dec ? "#,##0.0" : "#,##0";
  sp.labelFormat = f.split(";")[0];
  sp.signFormat = `${sp.labelFormat};${sp.labelFormat}`; // 음수(왼쪽)도 양수로 보이게
  sp.title = sp.title || "";
  // finalize가 계열 이름으로 차트를 찾는다 — 첫 계열 = 간격
  sp.series = [{ name: GAP_NAME }, sp.left, sp.right];
  return sp;
}

// ---------- 크기 계산(인치) ----------
function textW(t, pt) {
  let w = 0;
  for (const ch of String(t)) w += /[0-9]/.test(ch) ? 0.56 : /[,.]/.test(ch) ? 0.28 : ch.charCodeAt(0) >= 0x1100 ? 0.95 : 0.6;
  return w * pt / 72;
}
const NAME_PT = 12, LBL_PT = 11;
// 그림 영역 폭(인치)에서 가운데 간격 폭과 값 축 범위를 정한다: [-(G + M), M]
function geometry(sp, plotW) {
  const M = niceCeil(sp.max * 1.08) || 1;
  const nameW = Math.max(...sp.x.map(t => textW(t, NAME_PT))) + 0.25;
  const frac = Math.min(0.42, Math.max(0.1, nameW / plotW));
  const G = +(2 * M * frac / (1 - frac)).toPrecision(3);
  const unitIn = plotW / (2 * M + G); // 값 1의 폭(인치)
  // 막대 안에 숫자가 들어가는지(안 들어가면 막대 바깥으로 옮김)
  const fits = (v) => v != null && v * unitIn >= textW(fmt(v, sp.labelFormat), LBL_PT) + 0.1;
  return { M, G, min: -(G + M), max: M, unitIn, fits };
}

const PLOT_LAYOUT = (y, h) => `<c:layout><c:manualLayout><c:layoutTarget val="inner"/><c:xMode val="edge"/><c:yMode val="edge"/><c:x val="0.02"/><c:y val="${y}"/><c:w val="0.96"/><c:h val="${h}"/></c:manualLayout></c:layout>`;

// ---------- PowerPoint ----------
function addPptx(slide, pres, sp, box, font) {
  const T = pres.ChartType || pres.charts;
  const plotW = Math.max(2, box.w * 0.96), plotH = Math.max(1, box.h - 0.55); // 그림 영역 = 차트 폭의 96%(PLOT_LAYOUT)
  const g = geometry(sp, plotW);
  sp.__g = g; sp.__box = { w: box.w, h: box.h, plotW, plotH };
  const data = [
    { name: GAP_NAME, labels: sp.x, values: sp.x.map(() => -g.G) },
    { name: sp.left.name, labels: sp.x, values: sp.left.data.map(v => (v == null ? null : -v)) },
    { name: sp.right.name, labels: sp.x, values: sp.right.data.map(v => (v == null ? null : v)) },
  ];
  slide.addChart(T.bar, data, {
    x: box.x, y: box.y, w: box.w, h: box.h, showTitle: false,
    barDir: "bar", barGrouping: "stacked", barGapWidthPct: 45, overlap: 100,
    chartColors: ["FFFFFF", sp.left.color, sp.right.color],
    showLegend: true, legendPos: "t", legendFontSize: 11, legendFontFace: font, legendColor: "404040",
    catAxisOrientation: "maxMin", catAxisHidden: true, valAxisHidden: true,
    // 값 축 범위는 좌우 대칭으로 고정 [-(간격 + M), M] — 가운데 간격(항목 이름)이 차트 가운데에 오고 범례도 그 위 가운데(2026-11-21 사용자 요청).
    // '데이터 편집'으로 값을 M보다 키우면 축 최소·최대값도 고쳐야 한다(내장 통합문서 안내 줄)
    valAxisMaxVal: g.max, valAxisMinVal: g.min, valGridLine: { style: "none" }, catGridLine: { style: "none" },
    showValue: true, dataLabelFormatCode: sp.signFormat, dataLabelPosition: "inEnd", dataLabelColor: "FFFFFF", dataLabelFontBold: true,
    dataLabelFontFace: font, dataLabelFontSize: LBL_PT,
  });
}

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const serName = (ser) => { const m = ser.match(/<c:tx>[\s\S]*?<c:v>([\s\S]*?)<\/c:v>/); return m ? m[1] : ""; };
function rprXml(font, sz, color, b) {
  return `<a:defRPr sz="${sz}" b="${b ? 1 : 0}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${esc(font)}"/><a:ea typeface="${esc(font)}"/></a:defRPr>`;
}
const txPr = (font, sz, color, b) => `<c:txPr><a:bodyPr wrap="none" lIns="0" rIns="0"/><a:lstStyle/><a:p><a:pPr>${rprXml(font, sz, color, b)}</a:pPr><a:endParaRPr lang="ko-KR"/></a:p></c:txPr>`;
const SHOW = (val, cat) => `<c:showLegendKey val="0"/><c:showVal val="${val}"/><c:showCatName val="${cat}"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>`;
const NOFILL = "<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>";

// 간격 계열의 라벨: 가운데 항목 이름(범주 이름)
function gapLabels(font) {
  return `<c:dLbls>${NOFILL}${txPr(font, NAME_PT * 100, "262626", true)}<c:dLblPos val="ctr"/>${SHOW(0, 1)}</c:dLbls>`;
}
// 대상 계열 라벨: 막대 안쪽 바깥 끝(inEnd)에 흰 숫자, 막대가 짧아 안 들어가면 막대 바깥(계열 색)으로 옮긴다.
// 왼쪽(음수 누적 조각)의 inEnd는 Office·LibreOffice가 바깥 끝에 그리지만, 휴대폰 보기 앱 중에는 가운데 쪽 끝에 그리는 것이 있다(2026-11-21 사용자 실측).
// 보조 축(뒤집음)으로 왼쪽을 양수로 그리는 방식은 LibreOffice가 보조 축 막대를 겹쳐 그려 쓰지 않았다
// dir: 왼쪽 -1, 오른쪽 +1. chartW·unitIn: 이동 거리를 차트 폭 비율로 바꾸는 데 쓴다
function sideLabels(sp, side, dir, font, chartW, pt) {
  pt = pt || LBL_PT;
  const g = sp.__g, nf = `<c:numFmt formatCode="${esc(sp.signFormat)}" sourceLinked="0"/>`;
  const lw = (v) => textW(fmt(v, sp.labelFormat), pt);
  let x = "<c:dLbls>";
  if (dir < 0) {
    // 왼쪽(음수 누적 조각): 'inEnd'를 바깥 끝에 그리는 프로그램(PowerPoint·LibreOffice)과 가운데 쪽 끝에 그리는 프로그램(일부 휴대폰 보기 앱)이
    // 갈려(2026-11-21 사용자 실측), 어디서나 같은 '가운데(ctr)'에 두고 점마다 바깥 끝 안쪽까지 옮긴다. 그림 영역·축 범위를 고정해 두어서
    // 값 1의 폭(차트 폭 대비) u를 정확히 안다. 막대가 짧으면 바깥 끝 밖으로. ※ '데이터 편집'으로 값을 바꾸면 이 위치는 따라가지 않는다
    const u = 0.96 / (2 * g.M + g.G);
    side.data.forEach((v, i) => {
      if (v == null) { x += `<c:dLbl><c:idx val="${i}"/><c:delete val="1"/></c:dLbl>`; return; }
      const fit = g.fits(v), half = (lw(v) / 2 + 0.08) / chartW;
      const dx = -(v / 2) * u + (fit ? half : -half);
      x += `<c:dLbl><c:idx val="${i}"/><c:layout><c:manualLayout><c:x val="${dx.toFixed(4)}"/><c:y val="0"/></c:manualLayout></c:layout>` +
        `${nf}${NOFILL}${txPr(font, pt * 100, fit ? inkOn(side.color) : side.color, true)}<c:dLblPos val="ctr"/>${SHOW(1, 0)}</c:dLbl>`;
    });
    // 옮긴 라벨에 이끌선이 그려지지 않게(표준 요소 + Office 2013 확장)
    return x + `${nf}${NOFILL}${txPr(font, pt * 100, inkOn(side.color), true)}<c:dLblPos val="ctr"/>${SHOW(1, 0)}<c:showLeaderLines val="0"/>` +
      `<c:extLst><c:ext uri="{CE6537A1-D6FC-4f65-9D91-7224C49458BB}" xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart"><c15:showLeaderLines val="0"/></c:ext></c:extLst></c:dLbls>`;
  }
  // 오른쪽(양수): 막대 안쪽 바깥 끝(inEnd) — 어느 프로그램에서나 같다. 짧으면 바깥으로
  side.data.forEach((v, i) => {
    if (v == null) { x += `<c:dLbl><c:idx val="${i}"/><c:delete val="1"/></c:dLbl>`; return; }
    if (g.fits(v)) return;
    const dx = (lw(v) + 0.16) / chartW;
    x += `<c:dLbl><c:idx val="${i}"/><c:layout><c:manualLayout><c:x val="${dx.toFixed(4)}"/><c:y val="0"/></c:manualLayout></c:layout>` +
      `${nf}${NOFILL}${txPr(font, pt * 100, side.color, true)}<c:dLblPos val="inEnd"/>${SHOW(1, 0)}</c:dLbl>`;
  });
  return x + `${nf}${NOFILL}${txPr(font, pt * 100, inkOn(side.color), true)}<c:dLblPos val="inEnd"/>${SHOW(1, 0)}</c:dLbls>`;
}

// pptxgenjs가 만든 차트 XML을 다듬는다: 간격 막대 투명 + 가운데 항목 이름, 숫자 라벨 위치·색, 범례에서 간격 빼기, 축 숨김
function fixPptxXml(xml, sp, font) {
  font = font || "맑은 고딕";
  const chartW = sp.__box ? sp.__box.w : 8;
  xml = xml.replace(/<c:barChart>[\s\S]*?<\/c:barChart>/, (bc) => bc.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (ser) => {
    const nm = serName(ser);
    // invertIfNegative가 없으면 PowerPoint는 기본값(뒤집음)으로 음수 막대를 흰색으로 그린다(2026-11-21 사용자 확인 — LibreOffice는 무시해 미리보기에 안 보임)
    if (!/<c:invertIfNegative /.test(ser)) ser = ser.replace(/(<\/c:tx>\s*<c:spPr>[\s\S]*?<\/c:spPr>)/, '$1<c:invertIfNegative val="0"/>');
    const strip = (s) => s.replace(/<c:dLbls>[\s\S]*?<\/c:dLbls>/, "");
    if (nm === GAP_NAME) {
      ser = strip(ser).replace(/(<\/c:tx>\s*)<c:spPr>[\s\S]*?<\/c:spPr>/, `$1${NOFILL}`);
      return ser.replace(/(<c:invertIfNegative[^>]*\/>)/, `$1${gapLabels(font)}`);
    }
    const left = nm === esc(sp.left.name), right = nm === esc(sp.right.name);
    if (!left && !right) return ser;
    ser = strip(ser);
    const lbl = sideLabels(sp, left ? sp.left : sp.right, left ? -1 : 1, font, chartW);
    return /<c:invertIfNegative[^>]*\/>/.test(ser) ? ser.replace(/(<c:invertIfNegative[^>]*\/>)/, `$1${lbl}`) : ser.replace(/(<c:cat>)/, `${lbl}$1`);
  }));
  // 그림 영역을 좌우 대칭으로 고정 — 범례(위 가운데)가 가운데 항목 이름 위에 온다
  xml = xml.replace("<c:plotArea><c:layout/>", "<c:plotArea>" + PLOT_LAYOUT(0.12, 0.86));
  // 음수 막대 색이 뒤집히지 않게
  xml = xml.replace(/<c:invertIfNegative val="1"\/>/g, '<c:invertIfNegative val="0"/>');
  // 범례에서 간격(idx 0) 빼기
  if (!/<c:legendEntry>/.test(xml)) xml = xml.replace(/<c:legend>\s*<c:legendPos val="([a-z]+)"\/>/, '<c:legend><c:legendPos val="$1"/><c:legendEntry><c:idx val="0"/><c:delete val="1"/></c:legendEntry>');
  return xml;
}

// PowerPoint 내장 통합문서에 읽는 법 한 줄(데이터 편집을 연 사람용)
function note(sp) {
  return `읽는 법: 왼쪽 막대(${sp.left.name}) 값은 왼쪽으로 그리려고 음수로 넣었습니다(그래프에는 양수로 보임). '${GAP_NAME}' 열은 가운데 항목 이름을 쓰기 위한 투명 막대입니다. 값을 ${fmt(sp.__g ? sp.__g.M : sp.max, sp.labelFormat)}보다 크게 바꾸면 차트의 가로 축(숨김) 최소·최대값도 함께 고치세요. 왼쪽 막대 숫자는 막대 끝에 맞춰 자리를 정해 두어, 값을 바꾸면 숫자를 손으로 옮겨야 할 수 있습니다.`;
}

// ---------- Excel 그림자료 ----------
// 시트: A 항목 · B 왼쪽 값 · C 오른쪽 값(원래 양수 — 고치는 칸) · E 간격 · F 왼쪽(그래프용 = -B) — 차트는 E·F·C를 그린다
function writeSheet(ws, sp, title, font, R0, BOX, fill1) {
  const F = (o) => Object.assign({ name: font, size: 10 }, o || {});
  ws.getCell("A1").value = title; ws.getCell("A1").font = F({ bold: true, size: 12, color: { argb: "FF1F3864" } });
  ws.getCell("H2").value = { richText: [
    { text: "■ ", font: F({ bold: true, color: { argb: "FF" + sp.left.color } }) }, { text: sp.left.name + "(왼쪽)    ", font: F({ color: { argb: "FF404040" } }) },
    { text: "■ ", font: F({ bold: true, color: { argb: "FF" + sp.right.color } }) }, { text: sp.right.name + "(오른쪽)", font: F({ color: { argb: "FF404040" } }) },
  ] };
  const g = geometry(sp, 0.96 * 640 / 96);
  sp.__gx = g;
  const heads = ["항목", sp.left.name, sp.right.name, null, GAP_NAME, sp.left.name + "(그래프용)"];
  heads.forEach((h, j) => {
    if (h == null) return;
    const cell = ws.getCell(3, j + 1); cell.value = h; cell.font = F({ bold: true, color: { argb: "FFFFFFFF" } });
    cell.fill = fill1(j >= 4 ? "8EA9DB" : "2E5395"); cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true }; cell.border = BOX;
  });
  const put = (r, j, v, nf, gray) => {
    const cell = ws.getCell(r, j + 1); cell.value = v; cell.border = BOX; cell.font = F(gray ? { color: { argb: "FF808080" } } : {});
    if (nf) { cell.numFmt = nf; cell.alignment = { horizontal: "right" }; } else cell.alignment = { horizontal: "left" };
  };
  const r1 = R0 + sp.n - 1, gapCell = `$B$${r1 + 2}`;
  for (let i = 0; i < sp.n; i++) {
    const r = R0 + i;
    put(r, 0, sp.x[i]);
    put(r, 1, sp.left.data[i], sp.labelFormat);
    put(r, 2, sp.right.data[i], sp.labelFormat);
    put(r, 4, { formula: `-${gapCell}`, result: -g.G }, "General", true);
    put(r, 5, { formula: `IF(B${r}="","",-B${r})`, result: sp.left.data[i] == null ? "" : -sp.left.data[i] }, sp.signFormat, true);
  }
  put(r1 + 2, 0, "가운데 간격 폭");
  put(r1 + 2, 1, g.G, "General");
  let rr = r1 + 4;
  const small = (t) => { ws.getCell(rr, 1).value = t; ws.getCell(rr, 1).font = F({ size: 9, color: { argb: "FF808080" } }); rr++; };
  small(`값은 B·C열(${sp.left.name}·${sp.right.name})만 고치면 됩니다. E·F열은 그래프용으로 자동 계산됩니다.`);
  small(`${GAP_NAME}: 가운데 항목 이름을 쓰기 위한 투명 막대(그래프에는 보이지 않음). 항목 이름이 길면 '가운데 간격 폭'을 늘리세요.`);
  small(`${sp.left.name}(그래프용): 왼쪽 막대를 그리려고 B열 값을 음수로 바꾼 값(그래프에는 양수로 보임).`);
  small(`가로 축(숨김)은 좌우 같게 최소 ${fmt(g.min, "#,##0.0")}·최대 ${fmt(g.max, "#,##0.0")}로 고정했습니다. 값을 ${fmt(g.M, sp.labelFormat)}보다 크게 바꾸면 축 최소·최대값도 고치세요. 왼쪽 막대 숫자는 막대 끝에 맞춰 자리를 정해 두어, 값을 바꾸면 숫자를 손으로 옮겨야 할 수 있습니다.`);
  if (sp.note) small(sp.note);
  if (sp.source) small("자료: " + String(sp.source).replace(/^\s*자료\s*[:：]\s*/, ""));
  [12, 12, 12, 2, 10, 16].forEach((w, j) => { const hw = j === 0 ? Math.max(12, ...sp.x.map(t => String(t).length * 2 + 2)) : w; ws.getColumn(j + 1).width = Math.min(40, hw); });
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printArea: `A1:R${Math.max(20, rr + 2)}` };
  return { cat: "A", left: "F", right: "C", gap: "E", r1 };
}

function xlsxChartXml(sp, sheet, cols, font, title, R0) {
  const g = sp.__gx, sh = `'${sheet.replace(/'/g, "''")}'`, r1 = cols.r1;
  const strRef = (f, vals) => `<c:strRef><c:f>${esc(f)}</c:f><c:strCache><c:ptCount val="${vals.length}"/>` + vals.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join("") + "</c:strCache></c:strRef>";
  const numRef = (f, vals) => `<c:numRef><c:f>${esc(f)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>` + vals.map((v, i) => (v == null ? "" : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join("") + "</c:numCache></c:numRef>";
  const cat = `<c:cat>${strRef(`${sh}!$A$${R0}:$A$${r1}`, sp.x)}</c:cat>`;
  const val = (c, vals) => `<c:val>${numRef(`${sh}!$${c}$${R0}:$${c}$${r1}`, vals)}</c:val>`;
  const head = (k, name, f) => `<c:idx val="${k}"/><c:order val="${k}"/><c:tx>${f ? `<c:strRef><c:f>${esc(f)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${esc(name)}</c:v></c:pt></c:strCache></c:strRef>` : `<c:v>${esc(name)}</c:v>`}</c:tx>`;
  const fillX = (c) => `<c:spPr><a:solidFill><a:srgbClr val="${c}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>`;
  const chartW = 640 / 96; // 차트 상자 H3:R18 약 640px
  // Excel 라벨은 9pt — 막대 안에 들어가는지도 9pt 글자 폭으로 판정
  const save = sp.__g; sp.__g = Object.assign({}, g, { fits: (v) => v != null && v * g.unitIn >= textW(fmt(v, sp.labelFormat), 9) + 0.1 });
  const lblL = sideLabels(sp, sp.left, -1, font, chartW, 9);
  const lblR = sideLabels(sp, sp.right, 1, font, chartW, 9);
  const lbl = (side) => (side === sp.left ? lblL : lblR);
  sp.__g = save;
  const sers =
    `<c:ser>${head(0, GAP_NAME, `${sh}!$E$3`)}${NOFILL}<c:invertIfNegative val="0"/>${gapLabels(font).replace(`sz="${NAME_PT * 100}"`, 'sz="1000"')}${cat}${val("E", sp.x.map(() => -g.G))}</c:ser>` +
    `<c:ser>${head(1, sp.left.name, `${sh}!$B$3`)}${fillX(sp.left.color)}<c:invertIfNegative val="0"/>${lbl(sp.left, -1)}${cat}${val("F", sp.left.data.map(v => (v == null ? null : -v)))}</c:ser>` +
    `<c:ser>${head(2, sp.right.name, `${sh}!$C$3`)}${fillX(sp.right.color)}<c:invertIfNegative val="0"/>${lbl(sp.right, 1)}${cat}${val("C", sp.right.data)}</c:ser>`;
  const ttl = `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr>${rprXml(font, 1100, "1F3864", true)}</a:pPr><a:r><a:rPr lang="ko-KR" sz="1100" b="1"><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill><a:latin typeface="${esc(font)}"/><a:ea typeface="${esc(font)}"/></a:rPr><a:t>${esc(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
  const axes = `<c:catAx><c:axId val="111"/><c:scaling><c:orientation val="maxMin"/></c:scaling><c:delete val="1"/><c:axPos val="l"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="none"/><c:crossAx val="222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>` +
    `<c:valAx><c:axId val="222"/><c:scaling><c:orientation val="minMax"/><c:max val="${g.max}"/><c:min val="${g.min}"/></c:scaling><c:delete val="1"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="none"/><c:crossAx val="111"/><c:crosses val="max"/><c:crossBetween val="between"/></c:valAx>`;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<c:roundedCorners val="0"/><c:chart>' + ttl + '<c:autoTitleDeleted val="0"/><c:plotArea>' + PLOT_LAYOUT(0.2, 0.78) +
    `<c:barChart><c:barDir val="bar"/><c:grouping val="stacked"/><c:varyColors val="0"/>${sers}<c:gapWidth val="45"/><c:overlap val="100"/><c:axId val="111"/><c:axId val="222"/></c:barChart>` + axes +
    '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>' +
    `<c:legend><c:legendPos val="t"/><c:legendEntry><c:idx val="0"/><c:delete val="1"/></c:legendEntry><c:overlay val="0"/>${txPr(font, 900, "404040", false)}</c:legend>` +
    '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>' +
    `<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>${txPr(font, 900, "262626", false)}` +
    '<c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings></c:chartSpace>';
}

// 그림자료 시트 제목 — chart-spec의 fullTitle과 같은 모양("[그림 N] 제목(단위)")
function fullTitle(sp, no) {
  const f = no != null ? no : sp.fig_no, t = sp.title || "";
  const unit = sp.unit && t.indexOf("(" + sp.unit) < 0 ? `(${sp.unit})` : "";
  return (f != null ? `[그림 ${f}] ` : "") + t + unit;
}

module.exports = { detect, addPptx, fixPptxXml, note, writeSheet, xlsxChartXml, fullTitle, GAP_NAME, geometry };
