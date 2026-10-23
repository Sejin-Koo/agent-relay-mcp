// 원본: 계정 스킬 sys-file-builder — 업무 에이전트 중계 서버의 lib/filebuilder/는 이 파일의 사본이다(사본을 직접 고치지 않는다).
// 엑셀 범위 차트(풋볼필드)를 차트 XML로 직접 쓴다.
// exceljs는 차트를 만들지 못하므로 저장한 뒤 xlsx(zip)에 차트·도면 파트를 끼워 넣는다.
// 막대: 누적 가로막대 3계열 — ① 투명 하단 ② 범위(점별 색) ③ 투명 라벨자리.
// 라벨: ①에 하단(막대 왼쪽), ②에 중앙값(막대 안 흰 글자 — 막대 폭에 맞춘 크기, 6pt로도 안 들어가면 생략), ③에 상단(막대 오른쪽).
// 라벨은 셀 값 방식(c15:datalabelsRange)이라 가정을 바꾸면 라벨 숫자도 따라 바뀐다.

const JSZip = require("jszip");

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const C15 = 'xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart"';

function strCache(vals) {
  return `<c:ptCount val="${vals.length}"/>` + vals.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join("");
}
function numCache(vals) {
  return `<c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>` +
    vals.map((v, i) => `<c:pt idx="${i}"><c:v>${Number(v) || 0}</c:v></c:pt>`).join("");
}
function ref(sheet, col, r1, r2) { return `'${sheet.replace(/'/g, "''")}'!$${col}$${r1}:$${col}$${r2}`; }

function dLbls(cols, pos, opts) {
  const o = opts || {};
  const font = `<a:latin typeface="${esc(o.font)}"/><a:ea typeface="${esc(o.font)}"/>`;
  const plainBox = '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>';
  let out = "";
  cols.forEach((col, i) => {
    if (o.hide && o.hide.has(i)) {
      out += `<c:dLbl><c:idx val="${i}"/><c:delete val="1"/><c:extLst><c:ext uri="{CE6537A1-D6FC-4f65-9D91-7224C49458BB}" ${C15}/></c:extLst></c:dLbl>`;
      return;
    }
    const box = o.fill
      ? `<c:spPr><a:solidFill><a:srgbClr val="${o.fill}"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="${o.edge ? o.edge[i] : col}"/></a:solidFill></a:ln></c:spPr>`
      : plainBox;
    const sz = Math.round(((o.sizes && o.sizes[i]) || 9) * 100);
    const guid = "{" + [o.seed.toString(16).padStart(8, "0").slice(-8), "1A2B", "4C3D", "8E9F", (o.seed * 100 + i).toString(16).padStart(12, "0").slice(-12)].join("-").toUpperCase() + "}";
    if (o.texts) { // 고정 글자 라벨(PowerPoint 차트 — 셀 범위 라벨 대신)
      out += `<c:dLbl><c:idx val="${i}"/><c:layout/>` +
        `<c:tx><c:rich><a:bodyPr wrap="none" lIns="0" rIns="0" tIns="0" bIns="0"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}" b="1"><a:solidFill><a:srgbClr val="${col}"/></a:solidFill>${font}</a:defRPr></a:pPr>` +
        `<a:r><a:rPr lang="ko-KR" sz="${sz}" b="1"><a:solidFill><a:srgbClr val="${col}"/></a:solidFill>${font}</a:rPr><a:t>${esc(o.texts[i])}</a:t></a:r></a:p></c:rich></c:tx>` +
        box + `<c:dLblPos val="${pos}"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbl>`;
      return;
    }
    out += `<c:dLbl><c:idx val="${i}"/><c:layout/>` +
      `<c:tx><c:rich><a:bodyPr wrap="none" lIns="0" rIns="0" tIns="0" bIns="0"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}" b="1"><a:solidFill><a:srgbClr val="${col}"/></a:solidFill>${font}</a:defRPr></a:pPr>` +
      `<a:fld id="${guid}" type="CELLRANGE"><a:rPr lang="ko-KR" sz="${sz}" b="1"><a:solidFill><a:srgbClr val="${col}"/></a:solidFill>${font}</a:rPr><a:pPr><a:defRPr sz="${sz}" b="1"/></a:pPr><a:t>[CELLRANGE]</a:t></a:fld><a:endParaRPr lang="ko-KR"/></a:p></c:rich></c:tx>` +
      box +
      `<c:dLblPos val="${pos}"/><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>` +
      `<c:extLst><c:ext uri="{CE6537A1-D6FC-4f65-9D91-7224C49458BB}" ${C15}><c15:dlblFieldTable/><c15:showDataLabelsRange val="1"/></c:ext></c:extLst></c:dLbl>`;
  });
  if (o.texts) return `<c:dLbls>${out}${plainBox}<c:dLblPos val="${pos}"/><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>`;
  return `<c:dLbls>${out}${plainBox}<c:dLblPos val="${pos}"/><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>` +
    `<c:extLst><c:ext uri="{CE6537A1-D6FC-4f65-9D91-7224C49458BB}" ${C15}><c15:showDataLabelsRange val="1"/><c15:showLeaderLines val="0"/></c:ext></c:extLst></c:dLbls>`;
}
function rangeExt(sheet, col, r1, r2, vals) {
  return `<c:extLst><c:ext uri="{02D57815-91ED-43cb-92C2-25804820EDAC}" ${C15}><c15:datalabelsRange><c15:f>${ref(sheet, col, r1, r2)}</c15:f>` +
    `<c15:dlblRangeCache>${strCache(vals)}</c15:dlblRangeCache></c15:datalabelsRange></c:ext></c:extLst>`;
}
function ser(idx, name, sheet, col, r1, r2, cats, vals, body, tail) {
  return `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/><c:tx><c:v>${esc(name)}</c:v></c:tx>${body}` +
    `<c:cat><c:strRef><c:f>${ref(sheet, "A", r1, r2)}</c:f><c:strCache>${strCache(cats)}</c:strCache></c:strRef></c:cat>` +
    `<c:val><c:numRef><c:f>${ref(sheet, col, r1, r2)}</c:f><c:numCache>${numCache(vals)}</c:numCache></c:numRef></c:val>${tail || ""}</c:ser>`;
}

