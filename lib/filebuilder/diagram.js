// 원본: 계정 스킬 sys-file-builder — 업무 에이전트 중계 서버의 lib/filebuilder/는 이 파일의 사본이다(사본을 직접 고치지 않는다).
// 업무 에이전트 페이지의 도식 모듈(Diagram)을 그대로 옮긴 것 — 배치(layout), Word 도형(patchDocxXml), PowerPoint 도형(toPptx), 글 설명(describe).
// 그림(toCanvas)은 브라우저에서만 쓴다. 페이지 쪽을 고치면 여기도 같이 옮긴다.
var Diagram = (function () {
  "use strict";
  var SHAPES = ["rect", "roundRect", "ellipse", "diamond", "hexagon", "can", "parallelogram", "chevron", "homePlate", "flowChartDocument", "cloud", "text"];
  function n(v, d, lo, hi) { v = typeof v === "number" && isFinite(v) ? v : d; return Math.max(lo, Math.min(hi, v)); }
  function str(v, max) { return v == null ? "" : String(v).slice(0, max || 120); }
  function hex(c) { return String(c || "000000").replace(/^#/, "").toUpperCase(); }

  /* ---------- 글자 폭 추정·도형 안 글자 자리 ----------
     글자 폭은 글꼴을 읽지 않고 추정한다(한글 1em, 라틴 대문자 0.65em, 그 밖의 라틴·숫자 0.55em, 빈칸 0.3em).
     도형 안 글자 자리는 Office 도형 정의(presetShapeDefinitions)의 글상자 사각형을 따른다 —
     Word·PowerPoint·LibreOffice가 모두 이 사각형 안에서 줄을 바꾸므로 셋이 같은 기준이 된다. */
  function charW(ch) {
    var c = ch.charCodeAt(0);
    if (ch === " ") return 0.3;
    if (c >= 0x1100) return 1.0;
    if (ch === "\u00B7") return 0.6;
    if (/[A-Z]/.test(ch)) return 0.65;
    return 0.55;
  }
  function textW(t, px, bold) { var w = 0; String(t || "").split("").forEach(function (ch) { w += charW(ch); }); return w * px * (bold ? 1.05 : 1); }
  // 빈칸에서만 줄을 바꿔 maxW 안에 넣은 줄들(빈칸이 없거나 한 낱말이 maxW보다 길면 그 낱말은 한 줄을 넘는다)
  function wordLines(t, px, bold, maxW) {
    var words = String(t || "").split(" ").filter(function (x) { return x !== ""; }), out = [], line = "";
    words.forEach(function (wd) {
      var cand = line ? line + " " + wd : wd;
      if (line && textW(cand, px, bold) > maxW) { out.push(line); line = wd; } else line = cand;
    });
    if (line) out.push(line);
    return out;
  }
  // 실제 줄바꿈 흉내: 빈칸에서 먼저 바꾸고, 그래도 maxW를 넘는 줄은 글자 단위로 앞에서부터 채워 자른다
  // (Word·PowerPoint·LibreOffice가 빈칸 없는 한글 낱말을 자르는 방식)
  function breakLines(t, px, bold, maxW) {
    var out = [];
    wordLines(t, px, bold, maxW).forEach(function (ln) {
      if (textW(ln, px, bold) <= maxW) { out.push(ln); return; }
      var cur = "";
      ln.split("").forEach(function (ch) { if (cur && textW(cur + ch, px, bold) > maxW) { out.push(cur); cur = ch === " " ? "" : ch; } else cur += ch; });
      if (cur) out.push(cur);
    });
    return out;
  }
  // 두 줄로 나눌 때 더 긴 줄의 폭이 가장 작아지는 나눔
  function split2W(t, px, bold) {
    var words = String(t || "").split(" ").filter(function (x) { return x !== ""; });
    if (words.length < 2) return textW(t, px, bold);
    var best = Infinity;
    for (var i = 1; i < words.length; i++) best = Math.min(best, Math.max(textW(words.slice(0, i).join(" "), px, bold), textW(words.slice(i).join(" "), px, bold)));
    return best;
  }
  // 도형 폭 w·높이 h에서 글상자 사각형 폭(여백 빼기 전)
  function textRectW(shape, w, h) {
    var ss = Math.min(w, h);
    switch (shape) {
      case "chevron": return Math.max(0, w - ss);            // il = ss/2, ir = r - ss/2
      case "homePlate": return Math.max(0, w - ss / 4);      // ir = r - ss/4
      case "diamond": return w / 2;
      case "ellipse": case "cloud": return w * 0.707;
      case "hexagon": return Math.max(0, w - ss / 2);
      case "parallelogram": return Math.max(0, w - ss * 0.5);
      case "roundRect": return w - ss * 0.1;
      default: return w;
    }
  }
  function textRectH(shape, w, h) {
    switch (shape) {
      case "diamond": return h / 2;
      case "ellipse": case "cloud": return h * 0.707;
      case "flowChartDocument": return h * 0.8;
      case "can": return h * 0.7;
      default: return h;
    }
  }
  var PADX = 8, PADY = 5, LH = 1.3; // 좌우·위아래 여백(px)과 줄 높이 배수 — Word 글상자 여백(lIns 36000·tIns 18000)과 PPT margin을 덮는 값
  // 상자 하나가 글자를 담는 데 필요한 폭·높이(px, 기준 글자 14px·12px) — maxW를 넘으면 빈칸에서 두 줄로
  function needBox(o, maxW, h) {
    var bold = o.shape !== "text";
    var one = Math.max(textW(o.label, 14, bold), o.sub ? textW(o.sub, 12, false) : 0);
    var geomPad = function (w) { return w - textRectW(o.shape, w, h); };
    var fitW = function (inner) { // 글자 폭 inner를 담는 도형 폭(도형 모양에 따라 반복으로 맞춘다)
      var w = inner + 2 * PADX;
      for (var k = 0; k < 6; k++) w = inner + 2 * PADX + geomPad(w);
      if (o.shape === "diamond") w = (inner + 2 * PADX) * 2;
      if (o.shape === "ellipse" || o.shape === "cloud") w = (inner + 2 * PADX) / 0.707;
      return Math.ceil(w);
    };
    var w1 = fitW(one);
    var lines = (o.label ? 1 : 0) + (o.sub ? 1 : 0), w = w1;
    if (w1 > maxW) {
      var two = Math.max(split2W(o.label, 14, bold), o.sub ? split2W(o.sub, 12, false) : 0);
      w = Math.min(maxW, fitW(two));
      var innerW = textRectW(o.shape, w, h) - 2 * PADX;
      lines = breakLines(o.label, 14, bold, innerW).length + (o.sub ? breakLines(o.sub, 12, false, innerW).length : 0);
    }
    var hNeed = Math.ceil(lines * 14 * LH + 2 * PADY);
    if (o.shape === "diamond") hNeed *= 2;
    else if (o.shape === "ellipse" || o.shape === "cloud") hNeed = Math.ceil(hNeed / 0.707);
    return { w: w, h: hNeed };
  }

  // 옛 형식과 새 형식을 하나의 모양(graph)으로
  function normalize(spec) {
    spec = spec || {};
    var t = String(spec.type || "graph").toLowerCase();
    if (t === "chevron") {
      var steps = (spec.steps || []).slice(0, 10), hasSub = steps.some(function (s) { return s && s.sub; });
      var nodes = [];
      steps.forEach(function (s, i) {
        nodes.push({ id: "s" + i, label: s.label, shape: i ? "chevron" : "homePlate", style: s.highlight ? "primary" : "default", row: 0, col: i });
        if (hasSub) nodes.push({ id: "t" + i, label: s.sub || "", shape: "text", style: "plain", row: 1, col: i, h: 0.55 });
      });
      return { direction: "LR", title: spec.title, source: spec.source, nodes: nodes, edges: [], groups: [],
        node_w: n(spec.node_w, 150, 60, 400), node_h: n(spec.node_h, 62, 30, 200), col_gap: -8, row_gap: 6 };
    }
    var g = { direction: String(spec.direction || (t === "flow" ? "LR" : "TB")).toUpperCase() === "LR" ? "LR" : "TB",
      title: spec.title, source: spec.source,
      nodes: (spec.nodes || []).slice(0, 40), edges: (spec.edges || []).slice(0, 80), groups: (spec.groups || []).slice(0, 12) };
    ["node_w", "node_h", "col_gap", "row_gap"].forEach(function (k) { if (typeof spec[k] === "number") g[k] = spec[k]; });
    return g;
  }

  // 배치: 결과 좌표는 px 단위(배율 1)
  function layout(spec) {
    var g = normalize(spec);
    if (!g.nodes.length) throw new Error("도식에 상자가 없습니다.");
    var LR = g.direction === "LR";
    var NW = n(g.node_w, LR ? 150 : 170, 40, 400), NH = n(g.node_h, 64, 24, 240);
    var CG = n(g.col_gap, LR ? 56 : 40, -40, 300), RG = n(g.row_gap, LR ? 30 : 56, -40, 300);
    var byId = {};
    var nodes = g.nodes.map(function (nd, i) {
      var o = { id: str(nd && nd.id != null ? nd.id : "n" + i, 40), label: str(nd && nd.label, 80), sub: str(nd && nd.sub, 120),
        shape: SHAPES.indexOf(nd && nd.shape) >= 0 ? nd.shape : "roundRect",
        style: str(nd && nd.style, 20) || "default", group: nd && nd.group != null ? str(nd.group, 40) : "",
        wm: n(nd && nd.w, 1, 0.4, 4), hm: n(nd && nd.h, 1, 0.4, 4),
        row: typeof (nd && nd.row) === "number" ? nd.row : null, col: typeof (nd && nd.col) === "number" ? nd.col : null };
      byId[o.id] = o; return o;
    });
    var edges = g.edges.map(function (e) {
      return { from: str(e && e.from, 40), to: str(e && e.to, 40), label: str(e && e.label, 40), dashed: !!(e && e.dashed),
        arrow: ["end", "both", "none"].indexOf(e && e.arrow) >= 0 ? e.arrow : "end" };
    }).filter(function (e) { return byId[e.from] && byId[e.to] && e.from !== e.to; });
    // 글자가 도형 안에 줄바꿈 없이(길면 빈칸에서 두 줄로) 들어가도록 공통 상자 폭·높이를 늘린다 — 줄이지는 않는다.
    // 사용자가 node_w·node_h를 정했어도 글자가 넘치면 늘린다. 다만 가로로 늘어선 상자 수(cols)를 보고
    // 도식 전체 폭이 WMAX px를 넘지 않게 상자 폭에 상한을 둔다 — 넘으면 Word 쪽 폭(약 16cm)에 넣을 때 글자가 7pt 아래로 작아진다
    var WMAX = 880;
    function autoSize(cols) {
      var cap = Math.max(NW, Math.min(400, (WMAX - CG * Math.max(0, cols - 1)) / Math.max(1, cols)));
      nodes.forEach(function (o) {
        if (!o.label && !o.sub) return;
        if (o.shape === "text") { NW = Math.max(NW, Math.min(cap, (textW(o.label, 14, false) + 2 * PADX) / o.wm)); return; }
        var nb = needBox(o, cap * o.wm, NH * o.hm);
        NW = Math.max(NW, Math.min(cap, nb.w / o.wm));
      });
      nodes.forEach(function (o) { // 정해진 폭에서 줄 수를 다시 세어 높이를 맞춘다
        if (o.shape === "text" || (!o.label && !o.sub)) return;
        var w = NW * o.wm, innerW = textRectW(o.shape, w, NH * o.hm) - 2 * PADX;
        var lines = breakLines(o.label, 14, true, innerW).length + (o.sub ? breakLines(o.sub, 12, false, innerW).length : 0);
        var hNeed = lines * 14 * LH + 2 * PADY;
        if (o.shape === "diamond") hNeed *= 2; else if (o.shape === "ellipse" || o.shape === "cloud") hNeed /= 0.707;
        NH = Math.max(NH, Math.min(240, Math.ceil(hNeed / o.hm)));
      });
    }
    var grid = nodes.some(function (o) { return o.row !== null && o.col !== null; });
    if (grid) {
      var mr = 0; nodes.forEach(function (o) { if (o.row !== null) mr = Math.max(mr, o.row); });
      var extra = 0;
      nodes.forEach(function (o) { if (o.row === null || o.col === null) { o.row = mr + 1; o.col = extra++; } });
      var mc = 0; nodes.forEach(function (o) { mc = Math.max(mc, o.col + Math.round(o.wm)); });
      autoSize(mc);
      nodes.forEach(function (o) {
        o.w = NW * o.wm + CG * (o.wm - 1); o.h = NH * o.hm;
        o.x = o.col * (NW + CG); o.y = o.row * (NH + RG);
      });
    } else {
      // 들어오는 화살표 기준 가장 긴 경로로 단(層)을 정한다
      nodes.forEach(function (o) { o.layer = 0; });
      for (var it = 0; it < nodes.length; it++) {
        var moved = false;
        edges.forEach(function (e) { var a = byId[e.from], b = byId[e.to]; if (b.layer < a.layer + 1 && a.layer + 1 < nodes.length) { b.layer = a.layer + 1; moved = true; } });
        if (!moved) break;
      }
      var layers = [];
      nodes.forEach(function (o) { (layers[o.layer] = layers[o.layer] || []).push(o); });
      layers = layers.filter(Boolean);
      // 위(앞) 단의 위치 평균으로 순서를 정해 선이 덜 엇갈리게
      layers.forEach(function (ly, li) {
        if (li > 0) ly.forEach(function (o, k) {
          var ps = edges.filter(function (e) { return e.to === o.id; }).map(function (e) { return byId[e.from]._pos; }).filter(function (v) { return typeof v === "number"; });
          o._key = ps.length ? ps.reduce(function (a, b) { return a + b; }, 0) / ps.length : k + 0.5;
        });
        if (li > 0) ly.sort(function (a, b) { return (a.group < b.group ? -1 : a.group > b.group ? 1 : 0) || a._key - b._key; });
        ly.forEach(function (o, k) { o._pos = k; });
      });
      var maxN = layers.reduce(function (m, ly) { return Math.max(m, ly.length); }, 0);
      autoSize(LR ? layers.length : maxN);
      layers.forEach(function (ly, li) {
        var span = maxN - ly.length;
        ly.forEach(function (o, k) {
          o.w = NW * o.wm; o.h = NH * o.hm;
          var along = (k + span / 2);
          if (LR) { o.x = li * (NW + CG); o.y = along * (NH + RG); }
          else { o.x = along * (NW + CG); o.y = li * (NH + RG); }
        });
      });
    }
    // 묶음(계층·경계) 상자
    var groups = g.groups.map(function (gr) {
      var id = str(gr && gr.id, 40), mem = nodes.filter(function (o) { return o.group === id; });
      if (!mem.length) return null;
      var x0 = Math.min.apply(null, mem.map(function (o) { return o.x; })), y0 = Math.min.apply(null, mem.map(function (o) { return o.y; }));
      var x1 = Math.max.apply(null, mem.map(function (o) { return o.x + o.w; })), y1 = Math.max.apply(null, mem.map(function (o) { return o.y + o.h; }));
      return { id: id, label: str(gr && gr.label, 60), x: x0 - 14, y: y0 - 30, w: x1 - x0 + 28, h: y1 - y0 + 44 };
    }).filter(Boolean);
    // 원점 맞추기
    var all = nodes.map(function (o) { return [o.x, o.y, o.x + o.w, o.y + o.h]; }).concat(groups.map(function (r) { return [r.x, r.y, r.x + r.w, r.y + r.h]; }));
    var minX = Math.min.apply(null, all.map(function (a) { return a[0]; })), minY = Math.min.apply(null, all.map(function (a) { return a[1]; }));
    var maxX = Math.max.apply(null, all.map(function (a) { return a[2]; })), maxY = Math.max.apply(null, all.map(function (a) { return a[3]; }));
    var M = 16, dx = M - minX, dy = M - minY;
    nodes.forEach(function (o) { o.x += dx; o.y += dy; });
    groups.forEach(function (r) { r.x += dx; r.y += dy; });
    // 선: 꺾은선(직교). 첫 구간 가운데에 이름표
    var lines = edges.map(function (e) {
      var a = byId[e.from], b = byId[e.to];
      var acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
      var vert = Math.abs(bcy - acy) >= Math.abs(bcx - acx) * (LR ? 1.6 : 0.6);
      var pts;
      if (vert) {
        var down = bcy > acy, sy = down ? a.y + a.h : a.y, ty = down ? b.y : b.y + b.h, my = (sy + ty) / 2;
        pts = Math.abs(acx - bcx) < 2 ? [[acx, sy], [acx, ty]] : [[acx, sy], [acx, my], [bcx, my], [bcx, ty]];
      } else {
        var right = bcx > acx, sx = right ? a.x + a.w : a.x, tx = right ? b.x : b.x + b.w, mx = (sx + tx) / 2;
        pts = Math.abs(acy - bcy) < 2 ? [[sx, acy], [tx, acy]] : [[sx, acy], [mx, acy], [mx, bcy], [tx, bcy]];
      }
      // 이름표: 한 상자에서 여러 선이 나가면 갈라진 뒤(마지막 구간)에, 아니면 첫 구간에 단다
      var fan = edges.filter(function (x) { return x.from === e.from; }).length > 1;
      var p0 = fan ? pts[pts.length - 2] : pts[0], p1 = fan ? pts[pts.length - 1] : pts[1];
      return { pts: pts, label: e.label, dashed: e.dashed, arrow: e.arrow, lx: (p0[0] + p1[0]) / 2, ly: (p0[1] + p1[1]) / 2 };
    });
    return { W: maxX - minX + 2 * M, H: maxY - minY + 2 * M, nodes: nodes, groups: groups, lines: lines, title: str(g.title, 120), source: str(g.source, 160) };
  }

  function palette(st, style) {
    var C = st.colors;
    var P = {
      primary: { fill: hex(C.title), line: hex(C.title), text: "FFFFFF", sub: "DFE7F5" },
      "default": { fill: "D9E2F3", line: hex(C.h2), text: hex(C.title), sub: "404040" },
      muted: { fill: "F2F2F2", line: "BFBFBF", text: "404040", sub: "595959" },
      accent: { fill: "FFF2CC", line: "BF9000", text: "7F6000", sub: "595959" },
      warning: { fill: "FDECEA", line: "C00000", text: "C00000", sub: "595959" },
      white: { fill: "FFFFFF", line: hex(C.h2), text: hex(C.title), sub: "595959" },
      plain: { fill: null, line: null, text: "404040", sub: "595959" }
    };
    return P[style] || P["default"];
  }

  /* ---------- 그림(캔버스) ---------- */
  function wrapText(ctx, text, maxW, maxLines) {
    // 빈칸에서 먼저 줄을 바꾸고, 한 낱말이 maxW보다 길 때만 글자 단위로 자른다(Word·PowerPoint와 같은 방식)
    var words = String(text || "").split(" "), lines0 = [], cur = "";
    words.forEach(function (wd) { var c = cur ? cur + " " + wd : wd; if (cur && ctx.measureText(c).width > maxW) { lines0.push(cur); cur = wd; } else cur = c; });
    if (cur) lines0.push(cur);
    if (lines0.every(function (l) { return ctx.measureText(l).width <= maxW; })) return lines0.slice(0, maxLines || 4);
    var out = [], line = "";
    String(text || "").split("").forEach(function (ch) {
      if (ch === "\n") { out.push(line); line = ""; return; }
      if (ctx.measureText(line + ch).width > maxW && line) { out.push(line); line = ch.trim() ? ch : ""; } else line += ch;
    });
    if (line) out.push(line);
    return out.slice(0, maxLines || 4);
  }
  function shapePath(x, o) {
    var X = o.x, Y = o.y, w = o.w, h = o.h, r = Math.min(10, h / 4), k;
    x.beginPath();
    switch (o.shape) {
      case "rect": case "text": x.rect(X, Y, w, h); break;
      case "ellipse": case "cloud": x.ellipse(X + w / 2, Y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); break;
      case "diamond": x.moveTo(X + w / 2, Y); x.lineTo(X + w, Y + h / 2); x.lineTo(X + w / 2, Y + h); x.lineTo(X, Y + h / 2); x.closePath(); break;
      case "hexagon": k = Math.min(w / 4, h / 2); x.moveTo(X + k, Y); x.lineTo(X + w - k, Y); x.lineTo(X + w, Y + h / 2); x.lineTo(X + w - k, Y + h); x.lineTo(X + k, Y + h); x.lineTo(X, Y + h / 2); x.closePath(); break;
      case "parallelogram": k = Math.min(w / 5, h / 2); x.moveTo(X + k, Y); x.lineTo(X + w, Y); x.lineTo(X + w - k, Y + h); x.lineTo(X, Y + h); x.closePath(); break;
      case "chevron": k = Math.min(w / 4, h / 2); x.moveTo(X, Y); x.lineTo(X + w - k, Y); x.lineTo(X + w, Y + h / 2); x.lineTo(X + w - k, Y + h); x.lineTo(X, Y + h); x.lineTo(X + k, Y + h / 2); x.closePath(); break;
      case "homePlate": k = Math.min(w / 4, h / 2); x.moveTo(X, Y); x.lineTo(X + w - k, Y); x.lineTo(X + w, Y + h / 2); x.lineTo(X + w - k, Y + h); x.lineTo(X, Y + h); x.closePath(); break;
      case "can": k = Math.min(h / 5, 12); x.moveTo(X, Y + k); x.ellipse(X + w / 2, Y + k, w / 2, k, 0, Math.PI, 0); x.lineTo(X + w, Y + h - k); x.ellipse(X + w / 2, Y + h - k, w / 2, k, 0, 0, Math.PI); x.closePath(); break;
      case "flowChartDocument": x.moveTo(X, Y); x.lineTo(X + w, Y); x.lineTo(X + w, Y + h * 0.85); x.bezierCurveTo(X + w * 0.75, Y + h * 0.7, X + w * 0.25, Y + h * 1.05, X, Y + h * 0.88); x.closePath(); break;
      default: x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r); x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath();
    }
  }
  function toCanvas(lay, st, maxW) {
    var font = st.chart.font, s = Math.min(1.4, (maxW || st.chart.width) / lay.W);
    var W = Math.round(lay.W * s), H = Math.round(lay.H * s);
    var c = document.createElement("canvas"); c.width = W * 2; c.height = H * 2;
    var x = c.getContext("2d"); x.scale(2 * s, 2 * s); x.fillStyle = "#ffffff"; x.fillRect(0, 0, lay.W, lay.H);
    lay.groups.forEach(function (r) {
      x.save(); x.setLineDash([6, 4]); x.strokeStyle = "#9AA7BD"; x.fillStyle = "#F7F9FC"; x.lineWidth = 1.2;
      x.beginPath(); x.rect(r.x, r.y, r.w, r.h); x.fill(); x.stroke(); x.restore();
      x.fillStyle = "#" + hex(st.colors.sub); x.font = "bold 13px " + font; x.textAlign = "left"; x.textBaseline = "top";
      x.fillText(r.label, r.x + 8, r.y + 7);
    });
    x.lineWidth = 1.6;
    lay.lines.forEach(function (ln) {
      x.save(); x.strokeStyle = "#7F8AA0"; x.fillStyle = "#7F8AA0"; if (ln.dashed) x.setLineDash([6, 4]);
      x.beginPath(); ln.pts.forEach(function (p, i) { if (i) x.lineTo(p[0], p[1]); else x.moveTo(p[0], p[1]); }); x.stroke(); x.setLineDash([]);
      var head = function (a, b) { var ang = Math.atan2(b[1] - a[1], b[0] - a[0]); x.beginPath(); x.moveTo(b[0], b[1]); x.lineTo(b[0] - 10 * Math.cos(ang - 0.4), b[1] - 10 * Math.sin(ang - 0.4)); x.lineTo(b[0] - 10 * Math.cos(ang + 0.4), b[1] - 10 * Math.sin(ang + 0.4)); x.closePath(); x.fill(); };
      var P = ln.pts;
      if (ln.arrow !== "none") head(P[P.length - 2], P[P.length - 1]);
      if (ln.arrow === "both") head(P[1], P[0]);
      if (ln.label) {
        x.font = "12px " + font; var tw = x.measureText(ln.label).width;
        x.fillStyle = "#ffffff"; x.fillRect(ln.lx - tw / 2 - 4, ln.ly - 9, tw + 8, 18);
        x.fillStyle = "#262626"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(ln.label, ln.lx, ln.ly);
      }
      x.restore();
    });
    lay.nodes.forEach(function (o) {
      var pc = palette(st, o.shape === "text" ? (o.style === "default" ? "plain" : o.style) : o.style);
      if (o.shape !== "text" && pc.fill) {
        shapePath(x, o); x.fillStyle = "#" + pc.fill; x.fill(); x.strokeStyle = "#" + (pc.line || pc.fill); x.lineWidth = 1; x.stroke();
      }
      var inset = (o.w - textRectW(o.shape, o.w, o.h)) / 2 + PADX - 3;
      var cx = o.x + o.w / 2 + (o.shape === "homePlate" ? -(o.w - textRectW(o.shape, o.w, o.h)) / 2 : 0);
      x.font = (o.shape === "text" ? "" : "bold ") + "14px " + font;
      var lab = wrapText(x, o.label, o.w - inset * 2 - 6, 3);
      x.font = "12px " + font;
      var sub = o.sub ? wrapText(x, o.sub, o.w - inset * 2 - 6, 2) : [];
      var tot = lab.length * 18 + sub.length * 16, y0 = o.y + o.h / 2 - tot / 2;
      x.textAlign = "center"; x.textBaseline = "top"; x.fillStyle = "#" + pc.text; x.font = (o.shape === "text" ? "" : "bold ") + "14px " + font;
      lab.forEach(function (t, i) { x.fillText(t, cx, y0 + i * 18); });
      x.fillStyle = "#" + pc.sub; x.font = "12px " + font;
      sub.forEach(function (t, i) { x.fillText(t, cx, y0 + lab.length * 18 + i * 16); });
    });
    return { dataUrl: c.toDataURL("image/png"), w: W, h: H };
  }

  /* ---------- PowerPoint 실제 도형 ---------- */
  function toPptx(slide, lay, st, box, fontFace) {
    var s = Math.min(box.w / lay.W, box.h / lay.H);
    var ox = box.x + (box.w - lay.W * s) / 2, oy = box.y;
    var X = function (v) { return +(ox + v * s).toFixed(3); }, Y = function (v) { return +(oy + v * s).toFixed(3); }, L = function (v) { return +(v * s).toFixed(3); };
    // 글자 크기는 도형과 같은 비율로 줄이고 늘린다(그림·Word와 같은 글자:도형 비율). 아주 작아질 때만 하한(8·7pt)
    var pt = function (px) { return Math.max(px >= 14 ? 8 : 7, Math.min(18, +(px * s * 72).toFixed(1))); };
    lay.groups.forEach(function (r) {
      slide.addText(r.label, { shape: "rect", x: X(r.x), y: Y(r.y), w: L(r.w), h: L(r.h), fill: { color: "F7F9FC" },
        line: { color: "9AA7BD", width: 1, dashType: "dash" }, fontFace: fontFace, fontSize: pt(13), bold: true, color: hex(st.colors.sub), align: "left", valign: "top", margin: 4 });
    });
    lay.lines.forEach(function (ln) {
      var P = ln.pts;
      for (var i = 1; i < P.length; i++) {
        var a = P[i - 1], b = P[i], last = i === P.length - 1, first = i === 1;
        var o = { x: X(Math.min(a[0], b[0])), y: Y(Math.min(a[1], b[1])), w: L(Math.abs(b[0] - a[0])), h: L(Math.abs(b[1] - a[1])),
          flipH: b[0] < a[0], flipV: b[1] < a[1], line: { color: "7F8AA0", width: 1.25 } };
        if (ln.dashed) o.line.dashType = "dash";
        if (last && ln.arrow !== "none") o.line.endArrowType = "triangle";
        if (first && ln.arrow === "both") o.line.beginArrowType = "triangle";
        slide.addShape("line", o);
      }
      if (ln.label) {
        var tw = Math.max(0.5, ln.label.length * pt(12) / 72 + 0.2);
        slide.addText(ln.label, { x: X(ln.lx) - tw / 2, y: Y(ln.ly) - 0.13, w: tw, h: 0.26, fontFace: fontFace, fontSize: pt(12), color: "262626", align: "center", valign: "middle", fill: { color: "FFFFFF" }, margin: 0 });
      }
    });
    lay.nodes.forEach(function (o) {
      var pc = palette(st, o.shape === "text" ? (o.style === "default" ? "plain" : o.style) : o.style);
      var runs = [{ text: o.label || " ", options: { bold: o.shape !== "text", color: pc.text, fontSize: pt(14), breakLine: !!o.sub } }];
      if (o.sub) runs.push({ text: o.sub, options: { color: pc.sub, fontSize: pt(12) } });
      var opt = { x: X(o.x), y: Y(o.y), w: L(o.w), h: L(o.h), fontFace: fontFace, align: "center", valign: "middle", margin: [1, 3, 1, 3] };
      if (o.shape !== "text") { opt.shape = o.shape === "rect" ? "rect" : o.shape; opt.fill = { color: pc.fill || "FFFFFF" }; opt.line = { color: pc.line || pc.fill || "FFFFFF", width: 0.75 }; }
      slide.addText(runs, opt);
    });
  }

  /* ---------- Word 실제 도형(그룹) XML ---------- */
  function xe(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function docxGroup(lay, st, cxEmu, uid, font) {
    var e = cxEmu / lay.W, cy = Math.round(lay.H * e), cx = Math.round(cxEmu), id = uid;
    var E = function (v) { return Math.round(v * e); };
    var hp = function (px) { return Math.max(14, Math.min(32, Math.round(px * e / 12700 * 2))); }; // 반 포인트
    var rpr = function (color, sz, bold) { return '<w:rPr><w:rFonts w:ascii="' + xe(font) + '" w:eastAsia="' + xe(font) + '" w:hAnsi="' + xe(font) + '" w:cs="' + xe(font) + '"/>' + (bold ? "<w:b/>" : "") + '<w:color w:val="' + color + '"/><w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/></w:rPr>'; };
    var para = function (text, color, sz, bold, align) { return '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="' + (align || "center") + '"/></w:pPr><w:r>' + rpr(color, sz, bold) + '<w:t xml:space="preserve">' + xe(text) + "</w:t></w:r></w:p>"; };
    var shape = function (geom, x, y, w, h, fill, line, dash, txt, anchor, flipH, flipV, ends) {
      id++;
      var ln = line ? '<a:ln w="' + (geom === "line" ? 15875 : 9525) + '"><a:solidFill><a:srgbClr val="' + line + '"/></a:solidFill>' + (dash ? '<a:prstDash val="dash"/>' : "") + (ends || "") + "</a:ln>" : "<a:ln><a:noFill/></a:ln>";
      return '<wps:wsp><wps:cNvPr id="' + id + '" name="도형 ' + id + '"/><wps:cNvSpPr/><wps:spPr><a:xfrm' + (flipH ? ' flipH="1"' : "") + (flipV ? ' flipV="1"' : "") + '><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + Math.max(0, w) + '" cy="' + Math.max(0, h) + '"/></a:xfrm><a:prstGeom prst="' + geom + '"><a:avLst/></a:prstGeom>' +
        (fill ? '<a:solidFill><a:srgbClr val="' + fill + '"/></a:solidFill>' : "<a:noFill/>") + ln + "</wps:spPr>" +
        (txt ? "<wps:txbx><w:txbxContent>" + txt + "</w:txbxContent></wps:txbx>" : "") +
        '<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="36000" tIns="18000" rIns="36000" bIns="18000" anchor="' + (anchor || "ctr") + '" anchorCtr="0"><a:noAutofit/></wps:bodyPr></wps:wsp>';
    };
    var kids = [];
    lay.groups.forEach(function (r) {
      kids.push(shape("rect", E(r.x), E(r.y), E(r.w), E(r.h), "F7F9FC", "9AA7BD", true, para(r.label, hex(st.colors.sub), hp(13), true, "left"), "t"));
    });
    lay.lines.forEach(function (ln) {
      var P = ln.pts;
      for (var i = 1; i < P.length; i++) {
        var a = P[i - 1], b = P[i], last = i === P.length - 1, first = i === 1;
        var ends = (first && ln.arrow === "both" ? '<a:headEnd type="triangle" w="med" len="med"/>' : "") + (last && ln.arrow !== "none" ? '<a:tailEnd type="triangle" w="med" len="med"/>' : "");
        kids.push(shape("line", E(Math.min(a[0], b[0])), E(Math.min(a[1], b[1])), E(Math.abs(b[0] - a[0])), E(Math.abs(b[1] - a[1])), null, "7F8AA0", ln.dashed, "", "ctr", b[0] < a[0], b[1] < a[1], ends));
      }
      if (ln.label) {
        var hz = hp(12), twE = Math.round(ln.label.length * hz / 2 * 12700 * 1.05 + 90000), thE = Math.round(hz / 2 * 12700 * 1.5 + 36000);
        kids.push(shape("rect", E(ln.lx) - Math.round(twE / 2), E(ln.ly) - Math.round(thE / 2), twE, thE, "FFFFFF", null, false, para(ln.label, "262626", hz, false), "ctr"));
      }
    });
    lay.nodes.forEach(function (o) {
      var pc = palette(st, o.shape === "text" ? (o.style === "default" ? "plain" : o.style) : o.style);
      var txt = para(o.label, pc.text, hp(14), o.shape !== "text") + (o.sub ? para(o.sub, pc.sub, hp(12), false) : "");
      if (o.shape === "text") kids.push(shape("rect", E(o.x), E(o.y), E(o.w), E(o.h), null, null, false, txt, "ctr"));
      else kids.push(shape(o.shape, E(o.x), E(o.y), E(o.w), E(o.h), pc.fill, pc.line, false, txt, "ctr"));
    });
    var drawing = '<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="' + uid + '" name="도식 ' + uid + '"/><wp:cNvGraphicFramePr/>' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"><wpg:wgp><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/><a:chOff x="0" y="0"/><a:chExt cx="' + cx + '" cy="' + cy + '"/></a:xfrm></wpg:grpSpPr>' +
      kids.join("") + "</wpg:wgp></a:graphicData></a:graphic></wp:inline></w:drawing>";
    return { xml: drawing, nextId: id + 1, cy: cy };
  }
  // Word 도형으로 넣었을 때 글자가 도형 안에 다 들어가는지(그림과 같은 품질인지) 판정한다.
  // 실제 글자 크기(hp 하한 7pt 포함)·Word 글상자 여백(좌우 36000·위아래 18000 EMU)·도형 글상자 사각형으로 계산하고,
  // 낱말 중간에서 줄이 바뀌거나 줄 수가 높이를 넘으면 실패. 실패한 상자 목록을 돌려준다
  function wordFit(lay, cxEmu) {
    var e = cxEmu / lay.W, bad = [];
    var hpx = function (px) { return Math.max(14, Math.min(32, Math.round(px * e / 12700 * 2))) / 2 * 12700 / e; }; // 실제 글자 크기를 px로
    lay.nodes.forEach(function (o) {
      if (!o.label && !o.sub) return;
      var bold = o.shape !== "text";
      // 렌더러마다 글상자 계산이 조금씩 달라(LibreOffice 실측: 셰브론 글자 자리가 정의보다 좁게 나옴) 폭에 15% 여유를 둔다
      var inner = (textRectW(o.shape, o.w, o.h) - 72000 / e) * 0.85, innerH = textRectH(o.shape, o.w, o.h) - 36000 / e;
      var L = hpx(14), S = hpx(12);
      // Word 도형의 줄바꿈과 그림(글자 14·12px 그대로)의 줄바꿈을 비교한다. Word 쪽 줄이 더 많거나 높이를 넘으면 그림이 낫다
      var ll = breakLines(o.label, L, bold, inner), sl = o.sub ? breakLines(o.sub, S, false, inner) : [];
      var imgW = textRectW(o.shape, o.w, o.h) - 2 * PADX + 6;
      var il = breakLines(o.label, 14, bold, imgW), is = o.sub ? breakLines(o.sub, 12, false, imgW) : [];
      var hNeed = ll.length * L * 1.2 + sl.length * S * 1.2;
      if (ll.length + sl.length > il.length + is.length || hNeed > innerH + 0.5) bad.push(o.label || o.sub);
    });
    return { ok: !bad.length, bad: bad };
  }
  // Word 문서 XML 후처리: 그림으로 넣어 둔 도식(이름 DIAGRAM_k)을 실제 도형 묶음으로 바꾸고, 그림은 대체본으로 남긴다.
  // 도형으로 넣으면 글자가 넘치는 도식(wordFit 실패)은 그림 그대로 둔다 — 그림이 더 나을 때는 그림, 같으면 도형.
  // report 배열을 주면 도식마다 { k, shapes: true|false, bad: [...] }를 넣는다
  function patchDocxXml(xml, layouts, st, font, report, force) {
    var uid = 5000;
    layouts.forEach(function (lay, k) {
      if (!lay) return;
      var re = new RegExp('<w:drawing>(?:(?!</w:drawing>)[\\s\\S])*?name="DIAGRAM_' + k + '"(?:(?!</w:drawing>)[\\s\\S])*</w:drawing>');
      var m = xml.match(re);
      if (!m) return;
      var ext = m[0].match(/<wp:extent cx="(\d+)"/);
      var cxEmu = ext ? +ext[1] : 5734050;
      var fit = wordFit(lay, cxEmu);
      if (report) report.push({ k: k, shapes: fit.ok, bad: fit.bad });
      if (!fit.ok && !force) return;
      var g = docxGroup(lay, st, cxEmu, uid, font); uid = g.nextId + 10;
      xml = xml.replace(m[0], function () { return '<mc:AlternateContent><mc:Choice Requires="wpg">' + g.xml + "</mc:Choice><mc:Fallback>" + m[0] + "</mc:Fallback></mc:AlternateContent>"; });
    });
    return xml;
  }
  // 한글·Excel처럼 도형을 넣지 않는 형식에 쓸 글 설명
  function describe(spec) {
    var lay; try { lay = layout(spec); } catch (e) { return []; }
    var name = {}; lay.nodes.forEach(function (o) { name[o.id] = o.label || o.id; });
    var out = [];
    lay.groups.forEach(function (g) { out.push("[" + g.label + "] " + lay.nodes.filter(function (o) { return o.group === g.id; }).map(function (o) { return o.label; }).join(", ")); });
    var g0 = normalize(spec);
    (g0.edges || []).forEach(function (e) { if (name[e.from] && name[e.to]) out.push(name[e.from] + " → " + name[e.to] + (e.label ? " (" + e.label + ")" : "")); });
    if (!g0.edges.length) lay.nodes.filter(function (o) { return o.shape !== "text"; }).forEach(function (o, i) { out.push((i + 1) + ". " + o.label + (o.sub ? " — " + o.sub : "")); });
    return out;
  }
  return { normalize: normalize, layout: layout, toCanvas: toCanvas, toPptx: toPptx, docxGroup: docxGroup, patchDocxXml: patchDocxXml, wordFit: wordFit, describe: describe };
})();

/* ===== 그림 모듈: 답변 속 ```chart / ```diagram 블록(JSON 설정)을 그림(PNG)으로 그린다 =====
   - chart: ECharts로 그린다(막대·선·면적·누적·가로막대·파이·도넛·산점도·복합, 또는 option에 ECharts 설정 JSON).
   - diagram: 캔버스로 직접 그린다(셰브론 단계도, 흐름도).
   - 설정은 JSON 값만 받는다. 함수·코드는 받지 않고, 바깥 이미지(graphic)는 지운다. */
if (typeof module !== "undefined" && module.exports) module.exports = Diagram;
