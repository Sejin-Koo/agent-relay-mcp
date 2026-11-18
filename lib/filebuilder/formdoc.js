// 양식 문서(계약서·서약서·동의서·확인서·각서·위임장, 사내규정, 공문, 의사록) → Word.
// 원고 제목(# …) 바로 다음 줄에 '문서 종류: 서약서'처럼 적으면 보고서 서식 대신 이 모듈로 만든다(계정 스킬 ref-formal-doc-style).
// 보고서 요소를 쓰지 않는다: 표지·목차·머리글·작성일 줄·장 자동번호·[ ] 이름표·핵심 메시지 상자·남색 표 머리행.
// 원고 표기(줄 단위로 해석 — 마크다운 목록 해석을 쓰지 않는다. 조문 사이의 "1." 줄이 목록으로 묶여 뒤 항을 삼키는 일을 막기 위함):
//   제N조(제목) [본문]      조 — 제목 굵게. 본문이 같은 줄에 있으면 이어 쓴다
//   ① …                     항 — 내어쓰기
//   1. … / 가. …            호 / 목 (공문은 1. 가. 1) 가) (1) (가) ① ㉮ 여덟 단계 — 행정업무규정 시행규칙 제2조제1항)
//   - … / ☐ …               글머리(내어쓰기)
//   ## 제1장 총칙 / ## 부칙  가운데 굵은 줄(장·부칙)
//   ## [별지 제1호 서식] 제목  새 쪽, 왼쪽 위 작은 글씨로 서식 번호, 가운데 제목([별표]·[별첨]도 같음)
//   ## 그 밖의 제목            굵은 줄(의사록의 '제1호 의안: …' 등)
//   | 표 |                     머리행이 모두 비어 있으면 머리행 없이, 홀수 열(1·3열)을 이름 칸으로 회색 음영. 아니면 머리행 회색 음영
//   날짜만 있는 줄 → 가운데, '(서명 또는 인)'·'(인)'·'(서명)'으로 끝나는 줄 → 오른쪽, '귀하'·'귀중'으로 끝나는 줄 → 가운데 굵게
//   [가운데] … / [오른쪽] …    정렬 직접 지정
//   공문: 수신·참조·(경유)·제목 줄은 이름표 서식, 제목 줄 아래 가로선, '발신명의: …' 줄은 가운데 크게, 그 뒤 줄은 결문(작은 글씨)
"use strict";

const KIND_RE = /^[*_\s]*문서\s*종류\s*[:：]\s*([^\n*_]+?)[*_\s]*$/m;
const KINDS = {
  contract: /계약서|서약서|동의서|확인서|각서|위임장|합의서|약정서|협약서|양해각서|MOU/i,
  regulation: /규정|규칙|지침|정관|세칙|내규|요령/,
  letter: /공문|기안문|시행문|통지서|안내문|협조문|회신/,
  minutes: /의사록/,
};

// 원고에서 양식 종류를 찾는다. 제목 다음 머리 줄(첫 빈 줄 전까지 몇 줄) 안에 있어야 한다
function kindOf(md) {
  const lines = String(md || "").replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length || !/^#\s/.test(lines[i])) return null;
  for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
    const m = lines[j].match(KIND_RE);
    if (m) {
      const label = m[1].trim();
      for (const k of Object.keys(KINDS)) if (KINDS[k].test(label)) return { kind: k, label };
      return { kind: "contract", label };
    }
  }
  return null;
}

