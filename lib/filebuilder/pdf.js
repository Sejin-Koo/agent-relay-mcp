// 원본: 계정 스킬 sys-file-builder — 업무 에이전트 중계 서버의 lib/filebuilder/는 이 파일의 사본이다(사본을 직접 고치지 않는다).
// 문서 모델(docexport.mdToModel) → PDF. 서버(Node)에서 글자가 살아 있는 PDF를 만든다(페이지의 PDF는 화면을 그림으로 떠서 만든다).
// - 글꼴: 본고딕(Noto Sans KR, OFL). 맑은 고딕은 Windows 글꼴이라 공개 저장소·여러 회사 사용자용 서버에 넣지 않는다.
// - 서식은 Word 규칙(ref-word-doc-style)을 따른다: 장 "n.", 소제목 "n-k.", 표 머리 남색 바탕 흰 글자, 표 제목·자료 줄,
//   첫 절 요약 상자, 장 첫 줄 핵심 메시지 상자, 본문 10쪽 이상(경계 9쪽)이면 표지·목차(쪽번호 포함), 바닥글 "- n/N -".
// - 줄바꿈은 어절 단위(띄어쓰기)로 한다. 한 어절이 칸보다 길 때만 글자 단위로 자른다.
const PDFDocument = require("pdfkit");
const path = require("path");

// 글꼴 경로는 문자열을 그대로 써야 배포 도구(Vercel)가 파일을 함께 싣는다
function fontFile(weight) {
  try {
    return weight === "bold"
      ? require.resolve("@expo-google-fonts/noto-sans-kr/700Bold/NotoSansKR_700Bold.ttf")
      : require.resolve("@expo-google-fonts/noto-sans-kr/400Regular/NotoSansKR_400Regular.ttf");
  } catch (e) {
    return path.join(__dirname, "fonts", weight === "bold" ? "NotoSansKR_700Bold.ttf" : "NotoSansKR_400Regular.ttf");
  }
}
const FONT_NAME = "본고딕(Noto Sans KR)";

const MM = 72 / 25.4;
const PAGE = { w: 595.28, h: 841.89 };
const M = { top: 20 * MM, bottom: 20 * MM, left: 25.4 * MM, right: 25.4 * MM };
const CW = PAGE.w - M.left - M.right;
const HEAD_Y = 10 * MM, FOOT_Y = PAGE.h - 12 * MM;

const hex = (c, d) => "#" + (/^[0-9A-Fa-f]{6}$/.test(String(c || "")) ? c : d);