// spec: { sheet, title, r1, r2, cols: {lo,wd,gap,llo,lmid,lhi}, cats, lo, wd, gap, llo, lmid, lhi, colors, font, midText, midFill }
function rangeChartXml(s) {
  const NOFILL = '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr><c:invertIfNegative val="0"/>';
  const hideLo = new Set(), hideMid = new Set();
  s.llo.forEach((v, i) => { if (!v) hideLo.add(i); });
  s.lmid.forEach((v, i) => { if (!v) hideMid.add(i); });
  // s.staticLabels: PowerPoint 차트용 — 라벨을 셀 범위 대신 고정 글자로(내장 통합문서에 라벨 열이 없음)
  const ST = !!s.staticLabels, ext = (col, vals) => ST ? "" : rangeExt(s.sheet, col, s.r1, s.r2, vals);
  const s1 = ser(0, "하단", s.sheet, s.cols.lo, s.r1, s.r2, s.cats, s.lo,
    NOFILL + dLbls(s.colors, "inEnd", { font: s.font, hide: hideLo, seed: s.r1 * 10 + 1, texts: ST ? s.llo : null }),
    ext(s.cols.llo, s.llo));
  const dpts = s.colors.map((c, i) => `<c:dPt><c:idx val="${i}"/><c:invertIfNegative val="0"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${c}"/></a:solidFill></c:spPr></c:dPt>`).join("");
  const s2 = ser(1, "범위", s.sheet, s.cols.wd, s.r1, s.r2, s.cats, s.wd,
    `<c:spPr><a:solidFill><a:srgbClr val="${s.colors[0]}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>${dpts}` +
    dLbls(s.colors.map(() => s.midText), "ctr", { font: s.font, hide: hideMid, fill: s.midFill, edge: s.colors, sizes: s.midSize, seed: s.r1 * 10 + 2, texts: ST ? s.lmid : null }),
    ext(s.cols.lmid, s.lmid));
  const s3 = ser(2, "라벨", s.sheet, s.cols.gap, s.r1, s.r2, s.cats, s.gap,
    NOFILL + dLbls(s.colors, "inBase", { font: s.font, seed: s.r1 * 10 + 3, texts: ST ? s.lhi : null }),
    ext(s.cols.lhi, s.lhi));
  const font = `<a:latin typeface="${esc(s.font)}"/><a:ea typeface="${esc(s.font)}"/>`;
  const axTx = `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"><a:solidFill><a:srgbClr val="404040"/></a:solidFill>${font}</a:defRPr></a:pPr><a:endParaRPr lang="ko-KR"/></a:p></c:txPr>`;
  const title = `<c:title><c:tx><c:rich><a:bodyPr wrap="none"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1100" b="1"/></a:pPr>` +
    `<a:r><a:rPr lang="ko-KR" sz="1100" b="1"><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill>${font}</a:rPr><a:t>${esc(s.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<c:roundedCorners val="0"/><c:chart>' + title + '<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>' +
    '<c:barChart><c:barDir val="bar"/><c:grouping val="stacked"/><c:varyColors val="0"/>' + s1 + s2 + s3 +
    '<c:gapWidth val="35"/><c:overlap val="100"/><c:axId val="5001"/><c:axId val="5002"/></c:barChart>' +
    '<c:catAx><c:axId val="5001"/><c:scaling><c:orientation val="maxMin"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>' +
    '<c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' +
    '<c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="BFBFBF"/></a:solidFill></a:ln></c:spPr>' + axTx +
    '<c:crossAx val="5002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:tickLblSkip val="1"/><c:noMultiLvlLbl val="0"/></c:catAx>' +
    '<c:valAx><c:axId val="5002"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>' +
    '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E7E6E6"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>' +
    '<c:numFmt formatCode="#,##0" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' +
    '<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>' + axTx +
    '<c:crossAx val="5001"/><c:crosses val="max"/><c:crossBetween val="between"/></c:valAx>' +
    '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>' +
    '<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="6350"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr>' +
    `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr>${font}</a:defRPr></a:pPr><a:endParaRPr lang="ko-KR"/></a:p></c:txPr>` +
    (s.tail || "") + '</c:chartSpace>';
}

function anchorXml(a, rid, id) {
  return `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${a.c1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.r1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>${a.c2}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.r2}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id + 1}" name="차트 ${id}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
    `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
    `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
}

