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
    if (ch === " ") return 0.36; // 맑은 고딕 0.352em(2026-11-26 실측 — 0.3이면 빈칸 많은 글이 추정보다 넓게 그려졌다)
    if (ch === "%" || ch === "&" || ch === "@" || ch === "W" || ch === "M") return 0.88; // 맑은 고딕 0.82~0.95em
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
  // 고른 줄 나눔: 빈칸·가운뎃점 뒤에서만 줄을 바꾸되, 같은 줄 수 안에서 가장 긴 줄이 가장 짧아지게 나눈다(욕심 줄바꿈이면 마지막 줄에
  // '추진'·'협의'처럼 한 낱말만 남았다 — 2026-11-26 도식 점검). 폭보다 긴 낱말이 있으면 글자 단위(breakLines)로 돌아간다.
  // 배치가 이 결과를 o.lines·o.subLines로 적어 두면 PowerPoint·Word·그림이 그 자리에서 줄을 바꾼다 — LibreOffice는 언어를 ko-KR로 해도
  // 한글 낱말 안에서 끊어("개발 파트너 품/질·보안") Word 그림이 그렇게 나왔다
  function balanceLines(t, px, bold, maxW) {
    var segs = String(t || "").split("\n");
    if (segs.length > 1) return [].concat.apply([], segs.map(function (g) { return balanceLines(g, px, bold, maxW); }));
    var toks = [];
    String(t || "").split(" ").filter(function (x) { return x !== ""; }).forEach(function (wd, wi) {
      wd.split(/(?<=·)/).forEach(function (pt, pi) { toks.push({ t: pt, sp: wi > 0 && pi === 0 }); });
    });
    if (!toks.length) return [""];
    if (toks.some(function (k) { return textW(k.t, px, bold) > maxW; })) return breakLines(t, px, bold, maxW);
    var greedy = wordLines(t, px, bold, maxW);
    if (greedy.length < 2) return greedy;
    var n = toks.length, L = greedy.length;
    var lineOf = function (i, j) { var s2 = ""; for (var q = i; q < j; q++) s2 += (q > i && toks[q].sp ? " " : "") + toks[q].t; return s2; };
    var W = function (i, j) { return textW(lineOf(i, j), px, bold); };
    // best[k][i]: 앞 i개 낱말을 k줄로 나눌 때 {가장 긴 줄, 제곱합, 자른 자리}
    var best = [];
    for (var k = 0; k <= L; k++) { best.push([]); for (var i = 0; i <= n; i++) best[k].push(null); }
    best[0][0] = { mx: 0, sq: 0, cut: -1 };
    for (var k2 = 1; k2 <= L; k2++) for (var j = 1; j <= n; j++) for (var i2 = k2 - 1; i2 < j; i2++) {
      var prev = best[k2 - 1][i2]; if (!prev) continue;
      var w = W(i2, j); if (w > maxW) continue;
      var c = { mx: Math.max(prev.mx, w), sq: prev.sq + w * w, cut: i2 };
      var cur = best[k2][j];
      if (!cur || c.mx < cur.mx - 0.5 || (Math.abs(c.mx - cur.mx) <= 0.5 && c.sq < cur.sq)) best[k2][j] = c;
    }
    if (!best[L][n]) return greedy;
    var out = [], jj = n;
    for (var kk = L; kk >= 1; kk--) { var ii = best[kk][jj].cut; out.unshift(lineOf(ii, jj)); jj = ii; }
    return out;
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
        // 기본 폭은 단계 수로 나눠 전체 폭이 880px 안에 들게(단계 8개면 117px) — 150px 고정이면 8단계가 1,232px로 그려져 Word에서 글자가
        // 5pt가 됐다(2026-11-26 도식 점검 — 860px 기준). 원고가 node_w를 주면 그 값. 글이 길면 배치가 줄을 나누고 높이를 늘린다
        node_w: n(spec.node_w, Math.min(150, Math.floor((860 + 8 * Math.max(0, steps.length - 1)) / Math.max(1, steps.length))), 60, 400), node_h: Math.min(62, n(spec.node_h, 62, 30, 200)), col_gap: -8, row_gap: 12 };
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
    if (spec.wrap === false) g.wrap = false; // 긴 가로 흐름을 여러 줄로 접지 않음
    return g;
  }

  // 배치 크기 점수(1 이상이면 기준 충족): Word 그림(본문 폭 451pt, 높이 상한은 docCap과 같이 본문의 40~60%)에서 14px 글이 7pt,
  // PPT 원본(16:9 도식 영역 873×374pt)에서 14px 글이 8pt가 되는 배율을 1로 잡아 둘 중 작은 값 — 클수록 글자가 크다
  function fitScore(W, H) {
    var capH = Math.max(291, Math.min(437, Math.min(H * 0.5, H * 451 / W)));
    return Math.min(Math.min(451 / W, capH / H) / 0.5, Math.min(873 / W, 374 / H) / 0.5714);
  }
  function wordScale(l) { return fitScore(l.W, l.H) * 0.5; }
  // 배치: 결과 좌표는 px 단위(배율 1). 단계가 많아 도식이 길쭉해지면(Word에서 14px 글이 7pt 아래) 다른 방향 배치도 해 보고 더 큰 쪽을 쓴다 —
  // 위→아래 흐름도 10단계가 454×1,114px, 세로 스윔레인 12단계가 988×1,204px로 그려져 Word에서 글자가 3pt가 됐다(2026-11-26 도식 점검).
  // 방향을 바꾸면 lay.flipped에 적는다. 원고가 "auto_direction": false면 바꾸지 않는다
  function layout(spec) {
    var lay = layoutOne(spec), t = typeKey(spec);
    if (!spec || spec.auto_direction === false || spec._alt || fitScore(lay.W, lay.H) >= 0.9) return lay;
    var alts = [];
    if (t === "swimlane") alts = [{ direction: "LR", wrap: false }, { direction: "TB" }];
    else if (!BUILD[t] && t !== "chevron" && !(spec.nodes || []).some(function (nd) { return nd && typeof nd.row === "number" && typeof nd.col === "number"; })) {
      var LR0 = normalize(spec).direction === "LR";
      alts = [{ direction: LR0 ? "TB" : "LR" }];
    }
    var s0 = fitScore(lay.W, lay.H), best = lay, bs = s0 * (s0 >= 0.75 ? 1.15 : 1.02); // 원래 방향을 조금 더 아낀다(이미 많이 작으면 조금만)
    alts.forEach(function (a) {
      try {
        var l2 = layoutOne(Object.assign({}, spec, a, { _alt: true }));
        var s2 = fitScore(l2.W, l2.H);
        if (s2 > bs) { best = l2; bs = s2; best.flipped = a.direction; }
      } catch (e) { /* 다른 방향을 못 그리면 원래 배치 */ }
    });
    return best;
  }
  function layoutOne(spec) {
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
    var WMAX = 860; // 여백(좌우 16px)을 더한 도식 폭이 892px 이하 → Word 본문 폭(451pt)에서 14px 글이 7pt 이상(2026-11-26, 880이면 6.9pt)
    // ownD: 마름모(판단)는 따로 크기를 정한다(sizeDiamond) — 마름모 글상자는 폭·높이의 절반뿐이라 공통 크기에 넣으면 글이
    // 여러 줄로 부서지고, 그 높이가 모든 상자의 공통 높이를 끌어올렸다(2026-11-24 업무 에이전트 하도급 흐름도: 상자 7개가 모두 239px)
    function autoSize(cols, ownD, extra) { // extra: 상자 폭 말고 가로로 더 차지하는 폭(나무 배치의 쌓인 자식 들여쓰기 등)
      var cap0 = Math.min(400, (WMAX - (extra || 0) - CG * Math.max(0, cols - 1)) / Math.max(1, cols));
      // 가로로 늘어선 상자가 많으면 기본 폭(170·150px)보다 좁게(110px까지) — 기본 폭을 하한으로 두면 상자 넷 + 들여쓰기만으로
      // 880px을 넘었다(2026-11-26 도식 점검: 조직도 1,137px). 원고가 node_w를 정했으면 그 값을 하한으로 둔다
      if (cap0 < NW && typeof g.node_w !== "number") NW = Math.max(110, cap0);
      var cap = Math.max(NW, cap0);
      var skip = function (o) { return ownD && o.shape === "diamond"; };
      nodes.forEach(function (o) {
        if (!o.label && !o.sub) return;
        if (skip(o)) return;
        if (o.shape === "text") { NW = Math.max(NW, Math.min(cap, (textW(o.label, o.fs, false) + 2 * PADX) / o.wm)); return; }
        var nb = needBox(o, cap * o.wm, NH * o.hm);
        NW = Math.max(NW, Math.min(cap, nb.w / o.wm));
      });
      nodes.forEach(function (o) { // 정해진 폭에서 줄 수를 다시 세어 높이를 맞춘다
        if (o.shape === "text" || (!o.label && !o.sub) || skip(o)) return;
        var w = NW * o.wm, innerW = textRectW(o.shape, w, NH * o.hm) - 2 * PADX;
        var lines = breakLines(o.label, 14, true, innerW).length + (o.sub ? breakLines(o.sub, 12, false, innerW).length : 0);
        var hNeed = lines * 14 * LH + 2 * PADY;
        if (o.shape === "diamond") hNeed *= 2; else if (o.shape === "ellipse" || o.shape === "cloud") hNeed /= 0.707;
        NH = Math.max(NH, Math.min(240, Math.ceil(hNeed / o.hm)));
      });
      if (ownD) nodes.forEach(function (o) { if (skip(o) && (o.label || o.sub)) sizeDiamond(o); });
    }
    // 마름모 하나의 폭·높이 배율: 공통 상자(NW×NH)보다 폭 1.8배·높이 1.6배까지 키워 글이 들어가는 가장 작은 넓이를 고른다
    function sizeDiamond(o) {
      if (o._w0 == null) { o._w0 = o.wm; o._h0 = o.hm; }
      var best = null, last = null;
      for (var i = 0; i <= 8; i++) {
        var wm = o._w0 * (1 + i / 10), w = NW * wm;
        var innerW = textRectW("diamond", w, NH) - 2 * PADX;
        var lines = breakLines(o.label, 14, true, innerW).length + (o.sub ? breakLines(o.sub, 12, false, innerW).length : 0);
        var hm = Math.max(o._h0, (lines * 14 * LH + 2 * PADY) * 2 / NH);
        last = { wm: wm, hm: hm };
        if (hm <= o._h0 * 1.6 && (!best || wm * hm < best.wm * best.hm - 1e-6)) best = { wm: wm, hm: hm };
      }
      best = best || { wm: last.wm, hm: Math.min(last.hm, 240 / NH) };
      o.wm = best.wm; o.hm = best.hm;
    }
    var grid = nodes.some(function (o) { return o.row !== null && o.col !== null; });
    // 선 이름표가 상자 사이 간격에 들어가게 간격을 넓힌다(12px 글자 + 좌우 여유, 최대 150px) — 간격이 좁으면 이름표가 상자에 가려
    // 보이지 않았다(2026-11-13 사용자 지적: 밸류체인 도식의 '장비·SW 매입', '구축 후 장기 운영'). 가로선 이름표는 열 간격, 세로선 이름표는 행 간격
    function gapFor(es) { var w = 0; es.forEach(function (e) { if (e.label) w = Math.max(w, textW(e.label, 12, false) + 20); }); return Math.min(150, w); }
    if (grid) {
      var mr = 0; nodes.forEach(function (o) { if (o.row !== null) mr = Math.max(mr, o.row); });
      var extra = 0;
      nodes.forEach(function (o) { if (o.row === null || o.col === null) { o.row = mr + 1; o.col = extra++; } });
      var gf = gapFor(edges.filter(function (e) { return byId[e.from].row === byId[e.to].row; }));
      if (gf > 0) CG = Math.max(CG, gf); // 이름표가 없으면 원고 간격 그대로(단계 개요의 -8px 맞물림이 0으로 바뀌어 도식이 넓어지던 것)
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
        if (LR) CG = Math.max(CG, gapFor(fwd)); else if (fwd.some(function (e) { return e.label; })) RG = Math.max(RG, 64); // 갈래 끝 세로선(행 간격의 절반)에 이름표(18px)가 들어가게
        treeLayout(nodes, fwd, byId, LR, function (cols, extra) { autoSize(cols, false, extra); return { NW: NW, NH: NH }; }, CG, RG);
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
      var L = layers.length, ovW = 0, ovH = 0, lsz = [];
      var NW0 = NW, NH0 = NH;
      var measure = function (cols) {
        NW = NW0; NH = NH0; // 접기 전 좁은 폭에서 늘어난 높이가 남지 않게 처음 값에서 다시 잰다
        autoSize(cols, true);
        ovW = 0; ovH = 0;
        nodes.forEach(function (o) { o.w = NW * o.wm; o.h = NH * o.hm; ovW = Math.max(ovW, (o.w - NW) / 2); ovH = Math.max(ovH, (o.h - NH) / 2); });
        lsz = layers.map(function (ly) { return Math.max.apply(null, ly.map(function (o) { return LR ? o.w : o.h; })); });
      };
      measure(LR ? L : maxN);
      // 가로 흐름의 단이 많아 폭이 WMAX를 크게 넘으면 여러 줄로 접는다(뱀 모양 — 줄 끝에서 아래 줄 첫 단으로 내려감).
      // 한 줄로 두면 화면·Word 폭에 맞춰 줄이면서 글자가 7px 안팎으로 작아졌다(2026-11-24 하도급 흐름도: 6단, 폭 1,350px)
      var bands = [layers.map(function (ly, li) { return li; })];
      if (LR && g.wrap !== false && L >= 4) {
        var totW = lsz.reduce(function (a, b) { return a + b; }, 0) + CG * (L - 1);
        if (totW > WMAX * 1.25) {
          var nB = Math.ceil(totW / WMAX), K = Math.ceil(L / nB);
          measure(K);
          // 자르는 자리: 줄을 건너가는 선이 적은 자리를 고르되(갈라지는 선이 줄을 건너가면 읽기 어렵다), 줄 폭이 WMAX를 넘는 만큼 벌점
          layers.forEach(function (ly, li) { ly.forEach(function (o) { o._li = li; }); });
          var cross = function (c) { return fwd.filter(function (e) { return byId[e.from]._li < c && byId[e.to]._li >= c; }).length; };
          var wOf = function (i, j) { var w = 0; for (var q = i; q < j; q++) w += lsz[q]; return w + CG * (j - i - 1); };
          var memo = {};
          var best = function (i, k) { // 단 i부터 끝까지를 k줄로
            var key = i + "_" + k; if (memo[key]) return memo[key];
            var r = null;
            if (k === 1) r = { c: Math.max(0, wOf(i, L) - WMAX), cuts: [] };
            else if (L - i < 2 * k) r = { c: 1e9, cuts: [] };
            else for (var j = i + 2; j <= L - 2 * (k - 1); j++) { // 한 줄에 단 둘 이상(한 상자만 덩그러니 남은 줄은 흐름이 끊겨 보임)
              var rest = best(j, k - 1), c = Math.max(0, wOf(i, j) - WMAX) + cross(j) * 150 + rest.c;
              if (!r || c < r.c) r = { c: c, cuts: [j].concat(rest.cuts) };
            }
            return (memo[key] = r);
          };
          var cuts = best(0, nB).cuts.concat([L]), st = 0;
          bands = cuts.map(function (c) { var bl = []; for (var q = st; q < c; q++) bl.push(q); st = c; return bl; });
        }
      }
      // 위→아래 흐름의 단이 많아 도식이 길쭉하면 여러 열로 접는다(열 끝 상자 오른쪽에서 열 사이 빈칸을 올라가 다음 열 첫 상자 위로) —
      // 10단 흐름도가 454×1,114px로 그려져 Word에서 글자가 4~5pt가 됐다(2026-11-26 도식 점검). 열 수는 Word 폭·높이에 넣었을 때 글자가
      // 가장 커지는 수(2~4열). 끄기 "wrap": false
      if (!LR && g.wrap !== false && L >= 5) {
        var HMAX = 560, sumH = function () { return lsz.reduce(function (a, b) { return a + b; }, 0) + RG * (L - 1); }, totH = sumH();
        if (totH > HMAX * 1.25) {
          layers.forEach(function (ly, li) { ly.forEach(function (o) { o._li = li; }); });
          var crossT = function (c) { return fwd.filter(function (e) { return byId[e.from]._li < c && byId[e.to]._li >= c; }).length; };
          var hOf = function (i, j) { var h = 0; for (var q = i; q < j; q++) h += lsz[q]; return h + RG * (j - i - 1); };
          var colW = maxN * (NW + CG) - CG, bestB = null;
          var sc1 = fitScore(colW + 32, totH + 32);
          for (var nb2 = 2; nb2 <= 4 && nb2 * 2 <= L; nb2++) {
            measure(maxN * nb2); // 열이 늘면 상자 폭 상한이 좁아진다(긴 글은 두 줄로)
            totH = sumH(); colW = maxN * (NW + CG) - CG;
            var lim = Math.max(HMAX * 0.6, totH / nb2 * 1.08), memoT = {};
            var bestT = function (i, k) {
              var key = i + "_" + k; if (memoT[key]) return memoT[key];
              var r = null;
              if (k === 1) r = { c: Math.max(0, hOf(i, L) - lim), mx: hOf(i, L), cuts: [] };
              else if (L - i < 2 * k) r = { c: 1e9, mx: 0, cuts: [] };
              else for (var j = i + 2; j <= L - 2 * (k - 1); j++) {
                var rest = bestT(j, k - 1), c = Math.max(0, hOf(i, j) - lim) + crossT(j) * 150 + rest.c;
                if (!r || c < r.c) r = { c: c, mx: Math.max(hOf(i, j), rest.mx), cuts: [j].concat(rest.cuts) };
              }
              return (memoT[key] = r);
            };
            var rT = bestT(0, nb2), Wn = nb2 * colW + (nb2 - 1) * (CG + 60), sc = fitScore(Wn + 32, rT.mx + 32) - rT.c / 1e5;
            if (!bestB || sc > bestB.sc) bestB = { sc: sc, cuts: rT.cuts, n: nb2 };
          }
          var useB = bestB && sc1 < 0.9 && bestB.sc > sc1 * 1.15;
          measure(useB ? maxN * bestB.n : maxN);
          if (useB) {
            var cutsT = bestB.cuts.concat([L]), stT = 0;
            bands = cutsT.map(function (c) { var bl = []; for (var q = stT; q < c; q++) bl.push(q); stT = c; return bl; });
          }
        }
      }
      var RGc = LR && ovH > 0 ? Math.max(RG, 2 * ovH + 12) : RG, CGc = !LR && ovW > 0 ? Math.max(CG, 2 * ovW + 12) : CG;
      var crossLbl = bands.length > 1 && edges.some(function (e) { return e.label; });
      var bandGap = crossLbl ? Math.max(44, 12 * LH + 30) : 40, y0 = 0, x0 = 0, bandBottom = [], bandRight = [], colGap = Math.max(CG, 30) + 40;
      if (!LR && bands.length > 1) { // 열 사이를 지나는 선이 여럿이고 이름표가 있으면 통로마다 이름표 폭만큼 열 간격을 넓힌다
        var bIdx = function (o) { for (var q = 0; q < bands.length; q++) if (bands[q].indexOf(o.layer) >= 0) return q; return 0; };
        var sp0 = 10; edges.forEach(function (e) { if (e.label) sp0 = Math.max(sp0, Math.min(70, textW(e.label, 12, false) + 20)); });
        var cnt0 = {}; fwd.forEach(function (e) { var ba = bIdx(byId[e.from]), bb = bIdx(byId[e.to]); if (bb > ba) cnt0[bb] = (cnt0[bb] || 0) + 1; });
        var mx0 = 0; Object.keys(cnt0).forEach(function (k) { mx0 = Math.max(mx0, cnt0[k]); });
        colGap += Math.max(0, mx0 - 1) * sp0;
      }
      bands.forEach(function (bl, bi) {
        var bMax = bl.reduce(function (m, li) { return Math.max(m, layers[li].length); }, 0), cur = 0, bot = -Infinity, rgt = -Infinity;
        bl.forEach(function (li) {
          var ly = layers[li], span = (LR || bands.length > 1 ? bMax : maxN) - ly.length;
          ly.forEach(function (o, k) {
            var along = (k + span / 2);
            o._band = bi;
            if (LR) { o.x = cur + (lsz[li] - o.w) / 2; o.y = y0 + along * (NH + RGc) + (NH - o.h) / 2; }
            else { o.x = x0 + along * (NW + CGc) + (NW - o.w) / 2; o.y = cur + (lsz[li] - o.h) / 2; }
            bot = Math.max(bot, o.y + o.h); rgt = Math.max(rgt, o.x + o.w);
          });
          cur += lsz[li] + (LR ? CG : RG);
        });
        bandBottom[bi] = bot; bandRight[bi] = rgt;
        y0 = bot + bandGap + ovH;
        x0 = rgt + colGap;
      });
      // 세로 흐름을 열로 접었을 때 열을 건너가는 선: 출발 상자 오른쪽 → 열 사이 빈칸 → 도착 상자 위(위에 다른 상자가 있으면 왼쪽)
      // 같은 열 사이 빈칸을 지나는 선이 여럿이면 통로를 10px씩 나누고(같은 세로선을 함께 쓰면 어느 선이 어디로 가는지 읽히지 않았다 —
      // 2026-11-26 도식 점검), 도착 상자 위 가로선 높이도 선마다 다르게 한다
      var crossIdx = {}, chSp = 10;
      edges.forEach(function (e) { if (e.label) chSp = Math.max(chSp, Math.min(70, textW(e.label, 12, false) + 20)); }); // 통로 사이에 이름표가 들어가게
      var crossN = {}; if (!LR && bands.length > 1) edges.forEach(function (e) { var a = byId[e.from], b = byId[e.to]; if (!e.back && b._band > a._band) crossN[b._band] = (crossN[b._band] || 0) + 1; });
      if (!LR && bands.length > 1) edges.forEach(function (e) {
        var a = byId[e.from], b = byId[e.to];
        if (e.back || a._band === b._band || b._band < a._band) return;
        var ci = crossIdx[b._band] = (crossIdx[b._band] == null ? 0 : crossIdx[b._band] + 1), cn = crossN[b._band] || 1;
        var acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2, gx = bandRight[b._band - 1] + colGap / 2 + (ci - (cn - 1) / 2) * chSp, gy = b.y - Math.max(14, RG / 2) + (ci - (cn - 1) / 2) * 6;
        var blocked = nodes.some(function (o) { return o !== b && o._band === b._band && o.y < b.y && o.x < bcx && o.x + o.w > bcx; });
        e.pts = blocked ? [[a.x + a.w, acy], [gx, acy], [gx, bcy], [b.x, bcy]] : [[a.x + a.w, acy], [gx, acy], [gx, gy], [bcx, gy], [bcx, b.y]];
        e.lblMin = blocked ? 2 : 3;
        e.banded = true;
      });
      // 줄을 건너가는 선: 출발 상자 오른쪽 열 간격으로 내려와 줄 사이 빈칸을 지나 도착 상자 위로 들어간다
      if (LR && bands.length > 1) edges.forEach(function (e) {
        var a = byId[e.from], b = byId[e.to];
        if (e.back || a._band === b._band) return;
        var acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
        if (b._band > a._band) {
          var gx = a.x + a.w + CG / 2, gy = bandBottom[a._band] + bandGap / 2;
          // 도착 상자 위에 같은 줄의 다른 상자가 있으면 위로 들어가지 못하므로 왼쪽 열 간격으로 내려가 옆으로 들어간다
          var blocked = nodes.some(function (o) { return o !== b && o._band === b._band && o.y < b.y && o.x < bcx && o.x + o.w > bcx; });
          // 왼쪽 열 간격 가운데는 앞 단 상자에서 갈라지는 선이 쓰므로 도착 상자 쪽으로 붙여 내려 두 선이 겹치지 않게 한다
          var ex = b.x - Math.max(12, CG / 4);
          e.pts = blocked ? [[a.x + a.w, acy], [gx, acy], [gx, gy], [ex, gy], [ex, bcy], [b.x, bcy]]
            : [[a.x + a.w, acy], [gx, acy], [gx, gy], [bcx, gy], [bcx, b.y]];
          // 같은 상자에서 나간 선끼리는 줄 사이 빈칸까지 같은 길을 쓰므로, 이름표는 갈라진 뒤 구간에만 단다
          // (공유 구간에 달면 '유형자산' 이름표가 '투자부동산' 갈래 앞에 붙어 뜻이 뒤바뀌어 보였다)
          e.lblMin = 3;
        }
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
    // 선이 두 끝 상자 말고 다른 상자를 지나가면(여러 단을 건너뛰는 선 — 예: 판단 '예'가 두 단 아래 상자로) 옆 통로로 돌린다:
    // 출발 상자 아래(LR이면 오른쪽) 간격 → 막는 상자들의 바깥 통로 → 도착 상자 위(왼쪽) 간격. 왼쪽·오른쪽(위·아래) 중 짧은 쪽,
    // 그래도 막히면 그대로 둔다(2026-11-26 도식 점검: '예산 범위 이내?' → '부서장 승인' 선이 '재무 검토' 상자 한가운데를 지나감)
    var through = function (P, a, b) {
      return nodes.some(function (o) {
        if (o === a || o === b) return false;
        var r = [o.x + 2, o.y + 2, o.x + o.w - 2, o.y + o.h - 2];
        for (var i = 1; i < P.length; i++) if (segHit(P[i - 1], P[i], r)) return true;
        return false;
      });
    };
    var detour = function (P, a, b, LR) {
      if (!through(P, a, b)) return null;
      var blk = nodes.filter(function (o) { return o !== a && o !== b && (LR ? o.x < b.x && o.x + o.w > a.x + a.w : o.y < b.y && o.y + o.h > a.y + a.h); });
      if (!blk.length) return null;
      var res = null;
      if (!LR) {
        var ax = a.x + a.w / 2, bx = b.x + b.w / 2, y1 = a.y + a.h + Math.max(10, RG / 2 - 6), y2 = b.y - Math.max(10, RG / 2 - 6);
        if (!(b.y > a.y + a.h)) return null;
        // 옆으로 나가는 길(판단 상자의 예/아니오가 서로 다른 꼭짓점에서 나가게)을 먼저, 막히면 아래로 나가 옆 통로로
        var acy2 = a.y + a.h / 2, cxs = [Math.min.apply(null, blk.map(function (o) { return o.x; })) - Math.max(14, CG / 2), Math.max.apply(null, blk.map(function (o) { return o.x + o.w; })) + Math.max(14, CG / 2)];
        cxs.sort(function (p, q) { return Math.abs(p - ax) + Math.abs(p - bx) - Math.abs(q - ax) - Math.abs(q - bx); });
        var cands = cxs.map(function (cx) { return [[cx < ax ? a.x : a.x + a.w, acy2], [cx, acy2], [cx, y2], [bx, y2], [bx, b.y]]; })
          .concat(cxs.map(function (cx) { return [[ax, a.y + a.h], [ax, y1], [cx, y1], [cx, y2], [bx, y2], [bx, b.y]]; }));
        cands.some(function (Q) { if ((Q[0][0] < Q[1][0]) === (Q[1][0] > ax) && !through(Q, a, b)) { res = Q; return true; } return false; });
      } else {
        var ay = a.y + a.h / 2, by = b.y + b.h / 2, x1 = a.x + a.w + Math.max(10, CG / 2 - 6), x2 = b.x - Math.max(10, CG / 2 - 6);
        if (!(b.x > a.x + a.w)) return null;
        var acx2 = a.x + a.w / 2, cys = [Math.min.apply(null, blk.map(function (o) { return o.y; })) - Math.max(14, RG / 2), Math.max.apply(null, blk.map(function (o) { return o.y + o.h; })) + Math.max(14, RG / 2)];
        cys.sort(function (p, q) { return Math.abs(p - ay) + Math.abs(p - by) - Math.abs(q - ay) - Math.abs(q - by); });
        var cands2 = cys.map(function (cy) { return [[acx2, cy < ay ? a.y : a.y + a.h], [acx2, cy], [x2, cy], [x2, by], [b.x, by]]; })
          .concat(cys.map(function (cy) { return [[a.x + a.w, ay], [x1, ay], [x1, cy], [x2, cy], [x2, by], [b.x, by]]; }));
        cands2.some(function (Q) { if ((Q[0][1] < Q[1][1]) === (Q[1][1] > ay) && !through(Q, a, b)) { res = Q; return true; } return false; });
      }
      return res;
    };
    var lines = edges.map(function (e) {
      var a = byId[e.from], b = byId[e.to];
      if (e.pts || e.back) {
        var P2;
        if (e.pts) P2 = e.pts.map(function (p) { return [p[0] + dx, p[1] + dy]; });
        else if (!LR && a._band != null && nodes.some(function (o) { return o._band > 0; })) {
          if (a._band === b._band) P2 = backRoute(a, b, bbox(nodes.filter(function (o) { return o._band === a._band; })), LR, backK++);
          else { // 앞 열로 되돌아감: 출발 상자 위 → 도식 위 빈칸 → 도착 열 바깥 왼쪽 → 도착 상자 왼쪽(도착 상자 위로 내려오면 그 위 상자를 지나갔다)
            var k2 = backK++, yt = nb[1] - Math.max(14, RG / 2) - 22 - k2 * 14, bm = Math.min.apply(null, nodes.filter(function (o) { return o._band === b._band; }).map(function (o) { return o.x; }));
            // 도착 상자 바로 왼쪽으로 내려올 수 있으면 그 자리(도식이 넓어지지 않게), 막히면 그 열 바깥
            var mkP = function (xl) { return [[a.x + a.w / 2, a.y], [a.x + a.w / 2, yt], [xl, yt], [xl, b.y + b.h / 2], [b.x, b.y + b.h / 2]]; };
            var clear = function (P) { return !nodes.some(function (o) { if (o === a || o === b) return false; var r = [o.x - 2, o.y - 2, o.x + o.w + 2, o.y + o.h + 2]; for (var i = 1; i < P.length; i++) if (segHit(P[i - 1], P[i], r)) return true; return false; }); };
            P2 = [b.x - 16 - k2 * 10, bm - 24 - k2 * 14].map(mkP).filter(clear)[0] || mkP(bm - 24 - k2 * 14);
          }
        } else P2 = backRoute(a, b, nb, LR, backK++);
        var q0 = P2[Math.floor((P2.length - 1) / 2)], q1 = P2[Math.floor((P2.length - 1) / 2) + 1] || q0;
        return { pts: P2, label: e.label, dashed: e.dashed, arrow: e.arrow, lx: (q0[0] + q1[0]) / 2, ly: (q0[1] + q1[1]) / 2, _pref: e.pts ? P2.length - 2 : Math.floor((P2.length - 1) / 2), _min: e.lblMin };
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
      pts = detour(pts, a, b, LR) || pts;
      // 이름표: 한 상자에서 여러 선이 나가면 갈라진 뒤(마지막 구간)에, 아니면 첫 구간에 단다
      var fan = edges.filter(function (x) { return x.from === e.from; }).length > 1;
      var p0 = fan ? pts[pts.length - 2] : pts[0], p1 = fan ? pts[pts.length - 1] : pts[1];
      return { pts: pts, label: e.label, dashed: e.dashed, arrow: e.arrow, lx: (p0[0] + p1[0]) / 2, ly: (p0[1] + p1[1]) / 2, _pref: fan ? pts.length - 2 : 0 };
    });
    spreadEntries(lines, nodes);
    placeLabels(lines, nodes, groups);
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
      o.lines = balanceLines(o.label, o.fs || 14, true, iw);
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
  // 줄을 직접 나눠 둔다(o.lines·o.subLines — 고른 줄 나눔). 글이 한 줄이면 두지 않는다. 폭은 실제 글상자보다 4% 좁게 잡아
  // 렌더러가 다시 줄을 바꾸지 않게 한다(한글은 추정 폭 = 맑은 고딕 실제 폭이라 여유가 없다)
  function setLines(o) {
    if (o.noFit || (!o.label && !o.sub)) { if (o.noFit && (o.shape === "chevron" || o.shape === "homePlate")) delete o.lines; return; }
    var bold = o.bold != null ? o.bold : o.shape !== "text", tr = o.tr || textRect(o);
    var iw = (o.shape === "text" ? o.w - 2 * PADX : tr.w - 6) * 0.96;
    if (iw <= 10) return;
    var fs = o.fs || 14, sfs = Math.min(o.subFs || 12, fs);
    if (o.label) { var ls = balanceLines(o.label, fs, bold, iw); if (ls.length > 1 || o.shape === "chevron" || o.shape === "homePlate") o.lines = ls; else delete o.lines; }
    if (o.sub) { var ss = balanceLines(o.sub, sfs, false, iw); if (ss.length > 1) o.subLines = ss; else delete o.subLines; }
  }
  function finish(lay, spec, fromGraph) {
    lay.nodes = lay.nodes || []; lay.groups = lay.groups || []; lay.lines = lay.lines || [];
    lay.nodes.forEach(function (o) { o.path = o.path || geomPath(o); o.tr = o.tr || textRect(o); });
    lay.groups.forEach(function (r) { r.kind = r.kind || "box"; r.path = r.path || poly([[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]); });
    if (!fromGraph) lay.nodes.forEach(fitNode);
    lay.nodes.forEach(setLines);
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
    var SG = 10, memo = {};
    var SIof = function (o) { return (kids[o.id] || []).reduce(function (m, c) { var e = edges.filter(function (x) { return x.from === o.id && x.to === c.id; })[0]; return e && e.label ? Math.max(m, Math.min(186, textW(e.label, 12, false) + 36)) : m; }, 22); };
    var SC = function (o) { var nk = (kids[o.id] || []).length; return nk >= 6 ? Math.min(3, Math.ceil(nk / 5)) : 1; }, SCG = 18;
    var cols = 0, extraW = 0;
    // 쌓인 자식 들여쓰기(SIof)와 열 사이(SCG)도 도식 폭을 차지하므로 상자 폭 상한을 정할 때 뺀다 — 빼지 않으면 조직도가 880px을 넘어
    // Word 폭에서 글자가 7pt 아래로 작아졌다(2026-11-26 도식 점검)
    nodes.forEach(function (o) { if (stack[o.id]) { cols += SC(o); extraW += SC(o) * SIof(o) + (SC(o) - 1) * SCG; } else if (isLeaf(o) && !stack[parent[o.id]]) cols += 1; });
    var maxD = 0; nodes.forEach(function (o) { maxD = Math.max(maxD, depthOf[o.id] || 0); });
    var sz = sizeFn(LR ? maxD + 1 : Math.max(1, cols), LR ? 0 : extraW);
    var NW = sz.NW, NH = sz.NH;
    nodes.forEach(function (o) { o.w = NW * o.wm; o.h = NH * o.hm; });
    var B = function (o) { return LR ? o.h : o.w; };
    var gapB = LR ? Math.max(14, RG * 0.45) : Math.max(18, CG * 0.6), stepD = LR ? NW + CG : NH + RG;
    // 쌓인 자식 들여쓰기(SIof): 선 이름표(지분율 등)가 세로 줄기와 자식 상자 사이 가로 선에 들어가게 이름표 폭만큼 넓힌다 —
    // 22px 고정이면 이름표가 자식 상자 글을 덮거나 줄기 왼쪽에 몰려 어느 자식의 것인지 읽히지 않았다(2026-11-26 도식 점검)
    // 쌓는 자식이 6개 이상이면 5개씩 여러 열로 쌓는다(SC — 열마다 세로 줄기, 부모 아래 가로선으로 이어짐). 한 열에 8개를 쌓으면
    // 도식이 길쭉해져(지분 구조 자회사 8개: 429×812px) PPT 16:9 슬라이드에서 글자가 6pt로 작아졌다(2026-11-26 도식 점검)
    var width = function (o) {
      if (memo[o.id] != null) return memo[o.id];
      var k = kids[o.id] || [], wv;
      if (!k.length) wv = B(o);
      else if (stack[o.id]) wv = Math.max(B(o), SC(o) * (SIof(o) + Math.max.apply(null, k.map(B))) + (SC(o) - 1) * SCG);
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
        var si = SIof(o), nc = SC(o), per = Math.ceil(k.length / nc), cw = si + Math.max.apply(null, k.map(B)) + SCG, y00 = yy;
        k.forEach(function (c, ci) {
          if (ci && ci % per === 0) yy = y00;
          var col = Math.floor(ci / per);
          pos[c.id] = { b: left + col * cw + si, d: yy, col: col, rail: left + col * cw + 12 }; yy += c.h + SG;
        });
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
      if (stack[a.id]) {
        var rx = a.x + 12, p = pos[c.id] || {};
        if (!p.col) { e.pts = [[rx, a.y + a.h], [rx, c.y + c.h / 2], [c.x, c.y + c.h / 2]]; return; }
        var busY = a.y + a.h + 7, rj = c.x - (SIof(a) - 12); // 둘째 열부터: 부모 아래 가로선 → 그 열 줄기
        e.pts = [[rx, a.y + a.h], [rx, busY], [rj, busY], [rj, c.y + c.h / 2], [c.x, c.y + c.h / 2]];
        return;
      }
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
  // 가로 흐름이면 정방향 선이 상자 가운데로 드나들므로 상자 폭 3/4 자리에서 나가 1/4 자리로 들어간다(같은 세로줄을 정방향 선과 겹쳐 쓰던 것 — 2026-11-26 도식 점검)
  function backRoute(a, b, nb, LR, k) {
    var off = 24 + k * 14;
    if (LR) { var yb = nb[3] + off, ax0 = a.x + a.w * 0.72, bx0 = b.x + b.w * 0.28; return [[ax0, a.y + a.h], [ax0, yb], [bx0, yb], [bx0, b.y + b.h]]; }
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
  // 선분이 사각형 [x0,y0,x1,y1]을 지나는가(Liang–Barsky)
  function segHit(a, b, r) {
    var t0 = 0, t1 = 1, dx = b[0] - a[0], dy = b[1] - a[1];
    var p = [-dx, dx, -dy, dy], q = [a[0] - r[0], r[2] - a[0], a[1] - r[1], r[3] - a[1]];
    for (var i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return false; }
      else { var t = q[i] / p[i]; if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; } }
    }
    return t0 < t1;
  }
  // 한 상자의 같은 점으로 들어오는 선이 둘 이상이면 그 변 위에서 들어가는 자리를 나눈다(들어오는 순서대로 1/(n+1) 간격) —
  // 같은 점·같은 마지막 구간을 여러 선이 함께 쓰면 화살표가 하나로 보이고 이름표('예'·'아니오')가 한데 몰렸다(2026-11-26 사용자 지적)
  function spreadEntries(lines, nodes) {
    var groupsE = {};
    lines.forEach(function (ln) { var e = ln.pts[ln.pts.length - 1]; var key = Math.round(e[0]) + "_" + Math.round(e[1]); (groupsE[key] = groupsE[key] || []).push(ln); });
    Object.keys(groupsE).forEach(function (key) {
      var ls = groupsE[key]; if (ls.length < 2) return;
      var e = ls[0].pts[ls[0].pts.length - 1];
      var o = nodes.filter(function (q) { return e[0] >= q.x - 1 && e[0] <= q.x + q.w + 1 && e[1] >= q.y - 1 && e[1] <= q.y + q.h + 1; })[0];
      if (!o) return;
      var vert = ls.every(function (ln) { var P = ln.pts, a = P[P.length - 2], b = P[P.length - 1]; return Math.abs(a[0] - b[0]) < 1; });
      var horz = ls.every(function (ln) { var P = ln.pts, a = P[P.length - 2], b = P[P.length - 1]; return Math.abs(a[1] - b[1]) < 1; });
      if (!vert && !horz) return;
      // 들어오는 쪽 순서(앞 꼭짓점 위치)대로 나눠 선이 서로 엇갈리지 않게
      var from = function (ln) { var P = ln.pts; return P.length > 2 ? P[P.length - 3] : P[0]; };
      ls.sort(function (p, q) { return vert ? from(p)[0] - from(q)[0] : from(p)[1] - from(q)[1]; });
      var span = vert ? o.w * 0.6 : o.h * 0.6, start = vert ? o.x + o.w / 2 - span / 2 : o.y + o.h / 2 - span / 2;
      ls.forEach(function (ln, i) {
        var P = ln.pts, n2 = P.length, v = start + span * (i + 0.5) / ls.length, a = P[n2 - 2], b = P[n2 - 1];
        if (vert) {
          if (n2 > 2 && Math.abs(P[n2 - 3][1] - a[1]) < 1) { a[0] = v; b[0] = v; } // 앞 구간이 가로선이면 꼭짓점을 옮긴다
          else { var my = (a[1] + b[1]) / 2; P.splice(n2 - 1, 1, [a[0], my], [v, my], [v, b[1]]); }
        } else {
          if (n2 > 2 && Math.abs(P[n2 - 3][0] - a[0]) < 1) { a[1] = v; b[1] = v; }
          else { var mx = (a[0] + b[0]) / 2; P.splice(n2 - 1, 1, [mx, a[1]], [mx, v], [b[0], v]); }
        }
      });
    });
  }
  // 선 이름표 자리(2026-11-26 사용자 지정):
  // ① 선 길이의 한가운데에 가장 가까운 자리부터 찾는다. 다른 선과 함께 쓰는 구간(갈라지는 선의 줄기·버스)과 화살촉 근처는 빼고,
  //    상자(글 상자 포함)·묶음 이름·다른 이름표를 가리지 않는 자리만 쓴다.
  // ② 배경이 흰색이면 흰 바탕 이름표를 선 위에 얹는다 — 이름표가 꺾인 모서리에 걸치지 않게 곧은 구간 안에서만.
  // ③ 배경이 흰색이 아니면(스윔레인 레인·층·묶음 상자) 흰 바탕이 어색하므로 바탕 없이 선 옆에 쓴다 — 가로선은 위(안 되면 아래),
  //    세로선은 오른쪽(안 되면 왼쪽). 이름표가 어느 선에도 닿지 않아야 한다. 결과: ln.lx·ly(가운데), ln.lnofill(바탕 없음)
  function placeLabels(lines, nodes, groups) {
    groups = groups || [];
    var taken = [];
    var white = function (c) { return c == null || /^#?F{6}$/i.test(String(c)); };
    // 이름표 칸이 걸치는 모든 묶음(레인·층·묶음 상자)의 바탕이 흰색인가 — 흰 레인과 회색 레인 경계에 걸친 흰 바탕 이름표도 어색했다
    var bgWhite = function (r) {
      return groups.every(function (g) {
        if (!(r[0] < g.x + g.w && r[2] > g.x && r[1] < g.y + g.h && r[3] > g.y)) return true;
        return g.fill === null || white(g.fill == null ? "F7F9FC" : g.fill);
      });
    };
    var gLabels = groups.filter(function (r) { return r.label; }).map(function (r) { return [r.x, r.y, r.x + textW(r.label, 13, true) + 16, r.y + 22]; });
    var ov = function (r, t, m) { m = m || 0; return r[0] < t[2] + m && r[2] > t[0] - m && r[1] < t[3] + m && r[3] > t[1] - m; };
    var segsHit = function (ln, r, skip) {
      for (var i = 1; i < ln.pts.length; i++) if (i - 1 !== skip && segHit(ln.pts[i - 1], ln.pts[i], r)) return true;
      return false;
    };
    var blocked = function (r) {
      return nodes.some(function (o) { return (o.label || o.sub || o.shape !== "text") && ov(r, [o.x, o.y, o.x + o.w, o.y + o.h], 2); }) ||
        taken.some(function (t) { return ov(r, t, 2); }) || gLabels.some(function (t) { return ov(r, t, 2); });
    };
    var shared = function (ln, p) { // 다른 선이 같은 자리를 지나는가
      return lines.some(function (o) {
        if (o === ln) return false;
        for (var i = 1; i < o.pts.length; i++) {
          var a = o.pts[i - 1], b = o.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
          if (Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) < 2) return true;
        }
        return false;
      });
    };
    lines.forEach(function (ln) {
      if (!ln.label) return;
      var lw = textW(ln.label, 12, false) + 8, lh = 18, P = ln.pts, segLen = [], tot = 0;
      for (var i = 0; i < P.length - 1; i++) { var d = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]); segLen.push(d); tot += d; }
      // 선을 따라 4px마다 후보 점(한가운데에 가까운 순)
      var cands = [], acc = 0;
      for (var k = 0; k < segLen.length; k++) {
        if (ln._min > 0 && k < ln._min) { acc += segLen[k]; continue; }
        for (var s0 = 0; s0 <= segLen[k]; s0 += 4) {
          var sAll = acc + s0, t = segLen[k] ? s0 / segLen[k] : 0;
          if (sAll < 8 || tot - sAll < 14) continue; // 선 시작·화살촉 근처는 빼다
          cands.push({ k: k, x: P[k][0] + (P[k + 1][0] - P[k][0]) * t, y: P[k][1] + (P[k + 1][1] - P[k][1]) * t, d: Math.abs(sAll - tot / 2), hz: Math.abs(P[k + 1][1] - P[k][1]) < 1 });
        }
        acc += segLen[k];
      }
      // 다른 선과 출발점을 함께 쓰는 갈래(조직도·지분 구조·판단 분기)는 전체 길이 가운데가 함께 쓰는 줄기·버스에 걸려 어느 갈래의
      // 이름표인지 모호했다 — 그 갈래만의 마지막 곧은 구간 가운데를 기준으로 한다(2026-11-26 사용자 지적)
      var fan = lines.some(function (o) { return o !== ln && Math.hypot(o.pts[0][0] - P[0][0], o.pts[0][1] - P[0][1]) < 3; });
      if (fan && P.length > 2) {
        var lastK = P.length - 2, accL = 0; for (var q0 = 0; q0 < lastK; q0++) accL += segLen[q0];
        var mid = accL + segLen[lastK] / 2;
        cands.forEach(function (c) { var sA = 0; for (var q1 = 0; q1 < c.k; q1++) sA += segLen[q1]; sA += Math.hypot(c.x - P[c.k][0], c.y - P[c.k][1]); c.d = Math.abs(sA - mid) + (c.k === lastK ? 0 : 1000); });
      }
      cands.sort(function (p, q) { return p.d - q.d; });
      var best = null;
      var tryOn = function (c) { // 흰 바탕 이름표를 선 위에(곧은 구간 안, 양쪽으로 선이 8px 이상 보이게 — 짧은 세로선을 통째로 덮으면 화살표가 사라졌다)
        var a = P[c.k], b = P[c.k + 1], half = c.hz ? lw / 2 : lh / 2, along = c.hz ? [Math.min(a[0], b[0]), Math.max(a[0], b[0]), c.x] : [Math.min(a[1], b[1]), Math.max(a[1], b[1]), c.y];
        var endHead = c.k === P.length - 2 ? 14 : 0, toB = c.hz ? Math.abs(b[0] - c.x) : Math.abs(b[1] - c.y);
        if (along[2] - half < along[0] + 8 || along[2] + half > along[1] - 8 || toB - half < endHead + 8) return null;
        var r = [c.x - lw / 2, c.y - lh / 2, c.x + lw / 2, c.y + lh / 2], inner = [r[0] + 1, r[1] + 1, r[2] - 1, r[3] - 1];
        if (blocked(r) || segsHit(ln, inner, c.k) || lines.some(function (o) { return o !== ln && segsHit(o, inner, -1); })) return null;
        return { x: c.x, y: c.y, r: r, nofill: false };
      };
      var trySide = function (c) { // 바탕 없이 선 옆에
        var opts = c.hz ? [[c.x - lw / 2, c.y - 3 - lh], [c.x - lw / 2, c.y + 3]] : [[c.x + 4, c.y - lh / 2], [c.x - 4 - lw, c.y - lh / 2]];
        for (var q = 0; q < opts.length; q++) {
          var r = [opts[q][0], opts[q][1], opts[q][0] + lw, opts[q][1] + lh];
          if (blocked(r) || lines.some(function (o) { return segsHit(o, r, -1); })) continue;
          return { x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2, r: r, nofill: true };
        }
        return null;
      };
      // 다른 선과 함께 쓰지 않는 자리를 먼저, 그다음 함께 쓰는 자리
      [false, true].some(function (allowShared) {
        return cands.some(function (c) {
          if (!allowShared && shared(ln, [c.x, c.y])) return false;
          best = bgWhite([c.x - lw / 2, c.y - lh / 2, c.x + lw / 2, c.y + lh / 2]) ? (tryOn(c) || trySide(c)) : trySide(c);
          return !!best;
        });
      });
      if (!best) { // 둘 다 막히면 한가운데에 흰 바탕으로(마지막 수단)
        var c0 = cands[0] || { x: (P[0][0] + P[P.length - 1][0]) / 2, y: (P[0][1] + P[P.length - 1][1]) / 2 };
        best = { x: c0.x, y: c0.y, r: [c0.x - lw / 2, c0.y - lh / 2, c0.x + lw / 2, c0.y + lh / 2], nofill: false };
      }
      ln.lx = best.x; ln.ly = best.y; ln.lnofill = best.nofill || undefined;
      taken.push(best.r);
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
    // 목록 칸(SWOT·칸 나누기·비교·로드맵 본문 — 줄바꿈으로 이은 항목들)은 120자에서 자르지 않는다: 항목이 길면 마지막 항목이
    // 중간에서 잘려 "빠른 의사결정 시스템 연동 및"처럼 끝났다(2026-11-26 도식 점검)
    var r = { id: str(o.id != null ? o.id : "n" + Math.random().toString(36).slice(2, 8), 40), label: str(o.label, /\n/.test(String(o.label || "")) ? 3000 : 120), sub: str(o.sub, 200), shape: o.shape || "roundRect",
      style: o.style || "default", x: o.x, y: o.y, w: o.w, h: o.h, fs: o.fs || 14, wm: 1, hm: 1, group: "" };
    ["fill", "line", "color", "subColor", "alpha", "align", "valign", "inset", "insetB", "fsFixed", "noFit", "bold", "minFs", "subFs", "role", "paraGap"].forEach(function (k) { if (o[k] !== undefined) r[k] = o[k]; });
    return r;
  }
  function boxFor(label, sub, maxW, minW, fs) { // 글자에 맞춘 상자 크기
    fs = fs || 14;
    var w = Math.max(minW || 90, Math.min(maxW, Math.max(textW(label, fs, true), sub ? textW(sub, 12, false) : 0) + 2 * PADX + 8));
    var iw = w - 2 * PADX - 4, lines = breakLines(label, fs, true, iw).length + (sub ? breakLines(sub, 12, false, iw).length : 0);
    return { w: Math.ceil(w), h: Math.ceil(Math.max(46, lines * fs * LH + 2 * PADY + 8)) };
  }
  // 목록 칸(SWOT·칸 나누기·비교·로드맵 본문): 글 13px, 글머리 사이 6px, 칸 안 세로 가운데(2026-11-26 사용자 지정 — 14px에 간격 없이
  // 위에 붙여 쓰면 답답했다). 높이 = 항목별 줄 수 × 줄 높이 + 항목 사이 간격 + 위아래 여백. w는 칸 폭(px) — 글머리 내어쓰기·여백을 뺀다
  var LIST_FS = 13, LIST_GAP = 6;
  function listText(items) { return (items || []).map(function (q) { return "• " + (typeof q === "string" ? q : (q && q.label) || ""); }).join("\n"); }
  function listH(text, w) {
    var its = String(text || "").split("\n").filter(function (t) { return t; });
    if (!its.length) return 0;
    return its.reduce(function (h, t) { return h + breakLines(t.replace(/^• /, ""), LIST_FS, false, w - 28).length * LIST_FS * 1.36; }, 0) + (its.length - 1) * LIST_GAP + 20;
  }
  function listNode(o) { return mk(Object.assign({ shape: "rect", color: "262626", align: "left", valign: "middle", bold: false, fs: LIST_FS, fsFixed: true, noFit: true, paraGap: LIST_GAP }, o)); }
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
    var NW, NH, lblW, CG, RG, HW, HH;
    var sizes = function () {
      // 짧은 이름(구매 요청·검수)이면 상자를 작게 — 단계가 많은 스윔레인이 Word 폭에 들어가게(2026-11-26, 120×52 → 100×46).
      // 판단 마름모가 있으면 글 칸이 폭·높이의 절반이라 전처럼 120×52(작게 하면 Word 도형에서 '승인?'이 넘쳐 그림으로 넣었다)
      var hasD = nodes.some(function (o) { return o.shape === "diamond"; });
      NW = hasD ? 120 : 100; NH = hasD ? 52 : 46;
      nodes.forEach(function (o) { var b = boxFor(o.label, o.sub, LR ? 170 : 160, 96); NW = Math.max(NW, b.w); NH = Math.max(NH, b.h); });
      lblW = edges.reduce(function (m, e) { return e.label ? Math.max(m, textW(e.label, 12, false) + 20) : m; }, 0);
      CG = Math.max(LR ? 44 : 34, Math.min(140, LR ? lblW : 0)); RG = Math.max(18, LR ? 0 : (lblW ? 30 : 0));
      HW = LR ? Math.max(90, Math.min(130, Math.max.apply(null, lanes.map(function (l) { return textW(l.label, 14, true) + 24; })))) : 0; HH = LR ? 0 : 44;
    };
    // 레인 머리 글 줄 나눔 — 칸보다 긴 레인 이름이 머리 칸 밖으로 넘쳤다(2026-11-26 도식 점검). 세로 배치는 칸 폭이 레인 폭이라 배치 뒤에 다시 잰다
    var headLines = function (l, w) { return balanceLines(l.label, 14, true, (w - 2 * PADX) * 0.96); };
    sizes();
    var groups = [], heads = [], pad = 14;
    // 단계가 많아 가로 스윔레인이 넓으면 여러 띠로 접는다(띠마다 레인 이름을 다시 쓰고, 띠를 건너는 선은 띠 사이 빈칸으로) —
    // 2026-11-24에는 1,100px을 넘으면 레인을 세로 칸으로 돌렸는데, 단계가 10개를 넘으면 세로로 돌린 도식이 988×1,204px로 길쭉해져
    // Word에서 글자가 4pt가 됐다(2026-11-26 도식 점검). 띠당 단계 수는 Word 폭·높이에 넣었을 때 글자가 가장 커지는 수. 끄기 "wrap": false
    var laneH = lanes.map(function (l, i) { return Math.max(subN[i] * (NH + 16) - 16 + 2 * pad, Math.ceil(headLines(l, HW).length * 14 * LH + 16)); });
    var R = maxRank + 1, K = R, BG = 36 + (lblW ? 12 * LH : 0);
    if (LR && spec.wrap !== false && R >= 4) {
      var sumH = laneH.reduce(function (a, b) { return a + b; }, 0);
      var scoreK = function (k) { var nb0 = Math.ceil(R / k), W0 = HW + 2 * pad + k * (NW + CG) - CG + 32, H0 = nb0 * sumH + (nb0 - 1) * BG + 32; return fitScore(W0, H0); };
      var bestK = R;
      for (var k0 = R - 1; k0 >= 2; k0--) if (scoreK(k0) > scoreK(bestK) * 1.05 && Math.ceil(R / k0) <= 4) bestK = k0;
      // 접지 않아도 기준에 가깝거나(90% 이상) 접어서 15% 넘게 나아지지 않으면 한 띠로 둔다 — 5단계 흐름을 두 띠로 나누면 읽기 흐름이 끊긴다
      K = scoreK(R) < 0.9 && scoreK(bestK) > scoreK(R) * 1.15 ? bestK : R;
    }
    var bandOf = function (o) { return Math.floor(o.rank / K); };
    if (LR) {
      var nBand = Math.ceil(R / K), totalW = HW + pad + Math.min(R, K) * (NW + CG) - CG + pad, y = 0, bandTop = [], bandBot = [];
      for (var bi = 0; bi < nBand; bi++) {
        bandTop[bi] = y;
        lanes.forEach(function (l, i) {
          var hl = headLines(l, HW), h = laneH[i];
          groups.push({ id: l.id + (bi ? "_" + bi : ""), label: "", kind: "lane", x: 0, y: y, w: totalW, h: h, fill: i % 2 ? "FFFFFF" : "F5F7FB", line: "C9D3E3" });
          heads.push(mk({ id: "_lane_" + i + (bi ? "_" + bi : ""), label: l.label, shape: "rect", x: 0, y: y, w: HW, h: h, fill: "D9E2F3", line: "C9D3E3", color: "1F3864", fsFixed: true, noFit: true }));
          if (hl.length > 1) heads[heads.length - 1].lines = hl;
          var off = (h - (subN[i] * (NH + 16) - 16 + 2 * pad)) / 2; // 머리 글 때문에 레인이 높아지면 상자는 가운데로
          nodes.filter(function (o) { return o.lane === i && bandOf(o) === bi; }).forEach(function (o) {
            var rows = nodes.filter(function (q) { return q.lane === i && q.rank === o.rank; }).length;
            o.w = NW; o.h = NH; o.x = HW + pad + (o.rank - bi * K) * (NW + CG);
            o.y = y + pad + off + (subN[i] - rows) * (NH + 16) / 2 + o.sub2 * (NH + 16);
          });
          y += h;
        });
        bandBot[bi] = y;
        y += BG;
      }
    } else {
      HH = Math.max(44, Math.max.apply(null, lanes.map(function (l, i) { return Math.ceil(headLines(l, subN[i] * (NW + 16) - 16 + 2 * pad).length * 14 * LH + 14); })));
      var x = 0, totalH = HH + pad + (maxRank + 1) * (NH + 40) - 40 + pad;
      lanes.forEach(function (l, i) {
        var w = subN[i] * (NW + 16) - 16 + 2 * pad;
        groups.push({ id: l.id, label: "", kind: "lane", x: x, y: 0, w: w, h: totalH, fill: i % 2 ? "FFFFFF" : "F5F7FB", line: "C9D3E3" });
        heads.push(mk({ id: "_lane_" + i, label: l.label, shape: "rect", x: x, y: 0, w: w, h: HH, fill: "D9E2F3", line: "C9D3E3", color: "1F3864", fsFixed: true, noFit: true }));
        var hl2 = headLines(l, w); if (hl2.length > 1) heads[heads.length - 1].lines = hl2;
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
      var pts;
      if (LR && K < R && bandOf(a) !== bandOf(b)) {
        var acy = a.y + a.h / 2, bcy = b.y + b.h / 2;
        if (bandOf(b) > bandOf(a)) { // 다음 띠로: 출발 상자 오른쪽 열 간격 → 띠 사이 빈칸 → 도착 상자 왼쪽 열 간격 → 도착 상자
          // 도착 상자가 띠의 첫 단계면 레인 머리와 첫 열 사이(머리 칸을 지나가지 않게)
          var gx = a.x + a.w + CG / 2, gy = bandBot[bandOf(a)] + BG / 2 + (bk % 3) * 6, ex = b.rank % K === 0 ? HW + pad / 2 : b.x - CG / 2;
          pts = [[a.x + a.w, acy], [gx, acy], [gx, gy], [ex, gy], [ex, bcy], [b.x, bcy]];
        } else { // 앞 띠로 되돌아감: 출발 상자 위 → 그 띠 위 빈칸 → 도착 상자 아래
          var gy2 = bandTop[bandOf(a)] - BG / 2 - (bk++ % 3) * 6;
          pts = [[a.x + a.w / 2, a.y], [a.x + a.w / 2, gy2], [b.x + b.w / 2, gy2], [b.x + b.w / 2, b.y + b.h]];
        }
      } else if (e.back && LR && K < R) pts = backRoute(a, b, bbox(nodes.filter(function (o) { return bandOf(o) === bandOf(a); })), LR, bk++);
      else pts = e.back ? backRoute(a, b, nb, LR, bk++) : orthRoute(a, b, LR);
      // 세로 스윔레인에서 다음 단계로 가는 선은 아래로 나가 단계 사이 빈칸에서 옆으로 건너 위로 들어간다 —
      // 옆으로 나가면 레인 경계의 같은 세로줄을 여러 선이 나눠 써서 어느 화살표가 어디서 왔는지 읽히지 않았다
      if (!LR && !e.back && b.y >= a.y + a.h) {
        var ax = a.x + a.w / 2, bx = b.x + b.w / 2, my = b.y - 20;
        pts = Math.abs(ax - bx) < 1 ? [[ax, a.y + a.h], [bx, b.y]] : [[ax, a.y + a.h], [ax, my], [bx, my], [bx, b.y]];
      }
      return { pts: pts, label: e.label, dashed: e.dashed, arrow: e.arrow };
    });
    placeLabels(lines, heads.concat(nodes), groups);
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
    // 가운데 글(타원)이 있으면 단계 상자가 타원에서 16px 이상 떨어질 때까지 반지름을 늘린다 — 가운데 글이 길면 타원이 좌우 단계 상자를
    // 덮었다(2026-11-26 도식 점검). 상자 네 모서리 중 타원 중심에 가장 가까운 점을 타원 식에 넣어 본다
    var cen = spec.center ? itemText(spec.center) : null, cbx = null;
    if (cen) {
      cbx = boxFor(cen.label, cen.sub, 220, 100);
      var ex = cbx.w * 0.65 + 16, ey = cbx.h * 0.65 + 16;
      for (var tries = 0; tries < 60; tries++) {
        var clash = false;
        for (var q = 0; q < n && !clash; q++) {
          var aq = -Math.PI / 2 + 2 * Math.PI * q / n, bx0 = R * Math.cos(aq) - sz.w / 2, by0 = R * Math.sin(aq) - sz.h / 2;
          var nx = Math.max(bx0, Math.min(0, bx0 + sz.w)), ny = Math.max(by0, Math.min(0, by0 + sz.h)); // 상자에서 원점에 가장 가까운 점
          if ((nx * nx) / (ex * ex) + (ny * ny) / (ey * ey) < 1) clash = true;
        }
        if (!clash) break;
        R += 8;
      }
    }
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
    if (cen) {
      var cb = cbx;
      nodes.push(mk({ id: "center", label: cen.label, sub: cen.sub, shape: "ellipse", style: "white", x: -cb.w * 0.65, y: -cb.h * 0.65, w: cb.w * 1.3, h: cb.h * 1.3, line: "AFC3E6" }));
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
    var cw = cb.w * 1.3, ch = cb.h * 1.35;
    // 반지름: 이웃 상자끼리 16px, 가운데 타원과 40px 이상 떨어지는 가장 작은 값(가로 1.15배 타원 자리). 원둘레를 상자 폭으로 나누던
    // 식은 위아래로 놓인 상자 사이까지 상자 폭만큼 띄워 12개면 도식이 928×743px로 커졌다(2026-11-26 도식 점검)
    var XF = 1.15;
    var place = function (R, i) { var ang = -Math.PI / 2 + 2 * Math.PI * i / n; return [R * Math.cos(ang) * XF, R * Math.sin(ang)]; };
    var okR = function (R) {
      for (var i = 0; i < n; i++) {
        var p = place(R, i), q = place(R, (i + 1) % n);
        if (n > 1 && Math.abs(p[0] - q[0]) < sz.w + 16 && Math.abs(p[1] - q[1]) < sz.h + 16) return false;
        var nx = Math.max(p[0] - sz.w / 2, Math.min(0, p[0] + sz.w / 2)), ny = Math.max(p[1] - sz.h / 2, Math.min(0, p[1] + sz.h / 2));
        if ((nx * nx) / Math.pow(cw / 2 + 40, 2) + (ny * ny) / Math.pow(ch / 2 + 40, 2) < 1) return false;
      }
      return true;
    };
    var fitR = function () { var r0 = Math.max(80, cb.w / 2 + 20); for (var tr0 = 0; tr0 < 200 && !okR(r0); tr0++) r0 += 6; return r0; };
    // 가로 배율: 항목이 많아 도식이 Word 폭을 넘으면 1.0까지 줄이고, 높이가 남으면 1.3까지 — 글자가 가장 커지는 값
    var bestF = null;
    [1.15, 1.0, 1.3].forEach(function (f) { XF = f; var r1 = fitR(), Wd = 2 * r1 * f + sz.w + 32, Hd = 2 * r1 + sz.h + 32, sc = fitScore(Wd, Hd); if (!bestF || sc > bestF.sc * 1.03) bestF = { f: f, r: r1, sc: sc }; });
    XF = bestF.f;
    var R = bestF.r;
    var nodes = [mk({ id: "hub", label: c.label, sub: c.sub, shape: "ellipse", style: "primary", x: -cw / 2, y: -ch / 2, w: cw, h: ch })];
    var lines = [], dir = spec.arrow || "out";
    items.forEach(function (s, i) {
      var ang = -Math.PI / 2 + 2 * Math.PI * i / n, ex = Math.cos(ang), ey = Math.sin(ang);
      var o = mk({ id: "h" + i, label: s.label, sub: s.sub, shape: "roundRect", style: s.highlight ? "accent" : "default", x: place(R, i)[0] - sz.w / 2, y: place(R, i)[1] - sz.h / 2, w: sz.w, h: sz.h });
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
      var qn = mk({ id: "q" + i, label: qi.label || "", sub: qi.sub, shape: "rect", x: L + p[0] * S / 2, y: T + p[1] * S / 2, w: S / 2, h: S / 2,
        fill: qi.highlight ? "FFF2CC" : cellF[i], line: "FFFFFF", color: "1F3864", align: "left", valign: "top", fs: 15, fsFixed: true, noFit: true });
      // 사분면 이름이 칸 폭을 넘으면 줄을 나눠 둔다(칸 밖으로 넘쳐 옆 칸 글과 겹쳤다 — 2026-11-26 도식 점검)
      if (qn.label) qn.lines = balanceLines(qn.label, 15, true, S / 2 - 24);
      if (qn.sub) qn.subLines = balanceLines(qn.sub, 12, false, S / 2 - 24);
      nodes.push(qn);
    });
    // 사분면 이름이 차지하는 자리(점 이름을 피할 곳)
    var qRect = nodes.map(function (o) {
      var ls = (o.lines || [o.label || ""]), w = ls.reduce(function (m, t) { return Math.max(m, textW(t, 15, true)); }, 0) + 16;
      var h = ls.length * 15 * LH + (o.subLines ? o.subLines.length : o.sub ? 1 : 0) * 12 * LH + 10;
      return [o.x, o.y, o.x + w, o.y + h];
    });
    lines.push({ pts: [[L, T + S], [L + S + 14, T + S]], arrow: "end", color: "595959", width: 1.5 });
    lines.push({ pts: [[L, T + S], [L, T - 14]], arrow: "end", color: "595959", width: 1.5 });
    var txt = function (id, label, x, y, w, align, bold) { if (label) nodes.push(mk({ id: id, label: label, shape: "text", style: "plain", x: x, y: y, w: w, h: 22, align: align, fs: 13, fsFixed: true, noFit: true, bold: !!bold, color: bold ? "1F3864" : "595959" })); };
    txt("xl", xa.label, L + S / 2 - 160, T + S + 22, 320, "center", true);
    txt("xlo", xa.low, L, T + S + 4, 140, "left");
    txt("xhi", xa.high, L + S - 140, T + S + 4, 140, "right");
    txt("yl", ya.label, L + 8 - PADX, T - 38, 300, "left", true); // 세로축 이름은 축선 끝 오른쪽에(축선이 글을 가로지르던 것)
    txt("ylo", ya.low, L - 66, T + S - 22, 62, "right");
    txt("yhi", ya.high, L - 66, T, 62, "right");
    // 점과 점 이름: 이름은 점 오른쪽·왼쪽·위·아래 중 다른 점·이름·사분면 이름·축선과 겹치지 않고 그림 칸 안에 드는 자리에 둔다 —
    // 늘 오른쪽에 두면 점이 몰린 곳·오른쪽 끝·사분면 이름 옆에서 글이 겹쳤다(2026-11-26 도식 점검)
    var its = (spec.items || []).slice(0, 30).map(itemText), pts = its.map(function (it) {
      var cx = L + Math.max(0, Math.min(1, +it.x || 0)) * S, cy = T + (1 - Math.max(0, Math.min(1, +it.y || 0))) * S, d = Math.max(10, Math.min(40, +it.size || 14));
      return { cx: cx, cy: cy, d: d, r: [cx - d / 2 - 2, cy - d / 2 - 2, cx + d / 2 + 2, cy + d / 2 + 2] };
    });
    var placed = [], ov = function (a, b) { return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])); };
    its.forEach(function (it, i) {
      var pt = pts[i];
      nodes.push(mk({ id: "p" + i, label: "", shape: "ellipse", x: pt.cx - pt.d / 2, y: pt.cy - pt.d / 2, w: pt.d, h: pt.d, fill: it.highlight ? "D2601A" : "2E5395", line: "FFFFFF", noFit: true }));
      if (!it.label) return;
      var ls = textW(it.label, 13, true) > 170 ? balanceLines(it.label, 13, true, 170) : [String(it.label)];
      var tw = ls.reduce(function (m, t) { return Math.max(m, textW(t, 13, true)); }, 0) + 6, th = ls.length * 13 * LH + 4, g = pt.d / 2 + 4;
      var cand = [[pt.cx + g, pt.cy - th / 2, "left"], [pt.cx - g - tw, pt.cy - th / 2, "right"], [pt.cx - tw / 2, pt.cy - g - th, "center"], [pt.cx - tw / 2, pt.cy + g, "center"],
        [pt.cx + g, pt.cy - g - th + 4, "left"], [pt.cx + g, pt.cy + g - 4, "left"], [pt.cx - g - tw, pt.cy - g - th + 4, "right"], [pt.cx - g - tw, pt.cy + g - 4, "right"]];
      var cost = function (c) {
        var r = [c[0], c[1], c[0] + tw, c[1] + th], k = 0;
        pts.forEach(function (q, j) { if (j !== i) k += ov(r, q.r) * 3; });
        placed.forEach(function (q) { k += ov(r, q) * 3; });
        qRect.forEach(function (q) { k += ov(r, q) * 2; });
        k += (r[0] < L + 2 ? (L + 2 - r[0]) * th : 0) + (r[2] > L + S ? (r[2] - L - S) * th : 0) + (r[1] < T ? (T - r[1]) * tw : 0) + (r[3] > T + S - 2 ? (r[3] - T - S + 2) * tw : 0);
        if (r[0] < L && r[2] > L) k += 5000; // 세로축 선을 가로지르는 자리는 피한다
        return k;
      };
      var best = cand.reduce(function (b, c, ci) { var k = cost(c) + ci * 0.01; return !b || k < b.k ? { c: c, k: k } : b; }, null).c;
      placed.push([best[0], best[1], best[0] + tw, best[1] + th]);
      var o = mk({ id: "pl" + i, label: it.label, shape: "text", x: best[0] - PADX + (best[2] === "left" ? 0 : 0), y: best[1] - 2, w: tw + 2 * PADX, h: th + 4, align: best[2], fs: 13, fsFixed: true, noFit: true, bold: true, color: it.highlight ? "D2601A" : "1F3864", valign: "middle" });
      if (ls.length > 1) o.lines = ls;
      nodes.push(o);
    });
    return { nodes: nodes, groups: [], lines: lines };
  };

  // 칸 나누기(SWOT·비교 칸): cells = [{title, items[], style, highlight}], cols(기본 2). type "swot"는 s·w·o·t 배열로
  BUILD.grid = function (spec) {
    var cells = (spec.cells || []).slice(0, 12), cols = Math.max(1, Math.min(4, spec.cols || 2));
    if (!cells.length) throw new Error("칸 도식에 cells가 없습니다.");
    var CW = cols >= 3 ? 260 : 360, HH = 40, gap = 12, nodes = [];
    var bodyH = cells.map(function (c) { return Math.max(56, listH(listText(c.items), CW)); });
    var rows = Math.ceil(cells.length / cols), rowH = [];
    for (var r = 0; r < rows; r++) rowH.push(Math.max.apply(null, bodyH.slice(r * cols, r * cols + cols)));
    var y = 0;
    for (var r2 = 0; r2 < rows; r2++) {
      for (var c2 = 0; c2 < cols; c2++) {
        var i = r2 * cols + c2, cl = cells[i]; if (!cl) continue;
        var x = c2 * (CW + gap), head = cl.color ? hex(cl.color) : (cl.highlight ? "D2601A" : SERIES[i % SERIES.length]);
        nodes.push(mk({ id: "gh" + i, label: cl.title || "", shape: "rect", x: x, y: y, w: CW, h: HH, fill: head, line: head, color: inkOn(head), fs: 15, fsFixed: true, noFit: true }));
        nodes.push(listNode({ id: "gb" + i, label: listText(cl.items), x: x, y: y + HH, w: CW, h: rowH[r2], fill: "FFFFFF", line: head }));
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
    // 글 상자는 글에 맞춰 넓히고(최대 170px) 줄 수만큼 높인다 — 120×52px 고정이면 긴 이름이 상자 밖으로 넘쳤다(2026-11-26 도식 점검)
    var fitBox = function (label, sub, fs, bold, minW, maxW) {
      var w = Math.max(minW, Math.min(maxW, Math.max(textW(label, fs, bold), sub ? textW(sub, 12, false) : 0) + 2 * PADX + 6));
      var iw = (w - 2 * PADX) * 0.96, nl = balanceLines(label, fs, bold, iw).length, ns = sub ? balanceLines(sub, 12, false, iw).length : 0;
      return { w: w, h: Math.ceil(nl * fs * LH + ns * 12 * LH + 2 * PADY + 4) };
    };
    sets.forEach(function (s, i) {
      var col = s.color ? hex(s.color) : SERIES[i], b = fitBox(s.label, s.sub, 15, true, 120, 170);
      nodes.push(mk({ id: "vl" + i, label: s.label, sub: s.sub, shape: "text", x: lp[i][0] - b.w / 2, y: lp[i][1] - b.h / 2, w: b.w, h: Math.max(52, b.h), align: "center", valign: "middle", fs: 15, bold: true, color: col }));
    });
    var ov = spec.overlap || spec.center;
    if (ov) { var ot = itemText(ov), ob = fitBox(ot.label, ot.sub, 13, true, 110, n === 2 ? 130 : 120); nodes.push(mk({ id: "vo", label: ot.label, sub: ot.sub, shape: "text", valign: "middle", x: -ob.w / 2, y: (n === 2 ? 0 : (cs[0][1] + cs[1][1] + cs[2][1]) / 3) - Math.max(48, ob.h) / 2, w: ob.w, h: Math.max(48, ob.h), fs: 13, bold: true, color: "1F3864" })); }
    if (n === 3 && spec.pairs) {
      // 둘만 겹친 곳: 세 원 중심의 무게중심에서 나머지 한 원의 반대쪽으로
      var gx = (cs[0][0] + cs[1][0] + cs[2][0]) / 3, gy = (cs[0][1] + cs[1][1] + cs[2][1]) / 3;
      [["AB", 2], ["AC", 1], ["BC", 0]].forEach(function (pp) {
        var t = spec.pairs[pp[0]]; if (!t) return;
        var vx = gx - cs[pp[1]][0], vy = gy - cs[pp[1]][1], vl = Math.hypot(vx, vy) || 1, m = [gx + vx / vl * d * 0.95, gy + vy / vl * d * 0.95];
        var pb = fitBox(str(t, 40), "", 12, false, 100, 110);
        nodes.push(mk({ id: "vp" + pp[0], label: str(t, 40), shape: "text", x: m[0] - pb.w / 2, y: m[1] - Math.max(36, pb.h) / 2, w: pb.w, h: Math.max(36, pb.h), fs: 12, bold: false, color: "262626" }));
      });
    }
    return { nodes: nodes, groups: [], lines: [] };
  };

  // 동심원(핵심 → 바깥): rings = [{label,sub}] 안 → 밖
  BUILD.onion = function (spec) {
    var rg = (spec.rings || spec.levels || []).slice(0, 6).map(itemText), n = rg.length;
    if (!n) throw new Error("동심원 도식에 rings가 없습니다.");
    var nodes = [], R0 = 70, step = 52;
    // 고리 글은 고리 위쪽 띠의 현(chord) 폭 안에 들어가야 한다 — 240px 고정 폭이면 긴 글이 고리 밖으로 넘쳤다(2026-11-26 도식 점검).
    // 들어가지 않으면 고리 두께(step)를 늘린다(최대 96px). 가운데 글은 R0 원 안에 줄 수만큼
    var c0 = rg[0], c0w = 2 * R0 * 0.8, c0n = balanceLines(c0.label, 14, true, c0w - 2 * PADX).length + (c0.sub ? balanceLines(c0.sub, 12, false, c0w - 2 * PADX).length : 0);
    R0 = Math.max(R0, Math.ceil((c0n * 14 * LH + 10) / 2 / 0.6));
    var ringW = function (R) { var yc = R - 6 - (step - 10) / 2; return Math.max(60, 2 * Math.sqrt(Math.max(0, R * R - yc * yc)) * 0.86); };
    for (var pass = 0; pass < 3; pass++) for (var ri = 1; ri < n; ri++) {
      var Ri = R0 + ri * step, nl = balanceLines(rg[ri].label, 14, true, ringW(Ri) - 2 * PADX).length;
      step = Math.min(96, Math.max(step, Math.ceil(nl * 14 * LH + 18)));
    }
    for (var i = n - 1; i >= 0; i--) {
      var R = R0 + i * step, fill = STEPS[Math.min(STEPS.length - 1, i + 1)], s = rg[i];
      nodes.push(mk({ id: "r" + i, label: "", shape: "ellipse", x: -R, y: -R, w: 2 * R, h: 2 * R, fill: i === 0 ? "1F3864" : fill, line: "FFFFFF", noFit: true }));
    }
    rg.forEach(function (s, i) {
      var R = R0 + i * step, ink = i === 0 ? "FFFFFF" : inkOn(STEPS[Math.min(STEPS.length - 1, i + 1)]);
      var h = i === 0 ? Math.min(2 * R0 * 0.75, c0n * 14 * LH + 10) : step - 10, y = i === 0 ? -h / 2 : -R + 6, w = i === 0 ? c0w : ringW(R);
      nodes.push(mk({ id: "rl" + i, label: s.label, sub: i === 0 ? s.sub : "", shape: "text", x: -w / 2, y: y, w: w, h: h, fs: 14, bold: true, color: ink, subColor: ink === "FFFFFF" ? "DFE7F5" : "404040", valign: "middle" }));
    });
    return { nodes: nodes, groups: [], lines: [] };
  };

  // 층 구조(시스템 아키텍처·가치 사슬 층): layers = [{label, items[], highlight}] 위 → 아래
  BUILD.layers = function (spec) {
    var ls = (spec.layers || []).slice(0, 8);
    if (!ls.length) throw new Error("층 도식에 layers가 없습니다.");
    var Wt = 860, pad = 10, gap = 8, nodes = [], groups = [], y = 0;
    var HW = Math.max(120, Math.min(190, Math.max.apply(null, ls.map(function (L) { return textW(L.label || "", 14, true) + 2 * PADX + 16; }))));
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
    var bodies = cs.map(function (c) { return listText(c.items); });
    var BH = Math.max(64, Math.max.apply(null, bodies.map(function (t) { return listH(t, CW); })));
    cs.forEach(function (c, i) {
      var x = i * (CW + AW), head = c.highlight ? "D2601A" : (i === n - 1 && arrow ? "1F3864" : "5B6B8C");
      nodes.push(mk({ id: "ch" + i, label: c.title || "", sub: c.sub, shape: "rect", x: x, y: 0, w: CW, h: HH, fill: head, line: head, color: "FFFFFF", fs: 15, fsFixed: true, noFit: true }));
      nodes.push(listNode({ id: "cb" + i, label: bodies[i], x: x, y: HH, w: CW, h: BH, fill: "FFFFFF", line: head }));
      if (arrow && i < n - 1) nodes.push(mk({ id: "ca" + i, label: "", shape: "chevron", x: x + CW + 8, y: HH + BH / 2 - 22, w: AW - 16, h: 44, fill: "AFC3E6", line: "AFC3E6", noFit: true }));
    });
    return { nodes: nodes, groups: [], lines: lines };
  };

  // 로드맵(단계별 할 일): phases = [{label, period, items[], highlight}]
  BUILD.roadmap = function (spec) {
    var ps = (spec.phases || []).slice(0, 6);
    if (!ps.length) throw new Error("로드맵 도식에 phases가 없습니다.");
    var n = ps.length, PW = Math.floor((860 + (n - 1) * 6) / n), HH = 56, nodes = [];
    // 단계 이름이 화살표 글자 칸에 14px로 들어가도록 머리 높이를 줄 수만큼(최대 3줄) — 56px 고정이면 긴 이름이 11px로 줄었다(2026-11-26 도식 점검)
    ps.forEach(function (p) { var nl = balanceLines(p.label || "", 14, true, (textRectW("chevron", PW, HH) - 10) * 0.96).length; HH = Math.max(HH, Math.min(3, nl) * 14 * LH + 16); });
    var bodies = ps.map(function (p) { return listText(p.items); });
    var BH = Math.max(56, Math.max.apply(null, bodies.map(function (t) { return listH(t, PW - 20); })));
    // 기간(2027 상반기 등)은 단계 화살표 위에 가운데로 쓴다(2026-11-26 사용자 지정 — 화살표와 본문 사이에 끼면 본문 제목처럼 보였다)
    var PT = ps.some(function (p) { return p.period; }) ? 26 : 0;
    ps.forEach(function (p, i) {
      var x = i * (PW - 6), fill = p.highlight ? "D2601A" : STEPS[Math.min(3, i)], k = arrowK(PW, HH);
      if (p.period) nodes.push(mk({ id: "pp" + i, label: p.period, shape: "text", x: x + (i ? k : 0), y: 0, w: PW - k - (i ? k : 0), h: 22, fs: 13, bold: true, color: "2E5395", align: "center", valign: "middle", fsFixed: true, noFit: true }));
      nodes.push(mk({ id: "ph" + i, label: p.label || "", shape: i ? "chevron" : "homePlate", x: x, y: PT, w: PW, h: HH, fill: fill, line: fill, color: inkOn(fill) }));
      if (bodies[i]) nodes.push(listNode({ id: "pb" + i, label: bodies[i], x: x + 10, y: PT + HH + 10, w: PW - 20 - (i < n - 1 ? 6 : 0), h: BH, fill: "F7F9FC", line: "D0D9E8" }));
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
      if (o.paraGap && /^• /.test(o.label || "")) { // 글머리 목록 칸: 항목마다 내어쓰기 + 항목 사이 간격(PPT·Word와 같은 모양)
        var lfs0 = o.fs || 14, lh0 = Math.round(lfs0 * 1.36), ind = Math.round(lfs0 * 1.1), lft = (o.shape === "text" ? o.x + PADX : tr.x + 7), iw0 = Math.max(10, (o.shape === "text" ? o.w - 2 * PADX : tr.w - 6)) - ind;
        x.font = (bold ? "bold " : "") + lfs0 + "px " + font;
        var its = String(o.label).split("\n").filter(function (t) { return t; }).map(function (t) { return wrapText(x, t.replace(/^• /, ""), iw0, 99); });
        var tot0 = its.reduce(function (h, l) { return h + l.length * lh0; }, 0) + (its.length - 1) * o.paraGap;
        var tp = o.shape === "text" ? o.y : tr.y, hh = o.shape === "text" ? o.h : tr.h;
        var yy = o.valign === "top" ? tp + PADY : tp + hh / 2 - tot0 / 2;
        x.textAlign = "left"; x.textBaseline = "top"; x.fillStyle = "#" + cc.text;
        its.forEach(function (ls) { x.fillText("•", lft, yy); ls.forEach(function (t, i) { x.fillText(t, lft + ind, yy + i * lh0); }); yy += ls.length * lh0 + o.paraGap; });
        return;
      }
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
      if (!ln.lnofill) { x.fillStyle = "#ffffff"; x.fillRect(ln.lx - tw / 2 - 4, ln.ly - 9, tw + 8, 18); }
      x.fillStyle = "#262626"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(ln.label, ln.lx, ln.ly);
    });
    return { dataUrl: c.toDataURL("image/png"), w: W, h: H };
  }

  /* ---------- PowerPoint 실제 도형 ---------- */
  // PPT 글자 확대 배율: 도식이 작게 줄어 글자가 하한(14px 글 8pt)보다 작아지면 하한까지 키우되, 키운 글이 글자 자리에 들어가는
  // 만큼만 키운다. 테두리 있는 도형의 글은 모두 같은 배율(도형마다 따로 정하면 크기가 들쭉날쭉하고, 키운 글이 도형 밖으로 넘쳐
  // 옆 글과 겹쳤다 — 2026-11-26 도식 점검), 테두리 없는 글(벤 이름·점 이름 등)은 그 배율 안에서 제 칸에 들어가는 만큼.
  // 키울 때는 그 크기로 줄을 다시 나눈다. 마름모·타원은 글 줄 높이에서의 실제 도형 폭으로 잰다(글상자 사각형은 폭·높이의 절반이라
  // 마름모 하나가 전체 배율을 1에 묶었다). 돌려주는 값: { r: 도형 글 배율, per: 상자별 { r, lines, subLines } }
  function pptBoost(lay, s) {
    var want = 8 / (14 * s * 72);
    if (want <= 1.001) return { r: 1, per: null };
    var tok = function (t, f2, b2) { return String(t || "").split(/\s+/).reduce(function (m2, wd) { return Math.max(m2, wd.split(/(?<=·)/).reduce(function (m3, pc) { return Math.max(m3, textW(pc, f2, b2)); }, 0)); }, 0); };
    var fitOne = function (o, r) {
      var bold = o.bold != null ? o.bold : o.shape !== "text", tr = o.tr || textRect(o), fs = o.fs || 14, sfs = Math.min(o.subFs || 12, fs);
      var round = o.shape === "diamond" || o.shape === "ellipse" || o.shape === "circle" || o.shape === "cloud";
      // 테두리 없는 글은 칸 높이를 조금 넘어도(1.4배까지) 된다 — 칸은 배치용 자리일 뿐 선이 없고, 겹침은 도식 점검(diagram-check)이 잰다
      var base = o.shape === "text" ? o.w - 2 * PADX : tr.w - 6, ih = ((o.shape === "text" ? o.h * 1.4 : round ? o.h * 0.86 : tr.h) - 2) / r;
      for (var pass = 0; pass < 2; pass++) {
        var iw = base * 0.96 / r;
        var lab = o.label ? balanceLines(o.label, fs, bold, iw) : [], sub = o.sub ? balanceLines(o.sub, sfs, false, iw) : [];
        var th = lab.length * fs * 1.36 + sub.length * sfs * 1.36;
        if (round && pass === 0) { // 글 덩어리 위·아래 끝 높이에서의 도형 폭(마름모는 직선, 타원은 원호)
          var q = Math.min(0.95, th * r / o.h);
          base = (o.shape === "diamond" ? o.w * (1 - q) : o.w * Math.sqrt(1 - q * q)) - 10;
          continue;
        }
        var lw = Math.max(lab.reduce(function (m, t) { return Math.max(m, textW(t, fs, bold)); }, 0), sub.reduce(function (m, t) { return Math.max(m, textW(t, sfs, false)); }, 0));
        if (lw > iw + 0.5 || tok(o.label, fs, bold) > iw || tok(o.sub, sfs, false) > iw || th > ih) return null;
        return { lines: lab, subLines: sub };
      }
      return null;
    };
    // 마름모·타원(판단·시작/끝)은 글 칸이 좁아 배율을 막으므로 테두리 없는 글과 같이 제 칸에 들어가는 만큼만 키운다 —
    // 흐름도에서 판단 마름모 글이 상자 글보다 조금 작은 것은 흔한 모양이고, 마름모 하나 때문에 모든 글이 작아지는 것보다 낫다
    var isRound = function (o) { return o.shape === "diamond" || o.shape === "ellipse" || o.shape === "circle" || o.shape === "cloud"; };
    var shaped = lay.nodes.filter(function (o) { return (o.label || o.sub) && !o.noFit && o.shape !== "text" && !isRound(o); });
    var free = lay.nodes.filter(function (o) { return (o.label || o.sub) && !o.noFit && (o.shape === "text" || isRound(o)); });
    var rMain = 1, per = new Map();
    for (var r = want; r > 1.001; r -= 0.05) {
      var m = new Map(), ok = shaped.every(function (o) { var f = fitOne(o, r); if (f) m.set(o, { r: r, lines: f.lines, subLines: f.subLines }); return !!f; });
      if (ok) { rMain = r; per = m; break; }
    }
    free.forEach(function (o) {
      for (var r2 = Math.max(rMain, Math.min(want, 1)); r2 > 1.001; r2 -= 0.05) { var f = fitOne(o, r2); if (f) { per.set(o, { r: r2, lines: f.lines, subLines: f.subLines }); return; } }
    });
    if (!shaped.length) { // 도형 글이 없으면 자유 글 중 가장 큰 배율
      rMain = 1; per.forEach(function (v) { rMain = Math.max(rMain, v.r); });
    }
    return { r: rMain, per: per };
  }
  function toPptx(slide, lay, st, box, fontFace) {
    var s = Math.min(box.w / lay.W, box.h / lay.H);
    var ox = box.x + (box.w - lay.W * s) / 2, oy = box.y;
    var X = function (v) { return +(ox + v * s).toFixed(3); }, Y = function (v) { return +(oy + v * s).toFixed(3); }, L = function (v) { return +(v * s).toFixed(3); };
    // 글자 크기는 도형과 같은 비율로 줄이고 늘린다(그림·Word와 같은 글자:도형 비율). 아주 작아질 때만 도식 전체를 같은 배율로 키운다(pptBoost)
    var bo = pptBoost(lay, s), boost = bo.r;
    var pt = function (px, r) { return Math.min(18, +(px * s * 72 * (r || boost)).toFixed(1)); };
    var linesOf = function (o) { var q = bo.per && bo.per.get(o); return q ? { r: q.r, l: q.lines.length > 1 ? q.lines : o.lines, s: q.subLines.length > 1 ? q.subLines : null } : { r: o.shape === "text" || o.noFit ? (o.noFit ? boost : 1) : 1, l: o.lines, s: o.subLines }; };
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
      var LL = linesOf(o);
      var items = o.noFit && o.label && String(o.label).split("\n");
      if (items && items.length > 1 && items.every(function (g) { return /^• /.test(g); })) {
        // 목록 칸: 항목마다 글머리 문단(내어쓰기) — 줄바꿈으로 이으면 긴 항목의 둘째 줄이 글머리 아래로 붙어 시작했다(2026-11-26 도식 점검)
        var fsz = pt(o.fs || 14, LL.r);
        var gapPt = o.paraGap ? pt(o.paraGap, LL.r) : 0;
        var bruns = items.map(function (g, gi) { var op = { bold: bold, color: cc.text, fontSize: fsz, bullet: { indent: Math.max(6, Math.round(fsz * 0.9)) }, breakLine: gi < items.length - 1 }; if (gi && gapPt) op.paraSpaceBefore = gapPt; return { text: g.replace(/^• /, ""), options: op }; });
        var bopt = { x: X(o.x), y: Y(o.y), w: L(o.w), h: L(o.h), fontFace: fontFace, align: o.align || "left", valign: o.valign === "top" ? "top" : "middle", margin: [4, 6, 4, 6] };
        if (cc.fill || cc.line) { bopt.shape = PRESET[o.shape] || "rect"; bopt.fill = cc.fill ? { color: cc.fill } : { type: "none" }; bopt.line = cc.line ? { color: cc.line, width: 0.75 } : { type: "none" }; }
        slide.addText(bruns, bopt);
        return;
      }
      var runs = [{ text: (LL.l ? LL.l.join("\n") : o.label) || " ", options: { bold: bold, color: cc.text, fontSize: pt(o.fs || 14, LL.r), breakLine: !!o.sub } }];
      if (o.sub) runs.push({ text: LL.s ? LL.s.join("\n") : o.sub, options: { color: cc.sub, fontSize: pt(Math.min(o.subFs || 12, o.fs || 14), LL.r) } });
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
      var tw = Math.max(0.3, textW(ln.label, 12, false) * pt(12) / 12 / 72 + 0.06); // 여유를 크게 두면 이름표 흰 바탕이 옆 세로 줄기를 덮어 선이 끊겨 보였다
      var lo = { x: X(ln.lx) - tw / 2, y: Y(ln.ly) - 0.13, w: tw, h: 0.26, fontFace: fontFace, fontSize: pt(12), color: "262626", align: "center", valign: "middle", margin: 0 };
      if (!ln.lnofill) lo.fill = { color: "FFFFFF" }; // 배경이 흰색이 아닌 곳은 바탕 없이 선 옆(placeLabels)
      slide.addText(ln.label, lo);
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
    para = function (text, color, sz, bold, align, gapTw) { // 직접 나눈 줄("\n")은 줄바꿈(<w:br/>)으로. gapTw: 목록 항목 사이 간격(1/20pt)
      var segs = String(text || "").split("\n");
      // 목록 칸("• 항목"이 줄마다) — 항목마다 문단을 나누고 내어쓰기(둘째 줄이 글머리 뒤 글자에 맞게). 한 문단에 줄바꿈으로 이으면
      // 긴 항목의 둘째 줄이 글머리 아래로 붙어 시작했다(2026-11-26 도식 점검)
      if (segs.length > 1 && segs.every(function (g) { return /^• /.test(g); })) {
        var hang = Math.round(sz * 10 * 0.9), gi2 = 0; // 글머리 + 빈칸 폭(1/20pt 단위 — sz는 반 pt)
        return segs.map(function (g) {
          return '<w:p><w:pPr><w:spacing w:before="' + (gi2++ ? (gapTw || 0) : 0) + '" w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="' + hang + '" w:hanging="' + hang + '"/><w:jc w:val="' + (align || "left") + '"/></w:pPr><w:r>' + rpr(color, sz, bold) + '<w:t xml:space="preserve">• </w:t></w:r><w:r>' + rpr(color, sz, bold) + '<w:tab/><w:t xml:space="preserve">' + xe(g.replace(/^• /, "")) + "</w:t></w:r></w:p>";
        }).join("");
      }
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
      var txt = (o.label ? para(o.lines ? o.lines.join("\n") : o.label, cc.text, hp(o.fs || 14), bold, al, o.paraGap ? Math.round(o.paraGap * e / 12700 * 20) : 0) : "") + (o.sub ? para(o.subLines ? o.subLines.join("\n") : o.sub, cc.sub, hp(Math.min(o.subFs || 12, o.fs || 14)), false, al) : "");
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
      kids.push(shape("rect", E(ln.lx) - Math.round(twE / 2), E(ln.ly) - Math.round(thE / 2), twE, thE, ln.lnofill ? null : "FFFFFF", null, false, para(ln.label, "262626", hz, false), "ctr"));
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
  // Word·PDF 도식 그림 높이 상한(본문 높이에 대한 비율): 기본 40%(정사각형에 가까운 순환·벤·2×2가 한 쪽을 다 차지하지 않게),
  // 40%로 줄이면 도식 글자가 0.5pt/px(14px 글 7pt) 아래로 작아지는 큰 도식은 60%까지 — 단계가 많은 흐름도·스윔레인이 40%에 묶여
  // 글자가 3~5pt로 작아졌다(2026-11-26 도식 점검). wPt: 그림 폭 상한, bodyH: 본문 높이(둘 다 같은 단위 — pt 또는 px)
  function docCap(lay, wPt, bodyH) {
    if (!lay || !lay.W || !lay.H || !bodyH) return 0.40;
    var want = Math.min(lay.H * 0.5, lay.H * wPt / lay.W); // 글자 기준을 맞추는 높이(폭이 먼저 막히면 그 높이까지만). 0.5는 pt 기준 — px이면 아래에서 바꿈
    return Math.max(0.40, Math.min(0.60, want / bodyH));
  }
  // 중계 서버가 페이지에 돌려주는 배치: 색까지 적어(resolve) JSON으로. 페이지는 toCanvas(배치)만 부르면 된다
  function serverLayout(spec, st) {
    var lay = layout(spec);
    resolve(lay, st || { colors: DEF_COLORS });
    return JSON.parse(JSON.stringify(lay));
  }
  var TYPES = function () { return Object.keys(BUILD).concat(["graph", "flow", "tree", "chevron"]); };
  return { docCap: docCap, pptBoost: pptBoost, serverLayout: serverLayout, types: TYPES, normalize: normalize, layout: layout, wrapCheck: wrapCheck, toCanvas: toCanvas, toPptx: toPptx, docxGroup: docxGroup, patchDocxXml: patchDocxXml, wordFit: wordFit, describe: describe };
})();

/* ===== 그림 모듈: 답변 속 ```chart / ```diagram 블록(JSON 설정)을 그림(PNG)으로 그린다 =====
   - chart: ECharts로 그린다(막대·선·면적·누적·가로막대·파이·도넛·산점도·복합, 또는 option에 ECharts 설정 JSON).
   - diagram: 캔버스로 직접 그린다(셰브론 단계도, 흐름도).
   - 설정은 JSON 값만 받는다. 함수·코드는 받지 않고, 바깥 이미지(graphic)는 지운다. */
if (typeof module !== "undefined" && module.exports) module.exports = Diagram;
