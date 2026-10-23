// 일반 Excel — 원고(마크다운)의 표 하나가 시트 하나. 표 바로 위 '### 제목'(없으면 절 제목)이 시트 이름이 된다.
// 페이지의 값 표 빌더와 같은 규칙(숫자 열 판단·단위 머리글)에 서식을 더한다: 머리글 바탕색, 테두리, 맑은 고딕,
// 숫자 형식, 열 너비, 틀 고정, 자동 필터, 인쇄 설정. 끝에 '정보' 시트(제목·작성·출처·시트 구성).

const ExcelJS = require("exceljs");

const NUM_CELL = /^[\s(+\-−△▲▼]*\d[\d,]*(\.\d+)?\s*(%p|%|원|억원|조원|백만원|천원|만원|달러|명|건|개|곳|일|개월|년|배|℃|mm|cm|회|세대|주|점|호|위)?\)?\s*$/;
function numParse(s) {
  const t = String(s == null ? "" : s).trim();
  if (!t || !NUM_CELL.test(t)) return null;
  const neg = /^[\s(]*[\-−△▼]/.test(t) || /^\(.*\)$/.test(t);
  const m = t.replace(/,/g, "").match(/\d+(\.\d+)?/);
  if (!m) return null;
  const u = (t.match(/(%p|%|원|억원|조원|백만원|천원|만원|달러|명|건|개|곳|일|개월|년|배|℃|mm|cm|회|세대|주|점|호|위)\)?\s*$/) || [])[1] || "";
  const v = parseFloat(m[0]);
  return { v: neg ? -v : v, unit: u, dec: (m[1] || "").length - (m[1] ? 1 : 0) };
}
function sheetName(raw, used) {
  let s = String(raw || "표").replace(/[\[\]:*?\/\\']/g, " ").replace(/\s+/g, " ").trim().slice(0, 28) || "표";
  const base = s; let n = 2;
  while (used[s]) s = base.slice(0, 26) + " " + n++;
  used[s] = 1;
  return s;
}
function wch(s) { let w = 0; String(s == null ? "" : s).split("").forEach(c => { w += c.charCodeAt(0) > 0x2e80 ? 2 : 1; }); return w; }

async function buildGenericWorkbook(model, DX, st, meta) {
  const font = (st && st.font) || "맑은 고딕";
  const c = (st && st.colors) || {};
  const thBg = c.th_bg || "2E5395", thFg = c.th_fg || "FFFFFF";
  const conf = (st && st.elements && st.elements.confidential) || "";
  const wb = new ExcelJS.Workbook();
  wb.creator = (meta && meta.brand) || "업무 에이전트";
  const used = {};
  const tables = [];
  model.sections.forEach(s => {
    let label = s.heading;
    s.blocks.forEach(b => {
      if (b.type === "h3") label = b.text;
      if (b.type === "table") tables.push({ name: label || s.heading || model.title, t: b });
      if (b.type === "figure") { const ft = DX.figureTable(b.spec); if (ft) tables.push({ name: b.title || label || "그림 자료", t: ft }); }
    });
  });
  const thin = { style: "thin", color: { argb: "FFBFBFBF" } };
  const border = { top: thin, bottom: thin, left: thin, right: thin };
  const setup = (ws, freeze) => {
    ws.views = [Object.assign({ showGridLines: false }, freeze ? { state: "frozen", xSplit: 0, ySplit: freeze } : {})];
    ws.pageSetup = { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true };
    ws.headerFooter = { oddHeader: conf ? `&R&8${conf}` : "", oddFooter: "&C&8&P / &N" };
  };
  if (!tables.length) {
    const ws = wb.addWorksheet(sheetName("내용", used));
    ws.columns = [{ width: 24 }, { width: 100 }];
    const rows = [["구분", "내용"]];
    model.sections.forEach(s => s.blocks.forEach(b => {
      if (b.type === "p" || b.type === "note") rows.push([s.heading || "", DX.plain(b.text)]);
      else if (b.type === "h3") rows.push([s.heading || "", "■ " + b.text]);
      else if (b.type === "bullets") b.items.forEach(it => rows.push([s.heading || "", (it.level ? "  - " : "• ") + DX.plain(it.text)]));
    }));
    rows.forEach((rw, i) => {
      const row = ws.addRow(rw);
      row.eachCell(cell => {
        cell.font = { name: font, size: 10, bold: i === 0, color: { argb: "FF" + (i === 0 ? thFg : "000000") } };
        if (i === 0) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + thBg } };
        cell.border = border; cell.alignment = { vertical: "top", wrapText: true };
      });
    });
    setup(ws, 1);
  }
  tables.forEach(x => {
    const t = x.t;
    let heads = t.headers.slice();
    const colNum = heads.map((h, i) => {
      const cells = t.rows.map(r => String(r[i] == null ? "" : r[i]).trim()).filter(Boolean);
      if (!cells.length) return null;
      const ps = cells.map(numParse);
      if (ps.some(p => !p)) return null;
      const units = {}; ps.forEach(p => { units[p.unit] = 1; });
      const uk = Object.keys(units);
      if (uk.length > 1) return null;
      const dec = ps.reduce((m, p) => Math.max(m, p.dec), 0);
      const year = cells.every(v => /^(19|20)\d{2}$/.test(v)); // 연도 열은 천 단위 구분 없이
      return { unit: uk[0], dec: Math.min(dec, 4), year };
    });
    heads = heads.map((h, i) => { const cn = colNum[i]; return cn && cn.unit && h.indexOf(cn.unit) < 0 ? `${h}(${cn.unit})` : h; });
    const ws = wb.addWorksheet(sheetName(x.name, used));
    const info = DX.colInfo(t.headers, t.rows);
    const hr = ws.addRow(heads);
    hr.eachCell(cell => {
      cell.font = { name: font, size: 10, bold: true, color: { argb: "FF" + thFg } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + thBg } };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = border;
    });
    t.rows.forEach(r => {
      const vals = heads.map((_, i) => {
        const v = r[i] == null ? "" : r[i];
        if (colNum[i]) { const p = numParse(v); return p ? (colNum[i].unit === "%" ? p.v / 100 : p.v) : v; }
        return v;
      });
      const row = ws.addRow(vals);
      heads.forEach((_, i) => {
        const cell = row.getCell(i + 1);
        cell.font = { name: font, size: 10 };
        cell.border = border;
        const cn = colNum[i];
        if (cn && typeof cell.value === "number") {
          cell.numFmt = cn.year ? "0" : cn.unit === "%" ? "0." + "0".repeat(Math.max(1, cn.dec)) + "%" : (cn.dec ? "#,##0." + "0".repeat(cn.dec) : "#,##0");
          cell.alignment = { vertical: "top", horizontal: "right" };
        } else cell.alignment = { vertical: "top", horizontal: (info[i] && info[i].align) || "left", wrapText: true };
      });
    });
    ws.columns.forEach((col, i) => {
      let m = wch(heads[i]);
      t.rows.forEach(r => { m = Math.max(m, wch(r[i])); });
      col.width = Math.min(Math.max(m + 2, 8), 60);
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + t.rows.length, column: heads.length } };
    setup(ws, 1);
  });
  const wsi = wb.addWorksheet(sheetName("정보", used));
  wsi.columns = [{ width: 14 }, { width: 100 }];
  const info = [["제목", model.title], ["작성", model.subtitle || ""]];
  model.source.forEach(s => info.push(["출처", s]));
  if (tables.length) info.push(["시트 구성", `${tables.length}개 표: ` + tables.map((x, i) => `${i + 1}) ${x.name || "표"}`).join(" / ")]);
  info.forEach(rw => {
    const row = wsi.addRow(rw);
    row.getCell(1).font = { name: font, size: 10, bold: true }; row.getCell(2).font = { name: font, size: 10 };
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
  });
  setup(wsi);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildGenericWorkbook };
