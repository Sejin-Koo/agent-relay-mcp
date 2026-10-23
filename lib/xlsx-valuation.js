// 가치평가 엑셀 모델(회계법인·IB 양식) — 에이전트가 원고에 넣은 ```valuation-model JSON으로 만든다.
// 가정 시트 하나만 바꾸면 DCF·상대가치·요약·차트가 다시 계산되도록 모든 계산 칸은 수식이다.
// 수식마다 이 코드가 같은 계산으로 구한 값을 함께 넣어(캐시) 계산 전에 여는 미리보기에서도 숫자가 보이게 한다.
// 시트: 표지 · 요약 · 가정 · 재무자료 · WACC · DCF_회사 · 상대가치

const ExcelJS = require("exceljs");
const { rangeChartXml, injectCharts } = require("./xlsx-chart");

const NAVY = "2E5395", TEAL = "2A9478", ORANGE = "D2601A";
const F_IN = "0000FF", F_LINK = "008000", F_CALC = "000000";
const FMT = { amt: '#,##0;(#,##0);"-"', amt1: '#,##0.0;(#,##0.0);"-"', pct: "0.0%", pct2: "0.00%", mult: '0.0"x"', beta: "0.0000", won: '#,##0;(#,##0);"-"', yr: "0.0" };

function colName(n) { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
const q = (sheet) => `'${String(sheet).replace(/'/g, "''")}'`;
const abs = (sheet, c, r) => `${q(sheet)}!$${c}$${r}`;
const num = (x) => (typeof x === "number" && isFinite(x)) ? x : (typeof x === "string" && x.trim() !== "" && isFinite(+x.replace(/,/g, "")) ? +x.replace(/,/g, "") : null);
const arrN = (v, n) => Array.isArray(v) ? Array.from({ length: n }, (_, i) => num(v[Math.min(i, v.length - 1)])) : Array.from({ length: n }, () => num(v));
function quartile(arr, k) { // Excel QUARTILE(포함) 과 같은 선형 보간
  const a = arr.filter(x => typeof x === "number" && isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const p = (a.length - 1) * k / 4, lo = Math.floor(p), hi = Math.ceil(p);
  return a[lo] + (a[hi] - a[lo]) * (p - lo);
}
const median = (arr) => quartile(arr, 2);
const isNum = (x) => typeof x === "number" && isFinite(x);

// ---------------- 평가 방법 ----------------
// methods: ["dcf","relative"] 중 고른 것. 없거나 알아볼 수 없으면 둘 다.
// 하나만 고르면 그 결과가 곧 적정가치다(요약·차트에서 그 행과 시장가치를 같은 색으로 비교).
function methodsOf(spec) {
  const m = Array.isArray(spec && spec.methods) ? spec.methods.map(x => String(x).toLowerCase()) : [];
  const dcf = m.some(x => /dcf|현금/.test(x)), rel = m.some(x => /rel|멀티|상대|peer|multiple|배수/.test(x));
  return (dcf || rel) ? { dcf, rel } : { dcf: true, rel: true };
}

// ---------------- 입력 검사 ----------------
function validate(spec) {
  const errs = [];
  const MT = methodsOf(spec);
  const A = spec && spec.assumptions;
  if (MT.dcf) {
    if (!A) errs.push("assumptions가 없습니다");
    else ["rf_pct", "mrp_pct", "tax_pct", "g_pct", "kd_pct"].forEach(k => { if (num(A[k]) === null) errs.push(`assumptions.${k}가 숫자가 아닙니다`); });
  }
  const cos = spec && spec.companies;
  if (!Array.isArray(cos) || !cos.length) errs.push("companies가 비었습니다");
  (cos || []).forEach((c, i) => {
    const p = `companies[${i}]`;
    if (!c.name) errs.push(`${p}.name이 없습니다`);
    if (num(c.shares_outstanding) === null) errs.push(`${p}.shares_outstanding가 없습니다`);
    if (MT.dcf) {
      if (num(c.beta_unlevered) === null) errs.push(`${p}.beta_unlevered가 없습니다`);
      const h = c.history || {};
      if (!Array.isArray(h.years) || !h.years.length) errs.push(`${p}.history.years가 없습니다`);
      ["revenue", "operating_income", "depreciation", "capex", "nwc"].forEach(k => { if (!Array.isArray(h[k]) || h[k].length !== (h.years || []).length) errs.push(`${p}.history.${k} 길이가 years와 다릅니다`); });
      const f = c.forecast || {};
      if (!Array.isArray(f.years) || f.years.length < 2) errs.push(`${p}.forecast.years는 2개 이상이어야 합니다`);
      ["growth_pct", "margin_pct", "da_pct", "capex_pct", "nwc_pct"].forEach(k => { if (f[k] === undefined) errs.push(`${p}.forecast.${k}가 없습니다`); });
    }
    if (MT.rel) {
      if (!Array.isArray(c.peers) || !c.peers.length) errs.push(`${p}.peers가 비었습니다`);
      if (!c.target_metrics) errs.push(`${p}.target_metrics가 없습니다`);
    }
  });
  return errs;
}

// ---------------- 계산(수식과 같은 산식) ----------------
function compute(spec) {
  const A = spec.assumptions || {};
  const MT = methodsOf(spec);
  const pc = (k, d) => (num(A[k]) === null ? (d === undefined ? NaN : d) : num(A[k])) / 100;
  const G = { rf: pc("rf_pct"), mrp: pc("mrp_pct"), srp: pc("srp_pct", 0), tax: pc("tax_pct"), kd: pc("kd_pct"), g: pc("g_pct"), w: pc("weight_dcf_pct", 50), ws: pc("wacc_step_pct", 0.5), gs: pc("g_step_pct", 0.5) };
  const NA = { lo: NaN, mid: NaN, hi: NaN };
  const out = spec.companies.map(c => {
    const bridge = (c.bridge || []).map(b => ({ item: String(b.item || ""), amount: num(b.amount) || 0, note: b.note || "" }));
    const bsum = bridge.reduce((s, b) => s + b.amount, 0);
    const shares = num(c.shares_outstanding);
    const o = { c, bridge, bsum, shares, dcf: NA, comp: NA, peers: [], stats: {}, app: {} };
    if (MT.dcf) {
      const h = c.history, f = c.forecast, N = f.years.length, H = h.years.length;
      const hv = (k) => h[k].map(num);
      const hist = { rev: hv("revenue"), op: hv("operating_income"), da: hv("depreciation"), capex: hv("capex"), nwc: hv("nwc") };
      const fa = { g: arrN(f.growth_pct, N).map(x => x / 100), m: arrN(f.margin_pct, N).map(x => x / 100), da: arrN(f.da_pct, N).map(x => x / 100), cp: arrN(f.capex_pct, N).map(x => x / 100), nw: arrN(f.nwc_pct, N).map(x => x / 100) };
      const bu = num(c.beta_unlevered), de = (num(c.target_de_pct) || 0) / 100;
      const bl = bu * (1 + (1 - G.tax) * de), ke = G.rf + bl * G.mrp + G.srp, kdat = G.kd * (1 - G.tax);
      const ev_w = 1 / (1 + de), dv_w = de / (1 + de), wacc = ke * ev_w + kdat * dv_w;
      const rev = [], op = [], tax = [], nopat = [], da = [], capex = [], nwc = [], dnwc = [], fcff = [], t = [], dfac = [], pv = [];
      for (let i = 0; i < N; i++) {
        rev[i] = (i ? rev[i - 1] : hist.rev[H - 1]) * (1 + fa.g[i]);
        op[i] = rev[i] * fa.m[i]; tax[i] = op[i] * G.tax; nopat[i] = op[i] - tax[i];
        da[i] = rev[i] * fa.da[i]; capex[i] = rev[i] * fa.cp[i]; nwc[i] = rev[i] * fa.nw[i];
        dnwc[i] = nwc[i] - (i ? nwc[i - 1] : hist.nwc[H - 1]);
        fcff[i] = nopat[i] + da[i] - capex[i] - dnwc[i];
        t[i] = i + 0.5; dfac[i] = 1 / Math.pow(1 + wacc, t[i]); pv[i] = fcff[i] * dfac[i];
      }
      const sumPv = pv.reduce((s, x) => s + x, 0);
      const tv = fcff[N - 1] * (1 + G.g) / (wacc - G.g), pvTv = tv * dfac[N - 1], ev = sumPv + pvTv;
      const eq = ev + bsum, ps = eq * 1e6 / shares;
      const sens = (w, g) => fcff.reduce((s, x, i) => s + x / Math.pow(1 + w, t[i]), 0) + fcff[N - 1] * (1 + g) / (w - g) / Math.pow(1 + w, t[N - 1]) + bsum;
      const grid = [-2, -1, 0, 1, 2].map(a => [-2, -1, 0, 1, 2].map(b => sens(wacc + a * G.ws, G.g + b * G.gs)));
      Object.assign(o, { N, H, hist, fa, bu, de, bl, ke, kdat, ev_w, dv_w, wacc, rev, op, tax, nopat, da, capex, nwc, dnwc, fcff, t, dfac, pv, sumPv, tv, pvTv, ev, eq, ps, grid, dcf: { lo: grid[3][1], mid: eq, hi: grid[1][3] } });
    }
    if (MT.rel) {
      const peers = (c.peers || []).map(p => {
        const mc = num(p.market_cap), ev2 = num(p.ev), ebitda = num(p.ebitda), ebit = num(p.ebit), ni = num(p.net_income), eqp = num(p.equity);
        const r = (a, b) => (isNum(a) && isNum(b) && b > 0) ? a / b : NaN;
        return { name: p.name || "", code: p.code || "", mc, ev: ev2, ebitda, ebit, ni, eq: eqp, m: { "EV/EBITDA": r(ev2, ebitda), "EV/EBIT": r(ev2, ebit), PER: r(mc, ni), PBR: r(mc, eqp) } };
      });
      const tm = c.target_metrics || {};
      const metric = { "EV/EBITDA": num(tm.ebitda), "EV/EBIT": num(tm.ebit), PER: num(tm.net_income), PBR: num(tm.equity) };
      const stats = {}, app = {};
      ["EV/EBITDA", "EV/EBIT", "PER", "PBR"].forEach(k => {
        const vals = peers.map(p => p.m[k]).filter(isNum);
        const s = { n: vals.length, med: median(vals), q1: quartile(vals, 1), q3: quartile(vals, 3), avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN };
        stats[k] = s;
        const met = metric[k], isEv = k.startsWith("EV");
        const val = (mult) => (isNum(met) && met > 0 && isNum(mult)) ? met * mult + (isEv ? bsum : 0) : NaN;
        app[k] = { lo: val(s.q1), mid: val(s.med), hi: val(s.q3) };
      });
      const useP = c.include_pbr_in_composite === true;
      const compKeys = ["EV/EBITDA", "EV/EBIT", "PER"].concat(useP ? ["PBR"] : []);
      const meds = compKeys.map(k => app[k].mid).filter(isNum);
      const comp = meds.length ? { lo: Math.min(...meds), mid: meds.reduce((a, b) => a + b, 0) / meds.length, hi: Math.max(...meds) } : NA;
      Object.assign(o, { peers, metric, stats, app, useP, compKeys, comp });
    }
    o.fv = MT.dcf && MT.rel
      ? (isNum(o.comp.mid) ? { lo: G.w * o.dcf.lo + (1 - G.w) * o.comp.lo, mid: G.w * o.dcf.mid + (1 - G.w) * o.comp.mid, hi: G.w * o.dcf.hi + (1 - G.w) * o.comp.hi } : o.dcf)
      : (MT.dcf ? o.dcf : o.comp);
    o.listed = c.listed !== false && isNum(num(c.market_cap));
    const mc = num(c.market_cap), mc2 = isNum(num(c.market_cap_alt)) ? num(c.market_cap_alt) : mc;
    o.mkt = o.listed ? { lo: Math.min(mc, mc2), mid: mc, hi: Math.max(mc, mc2) } : null;
    return o;
  });
  return { G, MT, cos: out };
}

// ---------------- 시트 작성 도우미 ----------------
function styler(font) {
  const thin = { style: "thin", color: { argb: "FFBFBFBF" } };
  const border = { top: thin, bottom: thin, left: thin, right: thin };
  return {
    border,
    put(ws, addr, v, o) {
      o = o || {};
      const cell = ws.getCell(addr);
      if (v && typeof v === "object" && v.f !== undefined) {
        const r = v.r;
        cell.value = { formula: v.f.replace(/^=/, ""), result: (typeof r === "number" && !isFinite(r)) ? "n/a" : r };
      } else cell.value = (typeof v === "number" && !isFinite(v)) ? "n/a" : v;
      const color = o.color || (v && typeof v === "object" ? (v.link ? F_LINK : F_CALC) : (typeof v === "number" ? F_IN : F_CALC));
      cell.font = { name: font, size: o.size || 9, bold: !!o.bold, color: { argb: "FF" + color } };
      if (o.fmt) cell.numFmt = o.fmt;
      if (o.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + o.fill } };
      if (o.border !== false) cell.border = border;
      cell.alignment = { vertical: "middle", horizontal: o.align || (typeof v === "string" ? "left" : "right"), wrapText: !!o.wrap };
      return cell;
    },
    head(ws, r, cols, o) {
      cols.forEach(([c, t]) => {
        const cell = ws.getCell(`${c}${r}`);
        cell.value = t;
        cell.font = { name: font, size: 9, bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + ((o && o.bg) || "1F3864") } };
        cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        cell.border = border;
      });
    },
    title(ws, t, sub) {
      ws.getCell("A1").value = t; ws.getCell("A1").font = { name: font, size: 13, bold: true, color: { argb: "FF1F3864" } };
      if (sub) { ws.getCell("A2").value = sub; ws.getCell("A2").font = { name: font, size: 9, color: { argb: "FF595959" } }; }
    },
    text(ws, addr, t, o) {
      const cell = ws.getCell(addr); cell.value = t;
      cell.font = { name: font, size: (o && o.size) || 9, bold: !!(o && o.bold), color: { argb: "FF" + ((o && o.color) || "404040") } };
      cell.alignment = { vertical: "middle", horizontal: "left", wrapText: !!(o && o.wrap) };
      return cell;
    }
  };
}
function setup(ws, conf, opts) {
  ws.views = [Object.assign({ showGridLines: false }, opts && opts.freeze ? { state: "frozen", xSplit: opts.freeze[0], ySplit: opts.freeze[1] } : {})];
  ws.pageSetup = { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } };
  ws.headerFooter = { oddHeader: conf ? `&R&"${"맑은 고딕"},Regular"&8${conf}` : "", oddFooter: "&C&8&P / &N" };
}