function inline(s) {
  // **굵게** 만 해석. 그 밖의 마크다운 기호는 글자로 둔다(조문에 * 가 들어갈 일이 거의 없음)
  const out = [];
  String(s).split(/(\*\*[^*]+\*\*)/g).forEach((p) => {
    if (!p) return;
    if (/^\*\*[^*]+\*\*$/.test(p)) out.push({ text: p.slice(2, -2), bold: true });
    else out.push({ text: p.replace(/\\([*_|#])/g, "$1"), bold: false });
  });
  return out;
}

function parseTable(rows) {
  const cells = rows.map((r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|").replace(/<br\s*\/?>/gi, "\n")));
  const sepIdx = cells.findIndex((r) => r.some((c) => /^:?-{2,}:?$/.test(c)) && r.every((c) => /^:?-{2,}:?$/.test(c) || c === ""));
  let header = null, body = cells, aligns = [];
  if (sepIdx === 1) {
    header = cells[0];
    aligns = cells[1].map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : /^:-+/.test(c) ? "left" : ""));
    body = cells.slice(2);
  }
  const n = Math.max(...cells.map((r) => r.length));
  const pad = (r) => { r = r.slice(0, n); while (r.length < n) r.push(""); return r; };
  const noHeader = !header || header.every((c) => !c);
  return { type: "table", header: noHeader ? null : pad(header), rows: body.map(pad), aligns, labelCols: noHeader };
}

// 원고 → 블록 목록
function parse(md) {
  const lines = String(md || "").replace(/\r/g, "").split("\n");
  const doc = { title: "", subtitle: "", kind: null, label: "", blocks: [] };
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && /^#\s/.test(lines[i])) { doc.title = lines[i].replace(/^#\s+/, "").trim(); i++; }
  // 머리 줄: 문서 종류·부제
  while (i < lines.length && lines[i].trim()) {
    const l = lines[i].trim();
    let m;
    if ((m = l.match(KIND_RE))) doc.label = m[1].trim();
    else if ((m = l.match(/^[*_\s]*부제\s*[:：]\s*(.+?)[*_\s]*$/))) doc.subtitle = m[1].trim();
    else break;
    i++;
  }
  const k = kindOf(md);
  doc.kind = k ? k.kind : "contract";
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const l = raw.trim();
    if (!l) { doc.blocks.push({ type: "gap" }); continue; }
    if (/^\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      i--;
      doc.blocks.push(parseTable(rows));
      continue;
    }
    if (/^#{2,6}\s/.test(l)) {
      const t = l.replace(/^#{2,6}\s+/, "").trim();
      const m = t.match(/^\[(별지|별표|별첨)([^\]]*)\]\s*(.*)$/);
      if (m) doc.blocks.push({ type: "form", tag: "[" + m[1] + m[2] + "]", title: m[3].trim() });
      else if (/^제\s*\d+\s*장/.test(t) || /^부\s*칙/.test(t)) doc.blocks.push({ type: "chapter", text: t });
      else doc.blocks.push({ type: "heading", text: t.replace(/^\*\*|\*\*$/g, "") });
      continue;
    }
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(l)) { doc.blocks.push({ type: "rule" }); continue; }
    doc.blocks.push({ type: "line", text: l });
  }
  return doc;
}

// 공문 항목 단계(행정업무규정 시행규칙 제2조제1항: 1., 가., 1), 가), (1), (가), ①, ㉮)
const LETTER_LEVELS = [/^\d{1,2}\.\s/, /^[가-힣]\.\s/, /^\d{1,2}\)\s/, /^[가-힣]\)\s/, /^\(\d{1,2}\)\s/, /^\([가-힣]\)\s/, /^[①-⑳]\s?/, /^[㉮-㉻]\s?/];

function classify(text, kind) {
  let m;
  if ((m = text.match(/^(?:\[(가운데|오른쪽)\]\s*)(.*)$/))) return { role: m[1] === "가운데" ? "center" : "right", text: m[2] };
  if ((m = text.match(/^\*{0,2}(제\s*\d+\s*조(?:의\s*\d+)?\s*\([^)]*\))\*{0,2}\s*(.*)$/))) return { role: "article", head: m[1], text: m[2] };
  if (kind === "letter") {
    if ((m = text.match(/^(수\s*신|참\s*조|\(경유\)|경\s*유|제\s*목)\s*[:：]?\s*(.*)$/))) return { role: "letterhead", label: m[1], text: m[2] };
    if ((m = text.match(/^발신\s*명의\s*[:：]\s*(.*)$/))) return { role: "sender", text: m[1] };
    if (/^붙임\s/.test(text)) return { role: "attach", text };
    for (let lv = 0; lv < LETTER_LEVELS.length; lv++) {
      const mm = text.match(LETTER_LEVELS[lv]);
      if (mm) return { role: "item", level: lv, mark: mm[0].trim(), text: text.slice(mm[0].length).trim() };
    }
  } else {
    if ((m = text.match(/^([①-⑳])\s*(.*)$/))) return { role: "hang", mark: m[1], text: m[2] };
    if ((m = text.match(/^(\d{1,2}\.)\s+(.*)$/))) return { role: "ho", mark: m[1], text: m[2] };
    if ((m = text.match(/^([가-힣]\.)\s+(.*)$/))) return { role: "mok", mark: m[1], text: m[2] };
  }
  const plainText = text.replace(/\*\*/g, "").trim();
  if (/(귀하|귀중)$/.test(plainText)) return { role: "center", text, bold: true };
  if ((m = text.match(/^([-•▪]|☐|□|○)\s+(.*)$/))) return { role: "bullet", mark: m[1] === "•" || m[1] === "▪" ? "-" : m[1], text: m[2] };
  if (/^(\d{4}\s*\.\s*\d{1,2}\s*\.\s*\d{1,2}\s*\.?|(\d{4}\s*)?년\s+\d*\s*월\s+\d*\s*일)$/.test(plainText)) return { role: "center", text };
  if (/\((서명\s*또는\s*인|인|서명|기명날인)\)\s*$/.test(plainText)) return { role: "right", text };
  if (/(귀하|귀중)$/.test(plainText)) return { role: "center", text, bold: true };
  return { role: "body", text };
}