function render(model, DX, opt) {
  const st = DX.getStyle();
  const C = st.colors, SZ = st.word.size, EL = st.elements;
  const pt = (half) => half / 2;
  const S = { title: pt(SZ.title), sub: pt(SZ.subtitle), h1: pt(SZ.h1), h2: pt(SZ.h2), body: pt(SZ.body), th: pt(SZ.th), td: pt(SZ.td),
    cap: pt(SZ.caption), src: pt(SZ.src), head: pt(SZ.header), foot: pt(SZ.footer), ctitle: pt(SZ.cover_title), csub: pt(SZ.cover_sub) };
  const LINE = 1.32;
  // 첫 글꼴을 본고딕으로 지정한다 — 지정하지 않으면 pdfkit이 내장 Helvetica 파일을 따로 읽는데, 배포 환경에는 그 파일이 실리지 않는다
  const doc = new PDFDocument({ font: fontFile("regular"), size: "A4", margins: { top: M.top, bottom: 0, left: M.left, right: M.right }, autoFirstPage: false, bufferPages: true,
    info: { Title: model.title, Creator: DX.creator ? DX.creator() : "업무 에이전트" } });
  doc.registerFont("R", fontFile("regular"));
  doc.registerFont("B", fontFile("bold"));
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((res) => doc.on("end", () => res(Buffer.concat(chunks))));

  const conf = DX.confOf(model);
  const headText = [model.header || "", conf].filter(Boolean).join("  |  ");
  const bodyStart = { page: 0 };
  const heads = []; // {text, level, page(본문 쪽 번호, 1부터)}
  let y = M.top;
  const bottom = PAGE.h - M.bottom;
  let bodyPageNo = 0; // 본문 쪽 수

  function newPage() { doc.addPage(); y = M.top; }
  function bodyPage() { newPage(); bodyPageNo++; }
  function ensure(h) { if (y + h > bottom) bodyPage(); }

  // ---------- 글 배치(어절 단위) ----------
  function tokens(text, bold) {
    // runs = [{text,bold}] → 어절 토큰 [{t, bold, sp}] (sp: 뒤에 띄어쓰기)
    const runs = DX.parseInline(text).map((r) => ({ text: r.text, bold: r.bold || !!bold }));
    const out = [];
    runs.forEach((r) => {
      const parts = r.text.replace(/\t/g, " ").split(/( +)/);
      parts.forEach((p) => {
        if (!p) return;
        if (/^ +$/.test(p)) { if (out.length) out[out.length - 1].sp = true; return; }
        out.push({ t: p, bold: r.bold, sp: false });
      });
    });
    return out;
  }
  function wid(t, bold, size) { doc.font(bold ? "B" : "R").fontSize(size); return doc.widthOfString(t); }
  function layoutLines(text, size, width, bold) {
    const toks = tokens(text, bold);
    const spaceW = wid(" ", false, size);
    const lines = [];
    let cur = [], w = 0;
    const flush = () => { lines.push(cur); cur = []; w = 0; };
    toks.forEach((tk) => {
      let tw = wid(tk.t, tk.bold, size);
      if (tw > width) {
        // 칸보다 긴 어절은 글자 단위로 자른다
        let piece = "";
        Array.from(tk.t).forEach((ch) => {
          const pw = wid(piece + ch, tk.bold, size);
          if (w + pw > width && (piece || cur.length)) {
            if (piece) cur.push({ t: piece, bold: tk.bold, sp: false });
            flush(); piece = ch;
          } else piece += ch;
        });
        if (piece) { const pw = wid(piece, tk.bold, size); cur.push({ t: piece, bold: tk.bold, sp: tk.sp }); w += pw + (tk.sp ? spaceW : 0); }
        return;
      }
      if (cur.length && w + tw > width) flush();
      cur.push(tk); w += tw + (tk.sp ? spaceW : 0);
    });
    if (cur.length || !lines.length) flush();
    return lines;
  }
  function lineWidth(line, size) {
    const spaceW = wid(" ", false, size);
    return line.reduce((a, tk, i) => a + wid(tk.t, tk.bold, size) + (tk.sp && i < line.length - 1 ? spaceW : 0), 0);
  }
  function drawLine(line, x, yy, size, color, align, width) {
    const spaceW = wid(" ", false, size);
    let xx = x;
    if (align === "center" || align === "right") {
      const lw = lineWidth(line, size);
      xx = align === "center" ? x + (width - lw) / 2 : x + width - lw;
    }
    line.forEach((tk) => {
      doc.font(tk.bold ? "B" : "R").fontSize(size).fillColor(color);
      doc.text(tk.t, xx, yy, { lineBreak: false });
      xx += doc.widthOfString(tk.t) + (tk.sp ? spaceW : 0);
    });
  }
  function textHeight(text, size, width, bold) { return layoutLines(text, size, width, bold).length * size * LINE; }
  // 문단 — 쪽이 넘어가면 줄 단위로 나눠 싣는다
  function para(text, o) {
    o = o || {};
    const size = o.size || S.body, x = o.x || M.left, width = o.width || CW, lh = size * LINE;
    const lines = layoutLines(text, size, width, o.bold);
    if (o.keep) ensure(Math.min(lines.length, 3) * lh + (o.keepExtra || 0));
    lines.forEach((ln) => {
      if (y + lh > bottom) bodyPage();
      drawLine(ln, x, y, size, o.color || "#000000", o.align, width);
      y += lh;
    });
    y += o.after == null ? 4 : o.after;
  }

  // ---------- 블록 ----------
  let figN = 0;
  function heading(level, text) {
    const size = level === 1 ? S.h1 : S.h2;
    const before = level === 1 ? 12 : 7;
    ensure(before + size * LINE + S.body * LINE * 2);
    y += y === M.top ? 0 : before;
    heads.push({ text, level, page: bodyPageNo });
    para(text, { size, bold: true, color: hex(level === 1 ? C.h1 : C.h2, "1F3864"), after: level === 1 ? 6 : 4 });
  }
  function boxBlock(text, o) {
    // 왼쪽 굵은 선 + 음영 상자 안의 글
    const pad = 8, size = o.size || S.body;
    const h = textHeight(text, size, CW - pad * 2 - 3, o.bold) + pad * 2;
    ensure(h + 4);
    doc.save().rect(M.left, y, CW, h).fill(hex(C.box_bg, "F2F4F8")).restore();
    doc.save().rect(M.left, y, 3, h).fill(hex(C.box_line, "2E5395")).restore();
    const y0 = y; y += pad;
    para(text, { size, bold: o.bold, color: o.color, x: M.left + pad + 3, width: CW - pad * 2 - 3, after: 0 });
    y = y0 + h + 6;
  }
  function table(b, nextSrc) {
    const info = DX.colInfo(b.headers, b.rows);
    const padX = 4, padY = 3, total = CW;
    // 열 최소 폭 = 그 열에서 가장 긴 어절(머리 포함)이 한 줄에 들어가는 폭(전체의 40%까지) — 단어가 글자 단위로 끊기지 않게
    const mins = b.headers.map((h, i) => {
      let mx = 0;
      [h].concat(b.rows.map((r) => r[i] || "")).forEach((c, k) => tokens(String(c), !k).forEach((tk) => { mx = Math.max(mx, wid(tk.t, tk.bold, k ? S.td : S.th)); }));
      return Math.min(total * 0.4, mx + padX * 2 + 1);
    });
    let widths;
    const minSum = mins.reduce((a, v) => a + v, 0);
    if (minSum >= total) widths = mins.map((v) => v * total / minSum);
    else { const free = total - minSum; widths = mins.map((v, i) => v + free * info[i].ratio); }
    const border = hex(C.border === "auto" ? "808080" : C.border, "808080");
    function rowH(cells, head) {
      return Math.max(...cells.map((c, i) => textHeight(String(c || ""), head ? S.th : S.td, widths[i] - padX * 2, head))) + padY * 2;
    }
    function drawRow(cells, head, h) {
      let x = M.left;
      cells.forEach((c, i) => {
        if (head) doc.save().rect(x, y, widths[i], h).fill(hex(C.th_bg, "2E5395")).restore();
        doc.save().lineWidth(0.5).strokeColor(border).rect(x, y, widths[i], h).stroke().restore();
        const size = head ? S.th : S.td;
        const lines = layoutLines(String(c || ""), size, widths[i] - padX * 2, head);
        const th = lines.length * size * LINE;
        let yy = y + (h - th) / 2;
        lines.forEach((ln) => { drawLine(ln, x + padX, yy, size, head ? hex(C.th_fg, "FFFFFF") : "#000000", head ? "center" : info[i].align, widths[i] - padX * 2); yy += size * LINE; });
        x += widths[i];
      });
      y += h;
    }
    const hh = rowH(b.headers, true);
    const r0 = b.rows.length ? rowH(b.headers.map((_, i) => b.rows[0][i]), false) : 0;
    ensure(hh + r0);
    drawRow(b.headers, true, hh);
    b.rows.forEach((r) => {
      const cells = b.headers.map((_, i) => r[i] || "");
      const h = rowH(cells, false);
      if (y + h > bottom) { bodyPage(); drawRow(b.headers, true, hh); }
      drawRow(cells, false, h);
    });
    y += nextSrc ? 3 : 8;
  }
  function figure(b) {
    figN++;
    const cap = "[그림 " + figN + "] " + (b.title || "");
    if (b.img && b.img.bytes) {
      let w = CW, h = w * b.img.h / b.img.w;
      const maxH = (bottom - M.top) * 0.55;
      if (h > maxH) { w = w * maxH / h; h = maxH; }
      ensure(S.cap * LINE + h + 6 + (b.source ? S.src * LINE : 0));
      para(cap, { size: S.cap, bold: true, color: hex(C.caption, "1F3864"), after: 2 });
      try { doc.image(b.img.bytes, M.left + (CW - w) / 2, y, { width: w, height: h }); } catch (e) { /* 그림을 읽지 못하면 비워 둔다 */ }
      y += h + 3;
    } else {
      para(cap + " (그림을 만들지 못해 생략함)", { size: S.src, color: hex(C.muted, "808080") });
    }
    if (b.source && EL.source_line) para("자료: " + b.source, { size: S.src, color: hex(C.muted, "808080"), after: 8 });
  }
  function bullets(b) {
    const BU = st.word.bullet;
    b.items.forEach((it) => {
      const lvl = it.level || 0;
      const sym = it.ordered ? it.n + "." : (lvl ? BU.l1 : BU.l0);
      const ind = 10 + lvl * 14, hang = it.ordered ? 14 : 9;
      const lines = layoutLines(it.text, S.body, CW - ind - hang);
      const lh = S.body * LINE;
      lines.forEach((ln, i) => {
        if (y + lh > bottom) bodyPage();
        if (!i) { doc.font("R").fontSize(S.body).fillColor("#000000").text(sym, M.left + ind, y, { lineBreak: false }); }
        drawLine(ln, M.left + ind + hang, y, S.body, "#000000");
        y += lh;
      });
      y += 2;
    });
    y += 3;
  }
  function blocks(s) {
    s.blocks.forEach((b, i) => {
      const nextB = s.blocks[i + 1];
      if (b.type === "h3") heading(2, DX.h3Text(b));
      else if (b.type === "p" && b.role === "lead") boxBlock(DX.plain(b.text), { bold: true, color: hex(C.title, "1F3864") });
      else if (b.type === "p" && b.role === "caption") { if (EL.caption) para(b.text, { size: S.cap, bold: true, color: hex(C.caption, "1F3864"), keep: true, keepExtra: 40, after: 3 }); }
      else if (b.type === "p" && b.role === "src") { if (EL.source_line) para(b.text, { size: S.src, color: hex(C.muted, "808080"), after: 8 }); }
      else if (b.type === "p") String(b.text).split(/\n+/).forEach((ln) => { if (ln.trim()) para(ln, { keep: !!(nextB && (nextB.type === "table" || nextB.type === "figure")), keepExtra: 40 }); });
      else if (b.type === "note") {
        const y0 = y; para(DX.plain(b.text), { x: M.left + 10, width: CW - 10, color: hex(C.sub, "595959"), size: S.sub });
        doc.save().rect(M.left + 2, Math.max(M.top, y0), 2, Math.max(4, y - Math.max(M.top, y0) - 4)).fill("#BFBFBF").restore();
      }
      else if (b.type === "bullets") bullets(b);
      else if (b.type === "table") table(b, nextB && nextB.role === "src" && EL.source_line);
      else if (b.type === "figure") figure(b);
    });
  }

  // ---------- 표지·목차 ----------
  function coverPage() {
    newPage();
    y = 230;
    para(model.title, { size: S.ctitle, bold: true, color: hex(C.title, "1F3864"), align: "center", after: 14 });
    if (model.subtitle) para(model.subtitle, { size: S.csub, color: hex(C.sub, "595959"), align: "center", after: 8 });
    const dl = DX.dateLines(model);
    if (dl.length) { y += 10; dl.forEach((t) => para(t, { size: S.sub, color: hex(C.sub, "595959"), align: "center", after: 2 })); }
    if (conf) { y += 16; para(conf, { size: S.sub + 1, bold: true, color: "#C00000", align: "center" }); }
    y = PAGE.h - 190;
    para(DX.dept(), { size: S.csub, bold: true, color: hex(C.title, "1F3864"), align: "center" });
  }
  function tocPages(list) {
    newPage();
    para("목 차", { size: 16, bold: true, color: hex(C.title, "1F3864"), align: "center", after: 16 });
    list.forEach((h) => {
      const size = h.level === 1 ? S.body : S.sub, x = M.left + (h.level === 1 ? 0 : 14);
      const lh = size * LINE + (h.level === 1 ? 4 : 2);
      if (y + lh > bottom) newPage();
      const num = String(h.page);
      doc.font(h.level === 1 ? "B" : "R").fontSize(size).fillColor("#000000");
      const nw = doc.widthOfString(num);
      const maxT = CW - (x - M.left) - nw - 20;
      let t = h.text;
      while (t.length > 4 && doc.widthOfString(t) > maxT) t = t.slice(0, -2);
      if (t !== h.text) t = t.slice(0, -1) + "…";
      doc.text(t, x, y, { lineBreak: false });
      const tw = doc.widthOfString(t);
      doc.font("R").fontSize(size).fillColor("#808080");
      const dw = doc.widthOfString(".");
      let dots = ""; const room = M.left + CW - nw - (x + tw) - 8;
      for (let k = 0; k < Math.floor(room / dw); k++) dots += ".";
      doc.text(dots, x + tw + 4, y, { lineBreak: false });
      doc.font(h.level === 1 ? "B" : "R").fillColor("#000000").text(num, M.left + CW - nw, y, { lineBreak: false });
      y += lh;
    });
  }

  // ---------- 조립 ----------
  if (opt.cover) { coverPage(); tocPages(opt.heads || []); }
  bodyStart.page = doc.bufferedPageRange().count;
  bodyPage();
  if (!opt.cover) {
    para(model.title, { size: S.title, bold: true, color: hex(C.title, "1F3864"), align: "center", after: 4 });
    const dl = DX.dateLines(model);
    if (model.subtitle) para(model.subtitle, { size: S.sub, color: hex(C.sub, "595959"), align: "center", after: dl.length ? 2 : 12 });
    if (dl.length) para(dl.join("  ·  "), { size: S.src, color: hex(C.muted, "808080"), align: "center", after: 12 });
  }
  let hn = 0;
  model.sections.forEach((s, si) => {
    if (s.heading) { hn++; heading(1, hn + ". " + s.heading); }
    const boxed = EL.summary_box && si === 0 && /요약|결론|summary/i.test(s.heading || "") && s.blocks.length &&
      !s.blocks.some((b) => b.type === "table" || b.type === "figure" || b.type === "h3");
    if (boxed) {
      // 요약 상자: 상자 높이를 먼저 재고, 한 쪽에 들어가면 음영을 깐 뒤 글을 얹는다
      const pad = 9, innerW = CW - pad * 2 - 3;
      let h = pad * 2;
      s.blocks.forEach((b) => {
        if (b.type === "bullets") b.items.forEach((it) => { h += textHeight(it.text, S.body, innerW - 10 - (it.level || 0) * 14 - 9) + 2; });
        else if (b.type === "p" || b.type === "note") h += textHeight(DX.plain(b.text), S.body, innerW, b.role === "lead") + 4;
      });
      h += 3;
      if (h < bottom - M.top) {
        ensure(h);
        doc.save().rect(M.left, y, CW, h).fill(hex(C.box_bg, "F2F4F8")).restore();
        doc.save().rect(M.left, y, 3, h).fill(hex(C.box_line, "2E5395")).restore();
        const y0 = y;
        y += pad;
        // 상자 안은 들여 쓴다
        const saveLeft = M.left;
        M.left = saveLeft + pad + 3;
        s.blocks.forEach((b) => {
          if (b.type === "bullets") bulletsIn(b, innerW);
          else if (b.type === "p" && b.role === "lead") para(DX.plain(b.text), { bold: true, color: hex(C.title, "1F3864"), x: M.left, width: innerW });
          else if (b.type === "p" || b.type === "note") String(b.text).split(/\n+/).forEach((ln) => { if (ln.trim()) para(ln, { x: M.left, width: innerW }); });
        });
        M.left = saveLeft;
        y = Math.max(y, y0 + h) + 8;
        return;
      }
    }
    blocks(s);
  });
  if (model.source.length) {
    y += 8;
    para("출처", { size: S.td, bold: true, color: hex(C.sub, "595959"), after: 2 });
    model.source.forEach((src) => para(src, { size: S.td, color: hex(C.sub, "595959"), after: 2 }));
  }

  // ---------- 머리글·바닥글 ----------
  const range = doc.bufferedPageRange();
  const nBody = range.count - bodyStart.page;
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const isCover = opt.cover && i === 0;
    const isToc = opt.cover && i > 0 && i < bodyStart.page;
    if (isCover) continue;
    if (headText) {
      doc.font("R").fontSize(S.head).fillColor(hex(C.muted, "808080"));
      doc.text(headText, M.left, HEAD_Y, { width: CW, align: "right", lineBreak: false });
      doc.save().lineWidth(0.5).strokeColor("#BFBFBF").moveTo(M.left, HEAD_Y + S.head + 3).lineTo(M.left + CW, HEAD_Y + S.head + 3).stroke().restore();
    }
    const label = isToc ? "- " + roman(i) + " -" : "- " + (i - bodyStart.page + 1) + "/" + nBody + " -";
    doc.font("R").fontSize(S.foot).fillColor("#000000").text(label, M.left, FOOT_Y, { width: CW, align: "center", lineBreak: false });
  }
  doc.end();
  return { done, pages: nBody, heads };

  function bulletsIn(b, width) {
    const BU = st.word.bullet;
    b.items.forEach((it) => {
      const lvl = it.level || 0, sym = it.ordered ? it.n + "." : (lvl ? BU.l1 : BU.l0);
      const ind = lvl * 14, hang = it.ordered ? 14 : 9;
      const lines = layoutLines(it.text, S.body, width - ind - hang);
      lines.forEach((ln, i) => {
        if (!i) doc.font("R").fontSize(S.body).fillColor("#000000").text(sym, M.left + ind, y, { lineBreak: false });
        drawLine(ln, M.left + ind + hang, y, S.body, "#000000");
        y += S.body * LINE;
      });
      y += 2;
    });
  }
}
function roman(n) {
  let r = ""; [[10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]].forEach(([v, s]) => { while (n >= v) { r += s; n -= v; } });
  return r;
}

// 본문을 한 번 배치해 쪽수를 잰 뒤, 10쪽 이상(경계 9쪽)이면 표지·목차를 붙여 다시 만든다(목차 쪽번호는 첫 배치 값)
async function buildPdf(model, DX, opt) {
  opt = opt || {};
  const first = render(model, DX, { date: opt.date });
  const buf1 = await first.done;
  const cover = opt.cover === true || (opt.cover !== false && first.pages >= DX.coverMin());
  if (!cover) return { buffer: buf1, pages: first.pages, cover: false, font: FONT_NAME };
  const second = render(model, DX, { date: opt.date, cover: true, heads: first.heads.map((h) => ({ text: h.text, level: h.level, page: h.page })) });
  const buf2 = await second.done;
  return { buffer: buf2, pages: second.pages, cover: true, font: FONT_NAME };
}

module.exports = { buildPdf, FONT_NAME };