// ---------------- 통합 문서 ----------------
async function buildValuationWorkbook(spec, meta) {
  const errs = validate(spec);
  if (errs.length) { const e = new Error("가치평가 모델 입력 오류: " + errs.slice(0, 8).join("; ")); e.code = "bad_model"; throw e; }
  const M = compute(spec);
  const MT = M.MT;
  const font = (meta && meta.font) || "맑은 고딕";
  const S = styler(font);
  const wb = new ExcelJS.Workbook();
  wb.creator = (meta && meta.brand) || "업무 에이전트";
  wb.calcProperties = { fullCalcOnLoad: true };
  const conf = (meta && meta.confidential) || "";
  const date = spec.valuation_date || "";
  const unit = "백만원";
  const names = M.cos.map(x => x.c.name);
  const dcfName = (x, i) => ("DCF_" + String(x.c.name).replace(/[\[\]:*?\/\\']/g, " ").trim()).slice(0, 28) + (M.cos.filter(y => y.c.name === x.c.name).length > 1 ? String(i + 1) : "");

  const wsCover = wb.addWorksheet("표지");
  const wsSum = wb.addWorksheet("요약");
  const wsA = wb.addWorksheet("가정");
  const wsF = wb.addWorksheet("재무자료");
  const wsW = MT.dcf ? wb.addWorksheet("WACC") : null;
  const wsD = MT.dcf ? M.cos.map((x, i) => wb.addWorksheet(dcfName(x, i))) : [];
  const wsR = MT.rel ? wb.addWorksheet("상대가치") : null;

  // ===== 가정 =====
  S.title(wsA, "가정 — 이 시트의 파란 글자만 바꾸면 전 시트가 다시 계산됨", `단위: ${unit}, % · 평가기준일 ${date}`);
  wsA.columns = [{ width: 30 }, { width: 12 }].concat(Array.from({ length: 10 }, () => ({ width: 11 }))).concat([{ width: 60 }]);
  S.head(wsA, 4, [["A", "공통 가정"], ["B", "값"], ["C", "근거·출처"]]);
  wsA.mergeCells("C4:M4");
  const A = spec.assumptions || {}, G = M.G;
  const common = [
    ["rf", "무위험이자율", G.rf, A.rf_note], ["mrp", "시장위험프리미엄", G.mrp, A.mrp_note], ["srp", "규모위험프리미엄", G.srp, A.srp_note],
    ["tax", "법인세율(지방소득세 포함)", G.tax, A.tax_note], ["kd", "세전 타인자본비용", G.kd, A.kd_note], ["g", "영구성장률", G.g, A.g_note],
    ["w", "적정가치 가중치 — DCF", G.w, A.weight_note || "상대가치 종합 = 1 − DCF 가중치"],
    ["ws", "민감도 간격 — 할인율(±)", G.ws, ""], ["gs", "민감도 간격 — 영구성장률(±)", G.gs, ""]
  ].filter(([k]) => MT.dcf && (k !== "w" || MT.rel));
  const AR = {};
  let r = 5;
  S.put(wsA, `A${r}`, "평가기준일"); S.put(wsA, `B${r}`, date, { color: F_IN, align: "center" }); S.put(wsA, `C${r}`, spec.valuation_note || "", { wrap: true }); wsA.mergeCells(`C${r}:M${r}`); r++;
  common.forEach(([k, label, v, note]) => {
    S.put(wsA, `A${r}`, label);
    S.put(wsA, `B${r}`, v, { fmt: k === "ws" || k === "gs" ? FMT.pct : FMT.pct2, fill: ["mrp", "g", "w"].includes(k) ? "FFF2CC" : undefined });
    S.put(wsA, `C${r}`, note || "", { wrap: true }); wsA.mergeCells(`C${r}:M${r}`);
    AR[k] = abs("가정", "B", r); r++;
  });
  r++;
  const CA = []; // 회사별 가정 주소
  if (MT.dcf) M.cos.forEach((x, ci) => {
    const c = x.c, N = x.N, last = 1 + N;
    S.head(wsA, r, [["A", `${c.name} — 회사별 가정`], ["B", "값"]].concat(c.forecast.years.map((y, i) => [colName(3 + i), String(y)])).concat([[colName(3 + N), "근거·출처"]]));
    // 첫 두 행은 값 하나(B열)
    r++;
    const ca = { years: c.forecast.years };
    S.put(wsA, `A${r}`, "무부채 베타(βu)"); S.put(wsA, `B${r}`, x.bu, { fmt: FMT.beta, fill: "FFF2CC" }); S.put(wsA, `${colName(3 + N)}${r}`, c.beta_note || "", { wrap: true }); ca.bu = abs("가정", "B", r); r++;
    S.put(wsA, `A${r}`, "목표 부채비율(D/E)"); S.put(wsA, `B${r}`, x.de, { fmt: FMT.pct }); S.put(wsA, `${colName(3 + N)}${r}`, c.de_note || "", { wrap: true }); ca.de = abs("가정", "B", r); r++;
    const notes = c.forecast_notes || {};
    [["g", "매출 성장률", "growth"], ["m", "영업이익률", "margin"], ["da", "감가상각비 / 매출", "da"], ["cp", "CAPEX / 매출", "capex"], ["nw", "순운전자본 / 매출", "nwc"]].forEach(([k, label, nk]) => {
      S.put(wsA, `A${r}`, label);
      x.fa[k].forEach((v, i) => S.put(wsA, `${colName(3 + i)}${r}`, v, { fmt: FMT.pct, fill: k === "g" || k === "m" ? "FFF2CC" : undefined }));
      S.put(wsA, `${colName(3 + N)}${r}`, notes[nk] || "", { wrap: true });
      ca[k] = r; r++;
    });
    CA[ci] = ca; r += 1;
    void last;
  });
  setup(wsA, conf, { freeze: [1, 4] });

  // ===== 재무자료 =====
  S.title(wsF, "재무자료 — 공시 원자료와 주주가치 조정 항목", `단위: ${unit}(주식수는 주)`);
  wsF.columns = [{ width: 28 }].concat(Array.from({ length: 8 }, () => ({ width: 12 }))).concat([{ width: 50 }]);
  r = 4;
  const FR = [];
  M.cos.forEach((x, ci) => {
    const c = x.c, H = MT.dcf ? x.H : 1, nc = colName(2 + H);
    S.head(wsF, r, [["A", c.name + (c.code ? ` (${c.code})` : "")]].concat(MT.dcf ? c.history.years.map((y, i) => [colName(2 + i), String(y)]) : [["B", "값"]]).concat([[nc, "출처·비고"]]));
    r++;
    const fr = { H };
    if (MT.dcf) {
      [["rev", "매출액"], ["op", "영업이익"], ["da", "감가상각비(무형 포함)"], ["capex", "CAPEX(유·무형 취득)"], ["nwc", "순운전자본"]].forEach(([k, label], j) => {
        S.put(wsF, `A${r}`, label);
        x.hist[k].forEach((v, i) => S.put(wsF, `${colName(2 + i)}${r}`, v, { fmt: FMT.amt }));
        S.put(wsF, `${nc}${r}`, j === 0 ? (c.history.source || "") : "");
        fr[k] = r; r++;
      });
    }
    S.put(wsF, `A${r}`, "유통주식수(자기주식 제외, 주)"); S.put(wsF, `B${r}`, x.shares, { fmt: FMT.won }); S.put(wsF, `${nc}${r}`, c.shares_note || ""); fr.shares = abs("재무자료", "B", r); r++;
    if (x.listed) {
      S.put(wsF, `A${r}`, "시가총액(평가기준일 종가)"); S.put(wsF, `B${r}`, num(c.market_cap), { fmt: FMT.amt }); S.put(wsF, `${nc}${r}`, c.market_note || ""); fr.mc = abs("재무자료", "B", r); r++;
      S.put(wsF, `A${r}`, "시가총액(다른 기준)"); S.put(wsF, `B${r}`, isNum(num(c.market_cap_alt)) ? num(c.market_cap_alt) : num(c.market_cap), { fmt: FMT.amt }); S.put(wsF, `${nc}${r}`, c.market_alt_note || (isNum(num(c.market_cap_alt)) ? "" : "다른 기준 없음 — 종가와 같게 둠")); fr.mc2 = abs("재무자료", "B", r); r++;
    }
    // 영업가치 → 주주가치 조정(비영업자산 +, 차입금·리스부채·비지배지분 −). DCF와 EV 배수가 같은 값을 쓴다
    const b0 = r;
    x.bridge.forEach(b => { S.put(wsF, `A${r}`, "(조정) " + b.item); S.put(wsF, `B${r}`, b.amount, { fmt: FMT.amt }); S.put(wsF, `${nc}${r}`, b.note || ""); r++; });
    S.put(wsF, `A${r}`, "주주가치 조정 합계", { bold: true });
    S.put(wsF, `B${r}`, { f: x.bridge.length ? `=SUM(B${b0}:B${r - 1})` : "=0", r: x.bsum }, { fmt: FMT.amt, bold: true });
    S.put(wsF, `${nc}${r}`, "평가기준일 직전 정기보고서 말 잔액 기준");
    fr.bsum = abs("재무자료", "B", r); r++;
    FR[ci] = fr; r++;
  });
  setup(wsF, conf, { freeze: [1, 3] });

  // ===== WACC =====
  const WR = {};
  if (MT.dcf) {
  S.title(wsW, "WACC — CAPM 빌드업", "자기자본비용 = 무위험이자율 + 레버드 베타 × 시장위험프리미엄 + 규모위험프리미엄");
  wsW.columns = [{ width: 28 }].concat(M.cos.map(() => ({ width: 14 }))).concat([{ width: 40 }]);
  S.head(wsW, 4, [["A", "항목"]].concat(M.cos.map((x, i) => [colName(2 + i), x.c.name])).concat([[colName(2 + M.cos.length), "산식"]]));
  const wrows = [
    ["rf", "무위험이자율", (x, ci) => ({ f: `=${AR.rf}`, r: G.rf, link: 1 }), FMT.pct2, "가정"],
    ["bu", "무부채 베타(βu)", (x, ci) => ({ f: `=${CA[ci].bu}`, r: x.bu, link: 1 }), FMT.beta, "가정"],
    ["de", "목표 부채비율(D/E)", (x, ci) => ({ f: `=${CA[ci].de}`, r: x.de, link: 1 }), FMT.pct, "가정"],
    ["tax", "법인세율", (x) => ({ f: `=${AR.tax}`, r: G.tax, link: 1 }), FMT.pct2, "가정"],
    ["bl", "레버드 베타(βL)", (x, ci, c) => ({ f: `=${c}${WR.bu}*(1+(1-${c}${WR.tax})*${c}${WR.de})`, r: x.bl }), FMT.beta, "βu × (1 + (1 − t) × D/E)"],
    ["mrp", "시장위험프리미엄", () => ({ f: `=${AR.mrp}`, r: G.mrp, link: 1 }), FMT.pct2, "가정"],
    ["srp", "규모위험프리미엄", () => ({ f: `=${AR.srp}`, r: G.srp, link: 1 }), FMT.pct2, "가정"],
    ["ke", "자기자본비용(Ke)", (x, ci, c) => ({ f: `=${c}${WR.rf}+${c}${WR.bl}*${c}${WR.mrp}+${c}${WR.srp}`, r: x.ke }), FMT.pct2, "Rf + βL × MRP + SRP"],
    ["kd", "세전 타인자본비용", () => ({ f: `=${AR.kd}`, r: G.kd, link: 1 }), FMT.pct2, "가정"],
    ["kdat", "세후 타인자본비용", (x, ci, c) => ({ f: `=${c}${WR.kd}*(1-${c}${WR.tax})`, r: x.kdat }), FMT.pct2, "Kd × (1 − t)"],
    ["ev", "자기자본 비중(E/V)", (x, ci, c) => ({ f: `=1/(1+${c}${WR.de})`, r: x.ev_w }), FMT.pct, "1 / (1 + D/E)"],
    ["dv", "타인자본 비중(D/V)", (x, ci, c) => ({ f: `=${c}${WR.de}/(1+${c}${WR.de})`, r: x.dv_w }), FMT.pct, "D/E / (1 + D/E)"],
    ["wacc", "WACC", (x, ci, c) => ({ f: `=${c}${WR.ke}*${c}${WR.ev}+${c}${WR.kdat}*${c}${WR.dv}`, r: x.wacc }), FMT.pct2, "Ke × E/V + Kd(세후) × D/V"]
  ];
  r = 5;
  wrows.forEach(([k]) => { WR[k] = r++; });
  wrows.forEach(([k, label, fn, fmt, note]) => {
    S.put(wsW, `A${WR[k]}`, label, { bold: k === "wacc" });
    M.cos.forEach((x, ci) => { const c = colName(2 + ci); S.put(wsW, `${c}${WR[k]}`, fn(x, ci, c), { fmt, bold: k === "wacc", fill: k === "wacc" ? "FFF2CC" : undefined }); });
    S.put(wsW, `${colName(2 + M.cos.length)}${WR[k]}`, note);
  });
  setup(wsW, conf, { freeze: [1, 4] });
  }

  // ===== DCF =====
  const DR = [];
  if (MT.dcf) M.cos.forEach((x, ci) => {
    const ws = wsD[ci], sh = ws.name, c = x.c, H = x.H, N = x.N, fr = FR[ci], ca = CA[ci];
    S.title(ws, `${c.name} — DCF(FCFF, 기간 중간 할인)`, `단위: ${unit} · 평가기준일 ${date} · 할인기간 = 예측 연차 − 0.5`);
    ws.columns = [{ width: 26 }].concat(Array.from({ length: H + N + 1 }, () => ({ width: 12 }))).concat([{ width: 36 }]);
    const hc = (i) => colName(2 + i), fc = (i) => colName(2 + H + i), lastH = hc(H - 1);
    S.head(ws, 4, [["A", "구분"]].concat(c.history.years.map((y, i) => [hc(i), String(y) + " A"])).concat(c.forecast.years.map((y, i) => [fc(i), String(y)])));
    const R = { rev: 5, g: 6, op: 7, m: 8, tax: 9, nopat: 10, da: 11, capex: 12, nwc: 13, dnwc: 14, fcff: 15, t: 16, w: 17, df: 18, pv: 19 };
    const labels = { rev: "매출액", g: "매출 성장률", op: "영업이익", m: "영업이익률", tax: "영업이익 법인세", nopat: "세후영업이익(NOPAT)", da: "감가상각비", capex: "CAPEX", nwc: "순운전자본", dnwc: "순운전자본 증가", fcff: "FCFF", t: "할인기간(년)", w: "WACC", df: "할인계수", pv: "FCFF 현재가치" };
    Object.entries(R).forEach(([k, rr]) => S.put(ws, `A${rr}`, labels[k], { bold: k === "fcff" }));
    // 과거 실적(재무자료 참조)
    for (let i = 0; i < H; i++) {
      const col = hc(i), fcol = colName(2 + i);
      S.put(ws, `${col}${R.rev}`, { f: `='재무자료'!${fcol}${fr.rev}`, r: x.hist.rev[i], link: 1 }, { fmt: FMT.amt });
      if (i) S.put(ws, `${col}${R.g}`, { f: `=${col}${R.rev}/${hc(i - 1)}${R.rev}-1`, r: x.hist.rev[i] / x.hist.rev[i - 1] - 1 }, { fmt: FMT.pct });
      S.put(ws, `${col}${R.op}`, { f: `='재무자료'!${fcol}${fr.op}`, r: x.hist.op[i], link: 1 }, { fmt: FMT.amt });
      S.put(ws, `${col}${R.m}`, { f: `=${col}${R.op}/${col}${R.rev}`, r: x.hist.op[i] / x.hist.rev[i] }, { fmt: FMT.pct });
      S.put(ws, `${col}${R.da}`, { f: `='재무자료'!${fcol}${fr.da}`, r: x.hist.da[i], link: 1 }, { fmt: FMT.amt });
      S.put(ws, `${col}${R.capex}`, { f: `='재무자료'!${fcol}${fr.capex}`, r: x.hist.capex[i], link: 1 }, { fmt: FMT.amt });
      S.put(ws, `${col}${R.nwc}`, { f: `='재무자료'!${fcol}${fr.nwc}`, r: x.hist.nwc[i], link: 1 }, { fmt: FMT.amt });
    }
    const aCol = (i) => colName(3 + i); // 가정 시트의 연도 열(B열은 단일 값)
    for (let i = 0; i < N; i++) {
      const col = fc(i), prev = i ? fc(i - 1) : lastH, ac = aCol(i);
      S.put(ws, `${col}${R.g}`, { f: `='가정'!${ac}${ca.g}`, r: x.fa.g[i], link: 1 }, { fmt: FMT.pct });
      S.put(ws, `${col}${R.rev}`, { f: `=${prev}${R.rev}*(1+${col}${R.g})`, r: x.rev[i] }, { fmt: FMT.amt });
      S.put(ws, `${col}${R.m}`, { f: `='가정'!${ac}${ca.m}`, r: x.fa.m[i], link: 1 }, { fmt: FMT.pct });
      S.put(ws, `${col}${R.op}`, { f: `=${col}${R.rev}*${col}${R.m}`, r: x.op[i] }, { fmt: FMT.amt });
      S.put(ws, `${col}${R.tax}`, { f: `=${col}${R.op}*${AR.tax}`, r: x.tax[i] }, { fmt: FMT.amt });
      S.put(ws, `${col}${R.nopat}`, { f: `=${col}${R.op}-${col}${R.tax}`, r: x.nopat[i] }, { fmt: FMT.amt });
      S.put(ws, `${col}${R.da}`, { f: `=${col}${R.rev}*'가정'!${ac}${ca.da}`, r: x.da[i] }, { fmt: FMT.amt });
      S.put(ws, `${col}${R.capex}`, { f: `=${col}${R.rev}*'가정'!${ac}${ca.cp}`, r: x.capex[i] }, { fmt: FMT.amt });
      S.put(ws, `${col}${R.nwc}`, { f: `=${col}${R.rev}*'가정'!${ac}${ca.nw}`, r: x.nwc[i] }, { fmt: FMT.amt });
      S.put(ws, `${col}${R.dnwc}`, { f: `=${col}${R.nwc}-${prev}${R.nwc}`, r: x.dnwc[i] }, { fmt: FMT.amt });
      S.put(ws, `${col}${R.fcff}`, { f: `=${col}${R.nopat}+${col}${R.da}-${col}${R.capex}-${col}${R.dnwc}`, r: x.fcff[i] }, { fmt: FMT.amt, bold: true });
      S.put(ws, `${col}${R.t}`, x.t[i], { fmt: FMT.yr });
      S.put(ws, `${col}${R.w}`, { f: `='WACC'!$${colName(2 + ci)}$${WR.wacc}`, r: x.wacc, link: 1 }, { fmt: FMT.pct2 });
      S.put(ws, `${col}${R.df}`, { f: `=1/(1+${col}${R.w})^${col}${R.t}`, r: x.dfac[i] }, { fmt: "0.0000" });
      S.put(ws, `${col}${R.pv}`, { f: `=${col}${R.fcff}*${col}${R.df}`, r: x.pv[i] }, { fmt: FMT.amt });
    }
    const f0 = fc(0), fN = fc(N - 1), rngF = `$${f0}$${R.fcff}:$${fN}$${R.fcff}`, rngT = `$${f0}$${R.t}:$${fN}$${R.t}`;
    const wRef = `'WACC'!$${colName(2 + ci)}$${WR.wacc}`;
    // 가치 산정
    r = 21;
    S.head(ws, r, [["A", "가치 산정"], ["B", "금액"], ["C", "산식·근거"]]); ws.mergeCells(`C${r}:${colName(Math.max(4, 2 + H + N))}${r}`); r++;
    const V = {};
    const vrow = (k, label, v, fmt, note, o) => { S.put(ws, `A${r}`, label, { bold: o && o.bold }); S.put(ws, `B${r}`, v, Object.assign({ fmt }, o || {})); S.put(ws, `C${r}`, note || ""); ws.mergeCells(`C${r}:${colName(Math.max(4, 2 + H + N))}${r}`); V[k] = r++; };
    vrow("sumpv", "예측기간 FCFF 현재가치 합계", { f: `=SUM(${f0}${R.pv}:${fN}${R.pv})`, r: x.sumPv }, FMT.amt, "");
    vrow("g", "영구성장률", { f: `=${AR.g}`, r: G.g, link: 1 }, FMT.pct2, "가정");
    vrow("tv", "영구가치(예측기간 말)", { f: `=${fN}${R.fcff}*(1+B${r - 1})/(${fN}${R.w}-B${r - 1})`, r: x.tv }, FMT.amt, "마지막 해 FCFF × (1 + g) ÷ (WACC − g)");
    vrow("pvtv", "영구가치 현재가치", { f: `=B${r - 1}*${fN}${R.df}`, r: x.pvTv }, FMT.amt, "마지막 해 할인계수 적용(기간 중간 관례)");
    vrow("ev", "영업가치(EV)", { f: `=B${V.sumpv}+B${r - 1}`, r: x.ev }, FMT.amt, "", { bold: true });
    vrow("tvw", "영구가치 비중", { f: `=B${V.pvtv}/B${V.ev}`, r: x.pvTv / x.ev }, FMT.pct, "");
    vrow("bsum", "주주가치 조정 합계", { f: `=${fr.bsum}`, r: x.bsum, link: 1 }, FMT.amt, "재무자료 시트의 조정 항목 합계(비영업자산 − 차입금·리스부채 등)");
    vrow("eq", "주주가치(100%)", { f: `=B${V.ev}+B${V.bsum}`, r: x.eq }, FMT.amt, "", { bold: true, fill: "FFF2CC" });
    vrow("sh", "유통주식수(주)", { f: `=${fr.shares}`, r: x.shares, link: 1 }, FMT.won, "자기주식 제외");
    vrow("ps", "주당가치(원)", { f: `=B${V.eq}*1000000/B${V.sh}`, r: x.ps }, FMT.won, "", { bold: true });
    // 민감도
    r++;
    const s0 = r;
    S.text(ws, `A${r}`, "민감도 — 주주가치(백만원): 행 = WACC, 열 = 영구성장률", { bold: true, color: "1F3864" }); r++;
    S.head(ws, r, [["A", "WACC \\ g"]].concat([0, 1, 2, 3, 4].map(j => [colName(2 + j), ""])));
    const gRow = r;
    [0, 1, 2, 3, 4].forEach(j => { const cl = ws.getCell(`${colName(2 + j)}${gRow}`); cl.value = { formula: `${AR.g}+(${j - 2})*${AR.gs}`, result: G.g + (j - 2) * G.gs }; cl.numFmt = FMT.pct2; });
    r++;
    const sens = [];
    [0, 1, 2, 3, 4].forEach(i => {
      S.put(ws, `A${r}`, { f: `=${wRef}+(${i - 2})*${AR.ws}`, r: x.wacc + (i - 2) * G.ws }, { fmt: FMT.pct2, bold: true, align: "center" });
      sens[i] = r;
      [0, 1, 2, 3, 4].forEach(j => {
        const gc = `${colName(2 + j)}$${gRow}`, wc = `$A${r}`;
        S.put(ws, `${colName(2 + j)}${r}`, { f: `=SUMPRODUCT(${rngF},1/(1+${wc})^${rngT})+$${fN}$${R.fcff}*(1+${gc})/(${wc}-${gc})/(1+${wc})^$${fN}$${R.t}+$B$${V.bsum}`, r: x.grid[i][j] },
          { fmt: FMT.amt, fill: i === 2 && j === 2 ? "FFF2CC" : undefined });
      });
      r++;
    });
    S.put(ws, `A${r}`, "검증: 중앙 − 주주가치 = 0"); S.put(ws, `B${r}`, { f: `=ROUND(D${sens[2]}-B${V.eq},6)`, r: 0 }, { fmt: "0.000000" }); r++;
    DR[ci] = { sh, lo: `'${sh}'!$C$${sens[3]}`, mid: `'${sh}'!$B$${V.eq}`, hi: `'${sh}'!$E$${sens[1]}`, bsum: `'${sh}'!$B$${V.bsum}`, s0 };
    setup(ws, conf, { freeze: [1, 4] });
  });

  // ===== 상대가치 =====
  const RR = [];
  const MULTS = ["EV/EBITDA", "EV/EBIT", "PER", "PBR"];
  if (MT.rel) {
  S.title(wsR, "상대가치 — 피어 배수와 대상회사 적용", `단위: ${unit}, 배수(x) · 분모 ≤ 0 이면 n/a(통계에서 제외) · 통계: COUNT·MEDIAN·QUARTILE(포함)`);
  wsR.columns = [{ width: 22 }, { width: 10 }].concat(Array.from({ length: 10 }, () => ({ width: 11 }))).concat([{ width: 30 }]);
  r = 4;
  M.cos.forEach((x, ci) => {
    const c = x.c;
    S.text(wsR, `A${r}`, `${c.name} — 피어그룹`, { bold: true, color: "1F3864", size: 10 }); r++;
    if (c.peer_note) { S.text(wsR, `A${r}`, c.peer_note, { wrap: false }); r++; }
    S.head(wsR, r, [["A", "피어"], ["B", "종목코드"], ["C", "시가총액"], ["D", "EV"], ["E", "EBITDA"], ["F", "EBIT"], ["G", "지배순이익"], ["H", "지배자본"], ["I", "EV/EBITDA"], ["J", "EV/EBIT"], ["K", "PER"], ["L", "PBR"]]);
    r++;
    const p0 = r;
    x.peers.forEach(p => {
      S.put(wsR, `A${r}`, p.name); S.put(wsR, `B${r}`, String(p.code || ""), { align: "center" });
      [["C", p.mc], ["D", p.ev], ["E", p.ebitda], ["F", p.ebit], ["G", p.ni], ["H", p.eq]].forEach(([cc, v]) => S.put(wsR, `${cc}${r}`, isNum(v) ? v : "n/a", { fmt: FMT.amt }));
      const mf = (n, d) => `=IF(AND(ISNUMBER(${n}${r}),ISNUMBER(${d}${r})),IF(${d}${r}>0,${n}${r}/${d}${r},"n/a"),"n/a")`;
      S.put(wsR, `I${r}`, { f: mf("D", "E"), r: p.m["EV/EBITDA"] }, { fmt: FMT.mult });
      S.put(wsR, `J${r}`, { f: mf("D", "F"), r: p.m["EV/EBIT"] }, { fmt: FMT.mult });
      S.put(wsR, `K${r}`, { f: mf("C", "G"), r: p.m.PER }, { fmt: FMT.mult });
      S.put(wsR, `L${r}`, { f: mf("C", "H"), r: p.m.PBR }, { fmt: FMT.mult });
      r++;
    });
    const p1 = Math.max(p0, r - 1);
    const st = {};
    [["n", "표본 수", (rg) => `COUNT(${rg})`, (s) => s.n, "0"], ["med", "중앙값", (rg) => `IF(COUNT(${rg})>0,MEDIAN(${rg}),"n/a")`, (s) => s.med, FMT.mult],
     ["q1", "1사분위(Q1)", (rg) => `IF(COUNT(${rg})>0,QUARTILE(${rg},1),"n/a")`, (s) => s.q1, FMT.mult], ["q3", "3사분위(Q3)", (rg) => `IF(COUNT(${rg})>0,QUARTILE(${rg},3),"n/a")`, (s) => s.q3, FMT.mult],
     ["avg", "평균(참고)", (rg) => `IF(COUNT(${rg})>0,AVERAGE(${rg}),"n/a")`, (s) => s.avg, FMT.mult]].forEach(([k, label, ff, vv, fmt]) => {
      S.put(wsR, `A${r}`, label, { bold: k === "med" });
      ["I", "J", "K", "L"].forEach((cc, j) => S.put(wsR, `${cc}${r}`, { f: "=" + ff(`${cc}${p0}:${cc}${p1}`), r: vv(x.stats[MULTS[j]]) }, { fmt, bold: k === "med" }));
      st[k] = r++;
    });
    r++;
    S.head(wsR, r, [["A", "대상회사 적용"], ["B", "대상 지표"], ["C", "배수 Q1"], ["D", "배수 중앙"], ["E", "배수 Q3"], ["F", "주주가치 하단"], ["G", "주주가치 중앙"], ["H", "주주가치 상단"], ["I", "산식"]]);
    wsR.mergeCells(`I${r}:L${r}`); r++;
    const ap = {};
    const tm = c.target_metrics || {};
    const metricRow = { "EV/EBITDA": ["EBITDA(최근 12개월)", "ebitda", "I"], "EV/EBIT": ["EBIT(최근 12개월)", "ebit", "J"], PER: ["지배순이익(최근 12개월)", "net_income", "K"], PBR: ["지배자본(기준일)", "equity", "L"] };
    MULTS.forEach(k => {
      const [mlabel, mk, mc] = metricRow[k], isEv = k.startsWith("EV");
      S.put(wsR, `A${r}`, k + (k === "PBR" && !x.useP ? " (참고)" : ""));
      S.put(wsR, `B${r}`, isNum(num(tm[mk])) ? num(tm[mk]) : "n/a", { fmt: FMT.amt });
      S.put(wsR, `C${r}`, { f: `=${mc}${st.q1}`, r: x.stats[k].q1 }, { fmt: FMT.mult });
      S.put(wsR, `D${r}`, { f: `=${mc}${st.med}`, r: x.stats[k].med }, { fmt: FMT.mult });
      S.put(wsR, `E${r}`, { f: `=${mc}${st.q3}`, r: x.stats[k].q3 }, { fmt: FMT.mult });
      const add = isEv ? `+${FR[ci].bsum}` : "";
      const vf = (cc) => `=IF(AND(ISNUMBER($B${r}),ISNUMBER(${cc}${r})),IF($B${r}>0,$B${r}*${cc}${r}${add},"n/a"),"n/a")`;
      S.put(wsR, `F${r}`, { f: vf("C"), r: x.app[k].lo }, { fmt: FMT.amt });
      S.put(wsR, `G${r}`, { f: vf("D"), r: x.app[k].mid }, { fmt: FMT.amt, bold: true });
      S.put(wsR, `H${r}`, { f: vf("E"), r: x.app[k].hi }, { fmt: FMT.amt });
      S.put(wsR, `I${r}`, isEv ? `${mlabel} × 배수 + 주주가치 조정(재무자료)` : `${mlabel} × 배수`); wsR.mergeCells(`I${r}:L${r}`);
      ap[k] = r++;
    });
    RR[ci] = ap; r += 2;
  });
  setup(wsR, conf, { freeze: [0, 3] });
  }

  // ===== 요약 =====
  // 행 구성: 둘 다 = DCF·배수 4종·상대가치 종합·적정가치·시장가치 / DCF만 = DCF(적정가치)·시장가치 / 상대가치만 = 배수 4종·상대가치 종합(적정가치)·시장가치
  // 색: 적정가치 산정 요소 남색, 배수 청록, 최종 비교(적정가치·시장가치) 주황. 방법이 하나면 그 결과가 적정가치라 주황.
  S.title(wsSum, "평가 요약 — 방법별 주주가치 비교와 적정가치 범위", `단위: ${unit}(주당가치 원) · 100% 주주가치(지배권 프리미엄·시너지 제외) · 평가기준일 ${date}`);
  wsSum.columns = [{ width: 26 }, { width: 22 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 13 }, { width: 40 }, { width: 2 }, { width: 9 }, { width: 9 }, { width: 9 }, { width: 9 }, { width: 9 }, { width: 9 }, { width: 2 }];
  r = 4;
  const charts = [];
  const BOTH = MT.dcf && MT.rel;
  const PLOT_PX = 420;            // 차트 막대 영역 폭(px) 추정 — 9열 차트에서 범주 이름을 뺀 폭
  const AXIS = 1.25;              // 축 최댓값 ≈ 최대 상단 × 1.25 (라벨자리 0.15 + 눈금 반올림)
  const CH_PX = 0.733;            // 굵은 숫자 한 글자 폭 ≈ 0.733 × 글자 크기(pt) px
  M.cos.forEach((x, ci) => {
    const c = x.c;
    S.text(wsSum, `A${r}`, `${c.name}${c.code ? ` (${c.code})` : ""}`, { bold: true, color: "1F3864", size: 11 }); r++;
    S.head(wsSum, r, [["A", "방법"], ["B", "적용 기준"], ["C", "하단"], ["D", "중앙"], ["E", "상단"], ["F", "주당가치(원, 중앙)"], ["G", "비고"], ["I", "차트 하단(억원)"], ["J", "차트 폭(억원)"], ["K", "라벨 자리(억원)"], ["L", "하단 라벨"], ["M", "중앙 라벨"], ["N", "상단 라벨"]]);
    r++;
    const rs = r, ap = RR[ci], dr = DR[ci], shRef = FR[ci].shares;
    const colors = [];
    const psF = (rr, mid) => ({ f: `=IF(ISNUMBER(D${rr}),ROUND(D${rr}*1000000/${shRef},0),"n/a")`, r: isNum(mid) ? Math.round(mid * 1e6 / x.shares) : NaN });
    const row = (m, b, lo, mid, hi, note, color, o) => {
      o = o || {};
      S.put(wsSum, `A${r}`, m, { bold: o.bold, fill: o.fill }); S.put(wsSum, `B${r}`, b);
      S.put(wsSum, `C${r}`, lo, { fmt: FMT.amt, bold: o.bold, fill: o.fill }); S.put(wsSum, `D${r}`, mid, { fmt: FMT.amt, bold: o.bold, fill: o.fill }); S.put(wsSum, `E${r}`, hi, { fmt: FMT.amt, bold: o.bold, fill: o.fill });
      S.put(wsSum, `F${r}`, psF(r, mid.r), { fmt: FMT.won, bold: o.bold, fill: o.fill });
      S.put(wsSum, `G${r}`, note || "");
      colors.push(color);
      return r++;
    };
    let rdcf = null, rcomp = null, rfv;
    const FAIR = { bold: true, fill: "FFF2CC" };
    if (MT.dcf) {
      rdcf = row(BOTH ? "DCF" : "DCF (적정가치)", `WACC ±${(G.ws * 100).toFixed(1)}%p · g ±${(G.gs * 100).toFixed(1)}%p`,
        { f: `=${dr.lo}`, r: x.dcf.lo, link: 1 }, { f: `=${dr.mid}`, r: x.dcf.mid, link: 1 }, { f: `=${dr.hi}`, r: x.dcf.hi, link: 1 },
        "하단 = WACC↑·g↓ 모서리, 상단 = WACC↓·g↑ 모서리", BOTH ? NAVY : ORANGE, BOTH ? {} : FAIR);
    }
    if (MT.rel) {
      const mrows = {};
      MULTS.forEach(k => {
        mrows[k] = row(k === "PBR" && !x.useP ? "(참고) PBR" : "상대가치 " + k, "피어 Q1·중앙·Q3",
          { f: `='상대가치'!$F$${ap[k]}`, r: x.app[k].lo, link: 1 }, { f: `='상대가치'!$G$${ap[k]}`, r: x.app[k].mid, link: 1 }, { f: `='상대가치'!$H$${ap[k]}`, r: x.app[k].hi, link: 1 },
          k === "PBR" && !x.useP ? (c.pbr_note || "참고로만 표시하고 상대가치 종합에서 제외") : "", TEAL);
      });
      const dl = x.compKeys.map(k => `D${mrows[k]}`).join(",");
      rcomp = row(BOTH ? "상대가치 종합" : "상대가치 종합 (적정가치)", `${x.compKeys.length}개 배수 중앙값`,
        { f: `=IF(COUNT(${dl})>0,MIN(${dl}),"n/a")`, r: x.comp.lo }, { f: `=IF(COUNT(${dl})>0,AVERAGE(${dl}),"n/a")`, r: x.comp.mid }, { f: `=IF(COUNT(${dl})>0,MAX(${dl}),"n/a")`, r: x.comp.hi },
        "하단·상단 = 배수별 중앙값의 최소·최대, 중앙 = 평균", BOTH ? NAVY : ORANGE, BOTH ? { bold: true } : FAIR);
    }
    if (BOTH) {
      const fvF = (cc, key) => ({ f: `=IF(ISNUMBER(${cc}${rcomp}),${AR.w}*${cc}${rdcf}+(1-${AR.w})*${cc}${rcomp},${cc}${rdcf})`, r: x.fv[key] });
      rfv = row("적정가치(가중)", { f: `="DCF "&TEXT(${AR.w},"0%")&" + 상대가치 "&TEXT(1-${AR.w},"0%")`, r: `DCF ${Math.round(G.w * 100)}% + 상대가치 ${Math.round((1 - G.w) * 100)}%` },
        fvF("C", "lo"), fvF("D", "mid"), fvF("E", "hi"), "같은 행의 하단·중앙·상단끼리 가중평균", ORANGE, FAIR);
    } else rfv = MT.dcf ? rdcf : rcomp;
    let re = r - 1;
    if (x.listed) {
      const rmk = row("시장가치", "시가총액",
        { f: `=MIN(${FR[ci].mc},${FR[ci].mc2})`, r: x.mkt.lo, link: 1 }, { f: `=${FR[ci].mc}`, r: x.mkt.mid, link: 1 }, { f: `=MAX(${FR[ci].mc},${FR[ci].mc2})`, r: x.mkt.hi, link: 1 },
        "최종 비교 대상. 중앙 = 평가기준일 종가 시가총액", ORANGE, { bold: true });
      re = rmk;
      S.put(wsSum, `A${r}`, "적정가치 / 시가총액 − 1");
      ["C", "D", "E"].forEach((cc, j) => S.put(wsSum, `${cc}${r}`, { f: `=IFERROR(${cc}${rfv}/$D$${rmk}-1,"n/a")`, r: x.fv[["lo", "mid", "hi"][j]] / x.mkt.mid - 1 }, { fmt: FMT.pct }));
      r++;
    }
    // 차트 도우미 열(억원) — 수식이라 가정을 바꾸면 차트도 바뀐다
    const vals = []; for (let rr = rs; rr <= re; rr++) vals.push(rr);
    const getv = (rr, col) => { const cell = wsSum.getCell(`${col}${rr}`).value; return cell && typeof cell === "object" ? cell.result : cell; };
    const E = vals.map(rr => getv(rr, "E")).filter(isNum), maxE = E.length ? Math.max(...E) : 0;
    const lo = [], wd = [], gap = [], llo = [], lmid = [], lhi = [], cats = [], midSize = [];
    const fmtN = (v) => Math.round(v).toLocaleString("en-US");
    vals.forEach((rr, i) => {
      const C = getv(rr, "C"), D = getv(rr, "D"), Ev = getv(rr, "E");
      const ok = isNum(C) && isNum(D) && isNum(Ev);
      const same = ok && Math.round(C / 100) === Math.round(Ev / 100);
      const w = ok ? Math.max(Ev - C, maxE * 0.006) / 100 : 0;
      // 중앙값: 막대 안에 흰 글자. 막대 폭에 맞춰 9pt부터 6pt까지 줄이고, 6pt로도 안 들어가면 쓰지 않는다
      const ratio = maxE ? w / (maxE / 100 * AXIS) : 0;
      const txt = ok ? fmtN(D / 100) : "";
      const fitPt = Math.floor((ratio * PLOT_PX - 4) / (CH_PX * Math.max(1, txt.length)));
      const nomid = !ok || same || Math.round(D / 100) === Math.round(C / 100) || Math.round(D / 100) === Math.round(Ev / 100) || fitPt < 6;
      cats.push(wsSum.getCell(`A${rr}`).value);
      lo.push(ok ? C / 100 : 0); wd.push(w); gap.push(maxE / 100 * 0.15);
      llo.push(!ok || same ? "" : fmtN(C / 100));
      lmid.push(nomid ? "" : txt); midSize.push(Math.min(9, Math.max(6, fitPt)));
      lhi.push(!ok ? "" : same ? fmtN(D / 100) : fmtN(Ev / 100));
      const SAME = `ROUND(C${rr}/100,0)=ROUND(E${rr}/100,0)`, OK = `AND(ISNUMBER(C${rr}),ISNUMBER(D${rr}),ISNUMBER(E${rr}))`;
      const FIT = `(J${rr}/(MAX($E$${rs}:$E$${re})/100*${AXIS}))*${PLOT_PX}-4<${CH_PX}*6*LEN(TEXT(D${rr}/100,"#,##0"))`;
      const NOMID = `OR(NOT(${OK}),${SAME},ROUND(D${rr}/100,0)=ROUND(C${rr}/100,0),ROUND(D${rr}/100,0)=ROUND(E${rr}/100,0),${FIT})`;
      const hp = { size: 8, color: "808080" };
      S.put(wsSum, `I${rr}`, { f: `=IF(${OK},C${rr}/100,0)`, r: lo[i] }, Object.assign({ fmt: FMT.amt1 }, hp));
      S.put(wsSum, `J${rr}`, { f: `=IF(${OK},MAX(E${rr}-C${rr},MAX($E$${rs}:$E$${re})*0.006)/100,0)`, r: w }, Object.assign({ fmt: FMT.amt1 }, hp));
      S.put(wsSum, `K${rr}`, { f: `=MAX($E$${rs}:$E$${re})/100*0.15`, r: gap[i] }, Object.assign({ fmt: FMT.amt1 }, hp));
      S.put(wsSum, `L${rr}`, { f: `=IF(OR(NOT(${OK}),${SAME}),"",TEXT(C${rr}/100,"#,##0"))`, r: llo[i] }, Object.assign({ align: "right" }, hp));
      S.put(wsSum, `M${rr}`, { f: `=IF(${NOMID},"",TEXT(D${rr}/100,"#,##0"))`, r: lmid[i] }, Object.assign({ align: "right" }, hp));
      S.put(wsSum, `N${rr}`, { f: `=IF(NOT(${OK}),"",IF(${SAME},TEXT(D${rr}/100,"#,##0"),TEXT(E${rr}/100,"#,##0")))`, r: lhi[i] }, Object.assign({ align: "right" }, hp));
    });
    const leg = [];
    if (BOTH) leg.push(["■ 적정가치 산정 요소(DCF·상대가치 종합)", NAVY]);
    if (MT.rel) leg.push(["■ 상대가치 산정 배수(EV/EBITDA·EV/EBIT·PER·PBR)", TEAL]);
    leg.push([x.listed ? `■ 최종 비교(${BOTH ? "적정가치" : MT.dcf ? "DCF = 적정가치" : "상대가치 종합 = 적정가치"} vs 시장가치)` : `■ 적정가치${BOTH ? "" : MT.dcf ? "(DCF)" : "(상대가치 종합)"}`, ORANGE]);
    leg.forEach(([t, col], k) => S.text(wsSum, `I${re + 2 + k}`, t, { bold: true, color: col, size: 8 }));
    charts.push({
      sheetName: "요약",
      anchor: { c1: 15, r1: rs - 3, c2: 24, r2: rs - 3 + Math.max(12, 6 + vals.length * 2) },
      xml: rangeChartXml({ sheet: "요약", title: `${c.name} 방법별 주주가치(억원)`, r1: rs, r2: re, cols: { lo: "I", wd: "J", gap: "K", llo: "L", lmid: "M", lhi: "N" },
        cats, lo, wd, gap, llo, lmid, lhi, colors, font, midText: "FFFFFF", midFill: null, midSize })
    });
    r = Math.max(r + 1, rs - 3 + Math.max(12, 6 + vals.length * 2) + 2, re + 2 + leg.length + 1);
  });
  S.text(wsSum, `A${r}`, "해석 유의: DCF는 할인율·성장률 가정에, PER은 일회성 영업외손익에 민감하므로 하단·상단 범위로 판단할 것. 상장 피어 배수는 유동성 있는 소수지분 가격임.", { wrap: true });
  wsSum.mergeCells(`A${r}:G${r + 1}`); wsSum.getRow(r).height = 28;
  setup(wsSum, conf, { freeze: [1, 3] });

  // ===== 표지 =====
  S.title(wsCover, spec.title || `${names.join("·")} 가치평가`, (meta && meta.dept) || "");
  wsCover.columns = [{ width: 22 }, { width: 90 }];
  r = 4;
  const kv = [
    ["대상회사", M.cos.map(x => x.c.name + (x.c.code ? ` (${x.c.code})` : "")).join(", ")],
    ["평가기준일", date],
    ["평가 대상 가치", "100% 주주가치(지배권 프리미엄·시너지 제외)"],
    ["평가 방법", MT.dcf && MT.rel ? `DCF(FCFF, 기간 중간 할인) ${Math.round(G.w * 100)}% + 상대가치(피어 배수) ${Math.round((1 - G.w) * 100)}% 가중 — 최종 비교: 적정가치 vs 시장가치`
      : MT.dcf ? "DCF(FCFF, 기간 중간 할인) — DCF 결과가 적정가치, 최종 비교: DCF vs 시장가치" : "상대가치(피어 배수) — 상대가치 종합이 적정가치, 최종 비교: 상대가치 종합 vs 시장가치"],
    ["단위", `${unit}(보고서·차트는 억원), 주당가치 원`],
    ["작성", [(meta && meta.brand) || "", (meta && meta.agent) || "", (meta && meta.date) || ""].filter(Boolean).join(" · ")],
    ["시트 안내", "요약(방법별 결과·적정가치·차트) → 가정(바꿀 값) → 재무자료(공시 원자료·주주가치 조정 항목)" + (MT.dcf ? " → WACC → DCF_회사" : "") + (MT.rel ? " → 상대가치(피어 배수)" : "")],
    ["글자색 범례", "파랑 = 입력값, 검정 = 계산식, 녹색 = 다른 시트 참조, 노란 바탕 = 결과에 영향이 큰 핵심 가정·결과"],
    ["차트 색", (MT.dcf && MT.rel ? "남색 = 적정가치 산정 요소(DCF·상대가치 종합), " : "") + (MT.rel ? "청록 = 상대가치 산정 배수, " : "") + "주황 = 최종 비교(적정가치·시장가치). 막대 왼쪽 = 하단, 오른쪽 = 상단, 막대 안 흰 글자 = 중앙값(막대가 짧으면 생략)"],
    ["다시 계산", "파일을 열면 전 시트가 다시 계산됨(Excel·Google 스프레드시트). 가정 시트의 파란 글자를 바꾸면 요약·차트까지 바뀜"],
    ["유의사항", spec.disclaimer || "공시·시장 자료로 만든 참고용 모델이며 평가 의견·투자 권유가 아님. 실사 결과와 거래 조건에 따라 달라질 수 있음"],
    ["자료", spec.source || ""]
  ];
  kv.forEach(([k, v]) => { S.put(wsCover, `A${r}`, k, { bold: true, fill: "EEF2F8" }); S.put(wsCover, `B${r}`, v, { wrap: true }); wsCover.getRow(r).height = 30; r++; });
  setup(wsCover, conf);

  const buf = await wb.xlsx.writeBuffer();
  const out = await injectCharts(Buffer.from(buf), charts);
  return { buffer: out, title: spec.title || `${names.join("·")} 가치평가`, summary: M.cos.map(x => ({ name: x.c.name, dcf: x.dcf, comp: x.comp, fair: x.fv, market: x.mkt, wacc: x.wacc })) };
}

module.exports = { buildValuationWorkbook, compute, validate };