function build(md, d, opt) {
  opt = opt || {};
  const FONT = opt.font || "맑은 고딕";
  const doc = parse(md);
  const kind = doc.kind;
  const SZ = 20, LINE = 288;
  const W = 11906 - 1134 * 2;
  const J = d.AlignmentType.JUSTIFIED, C = d.AlignmentType.CENTER, L = d.AlignmentType.LEFT, R = d.AlignmentType.RIGHT;
  const bd = { style: d.BorderStyle.SINGLE, size: 4, color: "000000" };
  const borders = { top: bd, bottom: bd, left: bd, right: bd };
  const GRAY = "F2F2F2";
  const runs = (t, o) => inline(t).map((r) => new d.TextRun({ text: r.text, bold: r.bold || !!(o && o.bold), size: (o && o.size) || SZ, font: FONT, color: o && o.color }));
  const P = (children, o) => new d.Paragraph(Object.assign({ alignment: J, spacing: { after: 60, line: LINE } }, o || {}, { children }));
  const hangPara = (mark, text, left, hang, o) => P([new d.TextRun({ text: mark + "\t", font: FONT, size: SZ, bold: !!(o && o.markBold) })].concat(runs(text)), Object.assign({ indent: { left, hanging: hang }, tabStops: [{ type: d.TabStopType.LEFT, position: left }], spacing: { after: 40, line: LINE } }, o && o.para));
  const out = [];
  let afterSender = false;
  const warnings = [];

  // 제목
  if (doc.title) {
    out.push(P(runs(doc.title, { bold: true, size: kind === "letter" ? 32 : 34 }), { alignment: C, spacing: { after: doc.subtitle ? 60 : 280 } }));
    if (doc.subtitle) out.push(P(runs(doc.subtitle, { size: 21 }), { alignment: C, spacing: { after: 280 } }));
    if (kind === "letter") out.push(P([], { border: { bottom: { style: d.BorderStyle.SINGLE, size: 12, color: "000000", space: 1 } }, spacing: { after: 160 } }));
  }

  function table(b) {
    const n = b.rows[0] ? b.rows[0].length : (b.header || []).length;
    if (!n) return null;
    // 열 너비: 글자 수 비례(이름 칸은 좁게), 최소 900
    const lens = Array.from({ length: n }, (_, c) => Math.max(...[b.header ? b.header[c] : ""].concat(b.rows.map((r) => r[c] || "")).map((s) => String(s).split("\n").reduce((m, x) => Math.max(m, x.length), 0)), 2));
    const weights = lens.map((x, c) => (b.labelCols && c % 2 === 0 ? Math.min(x, 8) : Math.min(Math.max(x, 4), 40)));
    const tot = weights.reduce((a, x) => a + x, 0);
    let widths = weights.map((x) => Math.max(900, Math.round((W * x) / tot)));
    const s = widths.reduce((a, x) => a + x, 0);
    widths = widths.map((x) => Math.round((x * W) / s));
    widths[n - 1] += W - widths.reduce((a, x) => a + x, 0);
    const cell = (t, w, o) => new d.TableCell({
      width: { size: w, type: d.WidthType.DXA }, borders,
      shading: o.fill ? { type: d.ShadingType.CLEAR, color: "auto", fill: GRAY } : undefined,
      margins: { top: 70, bottom: 70, left: 100, right: 100 }, verticalAlign: d.VerticalAlign.CENTER,
      children: String(t).split("\n").map((x) => new d.Paragraph({ alignment: o.align, spacing: { after: 0, line: 264 }, children: runs(x, { bold: o.bold, size: 19 }) })),
    });
    const al = (c) => ({ center: C, right: R, left: L }[b.aligns[c]] || null);
    const rows = [];
    if (b.header) rows.push(new d.TableRow({ tableHeader: true, cantSplit: true, children: b.header.map((h, c) => cell(h, widths[c], { fill: true, bold: true, align: C })) }));
    b.rows.forEach((r) => rows.push(new d.TableRow({ cantSplit: true, children: r.map((t, c) => {
      const isLabel = b.labelCols && c % 2 === 0 && n > 1;
      const short = String(t).replace(/\s/g, "").length <= 4 || /^☐$/.test(String(t).trim());
      return cell(t, widths[c], { fill: isLabel, bold: isLabel, align: isLabel ? C : (al(c) || (short && !b.labelCols ? C : L)) });
    }) })));
    return new d.Table({ width: { size: W, type: d.WidthType.DXA }, columnWidths: widths, layout: d.TableLayoutType.FIXED, rows });
  }

  let pendingGap = false;
  doc.blocks.forEach((b, bi) => {
    if (b.type === "gap") { pendingGap = true; return; }
    const before = pendingGap ? 120 : 0;
    pendingGap = false;
    if (b.type === "table") { const t = table(b); if (t) { out.push(t); out.push(P([], { spacing: { after: 60 } })); } return; }
    if (b.type === "rule") { out.push(P([], { border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: "000000", space: 1 } }, spacing: { after: 120 } })); return; }
    if (b.type === "form") {
      out.push(P(runs(b.tag, { size: 18 }), { alignment: L, pageBreakBefore: true, spacing: { after: 120 } }));
      if (b.title) out.push(P(runs(b.title, { bold: true, size: 30 }), { alignment: C, spacing: { before: 120, after: 240 } }));
      afterSender = false;
      return;
    }
    if (b.type === "chapter") { out.push(P(runs(b.text, { bold: true, size: 22 }), { alignment: C, keepNext: true, spacing: { before: 240, after: 120 } })); return; }
    if (b.type === "heading") { out.push(P(runs(b.text, { bold: true, size: 21 }), { alignment: L, keepNext: true, spacing: { before: 200, after: 80 } })); return; }
    // line
    const c = classify(b.text, kind);
    const small = afterSender ? { size: 17 } : null;
    switch (c.role) {
      case "article": {
        const head = new d.TextRun({ text: c.head.replace(/\s+(?=\()/, ""), bold: true, font: FONT, size: SZ });
        if (c.text) out.push(P([head, new d.TextRun({ text: " ", font: FONT, size: SZ })].concat(runs(c.text)), { spacing: { before: 160, after: 60, line: LINE } }));
        else out.push(P([head], { keepNext: true, spacing: { before: 160, after: 40, line: LINE } }));
        break;
      }
      case "hang": out.push(hangPara(c.mark, c.text, 340, 340)); break;
      case "ho": out.push(hangPara(c.mark, c.text, 700, 360)); break;
      case "mok": out.push(hangPara(c.mark, c.text, 1060, 360)); break;
      case "item": {
        // 공문: 첫 단계는 왼쪽 기본선, 그 아래는 두 글자(약 400)씩 들여 쓴다
        const left = c.level * 400 + 400, hang = 400;
        out.push(hangPara(c.mark, c.text, left, hang));
        break;
      }
      case "bullet": out.push(hangPara(c.mark, c.text, 340, 340)); break;
      case "letterhead": {
        const isTitle = /제\s*목/.test(c.label);
        out.push(P([new d.TextRun({ text: c.label.replace(/\s+/g, "") + "\t", bold: true, font: FONT, size: SZ })].concat(runs(c.text, { bold: isTitle })), Object.assign({ tabStops: [{ type: d.TabStopType.LEFT, position: 1000 }], indent: { left: 1000, hanging: 1000 }, spacing: { before, after: 60, line: LINE } }, isTitle ? { border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: "000000", space: 4 } }, spacing: { after: 200, line: LINE } } : {})));
        break;
      }
      case "attach": out.push(P(runs(c.text), { spacing: { before: 120, after: 60, line: LINE }, indent: { left: 700, hanging: 700 } })); break;
      case "sender":
        out.push(P(runs(c.text, { bold: true, size: 30 }), { alignment: C, spacing: { before: 600, after: 300 } }));
        afterSender = true;
        out.push(P([], { border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: "000000", space: 1 } }, spacing: { after: 80 } }));
        break;
      case "center": out.push(P(runs(c.text, { bold: !!c.bold, size: c.bold ? 22 : 21 }), { alignment: C, spacing: { before: Math.max(before, 200), after: 160 } })); break;
      case "right": out.push(P(runs(c.text, { size: 21 }), { alignment: R, spacing: { before, after: 100 } })); break;
      default: out.push(P(runs(c.text, small || undefined), { spacing: { before, after: 60, line: LINE } }));
    }
  });

  const footerKids = kind === "letter"
    ? [new d.TextRun({ text: "- ", size: 16, font: FONT }), new d.TextRun({ children: [d.PageNumber.CURRENT], size: 16, font: FONT }), new d.TextRun({ text: " -", size: 16, font: FONT })]
    : [new d.TextRun({ text: "- ", size: 16, font: FONT }), new d.TextRun({ children: [d.PageNumber.CURRENT], size: 16, font: FONT }), new d.TextRun({ text: " / ", size: 16, font: FONT }), new d.TextRun({ children: [d.PageNumber.TOTAL_PAGES], size: 16, font: FONT }), new d.TextRun({ text: " -", size: 16, font: FONT })];
  const document = new d.Document({
    creator: "", lastModifiedBy: "", title: doc.title,
    styles: { default: { document: { run: { font: FONT, size: SZ } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      footers: { default: new d.Footer({ children: [new d.Paragraph({ alignment: C, children: footerKids })] }) },
      children: out,
    }],
  });
  // 조문 인용 점검: 본문에 '제N조'로 인용한 조가 실제로 있는지(별지 서식 번호도)
  const text = String(md);
  const arts = new Set();
  text.replace(/^\*{0,2}제\s*(\d+)\s*조(?:의\s*(\d+))?\s*\(/gm, (m, a, b) => { arts.add(b ? a + "의" + b : a); return m; });
  if (arts.size) {
    const cited = new Set();
    text.replace(/제\s*(\d+)\s*조(?:의\s*(\d+))?(?!\s*\()/g, (m, a, b) => { cited.add(b ? a + "의" + b : a); return m; });
    // 법령 인용(「…」 제N조)은 빼고 본다
    const lawCited = new Set();
    text.replace(/」\s*제\s*(\d+)\s*조/g, (m, a) => { lawCited.add(a); return m; });
    const missing = [...cited].filter((x) => !arts.has(x) && !lawCited.has(x));
    if (missing.length) warnings.push(`본문에서 인용한 조 중 문서에 없는 조가 있습니다(법령 인용이면 무시): 제${missing.join("조, 제")}조`);
  }
  const forms = new Set(); text.replace(/^##\s*\[별지\s*제\s*(\d+)\s*호/gm, (m, a) => { forms.add(a); return m; });
  const citedForms = new Set(); text.replace(/별지\s*제\s*(\d+)\s*호/g, (m, a) => { citedForms.add(a); return m; });
  const mf = [...citedForms].filter((x) => !forms.has(x));
  if (mf.length) warnings.push(`본문에서 인용한 별지 중 문서에 없는 서식이 있습니다: 별지 제${mf.join("호, 제")}호`);
  return { document, title: doc.title, kind: doc.kind, label: doc.label, warnings };
}

module.exports = { kindOf, parse, build, classify };
