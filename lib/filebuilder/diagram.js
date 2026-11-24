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
  // 문구 안 "\n"은 직접 나눈 줄 — 폭은 가장 긴 줄, 줄바꿈은 줄마다 따로 계산한다
  function textW(t, px, bold) {
    var segs = String(t || "").split("\n");
    if (segs.length > 1) return Math.max.apply(null, segs.map(function (g) { return textW(g, px, bold); }));
    var w = 0; String(t || "").split("").forEach(function (ch) { w += charW(ch); }); return w * px * (bold ? 1.05 : 1);
  }
  // 빈칸에서만 줄을 바꿔 maxW 안에 넣은 줄들(빈칸이 없거나 한 낱말이 maxW보다 길면 그 낱말은 한 줄을 넘는다)
  function wordLines(t, px, bold, maxW) {
    // 빈칸에서 줄을 바꾸고, 폭보다 긴 낱말은 가운뎃점(·) 뒤에서도 바꾼다(화살표 도형은 이 결과대로 줄을 직접 나눠 넣는다 — o.lines)
    var toks = [];
    String(t || "").split(" ").filter(function (x) { return x !== ""; }).forEach(function (wd, wi) {
      var parts = textW(wd, px, bold) > maxW ? wd.split(/(?<=·)/) : [wd];
      parts.forEach(function (pt, pi) { toks.push({ t: pt, sp: wi > 0 && pi === 0 }); });
    });
    var out = [], line = "";
    toks.forEach(function (tk) {
      var cand = line ? line + (tk.sp ? " " : "") + tk.t : tk.t;
      if (line && textW(cand, px, bold) > maxW) { out.push(line); line = tk.t; } else line = cand;
    });
    if (line) out.push(line);
    return out;
  }

  // 실제 줄바꿈 흉내: 빈칸에서 먼저 바꾸고, 그래도 maxW를 넘는 줄은 글자 단위로 앞에서부터 채워 자른다
  // (Word·PowerPoint·LibreOffice가 빈칸 없는 한글 낱말을 자르는 방식)
  function breakLines(t, px, bold, maxW) {
    var segs = String(t || "").split("\n");
    if (segs.length > 1) return [].concat.apply([], segs.map(function (g) { return breakLines(g, px, bold, maxW); }));
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
    if (String(t || "").indexOf("\n") >= 0) return textW(t, px, bold);
    var words = String(t || "").split(" ").filter(function (x) { return x !== ""; });
    if (words.length < 2) return textW(t, px, bold);
    var best = Infinity;
    for (var i = 1; i < words.length; i++) best = Math.min(best, Math.max(textW(words.slice(0, i).join(" "), px, bold), textW(words.slice(i).join(" "), px, bold)));
    return best;
  }
  // 화살표(chevron·homePlate) 꺾임 깊이 — 그림(shapePath)과 같게 폭의 1/5과 높이의 1/2 중 작은 값(글자 칸을 넓히려고 1/4에서 줄임).
  // PowerPoint·Word 도형에도 이 깊이를 조정값(adj)으로 넣는다(2026-11-16). 기본값(짧은 변의 절반)이면 정사각형에 가까운
  // 셰브론은 글상자 폭이 거의 0이 되어 한두 글자씩 세로로 줄이 바뀌었다(업무 에이전트 PPT 실측).
  function arrowK(w, h) { return Math.min(w / 5, h / 2); }
  function arrowAdj(w, h) { var ss = Math.min(w, h); return ss > 0 ? Math.round(arrowK(w, h) / ss * 100000) : 50000; }
  // 도형 폭 w·높이 h에서 글상자 사각형 폭(여백 빼기 전)
  function textRectW(shape, w, h) {
    var ss = Math.min(w, h);
    switch (shape) {
      case "chevron": return Math.max(0, w - 2 * arrowK(w, h)); // il = x1, ir = r - x1 (x1 = 꺾임 깊이)
      case "homePlate": return Math.max(0, w - arrowK(w, h) / 2); // ir = r - x1/2
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
  // 그림(캔버스)에서 글자를 넣는 폭 — 그림은 도형 정의의 글상자에 묶이지 않아 셰브론에서 더 넓게 쓴다
  function imgInnerW(o) {
    var inset = o.shape === "chevron" || o.shape === "homePlate" ? arrowK(o.w, o.h) : o.shape === "diamond" ? o.w / 5 : 8;
    return o.w - inset * 2 - 6;
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
        if (hasSub) nodes.push({ id: "t" + i, label: s.sub || "", shape: "text", style: "plain", row: 1, col: i, h: 0.55, small: true }); // 단계 설명은 12px(도형 글 14px보다 작게)
      });
      return { direction: "LR", title: spec.title, source: spec.source, nodes: nodes, edges: [], groups: [],
        // 높이는 기본(62px)을 넘지 않게 — 글자가 더 필요하면 배치가 늘린다. 원고가 높이를 크게 주면 정사각형에 가까운 화살표가 되어 보기 나빴다(2026-11-16 사용자 판단)
        node_w: n(spec.node_w, 150, 60, 400), node_h: Math.min(62, n(spec.node_h, 62, 30, 200)), col_gap: -8, row_gap: 12 };
    }
    var TREE = { tree: 1, org: 1, orgchart: 1, logic: 1, logictree: 1, ownership: 1, structure: 1, mindmap: 1 };
    var g = { direction: String(spec.direction || (t === "flow" || t === "logic" || t === "logictree" || t === "mindmap" ? "LR" : "TB")).toUpperCase() === "LR" ? "LR" : "TB",
      title: spec.title, source: spec.source, tree: !!TREE[t],
      nodes: (spec.nodes || []).slice(0, 60), edges: (spec.edges || []).slice(0, 100), groups: (spec.groups || []).slice(0, 12) };
    // 상자에 parent를 적으면 부모 → 자식 선으로 바꾼다(조직도·로직 트리·지분 구조를 짧게 쓰게). 조직도·로직 트리는 화살촉 없음, 지분 구조는 화살표
    var noHead = t === "org" || t === "orgchart" || t === "tree" || t === "logic" || t === "logictree" || t === "mindmap";
    g.nodes.forEach(function (nd) {
      if (nd && nd.parent != null && nd.id != null) g.edges.push({ from: nd.parent, to: nd.id, label: nd.edge_label || nd.pct || "", arrow: noHead ? "none" : "end" });
    });
    ["node_w", "node_h", "col_gap", "row_gap"].forEach(function (k) { if (typeof spec[k] === "number") g[k] = spec[k]; });
    return g;
  }

  // 배치: 결과 좌표는 px 단위(배율 1)
  function layout(spec) {
    var t0 = typeKey(spec);
    if (BUILD[t0]) return finish(BUILD[t0](spec || {}), spec || {});
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
        row: typeof (nd && nd.row) === "number" ? nd.row : null, col: typeof (nd && nd.col) === "number" ? nd.col : null, fs: nd && nd.small ? 12 : 14 };
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
        if (o.shape === "text") { NW = Math.max(NW, Math.min(cap, (textW(o.label, o.fs, false) + 2 * PADX) / o.wm)); return; }
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
    // 선 이름표가 상자 사이 간격에 들어가게 간격을 넓힌다(12px 글자 + 좌우 여유, 최대 150px) — 간격이 좁으면 이름표가 상자에 가려
    // 보이지 않았다(2026-11-13 사용자 지적: 밸류체인 도식의 '장비·SW 매입', '구축 후 장기 운영'). 가로선 이름표는 열 간격, 세로선 이름표는 행 간격
    function gapFor(es) { var w = 0; es.forEach(function (e) { if (e.label) w = Math.max(w, textW(e.label, 12, false) + 20); }); return Math.min(150, w); }
    if (grid) {
      var mr = 0; nodes.forEach(function (o) { if (o.row !== null) mr = Math.max(mr, o.row); });
      var extra = 0;
      nodes.forEach(function (o) { if (o.row === null || o.col === null) { o.row = mr + 1; o.col = extra++; } });
      CG = Math.max(CG, gapFor(edges.filter(function (e) { return byId[e.from].row === byId[e.to].row; })));
      if (edges.some(function (e) { return e.label && byId[e.from].row !== byId[e.to].row; })) RG = Math.max(RG, 12 * LH + 18);
      var mc = 0; nodes.forEach(function (o) { mc = Math.max(mc, o.col + Math.round(o.wm)); });
      autoSize(mc);
      nodes.forEach(function (o) {
        o.w = NW * o.wm + CG * (o.wm - 1); o.h = NH * o.hm;
        o.x = o.col * (NW + CG); o.y = o.row * (NH + RG);
      });
      // 테두리 없는 글(text) 상자는 줄 수에 맞춰 높이를 늘리고(위 정렬로 그림), 아래 행을 그만큼 내린다 —
      // 단계 설명이 세 줄이면 위 도형으로 넘쳐 붙어 보이던 것(2026-11-13 사용자 지적)
      var rowIds = []; nodes.forEach(function (o) { if (rowIds.indexOf(o.row) < 0) rowIds.push(o.row); });
      rowIds.sort(function (a, b) { return a - b; }).forEach(function (r) {
        var extra = 0;
        nodes.forEach(function (o) {
          if (o.row !== r || o.shape !== "text" || (!o.label && !o.sub)) return;
          var iw = o.w - 2 * PADX, need = breakLines(o.label, o.fs, false, iw).length * o.fs * LH + (o.sub ? breakLines(o.sub, 12, false, iw).length * 12 * LH : 0) + 2 * PADY + 4;
          if (need > o.h) { extra = Math.max(extra, need - o.h); o._need = need; }
        });
        if (!extra) return;
        nodes.forEach(function (o) { if (o.row === r && o._need) o.h = o._need; else if (o.row > r) o.y += extra; });
      });
    } else {
      // 되돌아가는 화살표(반복·재검토)를 먼저 찾는다 — 깊이 우선 탐색에서 아직 끝나지 않은 상자로 가는 선. 이 선은 단(層) 계산과
      // 순서 정하기에서 빼고 옆으로 돌려 그린다(2026-11-24: 되돌아가는 선 하나 때문에 순서도 단계가 뒤엉킴 — '수정 필요?'가 맨 아래로)
      markBack(nodes, edges);
      var fwd = edges.filter(function (e) { return !e.back; });
      var forest = isForest(nodes, fwd);
      if (forest && (g.tree || fwd.length >= 3 && nodes.some(function (o) { return fwd.filter(function (e) { return e.from === o.id; }).length >= 2; }))) {
        if (LR) CG = Math.max(CG, gapFor(fwd)); else if (fwd.some(function (e) { return e.label; })) RG = Math.max(RG, 12 * LH + 18);
        treeLayout(nodes, fwd, byId, LR, function (cols) { autoSize(cols); return { NW: NW, NH: NH }; }, CG, RG);
      } else {
      // 들어오는 화살표 기준 가장 긴 경로로 단(層)을 정한다
      nodes.forEach(function (o) { o.layer = 0; });
      for (var it = 0; it < nodes.length; it++) {
        var moved = false;
        fwd.forEach(function (e) { var a = byId[e.from], b = byId[e.to]; if (b.layer < a.layer + 1 && a.layer + 1 < nodes.length) { b.layer = a.layer + 1; moved = true; } });
        if (!moved) break;
      }
      var layers = [];
      nodes.forEach(function (o) { (layers[o.layer] = layers[o.layer] || []).push(o); });
      layers = layers.filter(Boolean);
      // 위(앞) 단의 위치 평균으로 순서를 정해 선이 덜 엇갈리게
      layers.forEach(function (ly, li) {
        if (li > 0) ly.forEach(function (o, k) {
          var ps = fwd.filter(function (e) { return e.to === o.id; }).map(function (e) { return byId[e.from]._pos; }).filter(function (v) { return typeof v === "number"; });
          o._key = ps.length ? ps.reduce(function (a, b) { return a + b; }, 0) / ps.length : k + 0.5;
        });
        if (li > 0) ly.sort(function (a, b) { return (a.group < b.group ? -1 : a.group > b.group ? 1 : 0) || a._key - b._key; });
        ly.forEach(function (o, k) { o._pos = k; });
      });
      var maxN = layers.reduce(function (m, ly) { return Math.max(m, ly.length); }, 0);
      if (LR) CG = Math.max(CG, gapFor(edges)); else if (edges.some(function (e) { return e.label; })) RG = Math.max(RG, 12 * LH + 18);
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
    var backK = 0, nb = bbox(nodes);
    var lines = edges.map(function (e) {
      var a = byId[e.from], b = byId[e.to];
      if (e.pts || e.back) {
        var P2 = e.pts ? e.pts.map(function (p) { return [p[0] + dx, p[1] + dy]; }) : backRoute(a, b, nb, LR, backK++);
        var q0 = P2[Math.floor((P2.length - 1) / 2)], q1 = P2[Math.floor((P2.length - 1) / 2) + 1] || q0;
        return { pts: P2, label: e.label, dashed: e.dashed, arrow: e.arrow, lx: (q0[0] + q1[0]) / 2, ly: (q0[1] + q1[1]) / 2, _pref: e.pts ? P2.length - 2 : Math.floor((P2.length - 1) / 2) };
      }
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
      return { pts: pts, label: e.label, dashed: e.dashed, arrow: e.arrow, lx: (p0[0] + p1[0]) / 2, ly: (p0[1] + p1[1]) / 2, _pref: fan ? pts.length - 2 : 0 };
    });
    // 이름표 자리: 상자·다른 이름표와 겹치지 않는 선 위 지점을 고른다(선이 상자를 지나가거나 이름표끼리 같은 자리에 모이면
    // 이름표가 상자 글을 가렸다 — 2026-11-13). 먼저 고른 구간의 가운데, 안 되면 구간마다 가운데·1/3·2/3·1/5·4/5 순서
    var taken = [];
    var hit = function (r) {
      return nodes.some(function (o) { return r[0] < o.x + o.w + 2 && r[2] > o.x - 2 && r[1] < o.y + o.h + 2 && r[3] > o.y - 2; }) ||
        taken.some(function (t) { return r[0] < t[2] + 2 && r[2] > t[0] - 2 && r[1] < t[3] + 2 && r[3] > t[1] - 2; });
    };
    lines.forEach(function (ln) {
      if (!ln.label) return;
      var lw = textW(ln.label, 12, false) + 8, lh = 18, P = ln.pts, segs = [];
      for (var i = 0; i < P.length - 1; i++) segs.push(i);
      segs.sort(function (a, b) { return (a === ln._pref ? -1 : 0) - (b === ln._pref ? -1 : 0); });
      var best = null;
      // 선 위 자리가 모두 막히면 가로선은 선 바로 위·아래, 세로선은 선 바로 왼쪽·오른쪽으로 비켜 단다(한 간격에 이름표 둘)
      [[0, 0], [0, -1], [0, 1], [0, -2], [0, 2]].some(function (off) {
        return [0.5, 0.33, 0.67, 0.2, 0.8].some(function (t) {
          return segs.some(function (i) {
            var a = P[i], b = P[i + 1], hz = Math.abs(b[1] - a[1]) < 1;
            var x = a[0] + (b[0] - a[0]) * t + (hz ? 0 : off[1] * (lw / 2 + 3)), y = a[1] + (b[1] - a[1]) * t + (hz ? off[1] * (lh + 3) : 0);
            var r = [x - lw / 2, y - lh / 2, x + lw / 2, y + lh / 2];
            if (hit(r)) return false;
            best = [x, y, r]; return true;
          });
        });
      });
      if (best) { ln.lx = best[0]; ln.ly = best[1]; taken.push(best[2]); }
      else taken.push([ln.lx - lw / 2, ln.ly - lh / 2, ln.lx + lw / 2, ln.ly + lh / 2]);
    });
    // 도형 글자가 글상자에 다 들어가지 않으면(가장 긴 낱말이 폭을 넘거나 줄 수가 높이를 넘음) 그 상자만 글자를 1px씩 줄인다(하한 11px) —
    // PowerPoint·Word가 낱말 안에서 줄을 바꾸거나("인포테인먼/트") 글자가 도형 밖으로 넘치던 것(2026-11-16)
    nodes.forEach(function (o) {
      if (o.shape === "text" || !o.label) return;
      var iw = textRectW(o.shape, o.w, o.h) - 4, th = textRectH(o.shape, o.w, o.h) - 2 * PADY; // 좌우 여백은 실제 글상자 여백(PPT 1pt·Word 0.1cm 안팎). 글자 폭 추정(한글 1em)이 실제보다 넓어 여유가 된다
      var words = [].concat.apply([], String(o.label).split(/\s+/).map(function (wd) { return wd.split(/(?<=·)/); })); // 가운뎃점 뒤는 줄을 바꿀 수 있는 자리
      for (var f = o.fs || 14; f > 11; f--) {
        var longest = words.reduce(function (m, wd) { return Math.max(m, textW(wd, f, true)); }, 0);
        var need = breakLines(o.label, f, true, iw).length * f * LH + (o.sub ? breakLines(o.sub, 12, false, iw).length * 12 * LH : 0);
        if (longest <= iw && need <= th) break;
        o.fs = f - 1;
      }
    });
    // 한 도식 안의 도형 글자 크기는 같게(가장 작게 줄인 상자에 맞춤 — 상자마다 크기가 달라 보이지 않게)
    var minFs = nodes.reduce(function (m, o) { return o.shape === "text" || !o.label ? m : Math.min(m, o.fs || 14); }, 14);
    nodes.forEach(function (o) { if (o.shape !== "text" && o.label && (o.fs || 14) > minFs) o.fs = minFs; });
    // 화살표 도형은 줄을 직접 나눠 넣는다(PowerPoint가 가운뎃점 뒤 폭 없는 빈칸을 줄 바꿀 자리로 쓰지 않아 "시뮬/레이션"처럼 낱말 안에서 끊었다 — 2026-11-16 실측)
    nodes.forEach(function (o) {
      if ((o.shape !== "chevron" && o.shape !== "homePlate") || !o.label) return;
      var iw = textRectW(o.shape, o.w, o.h) - 4;
      o.lines = breakLines(o.label, o.fs || 14, true, iw);
    });
    return finish({ W: maxX - minX + 2 * M, H: maxY - minY + 2 * M, nodes: nodes, groups: groups, lines: lines, title: str(g.title, 120), source: str(g.source, 160) }, spec, true);
  }

  /* ---------- 범용 그리기 형식(2026-11-24) ----------
     배치 결과의 모든 상자에 윤곽 경로(path)와 글자 자리(tr)를 붙인다. 페이지·PPT·Word는 모양 이름을 몰라도 이 경로대로 그린다 —
     새 도식 종류·새 모양을 넣을 때 그리는 쪽(업무 에이전트 페이지)을 고치지 않게 하려는 구조.
     경로 명령: ["M",x,y] ["L",x,y] ["C",x1,y1,x2,y2,x,y] ["Q",x1,y1,x,y] ["Z"] (px, 도식 좌표)
     PPT·Word는 Office 기본 모양(PRESET)이 있으면 그 모양(사용자가 모양을 바꿀 수 있게), 없으면 이 경로로 만든 사용자 정의 도형을 쓴다. */
  var PRESET = { rect: "rect", text: "rect", roundRect: "roundRect", ellipse: "ellipse", circle: "ellipse", diamond: "diamond", hexagon: "hexagon",
    can: "can", parallelogram: "parallelogram", chevron: "chevron", homePlate: "homePlate", flowChartDocument: "flowChartDocument", cloud: "cloud", triangle: "triangle" };
  var KAP = 0.5523;
  function ellPath(cx, cy, rx, ry) {
    return [["M", cx + rx, cy], ["C", cx + rx, cy + ry * KAP, cx + rx * KAP, cy + ry, cx, cy + ry], ["C", cx - rx * KAP, cy + ry, cx - rx, cy + ry * KAP, cx - rx, cy],
      ["C", cx - rx, cy - ry * KAP, cx - rx * KAP, cy - ry, cx, cy - ry], ["C", cx + rx * KAP, cy - ry, cx + rx, cy - ry * KAP, cx + rx, cy], ["Z"]];
  }
  function poly(pts) { return pts.map(function (p, i) { return [i ? "L" : "M", p[0], p[1]]; }).concat([["Z"]]); }
  function geomPath(o) {
    var X = o.x, Y = o.y, w = o.w, h = o.h, k;
    switch (o.shape) {
      case "ellipse": case "circle": case "cloud": return ellPath(X + w / 2, Y + h / 2, w / 2, h / 2);
      case "diamond": return poly([[X + w / 2, Y], [X + w, Y + h / 2], [X + w / 2, Y + h], [X, Y + h / 2]]);
      case "hexagon": k = Math.min(w / 4, h / 2); return poly([[X + k, Y], [X + w - k, Y], [X + w, Y + h / 2], [X + w - k, Y + h], [X + k, Y + h], [X, Y + h / 2]]);
      case "parallelogram": k = Math.min(w / 5, h / 2); return poly([[X + k, Y], [X + w, Y], [X + w - k, Y + h], [X, Y + h]]);
      case "chevron": k = arrowK(w, h); return poly([[X, Y], [X + w - k, Y], [X + w, Y + h / 2], [X + w - k, Y + h], [X, Y + h], [X + k, Y + h / 2]]);
      case "homePlate": k = arrowK(w, h); return poly([[X, Y], [X + w - k, Y], [X + w, Y + h / 2], [X + w - k, Y + h], [X, Y + h]]);
      case "triangle": return poly([[X + w / 2, Y], [X + w, Y + h], [X, Y + h]]);
      case "trapezoid": // o.inset: 윗변 양쪽 들여쓰기, o.insetB: 아랫변 양쪽 들여쓰기(px)
        var a = Math.max(0, o.inset || 0), b = Math.max(0, o.insetB || 0);
        return poly([[X + a, Y], [X + w - a, Y], [X + w - b, Y + h], [X + b, Y + h]]);
      case "can": k = Math.min(h / 5, 12);
        return [["M", X, Y + k], ["C", X, Y + k - 4 * k / 3, X + w, Y + k - 4 * k / 3, X + w, Y + k], ["L", X + w, Y + h - k],
          ["C", X + w, Y + h - k + 4 * k / 3, X, Y + h - k + 4 * k / 3, X, Y + h - k], ["Z"]];
      case "flowChartDocument": return [["M", X, Y], ["L", X + w, Y], ["L", X + w, Y + h * 0.85], ["C", X + w * 0.75, Y + h * 0.7, X + w * 0.25, Y + h * 1.05, X, Y + h * 0.88], ["Z"]];
      case "roundRect": k = Math.min(10, h / 4, w / 4);
        return [["M", X + k, Y], ["L", X + w - k, Y], ["Q", X + w, Y, X + w, Y + k], ["L", X + w, Y + h - k], ["Q", X + w, Y + h, X + w - k, Y + h],
          ["L", X + k, Y + h], ["Q", X, Y + h, X, Y + h - k], ["L", X, Y + k], ["Q", X, Y, X + k, Y], ["Z"]];
      default: return poly([[X, Y], [X + w, Y], [X + w, Y + h], [X, Y + h]]);
    }
  }
  // 글자 자리(도식 좌표의 사각형) — Office 도형 정의의 글상자와 같은 폭(textRectW·textRectH), 사용자 정의 모양은 모양에 맞춰
  function textRect(o) {
    var tw, th;
    if (o.shape === "trapezoid") { tw = o.w - Math.max(o.inset || 0, o.insetB || 0) - Math.min(o.inset || 0, o.insetB || 0) * 0.5; th = o.h; }
    else if (o.shape === "triangle") { tw = o.w * 0.5; th = o.h * 0.5; return { x: o.x + (o.w - tw) / 2, y: o.y + o.h * 0.45, w: tw, h: th }; }
    else if (o.shape === "circle") { tw = o.w * 0.707; th = o.h * 0.707; }
    else { tw = textRectW(o.shape, o.w, o.h); th = textRectH(o.shape, o.w, o.h); }
    return { x: o.x + (o.w - tw) / 2, y: o.y + (o.h - th) / 2, w: tw, h: th };
  }
  function shiftPath(P, dx, dy) {
    return P.map(function (c) { var r = c.slice(); for (var i = 1; i < r.length; i += 2) { r[i] += dx; r[i + 1] += dy; } return r; });
  }
  function shiftAll(lay, dx, dy) {
    lay.nodes.forEach(function (o) { o.x += dx; o.y += dy; if (o.path) o.path = shiftPath(o.path, dx, dy); if (o.tr) { o.tr.x += dx; o.tr.y += dy; } });
    lay.groups.forEach(function (r) { r.x += dx; r.y += dy; if (r.path) r.path = shiftPath(r.path, dx, dy); });
    lay.lines.forEach(function (l) { l.pts = l.pts.map(function (p) { return [p[0] + dx, p[1] + dy]; }); if (l.lx != null) { l.lx += dx; l.ly += dy; } });
  }
  function bbox(nodes) {
    var a = [Infinity, Infinity, -Infinity, -Infinity];
    nodes.forEach(function (o) { a[0] = Math.min(a[0], o.x); a[1] = Math.min(a[1], o.y); a[2] = Math.max(a[2], o.x + o.w); a[3] = Math.max(a[3], o.y + o.h); });
    return a;
  }
  // 글자가 글자 자리에 다 들어가게 글자를 1px씩 줄인다(하한 o.minFs, 기본 11px)
  function fitNode(o) {
    if (!o.label || o.fsFixed) return;
    var tr = o.tr, bold = o.bold != null ? o.bold : o.shape !== "text", iw = tr.w - 6, th = tr.h - 2 * PADY;
    var words = [].concat.apply([], String(o.label).split(/\s+/).map(function (wd) { return wd.split(/(?<=·)/); }));
    var sfs = o.subFs || 12, min = o.minFs || 11;
    for (var f = o.fs || 14; f > min; f--) {
      var longest = words.reduce(function (m, wd) { return Math.max(m, textW(wd, f, bold)); }, 0);
      var need = breakLines(o.label, f, bold, iw).length * f * LH + (o.sub ? breakLines(o.sub, Math.min(sfs, f), false, iw).length * Math.min(sfs, f) * LH : 0);
      if (longest <= iw && need <= th) break;
      o.fs = f - 1;
    }
  }
  function finish(lay, spec, fromGraph) {
    lay.nodes = lay.nodes || []; lay.groups = lay.groups || []; lay.lines = lay.lines || [];
    lay.nodes.forEach(function (o) { o.path = o.path || geomPath(o); o.tr = o.tr || textRect(o); });
    lay.groups.forEach(function (r) { r.kind = r.kind || "box"; r.path = r.path || poly([[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]); });
    if (!fromGraph) lay.nodes.forEach(fitNode);
    // 경계: 상자·묶음·선·선 이름표를 모두 담게 원점을 다시 맞춘다(옆으로 돌린 되돌아가는 선이 잘리지 않게)
    var a = [Infinity, Infinity, -Infinity, -Infinity];
    var add = function (x0, y0, x1, y1) { a[0] = Math.min(a[0], x0); a[1] = Math.min(a[1], y0); a[2] = Math.max(a[2], x1); a[3] = Math.max(a[3], y1); };
    lay.nodes.forEach(function (o) { add(o.x, o.y, o.x + o.w, o.y + o.h); });
    lay.groups.forEach(function (r) { add(r.x, r.y, r.x + r.w, r.y + r.h); });
    lay.lines.forEach(function (l) {
      l.pts.forEach(function (p) { add(p[0] - 6, p[1] - 6, p[0] + 6, p[1] + 6); });
      if (l.label) { var lw = textW(l.label, 12, false) / 2 + 6; add(l.lx - lw, l.ly - 11, l.lx + lw, l.ly + 11); }
    });
    var M = 16;
    shiftAll(lay, M - a[0], M - a[1]);
    lay.W = Math.ceil(a[2] - a[0] + 2 * M); lay.H = Math.ceil(a[3] - a[1] + 2 * M);
    if (lay.title == null) lay.title = str(spec && spec.title, 120);
    if (lay.source == null) lay.source = str(spec && spec.source, 160);
    lay.v = 2;
    return lay;
  }

  /* ---------- 되돌아가는 선·숲(트리) 배치 ---------- */
  function markBack(nodes, edges) {
    var out = {}, st = {}, hasIn = {};
    edges.forEach(function (e) { (out[e.from] = out[e.from] || []).push(e); hasIn[e.to] = 1; });
    var dfs = function (id) {
      st[id] = 1;
      (out[id] || []).forEach(function (e) { if (st[e.to] === 1) e.back = true; else if (!st[e.to]) dfs(e.to); });
      st[id] = 2;
    };
    nodes.forEach(function (o) { if (!hasIn[o.id] && !st[o.id]) dfs(o.id); });
    nodes.forEach(function (o) { if (!st[o.id]) dfs(o.id); });
  }
  function isForest(nodes, fwd) {
    var inc = {};
    for (var i = 0; i < fwd.length; i++) { if (inc[fwd[i].to]) return false; inc[fwd[i].to] = 1; }
    return fwd.length > 0 && fwd.length <= nodes.length - 1;
  }
  // 조직도·로직 트리·지분 구조: 자식 묶음 가운데에 부모, 부모에서 나온 선이 가운데 줄에서 갈라져 자식으로(직각).
  // 위→아래에서 잎이 7개 이상이면 잎만 가진 부모의 자식은 부모 아래에 세로로 쌓는다(조직도 팀 목록 방식) —
  // 한 줄로 늘어서 글자가 아주 작아지던 것(2026-11-24 시험)
  function treeLayout(nodes, edges, byId, LR, sizeFn, CG, RG) {
    var kids = {}, parent = {};
    edges.forEach(function (e) { (kids[e.from] = kids[e.from] || []).push(byId[e.to]); parent[e.to] = e.from; });
    var roots = nodes.filter(function (o) { return !parent[o.id]; });
    var depthOf = {};
    var walk = function (list, d) { list.forEach(function (o) { depthOf[o.id] = d; walk(kids[o.id] || [], d + 1); }); };
    walk(roots, 0);
    var isLeaf = function (o) { return !(kids[o.id] || []).length; };
    var leaves = nodes.filter(isLeaf).length, stack = {};
    if (!LR && leaves >= 7) nodes.forEach(function (o) { var k = kids[o.id] || []; if (parent[o.id] && k.length >= 2 && k.every(isLeaf)) stack[o.id] = true; });
    var cols = 0;
    nodes.forEach(function (o) { if (stack[o.id]) cols += 1; else if (isLeaf(o) && !stack[parent[o.id]]) cols += 1; });
    var maxD = 0; nodes.forEach(function (o) { maxD = Math.max(maxD, depthOf[o.id] || 0); });
    var sz = sizeFn(LR ? maxD + 1 : Math.max(1, cols));
    var NW = sz.NW, NH = sz.NH;
    nodes.forEach(function (o) { o.w = NW * o.wm; o.h = NH * o.hm; });
    var B = function (o) { return LR ? o.h : o.w; };
    var gapB = LR ? Math.max(14, RG * 0.45) : Math.max(18, CG * 0.6), stepD = LR ? NW + CG : NH + RG;
    var SI = 22, SG = 10, memo = {};
    var width = function (o) {
      if (memo[o.id] != null) return memo[o.id];
      var k = kids[o.id] || [], wv;
      if (!k.length) wv = B(o);
      else if (stack[o.id]) wv = Math.max(B(o), SI + Math.max.apply(null, k.map(B)));
      else wv = Math.max(B(o), k.reduce(function (s, c) { return s + width(c); }, 0) + gapB * (k.length - 1));
      return (memo[o.id] = wv);
    };
    var pos = {};
    var place = function (o, left, d) {
      var k = kids[o.id] || [], wv = width(o), b0;
      if (!k.length) b0 = left + (wv - B(o)) / 2;
      else if (stack[o.id]) {
        b0 = left;
        var yy = d * stepD + o.h + SG + 4;
        k.forEach(function (c) { pos[c.id] = { b: left + SI, d: yy }; yy += c.h + SG; });
      } else {
        var cur = left;
        k.forEach(function (c) { place(c, cur, d + 1); cur += width(c) + gapB; });
        var f = pos[k[0].id], l = pos[k[k.length - 1].id];
        b0 = (f.b + B(k[0]) / 2 + l.b + B(k[k.length - 1]) / 2) / 2 - B(o) / 2;
      }
      pos[o.id] = { b: b0, d: d * stepD };
    };
    var cur0 = 0;
    roots.forEach(function (r) { place(r, cur0, 0); cur0 += width(r) + gapB * 2; });
    nodes.forEach(function (o) { var p = pos[o.id] || { b: 0, d: 0 }; if (LR) { o.x = p.d; o.y = p.b; } else { o.x = p.b; o.y = p.d; } });
    edges.forEach(function (e) {
      var a = byId[e.from], c = byId[e.to];
      if (stack[a.id]) { var rx = a.x + 12; e.pts = [[rx, a.y + a.h], [rx, c.y + c.h / 2], [c.x, c.y + c.h / 2]]; return; }
      if (LR) {
        var mx = a.x + a.w + (c.x - a.x - a.w) / 2, ay = a.y + a.h / 2, cy = c.y + c.h / 2;
        e.pts = Math.abs(ay - cy) < 1 ? [[a.x + a.w, ay], [c.x, cy]] : [[a.x + a.w, ay], [mx, ay], [mx, cy], [c.x, cy]];
      } else {
        var my = a.y + a.h + (c.y - a.y - a.h) / 2, ax = a.x + a.w / 2, cx = c.x + c.w / 2;
        e.pts = Math.abs(ax - cx) < 1 ? [[ax, a.y + a.h], [cx, c.y]] : [[ax, a.y + a.h], [ax, my], [cx, my], [cx, c.y]];
      }
    });
  }
  // 되돌아가는 선: 위→아래 흐름이면 도식 바깥 왼쪽·오른쪽(가까운 쪽), 왼쪽→오른쪽 흐름이면 아래로 돌려 그린다(선마다 14px씩 더 바깥)
  function backRoute(a, b, nb, LR, k) {
    var off = 24 + k * 14;
    if (LR) { var yb = nb[3] + off; return [[a.x + a.w / 2, a.y + a.h], [a.x + a.w / 2, yb], [b.x + b.w / 2, yb], [b.x + b.w / 2, b.y + b.h]]; }
    var mid = (nb[0] + nb[2]) / 2, left = (a.x + a.w / 2 + b.x + b.w / 2) / 2 < mid;
    if (left) { var xl = nb[0] - off; return [[a.x, a.y + a.h / 2], [xl, a.y + a.h / 2], [xl, b.y + b.h / 2], [b.x, b.y + b.h / 2]]; }
    var xr = nb[2] + off;
    return [[a.x + a.w, a.y + a.h / 2], [xr, a.y + a.h / 2], [xr, b.y + b.h / 2], [b.x + b.w, b.y + b.h / 2]];
  }
  // 직각 꺾은선(상자 a → b)
  function orthRoute(a, b, LR) {
    var acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
    var vert = Math.abs(bcy - acy) >= Math.abs(bcx - acx) * (LR ? 1.6 : 0.6);
    if (vert) {
      var down = bcy > acy, sy = down ? a.y + a.h : a.y, ty = down ? b.y : b.y + b.h, my = (sy + ty) / 2;
      return Math.abs(acx - bcx) < 2 ? [[acx, sy], [acx, ty]] : [[acx, sy], [acx, my], [bcx, my], [bcx, ty]];
    }
    var right = bcx > acx, sx = right ? a.x + a.w : a.x, tx = right ? b.x : b.x + b.w, mx = (sx + tx) / 2;
    return Math.abs(acy - bcy) < 2 ? [[sx, acy], [tx, acy]] : [[sx, acy], [mx, acy], [mx, bcy], [tx, bcy]];
  }
  // 선 이름표 자리: 상자·다른 이름표와 겹치지 않는 선 위 지점(그래프 배치와 같은 규칙)
  function placeLabels(lines, nodes) {
    var taken = [];
    var hit = function (r) {
      return nodes.some(function (o) { return o.shape !== "text" && r[0] < o.x + o.w + 2 && r[2] > o.x - 2 && r[1] < o.y + o.h + 2 && r[3] > o.y - 2; }) ||
        taken.some(function (t) { return r[0] < t[2] + 2 && r[2] > t[0] - 2 && r[1] < t[3] + 2 && r[3] > t[1] - 2; });
    };
    lines.forEach(function (ln) {
      if (!ln.label) return;
      var lw = textW(ln.label, 12, false) + 8, lh = 18, P = ln.pts, best = null;
      [[0, 0], [0, -1], [0, 1]].some(function (off) {
        return [0.5, 0.33, 0.67, 0.2, 0.8].some(function (t) {
          for (var i = 0; i < P.length - 1; i++) {
            var a = P[i], b = P[i + 1], hz = Math.abs(b[1] - a[1]) < 1;
            var x = a[0] + (b[0] - a[0]) * t + (hz ? 0 : off[1] * (lw / 2 + 3)), y = a[1] + (b[1] - a[1]) * t + (hz ? off[1] * (lh + 3) : 0);
            var r = [x - lw / 2, y - lh / 2, x + lw / 2, y + lh / 2];
            if (!hit(r)) { best = [x, y, r]; return true; }
          }
          return false;
        });
      });
      if (!best) { var m = P[Math.floor((P.length - 1) / 2)], n2 = P[Math.floor((P.length - 1) / 2) + 1] || m; best = [(m[0] + n2[0]) / 2, (m[1] + n2[1]) / 2, null]; }
      ln.lx = best[0]; ln.ly = best[1]; if (best[2]) taken.push(best[2]);
    });
  }

  /* ---------- 도식 종류(그래프·단계 화살표 밖) ----------
     각 함수는 { nodes, groups, lines, title, source }를 px 좌표로 돌려준다. 상자 필드: id·label·sub·shape·style·x·y·w·h·fs,
     선택 필드: fill·line·color·subColor(16진 색, null이면 없음)·alpha(0~1 채움 불투명도)·align(left|center)·valign(top|middle)·inset/insetB(사다리꼴)·fsFixed·noFit·bold.
     묶음 필드: kind(box 점선 묶음|lane 띠|band 층|zone 칸)·label·fill·line·dash. 선 필드: pts·arrow·dashed·label·color·width·smooth(곡선을 점으로 나눈 것). */
  var SERIES = ["2E5395", "2A9478", "D2601A", "7F6000", "5B6B8C", "8E44AD"];
  var STEPS = ["1F3864", "2E5395", "4A6FB5", "7D9BD1", "AFC3E6", "D9E2F3", "EEF3FA"];
  function inkOn(hexc) { var c = hex(hexc), r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16); return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "1F3864" : "FFFFFF"; }
  function itemText(it) { return typeof it === "string" ? { label: it } : (it || {}); }
  function mk(o) {
    var r = { id: str(o.id != null ? o.id : "n" + Math.random().toString(36).slice(2, 8), 40), label: str(o.label, 120), sub: str(o.sub, 200), shape: o.shape || "roundRect",
      style: o.style || "default", x: o.x, y: o.y, w: o.w, h: o.h, fs: o.fs || 14, wm: 1, hm: 1, group: "" };
    ["fill", "line", "color", "subColor", "alpha", "align", "valign", "inset", "insetB", "fsFixed", "noFit", "bold", "minFs", "subFs", "role"].forEach(function (k) { if (o[k] !== undefined) r[k] = o[k]; });
    return r;
  }
  function boxFor(label, sub, maxW, minW, fs) { // 글자에 맞춘 상자 크기
    fs = fs || 14;
    var w = Math.max(minW || 90, Math.min(maxW, Math.max(textW(label, fs, true), sub ? textW(sub, 12, false) : 0) + 2 * PADX + 8));
    var iw = w - 2 * PADX - 4, lines = breakLines(label, fs, true, iw).length + (sub ? breakLines(sub, 12, false, iw).length : 0);
    return { w: Math.ceil(w), h: Math.ceil(Math.max(46, lines * fs * LH + 2 * PADY + 8)) };
  }
  var BUILD = {};
  // 도식 종류 다른 이름(원고가 흔히 쓰는 말) → 실제 종류
  var TYPE_ALIAS = { lane: "swimlane", lanes: "swimlane", swimlanes: "swimlane", crossfunctional: "swimlane", pdca: "cycle", loop: "cycle", circular: "cycle", flywheel: "cycle",
    radial: "hub", spoke: "hub", hubspoke: "hub", ecosystem: "hub", "2x2": "matrix", quadrant: "matrix", positioning: "matrix", bcg: "matrix",
    cells: "grid", table: "grid", concentric: "onion", rings: "onion", architecture: "layers", stack: "layers", tiers: "layers",
    beforeafter: "compare", asis: "compare", versus: "compare", vs: "compare", timeline: "roadmap", phases: "roadmap", hierarchy: "pyramid", triangle: "pyramid", pipeline: "funnel" };
  function typeKey(spec) { var t = String((spec && spec.type) || "graph").toLowerCase().replace(/[\s_\-]/g, ""); return TYPE_ALIAS[t] || t; }

  // 스윔레인(부서·역할별 업무 흐름): lanes = [{id,label}], nodes = [{id,label,sub,lane,shape,step}], edges, direction LR(기본, 가로 띠)|TB(세로 띠)
  BUILD.swimlane = function (spec) {
    var LR = String(spec.direction || "LR").toUpperCase() !== "TB";
    var lanes = (spec.lanes || []).slice(0, 10).map(function (l, i) { l = typeof l === "string" ? { id: l, label: l } : l || {}; return { id: str(l.id != null ? l.id : "l" + i, 40), label: str(l.label != null ? l.label : l.id, 40) }; });
    if (!lanes.length) throw new Error("스윔레인에 lanes가 없습니다.");
    var li = {}; lanes.forEach(function (l, i) { li[l.id] = i; });
    var nodes = (spec.nodes || []).slice(0, 50).map(function (nd, i) {
      var o = mk({ id: nd.id != null ? nd.id : "n" + i, label: nd.label, sub: nd.sub, shape: nd.shape, style: nd.style || (nd.highlight ? "primary" : "default") });
      o.lane = li[nd.lane] != null ? li[nd.lane] : 0; o.step = typeof nd.step === "number" ? nd.step : null; return o;
    });
    var byId = {}; nodes.forEach(function (o) { byId[o.id] = o; });
    var edges = (spec.edges || []).slice(0, 100).map(function (e) { return { from: str(e.from, 40), to: str(e.to, 40), label: str(e.label, 40), dashed: !!e.dashed, arrow: ["end", "both", "none"].indexOf(e.arrow) >= 0 ? e.arrow : "end" }; })
      .filter(function (e) { return byId[e.from] && byId[e.to] && e.from !== e.to; });
    markBack(nodes, edges);
    var fwd = edges.filter(function (e) { return !e.back; });
    nodes.forEach(function (o) { o.rank = 0; });
    for (var it = 0; it < nodes.length; it++) {
      var mv = false;
      fwd.forEach(function (e) { var a = byId[e.from], b = byId[e.to]; if (b.rank < a.rank + 1) { b.rank = a.rank + 1; mv = true; } });
      if (!mv) break;
    }
    nodes.forEach(function (o) { if (o.step != null) o.rank = o.step; });
    var cell = {}; // 같은 칸(레인·단계)에 둘 이상이면 레인 안에서 줄을 나눈다
    nodes.forEach(function (o) { var k = o.lane + ":" + o.rank; o.sub2 = cell[k] = (cell[k] == null ? 0 : cell[k] + 1); });
    var subN = lanes.map(function (l, i) { return 1 + Math.max.apply(null, [0].concat(nodes.filter(function (o) { return o.lane === i; }).map(function (o) { return o.sub2; }))); });
    var maxRank = Math.max.apply(null, [0].concat(nodes.map(function (o) { return o.rank; })));
    var NW = 120, NH = 52;
    nodes.forEach(function (o) { var b = boxFor(o.label, o.sub, LR ? 170 : 160, 110); NW = Math.max(NW, b.w); NH = Math.max(NH, b.h); });
    var lblW = edges.reduce(function (m, e) { return e.label ? Math.max(m, textW(e.label, 12, false) + 20) : m; }, 0);
    var CG = Math.max(LR ? 44 : 34, Math.min(140, LR ? lblW : 0)), RG = Math.max(18, LR ? 0 : (lblW ? 30 : 0));
    var HW = LR ? Math.max(90, Math.min(130, Math.max.apply(null, lanes.map(function (l) { return textW(l.label, 14, true) + 24; })))) : 0, HH = LR ? 0 : 44;
    var groups = [], heads = [], pad = 14;
    if (LR) {
      var y = 0, totalW = HW + pad + (maxRank + 1) * (NW + CG) - CG + pad;
      lanes.forEach(function (l, i) {
        var h = subN[i] * (NH + 16) - 16 + 2 * pad;
        groups.push({ id: l.id, label: "", kind: "lane", x: 0, y: y, w: totalW, h: h, fill: i % 2 ? "FFFFFF" : "F5F7FB", line: "C9D3E3" });
        heads.push(mk({ id: "_lane_" + i, label: l.label, shape: "rect", x: 0, y: y, w: HW, h: h, fill: "D9E2F3", line: "C9D3E3", color: "1F3864", fsFixed: true, noFit: true }));
        nodes.filter(function (o) { return o.lane === i; }).forEach(function (o) {
          var rows = nodes.filter(function (q) { return q.lane === i && q.rank === o.rank; }).length;
          o.w = NW; o.h = NH; o.x = HW + pad + o.rank * (NW + CG);
          o.y = y + pad + (subN[i] - rows) * (NH + 16) / 2 + o.sub2 * (NH + 16);
        });
        y += h;
      });
    } else {
      var x = 0, totalH = HH + pad + (maxRank + 1) * (NH + 40) - 40 + pad;
      lanes.forEach(function (l, i) {
        var w = subN[i] * (NW + 16) - 16 + 2 * pad;
        groups.push({ id: l.id, label: "", kind: "lane", x: x, y: 0, w: w, h: totalH, fill: i % 2 ? "FFFFFF" : "F5F7FB", line: "C9D3E3" });
        heads.push(mk({ id: "_lane_" + i, label: l.label, shape: "rect", x: x, y: 0, w: w, h: HH, fill: "D9E2F3", line: "C9D3E3", color: "1F3864", fsFixed: true, noFit: true }));
        nodes.filter(function (o) { return o.lane === i; }).forEach(function (o) {
          var cols = nodes.filter(function (q) { return q.lane === i && q.rank === o.rank; }).length;
          o.w = NW; o.h = NH; o.y = HH + pad + o.rank * (NH + 40);
          o.x = x + pad + (subN[i] - cols) * (NW + 16) / 2 + o.sub2 * (NW + 16);
        });
        x += w;
      });
    }
    var nb = bbox(nodes), bk = 0;
    var lines = edges.map(function (e) {
      var a = byId[e.from], b = byId[e.to];
      var pts = e.back ? backRoute(a, b, nb, LR, bk++) : orthRoute(a, b, LR);
      return { pts: pts, label: e.label, dashed: e.dashed, arrow: e.arrow };
    });
    placeLabels(lines, nodes);
    return { nodes: heads.concat(nodes), groups: groups, lines: lines };
  };

  // 순환(PDCA·선순환): steps = [{label,sub,highlight}], center(가운데 글), node_shape(roundRect|ellipse)
  BUILD.cycle = function (spec) {
    var steps = (spec.steps || spec.items || []).slice(0, 10).map(itemText), n = steps.length;
    if (n < 2) throw new Error("순환 도식은 단계가 둘 이상이어야 합니다.");
    var sz = { w: 120, h: 52 };
    steps.forEach(function (s) { var b = boxFor(s.label, s.sub, 170, 110); sz.w = Math.max(sz.w, b.w); sz.h = Math.max(sz.h, b.h); });
    var R = Math.max(150, (sz.w + 40) * n / (2 * Math.PI) + 30), shape = spec.node_shape === "ellipse" ? "ellipse" : "roundRect";
    if (shape === "ellipse") { sz.w = Math.ceil(sz.w / 0.8); sz.h = Math.ceil(sz.h / 0.75); }
    var nodes = steps.map(function (s, i) {
      var ang = -Math.PI / 2 + 2 * Math.PI * i / n;
      return mk({ id: "c" + i, label: s.label, sub: s.sub, shape: shape, style: s.highlight ? "primary" : "default", x: R * Math.cos(ang) - sz.w / 2, y: R * Math.sin(ang) - sz.h / 2, w: sz.w, h: sz.h });
    });
    var lines = [];
    var gapA = function (o) { return Math.min(Math.PI / n * 0.9, (Math.hypot(o.w, o.h) / 2 + 10) / R); };
    for (var i = 0; i < n; i++) {
      var a0 = -Math.PI / 2 + 2 * Math.PI * i / n + gapA(nodes[i]), a1 = -Math.PI / 2 + 2 * Math.PI * (i + 1) / n - gapA(nodes[(i + 1) % n]);
      if (a1 <= a0) continue;
      var pts = []; for (var k = 0; k <= 16; k++) { var t = a0 + (a1 - a0) * k / 16; pts.push([R * Math.cos(t), R * Math.sin(t)]); }
      lines.push({ pts: pts, arrow: "end", smooth: true, color: "7F8AA0", width: 2 });
    }
    if (spec.center) {
      var c = itemText(spec.center), cb = boxFor(c.label, c.sub, Math.min(220, R * 1.1), 100);
      nodes.push(mk({ id: "center", label: c.label, sub: c.sub, shape: "ellipse", style: "white", x: -cb.w * 0.65, y: -cb.h * 0.65, w: cb.w * 1.3, h: cb.h * 1.3, line: "AFC3E6" }));
    }
    return { nodes: nodes, groups: [], lines: lines };
  };

  // 허브(방사형): center, items = [{label,sub,highlight}], arrow = out(기본)|in|both|none
  BUILD.hub = function (spec) {
    var items = (spec.items || []).slice(0, 12).map(itemText), n = items.length;
    if (!n) throw new Error("허브 도식에 items가 없습니다.");
    var c = itemText(spec.center || "핵심"), cb = boxFor(c.label, c.sub, 200, 120);
    var sz = { w: 110, h: 48 };
    items.forEach(function (s) { var b = boxFor(s.label, s.sub, 170, 100); sz.w = Math.max(sz.w, b.w); sz.h = Math.max(sz.h, b.h); });
    var R = Math.max(cb.w / 2 + sz.w / 2 + 70, (sz.w + 30) * n / (2 * Math.PI) + 20);
    var cw = cb.w * 1.3, ch = cb.h * 1.35;
    var nodes = [mk({ id: "hub", label: c.label, sub: c.sub, shape: "ellipse", style: "primary", x: -cw / 2, y: -ch / 2, w: cw, h: ch })];
    var lines = [], dir = spec.arrow || "out";
    items.forEach(function (s, i) {
      var ang = -Math.PI / 2 + 2 * Math.PI * i / n, ex = Math.cos(ang), ey = Math.sin(ang);
      var o = mk({ id: "h" + i, label: s.label, sub: s.sub, shape: "roundRect", style: s.highlight ? "accent" : "default", x: R * ex * 1.15 - sz.w / 2, y: R * ey - sz.h / 2, w: sz.w, h: sz.h });
      nodes.push(o);
      var p0 = [cw / 2 * ex, ch / 2 * ey]; // 가운데 타원 가장자리
      var tx = Math.abs(ex) < 1e-6 ? Infinity : (sz.w / 2) / Math.abs(ex), ty = Math.abs(ey) < 1e-6 ? Infinity : (sz.h / 2) / Math.abs(ey), tt = Math.min(tx, ty);
      var cx = o.x + sz.w / 2, cy = o.y + sz.h / 2, p1 = [cx - ex * tt, cy - ey * tt];
      var pts = dir === "in" ? [p1, p0] : [p0, p1];
      lines.push({ pts: pts, arrow: dir === "none" ? "none" : dir === "both" ? "both" : "end", label: str(s.edge, 30) });
    });
    placeLabels(lines, nodes);
    return { nodes: nodes, groups: [], lines: lines };
  };

  // 2×2 매트릭스(포지셔닝): x = {label, low, high}, y = {label, low, high}, quadrants = [왼위, 오른위, 왼아래, 오른아래]({label,sub,highlight}),
  // items = [{label, x: 0~1, y: 0~1, highlight}]
  BUILD.matrix = function (spec) {
    var S = 480, L = 70, T = 30, xa = spec.x || {}, ya = spec.y || {}, q = (spec.quadrants || []).map(itemText);
    var nodes = [], lines = [];
    var cellF = ["EEF3FA", "E6F2EE", "F7F7F7", "FDF0E7"];
    [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(function (p, i) {
      var qi = q[i] || {};
      nodes.push(mk({ id: "q" + i, label: qi.label || "", sub: qi.sub, shape: "rect", x: L + p[0] * S / 2, y: T + p[1] * S / 2, w: S / 2, h: S / 2,
        fill: qi.highlight ? "FFF2CC" : cellF[i], line: "FFFFFF", color: "1F3864", align: "left", valign: "top", fs: 15, fsFixed: true, noFit: true }));
    });
    lines.push({ pts: [[L, T + S], [L + S + 14, T + S]], arrow: "end", color: "595959", width: 1.5 });
    lines.push({ pts: [[L, T + S], [L, T - 14]], arrow: "end", color: "595959", width: 1.5 });
    var txt = function (id, label, x, y, w, align, bold) { if (label) nodes.push(mk({ id: id, label: label, shape: "text", style: "plain", x: x, y: y, w: w, h: 22, align: align, fs: 13, fsFixed: true, noFit: true, bold: !!bold, color: bold ? "1F3864" : "595959" })); };
    txt("xl", xa.label, L + S / 2 - 160, T + S + 22, 320, "center", true);
    txt("xlo", xa.low, L, T + S + 4, 140, "left");
    txt("xhi", xa.high, L + S - 140, T + S + 4, 140, "right");
    txt("yl", ya.label, L - 60, T - 34, 260, "left", true);
    txt("ylo", ya.low, L - 66, T + S - 22, 62, "right");
    txt("yhi", ya.high, L - 66, T, 62, "right");
    (spec.items || []).slice(0, 30).forEach(function (it, i) {
      it = itemText(it);
      var cx = L + Math.max(0, Math.min(1, +it.x || 0)) * S, cy = T + (1 - Math.max(0, Math.min(1, +it.y || 0))) * S, d = Math.max(10, Math.min(40, +it.size || 14));
      nodes.push(mk({ id: "p" + i, label: "", shape: "ellipse", x: cx - d / 2, y: cy - d / 2, w: d, h: d, fill: it.highlight ? "D2601A" : "2E5395", line: "FFFFFF", noFit: true }));
      nodes.push(mk({ id: "pl" + i, label: it.label, shape: "text", x: cx + d / 2 + 4 - PADX, y: cy - 11, w: Math.min(200, textW(it.label, 13, true) + 2 * PADX + 10), h: 22, align: "left", fs: 13, fsFixed: true, noFit: true, bold: true, color: it.highlight ? "D2601A" : "1F3864" }));
    });
    return { nodes: nodes, groups: [], lines: lines };
  };

  // 칸 나누기(SWOT·비교 칸): cells = [{title, items[], style, highlight}], cols(기본 2). type "swot"는 s·w·o·t 배열로
  BUILD.grid = function (spec) {
    var cells = (spec.cells || []).slice(0, 12), cols = Math.max(1, Math.min(4, spec.cols || 2));
    if (!cells.length) throw new Error("칸 도식에 cells가 없습니다.");
    var CW = cols >= 3 ? 260 : 360, HH = 40, gap = 12, nodes = [];
    var bodyH = cells.map(function (c) {
      var its = (c.items || []).map(function (x) { return "• " + (typeof x === "string" ? x : (x && x.label) || ""); });
      return Math.max(64, its.reduce(function (s, t) { return s + breakLines(t, 14, false, CW - 24).length * 14 * 1.45; }, 0) + 22);
    });
    var rows = Math.ceil(cells.length / cols), rowH = [];
    for (var r = 0; r < rows; r++) rowH.push(Math.max.apply(null, bodyH.slice(r * cols, r * cols + cols)));
    var y = 0;
    for (var r2 = 0; r2 < rows; r2++) {
      for (var c2 = 0; c2 < cols; c2++) {
        var i = r2 * cols + c2, cl = cells[i]; if (!cl) continue;
        var x = c2 * (CW + gap), head = cl.color ? hex(cl.color) : (cl.highlight ? "D2601A" : SERIES[i % SERIES.length]);
        nodes.push(mk({ id: "gh" + i, label: cl.title || "", shape: "rect", x: x, y: y, w: CW, h: HH, fill: head, line: head, color: inkOn(head), fs: 15, fsFixed: true, noFit: true }));
        var its = (cl.items || []).map(function (q) { return "• " + (typeof q === "string" ? q : (q && q.label) || ""); }).join("\n");
        nodes.push(mk({ id: "gb" + i, label: its, shape: "rect", x: x, y: y + HH, w: CW, h: rowH[r2], fill: "FFFFFF", line: head, color: "262626", align: "left", valign: "top", bold: false, fs: 14, fsFixed: true, noFit: true }));
      }
      y += HH + rowH[r2] + gap;
    }
    return { nodes: nodes, groups: [], lines: [] };
  };
  BUILD.swot = function (spec) {
    var m = [["s", "강점 (S)", "2E5395"], ["w", "약점 (W)", "D2601A"], ["o", "기회 (O)", "2A9478"], ["t", "위협 (T)", "7F6000"]];
    return BUILD.grid({ cols: 2, cells: m.map(function (k) { return { title: (spec.titles && spec.titles[k[0]]) || k[1], items: spec[k[0]] || [], color: k[2] }; }) });
  };

  // 피라미드(계층)·깔때기: levels = [{label,sub,note,highlight}] 위→아래. funnel은 위가 넓다. note는 오른쪽 설명
  BUILD.pyramid = function (spec, inv) {
    var lv = (spec.levels || spec.items || []).slice(0, 8).map(itemText), n = lv.length;
    if (!n) throw new Error("피라미드 도식에 levels가 없습니다.");
    var Wb = 520, H = 58, gap = 5, nodes = [], lines = [];
    var hasNote = lv.some(function (l) { return l.note; });
    lv.forEach(function (l, i) {
      var t = inv ? 1 - i / n : (i === 0 ? 0.12 : i / n), b = inv ? Math.max(0.24, 1 - (i + 1) / n) : (i + 1) / n;
      var top = Wb * t, bot = Wb * b, w = Math.max(top, bot), y = i * (H + gap);
      var fill = l.highlight ? "D2601A" : (l.color ? hex(l.color) : STEPS[Math.min(STEPS.length - 1, Math.round(i * (STEPS.length - 2) / Math.max(1, n - 1)))]);
      var o = mk({ id: "lv" + i, label: inv && l.value != null ? l.label + "  " + l.value : l.label, sub: l.sub, shape: "trapezoid", x: (Wb - w) / 2, y: y, w: w, h: H,
        inset: (w - top) / 2, insetB: (w - bot) / 2, fill: fill, line: "FFFFFF", color: inkOn(fill), subColor: inkOn(fill) === "FFFFFF" ? "DFE7F5" : "404040" });
      nodes.push(o);
      if (l.note) {
        var nx = Wb + 40;
        nodes.push(mk({ id: "nt" + i, label: l.note, shape: "text", x: nx, y: y, w: 300, h: H, align: "left", valign: "middle", fs: 13, fsFixed: true, bold: false, color: "404040", noFit: true }));
        lines.push({ pts: [[Wb / 2 + (top + bot) / 4 + 8, y + H / 2], [nx - 6, y + H / 2]], arrow: "none", dashed: true, color: "AFC3E6", width: 1 });
      }
    });
    if (!hasNote) lines = [];
    return { nodes: nodes, groups: [], lines: lines };
  };
  BUILD.funnel = function (spec) { return BUILD.pyramid(spec, true); };

  // 벤(교집합): sets = [{label,sub}] 2~3개, overlap(가운데 겹친 곳 글), pairs = {"AB": "…"} (3개일 때 둘씩 겹친 곳)
  BUILD.venn = function (spec) {
    var sets = (spec.sets || []).slice(0, 3).map(itemText), n = sets.length;
    if (n < 2) throw new Error("벤 도식은 집합이 둘 이상이어야 합니다.");
    var R = 150, d = n === 2 ? 95 : 112, cs = n === 2 ? [[-d, 0], [d, 0]] : [[0, -d * 0.95], [-d, d * 0.62], [d, d * 0.62]];
    var nodes = [], lp = n === 2 ? [[-d - R * 0.5, 0], [d + R * 0.5, 0]] : [[0, -d * 0.95 - R * 0.55], [-d - R * 0.48, d * 0.62 + R * 0.38], [d + R * 0.48, d * 0.62 + R * 0.38]];
    sets.forEach(function (s, i) {
      var col = s.color ? hex(s.color) : SERIES[i];
      nodes.push(mk({ id: "v" + i, label: "", shape: "ellipse", x: cs[i][0] - R, y: cs[i][1] - R, w: 2 * R, h: 2 * R, fill: col, alpha: 0.28, line: col, noFit: true }));
    });
    sets.forEach(function (s, i) {
      var col = s.color ? hex(s.color) : SERIES[i], w = 120;
      nodes.push(mk({ id: "vl" + i, label: s.label, sub: s.sub, shape: "text", x: lp[i][0] - w / 2, y: lp[i][1] - 26, w: w, h: 52, align: "center", valign: "middle", fs: 15, bold: true, color: col }));
    });
    var ov = spec.overlap || spec.center;
    if (ov) { var ot = itemText(ov); nodes.push(mk({ id: "vo", label: ot.label, sub: ot.sub, shape: "text", valign: "middle", x: -55, y: (n === 2 ? 0 : (cs[0][1] + cs[1][1] + cs[2][1]) / 3) - 24, w: 110, h: 48, fs: 13, bold: true, color: "1F3864" })); }
    if (n === 3 && spec.pairs) {
      // 둘만 겹친 곳: 세 원 중심의 무게중심에서 나머지 한 원의 반대쪽으로
      var gx = (cs[0][0] + cs[1][0] + cs[2][0]) / 3, gy = (cs[0][1] + cs[1][1] + cs[2][1]) / 3;
      [["AB", 2], ["AC", 1], ["BC", 0]].forEach(function (pp) {
        var t = spec.pairs[pp[0]]; if (!t) return;
        var vx = gx - cs[pp[1]][0], vy = gy - cs[pp[1]][1], vl = Math.hypot(vx, vy) || 1, m = [gx + vx / vl * d * 0.95, gy + vy / vl * d * 0.95];
        nodes.push(mk({ id: "vp" + pp[0], label: str(t, 40), shape: "text", x: m[0] - 50, y: m[1] - 18, w: 100, h: 36, fs: 12, bold: false, color: "262626" }));
      });
    }
    return { nodes: nodes, groups: [], lines: [] };
  };

  // 동심원(핵심 → 바깥): rings = [{label,sub}] 안 → 밖
  BUILD.onion = function (spec) {
    var rg = (spec.rings || spec.levels || []).slice(0, 6).map(itemText), n = rg.length;
    if (!n) throw new Error("동심원 도식에 rings가 없습니다.");
    var nodes = [], R0 = 70, step = 52;
    for (var i = n - 1; i >= 0; i--) {
      var R = R0 + i * step, fill = STEPS[Math.min(STEPS.length - 1, i + 1)], s = rg[i];
      nodes.push(mk({ id: "r" + i, label: "", shape: "ellipse", x: -R, y: -R, w: 2 * R, h: 2 * R, fill: i === 0 ? "1F3864" : fill, line: "FFFFFF", noFit: true }));
    }
    rg.forEach(function (s, i) {
      var R = R0 + i * step, ink = i === 0 ? "FFFFFF" : inkOn(STEPS[Math.min(STEPS.length - 1, i + 1)]);
      var y = i === 0 ? -22 : -R + 6, h = i === 0 ? 44 : step - 10;
      nodes.push(mk({ id: "rl" + i, label: s.label, sub: i === 0 ? s.sub : "", shape: "text", x: -Math.min(R, 120), y: y, w: 2 * Math.min(R, 120), h: h, fs: 14, bold: true, color: ink, subColor: ink === "FFFFFF" ? "DFE7F5" : "404040", valign: "middle" }));
    });
    return { nodes: nodes, groups: [], lines: [] };
  };

  // 층 구조(시스템 아키텍처·가치 사슬 층): layers = [{label, items[], highlight}] 위 → 아래
  BUILD.layers = function (spec) {
    var ls = (spec.layers || []).slice(0, 8);
    if (!ls.length) throw new Error("층 도식에 layers가 없습니다.");
    var Wt = 860, HW = 130, pad = 10, gap = 8, nodes = [], groups = [], y = 0;
    ls.forEach(function (L, i) {
      var its = (L.items || []).slice(0, 12).map(itemText), per = Math.min(6, Math.max(1, its.length)), rows = Math.max(1, Math.ceil(its.length / per));
      var iw = (Wt - HW - 2 * pad - (per - 1) * gap - pad) / per, ih = 46;
      its.forEach(function (it) { var b = boxFor(it.label, it.sub, iw, iw); ih = Math.max(ih, b.h); });
      var h = rows * (ih + gap) - gap + 2 * pad;
      groups.push({ id: "ly" + i, label: "", kind: "band", x: 0, y: y, w: Wt, h: h, fill: i % 2 ? "F5F7FB" : "EEF3FA", line: "D0D9E8" });
      nodes.push(mk({ id: "lh" + i, label: L.label || "", sub: L.sub, shape: "rect", x: 0, y: y, w: HW, h: h, fill: L.highlight ? "D2601A" : "2E5395", line: L.highlight ? "D2601A" : "2E5395", color: "FFFFFF" }));
      its.forEach(function (it, k) {
        var r = Math.floor(k / per), c = k % per;
        nodes.push(mk({ id: "li" + i + "_" + k, label: it.label, sub: it.sub, shape: "roundRect", style: it.highlight ? "accent" : "white", x: HW + pad + c * (iw + gap), y: y + pad + r * (ih + gap), w: iw, h: ih }));
      });
      y += h + 6;
    });
    return { nodes: nodes, groups: groups, lines: [] };
  };

  // 비교(현재 → 목표, A안 vs B안): columns = [{title, items[], highlight}], arrow = true(칸 사이 화살표)
  BUILD.compare = function (spec) {
    var cs = (spec.columns || []).slice(0, 4);
    if (cs.length < 2) throw new Error("비교 도식은 칸이 둘 이상이어야 합니다.");
    var arrow = spec.arrow !== false, n = cs.length, AW = arrow ? 46 : 18, CW = Math.floor((860 - (n - 1) * AW) / n), HH = 44, nodes = [], lines = [];
    var bodies = cs.map(function (c) { return (c.items || []).map(function (q) { return "• " + (typeof q === "string" ? q : (q && q.label) || ""); }).join("\n"); });
    var BH = Math.max(72, Math.max.apply(null, bodies.map(function (t) { return t.split("\n").reduce(function (s, ln) { return s + breakLines(ln, 14, false, CW - 24).length * 14 * 1.45; }, 0) + 24; })));
    cs.forEach(function (c, i) {
      var x = i * (CW + AW), head = c.highlight ? "D2601A" : (i === n - 1 && arrow ? "1F3864" : "5B6B8C");
      nodes.push(mk({ id: "ch" + i, label: c.title || "", sub: c.sub, shape: "rect", x: x, y: 0, w: CW, h: HH, fill: head, line: head, color: "FFFFFF", fs: 15, fsFixed: true, noFit: true }));
      nodes.push(mk({ id: "cb" + i, label: bodies[i], shape: "rect", x: x, y: HH, w: CW, h: BH, fill: "FFFFFF", line: head, color: "262626", align: "left", valign: "top", bold: false, fs: 14, fsFixed: true, noFit: true }));
      if (arrow && i < n - 1) nodes.push(mk({ id: "ca" + i, label: "", shape: "chevron", x: x + CW + 8, y: HH + BH / 2 - 22, w: AW - 16, h: 44, fill: "AFC3E6", line: "AFC3E6", noFit: true }));
    });
    return { nodes: nodes, groups: [], lines: lines };
  };

  // 로드맵(단계별 할 일): phases = [{label, period, items[], highlight}]
  BUILD.roadmap = function (spec) {
    var ps = (spec.phases || []).slice(0, 6);
    if (!ps.length) throw new Error("로드맵 도식에 phases가 없습니다.");
    var n = ps.length, PW = Math.floor((880 + (n - 1) * 6) / n), HH = 56, nodes = [];
    var bodies = ps.map(function (p) { return (p.items || []).map(function (q) { return "• " + (typeof q === "string" ? q : (q && q.label) || ""); }).join("\n"); });
    var BH = Math.max(64, Math.max.apply(null, bodies.map(function (t) { return t.split("\n").reduce(function (s, ln) { return s + breakLines(ln, 14, false, PW - 30).length * 14 * 1.45; }, 0) + 22; })));
    ps.forEach(function (p, i) {
      var x = i * (PW - 6), fill = p.highlight ? "D2601A" : STEPS[Math.min(3, i)];
      nodes.push(mk({ id: "ph" + i, label: p.label || "", shape: i ? "chevron" : "homePlate", x: x, y: 0, w: PW, h: HH, fill: fill, line: fill, color: inkOn(fill) }));
      if (p.period) nodes.push(mk({ id: "pp" + i, label: p.period, shape: "text", x: x + 10, y: HH + 4, w: PW - 30, h: 22, fs: 12, bold: true, color: "2E5395", fsFixed: true, noFit: true }));
      nodes.push(mk({ id: "pb" + i, label: bodies[i], shape: "rect", x: x + 10, y: HH + 30, w: PW - 30, h: BH, fill: "F7F9FC", line: "D0D9E8", color: "262626", align: "left", valign: "top", bold: false, fs: 14, fsFixed: true, noFit: true }));
    });
    return { nodes: nodes, groups: [], lines: [] };
  };

  var DEF_COLORS = { title: "1F3864", h2: "2E5395", sub: "595959" };
  function palette(st, style) {
    var C = (st && st.colors && st.colors.title) ? st.colors : DEF_COLORS;
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
  // 상자 색: 상자에 적힌 색(fill·line·color·subColor — null이면 없음)이 먼저, 없으면 style의 색
  function nodeColors(o, st) {
    var pc = palette(st, o.shape === "text" ? (o.style === "default" ? "plain" : o.style) : o.style);
    var pick = function (v, d) { return v === undefined ? d : (v ? hex(v) : null); };
    return { fill: o.shape === "text" && o.fill === undefined ? null : pick(o.fill, pc.fill), line: o.shape === "text" && o.line === undefined ? null : pick(o.line, pc.line),
      text: o.color ? hex(o.color) : pc.text, sub: o.subColor ? hex(o.subColor) : pc.sub };
  }
  // 서버가 배치를 돌려줄 때 색을 모두 적어 보낸다 — 페이지는 서식 설정을 몰라도 그대로 칠한다
  function resolve(lay, st) {
    lay.nodes.forEach(function (o) { var c = nodeColors(o, st); o.fill = c.fill; o.line = c.line; o.color = c.text; o.subColor = c.sub; });
    lay.groups.forEach(function (r) { if (r.kind === "box") { r.fill = r.fill || "F7F9FC"; r.line = r.line || "9AA7BD"; r.dash = r.dash !== false; r.color = r.color || hex(((st && st.colors) || DEF_COLORS).sub || "595959"); } });
    lay.lines.forEach(function (l) { l.color = l.color || "7F8AA0"; l.width = l.width || 1.6; });
    return lay;
  }

  /* ---------- 그림(캔버스) ---------- */
  function wrapText(ctx, text, maxW, maxLines) {
    // 문구 안 "\n"은 직접 나눈 줄 — 줄마다 따로 나누고, 줄 수 상한은 나눈 줄 수보다 작게 잡지 않는다
    var segs = String(text || "").split("\n");
    if (segs.length > 1) {
      var all = [];
      segs.forEach(function (g) { all = all.concat(wrapText(ctx, g, maxW, 4)); });
      return all.slice(0, Math.max(maxLines || 4, segs.length));
    }
    // 빈칸에서 먼저 줄을 바꾸고, 한 낱말이 maxW보다 길 때만 글자 단위로 자른다(Word·PowerPoint와 같은 방식)
    // 상자보다 긴 낱말은 가운뎃점(·) 뒤·여는 괄호 앞에서 먼저 나눈다("클라우드·MSP" → "클라우드·" / "MSP", 2026-11-13)
    var toks = [];
    String(text || "").split(" ").forEach(function (wd, wi) {
      var parts = ctx.measureText(wd).width > maxW ? wd.split(/(?<=·)|(?=\()/).filter(Boolean) : [wd];
      parts.forEach(function (pt, pi) { toks.push({ t: pt, sp: wi > 0 && pi === 0 }); });
    });
    var lines0 = [], cur = "";
    toks.forEach(function (tk) { var c = cur ? cur + (tk.sp ? " " : "") + tk.t : tk.t; if (cur && ctx.measureText(c).width > maxW) { lines0.push(cur); cur = tk.t; } else cur = c; });
    if (cur) lines0.push(cur);
    if (lines0.every(function (l) { return ctx.measureText(l).width <= maxW; })) return lines0.slice(0, maxLines || 4);
    var out = [], line = "";
    String(text || "").split("").forEach(function (ch) {
      if (ch === "\n") { out.push(line); line = ""; return; }
      if (ctx.measureText(line + ch).width > maxW && line) { out.push(line); line = ch.trim() ? ch : ""; } else line += ch;
    });
    if (line) out.push(line);
    out.charCut = true; // 낱말 안에서 자름(표시용)
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
      case "chevron": k = arrowK(w, h); x.moveTo(X, Y); x.lineTo(X + w - k, Y); x.lineTo(X + w, Y + h / 2); x.lineTo(X + w - k, Y + h); x.lineTo(X, Y + h); x.lineTo(X + k, Y + h / 2); x.closePath(); break;
      case "homePlate": k = arrowK(w, h); x.moveTo(X, Y); x.lineTo(X + w - k, Y); x.lineTo(X + w, Y + h / 2); x.lineTo(X + w - k, Y + h); x.lineTo(X, Y + h); x.closePath(); break;
      case "can": k = Math.min(h / 5, 12); x.moveTo(X, Y + k); x.ellipse(X + w / 2, Y + k, w / 2, k, 0, Math.PI, 0); x.lineTo(X + w, Y + h - k); x.ellipse(X + w / 2, Y + h - k, w / 2, k, 0, 0, Math.PI); x.closePath(); break;
      case "flowChartDocument": x.moveTo(X, Y); x.lineTo(X + w, Y); x.lineTo(X + w, Y + h * 0.85); x.bezierCurveTo(X + w * 0.75, Y + h * 0.7, X + w * 0.25, Y + h * 1.05, X, Y + h * 0.88); x.closePath(); break;
      default: x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r); x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath();
    }
  }
  function tracePath(x, P) {
    x.beginPath();
    P.forEach(function (c) {
      if (c[0] === "M") x.moveTo(c[1], c[2]); else if (c[0] === "L") x.lineTo(c[1], c[2]);
      else if (c[0] === "C") x.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]); else if (c[0] === "Q") x.quadraticCurveTo(c[1], c[2], c[3], c[4]);
      else if (c[0] === "Z") x.closePath();
    });
  }
  // 범용 그림: 배치 결과(묶음·선·상자의 윤곽 경로·글자 자리·색)만 보고 그린다. 모양 이름을 몰라도 되므로
  // 업무 에이전트 페이지는 이 함수 하나로 서버가 보낸 어떤 도식이든 그린다(새 모양을 넣어도 페이지를 고치지 않는다)
  function toCanvas(lay, st, maxW, doc) {
    var font = (st && st.chart && st.chart.font) || "sans-serif", s = Math.min(1.4, (maxW || (st && st.chart && st.chart.width) || 760) / lay.W);
    var W = Math.round(lay.W * s), H = Math.round(lay.H * s);
    var c = (doc || document).createElement("canvas"); c.width = W * 2; c.height = H * 2;
    var x = c.getContext("2d"); x.scale(2 * s, 2 * s); x.fillStyle = "#ffffff"; x.fillRect(0, 0, lay.W, lay.H);
    var col = function (v, d) { return "#" + hex(v || d); };
    lay.groups.forEach(function (r) {
      x.save();
      if (r.kind === "box" && r.dash !== false) x.setLineDash([6, 4]);
      x.lineWidth = r.kind === "box" ? 1.2 : 1;
      tracePath(x, r.path || [["M", r.x, r.y], ["L", r.x + r.w, r.y], ["L", r.x + r.w, r.y + r.h], ["L", r.x, r.y + r.h], ["Z"]]);
      if (r.fill !== null) { x.fillStyle = col(r.fill, "F7F9FC"); x.fill(); }
      if (r.line !== null) { x.strokeStyle = col(r.line, "9AA7BD"); x.stroke(); }
      x.restore();
      if (r.label) { x.fillStyle = col(r.color, st && st.colors ? st.colors.sub : "595959"); x.font = "bold 13px " + font; x.textAlign = "left"; x.textBaseline = "top"; x.fillText(r.label, r.x + 8, r.y + 7); }
    });
    var drawLines = function () {
      lay.lines.forEach(function (ln) {
        var lc = col(ln.color, "7F8AA0");
        x.save(); x.strokeStyle = lc; x.fillStyle = lc; x.lineWidth = ln.width || 1.6; if (ln.dashed) x.setLineDash([6, 4]);
        x.beginPath(); ln.pts.forEach(function (p, i) { if (i) x.lineTo(p[0], p[1]); else x.moveTo(p[0], p[1]); }); x.stroke(); x.setLineDash([]);
        var hl = 7 + (ln.width || 1.6) * 1.8;
        var head = function (a, b) { var ang = Math.atan2(b[1] - a[1], b[0] - a[0]); x.beginPath(); x.moveTo(b[0], b[1]); x.lineTo(b[0] - hl * Math.cos(ang - 0.4), b[1] - hl * Math.sin(ang - 0.4)); x.lineTo(b[0] - hl * Math.cos(ang + 0.4), b[1] - hl * Math.sin(ang + 0.4)); x.closePath(); x.fill(); };
        var P = ln.pts;
        if (ln.arrow !== "none" && P.length > 1) head(P[P.length - 2], P[P.length - 1]);
        if (ln.arrow === "both" && P.length > 1) head(P[1], P[0]);
        x.restore();
      });
    };
    drawLines();
    lay.nodes.forEach(function (o) {
      var cc = nodeColors(o, st || { colors: {} });
      var P = o.path || geomPath(o), tr = o.tr || textRect(o);
      if (cc.fill || cc.line) {
        tracePath(x, P);
        if (cc.fill) { x.save(); x.globalAlpha = o.alpha != null ? o.alpha : 1; x.fillStyle = "#" + cc.fill; x.fill(); x.restore(); }
        if (cc.line) { x.strokeStyle = "#" + cc.line; x.lineWidth = 1; x.stroke(); }
      }
      if (!o.label && !o.sub) return;
      var bold = o.bold != null ? o.bold : o.shape !== "text";
      var innerW = Math.max(10, (o.shape === "text" ? o.w - 2 * PADX : tr.w - 6)), many = o.valign === "top" || o.fsFixed;
      var lfs = o.fs || 14, lab, maxL = many ? 99 : (o.shape === "text" ? 5 : 3), avail = (o.shape === "text" ? o.h : tr.h);
      var sfs = Math.min(o.subFs || 12, lfs);
      for (var fsTry = lfs; ; fsTry--) {
        x.font = (bold ? "bold " : "") + fsTry + "px " + font;
        var all = wrapText(x, o.label, innerW, 99), subH = o.sub ? 32 : 0;
        var fits = many || (all.length <= Math.max(maxL, Math.floor((avail - 2 * PADY - subH) / Math.round(fsTry * 1.3))) && all.length * Math.round(fsTry * 1.3) + subH <= avail - 4 && !all.charCut);
        if (fits || fsTry <= Math.min(10, lfs)) { lfs = fsTry; lab = fits ? all : wrapText(x, o.label, innerW, Math.max(maxL, Math.floor((avail - 2 * PADY - subH) / Math.round(fsTry * 1.3)))); break; }
      }
      x.font = sfs + "px " + font;
      var sub = o.sub ? wrapText(x, o.sub, innerW, many ? 99 : 3) : [];
      var lh = Math.round(lfs * 1.3), slh = Math.round(sfs * 1.35);
      var tot = lab.length * lh + sub.length * slh;
      var top = o.shape === "text" ? o.y : tr.y, ht = o.shape === "text" ? o.h : tr.h;
      var y0 = o.valign === "top" || (o.shape === "text" && o.valign !== "middle") ? top + PADY : top + ht / 2 - tot / 2;
      var left = o.shape === "text" ? o.x + PADX : tr.x + 3, al = o.align || "center";
      var cx = al === "left" ? left : al === "right" ? left + innerW : left + innerW / 2;
      x.textAlign = al; x.textBaseline = "top"; x.fillStyle = "#" + cc.text; x.font = (bold ? "bold " : "") + lfs + "px " + font;
      lab.forEach(function (t, i) { x.fillText(t, cx, y0 + i * lh); });
      x.fillStyle = "#" + cc.sub; x.font = sfs + "px " + font;
      sub.forEach(function (t, i) { x.fillText(t, cx, y0 + lab.length * lh + i * slh); });
    });
    // 선 이름표는 상자 위에 그린다(상자에 가려 보이지 않던 것 — 2026-11-13)
    lay.lines.forEach(function (ln) {
      if (!ln.label) return;
      x.font = "12px " + font; var tw = x.measureText(ln.label).width;
      x.fillStyle = "#ffffff"; x.fillRect(ln.lx - tw / 2 - 4, ln.ly - 9, tw + 8, 18);
      x.fillStyle = "#262626"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(ln.label, ln.lx, ln.ly);
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
    // 경로 → pptxgenjs 사용자 정의 도형 점(도형 왼쪽 위 기준 인치)
    var pts = function (P, x0, y0) {
      return P.map(function (c) {
        if (c[0] === "M") return { x: L(c[1] - x0), y: L(c[2] - y0), moveTo: true };
        if (c[0] === "L") return { x: L(c[1] - x0), y: L(c[2] - y0) };
        if (c[0] === "C") return { x: L(c[5] - x0), y: L(c[6] - y0), curve: { type: "cubic", x1: L(c[1] - x0), y1: L(c[2] - y0), x2: L(c[3] - x0), y2: L(c[4] - y0) } };
        if (c[0] === "Q") return { x: L(c[3] - x0), y: L(c[4] - y0), curve: { type: "quadratic", x1: L(c[1] - x0), y1: L(c[2] - y0) } };
        return { close: true };
      });
    };
    lay.groups.forEach(function (r) {
      var box2 = r.kind === "box";
      slide.addText(r.label || "", { shape: "rect", x: X(r.x), y: Y(r.y), w: L(r.w), h: L(r.h), fill: r.fill === null ? undefined : { color: hex(r.fill || "F7F9FC") },
        line: r.line === null ? undefined : { color: hex(r.line || "9AA7BD"), width: box2 ? 1 : 0.75, dashType: box2 && r.dash !== false ? "dash" : "solid" },
        fontFace: fontFace, fontSize: pt(13), bold: true, color: hex(r.color || st.colors.sub), align: "left", valign: "top", margin: 4 });
    });
    lay.lines.forEach(function (ln) {
      var P = ln.pts, lc = hex(ln.color || "7F8AA0"), lw = +((ln.width || 1.6) * 0.78).toFixed(2);
      if (ln.smooth && P.length > 2) { // 곡선은 한 도형(열린 사용자 정의 도형)으로 — 고칠 때 한 번에 잡히게
        var bx = bbox(P.map(function (p) { return { x: p[0], y: p[1], w: 0, h: 0 }; }));
        var o2 = { x: X(bx[0]), y: Y(bx[1]), w: Math.max(0.01, L(bx[2] - bx[0])), h: Math.max(0.01, L(bx[3] - bx[1])), points: pts(P.map(function (p, i) { return [i ? "L" : "M", p[0], p[1]]; }), bx[0], bx[1]),
          line: { color: lc, width: lw } };
        if (ln.dashed) o2.line.dashType = "dash";
        if (ln.arrow !== "none") o2.line.endArrowType = "triangle";
        if (ln.arrow === "both") o2.line.beginArrowType = "triangle";
        slide.addShape("custGeom", o2);
        return;
      }
      for (var i = 1; i < P.length; i++) {
        var a = P[i - 1], b = P[i], last = i === P.length - 1, first = i === 1;
        var o = { x: X(Math.min(a[0], b[0])), y: Y(Math.min(a[1], b[1])), w: L(Math.abs(b[0] - a[0])), h: L(Math.abs(b[1] - a[1])),
          flipH: b[0] < a[0], flipV: b[1] < a[1], line: { color: lc, width: lw } };
        if (ln.dashed) o.line.dashType = "dash";
        if (last && ln.arrow !== "none") o.line.endArrowType = "triangle";
        if (first && ln.arrow === "both") o.line.beginArrowType = "triangle";
        slide.addShape("line", o);
      }
    });
    lay.nodes.forEach(function (o) {
      var cc = nodeColors(o, st), bold = o.bold != null ? o.bold : o.shape !== "text";
      var runs = [{ text: (o.lines ? o.lines.join("\n") : o.label) || " ", options: { bold: bold, color: cc.text, fontSize: pt(o.fs || 14), breakLine: !!o.sub } }];
      if (o.sub) runs.push({ text: o.sub, options: { color: cc.sub, fontSize: pt(Math.min(o.subFs || 12, o.fs || 14)) } });
      var opt = { x: X(o.x), y: Y(o.y), w: L(o.w), h: L(o.h), fontFace: fontFace, align: o.align || "center",
        valign: o.valign === "top" || (o.shape === "text" && o.valign !== "middle") ? "top" : "middle", margin: o.align === "left" ? [2, 6, 2, 6] : [1, 3, 1, 3] };
      if (cc.fill || cc.line) {
        var pre = PRESET[o.shape];
        opt.shape = pre || "custGeom";
        if (!pre) opt.points = pts(o.path || geomPath(o), o.x, o.y);
        opt.fill = cc.fill ? { color: cc.fill, transparency: o.alpha != null ? Math.round((1 - o.alpha) * 100) : 0 } : { type: "none" };
        opt.line = cc.line ? { color: cc.line, width: 0.75 } : { type: "none" };
      }
      // pptxgenjs는 rectRadius를 어느 도형이든 조정값 adj(= 반지름 / 짧은 변 × 100000)로 쓴다 — 화살표 꺾임 깊이를 그림과 같게
      if (o.shape === "chevron" || o.shape === "homePlate") opt.rectRadius = +(arrowK(o.w, o.h) * s).toFixed(4);
      slide.addText(o.label || o.sub ? runs : "", opt);
    });
    // 선 이름표는 상자 위에(가려지지 않게). 폭은 글자 폭으로(한글 1em, 그 밖 0.6em)
    lay.lines.forEach(function (ln) {
      if (!ln.label) return;
      var tw = Math.max(0.4, textW(ln.label, 12, false) * pt(12) / 12 / 72 + 0.14);
      slide.addText(ln.label, { x: X(ln.lx) - tw / 2, y: Y(ln.ly) - 0.13, w: tw, h: 0.26, fontFace: fontFace, fontSize: pt(12), color: "262626", align: "center", valign: "middle", fill: { color: "FFFFFF" }, margin: 0 });
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
    var para0 = para;
    para = function (text, color, sz, bold, align) { // 직접 나눈 줄("\n")은 줄바꿈(<w:br/>)으로
      var segs = String(text || "").split("\n");
      if (segs.length < 2) return para0(text, color, sz, bold, align);
      return para0(segs[0], color, sz, bold, align).replace(/<\/w:t><\/w:r><\/w:p>$/, "</w:t></w:r>") +
        segs.slice(1).map(function (g) { return "<w:r>" + rpr(color, sz, bold) + '<w:br/><w:t xml:space="preserve">' + xe(g) + "</w:t></w:r>"; }).join("") + "</w:p>";
    };
    // geom: Office 기본 모양 이름, 또는 "custom"(ex.path = 도형 왼쪽 위 기준 경로, ex.open = 열린 선)
    var shape = function (geom, x, y, w, h, fill, line, dash, txt, anchor, flipH, flipV, ends, ex) {
      id++; ex = ex || {};
      var lw = ex.lw ? Math.round(ex.lw * 9525) : (geom === "line" ? 15875 : 9525);
      var ln = line ? '<a:ln w="' + lw + '"><a:solidFill><a:srgbClr val="' + line + '"/></a:solidFill>' + (dash ? '<a:prstDash val="dash"/>' : "") + (ends || "") + "</a:ln>" : "<a:ln><a:noFill/></a:ln>";
      var gx;
      if (geom === "custom") {
        var E2 = function (v) { return Math.round(v * e); };
        var body = ex.path.map(function (c) {
          if (c[0] === "M") return '<a:moveTo><a:pt x="' + E2(c[1]) + '" y="' + E2(c[2]) + '"/></a:moveTo>';
          if (c[0] === "L") return '<a:lnTo><a:pt x="' + E2(c[1]) + '" y="' + E2(c[2]) + '"/></a:lnTo>';
          if (c[0] === "C") return '<a:cubicBezTo><a:pt x="' + E2(c[1]) + '" y="' + E2(c[2]) + '"/><a:pt x="' + E2(c[3]) + '" y="' + E2(c[4]) + '"/><a:pt x="' + E2(c[5]) + '" y="' + E2(c[6]) + '"/></a:cubicBezTo>';
          if (c[0] === "Q") return '<a:quadBezTo><a:pt x="' + E2(c[1]) + '" y="' + E2(c[2]) + '"/><a:pt x="' + E2(c[3]) + '" y="' + E2(c[4]) + '"/></a:quadBezTo>';
          return "<a:close/>";
        }).join("");
        gx = '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/><a:pathLst><a:path w="' + Math.max(1, w) + '" h="' + Math.max(1, h) + '"' + (ex.open ? ' fill="none"' : "") + ">" + body + "</a:path></a:pathLst></a:custGeom>";
      } else gx = '<a:prstGeom prst="' + geom + '">' + (geom === "chevron" || geom === "homePlate" ? '<a:avLst><a:gd name="adj" fmla="val ' + arrowAdj(w, h) + '"/></a:avLst>' : "<a:avLst/>") + "</a:prstGeom>";
      var fl = fill ? '<a:solidFill><a:srgbClr val="' + fill + '">' + (ex.alpha != null && ex.alpha < 1 ? '<a:alpha val="' + Math.round(ex.alpha * 100000) + '"/>' : "") + "</a:srgbClr></a:solidFill>" : "<a:noFill/>";
      return '<wps:wsp><wps:cNvPr id="' + id + '" name="도형 ' + id + '"/><wps:cNvSpPr/><wps:spPr><a:xfrm' + (flipH ? ' flipH="1"' : "") + (flipV ? ' flipV="1"' : "") + '><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + Math.max(0, w) + '" cy="' + Math.max(0, h) + '"/></a:xfrm>' + gx +
        fl + ln + "</wps:spPr>" +
        (txt ? "<wps:txbx><w:txbxContent>" + txt + "</w:txbxContent></wps:txbx>" : "") +
        '<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="36000" tIns="18000" rIns="36000" bIns="18000" anchor="' + (anchor || "ctr") + '" anchorCtr="0"><a:noAutofit/></wps:bodyPr></wps:wsp>';
    };
    var rel = function (P, x0, y0) { return P.map(function (c) { var r = c.slice(); for (var i = 1; i < r.length; i += 2) { r[i] -= x0; r[i + 1] -= y0; } return r; }); };
    var kids = [];
    lay.groups.forEach(function (r) {
      var box2 = r.kind === "box";
      kids.push(shape("rect", E(r.x), E(r.y), E(r.w), E(r.h), r.fill === null ? null : hex(r.fill || "F7F9FC"), r.line === null ? null : hex(r.line || "9AA7BD"), box2 && r.dash !== false,
        r.label ? para(r.label, hex(r.color || st.colors.sub), hp(13), true, "left") : "", "t"));
    });
    lay.lines.forEach(function (ln) {
      var P = ln.pts, lc = hex(ln.color || "7F8AA0"), lwpt = (ln.width || 1.6) * 0.78;
      if (ln.smooth && P.length > 2) {
        var bx = bbox(P.map(function (p) { return { x: p[0], y: p[1], w: 0, h: 0 }; }));
        var ends0 = (ln.arrow === "both" ? '<a:headEnd type="triangle" w="med" len="med"/>' : "") + (ln.arrow !== "none" ? '<a:tailEnd type="triangle" w="med" len="med"/>' : "");
        kids.push(shape("custom", E(bx[0]), E(bx[1]), Math.max(1, E(bx[2] - bx[0])), Math.max(1, E(bx[3] - bx[1])), null, lc, ln.dashed, "", "ctr", false, false, ends0,
          { path: rel(P.map(function (p, i) { return [i ? "L" : "M", p[0], p[1]]; }), bx[0], bx[1]), open: true, lw: lwpt / 0.75 }));
        return;
      }
      for (var i = 1; i < P.length; i++) {
        var a = P[i - 1], b = P[i], last = i === P.length - 1, first = i === 1;
        var ends = (first && ln.arrow === "both" ? '<a:headEnd type="triangle" w="med" len="med"/>' : "") + (last && ln.arrow !== "none" ? '<a:tailEnd type="triangle" w="med" len="med"/>' : "");
        kids.push(shape("line", E(Math.min(a[0], b[0])), E(Math.min(a[1], b[1])), E(Math.abs(b[0] - a[0])), E(Math.abs(b[1] - a[1])), null, lc, ln.dashed, "", "ctr", b[0] < a[0], b[1] < a[1], ends, { lw: lwpt / 0.75 }));
      }
    });
    lay.nodes.forEach(function (o) {
      var cc = nodeColors(o, st), bold = o.bold != null ? o.bold : o.shape !== "text", al = o.align === "left" ? "left" : o.align === "right" ? "right" : "center";
      var txt = (o.label ? para(o.lines ? o.lines.join("\n") : o.label, cc.text, hp(o.fs || 14), bold, al) : "") + (o.sub ? para(o.sub, cc.sub, hp(Math.min(o.subFs || 12, o.fs || 14)), false, al) : "");
      var anchor = o.valign === "top" || (o.shape === "text" && o.valign !== "middle") ? "t" : "ctr";
      if (!cc.fill && !cc.line) { kids.push(shape("rect", E(o.x), E(o.y), E(o.w), E(o.h), null, null, false, txt, anchor)); return; }
      var pre = PRESET[o.shape];
      if (pre) kids.push(shape(pre, E(o.x), E(o.y), E(o.w), E(o.h), cc.fill, cc.line, false, txt, anchor, false, false, "", { alpha: o.alpha }));
      else kids.push(shape("custom", E(o.x), E(o.y), E(o.w), E(o.h), cc.fill, cc.line, false, txt, anchor, false, false, "", { alpha: o.alpha, path: rel(o.path || geomPath(o), o.x, o.y) }));
    });
    // 선 이름표는 상자 위에(가려지지 않게)
    lay.lines.forEach(function (ln) {
      if (!ln.label) return;
      var hz = hp(12), twE = Math.round(ln.label.length * hz / 2 * 12700 * 1.05 + 90000), thE = Math.round(hz / 2 * 12700 * 1.5 + 36000);
      kids.push(shape("rect", E(ln.lx) - Math.round(twE / 2), E(ln.ly) - Math.round(thE / 2), twE, thE, "FFFFFF", null, false, para(ln.label, "262626", hz, false), "ctr"));
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
      if ((!o.label && !o.sub) || o.noFit) return;
      var bold = o.bold != null ? o.bold : o.shape !== "text", trW = o.tr ? o.tr.w : textRectW(o.shape, o.w, o.h), trH = o.tr ? o.tr.h : textRectH(o.shape, o.w, o.h);
      if (o.shape === "text") { trW = o.w; trH = o.h; }
      // 렌더러마다 글상자 계산이 조금씩 달라(LibreOffice 실측: 셰브론 글자 자리가 정의보다 좁게 나옴) 폭에 15% 여유를 둔다
      var inner = (trW - 72000 / e) * 0.85, innerH = trH - 36000 / e;
      var L = hpx(o.fs || 14), S = hpx(12);
      // Word 도형의 줄바꿈과 그림(글자 14·12px 그대로)의 줄바꿈을 비교한다. Word 쪽 줄이 더 많거나 높이를 넘으면 그림이 낫다
      var ll = breakLines(o.label, L, bold, inner), sl = o.sub ? breakLines(o.sub, S, false, inner) : [];
      var imgW = o.shape === "text" ? o.w - 2 * PADX : (o.tr ? o.tr.w - 6 : imgInnerW(o));
      var il = breakLines(o.label, o.fs || 14, bold, imgW), is = o.sub ? breakLines(o.sub, 12, false, imgW) : [];
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
      if (report) report.push({ k: k, shapes: fit.ok || !!lay._force, bad: fit.bad });
      if (!fit.ok && !force && !lay._force) return; // _force: 대체 그림이 빈 자리(그림 없이 받은 도식)라 도형이 아니면 보일 것이 없다
      var g = docxGroup(lay, st, cxEmu, uid, font); uid = g.nextId + 10;
      xml = xml.replace(m[0], function () { return '<mc:AlternateContent><mc:Choice Requires="wpg">' + g.xml + "</mc:Choice><mc:Fallback>" + m[0] + "</mc:Fallback></mc:AlternateContent>"; });
    });
    return xml;
  }
  // 한글·Excel처럼 도형을 넣지 않는 형식에 쓸 글 설명
  // 도식 종류별 관계 문장(그림을 못 넣는 한글·PDF·MD용). 새 종류를 넣을 때 여기에도 한 줄 넣는다 — 없으면 아래 공통 규칙(글 있는 상자 나열)
  var bl = function (it) { var t = itemText(it); return t.label + (t.sub ? " — " + t.sub : "") + (t.note ? " (" + t.note + ")" : ""); };
  var lst = function (a) { return (a || []).map(function (x) { return typeof x === "string" ? x : (x && x.label) || ""; }).filter(Boolean).join(", "); };
  var DESC = {
    swimlane: function (sp) {
      var lab = {}; (sp.nodes || []).forEach(function (n) { lab[n.id] = n.label; });
      return (sp.lanes || []).map(function (l) { l = typeof l === "string" ? { id: l, label: l } : l; return "[" + l.label + "] " + (sp.nodes || []).filter(function (n) { return n.lane === l.id; }).map(function (n) { return n.label; }).join(", "); })
        .concat((sp.edges || []).filter(function (e) { return lab[e.from] && lab[e.to]; }).map(function (e) { return lab[e.from] + " → " + lab[e.to] + (e.label ? " (" + e.label + ")" : ""); }));
    },
    cycle: function (sp) { var st = (sp.steps || sp.items || []).map(bl); return st.map(function (t, i) { return (i + 1) + ". " + t; }).concat(st.length ? [st.length + "단계 다음은 다시 1단계로 돌아감" + (sp.center ? " (가운데: " + itemText(sp.center).label + ")" : "")] : []); },
    hub: function (sp) { return ["가운데: " + itemText(sp.center || "핵심").label].concat((sp.items || []).map(function (x, i) { return (i + 1) + ". " + bl(x); })); },
    matrix: function (sp) {
      var x = sp.x || {}, y = sp.y || {}, q = (sp.quadrants || []).map(itemText), nm = ["왼쪽 위", "오른쪽 위", "왼쪽 아래", "오른쪽 아래"];
      var out = ["가로축: " + (x.label || "") + " (" + (x.low || "낮음") + " → " + (x.high || "높음") + "), 세로축: " + (y.label || "") + " (" + (y.low || "낮음") + " → " + (y.high || "높음") + ")"];
      q.forEach(function (t, i) { if (t.label) out.push("[" + nm[i] + "] " + t.label + (t.sub ? " — " + t.sub : "")); });
      (sp.items || []).forEach(function (it) { it = itemText(it); var qi = (+it.y >= 0.5 ? 0 : 2) + (+it.x >= 0.5 ? 1 : 0); out.push(it.label + ": " + (q[qi] && q[qi].label ? q[qi].label : nm[qi])); });
      return out;
    },
    grid: function (sp) { return (sp.cells || []).map(function (c) { return "[" + (c.title || "") + "] " + lst(c.items); }); },
    swot: function (sp) { return [["s", "강점"], ["w", "약점"], ["o", "기회"], ["t", "위협"]].map(function (k) { return "[" + k[1] + "] " + lst(sp[k[0]]); }); },
    pyramid: function (sp) { return (sp.levels || sp.items || []).map(function (l, i) { var t = itemText(l); return (i + 1) + ". " + t.label + (t.value != null ? " " + t.value : "") + (t.sub ? " — " + t.sub : "") + (t.note ? " (" + t.note + ")" : ""); }); },
    venn: function (sp) {
      var out = (sp.sets || []).map(function (x) { return "[집합] " + bl(x); });
      if (sp.pairs) Object.keys(sp.pairs).forEach(function (k) { out.push("[" + k.split("").map(function (c) { var i = "ABC".indexOf(c); return sp.sets[i] ? itemText(sp.sets[i]).label : c; }).join("·") + " 겹침] " + sp.pairs[k]); });
      if (sp.overlap || sp.center) out.push("[모두 겹침] " + itemText(sp.overlap || sp.center).label);
      return out;
    },
    onion: function (sp) { return (sp.rings || sp.levels || []).map(function (r, i) { return (i ? "바깥 " + i + "층: " : "가운데: ") + bl(r); }); },
    layers: function (sp) { return (sp.layers || []).map(function (l) { return "[" + (l.label || "") + "] " + lst(l.items); }); },
    compare: function (sp) { return (sp.columns || []).map(function (c) { return "[" + (c.title || "") + "] " + lst(c.items); }); },
    roadmap: function (sp) { return (sp.phases || []).map(function (p) { return "[" + (p.label || "") + (p.period ? " · " + p.period : "") + "] " + lst(p.items); }); }
  };
  DESC.funnel = DESC.pyramid;
  function describe(spec) {
    var t0 = typeKey(spec);
    if (DESC[t0]) { try { return DESC[t0](spec); } catch (e) { return []; } }
    var lay; try { lay = layout(spec); } catch (e) { return []; }
    if (BUILD[t0]) return lay.nodes.filter(function (o) { return o.label; }).map(function (o, i) { return (i + 1) + ". " + o.label + (o.sub ? " — " + o.sub : ""); });
    var name = {}; lay.nodes.forEach(function (o) { name[o.id] = o.label || o.id; });
    var out = [];
    lay.groups.forEach(function (g) { out.push("[" + g.label + "] " + lay.nodes.filter(function (o) { return o.group === g.id; }).map(function (o) { return o.label; }).join(", ")); });
    var g0 = normalize(spec);
    (g0.edges || []).forEach(function (e) { if (name[e.from] && name[e.to]) out.push(name[e.from] + " → " + name[e.to] + (e.label ? " (" + e.label + ")" : "")); });
    if (!g0.edges.length) lay.nodes.filter(function (o) { return o.shape !== "text"; }).forEach(function (o, i) { out.push((i + 1) + ". " + o.label + (o.sub ? " — " + o.sub : "")); });
    return out;
  }
  // 줄바꿈 점검: 도형 안 글자가 저절로 줄이 바뀌면서 마지막 줄에 짧은 조각(한두 낱말)만 남는 상자를 찾는다.
  // 배치(layout)와 같은 글자 폭·글상자 계산을 쓴다. 고치려면 문구를 줄이거나 "\n"으로 줄을 직접 나눈다
  function wrapCheck(lay) {
    var out = [];
    lay.nodes.forEach(function (o) {
      if (o.noFit) return;
      var bold = o.bold != null ? o.bold : o.shape !== "text";
      var innerW = o.shape === "text" ? o.w - 2 * PADX : (o.tr ? o.tr.w : textRectW(o.shape, o.w, o.h)) - 2 * PADX;
      [[o.label, o.fs || 14, bold], [o.sub, 12, false]].forEach(function (t) {
        if (!t[0]) return;
        String(t[0]).split("\n").forEach(function (seg) {
          var ls = breakLines(seg, t[1], t[2], innerW);
          if (ls.length < 2) return;
          var last = ls[ls.length - 1], lw = textW(last, t[1], t[2]);
          if (lw < innerW * 0.4) out.push({ box: o.label || o.sub, text: seg, lines: ls, hint: "마지막 줄 '" + last + "'만 따로 넘어감 — 문구를 줄이거나 \\n으로 줄을 직접 나누세요" });
        });
      });
    });
    return out;
  }
  // 중계 서버가 페이지에 돌려주는 배치: 색까지 적어(resolve) JSON으로. 페이지는 toCanvas(배치)만 부르면 된다
  function serverLayout(spec, st) {
    var lay = layout(spec);
    resolve(lay, st || { colors: DEF_COLORS });
    return JSON.parse(JSON.stringify(lay));
  }
  var TYPES = function () { return Object.keys(BUILD).concat(["graph", "flow", "tree", "chevron"]); };
  return { serverLayout: serverLayout, types: TYPES, normalize: normalize, layout: layout, wrapCheck: wrapCheck, toCanvas: toCanvas, toPptx: toPptx, docxGroup: docxGroup, patchDocxXml: patchDocxXml, wordFit: wordFit, describe: describe };
})();

/* ===== 그림 모듈: 답변 속 ```chart / ```diagram 블록(JSON 설정)을 그림(PNG)으로 그린다 =====
   - chart: ECharts로 그린다(막대·선·면적·누적·가로막대·파이·도넛·산점도·복합, 또는 option에 ECharts 설정 JSON).
   - diagram: 캔버스로 직접 그린다(셰브론 단계도, 흐름도).
   - 설정은 JSON 값만 받는다. 함수·코드는 받지 않고, 바깥 이미지(graphic)는 지운다. */
if (typeof module !== "undefined" && module.exports) module.exports = Diagram;
