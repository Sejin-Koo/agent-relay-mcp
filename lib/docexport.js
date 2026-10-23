// 페이지(업무 에이전트 원본)의 문서 변환 모듈을 그대로 옮긴 것 — 마크다운 → 문서 모델(mdToModel), 표 열 판단(colInfo), 문서 서식(setStyle).
// 페이지와 같은 해석을 쓰기 위해 고치지 않고 둔다. 페이지 쪽을 고치면 여기도 같이 옮긴다.
var DocExport = (function () {
  "use strict";
  var FONT = "맑은 고딕";
  var NAVY = "1F3864", BLUE = "2E5395", GRAY = "595959", LGRAY = "808080";

  /* ---------- 문서 서식 값: 중계 서버 설정(doc_style)으로 바꿀 수 있다. 값이 없거나 형식이 틀리면 아래 기본값 ---------- */
  var DEFAULT_STYLE = {
    font: "맑은 고딕",
    colors: { title: "1F3864", h1: "1F3864", h2: "2E5395", th_bg: "2E5395", th_fg: "FFFFFF", sub: "595959", muted: "808080",
      caption: "1F3864", border: "auto", box_bg: "F2F4F8", box_line: "2E5395" },
    word: { margin: { top: 1134, bottom: 1134, left: 1440, right: 1440 },
      size: { title: 36, subtitle: 20, h1: 26, h2: 23, body: 21, th: 20, td: 19, caption: 20, src: 17, header: 16, footer: 18, cover_title: 40, cover_sub: 24 },
      line: 276, after: 120, h1_space: [320, 160], h2_space: [200, 100],
      cell: { top: 80, bottom: 80, left: 100, right: 100, line: 276, after: 120 },
      bullet: { l0: "-", l1: "▪", hang_narrow: 170, hang_wide: 266, step: 340 } },
    hwpx: { size: { title: 2000, h1: 1300, h2: 1100, body: 1000, small: 900, th: 900, td: 900 } },
    pptx: { title: 24, body: 16, table: 12, max_lines: 12, table_rows: 9 },
    pdf: { body: 13.5, table: 12 },
    elements: { caption: true, source_line: true, summary_box: true, confidential: "", cover_min_pages: 9 },
    chart: { colors: ["2E5395", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47", "1F3864", "C00000"], font: "Noto Sans KR", width: 900, height: 480 }
  };
  var STYLE = JSON.parse(JSON.stringify(DEFAULT_STYLE));
  var HEX = /^[0-9A-Fa-f]{6}$/;
  function mergeStyle(dst, src, path) {
    Object.keys(src || {}).forEach(function (k) {
      if (!(k in dst)) return;
      var dv = dst[k], sv = src[k], key = path + k;
      if (Array.isArray(dv)) {
        if (Array.isArray(sv) && sv.length && sv.every(function (x) { return typeof x === typeof dv[0]; })) {
          if (key === "chart.colors" && !sv.every(function (x) { return HEX.test(x); })) return;
          dst[k] = sv.slice(0, 20);
        }
      } else if (dv && typeof dv === "object") {
        if (sv && typeof sv === "object" && !Array.isArray(sv)) mergeStyle(dv, sv, key + ".");
      } else if (typeof dv === "number") {
        if (typeof sv === "number" && isFinite(sv) && sv >= 0 && sv <= 100000) dst[k] = sv;
      } else if (typeof dv === "boolean") {
        if (typeof sv === "boolean") dst[k] = sv;
      } else if (typeof dv === "string") {
        if (typeof sv !== "string") return;
        if (path === "colors." && !(HEX.test(sv) || sv === "auto")) return;
        dst[k] = sv.slice(0, 80);
      }
    });
  }
  function setStyle(cfg) {
    STYLE = JSON.parse(JSON.stringify(DEFAULT_STYLE));
    if (cfg && typeof cfg === "object") mergeStyle(STYLE, cfg, "");
    FONT = STYLE.font; NAVY = STYLE.colors.h1; BLUE = STYLE.colors.h2; GRAY = STYLE.colors.sub; LGRAY = STYLE.colors.muted;
    COVER_MIN_PAGES = STYLE.elements.cover_min_pages;
  }
  function getStyle() { return STYLE; }
  // 그림(차트) 데이터를 표로 바꾼다 — 그림을 넣을 수 없는 형식(한글·Excel)에서 쓴다
  function figureTable(spec) {
    if (!spec || !Array.isArray(spec.series) || !spec.series.length) return null;
    var x = Array.isArray(spec.x) ? spec.x : null;
    if (spec.type === "pie" || (!x && spec.series[0] && Array.isArray(spec.series[0].data) && spec.series[0].data[0] && typeof spec.series[0].data[0] === "object")) {
      var d0 = spec.series[0].data || [];
      return { headers: ["항목", (spec.series[0].name || "값") + (spec.unit ? "(" + spec.unit + ")" : "")],
        rows: d0.map(function (p, i) {
          var obj = p && typeof p === "object", v = obj ? p.value : p, nm = obj ? p.name : (x ? x[i] : "");
          return [String(nm == null ? "" : nm), typeof v === "number" ? v.toLocaleString("ko-KR", { maximumFractionDigits: 4 }) : String(v == null ? "" : v)]; }) };
    }
    if (!x) return null;
    var headers = [spec.x_name || "구분"].concat(spec.series.map(function (sr, i) { return (sr.name || ("계열" + (i + 1))) + (spec.unit ? "(" + spec.unit + ")" : ""); }));
    var f = function (v) { return v == null ? "" : typeof v === "number" ? v.toLocaleString("ko-KR", { maximumFractionDigits: 4 }) : String(v); };
    var rows = x.map(function (xv, i) { return [String(xv)].concat(spec.series.map(function (sr) { return f((sr.data || [])[i]); })); });
    return { headers: headers, rows: rows };
  }

  function decode(s) {
    return s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  }
  // 굵게(**)만 살리고 나머지 인라인 마크다운은 글자만 남김
  function parseInline(s) {
    s = decode(String(s == null ? "" : s))
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\(agent:[^)\s]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, function (_, t, u) { return t === u ? u : t + " (" + u + ")"; })
      .replace(/`([^`]+)`/g, "$1")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, "");
    var runs = [], re = /\*\*([^*]+)\*\*|__([^_]+)__/g, last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) runs.push({ text: s.slice(last, m.index), bold: false });
      runs.push({ text: m[1] || m[2], bold: true });
      last = re.lastIndex;
    }
    if (last < s.length) runs.push({ text: s.slice(last), bold: false });
    runs.forEach(function (r) {
      r.text = r.text.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1$2").replace(/~~([^~]+)~~/g, "$1");
    });
    return runs.filter(function (r) { return r.text.length; });
  }
  function plain(s) { return parseInline(s).map(function (r) { return r.text; }).join(""); }

  function mdToModel(md, lexer, meta) {
    meta = meta || {};
    var model = { title: "", subtitle: meta.subtitle || "", question: meta.question || "",
      header: meta.header || "", sections: [], source: [] };
    var cur = null;
    function sec(h) { cur = { heading: h, blocks: [] }; model.sections.push(cur); }
    function add(b) { if (!cur) sec(""); cur.blocks.push(b); }
    var toks = lexer(String(md || ""));
    toks.forEach(function (t) {
      if (t.type === "heading") {
        var tx = plain(t.text);
        // 답변 제목에 붙은 번호("1. 요약", "Ⅱ. 재무")는 떼어 낸다 — 파일이 절 번호를 자동으로 붙이므로 "1. 1. 요약"이 되는 것을 막는다
        if (t.depth <= 2) tx = tx.replace(/^\s*(\d{1,2}|[IVX]{1,4}|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ])\s*[.)．]\s*/, "").trim() || tx;
        if (t.depth === 1 && !model.title) model.title = tx;
        else if (t.depth <= 2) sec(tx);
        else add({ type: "h3", text: tx });
      } else if (t.type === "paragraph" || t.type === "text") {
        var raw = String(t.text || "").trim();
        if (!raw) return;
        // 이미지 한 개뿐인 문단(![캡션](파일.png "자료: …"))은 그림 블록으로 — 파일 만들기 명령(scripts/build-file.js)에서만 켠다
        if (meta.images && t.tokens && t.tokens.length === 1 && t.tokens[0].type === "image") {
          var im = t.tokens[0];
          add({ type: "figure", kind: "image", spec: null, src: String(im.href || ""), title: plain(im.text || ""), source: String(im.title || "").replace(/^\s*자료\s*[:：]\s*/, "") });
          return;
        }
        if (/^[*_\s]*출처\s*[*_]*\s*[:：]/.test(raw)) {
          model.source.push(plain(raw).replace(/^\s*출처\s*[:：]\s*/, ""));
          return;
        }
        // 표 제목("[표 1] 회사 식별정보")과 표 아래 자료 줄("자료: …")은 계정 Word 서식처럼 따로 꾸민다
        if (/^[*_\s]*\[(표|그림)\s*\d+\]/.test(raw)) add({ type: "p", role: "caption", text: raw.replace(/^[*_\s]+|[*_\s]+$/g, "") });
        else if (/^[*_\s]*자료\s*[:：]/.test(raw)) add({ type: "p", role: "src", text: raw.replace(/^[*_\s]+/, "") });
        else add({ type: "p", text: raw });
      } else if (t.type === "list") {
        var items = [];
        (function walk(list, lvl) {
          var n = Number(list.start) || 1;
          list.items.forEach(function (it) {
            var first = (it.tokens || []).filter(function (x) { return x.type === "text" || x.type === "paragraph"; })[0];
            var tx = first ? first.text : String(it.text || "");
            items.push({ text: tx.split("\n")[0], level: lvl, ordered: !!list.ordered, n: n++ });
            (it.tokens || []).forEach(function (x) { if (x.type === "list") walk(x, lvl + 1); });
          });
        })(t, 0);
        add({ type: "bullets", items: items });
      } else if (t.type === "table") {
        var headers = t.header.map(function (c) { return plain(c.text); });
        var rows = t.rows.map(function (r) {
          var row = r.map(function (c) { return plain(c.text); });
          while (row.length < headers.length) row.push("");
          return row.slice(0, headers.length);
        });
        add({ type: "table", headers: headers, rows: rows });
      } else if (t.type === "blockquote") {
        var q = String(t.text || "").trim();
        if (q) add({ type: "note", text: q });
      } else if (t.type === "code" && /^(chart|diagram)$/i.test(t.lang || "")) {
        // 그림 블록: JSON 설정만 받는다(코드는 실행하지 않음). 형식이 틀리면 건너뛴다
        var spec = null;
        try { spec = JSON.parse(t.text); } catch (e) { spec = null; }
        if (spec && typeof spec === "object") add({ type: "figure", kind: t.lang.toLowerCase(), spec: spec, title: String(spec.title || ""), source: String(spec.source || "") });
      } else if (t.type === "code") {
        add({ type: "p", text: t.text });
      }
    });
    if (!model.title) model.title = meta.fallbackTitle || "에이전트 답변";
    model.sections = model.sections.filter(function (s) { return s.heading || s.blocks.length; });
    // 본문에 '출처' 절이 있으면 끝의 '출처:' 줄은 같은 내용의 반복이므로 따로 붙이지 않는다
    if (model.sections.some(function (s) { return /출처/.test(s.heading || ""); })) model.source = [];
    return model;
  }

  // 표 열 성격 판단: 숫자 열(3자리 이상 섞이면 오른쪽, 아니면 가운데), 짧은 값 열 가운데, 첫 열·긴 글 왼쪽
  var NUM_RE = /^[\s(+\-−△▲▼]*\d[\d,]*(\.\d+)?\s*(%p|%|원|억원|조원|백만원|천원|만원|달러|명|건|개|곳|일|개월|년|배|℃|mm|cm|회|세대|주|점|호|위)?\)?\s*$/;
  function colInfo(headers, rows) {
    var info = [];
    for (var i = 0; i < headers.length; i++) {
      var cells = rows.map(function (r) { return String(r[i] == null ? "" : r[i]).trim(); }).filter(Boolean);
      var align = "left";
      if (cells.length && cells.every(function (c) { return NUM_RE.test(c); })) {
        var big = cells.some(function (c) { var m = c.replace(/,/g, "").match(/\d+/); return m && m[0].length >= 3; });
        align = big ? "right" : "center";
      } else if (i > 0 && cells.length && cells.every(function (c) { return c.length <= 12; })) {
        align = "center";
      }
      var maxLen = Math.max(String(headers[i] || "").length,
        cells.reduce(function (m, c) { return Math.max(m, c.length); }, 0));
      info.push({ align: align, weight: Math.min(Math.max(maxLen, 3), 36) });
    }
    var sum = info.reduce(function (s, x) { return s + x.weight; }, 0) || 1;
    info.forEach(function (x) { x.ratio = x.weight / sum; });
    return info;
  }
  function splitWidths(total, info, minEach) {
    if (info.length * minEach >= total) return info.map(function () { return Math.floor(total / info.length); });
    var free = total - info.length * minEach;
    var w = info.map(function (x) { return minEach + Math.floor(free * x.ratio); });
    var diff = total - w.reduce(function (a, b) { return a + b; }, 0);
    var big = 0; w.forEach(function (v, i) { if (v > w[big]) big = i; });
    w[big] += diff;
    return w;
  }

  /* ---------- 공통: 표지·목차 ---------- */
  var DEPT = "업무 에이전트 작성 자료", CREATOR = "업무 에이전트";
  function setLabels(o) { if (o && o.dept) DEPT = String(o.dept); if (o && o.creator) CREATOR = String(o.creator); }
  var COVER_MIN_PAGES = 9; // 본문 10쪽 이상이면 표지·목차. 경계값(9~11쪽)은 붙이는 쪽으로 판단
  // 목차 항목 = 절 제목(1단계, "n. 제목") + 소제목(2단계). Word 북마크 키는 toc_<순번>
  function headList(model) {
    var out = [], hn = 0;
    model.sections.forEach(function (s) {
      if (s.heading) { hn++; out.push({ text: hn + ". " + s.heading, level: 1 }); }
      s.blocks.forEach(function (b) { if (b.type === "h3") out.push({ text: b.text, level: 2 }); });
    });
    out.forEach(function (h, i) { h.key = "toc_" + i; });
    return out;
  }
  function roman(n) {
    var r = "", t = [[10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
    t.forEach(function (p) { while (n >= p[0]) { r += p[1]; n -= p[0]; } });
    return r;
  }

  /* ---------- Word ---------- */
  // opt.cover=true 이면 표지(쪽번호 없음) / 목차(로마숫자) / 본문(1부터, "- n/구역전체 -") 3구역으로 만든다.
  // opt.pages 는 목차 항목별 본문 쪽번호(실측 추정값). Word에서 열 때 필드 갱신으로 다시 계산된다.
  function buildDocx(model, d, opt) {
    model._diag = [];
    opt = opt || {};
    var cover = !!opt.cover;
    var WS = STYLE.word, SZ = WS.size, C = STYLE.colors, EL = STYLE.elements;
    var AL = { left: d.AlignmentType.LEFT, center: d.AlignmentType.CENTER, right: d.AlignmentType.RIGHT };
    var W = 11906 - WS.margin.left - WS.margin.right;
    var heads = headList(model), hi = 0, figN = 0;
    function runs(text, o) {
      o = o || {};
      return parseInline(text).map(function (r) {
        return new d.TextRun({ text: r.text, bold: r.bold || !!o.bold, size: o.size || SZ.body, color: o.color, italics: !!o.italics, font: FONT });
      });
    }
    function headPara(level, text) {
      var key = "toc_" + (hi++);
      var run = new d.TextRun({ text: text, font: FONT });
      return new d.Paragraph({ heading: level === 1 ? d.HeadingLevel.HEADING_1 : d.HeadingLevel.HEADING_2,
        children: cover ? [new d.Bookmark({ id: key, children: [run] })] : [run] });
    }
    var kids = [];
    if (!cover) {
      kids.push(new d.Paragraph({ alignment: AL.center, spacing: { after: 120 },
        children: [new d.TextRun({ text: model.title, bold: true, size: SZ.title, color: C.title, font: FONT })] }));
      if (model.subtitle) kids.push(new d.Paragraph({ alignment: AL.center, spacing: { after: 240 },
        children: [new d.TextRun({ text: model.subtitle, size: SZ.subtitle, color: C.sub, font: FONT })] }));
      if (model.question) kids.push(new d.Paragraph({ spacing: { after: 240 },
        shading: { type: d.ShadingType.CLEAR, color: "auto", fill: C.box_bg },
        children: [new d.TextRun({ text: "질의  ", bold: true, size: SZ.td, color: C.h2, font: FONT }),
          new d.TextRun({ text: model.question, size: SZ.td, color: C.sub, font: FONT })] }));
    }
    var hn = 0;
    var border = { style: d.BorderStyle.SINGLE, size: 4, color: C.border };
    function blockParas(s, b, out, inBox) {
      var nextB = s.blocks[s.blocks.indexOf(b) + 1];
      if (b.type === "h3") {
        out.push(headPara(2, b.text));
      } else if (b.type === "p" && b.role === "caption") {
        if (EL.caption) out.push(new d.Paragraph({ keepNext: true, spacing: { before: 120, after: 80 }, children: runs(plain(b.text), { bold: true, color: C.caption, size: SZ.caption }) }));
      } else if (b.type === "p" && b.role === "src") {
        if (EL.source_line) out.push(new d.Paragraph({ spacing: { before: 60, after: 160 }, children: runs(b.text, { color: C.muted, size: SZ.src }) }));
      } else if (b.type === "p") {
        // 표 바로 앞 문단(리드 문장)은 표와 같은 쪽에 두어 표만 다음 쪽으로 넘어가지 않게 한다
        var keep = !!(nextB && (nextB.type === "table" || nextB.type === "figure" || nextB.role === "caption"));
        String(b.text).split(/\n+/).forEach(function (line) { if (line.trim()) out.push(new d.Paragraph({ keepNext: keep, children: runs(line) })); });
      } else if (b.type === "note") {
        out.push(new d.Paragraph({ indent: { left: 284 },
          border: { left: { style: d.BorderStyle.SINGLE, size: 12, color: "BFBFBF", space: 8 } },
          children: runs(b.text, { color: C.sub, size: SZ.subtitle }) }));
      } else if (b.type === "bullets") {
        var BU = WS.bullet;
        b.items.forEach(function (it) {
          var lvl = it.level || 0;
          var sym = it.ordered ? it.n + "." : (lvl ? BU.l1 : BU.l0);
          var narrow = !it.ordered && /^[-–·▪•]$/.test(sym);
          var hang = narrow ? BU.hang_narrow : BU.hang_wide;
          out.push(new d.Paragraph({ indent: { left: hang + lvl * BU.step, hanging: hang }, spacing: { after: 60 },
            children: [new d.TextRun({ children: [sym, new d.Tab()], size: SZ.body, font: FONT })].concat(runs(it.text)) }));
        });
      } else if (b.type === "figure") {
        figN++;
        var cap = "[그림 " + figN + "] " + (b.title || "");
        if (b.img && b.img.bytes) {
          var maxW = inBox ? W - 400 : W;
          var wPx = Math.round(maxW / 1440 * 96), hPx = Math.round(wPx * b.img.h / b.img.w);
          // 세로로 긴 그림은 본문 높이의 55%를 넘지 않게 줄인다
          var maxHPx = Math.round((16838 - WS.margin.top - WS.margin.bottom) / 1440 * 96 * 0.55);
          if (hPx > maxHPx) { wPx = Math.round(wPx * maxHPx / hPx); hPx = maxHPx; }
          out.push(new d.Paragraph({ keepNext: true, spacing: { before: 120, after: 80 }, children: runs(cap, { bold: true, color: C.caption, size: SZ.caption }) }));
          var imo = { type: "png", data: b.img.bytes, transformation: { width: wPx, height: hPx } };
          // 도식은 이름표를 달아 두고, 파일을 만든 뒤 실제 도형 묶음으로 바꾼다(그림은 대체본으로 남음)
          if (b.img.lay) { model._diag = model._diag || []; imo.altText = { name: "DIAGRAM_" + model._diag.length, description: cap, title: cap }; model._diag.push(b.img.lay); }
          out.push(new d.Paragraph({ keepNext: !!b.source, alignment: AL.center, spacing: { before: 0, after: 60, line: 240, lineRule: "auto" }, children: [new d.ImageRun(imo)] }));
        } else {
          out.push(new d.Paragraph({ children: runs(cap + " (그림을 만들지 못해 생략함)", { color: C.muted, size: SZ.src }) }));
        }
        if (b.source && EL.source_line) out.push(new d.Paragraph({ spacing: { before: 60, after: 160 }, children: runs("자료: " + b.source, { color: C.muted, size: SZ.src }) }));
      } else if (b.type === "table") {
        var info = colInfo(b.headers, b.rows);
        var tw = inBox ? W - 400 : W;
        var widths = splitWidths(tw, info, 700);
        var CL = WS.cell;
        var cell = function (text, i, head) {
          var o = { width: { size: widths[i], type: d.WidthType.DXA },
            margins: { top: CL.top, bottom: CL.bottom, left: CL.left, right: CL.right },
            verticalAlign: d.VerticalAlign.CENTER,
            children: [new d.Paragraph({ alignment: head ? AL.center : AL[info[i].align], spacing: { after: CL.after, line: CL.line, lineRule: "auto" },
              children: head ? [new d.TextRun({ text: text, bold: true, color: C.th_fg, size: SZ.th, font: FONT })] : runs(text, { size: SZ.td }) })] };
          if (head) o.shading = { fill: C.th_bg, type: d.ShadingType.CLEAR, color: "auto" };
          return new d.TableCell(o);
        };
        var rows = [new d.TableRow({ tableHeader: true, cantSplit: true, children: b.headers.map(function (h, i) { return cell(h, i, true); }) })]
          .concat(b.rows.map(function (r) { return new d.TableRow({ cantSplit: true, children: b.headers.map(function (_, i) { return cell(r[i] || "", i, false); }) }); }));
        out.push(new d.Table({ width: { size: tw, type: d.WidthType.DXA }, columnWidths: widths,
          layout: d.TableLayoutType.FIXED,
          borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
          rows: rows }));
        if (!(nextB && nextB.role === "src" && EL.source_line)) out.push(new d.Paragraph({ spacing: { after: 120 }, children: [] }));
      }
    }
    model.sections.forEach(function (s, si) {
      if (s.heading) { hn++; kids.push(headPara(1, hn + ". " + s.heading)); }
      // 첫 절이 요약·결론이면 음영 상자 안에 넣는다(설정 elements.summary_box)
      var boxed = EL.summary_box && si === 0 && /요약|결론|summary/i.test(s.heading || "") && s.blocks.length && !s.blocks.some(function (b) { return b.type === "table" || b.type === "figure" || b.type === "h3"; });
      if (boxed) {
        var inner = [];
        s.blocks.forEach(function (b) { blockParas(s, b, inner, true); });
        var none = { style: d.BorderStyle.NONE, size: 0, color: "FFFFFF" };
        kids.push(new d.Table({ width: { size: W, type: d.WidthType.DXA }, columnWidths: [W], layout: d.TableLayoutType.FIXED,
          borders: { top: none, bottom: none, right: none, insideHorizontal: none, insideVertical: none,
            left: { style: d.BorderStyle.SINGLE, size: 24, color: C.box_line } },
          rows: [new d.TableRow({ cantSplit: false, children: [new d.TableCell({ width: { size: W, type: d.WidthType.DXA },
            shading: { fill: C.box_bg, type: d.ShadingType.CLEAR, color: "auto" },
            margins: { top: 140, bottom: 80, left: 200, right: 200 }, children: inner })] })] }));
        kids.push(new d.Paragraph({ spacing: { after: 120 }, children: [] }));
      } else {
        s.blocks.forEach(function (b) { blockParas(s, b, kids, false); });
      }
    });
    if (model.source.length) {
      kids.push(new d.Paragraph({ spacing: { before: 240, after: 60 }, children: [new d.TextRun({ text: "출처", bold: true, size: SZ.td, color: C.sub, font: FONT })] }));
      model.source.forEach(function (src) { kids.push(new d.Paragraph({ children: runs(src, { size: SZ.td, color: C.sub }) })); });
    }

    var pageProps = { size: { width: 11906, height: 16838 }, margin: { top: WS.margin.top, bottom: WS.margin.bottom, left: WS.margin.left, right: WS.margin.right } };
    var headText = [model.header || "", EL.confidential || ""].filter(Boolean).join("  |  ");
    function mkHeader() {
      return new d.Header({ children: [new d.Paragraph({ alignment: AL.right,
        border: { bottom: { style: d.BorderStyle.SINGLE, size: 4, color: "BFBFBF", space: 1 } },
        children: [new d.TextRun({ text: headText, size: SZ.header, color: C.muted, font: FONT })] })] });
    }
    function mkFooter(parts) {
      return new d.Footer({ children: [new d.Paragraph({ alignment: AL.center,
        children: [new d.TextRun({ children: parts, size: SZ.footer, font: FONT })] })] });
    }
    var dotTab = [{ type: d.TabStopType.RIGHT, position: W, leader: d.LeaderType.DOT }];
    var paragraphStyles = [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: FONT, size: SZ.h1, bold: true, color: C.h1 }, paragraph: { spacing: { before: WS.h1_space[0], after: WS.h1_space[1] }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: FONT, size: SZ.h2, bold: true, color: C.h2 }, paragraph: { spacing: { before: WS.h2_space[0], after: WS.h2_space[1] }, outlineLevel: 1 } },
      { id: "TOC1", name: "toc 1", basedOn: "Normal", next: "Normal",
        run: { font: FONT, size: SZ.body, bold: true }, paragraph: { tabStops: dotTab, spacing: { before: 80, after: 60 } } },
      { id: "TOC2", name: "toc 2", basedOn: "Normal", next: "Normal",
        run: { font: FONT, size: SZ.subtitle }, paragraph: { tabStops: dotTab, indent: { left: 400 }, spacing: { after: 40 } } }
    ];
    var sections;
    if (!cover) {
      sections = [{ properties: { page: pageProps }, headers: { default: mkHeader() },
        footers: { default: mkFooter(["- ", d.PageNumber.CURRENT, "/", d.PageNumber.TOTAL_PAGES, " -"]) }, children: kids }];
    } else {
      var coverKids = [
        new d.Paragraph({ spacing: { before: 3600, after: 0 }, children: [] }),
        new d.Paragraph({ alignment: AL.center, spacing: { after: 300 },
          children: [new d.TextRun({ text: model.title, bold: true, size: SZ.cover_title, color: C.title, font: FONT })] })
      ];
      if (model.subtitle) coverKids.push(new d.Paragraph({ alignment: AL.center, spacing: { after: 200 },
        children: [new d.TextRun({ text: model.subtitle, size: SZ.cover_sub, color: C.sub, font: FONT })] }));
      if (model.question) coverKids.push(new d.Paragraph({ alignment: AL.center, spacing: { after: 200 },
        children: [new d.TextRun({ text: "질의: " + model.question, size: SZ.subtitle, color: C.sub, font: FONT })] }));
      if (EL.confidential) coverKids.push(new d.Paragraph({ alignment: AL.center, spacing: { before: 400 },
        children: [new d.TextRun({ text: EL.confidential, bold: true, size: SZ.subtitle, color: "C00000", font: FONT })] }));
      coverKids.push(new d.Paragraph({ alignment: AL.center, spacing: { before: 4200 },
        children: [new d.TextRun({ text: DEPT, bold: true, size: SZ.cover_sub, color: C.title, font: FONT })] }));
      var pages = opt.pages || [];
      var tocKids = [new d.Paragraph({ alignment: AL.center, spacing: { after: 360 },
        children: [new d.TextRun({ text: "목 차", bold: true, size: 32, color: C.title, font: FONT })] })]
        .concat(heads.map(function (h, i) {
          return new d.Paragraph({ style: h.level === 1 ? "TOC1" : "TOC2", tabStops: dotTab,
            children: [new d.InternalHyperlink({ anchor: h.key, children: [
              new d.TextRun({ text: h.text, font: FONT }),
              new d.TextRun({ children: [new d.Tab()], font: FONT }),
              new d.TextRun({ text: String(pages[i] || 1), font: FONT })] })] });
        }));
      sections = [
        { properties: { page: pageProps }, children: coverKids },
        { properties: { page: Object.assign({}, pageProps, { pageNumbers: { start: 1, formatType: d.NumberFormat.LOWER_ROMAN } }) },
          headers: { default: mkHeader() }, footers: { default: mkFooter(["- ", d.PageNumber.CURRENT, " -"]) }, children: tocKids },
        { properties: { page: Object.assign({}, pageProps, { pageNumbers: { start: 1, formatType: d.NumberFormat.DECIMAL } }) },
          headers: { default: mkHeader() },
          footers: { default: mkFooter(["- ", d.PageNumber.CURRENT, "/", d.PageNumber.TOTAL_PAGES_IN_SECTION, " -"]) }, children: kids }
      ];
    }
    var docOpt = { creator: CREATOR, title: model.title,
      styles: { default: { document: { run: { font: FONT, size: SZ.body }, paragraph: { spacing: { line: WS.line, lineRule: "auto", after: WS.after } } } },
        paragraphStyles: paragraphStyles },
      sections: sections };
    if (cover) docOpt.features = { updateFields: true };
    return new d.Document(docOpt);
  }
  // 목차 문단들을 TOC 필드로 감싸 "필드 + 캐시된 결과" 형태로 만든다(Word F9 갱신·구글 독스 표시 모두 가능)
  function wrapTocField(xml, n) {
    var paras = [], re = /<w:p[ >][\s\S]*?<\/w:p>/g, m;
    while ((m = re.exec(xml))) if (m[0].indexOf('w:anchor="toc_') >= 0) paras.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    if (paras.length !== n) throw new Error("목차 문단 수가 제목 수와 맞지 않습니다(" + paras.length + "/" + n + ").");
    if (!n) return xml;
    var first = paras[0], last = paras[paras.length - 1];
    var BEGIN = '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve">TOC \\o "1-3" \\h \\z \\u</w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
    var END = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
    var lastClose = last.end - "</w:p>".length;
    xml = xml.slice(0, lastClose) + END + xml.slice(lastClose);
    var pPrEnd = first.text.indexOf("</w:pPr>");
    if (pPrEnd < 0) throw new Error("목차 문단 서식을 찾지 못했습니다.");
    var ins = first.start + pPrEnd + "</w:pPr>".length;
    return xml.slice(0, ins) + BEGIN + xml.slice(ins);
  }
  async function finalizeDocx(data, JSZip, n, outType, diag) {
    var zip = await JSZip.loadAsync(data);
    var xml = await zip.file("word/document.xml").async("string");
    if (n) xml = wrapTocField(xml, n);
    if (diag && diag.length && typeof Diagram !== "undefined") xml = Diagram.patchDocxXml(xml, diag, STYLE, FONT);
    zip.file("word/document.xml", xml);
    return zip.generateAsync({ type: outType || "blob", compression: "DEFLATE", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  }

  /* ---------- PowerPoint ---------- */
  // 표지 슬라이드는 항상, 전체 10장 이상이면 표지 뒤에 목차 슬라이드를 넣는다(1차로 장수를 세고 2차로 만든다)
  function buildPptx(model, P) {
    var probe = renderPptx(new P(), model, false);
    return renderPptx(new P(), model, probe.count >= 10).pptx;
  }
  function renderPptx(p, model, agenda) {
    p.layout = "LAYOUT_WIDE";
    p.title = model.title;
    var count = 0;
    var PS = STYLE.pptx, NAVY_ = STYLE.colors.title, TH = STYLE.colors.th_bg, THF = STYLE.colors.th_fg;
    var FW = 13.333, X = 0.6, CW = FW - 1.2, BODY_Y = 1.55, BODY_H = 5.25, LINE_CH = Math.round(56 * 16 / PS.body), MAX_LINES = PS.max_lines, figN = 0;
    function base(title) {
      var s = p.addSlide(); count++;
      s.background = { color: "FFFFFF" };
      s.addText(title, { x: X, y: 0.35, w: CW, h: 0.9, fontFace: FONT, fontSize: PS.title, bold: true, color: NAVY_, valign: "middle", fit: "shrink" });
      s.addShape(p.shapes.RECTANGLE, { x: X, y: 1.28, w: CW, h: 0.03, fill: { color: "D9E2F3" }, line: { color: "D9E2F3" } });
      if (model.header) s.addText(model.header, { x: X, y: 7.0, w: 9, h: 0.3, fontFace: FONT, fontSize: 10, color: LGRAY });
      s.slideNumber = { x: FW - 1.1, y: 7.0, w: 0.6, h: 0.3, fontFace: FONT, fontSize: 10, color: LGRAY, align: "right" };
      return s;
    }
    var t = p.addSlide(); count++;
    t.background = { color: "FFFFFF" };
    t.addShape(p.shapes.RECTANGLE, { x: X, y: 2.45, w: 1.2, h: 0.07, fill: { color: BLUE }, line: { color: BLUE } });
    t.addText(model.title, { x: X, y: 2.65, w: CW, h: 1.5, fontFace: FONT, fontSize: 34, bold: true, color: NAVY, valign: "top", fit: "shrink" });
    if (model.subtitle) t.addText(model.subtitle, { x: X, y: 4.25, w: CW, h: 0.5, fontFace: FONT, fontSize: 16, color: GRAY });
    if (model.question) t.addText("질의: " + model.question, { x: X, y: 4.85, w: CW, h: 1.0, fontFace: FONT, fontSize: 13, color: LGRAY, valign: "top", fit: "shrink" });
    t.addText(DEPT, { x: X, y: 6.55, w: CW, h: 0.4, fontFace: FONT, fontSize: 14, bold: true, color: NAVY });

    if (agenda) {
      var items = model.sections.filter(function (s) { return s.heading; }).map(function (s, i) { return (i + 1) + ". " + s.heading; });
      var ag = base("목차");
      var half = items.length > 8 ? Math.ceil(items.length / 2) : items.length;
      [items.slice(0, half), items.slice(half)].forEach(function (col, ci) {
        if (!col.length) return;
        ag.addText(col.map(function (x) { return { text: x, options: { breakLine: true } }; }),
          { x: X + ci * (CW / 2), y: BODY_Y, w: items.length > 8 ? CW / 2 - 0.2 : CW, h: BODY_H, fontFace: FONT, fontSize: 16, color: "262626", valign: "top", paraSpaceAfter: 10, fit: "shrink" });
      });
    }

    model.sections.forEach(function (s) {
      var title = s.heading || model.title;
      var buf = [], lines = 0, cont = false;
      function flush() {
        if (!buf.length) return;
        var sl = base(title + (cont ? " (계속)" : ""));
        sl.addText(buf, { x: X, y: BODY_Y, w: CW, h: BODY_H, fontFace: FONT, fontSize: PS.body, color: "262626", valign: "top", paraSpaceAfter: 6, fit: "shrink" });
        buf = []; lines = 0; cont = true;
      }
      function push(text, opts, est) {
        if (lines + est > MAX_LINES && buf.length) flush();
        var o = { breakLine: true };
        for (var k in opts) o[k] = opts[k];
        buf.push({ text: text, options: o });
        lines += est;
      }
      function est(tx) { return Math.max(1, Math.ceil(tx.length / LINE_CH)); }
      var pendCap = "", lastVis = null;
      s.blocks.forEach(function (b) {
        if (b.type === "p" && b.role === "caption") { pendCap = plain(b.text); return; }
        if (b.type === "p" && b.role === "src") {
          if (lastVis) lastVis.addText(plain(b.text), { x: X, y: BODY_Y + BODY_H - 0.35, w: CW, h: 0.35, fontFace: FONT, fontSize: 11, color: LGRAY });
          else { var st0 = plain(b.text); push(st0, { color: LGRAY, fontSize: 12 }, est(st0)); }
          return;
        }
        if (b.type !== "table" && b.type !== "figure") lastVis = null;
        if (b.type === "figure") {
          flush();
          figN++;
          var fs = base(title + (cont ? " (계속)" : ""));
          if (b.img && b.img.lay && typeof Diagram !== "undefined") {
            // 도식은 실제 도형·글상자·연결선으로 넣어 PowerPoint에서 바로 고칠 수 있게 한다
            Diagram.toPptx(fs, b.img.lay, STYLE, { x: X, y: BODY_Y, w: CW, h: BODY_H - 0.5 }, FONT);
          } else if (b.img && b.img.dataUrl) {
            var ih = BODY_H - 0.5, iw = ih * b.img.w / b.img.h;
            if (iw > CW) { iw = CW; ih = iw * b.img.h / b.img.w; }
            fs.addImage({ data: b.img.dataUrl, x: X + (CW - iw) / 2, y: BODY_Y, w: iw, h: ih });
          }
          fs.addText("[그림 " + figN + "] " + (b.title || "") + (b.source ? "  · 자료: " + b.source : ""), { x: X, y: BODY_Y + BODY_H - 0.4, w: CW, h: 0.4, fontFace: FONT, fontSize: 11, color: LGRAY, align: "center" });
          cont = true; lastVis = null; pendCap = "";
        } else if (b.type === "table") {
          // 표 앞의 짧은 리드 문장(2줄 이하)은 표와 같은 장에 싣는다
          var lead = buf.length && lines <= 2 ? buf.map(function (x) { return x.text; }).join(" ") : "";
          if (lead) { buf = []; lines = 0; } else flush();
          var info = colInfo(b.headers, b.rows), per = PS.table_rows;
          for (var k = 0; k < Math.max(1, b.rows.length); k += per) {
            var sl = base(title + (cont ? " (계속)" : ""));
            var ty = BODY_Y;
            if (lead && !k) { sl.addText(lead, { x: X, y: ty - 0.05, w: CW, h: 0.45, fontFace: FONT, fontSize: PS.body - 2, color: "262626", fit: "shrink" }); ty += 0.45; }
            if (pendCap) { sl.addText(pendCap + (k ? " (계속)" : ""), { x: X, y: ty - 0.05, w: CW, h: 0.4, fontFace: FONT, fontSize: 13, bold: true, color: NAVY_ }); ty += 0.42; }
            var rows = [b.headers.map(function (h) {
              return { text: h, options: { bold: true, color: THF, fill: { color: TH }, align: "center", valign: "middle" } };
            })];
            b.rows.slice(k, k + per).forEach(function (r) {
              rows.push(b.headers.map(function (_, i) { return { text: String(r[i] || ""), options: { align: info[i].align, valign: "middle" } }; }));
            });
            sl.addTable(rows, { x: X, y: ty, w: CW, colW: info.map(function (x) { return +(CW * x.ratio).toFixed(3); }),
              fontFace: FONT, fontSize: PS.table, color: "262626", border: { type: "solid", pt: 0.75, color: "BFBFBF" }, rowH: 0.42, autoPage: false });
            cont = true; lastVis = sl;
          }
          pendCap = "";
        } else if (b.type === "bullets") {
          b.items.forEach(function (it) {
            var tx = plain(it.text);
            push(tx, { bullet: it.ordered ? { type: "number" } : { indent: 18 }, indentLevel: it.level || 0 }, est(tx));
          });
        } else if (b.type === "h3") {
          push(plain(b.text), { bold: true, color: BLUE }, 1);
        } else if (b.type === "note") {
          var nt = plain(b.text);
          push(nt, { italic: true, color: GRAY }, est(nt));
        } else {
          String(b.text).split(/\n+/).forEach(function (line) { var tx = plain(line); if (tx.trim()) push(tx, {}, est(tx)); });
        }
      });
      flush();
    });
    if (model.source.length) {
      var ss = base("출처 및 기준");
      ss.addText(model.source.map(function (x) { return { text: x, options: { breakLine: true, bullet: { indent: 18 } } }; }),
        { x: X, y: BODY_Y, w: CW, h: BODY_H, fontFace: FONT, fontSize: 14, color: GRAY, valign: "top", fit: "shrink" });
    }
    return { pptx: p, count: count };
  }

  /* ---------- 쪽 배치 엔진 (PDF 그리기 + Word 쪽수 추정에 공용, 브라우저 전용) ---------- */
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function inlineHtml(s) {
    return parseInline(s).map(function (r) { return r.bold ? "<b>" + esc(r.text) + "</b>" : esc(r.text); }).join("");
  }
  var PW = 794, PH = 1123, PX = 72, PT = 70, PB = 70;
  function hostCss(H) {
    var C = STYLE.colors, P = STYLE.pdf, c = function (x) { return x === "auto" ? "#000" : "#" + x; };
    return H + ".pg{width:" + PW + "px;height:" + PH + "px;background:#fff;color:#1a1a1a;position:relative;box-sizing:border-box;padding:" + PT + "px " + PX + "px " + PB + "px;font-family:'Malgun Gothic','맑은 고딕','Noto Sans KR',sans-serif;font-size:" + P.body + "px;line-height:1.65;overflow:hidden;word-break:keep-all;overflow-wrap:anywhere}" +
      H + ".t{font-size:24px;font-weight:700;color:" + c(C.title) + ";text-align:center;margin:6px 0 6px}" +
      H + ".st{font-size:13px;color:" + c(C.sub) + ";text-align:center;margin-bottom:16px}" +
      H + ".h1{font-size:17px;font-weight:700;color:" + c(C.h1) + ";margin:18px 0 8px}" +
      H + ".h2{font-size:15px;font-weight:700;color:" + c(C.h2) + ";margin:12px 0 6px}" +
      H + "table{width:100%;border-collapse:collapse;table-layout:fixed;margin:4px 0 12px;font-size:" + P.table + "px;line-height:1.45}" +
      H + "th{background:" + c(C.th_bg) + ";color:" + c(C.th_fg) + ";font-weight:700;text-align:center;border:1px solid #9aa7bd;padding:5px 7px}" +
      H + ".cap{font-size:12.5px;font-weight:700;color:" + c(C.caption) + ";margin:10px 0 4px}" +
      H + ".srcl{font-size:11px;color:" + c(C.muted) + ";margin:-6px 0 12px}" +
      H + ".box{background:" + c(C.box_bg) + ";border-left:4px solid " + c(C.box_line) + ";padding:10px 14px;margin:0 0 12px}" +
      H + ".fig{margin:6px 0 10px;text-align:center}" + H + ".fig img{max-width:100%}";
  }
  function makeHost(doc) {
    var id = "pdf-host-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
    var host = doc.createElement("div");
    host.id = id;
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;left:0;top:0;width:" + PW + "px;opacity:0;pointer-events:none;z-index:-1;";
    var H = "#" + id + " ";
    var css = doc.createElement("style");
    css.textContent =
      H + ".pg{width:" + PW + "px;height:" + PH + "px;background:#fff;color:#1a1a1a;position:relative;box-sizing:border-box;padding:" + PT + "px " + PX + "px " + PB + "px;font-family:'Malgun Gothic','맑은 고딕','Noto Sans KR',sans-serif;font-size:13.5px;line-height:1.65;overflow:hidden;word-break:keep-all;overflow-wrap:anywhere}" +
      H + ".bd{height:" + (PH - PT - PB) + "px;overflow:hidden}" +
      H + ".hd{position:absolute;left:" + PX + "px;right:" + PX + "px;top:30px;text-align:right;font-size:10.5px;color:#808080;border-bottom:1px solid #bfbfbf;padding-bottom:4px}" +
      H + ".ft{position:absolute;left:0;right:0;bottom:30px;text-align:center;font-size:11px;color:#404040}" +
      H + ".t{font-size:24px;font-weight:700;color:#1F3864;text-align:center;margin:6px 0 6px}" +
      H + ".st{font-size:13px;color:#595959;text-align:center;margin-bottom:16px}" +
      H + ".q{font-size:12.5px;color:#595959;background:#F2F4F8;padding:8px 12px;margin-bottom:14px}" +
      H + ".q b{color:#2E5395;margin-right:8px}" +
      H + ".h1{font-size:17px;font-weight:700;color:#1F3864;margin:18px 0 8px}" +
      H + ".h2{font-size:15px;font-weight:700;color:#2E5395;margin:12px 0 6px}" +
      H + ".p{margin:0 0 8px}" +
      H + ".li{position:relative;padding-left:16px;margin:0 0 4px}" +
      H + ".li .s{position:absolute;left:0;top:0}" +
      H + ".note{border-left:3px solid #bfbfbf;padding-left:10px;color:#595959;margin:0 0 8px}" +
      H + "table{width:100%;border-collapse:collapse;table-layout:fixed;margin:4px 0 12px;font-size:12px;line-height:1.45}" +
      H + "th{background:#2E5395;color:#fff;font-weight:700;text-align:center;border:1px solid #9aa7bd;padding:5px 7px}" +
      H + "td{border:1px solid #bfbfbf;padding:5px 7px;vertical-align:middle}" +
      H + ".src{margin-top:16px;font-size:12px;color:#595959}" +
      H + ".cv{display:flex;flex-direction:column;align-items:center;text-align:center}" +
      H + ".cv .ct{margin-top:300px;font-size:30px;font-weight:700;color:#1F3864;line-height:1.35}" +
      H + ".cv .cs{margin-top:18px;font-size:16px;color:#595959}" +
      H + ".cv .cq{margin-top:12px;font-size:13px;color:#808080;max-width:560px}" +
      H + ".cv .cd{margin-top:auto;margin-bottom:60px;font-size:16px;font-weight:700;color:#1F3864}" +
      H + ".tt{font-size:22px;font-weight:700;color:#1F3864;text-align:center;letter-spacing:.3em;margin:10px 0 28px}" +
      H + ".te{display:flex;align-items:baseline;gap:8px;margin:0 0 9px;font-weight:700}" +
      H + ".te.l2{padding-left:22px;font-weight:400;font-size:12.5px;margin-bottom:6px}" +
      H + ".te .ld{flex:1;border-bottom:1px dotted #808080;transform:translateY(-4px);min-width:20px}" +
      H + ".te .pn{font-variant-numeric:tabular-nums}" + hostCss(H);
    host.appendChild(css);
    doc.body.appendChild(host);
    return { host: host, id: id };
  }
  // 본문을 A4 쪽으로 흘려 담는다. titleBlock=false 면 제목·부제·질의를 빼고(표지로 이동) 본문만.
  function layout(H, doc, model, titleBlock) {
    var pages = [], heads = [], bd = null;
    function newPage() {
      var pg = doc.createElement("div"); pg.className = "pg";
      if (model.header) { var hd = doc.createElement("div"); hd.className = "hd"; hd.textContent = model.header; pg.appendChild(hd); }
      bd = doc.createElement("div"); bd.className = "bd"; pg.appendChild(bd);
      H.host.appendChild(pg); pages.push(pg);
    }
    function over() { return bd.scrollHeight > bd.clientHeight + 1; }
    function place(el) {
      bd.appendChild(el);
      if (over() && bd.children.length > 1) { bd.removeChild(el); newPage(); bd.appendChild(el); }
    }
    function el(cls, html) { var e = doc.createElement("div"); e.className = cls; e.innerHTML = html; return e; }
    function placeTable(b) {
      var info = colInfo(b.headers, b.rows);
      function mk() {
        var tb = doc.createElement("table");
        tb.innerHTML = "<colgroup>" + info.map(function (x) { return '<col style="width:' + (x.ratio * 100).toFixed(2) + '%">'; }).join("") + "</colgroup>" +
          "<thead><tr>" + b.headers.map(function (h) { return "<th>" + esc(h) + "</th>"; }).join("") + "</tr></thead><tbody></tbody>";
        return tb;
      }
      var tb = mk(); bd.appendChild(tb);
      if (over() && bd.children.length > 1) { bd.removeChild(tb); newPage(); tb = mk(); bd.appendChild(tb); }
      var body = tb.querySelector("tbody");
      b.rows.forEach(function (r) {
        var tr = doc.createElement("tr");
        tr.innerHTML = b.headers.map(function (_, i) { return '<td style="text-align:' + info[i].align + '">' + inlineHtml(r[i] || "") + "</td>"; }).join("");
        body.appendChild(tr);
        if (over() && body.children.length > 1) {
          body.removeChild(tr); newPage(); tb = mk(); bd.appendChild(tb); body = tb.querySelector("tbody"); body.appendChild(tr);
        }
      });
    }
    newPage();
    if (titleBlock) {
      place(el("t", esc(model.title)));
      if (model.subtitle) place(el("st", esc(model.subtitle)));
      if (model.question) place(el("q", "<b>질의</b>" + esc(model.question)));
    }
    var hn = 0, figN = 0;
    model.sections.forEach(function (s) {
      if (s.heading) {
        hn++; var tx = hn + ". " + s.heading;
        place(el("h1", esc(tx))); heads.push({ text: tx, level: 1, page: pages.length });
      }
      var si = model.sections.indexOf(s);
      if (STYLE.elements.summary_box && si === 0 && /요약|결론|summary/i.test(s.heading || "") && s.blocks.length &&
          !s.blocks.some(function (b) { return b.type === "table" || b.type === "figure" || b.type === "h3"; })) {
        var html = s.blocks.map(function (b) {
          if (b.type === "bullets") return b.items.map(function (it) { return '<div class="li" style="margin-left:' + ((it.level || 0) * 16) + 'px"><span class="s">' + (it.ordered ? it.n + "." : (it.level ? "▪" : "-")) + "</span>" + inlineHtml(it.text) + "</div>"; }).join("");
          return '<div class="p">' + inlineHtml(b.text || "") + "</div>";
        }).join("");
        place(el("box", html));
        return;
      }
      s.blocks.forEach(function (b) {
        if (b.type === "h3") { place(el("h2", esc(b.text))); heads.push({ text: b.text, level: 2, page: pages.length }); }
        else if (b.type === "p" && b.role === "caption") { if (STYLE.elements.caption) place(el("cap", inlineHtml(plain(b.text)))); }
        else if (b.type === "p" && b.role === "src") { if (STYLE.elements.source_line) place(el("srcl", inlineHtml(b.text))); }
        else if (b.type === "figure") {
          figN++;
          // 그림 제목·그림·자료 줄을 한 덩어리로 놓아 쪽이 갈려도 떨어지지 않게 한다
          place(el("figblk", '<div class="cap">' + esc("[그림 " + figN + "] " + (b.title || "")) + "</div>" +
            (b.img && b.img.dataUrl ? '<div class="fig"><img src="' + b.img.dataUrl + '" style="width:100%;height:' + Math.round((PW - 2 * PX) * b.img.h / b.img.w) + 'px"></div>' : "") +
            (b.source && STYLE.elements.source_line ? '<div class="srcl">' + esc("자료: " + b.source) + "</div>" : "")));
        }
        else if (b.type === "p") String(b.text).split(/\n+/).forEach(function (line) { if (line.trim()) place(el("p", inlineHtml(line))); });
        else if (b.type === "note") place(el("note", inlineHtml(b.text)));
        else if (b.type === "bullets") b.items.forEach(function (it) {
          var e = el("li", '<span class="s">' + (it.ordered ? it.n + "." : (it.level ? "▪" : "-")) + "</span>" + inlineHtml(it.text));
          e.style.marginLeft = ((it.level || 0) * 16) + "px";
          if (it.ordered) e.style.paddingLeft = "22px";
          place(e);
        });
        else if (b.type === "table") placeTable(b);
      });
    });
    if (model.source.length) place(el("src", "<b>출처</b><br>" + model.source.map(inlineHtml).join("<br>")));
    return { pages: pages, heads: heads };
  }
  function footer(doc, pg, text) { var ft = doc.createElement("div"); ft.className = "ft"; ft.textContent = text; pg.appendChild(ft); }
  function coverPage(H, doc, model) {
    var pg = doc.createElement("div"); pg.className = "pg cv";
    pg.innerHTML = '<div class="ct">' + esc(model.title) + "</div>" +
      (model.subtitle ? '<div class="cs">' + esc(model.subtitle) + "</div>" : "") +
      (model.question ? '<div class="cq">질의: ' + esc(model.question) + "</div>" : "") +
      '<div class="cd">' + esc(DEPT) + "</div>";
    H.host.appendChild(pg);
    return pg;
  }
  function tocPages(H, doc, model, heads) {
    var pages = [], bd = null;
    function newPage() {
      var pg = doc.createElement("div"); pg.className = "pg";
      if (model.header) { var hd = doc.createElement("div"); hd.className = "hd"; hd.textContent = model.header; pg.appendChild(hd); }
      bd = doc.createElement("div"); bd.className = "bd"; pg.appendChild(bd);
      H.host.appendChild(pg); pages.push(pg);
    }
    newPage();
    var tt = doc.createElement("div"); tt.className = "tt"; tt.textContent = "목 차"; bd.appendChild(tt);
    heads.forEach(function (h) {
      var e = doc.createElement("div"); e.className = "te" + (h.level === 2 ? " l2" : "");
      e.innerHTML = "<span>" + esc(h.text) + '</span><span class="ld"></span><span class="pn">' + h.page + "</span>";
      bd.appendChild(e);
      if (bd.scrollHeight > bd.clientHeight + 1 && bd.children.length > 1) { bd.removeChild(e); newPage(); bd.appendChild(e); }
    });
    return pages;
  }
  // Word 표지·목차 판단용: 본문 쪽수와 제목별 본문 쪽번호를 추정
  function estimate(model, doc) {
    var H = makeHost(doc);
    try {
      var full = layout(H, doc, model, true);
      var cover = full.pages.length >= COVER_MIN_PAGES;
      var heads = [];
      if (cover) {
        H.host.querySelectorAll(".pg").forEach(function (p) { p.remove(); });
        heads = layout(H, doc, model, false).heads;
      }
      return { pages: full.pages.length, cover: cover, headPages: heads.map(function (h) { return h.page; }) };
    } finally { H.host.remove(); }
  }
  async function buildPdf(model, h2c, JsPDF, doc) {
    var H = makeHost(doc);
    try {
      var main = layout(H, doc, model, true), ordered;
      if (main.pages.length < COVER_MIN_PAGES) {
        main.pages.forEach(function (pg, i) { footer(doc, pg, "- " + (i + 1) + "/" + main.pages.length + " -"); });
        ordered = main.pages;
      } else {
        main.pages.forEach(function (p) { p.remove(); });
        var body = layout(H, doc, model, false);
        var cv = coverPage(H, doc, model);
        var toc = tocPages(H, doc, model, body.heads);
        toc.forEach(function (pg, i) { footer(doc, pg, "- " + roman(i + 1) + " -"); });
        body.pages.forEach(function (pg, i) { footer(doc, pg, "- " + (i + 1) + "/" + body.pages.length + " -"); });
        ordered = [cv].concat(toc, body.pages);
      }
      try { if (doc.fonts && doc.fonts.ready) await doc.fonts.ready; } catch (e) {}
      var pdf = new JsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
      for (var i = 0; i < ordered.length; i++) {
        var canvas = await h2c(ordered[i], { scale: 2, backgroundColor: "#ffffff", logging: false, useCORS: true,
          onclone: function (cd) { var h = cd.getElementById(H.id); if (h) h.style.opacity = "1"; } });
        if (i > 0) pdf.addPage();
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, 210, 297);
      }
      pdf.setProperties({ title: model.title });
      return pdf.output("blob");
    } finally {
      H.host.remove();
    }
  }

  return { parseInline: parseInline, plain: plain, mdToModel: mdToModel, colInfo: colInfo, headList: headList,
    buildDocx: buildDocx, wrapTocField: wrapTocField, finalizeDocx: finalizeDocx,
    buildPptx: buildPptx, estimate: estimate, buildPdf: buildPdf, setLabels: setLabels,
    setStyle: setStyle, getStyle: getStyle, figureTable: figureTable };
})();
/* ===== 문서 변환 확장: 문서 모델 → Excel(xlsx) / 한글(hwpx) ===== */
(function (DX) {
  "use strict";
  var NUM_CELL = /^[\s(+\-−△▲▼]*\d[\d,]*(\.\d+)?\s*(%p|%|원|억원|조원|백만원|천원|만원|달러|명|건|개|곳|일|개월|년|배|℃|mm|cm|회|세대|주|점|호|위)?\)?\s*$/;
  function numParse(s) {
    var t = String(s == null ? "" : s).trim();
    if (!t || !NUM_CELL.test(t)) return null;
    var neg = /^[\s(]*[\-−△▼]/.test(t) || /^\(.*\)$/.test(t);
    var m = t.replace(/,/g, "").match(/\d+(\.\d+)?/);
    if (!m) return null;
    var u = (t.match(/(%p|%|원|억원|조원|백만원|천원|만원|달러|명|건|개|곳|일|개월|년|배|℃|mm|cm|회|세대|주|점|호|위)\)?\s*$/) || [])[1] || "";
    var v = parseFloat(m[0]);
    return { v: neg ? -v : v, unit: u, dec: (m[1] || "").length - (m[1] ? 1 : 0) };
  }
  function sheetName(raw, used) {
    var s = String(raw || "표").replace(/[\[\]:*?\/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 28) || "표";
    var base = s, n = 2;
    while (used[s]) { s = base.slice(0, 26) + " " + n++; }
    used[s] = 1;
    return s;
  }
  function wch(s) {
    var w = 0; String(s == null ? "" : s).split("").forEach(function (c) { w += c.charCodeAt(0) > 0x2e80 ? 2 : 1; });
    return w;
  }
  // 답변 속 마크다운 표를 시트로. 숫자 열은 숫자 형식(단위가 하나로 같으면 머리글에 단위를 붙인다)
  function buildXlsx(model, XLSX) {
    var wb = XLSX.utils.book_new(), used = {};
    var tables = [];
    model.sections.forEach(function (s) {
      var label = s.heading;
      s.blocks.forEach(function (b) {
        if (b.type === "h3") label = b.text;
        if (b.type === "table") tables.push({ name: label || s.heading || model.title, t: b });
        if (b.type === "figure") { var ft = DX.figureTable(b.spec); if (ft) tables.push({ name: b.title || label || "그림 자료", t: ft }); }
      });
    });
    var info = [["제목", model.title], ["작성", model.subtitle || ""]];
    if (model.question) info.push(["질의", model.question]);
    model.source.forEach(function (x) { info.push(["출처", x]); });
    if (tables.length) info.push(["시트 구성", tables.length + "개 표: " + tables.map(function (x, i) { return (i + 1) + ") " + (x.name || "표"); }).join(" / ")]);
    if (!tables.length) {
      // 표가 없으면 본문을 줄 단위로 한 시트에 담는다
      var rows = [["구분", "내용"]];
      model.sections.forEach(function (s) {
        s.blocks.forEach(function (b) {
          if (b.type === "p" || b.type === "note") rows.push([s.heading || "", DX.plain(b.text)]);
          else if (b.type === "h3") rows.push([s.heading || "", "■ " + b.text]);
          else if (b.type === "bullets") b.items.forEach(function (it) { rows.push([s.heading || "", (it.level ? "  - " : "• ") + DX.plain(it.text)]); });
        });
      });
      var ws0 = XLSX.utils.aoa_to_sheet(rows);
      ws0["!cols"] = [{ wch: 24 }, { wch: 100 }];
      XLSX.utils.book_append_sheet(wb, ws0, sheetName("내용", used));
    }
    tables.forEach(function (x) {
      var t = x.t, heads = t.headers.slice();
      var colNum = heads.map(function (h, i) {
        var cells = t.rows.map(function (r) { return String(r[i] == null ? "" : r[i]).trim(); }).filter(Boolean);
        if (!cells.length) return null;
        var ps = cells.map(numParse);
        if (ps.some(function (p) { return !p; })) return null;
        var units = {}; ps.forEach(function (p) { units[p.unit] = 1; });
        var uk = Object.keys(units);
        if (uk.length > 1) return null;
        var dec = ps.reduce(function (m, p) { return Math.max(m, p.dec); }, 0);
        return { unit: uk[0], dec: Math.min(dec, 4) };
      });
      heads = heads.map(function (h, i) { var c = colNum[i]; return c && c.unit && h.indexOf(c.unit) < 0 ? h + "(" + c.unit + ")" : h; });
      var aoa = [heads].concat(t.rows.map(function (r) {
        return heads.map(function (_, i) {
          var v = r[i] == null ? "" : r[i];
          if (colNum[i]) { var p = numParse(v); return p ? p.v : v; }
          return v;
        });
      }));
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      colNum.forEach(function (c, i) {
        if (!c) return;
        var fmt = c.dec ? "#,##0." + new Array(c.dec + 1).join("0") : "#,##0";
        for (var r = 1; r < aoa.length; r++) {
          var ref = XLSX.utils.encode_cell({ r: r, c: i });
          if (ws[ref] && ws[ref].t === "n") ws[ref].z = fmt;
        }
      });
      ws["!cols"] = heads.map(function (h, i) {
        var m = wch(h);
        aoa.forEach(function (row) { m = Math.max(m, wch(row[i])); });
        return { wch: Math.min(Math.max(m + 2, 6), 60) };
      });
      ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: heads.length - 1 } }) };
      XLSX.utils.book_append_sheet(wb, ws, sheetName(x.name, used));
    });
    var wsi = XLSX.utils.aoa_to_sheet(info);
    wsi["!cols"] = [{ wch: 12 }, { wch: 100 }];
    XLSX.utils.book_append_sheet(wb, wsi, sheetName("정보", used));
    var out = XLSX.write(wb, { bookType: "xlsx", type: "array", compression: true });
    return new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  /* ---------- 한글(HWPX) ---------- */
  // 글자 모양 번호(머리 파일 기준): 0 본문, 7 본문 굵게, 9 절 제목(남색), 10 소제목(파랑), 11 작은 회색, 12 문서 제목, 13 표 머리(흰 글자·파랑 바탕), 3 표 본문, 14 표 본문 굵게
  // 문단 모양 번호: 20 가운데, 21·22 목록 들여쓰기, 23 절 제목, 24 표 왼쪽, 25 표 오른쪽, 26 본문, 27 제목, 28 소제목
  var CP = { body: 0, bold: 7, h2: 9, h3: 10, small: 11, title: 12, th: 13, td: 3, tdb: 14 };
  var TEXT_W = 42520;
  function xesc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  }
  // 머리 파일의 글자 모양(크기·색)과 표 머리 채움색을 서식 설정에 맞춘다
  function styleHeader(xml) {
    var st = DX.getStyle ? DX.getStyle() : null;
    if (!st) return xml;
    var C = st.colors, Z = st.hwpx.size, fix = function (c) { return c === "auto" ? "000000" : c; };
    var MAP = { 0: [Z.body], 7: [Z.body], 9: [Z.h1, C.h1], 10: [Z.h2, C.h2], 11: [Z.small, C.sub], 12: [Z.title, C.title], 13: [Z.th, C.th_fg], 3: [Z.td], 14: [Z.td] };
    xml = xml.replace(/<hh:charPr\b[^>]*>/g, function (tag) {
      var m = tag.match(/ id="(\d+)"/); if (!m || !MAP[m[1]]) return tag;
      var v = MAP[m[1]];
      if (v[0]) tag = tag.replace(/ height="\d+"/, ' height="' + Math.round(v[0]) + '"');
      if (v[1]) tag = tag.replace(/ textColor="#[0-9A-Fa-f]{6}"/, ' textColor="#' + fix(v[1]).toUpperCase() + '"');
      return tag;
    });
    return xml.replace(/(<hh:borderFill id="4"[\s\S]*?faceColor=")#[0-9A-Fa-f]{6}/, "$1#" + fix(C.th_bg).toUpperCase());
  }
  function buildHwpx(model, JSZip, tpl, meta) {
    meta = meta || {};
    var pid = 1, out = [];
    function para(ppr, runs) {
      var r = runs.map(function (x) { return '<hp:run charPrIDRef="' + x.cp + '"><hp:t>' + xesc(x.text) + '</hp:t></hp:run>'; }).join("");
      if (!r) r = '<hp:run charPrIDRef="0"/>';
      return '<hp:p id="' + (pid++) + '" paraPrIDRef="' + ppr + '" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">' + r + '</hp:p>';
    }
    function inline(text, cpN, cpB) {
      return DX.parseInline(text).map(function (r) { return { cp: r.bold ? cpB : cpN, text: r.text }; });
    }
    function table(b) {
      var info = DX.colInfo(b.headers, b.rows);
      var n = b.headers.length;
      var ws = (function () {
        var minEach = 2400;
        if (n * minEach >= TEXT_W) return b.headers.map(function () { return Math.floor(TEXT_W / n); });
        var free = TEXT_W - n * minEach, w = info.map(function (x) { return minEach + Math.floor(free * x.ratio); });
        var diff = TEXT_W - w.reduce(function (a, c) { return a + c; }, 0), big = 0;
        w.forEach(function (v, i) { if (v > w[big]) big = i; });
        w[big] += diff;
        return w;
      })();
      var rows = [b.headers].concat(b.rows);
      var s = '<hp:p id="' + (pid++) + '" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">' +
        '<hp:tbl id="' + (1000000 + pid) + '" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="' + rows.length + '" colCnt="' + n + '" cellSpacing="0" borderFillIDRef="3" noAdjust="0">' +
        '<hp:sz width="' + TEXT_W + '" widthRelTo="ABSOLUTE" height="' + (282 * rows.length) + '" heightRelTo="ABSOLUTE" protect="0"/>' +
        '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
        '<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="510" right="510" top="141" bottom="141"/>';
      rows.forEach(function (row, ri) {
        s += "<hp:tr>";
        for (var ci = 0; ci < n; ci++) {
          var head = ri === 0;
          var al = head ? 20 : (info[ci].align === "right" ? 25 : info[ci].align === "center" ? 20 : 24);
          var txt = String(row[ci] == null ? "" : row[ci]);
          var runs = head ? [{ cp: CP.th, text: DX.plain(txt) }] : inline(txt, CP.td, CP.tdb);
          s += '<hp:tc name="" header="' + (head ? 1 : 0) + '" hasMargin="0" protect="0" editable="0" dirty="1" borderFillIDRef="' + (head ? 4 : 3) + '">' +
            '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">' +
            para(al, runs) + '</hp:subList><hp:cellAddr colAddr="' + ci + '" rowAddr="' + ri + '"/><hp:cellSpan colSpan="1" rowSpan="1"/>' +
            '<hp:cellSz width="' + ws[ci] + '" height="282"/><hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>';
        }
        s += "</hp:tr>";
      });
      s += "</hp:tbl></hp:run></hp:p>";
      return s;
    }
    // 그림(BinData) — python-hwpx가 만드는 한글 그림 개체 구조를 따름(글자처럼 취급, 본문 폭에 맞춤)
    var bins = [];
    function picPara(fig) {
      var n = bins.length + 1, id = "BIN" + ("000" + n).slice(-4);
      bins.push({ id: id, data: fig.data });
      var W = Math.round(TEXT_W * 0.98), H = Math.round(W * (Number(fig.h) || 9) / (Number(fig.w) || 16));
      var pic = '<hp:pic textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" reverse="0" id="' + (500000000 + n) + '" zOrder="' + n + '" numberingType="PICTURE" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="' + (500000000 + n) + '">' +
        '<hp:offset x="0" y="0"/><hp:orgSz width="' + W + '" height="' + H + '"/><hp:curSz width="' + W + '" height="' + H + '"/><hp:flip horizontal="0" vertical="0"/>' +
        '<hp:rotationInfo angle="0" centerX="' + Math.round(W / 2) + '" centerY="' + Math.round(H / 2) + '" rotateimage="1"/>' +
        '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>' +
        '<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="' + W + '" y="0"/><hc:pt2 x="' + W + '" y="' + H + '"/><hc:pt3 x="0" y="' + H + '"/></hp:imgRect>' +
        '<hp:imgClip left="0" right="' + W + '" top="0" bottom="' + H + '"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="' + W + '" dimheight="' + H + '"/>' +
        '<hc:img binaryItemIDRef="' + id + '" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/>' +
        '<hp:sz width="' + W + '" height="' + H + '" widthRelTo="ABSOLUTE" heightRelTo="ABSOLUTE" protect="0"/>' +
        '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="CENTER" vertOffset="0" horzOffset="0"/>' +
        '<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:shapeComment/></hp:pic>';
      return '<hp:p id="' + (pid++) + '" paraPrIDRef="20" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">' + pic + '</hp:run></hp:p>';
    }
    out.push(para(27, [{ cp: CP.title, text: model.title }]));
    if (model.subtitle) out.push(para(20, [{ cp: CP.small, text: model.subtitle }]));
    if (model.question) out.push(para(26, [{ cp: CP.small, text: "질의: " + model.question }]));
    var hn = 0, figN = 0;
    model.sections.forEach(function (sec) {
      if (sec.heading) out.push(para(23, [{ cp: CP.h2, text: (++hn) + ". " + sec.heading }]));
      sec.blocks.forEach(function (b) {
        if (b.type === "h3") out.push(para(28, [{ cp: CP.h3, text: b.text }]));
        else if (b.type === "p" && b.role === "caption") out.push(para(26, [{ cp: CP.bold, text: DX.plain(b.text) }]));
        else if (b.type === "p" && b.role === "src") out.push(para(26, inline(b.text, CP.small, CP.small)));
        else if (b.type === "p") {
          String(b.text).split(/\n+/).forEach(function (line) { if (line.trim()) out.push(para(26, inline(line, CP.body, CP.bold))); });
        } else if (b.type === "note") {
          String(b.text).split(/\n+/).forEach(function (line) { if (line.trim()) out.push(para(21, inline(line, CP.small, CP.small))); });
        } else if (b.type === "bullets") {
          b.items.forEach(function (it) {
            var mark = it.ordered ? it.n + ". " : (it.level ? "▪ " : "- ");
            out.push(para(it.level ? 22 : 21, [{ cp: CP.body, text: mark }].concat(inline(it.text, CP.body, CP.bold))));
          });
        } else if (b.type === "table") {
          out.push(table(b));
          out.push(para(0, []));
        } else if (b.type === "figure") {
          figN++;
          out.push(para(26, [{ cp: CP.bold, text: "[그림 " + figN + "] " + (b.title || "") }]));
          // 그림 PNG가 있으면(페이지가 그린 그림 또는 파일) 한글 그림 개체로 넣는다
          var fig = meta.figures && meta.figures[figN - 1];
          if (fig && fig.data) {
            out.push(picPara(fig));
            out.push(para(26, [{ cp: CP.small, text: (b.source ? "자료: " + b.source : "") }]));
            return;
          }
          // 그림이 없으면 그림의 자료를 표로 넣는다
          var ft = b.spec ? DX.figureTable(b.spec) : null;
          if (ft) { out.push(table(ft)); out.push(para(0, [])); }
          else if (b.kind === "diagram" && typeof Diagram !== "undefined") Diagram.describe(b.spec).forEach(function (line) { out.push(para(21, [{ cp: CP.body, text: "- " + line }])); });
          out.push(para(26, [{ cp: CP.small, text: (b.source ? "자료: " + b.source + " · " : "") + "그림은 Word·PDF·PowerPoint 파일에 들어 있습니다." }]));
        }
      });
    });
    if (model.source.length) {
      out.push(para(26, []));
      model.source.forEach(function (x) { out.push(para(26, [{ cp: CP.small, text: "출처: " + x }])); });
    }
    var sec = tpl.secHead + out.join("") + "</hs:sec>";
    var now = new Date(), iso = now.toISOString().replace(/\.\d+Z$/, "Z");
    var hpf = tpl.hpf.replace("</opf:manifest>", bins.map(function (b) { return '<opf:item id="' + b.id + '" href="BinData/' + b.id + '.png" media-type="image/png" isEmbeded="1"/>'; }).join("") + "</opf:manifest>")
      .replace("{{title}}", xesc(model.title)).replace(/\{\{creator\}\}/g, xesc(meta.creator || "업무 에이전트"))
      .replace(/\{\{iso\}\}/g, iso).replace("{{date}}", xesc(meta.date || iso));
    var prv = [model.title].concat(model.sections.map(function (s) { return s.heading; })).filter(Boolean).join("\r\n").slice(0, 1000);
    var zip = new JSZip(), NF = { createFolders: false };
    zip.file("mimetype", tpl.mimetype, { compression: "STORE", createFolders: false });
    zip.file("version.xml", tpl.version, NF);
    var header = styleHeader(tpl.header);
    if (bins.length) header = header.replace("</hh:refList>", '<hh:binDataList itemCnt="' + bins.length + '">' + bins.map(function (b, i) { return '<hh:binItem id="' + i + '" Type="Embedding" BinData="' + b.id + '.png" Format="png"/>'; }).join("") + "</hh:binDataList></hh:refList>");
    zip.file("Contents/header.xml", header, NF);
    bins.forEach(function (b) { zip.file("BinData/" + b.id + ".png", b.data, { base64: true, createFolders: false }); });
    zip.file("Contents/section0.xml", sec, NF);
    zip.file("Contents/content.hpf", hpf, NF);
    zip.file("settings.xml", tpl.settings, NF);
    zip.file("META-INF/container.xml", tpl.container, NF);
    zip.file("META-INF/manifest.xml", tpl.manifest, NF);
    zip.file("META-INF/container.rdf", tpl.rdf, NF);
    zip.file("Preview/PrvText.txt", prv, NF);
    return zip.generateAsync({ type: meta.nodebuffer ? "nodebuffer" : "blob", mimeType: "application/hwp+zip", compression: "DEFLATE" });
  }
  DX.buildXlsx = buildXlsx;
  DX.buildHwpx = buildHwpx;
})(DocExport);
module.exports = DocExport;