// charts: [{ sheetName, anchor:{c1,r1,c2,r2}(0부터), xml }]
async function injectCharts(buf, charts) {
  if (!charts.length) return buf;
  const zip = await JSZip.loadAsync(buf);
  const wbXml = await zip.file("xl/workbook.xml").async("string");
  const wbRels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  const ctPath = "[Content_Types].xml";
  let ct = await zip.file(ctPath).async("string");
  const sheetTarget = (name) => {
    const m = wbXml.match(new RegExp(`<sheet[^>]*name="${esc(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*r:id="([^"]+)"`));
    if (!m) throw new Error(`시트를 찾지 못했습니다: ${name}`);
    const r = wbRels.match(new RegExp(`<Relationship[^>]*Id="${m[1]}"[^>]*Target="([^"]+)"`)) || wbRels.match(new RegExp(`<Relationship[^>]*Target="([^"]+)"[^>]*Id="${m[1]}"`));
    return "xl/" + r[1].replace(/^\/?xl\//, "");
  };
  const bySheet = {};
  charts.forEach(c => { (bySheet[c.sheetName] = bySheet[c.sheetName] || []).push(c); });
  let chartNo = 0, drawNo = 0;
  for (const [name, list] of Object.entries(bySheet)) {
    drawNo++;
    const sheetPath = sheetTarget(name);
    const relsPath = sheetPath.replace(/worksheets\/(sheet\d+\.xml)$/, "worksheets/_rels/$1.rels");
    let anchors = "", drels = "";
    list.forEach((c, i) => {
      chartNo++;
      zip.file(`xl/charts/chart${chartNo}.xml`, c.xml);
      ct = ct.replace("</Types>", `<Override PartName="/xl/charts/chart${chartNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
      drels += `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${chartNo}.xml"/>`;
      anchors += anchorXml(c.anchor, `rId${i + 1}`, chartNo);
    });
    zip.file(`xl/drawings/drawing${drawNo}.xml`, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' + anchors + '</xdr:wsDr>');
    zip.file(`xl/drawings/_rels/drawing${drawNo}.xml.rels`, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + drels + '</Relationships>');
    ct = ct.replace("</Types>", `<Override PartName="/xl/drawings/drawing${drawNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
    const relsFile = zip.file(relsPath);
    let rels = relsFile ? await relsFile.async("string") : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    const rid = "rIdDrw" + drawNo;
    rels = rels.replace("</Relationships>", `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawNo}.xml"/></Relationships>`);
    zip.file(relsPath, rels);
    let sx = await zip.file(sheetPath).async("string");
    if (!/xmlns:r=/.test(sx.slice(0, 600))) sx = sx.replace("<worksheet ", '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
    const tag = `<drawing r:id="${rid}"/>`;
    const after = sx.match(/<(legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)[\s>\/]/);
    sx = after ? sx.slice(0, after.index) + tag + sx.slice(after.index) : sx.replace("</worksheet>", tag + "</worksheet>");
    zip.file(sheetPath, sx);
  }
  zip.file(ctPath, ct);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

module.exports = { rangeChartXml, injectCharts };
