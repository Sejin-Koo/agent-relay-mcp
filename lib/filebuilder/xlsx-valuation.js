// 원본: 계정 스킬 sys-file-builder — 업무 에이전트 중계 서버의 lib/filebuilder/는 이 파일의 사본이다(사본을 직접 고치지 않는다).
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
// 날짜: "2026-10-22" → UTC Date, 엑셀 일련번호
function parseDate(s) {
  const m = String(s || "").match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}
const serial = (d) => (d.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
const yearOf = (label, d) => { const m = String(label || "").match(/(19|20)\d{2}/); return m ? +m[0] : d; };
// 비상장사 참고가격 3종(사용자가 비교 기준을 고른다)
const REF_KEYS = ["tx", "supp", "book"];
const REF_LABEL = { tx: "최근 거래가격", supp: "보충적 평가액", book: "장부 순자산" };

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
      if (num(c.beta_unlevered) === null && !(c.beta_from_peers && Array.isArray(c.peers) && c.peers.some(q => num(q.beta_levered) !== null))) errs.push(`${p}.beta_unlevered가 없습니다(또는 beta_from_peers와 피어 beta_levered)`);
      const h = c.history || {};
      if (!Array.isArray(h.years) || !h.years.length) errs.push(`${p}.history.years가 없습니다`);
      const hasNwcParts = ["receivables", "inventory", "payables"].every(k => Array.isArray(h[k]));
      ["revenue", "operating_income", "depreciation", "capex"].concat(hasNwcParts ? ["receivables", "inventory", "payables"] : ["nwc"]).forEach(k => { if (!Array.isArray(h[k]) || h[k].length !== (h.years || []).length) errs.push(`${p}.history.${k} 길이가 years와 다릅니다`); });
      const f = c.forecast || {};
      if (!Array.isArray(f.years) || f.years.length < 2) errs.push(`${p}.forecast.years는 2개 이상이어야 합니다`);
      ["growth_pct", "margin_pct", "da_pct", "capex_pct", "nwc_pct"].forEach(k => { if (f[k] === undefined) errs.push(`${p}.forecast.${k}가 없습니다`); });
      if (c.stub) {
        const sp = ["receivables", "inventory", "payables"].every(k => num(c.stub[k]) !== null);
        ["revenue", "operating_income"].concat(sp ? [] : ["nwc"]).forEach(k => { if (num(c.stub[k]) === null) errs.push(`${p}.stub.${k}가 숫자가 아닙니다`); });
        if (!parseDate(spec.valuation_date)) errs.push("stub(반기 실적)을 쓰려면 valuation_date가 YYYY-MM-DD여야 합니다");
      }
    }
    if (c.market_prices) {
      const d = c.market_prices.days;
      if (!Array.isArray(d) || !d.length) errs.push(`${p}.market_prices.days가 비었습니다`);
      else d.forEach((x, j) => { if (!parseDate(x.date) || num(x.volume) === null || num(x.value) === null) errs.push(`${p}.market_prices.days[${j}]에 date·volume·value가 필요합니다`); });
      if (!parseDate(spec.valuation_date)) errs.push("market_prices를 쓰려면 valuation_date가 YYYY-MM-DD여야 합니다");
    }
    if (c.supplementary) {
      const s = c.supplementary;
      if (!Array.isArray(s.net_income) || s.net_income.length !== 3 || s.net_income.some(v => num(v) === null)) errs.push(`${p}.supplementary.net_income은 최근 3개 사업연도 순손익 3개(오래된 해 → 최근 해)여야 합니다`);
      if (num(s.shares_issued) === null) errs.push(`${p}.supplementary.shares_issued가 없습니다`);
      if (num(s.net_assets) === null) errs.push(`${p}.supplementary.net_assets가 없습니다`);
    }
    if (MT.rel) {
      if (!Array.isArray(c.peers) || !c.peers.length) errs.push(`${p}.peers가 비었습니다`);
      const canTtm = c.stub && c.stub.prior && num(c.net_income_ttm) !== null && num(c.equity_parent) !== null;
      if (!c.target_metrics && !canTtm) errs.push(`${p}.target_metrics가 없습니다(또는 stub.prior·net_income_ttm·equity_parent로 최근 12개월 값을 만들 수 있어야 합니다)`);
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
    const cont = num(c.contingent_adjustment) !== null ? num(c.contingent_adjustment) : null;
    const bsum = bridge.reduce((s, b) => s + b.amount, 0) + (cont || 0);
    const shares = num(c.shares_outstanding);
    const o = { c, bridge, bsum, cont, shares, dcf: NA, comp: NA, peers: [], stats: {}, app: {} };
    // 피어: 원자료(시가총액·이자부부채·현금·단기금융상품·비지배지분, 매출·영업이익·감가상각비)가 있으면 EV·EBITDA를 수식으로 만든다
    const rr = (a, b) => (isNum(a) && isNum(b) && b > 0) ? a / b : NaN;
    const peers = (c.peers || []).map(q => {
      const mc = num(q.market_cap), ibd = num(q.ibd), cash = num(q.cash), sti = num(q.short_term_investments), nci = num(q.nci);
      const rev = num(q.revenue), opi = num(q.operating_income), dap = num(q.depreciation);
      const raw = ibd !== null && mc !== null;
      const ev2 = raw ? mc + ibd - (cash || 0) - (sti || 0) + (nci || 0) : num(q.ev);
      const ebitda = (opi !== null && dap !== null) ? opi + dap : num(q.ebitda);
      const ebit = opi !== null ? opi : num(q.ebit);
      const ni = num(q.net_income), eqp = num(q.equity), bl = num(q.beta_levered);
      const dE = (raw && isNum(mc) && mc > 0) ? ibd / mc : NaN;
      const bU = (isNum(bl) && isNum(dE)) ? bl / (1 + (1 - G.tax) * dE) : NaN;
      return { name: q.name || "", code: q.code || "", raw, mc, ibd, cash, sti, nci, ev: ev2, rev, opi, dap, ebitda, ebit, ni, eq: eqp, bl, de: dE, bu: bU,
        m: { "EV/매출": rr(ev2, rev), "EV/EBITDA": rr(ev2, ebitda), "EV/EBIT": rr(ev2, ebit), PER: rr(mc, ni), PBR: rr(mc, eqp) } };
    });
    const pstat = (vals) => ({ n: vals.length, med: median(vals), q1: quartile(vals, 1), q3: quartile(vals, 3), avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN });
    o.peers = peers;
    o.pbeta = { bu: pstat(peers.map(q => q.bu).filter(isNum)), de: pstat(peers.map(q => q.de).filter(isNum)) };
    o.betaFromPeers = !!c.beta_from_peers && isNum(o.pbeta.bu.med);
    if (MT.dcf) {
      const h = c.history, f = c.forecast, N = f.years.length, H = h.years.length;
      const hv = (k) => h[k].map(num);
      const parts = ["receivables", "inventory", "payables"].every(k => Array.isArray(h[k]));
      const hist = { rev: hv("revenue"), op: hv("operating_income"), da: hv("depreciation"), capex: hv("capex"),
        ar: parts ? hv("receivables") : null, inv: parts ? hv("inventory") : null, ap: parts ? hv("payables") : null };
      hist.nwc = parts ? hist.ar.map((v, i) => v + hist.inv[i] - hist.ap[i]) : hv("nwc");
      const fa = { g: arrN(f.growth_pct, N).map(x => x / 100), m: arrN(f.margin_pct, N).map(x => x / 100), da: arrN(f.da_pct, N).map(x => x / 100), cp: arrN(f.capex_pct, N).map(x => x / 100), nw: arrN(f.nwc_pct, N).map(x => x / 100) };
      const bu = o.betaFromPeers ? o.pbeta.bu.med : num(c.beta_unlevered);
      const de = o.betaFromPeers && isNum(o.pbeta.de.med) ? o.pbeta.de.med : (num(c.target_de_pct) || 0) / 100;
      const bl = bu * (1 + (1 - G.tax) * de), ke = G.rf + bl * G.mrp + G.srp, kdat = G.kd * (1 - G.tax);
      const ev_w = 1 / (1 + de), dv_w = de / (1 + de), wacc = ke * ev_w + kdat * dv_w;
      const rev = [], op = [], tax = [], nopat = [], da = [], capex = [], nwc = [], dnwc = [], fcff = [], t = [], dfac = [], pv = [];
      // 반기 실적(stub)이 있으면: 첫 예측연도 = 당해 연간 추정, 할인하는 현금흐름은 당해 하반기(연간 − 반기 실적)부터
      const sb = c.stub || null;
      const sparts = sb && ["receivables", "inventory", "payables"].every(k => num(sb[k]) !== null);
      const st = sb ? { label: String(sb.label || "반기"), rev: num(sb.revenue), op: num(sb.operating_income), da: num(sb.depreciation) || 0, capex: num(sb.capex) || 0,
        ar: sparts ? num(sb.receivables) : null, inv: sparts ? num(sb.inventory) : null, ap: sparts ? num(sb.payables) : null,
        nwc: sparts ? num(sb.receivables) + num(sb.inventory) - num(sb.payables) : num(sb.nwc), source: sb.source || "",
        prior: sb.prior ? { label: String(sb.prior.label || "전년 동기"), rev: num(sb.prior.revenue), op: num(sb.prior.operating_income), da: num(sb.prior.depreciation) } : null } : null;
      const vd = parseDate(spec.valuation_date);
      const Y0 = yearOf(f.years[0], vd ? vd.getUTCFullYear() : 0);
      const yrs = f.years.map((y, i) => yearOf(y, Y0 + i));
      for (let i = 0; i < N; i++) {
        rev[i] = (i ? rev[i - 1] : hist.rev[H - 1]) * (1 + fa.g[i]);
        op[i] = rev[i] * fa.m[i]; tax[i] = op[i] * G.tax; nopat[i] = op[i] - tax[i];
        da[i] = rev[i] * fa.da[i]; capex[i] = rev[i] * fa.cp[i]; nwc[i] = rev[i] * fa.nw[i];
        dnwc[i] = nwc[i] - (i ? nwc[i - 1] : hist.nwc[H - 1]);
        fcff[i] = nopat[i] + da[i] - capex[i] - dnwc[i];
        t[i] = st ? (Date.UTC(yrs[i], 6, 1) - vd.getTime()) / 86400000 / 365 : i + 0.5;
        dfac[i] = 1 / Math.pow(1 + wacc, t[i]); pv[i] = fcff[i] * dfac[i];
      }
      let h2 = null;
      if (st) {
        const r2 = rev[0] - st.rev, o2 = op[0] - st.op, tx2 = o2 * G.tax, n2 = o2 - tx2, d2 = da[0] - st.da, cp2 = capex[0] - st.capex, dn2 = nwc[0] - st.nwc;
        const tDef = Math.max(0, (Date.UTC(yrs[0], 11, 31) - vd.getTime()) / 86400000 / 365 / 2);
        const th = num((c.stub || {}).discount_years) !== null ? num(c.stub.discount_years) : Math.round(tDef * 1000) / 1000;
        const fc2 = n2 + d2 - cp2 - dn2;
        h2 = { rev: r2, op: o2, tax: tx2, nopat: n2, da: d2, capex: cp2, nwc: nwc[0], dnwc: dn2, fcff: fc2, t: th, df: 1 / Math.pow(1 + wacc, th) };
        h2.pv = fc2 * h2.df;
      }
      // 할인하는 현금흐름: 반기 실적이 있으면 [하반기, 2년차…], 없으면 [1년차…]
      const CF = st ? [h2.fcff].concat(fcff.slice(1)) : fcff.slice();
      const CT = st ? [h2.t].concat(t.slice(1)) : t.slice();
      const PV = st ? [h2.pv].concat(pv.slice(1)) : pv.slice();
      const sumPv = PV.reduce((s, x) => s + x, 0);
      // 영구(Terminal) 연도: 마지막 예측연도의 세후영업이익·감가상각비·CAPEX·순운전자본을 (1 + g)배 — 순운전자본 증가 = 마지막 해 잔액 × g
      const L = N - 1, tfcf = (gg) => (nopat[L] + da[L] - capex[L]) * (1 + gg) - nwc[L] * gg;
      const term = { rev: rev[L] * (1 + G.g), op: op[L] * (1 + G.g), tax: tax[L] * (1 + G.g), nopat: nopat[L] * (1 + G.g), da: da[L] * (1 + G.g), capex: capex[L] * (1 + G.g), nwc: nwc[L] * (1 + G.g), dnwc: nwc[L] * G.g, fcff: tfcf(G.g) };
      const tv = term.fcff / (wacc - G.g), pvTv = tv * dfac[N - 1], ev = sumPv + pvTv;
      const eq = ev + bsum, ps = eq * 1e6 / shares;
      const sens = (w, g) => CF.reduce((s, x, i) => s + x / Math.pow(1 + w, CT[i]), 0) + tfcf(g) / (w - g) / Math.pow(1 + w, t[N - 1]) + bsum;
      const grid = [-2, -1, 0, 1, 2].map(a => [-2, -1, 0, 1, 2].map(b => sens(wacc + a * G.ws, G.g + b * G.gs)));
      Object.assign(o, { N, H, hist, fa, bu, de, bl, ke, kdat, ev_w, dv_w, wacc, rev, op, tax, nopat, da, capex, nwc, dnwc, fcff, t, dfac, pv, sumPv, term, tv, pvTv, ev, eq, ps, grid, st, h2, yrs, dcf: { lo: grid[3][1], mid: eq, hi: grid[1][3] } });
      // 최근 12개월(TTM) = 직전 사업연도 + 당해 반기 누적 − 전년 동기 누적
      if (st && st.prior && [st.prior.rev, st.prior.op].every(isNum)) {
        o.ttm = { rev: hist.rev[H - 1] + st.rev - st.prior.rev, op: hist.op[H - 1] + st.op - st.prior.op,
          da: isNum(st.prior.da) && isNum(hist.da[H - 1]) ? hist.da[H - 1] + st.da - st.prior.da : NaN };
        o.ttm.ebitda = isNum(o.ttm.da) ? o.ttm.op + o.ttm.da : NaN;
      }
      o.ttmNi = num(c.net_income_ttm); o.eqParent = num(c.equity_parent);
      // 내재 EV/EBITDA: 최근 12개월 EBITDA가 있으면 그것, 없으면 직전 사업연도 EBITDA 기준
      const eb = o.ttm ? o.ttm.ebitda : (isNum(hist.da[H - 1]) && isNum(hist.op[H - 1]) ? hist.op[H - 1] + hist.da[H - 1] : NaN);
      o.evEbitda = isNum(eb) && eb > 0 ? ev / eb : NaN; o.evEbitdaBase = o.ttm ? "최근 12개월" : String(h.years[H - 1]);
      o.waccTool = num(c.wacc_tool_pct) !== null ? num(c.wacc_tool_pct) / 100 : null;
    }
    if (MT.rel) {
      const tmIn = c.target_metrics || null;
      o.tmDerived = !tmIn && o.ttm && isNum(o.ttm.ebitda) && isNum(o.ttmNi) && isNum(o.eqParent);
      const tm = tmIn || (o.tmDerived ? { ebitda: o.ttm.ebitda, ebit: o.ttm.op, net_income: o.ttmNi, equity: o.eqParent, revenue: o.ttm.rev } : {});
      const metric = { "EV/EBITDA": num(tm.ebitda), "EV/EBIT": num(tm.ebit), PER: num(tm.net_income), PBR: num(tm.equity), "EV/매출": num(tm.revenue) };
      const stats = {}, app = {};
      ["EV/EBITDA", "EV/EBIT", "PER", "PBR", "EV/매출"].forEach(k => {
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
      Object.assign(o, { metric, stats, app, useP, compKeys, comp });
    }
    o.fv = MT.dcf && MT.rel
      ? (isNum(o.comp.mid) ? { lo: G.w * o.dcf.lo + (1 - G.w) * o.comp.lo, mid: G.w * o.dcf.mid + (1 - G.w) * o.comp.mid, hi: G.w * o.dcf.hi + (1 - G.w) * o.comp.hi } : o.dcf)
      : (MT.dcf ? o.dcf : o.comp);
    // 시장가격(일별 거래량·거래대금 → 1개월·1주일·최근일 거래량가중평균 → 기준주가, 자본시장법 시행령 제176조의5 방식)
    const vd = parseDate(spec.valuation_date);
    if (c.market_prices && Array.isArray(c.market_prices.days) && c.market_prices.days.length && vd) {
      const days = c.market_prices.days.map(d => ({ d: parseDate(d.date), date: String(d.date), close: num(d.close), vol: num(d.volume), val: num(d.value) }))
        .filter(d => d.d && isNum(d.vol) && isNum(d.val) && d.d.getTime() <= vd.getTime()).sort((a, b) => a.d - b.d);
      const m1 = new Date(Date.UTC(vd.getUTCFullYear(), vd.getUTCMonth() - 1, vd.getUTCDate()));
      const w1 = vd.getTime() - 7 * 86400000;
      const vw = (arr) => { const v = arr.reduce((s, d) => s + d.vol, 0); return v > 0 ? Math.round(arr.reduce((s, d) => s + d.val, 0) / v) : NaN; };
      const last = days[days.length - 1];
      const p1m = vw(days.filter(d => d.d.getTime() > m1.getTime())), p1w = vw(days.filter(d => d.d.getTime() > w1)), p1d = vw([last]);
      const base = Math.round([p1m, p1w, p1d].reduce((s, x) => s + x, 0) / 3);
      const close = num(c.market_prices.close) !== null ? num(c.market_prices.close) : last.close;
      o.mp = { days, m1, close, p1m, p1w, p1d, base, mcClose: close * shares / 1e6, mcBase: base * shares / 1e6 };
    }
    o.listed = c.listed !== false && (isNum(num(c.market_cap)) || !!o.mp);
    const mc = o.mp ? o.mp.mcClose : num(c.market_cap);
    const mc2 = o.mp ? o.mp.mcBase : (isNum(num(c.market_cap_alt)) ? num(c.market_cap_alt) : mc);
    o.mkt = o.listed ? { lo: Math.min(mc, mc2), mid: mc, hi: Math.max(mc, mc2) } : null;
    // 비상장사 참고가격 3종: ① 최근 거래가격 ② 상증세법 보충적 평가액(간이) ③ 장부 순자산 — 주주가치(백만원, 유통주식수 기준)
    o.refs = null;
    if (!o.listed) {
      const R = {};
      const tx = (Array.isArray(c.transactions) ? c.transactions : []).map(t => ({ d: parseDate(t.date), date: String(t.date || ""), kind: String(t.kind || t.type || ""), price: num(t.price_per_share), note: String(t.note || "") }))
        .filter(t => isNum(t.price)).sort((a, b) => (a.d ? a.d.getTime() : 0) - (b.d ? b.d.getTime() : 0));
      R.txRows = tx;
      R.tx = tx.length ? { lo: Math.min(...tx.map(t => t.price)) * shares / 1e6, mid: tx[tx.length - 1].price * shares / 1e6, hi: Math.max(...tx.map(t => t.price)) * shares / 1e6 } : NA;
      const s = c.supplementary;
      if (s) {
        const ni = s.net_income.map(num), si = num(s.shares_issued), na = num(s.net_assets);
        const rate = (num(s.rate_pct) !== null ? num(s.rate_pct) : 10) / 100;
        const eps = ni.map(v => v * 1e6 / si);
        const wavg = Math.max(0, (eps[2] * 3 + eps[1] * 2 + eps[0]) / 6);
        const niv = wavg / rate, nav = Math.max(0, na) * 1e6 / si;
        const reH = s.real_estate_heavy === true, navOnly = s.net_asset_only === true;
        const blend = reH ? (niv * 2 + nav * 3) / 5 : (niv * 3 + nav * 2) / 5;
        const per = navOnly ? nav : Math.max(blend, nav * 0.8);
        const prem = (num(s.majority_premium_pct) || 0) / 100;
        R.sp = { ni, si, na, rate, eps, wavg, niv, nav, reH, navOnly, blend, per, prem, years: Array.isArray(s.years) ? s.years.map(String) : ["3년 전", "2년 전", "직전"] };
        R.supp = { lo: per * shares / 1e6, mid: per * shares / 1e6, hi: per * (1 + prem) * shares / 1e6 };
      } else R.supp = NA;
      const be = num(c.book_equity) !== null ? num(c.book_equity) : (s ? num(s.net_assets) : null);
      R.bookEq = be;
      R.book = be !== null ? { lo: be, mid: be, hi: be } : NA;
      const want = String(c.reference_default || "");
      const okKeys = REF_KEYS.filter(k => isNum(R[k].mid));
      R.sel = REF_KEYS.find(k => REF_LABEL[k] === want && isNum(R[k].mid)) || (okKeys.includes("supp") ? "supp" : okKeys[0] || "supp");
      o.refs = R;
    }
    // 최대주주측 지분(발행주식 기준 지분율)
    const mh = c.major_holder;
    o.mh = mh && num(mh.stake_pct) !== null ? { name: String(mh.name || "최대주주 및 특수관계인"), stake: num(mh.stake_pct) / 100, issued: num(mh.shares_issued) !== null ? num(mh.shares_issued) : shares, note: String(mh.note || "") } : null;
    return o;
  });
  return { G, MT, cos: out, prem: (num(A.control_premium_pct) !== null ? num(A.control_premium_pct) : 30) / 100 };
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
      cell.alignment = { vertical: "middle", horizontal: o.align || (typeof v === "string" && v !== "n/a" ? "left" : "right"), wrapText: !!o.wrap };
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
  const wsP = M.cos.some(x => x.mp) ? wb.addWorksheet("시장가격") : null;
  const wsRef = M.cos.some(x => x.refs) ? wb.addWorksheet("참고가격") : null;
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
  const vdDate = parseDate(date);
  S.put(wsA, `A${r}`, "평가기준일"); S.put(wsA, `B${r}`, vdDate || date, { color: F_IN, align: "center", fmt: vdDate ? "yyyy-mm-dd" : undefined }); S.put(wsA, `C${r}`, spec.valuation_note || "", { wrap: true }); wsA.mergeCells(`C${r}:M${r}`);
  AR.vd = abs("가정", "B", r); r++;
  common.forEach(([k, label, v, note]) => {
    S.put(wsA, `A${r}`, label);
    S.put(wsA, `B${r}`, v, { fmt: k === "ws" || k === "gs" ? FMT.pct : FMT.pct2, fill: ["mrp", "g", "w"].includes(k) ? "FFF2CC" : undefined });
    S.put(wsA, `C${r}`, note || "", { wrap: true }); wsA.mergeCells(`C${r}:M${r}`);
    AR[k] = abs("가정", "B", r); r++;
  });
  if (M.cos.some(x => x.mh)) {
    S.put(wsA, `A${r}`, "경영권 프리미엄(인수비용 비교용)"); S.put(wsA, `B${r}`, M.prem, { fmt: FMT.pct, fill: "FFF2CC" });
    S.put(wsA, `C${r}`, A.control_premium_note || "가정값 — 거래 조건에 따라 바꿀 것", { wrap: true }); wsA.mergeCells(`C${r}:M${r}`);
    AR.prem = abs("가정", "B", r); r++;
  }
  r++;
  const CA = []; // 회사별 가정 주소
  M.cos.forEach((x, ci) => {
    const c = x.c, N = MT.dcf ? x.N : 0, nc = colName(3 + N);
    const ca = {};
    const any = MT.dcf || x.mh || x.refs || x.cont !== null;
    if (!any) { CA[ci] = ca; return; }
    S.head(wsA, r, [["A", `${c.name} — 회사별 가정`], ["B", "값"]].concat(MT.dcf ? c.forecast.years.map((y, i) => [colName(3 + i), String(y)]) : []).concat([[nc, "근거·출처"]]));
    r++;
    if (MT.dcf) {
      // 첫 행들은 값 하나(B열)
      // 피어에서 베타·D/E를 가져오면 상대가치 시트 통계 셀을 참조(주소는 상대가치 시트를 만든 뒤 채운다)
      S.put(wsA, `A${r}`, x.betaFromPeers ? "피어 언레버드 베타(중앙값)" : "무부채 베타(βu)"); S.put(wsA, `B${r}`, x.bu, { fmt: FMT.beta, fill: "FFF2CC" });
      S.put(wsA, `${nc}${r}`, c.beta_note || (x.betaFromPeers ? "상대가치 시트 피어 언레버드 베타 중앙값(βL ÷ (1 + (1 − t) × D/E))" : ""), { border: false }); ca.bu = abs("가정", "B", r); ca.buCell = `B${r}`; r++;
      S.put(wsA, `A${r}`, x.betaFromPeers ? "목표 부채비율 D/E(피어 중앙값)" : "목표 부채비율(D/E)"); S.put(wsA, `B${r}`, x.de, { fmt: FMT.pct });
      S.put(wsA, `${nc}${r}`, c.de_note || (x.betaFromPeers ? "상대가치 시트 피어 이자부부채/시가총액 중앙값" : ""), { border: false }); ca.de = abs("가정", "B", r); ca.deCell = `B${r}`; r++;
      if (x.st) {
        S.put(wsA, `A${r}`, `${c.forecast.years[0]} 하반기 할인기간(년)`); S.put(wsA, `B${r}`, x.h2.t, { fmt: "0.000" });
        S.put(wsA, `${nc}${r}`, (c.stub && c.stub.discount_note) || "평가기준일 ~ 연말 남은 기간의 중간(기준일까지 대부분 지났으면 0에 가깝게)", { border: false }); ca.th = abs("가정", "B", r); r++;
      }
      const notes = c.forecast_notes || {};
      [["g", "매출 성장률", "growth"], ["m", "영업이익률", "margin"], ["da", "감가상각비 / 매출", "da"], ["cp", "CAPEX / 매출", "capex"], ["nw", "순운전자본 / 매출", "nwc"]].forEach(([k, label, nk]) => {
        S.put(wsA, `A${r}`, label);
        x.fa[k].forEach((v, i) => S.put(wsA, `${colName(3 + i)}${r}`, v, { fmt: FMT.pct, fill: k === "g" || k === "m" ? "FFF2CC" : undefined }));
        S.put(wsA, `${nc}${r}`, notes[nk] || "", { border: false });
        ca[k] = r; r++;
      });
    }
    if (x.cont !== null) {
      S.put(wsA, `A${r}`, "우발부채 조정(백만원)"); S.put(wsA, `B${r}`, x.cont, { fmt: FMT.amt });
      S.put(wsA, `${nc}${r}`, c.contingent_note || "주주가치에 더하는 조정(손실 예상이면 음수)", { border: false }); ca.cont = abs("가정", "B", r); r++;
    }
    if (x.mh) {
      S.put(wsA, `A${r}`, "최대주주측 지분율(발행주식 기준)"); S.put(wsA, `B${r}`, x.mh.stake, { fmt: FMT.pct2 });
      S.put(wsA, `${nc}${r}`, `${x.mh.name}${x.mh.note ? " — " + x.mh.note : ""}`, { border: false }); ca.stake = abs("가정", "B", r); r++;
    }
    if (x.refs) {
      S.put(wsA, `A${r}`, "비교 기준 참고가격(선택)"); S.put(wsA, `B${r}`, REF_LABEL[x.refs.sel], { color: F_IN, align: "center", fill: "FFF2CC" });
      wsA.getCell(`B${r}`).dataValidation = { type: "list", allowBlank: false, formulae: [`"${REF_KEYS.map(k => REF_LABEL[k]).join(",")}"`] };
      S.put(wsA, `${nc}${r}`, "비상장사라 시가총액이 없음 — 참고가격 3종(최근 거래가격·상증세법 보충적 평가액·장부 순자산) 중 비교 기준을 목록에서 고를 것", { border: false });
      ca.sel = abs("가정", "B", r); r++;
    }
    CA[ci] = ca; r += 1;
  });
  setup(wsA, conf, { freeze: [1, 4] });

  // ===== 재무자료 =====
  S.title(wsF, "재무자료 — 공시 원자료와 주주가치 조정 항목", `단위: ${unit}(주식수는 주)`);
  // 데이터 열 수 = 과거 연도 + (전년 동기) + (반기) + (최근 12개월) — 회사마다 다를 수 있어 최댓값 기준, 그다음 열이 출처·비고
  const fcols = Math.max(1, ...M.cos.map(x => (MT.dcf ? x.H + (x.st ? 1 : 0) + (x.st && x.st.prior ? 1 : 0) + (x.ttm ? 1 : 0) : 1)));
  wsF.columns = [{ width: 30 }].concat(Array.from({ length: fcols }, () => ({ width: 12 }))).concat([{ width: 60 }]);
  r = 4;
  const FR = [];
  M.cos.forEach((x, ci) => {
    const c = x.c, H = MT.dcf ? x.H : 1;
    // 열: 과거 연도 | (전년 동기 누적) | (당해 반기 누적) | (최근 12개월 TTM) | 출처·비고
    const PS = MT.dcf && x.st && x.st.prior ? 1 : 0, SC = MT.dcf && x.st ? 1 : 0, TT = MT.dcf && x.ttm ? 1 : 0;
    const pc = colName(2 + H), scc = colName(2 + H + PS), tc = colName(2 + H + PS + SC), nc = colName(2 + H + PS + SC + TT);
    S.head(wsF, r, [["A", c.name + (c.code ? ` (${c.code})` : "")]].concat(MT.dcf ? c.history.years.map((y, i) => [colName(2 + i), String(y)]) : [["B", "값"]])
      .concat(PS ? [[pc, x.st.prior.label + " A"]] : []).concat(SC ? [[scc, x.st.label + " A"]] : []).concat(TT ? [[tc, "최근 12개월"]] : []).concat([[nc, "출처·비고"]]));
    r++;
    const fr = { H };
    if (MT.dcf) {
      const parts = !!x.hist.ar, H1 = colName(1 + H);
      const stv = x.st ? { rev: x.st.rev, op: x.st.op, da: x.st.da, capex: x.st.capex, ar: x.st.ar, inv: x.st.inv, ap: x.st.ap, nwc: x.st.nwc } : {};
      const psv = x.st && x.st.prior ? { rev: x.st.prior.rev, op: x.st.prior.op, da: x.st.prior.da } : {};
      const rows = [["rev", "매출액"], ["op", "영업이익"], ["da", "감가상각비(무형 포함)"], ["capex", "CAPEX(유·무형 취득)"]]
        .concat(parts ? [["ar", "매출채권"], ["inv", "재고자산"], ["ap", "매입채무"]] : []);
      rows.forEach(([k, label], j) => {
        S.put(wsF, `A${r}`, label);
        x.hist[k].forEach((v, i) => S.put(wsF, `${colName(2 + i)}${r}`, v === null ? "" : v, { fmt: FMT.amt }));
        if (PS && psv[k] !== undefined) S.put(wsF, `${pc}${r}`, isNum(psv[k]) ? psv[k] : "", { fmt: FMT.amt });
        if (SC) S.put(wsF, `${scc}${r}`, stv[k] === null || stv[k] === undefined ? "" : stv[k], { fmt: FMT.amt });
        if (TT && ["rev", "op", "da"].includes(k)) {
          const tv = x.ttm[k];
          S.put(wsF, `${tc}${r}`, { f: `=IF(OR(${H1}${r}="",${pc}${r}="",${scc}${r}=""),"",${H1}${r}+${scc}${r}-${pc}${r})`, r: isNum(tv) ? tv : "" }, { fmt: FMT.amt });
        }
        S.put(wsF, `${nc}${r}`, j === 0 ? [c.history.source, SC ? `${x.st.label}: ${x.st.source || "반기 누적 실적, 잔액은 반기말"}` : "", TT ? "최근 12개월 = 직전 사업연도 + 당해 누적 − 전년 동기 누적" : ""].filter(Boolean).join(" · ") : "");
        fr[k] = r; r++;
      });
      // 순운전자본 — 구성 항목이 있으면 수식(매출채권 + 재고 − 매입채무)
      S.put(wsF, `A${r}`, parts ? "순운전자본(매출채권+재고−매입채무)" : "순운전자본(기말 잔액)", { bold: parts });
      x.hist.nwc.forEach((v, i) => { const cc = colName(2 + i); S.put(wsF, `${cc}${r}`, parts ? { f: `=${cc}${fr.ar}+${cc}${fr.inv}-${cc}${fr.ap}`, r: v } : v, { fmt: FMT.amt }); });
      if (SC) S.put(wsF, `${scc}${r}`, x.st.ar !== null && parts ? { f: `=${scc}${fr.ar}+${scc}${fr.inv}-${scc}${fr.ap}`, r: x.st.nwc } : x.st.nwc, { fmt: FMT.amt });
      fr.nwc = r; r++;
      // EBITDA
      S.put(wsF, `A${r}`, "EBITDA(영업이익+감가상각비)");
      const ecols = Array.from({ length: H }, (_, i) => colName(2 + i)).concat(PS ? [pc] : []).concat(SC ? [scc] : []).concat(TT ? [tc] : []);
      ecols.forEach(cc => {
        const ci2 = cc === pc && PS ? "ps" : cc === scc && SC ? "st" : cc === tc && TT ? "tt" : null;
        const opv = ci2 === "ps" ? psv.op : ci2 === "st" ? stv.op : ci2 === "tt" ? x.ttm.op : x.hist.op[ecols.indexOf(cc)];
        const dav = ci2 === "ps" ? psv.da : ci2 === "st" ? stv.da : ci2 === "tt" ? x.ttm.da : x.hist.da[ecols.indexOf(cc)];
        S.put(wsF, `${cc}${r}`, { f: `=IF(OR(${cc}${fr.da}="",${cc}${fr.op}=""),"",${cc}${fr.op}+${cc}${fr.da})`, r: isNum(opv) && isNum(dav) ? opv + dav : "" }, { fmt: FMT.amt });
      });
      fr.ebitda = r; r++;
      if (SC) fr.stubCol = scc;
      if (TT) { fr.ttmCol = tc; fr.ttmEbitda = abs("재무자료", tc, fr.ebitda); fr.ttmOp = abs("재무자료", tc, fr.op); fr.ttmRev = abs("재무자료", tc, fr.rev); }
      if (isNum(x.ttmNi)) { S.put(wsF, `A${r}`, "지배주주순이익(최근 12개월)"); S.put(wsF, `${TT ? tc : "B"}${r}`, x.ttmNi, { fmt: FMT.amt }); S.put(wsF, `${nc}${r}`, c.net_income_note || ""); fr.ni = abs("재무자료", TT ? tc : "B", r); r++; }
      if (isNum(x.eqParent)) { S.put(wsF, `A${r}`, "지배주주지분(기준일)"); S.put(wsF, `${SC ? scc : "B"}${r}`, x.eqParent, { fmt: FMT.amt }); S.put(wsF, `${nc}${r}`, c.equity_note || ""); fr.eq = abs("재무자료", SC ? scc : "B", r); r++; }
    }
    S.put(wsF, `A${r}`, "유통주식수(자기주식 제외, 주)"); S.put(wsF, `B${r}`, x.shares, { fmt: FMT.won }); S.put(wsF, `${nc}${r}`, c.shares_note || ""); fr.shares = abs("재무자료", "B", r); r++;
    if (x.mh) { S.put(wsF, `A${r}`, "발행주식총수(주)"); S.put(wsF, `B${r}`, x.mh.issued, { fmt: FMT.won }); S.put(wsF, `${nc}${r}`, "최대주주측 지분가치 계산용(지분율이 발행주식 기준)"); fr.issued = abs("재무자료", "B", r); r++; }
    if (x.listed) {
      S.put(wsF, `A${r}`, "시가총액(평가기준일 종가)"); S.put(wsF, `B${r}`, x.mkt.mid, { fmt: FMT.amt }); S.put(wsF, `${nc}${r}`, x.mp ? "시장가격 시트: 종가 × 유통주식수" : (c.market_note || "")); fr.mc = abs("재무자료", "B", r); fr.mcCell = `B${r}`; r++;
      S.put(wsF, `A${r}`, x.mp ? "시가총액(기준주가)" : "시가총액(다른 기준)"); S.put(wsF, `B${r}`, x.mp ? x.mp.mcBase : (isNum(num(c.market_cap_alt)) ? num(c.market_cap_alt) : num(c.market_cap)), { fmt: FMT.amt });
      S.put(wsF, `${nc}${r}`, x.mp ? "시장가격 시트: 기준주가 × 유통주식수(자본시장법 시행령 제176조의5 방식)" : (c.market_alt_note || (isNum(num(c.market_cap_alt)) ? "" : "다른 기준 없음 — 종가와 같게 둠"))); fr.mc2 = abs("재무자료", "B", r); fr.mc2Cell = `B${r}`; r++;
    }
    if (Array.isArray(c.proxies) && c.proxies.length) {
      S.text(wsF, `A${r}`, "대용 추정(참고) — 신뢰도 낮음, DCF·상대가치에 쓰지 않음", { bold: true, color: "C00000" }); r++;
      c.proxies.forEach(p => {
        S.put(wsF, `A${r}`, String(p.item || "")); S.put(wsF, `B${r}`, isNum(num(p.value)) ? num(p.value) : String(p.value || ""), { fmt: FMT.amt, color: "808080" });
        S.put(wsF, `${nc}${r}`, [p.unit ? `단위 ${p.unit}` : "", p.basis || "", "신뢰도 낮음"].filter(Boolean).join(" · "), { color: "808080" }); r++;
      });
    }
    // 영업가치 → 주주가치 조정(비영업자산 +, 차입금·리스부채·비지배지분 −). DCF와 EV 배수가 같은 값을 쓴다
    const b0 = r;
    x.bridge.forEach(b => { S.put(wsF, `A${r}`, "(조정) " + b.item); S.put(wsF, `B${r}`, b.amount, { fmt: FMT.amt }); S.put(wsF, `${nc}${r}`, b.note || ""); r++; });
    if (x.cont !== null) { S.put(wsF, `A${r}`, "(조정) 우발부채"); S.put(wsF, `B${r}`, { f: `=${CA[ci].cont}`, r: x.cont, link: 1 }, { fmt: FMT.amt }); S.put(wsF, `${nc}${r}`, "가정 시트"); r++; }
    S.put(wsF, `A${r}`, "주주가치 조정 합계", { bold: true });
    S.put(wsF, `B${r}`, { f: r > b0 ? `=SUM(B${b0}:B${r - 1})` : "=0", r: x.bsum }, { fmt: FMT.amt, bold: true });
    S.put(wsF, `${nc}${r}`, "평가기준일 직전 정기보고서 말 잔액 기준");
    fr.bsum = abs("재무자료", "B", r); r++;
    FR[ci] = fr; r++;
  });
  setup(wsF, conf, { freeze: [1, 3] });

  // ===== 시장가격(상장사, 일별 거래 자료가 있을 때) =====
  if (wsP) {
    S.title(wsP, "시장가격 — 거래량가중평균주가와 기준주가", "기준주가 = (최근 1개월·1주일·최근일 거래량가중평균주가)의 산술평균 — 자본시장법 시행령 제176조의5제1항 방식 준용");
    wsP.columns = [{ width: 26 }, { width: 12 }, { width: 14 }, { width: 18 }, { width: 50 }];
    r = 4;
    M.cos.forEach((x, ci) => {
      if (!x.mp) return;
      const c = x.c, mp = x.mp;
      S.text(wsP, `A${r}`, `${c.name}${c.code ? ` (${c.code})` : ""}`, { bold: true, color: "1F3864", size: 10 }); r++;
      S.head(wsP, r, [["A", "일자"], ["B", "종가(원)"], ["C", "거래량(주)"], ["D", "거래대금(원)"]]); r++;
      const d0 = r;
      mp.days.forEach(d => {
        S.put(wsP, `A${r}`, d.d, { color: F_IN, align: "center", fmt: "yyyy-mm-dd" });
        S.put(wsP, `B${r}`, isNum(d.close) ? d.close : "", { fmt: FMT.won });
        S.put(wsP, `C${r}`, d.vol, { fmt: FMT.won }); S.put(wsP, `D${r}`, d.val, { fmt: FMT.won }); r++;
      });
      const d1 = r - 1, A_ = `$A$${d0}:$A$${d1}`, C_ = `$C$${d0}:$C$${d1}`, D_ = `$D$${d0}:$D$${d1}`;
      r++;
      S.head(wsP, r, [["A", "구분"], ["B", "값"], ["C", "산식·비고"]]); wsP.mergeCells(`C${r}:E${r}`); r++;
      const P = {};
      const prow = (k, label, v, fmt, note, o) => { S.put(wsP, `A${r}`, label, { bold: o && o.bold }); S.put(wsP, `B${r}`, v, Object.assign({ fmt }, o || {})); S.put(wsP, `C${r}`, note || ""); wsP.mergeCells(`C${r}:E${r}`); P[k] = r++; };
      prow("close", "평가기준일 종가(원)", mp.close, FMT.won, c.market_prices.close_note || "최근 거래일 종가");
      prow("m1", "1개월 거래량가중평균(원)", { f: `=ROUND(SUMIFS(${D_},${A_},">"&EDATE(${AR.vd},-1))/SUMIFS(${C_},${A_},">"&EDATE(${AR.vd},-1)),0)`, r: mp.p1m }, FMT.won, "평가기준일 전 1개월(기준일 포함) 거래대금 합 ÷ 거래량 합");
      prow("w1", "1주일 거래량가중평균(원)", { f: `=ROUND(SUMIFS(${D_},${A_},">"&(${AR.vd}-7))/SUMIFS(${C_},${A_},">"&(${AR.vd}-7)),0)`, r: mp.p1w }, FMT.won, "평가기준일 전 7일(기준일 포함)");
      prow("d1", "최근일 거래량가중평균(원)", { f: `=ROUND(D${d1}/C${d1},0)`, r: mp.p1d }, FMT.won, "마지막 거래일 거래대금 ÷ 거래량");
      prow("base", "기준주가(원)", { f: `=ROUND(AVERAGE(B${P.m1},B${P.w1},B${P.d1}),0)`, r: mp.base }, FMT.won, "세 가중평균주가의 산술평균(할인·할증 미적용)", { bold: true });
      prow("sh", "유통주식수(주)", { f: `=${FR[ci].shares}`, r: x.shares, link: 1 }, FMT.won, "재무자료");
      prow("mc", "시가총액 — 종가(백만원)", { f: `=B${P.close}*B${P.sh}/1000000`, r: mp.mcClose }, FMT.amt, "", { bold: true });
      prow("mcb", "시가총액 — 기준주가(백만원)", { f: `=B${P.base}*B${P.sh}/1000000`, r: mp.mcBase }, FMT.amt, "");
      if (c.market_prices.source) { S.text(wsP, `A${r}`, "자료: " + c.market_prices.source); r++; }
      // 재무자료의 시가총액 칸을 이 시트에 연결
      wsF.getCell(FR[ci].mcCell).value = { formula: `'시장가격'!$B$${P.mc}`, result: mp.mcClose }; wsF.getCell(FR[ci].mcCell).font = { name: font, size: 9, color: { argb: "FF" + F_LINK } };
      wsF.getCell(FR[ci].mc2Cell).value = { formula: `'시장가격'!$B$${P.mcb}`, result: mp.mcBase }; wsF.getCell(FR[ci].mc2Cell).font = { name: font, size: 9, color: { argb: "FF" + F_LINK } };
      r += 2;
    });
    setup(wsP, conf, { freeze: [1, 3] });
  }

  // ===== 참고가격(비상장사) — 최근 거래가격 · 상증세법 보충적 평가액(간이) · 장부 순자산 =====
  const RF = [];
  if (wsRef) {
    S.title(wsRef, "참고가격 — 비상장사 시장가치 대용 3종", "주주가치 = 주당가격 × 유통주식수(백만원). 비교 기준은 가정 시트에서 고른다");
    wsRef.columns = [{ width: 42 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 56 }];
    r = 4;
    M.cos.forEach((x, ci) => {
      if (!x.refs) return;
      const c = x.c, R = x.refs, sh = FR[ci].shares, rf = {};
      S.text(wsRef, `A${r}`, `${c.name}${c.code ? ` (${c.code})` : ""}${c.data_tier ? ` — 자료 구분 ${c.data_tier}` : ""}`, { bold: true, color: "1F3864", size: 10 }); r++;
      if (c.data_note) { S.text(wsRef, `A${r}`, c.data_note); r++; }
      // ① 최근 거래가격
      S.text(wsRef, `A${r}`, "① 최근 거래가격(유상증자 발행가·지분 매매가·전환가 등)", { bold: true }); r++;
      S.head(wsRef, r, [["A", "일자 · 구분"], ["B", "주당가격(원)"], ["C", "비고"]]); wsRef.mergeCells(`C${r}:E${r}`); r++;
      const t0 = r;
      if (R.txRows.length) R.txRows.forEach(t => {
        S.put(wsRef, `A${r}`, [t.date, t.kind].filter(Boolean).join(" · "), { color: F_IN }); S.put(wsRef, `B${r}`, t.price, { fmt: FMT.won });
        S.put(wsRef, `C${r}`, t.note); wsRef.mergeCells(`C${r}:E${r}`); r++;
      });
      else { S.put(wsRef, `A${r}`, "확인된 거래 없음"); S.put(wsRef, `B${r}`, ""); S.put(wsRef, `C${r}`, c.transactions_note || "공시·제공 자료에서 평가기준일 전 거래가격을 찾지 못함"); wsRef.mergeCells(`C${r}:E${r}`); r++; }
      const t1 = r - 1, TB = `B${t0}:B${t1}`;
      const has = `COUNT(${TB})>0`;
      const txv = (k) => R.tx[k];
      S.put(wsRef, `A${r}`, "주주가치 — 최저 / 최근 / 최고(백만원)");
      S.put(wsRef, `B${r}`, { f: `=IF(${has},MIN(${TB})*${sh}/1000000,"n/a")`, r: txv("lo") }, { fmt: FMT.amt });
      S.put(wsRef, `C${r}`, { f: `=IF(${has},B${t1}*${sh}/1000000,"n/a")`, r: txv("mid") }, { fmt: FMT.amt, bold: true });
      S.put(wsRef, `D${r}`, { f: `=IF(${has},MAX(${TB})*${sh}/1000000,"n/a")`, r: txv("hi") }, { fmt: FMT.amt });
      S.put(wsRef, `E${r}`, "최근 = 마지막(가장 늦은) 거래");
      rf.tx = r; r += 2;
      // ② 상증세법 보충적 평가액(간이)
      S.text(wsRef, `A${r}`, "② 상속세 및 증여세법 보충적 평가액(간이) — 시행령 제54조·제55조·제56조", { bold: true }); r++;
      const sp = R.sp;
      if (sp) {
        S.head(wsRef, r, [["A", "구분"], ["B", sp.years[0]], ["C", sp.years[1]], ["D", sp.years[2]], ["E", "산식·근거"]]); r++;
        const Q = {};
        const qrow = (k, label, vals, fmt, note, o) => {
          S.put(wsRef, `A${r}`, label, { bold: o && o.bold });
          vals.forEach((v, j) => { if (v !== undefined) S.put(wsRef, `${colName(2 + j)}${r}`, v, Object.assign({ fmt }, o || {})); });
          S.put(wsRef, `E${r}`, note || "", { wrap: true }); Q[k] = r++;
        };
        qrow("ni", "순손익(백만원)", sp.ni, FMT.amt, (c.supplementary.net_income_note || "회계상 당기순이익(간이) — 세법상 각 사업연도소득 조정(시행령 제56조④) 전"));
        qrow("si", "발행주식총수(주)", [sp.si], FMT.won, "평가기준일 현재(시행령 제54조⑤). 3년간 증자·감자가 있으면 연도별 주식수 조정 필요(제56조③)");
        qrow("eps", "1주당 순손익(원)", [0, 1, 2].map(j => ({ f: `=${colName(2 + j)}${Q.ni}*1000000/$B$${Q.si}`, r: sp.eps[j] })), FMT.won, "");
        qrow("wavg", "1주당 순손익 가중평균(원)", [{ f: `=MAX(0,(D${Q.eps}*3+C${Q.eps}*2+B${Q.eps})/6)`, r: sp.wavg }], FMT.won, "(직전 × 3 + 2년 전 × 2 + 3년 전 × 1) ÷ 6, 음수면 0(제56조①)");
        qrow("rate", "순손익가치 환원율", [sp.rate], FMT.pct, "시행규칙 제17조 연 10%");
        qrow("niv", "1주당 순손익가치(원)", [{ f: `=B${Q.wavg}/B${Q.rate}`, r: sp.niv }], FMT.won, "가중평균 ÷ 환원율(제54조①)");
        qrow("na", "순자산(백만원)", [sp.na], FMT.amt, c.supplementary.net_assets_note || "장부상 순자산(간이) — 자산 시가평가·영업권 평가액(제55조③) 미반영");
        qrow("nav", "1주당 순자산가치(원)", [{ f: `=MAX(0,B${Q.na})*1000000/B${Q.si}`, r: sp.nav }], FMT.won, "순자산 ÷ 발행주식총수, 0 이하면 0(제54조②·제55조①)");
        qrow("re", "부동산과다보유법인 여부", [sp.reH ? "예" : "아니오"], undefined, "예 = 순손익가치 : 순자산가치 = 2 : 3(제54조① 괄호)");
        wsRef.getCell(`B${Q.re}`).dataValidation = { type: "list", allowBlank: false, formulae: ['"예,아니오"'] }; wsRef.getCell(`B${Q.re}`).font = { name: font, size: 9, color: { argb: "FF" + F_IN } };
        qrow("nao", "순자산가치만 적용(제54조④) 여부", [sp.navOnly ? "예" : "아니오"], undefined, "사업개시 3년 미만·청산 중·부동산 80% 이상 등이면 예");
        wsRef.getCell(`B${Q.nao}`).dataValidation = { type: "list", allowBlank: false, formulae: ['"예,아니오"'] }; wsRef.getCell(`B${Q.nao}`).font = { name: font, size: 9, color: { argb: "FF" + F_IN } };
        qrow("blend", "가중평균액(원)", [{ f: `=IF(B${Q.re}="예",(B${Q.niv}*2+B${Q.nav}*3)/5,(B${Q.niv}*3+B${Q.nav}*2)/5)`, r: sp.blend }], FMT.won, "순손익가치 : 순자산가치 = 3 : 2");
        qrow("per", "1주당 평가액(원)", [{ f: `=IF(B${Q.nao}="예",B${Q.nav},MAX(B${Q.blend},B${Q.nav}*0.8))`, r: sp.per }], FMT.won, "가중평균액과 순자산가치 × 80% 중 큰 값(제54조① 단서)", { bold: true, fill: "FFF2CC" });
        qrow("prem", "최대주주 할증률", [sp.prem], FMT.pct, "법 제63조③ 20%. 중소기업·중견기업·3년 연속 결손법인 등은 0%");
        S.put(wsRef, `A${r}`, "주주가치 — 평가액 / 평가액 / 할증 적용(백만원)");
        S.put(wsRef, `B${r}`, { f: `=B${Q.per}*${sh}/1000000`, r: R.supp.lo }, { fmt: FMT.amt });
        S.put(wsRef, `C${r}`, { f: `=B${Q.per}*${sh}/1000000`, r: R.supp.mid }, { fmt: FMT.amt, bold: true });
        S.put(wsRef, `D${r}`, { f: `=B${Q.per}*(1+B${Q.prem})*${sh}/1000000`, r: R.supp.hi }, { fmt: FMT.amt });
        S.put(wsRef, `E${r}`, "유통주식수 기준. 상단 = 최대주주 할증 적용", { wrap: true });
        rf.supp = r; r++;
        S.text(wsRef, `A${r}`, "간이 추정: 세무조정·자산 시가평가·영업권을 반영한 세무상 평가액과 다를 수 있음. 실제 거래·신고 전 세무 검토 필요.", { color: "808080" }); r += 2;
      } else {
        S.put(wsRef, `A${r}`, "계산 자료 없음(최근 3년 순손익·순자산·발행주식총수 필요)");
        ["B", "C", "D"].forEach(cc => S.put(wsRef, `${cc}${r}`, "n/a")); rf.supp = r; r += 2;
      }
      // ③ 장부 순자산
      S.text(wsRef, `A${r}`, "③ 장부 순자산(자본총계)", { bold: true }); r++;
      S.put(wsRef, `A${r}`, "자본총계(백만원)");
      S.put(wsRef, `B${r}`, R.bookEq !== null ? R.bookEq : "n/a", { fmt: FMT.amt });
      S.put(wsRef, `C${r}`, R.bookEq !== null ? { f: `=B${r}`, r: R.bookEq } : "n/a", { fmt: FMT.amt, bold: true });
      S.put(wsRef, `D${r}`, R.bookEq !== null ? { f: `=B${r}`, r: R.bookEq } : "n/a", { fmt: FMT.amt });
      S.put(wsRef, `E${r}`, c.book_equity_note || "최근 재무제표 기말 자본총계(지배기업 소유주지분)");
      rf.book = r; r += 3;
      RF[ci] = rf;
    });
    setup(wsRef, conf, { freeze: [1, 3] });
  }

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
  if (M.cos.some(x => x.waccTool !== null && x.waccTool !== undefined)) {
    wrows.push(["tool", "WACC(계산 도구 값)", (x) => (isNum(x.waccTool) ? x.waccTool : "n/a"), FMT.pct2, "같은 입력으로 계산 도구가 낸 값(대조용)"]);
    wrows.push(["diff", "차이(모델 − 도구)", (x, ci, c) => ({ f: `=IF(ISNUMBER(${c}${WR.tool}),${c}${WR.wacc}-${c}${WR.tool},"n/a")`, r: isNum(x.waccTool) ? x.wacc - x.waccTool : NaN }), "0.00%;-0.00%;0.00%", "0에 가까워야 함"]);
  }
  wrows.forEach(([k]) => { WR[k] = r++; });
  wrows.forEach(([k, label, fn, fmt, note]) => {
    S.put(wsW, `A${WR[k]}`, label, { bold: k === "wacc" });
    M.cos.forEach((x, ci) => { const c = colName(2 + ci); const v = fn(x, ci, c); S.put(wsW, `${c}${WR[k]}`, v, { fmt, bold: k === "wacc", fill: k === "wacc" ? "FFF2CC" : undefined, align: typeof v === "string" ? "right" : undefined }); });
    S.put(wsW, `${colName(2 + M.cos.length)}${WR[k]}`, note);
  });
  setup(wsW, conf, { freeze: [1, 4] });
  }

  // ===== DCF =====
  const DR = [];
  if (MT.dcf) M.cos.forEach((x, ci) => {
    const ws = wsD[ci], sh = ws.name, c = x.c, H = x.H, N = x.N, fr = FR[ci], ca = CA[ci];
    S.title(ws, `${c.name} — DCF(FCFF, 기간 중간 할인)`, `단위: ${unit} · 평가기준일 ${date} · ` + (x.st ? `할인: ${c.forecast.years[0]} 하반기(가정 시트) 이후 각 연도 7월 1일까지 기간` : "할인기간 = 예측 연차 − 0.5"));
    // 열: 과거 A | (반기 A) | 1년차 E(반기가 있으면 연간 참고) | (1년차 하반기 E) | 2년차 E …
    const SB = x.st ? 1 : 0;
    ws.columns = [{ width: 26 }].concat(Array.from({ length: H + N + 1 + 2 * SB }, () => ({ width: 12 }))).concat([{ width: 36 }]);
    const hc = (i) => colName(2 + i), sc = colName(2 + H), fc = (i) => colName(2 + H + SB + (i && SB ? i + 1 : i)), h2c = colName(3 + H + SB), lastH = hc(H - 1), tcol = colName(2 + H + N + 2 * SB);
    S.head(ws, 4, [["A", "구분"]].concat(c.history.years.map((y, i) => [hc(i), String(y) + " A"])).concat(SB ? [[sc, x.st.label + " A"]] : [])
      .concat(c.forecast.years.map((y, i) => [fc(i), String(y) + (SB && !i ? "(연간)" : "")])).concat(SB ? [[h2c, String(c.forecast.years[0]) + " 하반기"]] : []).concat([[tcol, "영구(Terminal)"]]));
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
      // 과거 감가상각비·CAPEX가 비어 있으면(미조회 연도) 빈칸으로 둔다
      const lk = (k) => (isNum(x.hist[k][i]) ? { f: `='재무자료'!${fcol}${fr[k]}`, r: x.hist[k][i], link: 1 } : { f: `=IF('재무자료'!${fcol}${fr[k]}="","",'재무자료'!${fcol}${fr[k]})`, r: "", link: 1 });
      S.put(ws, `${col}${R.da}`, lk("da"), { fmt: FMT.amt });
      S.put(ws, `${col}${R.capex}`, lk("capex"), { fmt: FMT.amt });
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
      if (SB && !i) continue; // 연간 열은 참고 — 할인은 하반기 열에서
      S.put(ws, `${col}${R.fcff}`, { f: `=${col}${R.nopat}+${col}${R.da}-${col}${R.capex}-${col}${R.dnwc}`, r: x.fcff[i] }, { fmt: FMT.amt, bold: true });
      S.put(ws, `${col}${R.t}`, SB ? { f: `=(DATE(${x.yrs[i]},7,1)-${AR.vd})/365`, r: x.t[i] } : x.t[i], { fmt: SB ? "0.000" : FMT.yr });
      S.put(ws, `${col}${R.w}`, { f: `='WACC'!$${colName(2 + ci)}$${WR.wacc}`, r: x.wacc, link: 1 }, { fmt: FMT.pct2 });
      S.put(ws, `${col}${R.df}`, { f: `=1/(1+${col}${R.w})^${col}${R.t}`, r: x.dfac[i] }, { fmt: "0.0000" });
      S.put(ws, `${col}${R.pv}`, { f: `=${col}${R.fcff}*${col}${R.df}`, r: x.pv[i] }, { fmt: FMT.amt });
    }
    if (SB) {
      // 반기 실적(재무자료) 과 당해 하반기 = 연간 추정 − 반기 실적
      const st = x.st, h2 = x.h2, a0 = fc(0), fcol = fr.stubCol;
      S.put(ws, `${sc}${R.rev}`, { f: `='재무자료'!${fcol}${fr.rev}`, r: st.rev, link: 1 }, { fmt: FMT.amt });
      S.put(ws, `${sc}${R.op}`, { f: `='재무자료'!${fcol}${fr.op}`, r: st.op, link: 1 }, { fmt: FMT.amt });
      S.put(ws, `${sc}${R.m}`, { f: `=${sc}${R.op}/${sc}${R.rev}`, r: st.op / st.rev }, { fmt: FMT.pct });
      S.put(ws, `${sc}${R.da}`, { f: `='재무자료'!${fcol}${fr.da}`, r: st.da, link: 1 }, { fmt: FMT.amt });
      S.put(ws, `${sc}${R.capex}`, { f: `='재무자료'!${fcol}${fr.capex}`, r: st.capex, link: 1 }, { fmt: FMT.amt });
      S.put(ws, `${sc}${R.nwc}`, { f: `='재무자료'!${fcol}${fr.nwc}`, r: st.nwc, link: 1 }, { fmt: FMT.amt });
      const H2 = h2c;
      S.put(ws, `${H2}${R.rev}`, { f: `=${a0}${R.rev}-${sc}${R.rev}`, r: h2.rev }, { fmt: FMT.amt });
      S.put(ws, `${H2}${R.op}`, { f: `=${a0}${R.op}-${sc}${R.op}`, r: h2.op }, { fmt: FMT.amt });
      S.put(ws, `${H2}${R.m}`, { f: `=IFERROR(${H2}${R.op}/${H2}${R.rev},"n/a")`, r: h2.op / h2.rev }, { fmt: FMT.pct });
      S.put(ws, `${H2}${R.tax}`, { f: `=${H2}${R.op}*${AR.tax}`, r: h2.tax }, { fmt: FMT.amt });
      S.put(ws, `${H2}${R.nopat}`, { f: `=${H2}${R.op}-${H2}${R.tax}`, r: h2.nopat }, { fmt: FMT.amt });
      S.put(ws, `${H2}${R.da}`, { f: `=${a0}${R.da}-${sc}${R.da}`, r: h2.da }, { fmt: FMT.amt });
      S.put(ws, `${H2}${R.capex}`, { f: `=${a0}${R.capex}-${sc}${R.capex}`, r: h2.capex }, { fmt: FMT.amt });
      S.put(ws, `${H2}${R.nwc}`, { f: `=${a0}${R.nwc}`, r: h2.nwc }, { fmt: FMT.amt });
      S.put(ws, `${H2}${R.dnwc}`, { f: `=${H2}${R.nwc}-${sc}${R.nwc}`, r: h2.dnwc }, { fmt: FMT.amt });
      S.put(ws, `${H2}${R.fcff}`, { f: `=${H2}${R.nopat}+${H2}${R.da}-${H2}${R.capex}-${H2}${R.dnwc}`, r: h2.fcff }, { fmt: FMT.amt, bold: true });
      S.put(ws, `${H2}${R.t}`, { f: `=${ca.th}`, r: h2.t, link: 1 }, { fmt: "0.000" });
      S.put(ws, `${H2}${R.w}`, { f: `='WACC'!$${colName(2 + ci)}$${WR.wacc}`, r: x.wacc, link: 1 }, { fmt: FMT.pct2 });
      S.put(ws, `${H2}${R.df}`, { f: `=1/(1+${H2}${R.w})^${H2}${R.t}`, r: h2.df }, { fmt: "0.0000" });
      S.put(ws, `${H2}${R.pv}`, { f: `=${H2}${R.fcff}*${H2}${R.df}`, r: h2.pv }, { fmt: FMT.amt });
      S.text(ws, `A20`, `${c.forecast.years[0]}(연간) 열은 연간 추정(참고). 할인은 ${c.forecast.years[0]} 하반기(= 연간 − ${st.label} 실적)부터. 순운전자본 증가 = 연말 추정 잔액 − 반기말 실제 잔액. 이후 할인기간 = (해당 연도 7월 1일 − 평가기준일) ÷ 365`, { color: "808080", size: 8 });
    }
    {
      // 영구 연도 열 — 마지막 예측연도 × (1 + g)
      const L = fc(N - 1), T = tcol, tm = x.term, gA = AR.g;
      S.put(ws, `${T}${R.g}`, { f: `=${gA}`, r: G.g, link: 1 }, { fmt: FMT.pct });
      S.put(ws, `${T}${R.rev}`, { f: `=${L}${R.rev}*(1+${T}${R.g})`, r: tm.rev }, { fmt: FMT.amt });
      S.put(ws, `${T}${R.m}`, { f: `=${L}${R.m}`, r: x.fa.m[N - 1] }, { fmt: FMT.pct });
      S.put(ws, `${T}${R.op}`, { f: `=${T}${R.rev}*${T}${R.m}`, r: tm.op }, { fmt: FMT.amt });
      S.put(ws, `${T}${R.tax}`, { f: `=${T}${R.op}*${AR.tax}`, r: tm.tax }, { fmt: FMT.amt });
      S.put(ws, `${T}${R.nopat}`, { f: `=${T}${R.op}-${T}${R.tax}`, r: tm.nopat }, { fmt: FMT.amt });
      [["da", tm.da], ["capex", tm.capex], ["nwc", tm.nwc]].forEach(([k, v]) => S.put(ws, `${T}${R[k]}`, { f: `=${L}${R[k]}*(1+${T}${R.g})`, r: v }, { fmt: FMT.amt }));
      S.put(ws, `${T}${R.dnwc}`, { f: `=${T}${R.nwc}-${L}${R.nwc}`, r: tm.dnwc }, { fmt: FMT.amt });
      S.put(ws, `${T}${R.fcff}`, { f: `=${T}${R.nopat}+${T}${R.da}-${T}${R.capex}-${T}${R.dnwc}`, r: tm.fcff }, { fmt: FMT.amt, bold: true });
    }
    const f0 = SB ? h2c : fc(0), fN = fc(N - 1), rngF = `$${f0}$${R.fcff}:$${fN}$${R.fcff}`, rngT = `$${f0}$${R.t}:$${fN}$${R.t}`;
    const wRef = `'WACC'!$${colName(2 + ci)}$${WR.wacc}`;
    // 가치 산정
    r = 21;
    S.head(ws, r, [["A", "가치 산정"], ["B", "금액"], ["C", "산식·근거"]]); ws.mergeCells(`C${r}:${colName(Math.max(4, 2 + H + N))}${r}`); r++;
    const V = {};
    const vrow = (k, label, v, fmt, note, o) => { S.put(ws, `A${r}`, label, { bold: o && o.bold }); S.put(ws, `B${r}`, v, Object.assign({ fmt }, o || {})); S.put(ws, `C${r}`, note || ""); ws.mergeCells(`C${r}:${colName(Math.max(4, 2 + H + N))}${r}`); V[k] = r++; };
    vrow("sumpv", "예측기간 FCFF 현재가치 합계", { f: `=SUM(${f0}${R.pv}:${fN}${R.pv})`, r: x.sumPv }, FMT.amt, "");
    vrow("g", "영구성장률", { f: `=${AR.g}`, r: G.g, link: 1 }, FMT.pct2, "가정");
    vrow("tv", "영구가치(예측기간 말)", { f: `=${tcol}${R.fcff}/(${fN}${R.w}-B${r - 1})`, r: x.tv }, FMT.amt, "영구 연도 FCFF ÷ (WACC − g). 영구 연도 = 마지막 예측연도 × (1 + g), 순운전자본 증가 = 마지막 해 잔액 × g");
    vrow("pvtv", "영구가치 현재가치", { f: `=B${r - 1}*${fN}${R.df}`, r: x.pvTv }, FMT.amt, "마지막 해 할인계수 적용(기간 중간 관례)");
    vrow("ev", "영업가치(EV)", { f: `=B${V.sumpv}+B${r - 1}`, r: x.ev }, FMT.amt, "", { bold: true });
    vrow("tvw", "영구가치 비중", { f: `=B${V.pvtv}/B${V.ev}`, r: x.pvTv / x.ev }, FMT.pct, "");
    {
      const eref = fr.ttmEbitda || (fr.ebitda ? `'재무자료'!$${colName(1 + H)}$${fr.ebitda}` : null);
      if (eref) vrow("evm", "내재 EV/EBITDA(배)", { f: `=IF(ISNUMBER(${eref}),IF(${eref}>0,B${V.ev}/${eref},"n/a"),"n/a")`, r: x.evEbitda }, FMT.mult, `영업가치 ÷ ${x.evEbitdaBase} EBITDA(재무자료) — 피어 EV/EBITDA와 비교`);
    }
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
        S.put(ws, `${colName(2 + j)}${r}`, { f: `=SUMPRODUCT(${rngF},1/(1+${wc})^${rngT})+(($${fN}$${R.nopat}+$${fN}$${R.da}-$${fN}$${R.capex})*(1+${gc})-$${fN}$${R.nwc}*${gc})/(${wc}-${gc})/(1+${wc})^$${fN}$${R.t}+$B$${V.bsum}`, r: x.grid[i][j] },
          { fmt: FMT.amt, fill: i === 2 && j === 2 ? "FFF2CC" : undefined });
      });
      r++;
    });
    S.put(ws, `A${r}`, "검증: 중앙 − 주주가치 = 0"); S.put(ws, `B${r}`, { f: `=ROUND(D${sens[2]}-B${V.eq},6)`, r: 0 }, { fmt: "0.000000" }); r += 2;
    // 주당가치 민감도(원) = 주주가치 민감도 × 1,000,000 ÷ 유통주식수
    S.text(ws, `A${r}`, "민감도 — 주당가치(원): 행 = WACC, 열 = 영구성장률", { bold: true, color: "1F3864" }); r++;
    S.head(ws, r, [["A", "WACC \\ g"]].concat([0, 1, 2, 3, 4].map(j => [colName(2 + j), ""])));
    [0, 1, 2, 3, 4].forEach(j => { const cl = ws.getCell(`${colName(2 + j)}${r}`); cl.value = { formula: `${colName(2 + j)}${gRow}`, result: G.g + (j - 2) * G.gs }; cl.numFmt = FMT.pct2; });
    r++;
    [0, 1, 2, 3, 4].forEach(i => {
      S.put(ws, `A${r}`, { f: `=A${sens[i]}`, r: x.wacc + (i - 2) * G.ws }, { fmt: FMT.pct2, bold: true, align: "center" });
      [0, 1, 2, 3, 4].forEach(j => S.put(ws, `${colName(2 + j)}${r}`, { f: `=ROUND(${colName(2 + j)}${sens[i]}*1000000/$B$${V.sh},0)`, r: Math.round(x.grid[i][j] * 1e6 / x.shares) }, { fmt: FMT.won, fill: i === 2 && j === 2 ? "FFF2CC" : undefined }));
      r++;
    });
    DR[ci] = { sh, lo: `'${sh}'!$C$${sens[3]}`, mid: `'${sh}'!$B$${V.eq}`, hi: `'${sh}'!$E$${sens[1]}`, bsum: `'${sh}'!$B$${V.bsum}`, s0 };
    setup(ws, conf, { freeze: [1, 4] });
  });

  // ===== 상대가치 =====
  const RR = [];
  const MULTS = ["EV/EBITDA", "EV/EBIT", "PER", "PBR"];
  if (MT.rel) {
  S.title(wsR, "상대가치 — 피어 배수와 대상회사 적용", `단위: ${unit}, 배수(x) · 분모 ≤ 0 이면 n/a(통계에서 제외) · 통계: COUNT·MEDIAN·QUARTILE(포함)`);
  wsR.columns = [{ width: 22 }, { width: 10 }].concat(Array.from({ length: 13 }, () => ({ width: 11 }))).concat([{ width: 30 }]);
  r = 4;
  const statRows = (cols, p0, p1, statsOf) => {
    const st = {};
    [["n", "표본 수", (rg) => `COUNT(${rg})`, (q) => q.n, "0"], ["med", "중앙값", (rg) => `IF(COUNT(${rg})>0,MEDIAN(${rg}),"n/a")`, (q) => q.med],
     ["q1", "1사분위(Q1)", (rg) => `IF(COUNT(${rg})>0,QUARTILE(${rg},1),"n/a")`, (q) => q.q1], ["q3", "3사분위(Q3)", (rg) => `IF(COUNT(${rg})>0,QUARTILE(${rg},3),"n/a")`, (q) => q.q3],
     ["avg", "평균(참고)", (rg) => `IF(COUNT(${rg})>0,AVERAGE(${rg}),"n/a")`, (q) => q.avg]].forEach(([k, label, ff, vv, fmt0]) => {
      S.put(wsR, `A${r}`, label, { bold: k === "med" });
      cols.forEach(([cc, fmt, so]) => S.put(wsR, `${cc}${r}`, { f: "=" + ff(`${cc}${p0}:${cc}${p1}`), r: vv(so) }, { fmt: fmt0 || fmt, bold: k === "med" }));
      st[k] = r++;
    });
    return st;
  };
  M.cos.forEach((x, ci) => {
    const c = x.c;
    S.text(wsR, `A${r}`, `${c.name} — 피어그룹`, { bold: true, color: "1F3864", size: 10 }); r++;
    if (c.peer_note) { S.text(wsR, `A${r}`, c.peer_note, { wrap: false }); r++; }
    // 피어 원자료(있을 때): 시가총액·이자부부채·현금·단기금융상품·비지배지분·매출·영업이익·감가상각비·순이익·자본·베타 → EV·EBITDA·D/E·언레버드 베타를 수식으로
    const RAW = x.peers.some(p => p.raw || isNum(p.rev) || isNum(p.opi) || isNum(p.dap) || isNum(p.bl));
    const rawRow = [];
    if (RAW) {
      S.text(wsR, `A${r}`, "피어 원자료", { bold: true }); r++;
      S.head(wsR, r, [["A", "피어"], ["B", "종목코드"], ["C", "시가총액"], ["D", "이자부부채"], ["E", "현금성자산"], ["F", "단기금융상품"], ["G", "비지배지분"], ["H", "매출액"], ["I", "영업이익"], ["J", "감가상각비"], ["K", "지배순이익"], ["L", "지배자본"], ["M", "레버드 베타"], ["N", "D/E"], ["O", "언레버드 베타"], ["P", "산식"]]);
      r++;
      const q0 = r;
      x.peers.forEach((p, k) => {
        S.put(wsR, `A${r}`, p.name); S.put(wsR, `B${r}`, String(p.code || ""), { align: "center" });
        [["C", p.mc], ["D", p.ibd], ["E", p.cash], ["F", p.sti], ["G", p.nci], ["H", p.rev], ["I", p.opi], ["J", p.dap], ["K", p.ni], ["L", p.eq]].forEach(([cc, v]) => S.put(wsR, `${cc}${r}`, isNum(v) ? v : "n/a", { fmt: FMT.amt }));
        S.put(wsR, `M${r}`, isNum(p.bl) ? p.bl : "n/a", { fmt: FMT.beta });
        S.put(wsR, `N${r}`, { f: `=IF(AND(ISNUMBER(C${r}),ISNUMBER(D${r})),IF(C${r}>0,D${r}/C${r},"n/a"),"n/a")`, r: p.de }, { fmt: FMT.pct });
        S.put(wsR, `O${r}`, { f: `=IF(AND(ISNUMBER(M${r}),ISNUMBER(N${r})),M${r}/(1+(1-${AR.tax})*N${r}),"n/a")`, r: p.bu }, { fmt: FMT.beta });
        if (k === 0) S.put(wsR, `P${r}`, "D/E = 이자부부채 ÷ 시가총액, βu = βL ÷ (1 + (1 − t) × D/E)");
        rawRow[k] = r++;
      });
      const q1 = Math.max(q0, r - 1);
      const bst = statRows([["N", FMT.pct, x.pbeta.de], ["O", FMT.beta, x.pbeta.bu]], q0, q1);
      // 가정 시트의 βu·D/E가 피어에서 오면 중앙값 셀을 참조
      const ca = CA[ci];
      if (x.betaFromPeers && ca && ca.buCell) {
        S.put(wsA, ca.buCell, { f: `='상대가치'!$O$${bst.med}`, r: x.bu, link: 1 }, { fmt: FMT.beta, fill: "FFF2CC" });
        if (isNum(x.pbeta.de.med)) S.put(wsA, ca.deCell, { f: `='상대가치'!$N$${bst.med}`, r: x.de, link: 1 }, { fmt: FMT.pct });
      }
      r++;
    }
    S.text(wsR, `A${r}`, "피어 배수", { bold: true }); r++;
    S.head(wsR, r, [["A", "피어"], ["B", "종목코드"], ["C", "시가총액"], ["D", "EV"], ["E", "EBITDA"], ["F", "EBIT"], ["G", "지배순이익"], ["H", "지배자본"], ["I", "EV/EBITDA"], ["J", "EV/EBIT"], ["K", "PER"], ["L", "PBR"]].concat(RAW ? [["M", "EV/매출(참고)"]] : []));
    r++;
    const p0 = r;
    x.peers.forEach((p, k) => {
      const q = rawRow[k];
      S.put(wsR, `A${r}`, p.name); S.put(wsR, `B${r}`, String(p.code || ""), { align: "center" });
      const val = (v) => (isNum(v) ? v : "n/a");
      if (RAW) {
        S.put(wsR, `C${r}`, isNum(p.mc) ? { f: `=C${q}`, r: p.mc } : "n/a", { fmt: FMT.amt });
        S.put(wsR, `D${r}`, p.raw ? { f: `=C${q}+D${q}-N(E${q})-N(F${q})+N(G${q})`, r: p.ev } : val(p.ev), { fmt: FMT.amt });
        S.put(wsR, `E${r}`, isNum(p.opi) && isNum(p.dap) ? { f: `=I${q}+J${q}`, r: p.ebitda } : val(p.ebitda), { fmt: FMT.amt });
        S.put(wsR, `F${r}`, isNum(p.opi) ? { f: `=I${q}`, r: p.ebit } : val(p.ebit), { fmt: FMT.amt });
        S.put(wsR, `G${r}`, isNum(p.ni) ? { f: `=K${q}`, r: p.ni } : "n/a", { fmt: FMT.amt });
        S.put(wsR, `H${r}`, isNum(p.eq) ? { f: `=L${q}`, r: p.eq } : "n/a", { fmt: FMT.amt });
      } else [["C", p.mc], ["D", p.ev], ["E", p.ebitda], ["F", p.ebit], ["G", p.ni], ["H", p.eq]].forEach(([cc, v]) => S.put(wsR, `${cc}${r}`, val(v), { fmt: FMT.amt }));
      const mf = (n, d) => `=IF(AND(ISNUMBER(${n}),ISNUMBER(${d})),IF(${d}>0,${n}/${d},"n/a"),"n/a")`;
      S.put(wsR, `I${r}`, { f: mf(`D${r}`, `E${r}`), r: p.m["EV/EBITDA"] }, { fmt: FMT.mult });
      S.put(wsR, `J${r}`, { f: mf(`D${r}`, `F${r}`), r: p.m["EV/EBIT"] }, { fmt: FMT.mult });
      S.put(wsR, `K${r}`, { f: mf(`C${r}`, `G${r}`), r: p.m.PER }, { fmt: FMT.mult });
      S.put(wsR, `L${r}`, { f: mf(`C${r}`, `H${r}`), r: p.m.PBR }, { fmt: FMT.mult });
      if (RAW) S.put(wsR, `M${r}`, { f: mf(`D${r}`, `H${q}`), r: p.m["EV/매출"] }, { fmt: FMT.mult });
      r++;
    });
    const p1 = Math.max(p0, r - 1);
    const st = statRows(["I", "J", "K", "L"].map((cc, j) => [cc, FMT.mult, x.stats[MULTS[j]]]).concat(RAW ? [["M", FMT.mult, x.stats["EV/매출"]]] : []), p0, p1);
    r++;
    S.head(wsR, r, [["A", "대상회사 적용"], ["B", "대상 지표"], ["C", "배수 Q1"], ["D", "배수 중앙"], ["E", "배수 Q3"], ["F", "주주가치 하단"], ["G", "주주가치 중앙"], ["H", "주주가치 상단"], ["I", "산식"]]);
    wsR.mergeCells(`I${r}:L${r}`); r++;
    const ap = {};
    const tm = c.target_metrics || {};
    const metricRow = { "EV/EBITDA": ["EBITDA(최근 12개월)", "ebitda", "I"], "EV/EBIT": ["EBIT(최근 12개월)", "ebit", "J"], PER: ["지배순이익(최근 12개월)", "net_income", "K"], PBR: ["지배자본(기준일)", "equity", "L"], "EV/매출": ["매출액(최근 12개월)", "revenue", "M"] };
    // EV/매출은 원자료 표가 있고 대상 매출이 있을 때 참고로만 적용(요약·종합에 쓰지 않음)
    MULTS.concat(RAW && isNum(x.metric["EV/매출"]) ? ["EV/매출"] : []).forEach(k => {
      const [mlabel, mk, mc] = metricRow[k], isEv = k.startsWith("EV");
      S.put(wsR, `A${r}`, k + ((k === "PBR" && !x.useP) || k === "EV/매출" ? " (참고)" : ""));
      const dref = x.tmDerived ? { ebitda: FR[ci].ttmEbitda, ebit: FR[ci].ttmOp, net_income: FR[ci].ni, equity: FR[ci].eq, revenue: FR[ci].ttmRev }[mk] : null;
      S.put(wsR, `B${r}`, dref ? { f: `=${dref}`, r: x.metric[k], link: 1 } : (isNum(num(tm[mk])) ? num(tm[mk]) : "n/a"), { fmt: FMT.amt });
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
    let cmpRef = null, cmpMid = NaN; // 인수비용 비교에 쓰는 가격(상장 = 종가 시가총액, 비상장 = 고른 참고가격)
    if (x.listed) {
      const rmk = row("시장가치", x.mp ? "종가·기준주가 시가총액" : "시가총액",
        { f: `=MIN(${FR[ci].mc},${FR[ci].mc2})`, r: x.mkt.lo, link: 1 }, { f: `=${FR[ci].mc}`, r: x.mkt.mid, link: 1 }, { f: `=MAX(${FR[ci].mc},${FR[ci].mc2})`, r: x.mkt.hi, link: 1 },
        x.mp ? "최종 비교 대상. 중앙 = 평가기준일 종가 시가총액, 하단·상단 = 종가·기준주가 시가총액" : "최종 비교 대상. 중앙 = 평가기준일 종가 시가총액", ORANGE, { bold: true });
      re = rmk;
      S.put(wsSum, `A${r}`, "적정가치 / 시가총액 − 1");
      ["C", "D", "E"].forEach((cc, j) => S.put(wsSum, `${cc}${r}`, { f: `=IFERROR(${cc}${rfv}/$D$${rmk}-1,"n/a")`, r: x.fv[["lo", "mid", "hi"][j]] / x.mkt.mid - 1 }, { fmt: FMT.pct }));
      r++;
      cmpRef = `$D$${rmk}`; cmpMid = x.mkt.mid;
    } else if (x.refs) {
      // 참고가격 3종을 적정가치 바로 아래에 모두 그리고, 비교 기준은 가정 시트에서 고른다
      const R = x.refs, rf = RF[ci], rr = {};
      const refNote = { tx: "유상증자 발행가·지분 매매가 등 — 하단·상단 = 최저·최고, 중앙 = 최근", supp: "상증세법 시행령 제54조 간이 계산 — 상단 = 최대주주 할증 적용", book: "최근 기말 자본총계" };
      REF_KEYS.forEach((k, j) => {
        const v = R[k];
        rr[k] = row(`참고가격${"①②③"[j]} ${REF_LABEL[k]}`, "참고가격 시트",
          { f: `='참고가격'!$B$${rf[k]}`, r: v.lo, link: 1 }, { f: `='참고가격'!$C$${rf[k]}`, r: v.mid, link: 1 }, { f: `='참고가격'!$D$${rf[k]}`, r: v.hi, link: 1 },
          isNum(v.mid) ? refNote[k] : "자료 없음", ORANGE, { bold: R.sel === k });
      });
      re = r - 1;
      const selMid = R[R.sel].mid;
      S.put(wsSum, `A${r}`, "적정가치 / 선택한 참고가격 − 1");
      S.put(wsSum, `B${r}`, { f: `=${CA[ci].sel}`, r: REF_LABEL[R.sel], link: 1 });
      const pick = `CHOOSE(MATCH(${CA[ci].sel},{"${REF_KEYS.map(k => REF_LABEL[k]).join('","')}"},0),$D$${rr.tx},$D$${rr.supp},$D$${rr.book})`;
      ["C", "D", "E"].forEach((cc, j) => S.put(wsSum, `${cc}${r}`, { f: `=IFERROR(${cc}${rfv}/${pick}-1,"n/a")`, r: x.fv[["lo", "mid", "hi"][j]] / selMid - 1 }, { fmt: FMT.pct }));
      S.put(wsSum, `G${r}`, "비교 기준은 가정 시트의 '비교 기준 참고가격'에서 고름");
      cmpRef = `IFERROR(${pick},"n/a")`; cmpMid = selMid;
      r++;
    }
    if (x.mh) {
      const fr = FR[ci];
      S.put(wsSum, `A${r}`, "최대주주측 지분가치(적정가치 기준)"); S.put(wsSum, `B${r}`, { f: `=${CA[ci].stake}`, r: x.mh.stake, link: 1 }, { fmt: FMT.pct2, align: "center" });
      ["C", "D", "E"].forEach((cc, j) => S.put(wsSum, `${cc}${r}`, { f: `=IFERROR(ROUND(${cc}${rfv}/${fr.shares}*${fr.issued}*${CA[ci].stake},0),"n/a")`, r: Math.round(x.fv[["lo", "mid", "hi"][j]] / x.shares * x.mh.issued * x.mh.stake) }, { fmt: FMT.amt }));
      S.put(wsSum, `G${r}`, `주당 적정가치 × 최대주주측 보유주식수(${x.mh.name}, 지배권 프리미엄 별도)`);
      r++;
      if (cmpRef) {
        S.put(wsSum, `A${r}`, x.listed ? "(비교) 시가 기준 경영권 인수비용" : "(비교) 참고가격 기준 경영권 인수비용");
        S.put(wsSum, `B${r}`, { f: `="× 지분율 × (1+"&TEXT(${AR.prem},"0%")&")"`, r: `× 지분율 × (1+${Math.round(M.prem * 100)}%)` });
        S.put(wsSum, `D${r}`, { f: `=IFERROR(ROUND(${cmpRef.replace(/^\$D/, "$D")}/${fr.shares}*${fr.issued}*${CA[ci].stake}*(1+${AR.prem}),0),"n/a")`, r: Math.round(cmpMid / x.shares * x.mh.issued * x.mh.stake * (1 + M.prem)) }, { fmt: FMT.amt });
        S.put(wsSum, `G${r}`, x.listed ? "종가 시가총액 기준 지분 가치에 경영권 프리미엄을 더한 값(가정 시트)" : "선택한 참고가격 기준 지분 가치에 경영권 프리미엄을 더한 값(가정 시트)");
        r++;
      }
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
      const NOMID = `OR(${SAME},ROUND(D${rr}/100,0)=ROUND(C${rr}/100,0),ROUND(D${rr}/100,0)=ROUND(E${rr}/100,0),${FIT})`;
      const hp = { size: 8, color: "808080" };
      S.put(wsSum, `I${rr}`, { f: `=IF(${OK},C${rr}/100,0)`, r: lo[i] }, Object.assign({ fmt: FMT.amt1 }, hp));
      S.put(wsSum, `J${rr}`, { f: `=IF(${OK},MAX(E${rr}-C${rr},MAX($E$${rs}:$E$${re})*0.006)/100,0)`, r: w }, Object.assign({ fmt: FMT.amt1 }, hp));
      S.put(wsSum, `K${rr}`, { f: `=MAX($E$${rs}:$E$${re})/100*0.15`, r: gap[i] }, Object.assign({ fmt: FMT.amt1 }, hp));
      S.put(wsSum, `L${rr}`, { f: `=IF(NOT(${OK}),"",IF(${SAME},"",TEXT(C${rr}/100,"#,##0")))`, r: llo[i] }, Object.assign({ align: "right" }, hp));
      S.put(wsSum, `M${rr}`, { f: `=IF(NOT(${OK}),"",IF(${NOMID},"",TEXT(D${rr}/100,"#,##0")))`, r: lmid[i] }, Object.assign({ align: "right" }, hp));
      S.put(wsSum, `N${rr}`, { f: `=IF(NOT(${OK}),"",IF(${SAME},TEXT(D${rr}/100,"#,##0"),TEXT(E${rr}/100,"#,##0")))`, r: lhi[i] }, Object.assign({ align: "right" }, hp));
    });
    const leg = [];
    if (BOTH) leg.push(["■ 적정가치 산정 요소(DCF·상대가치 종합)", NAVY]);
    if (MT.rel) leg.push(["■ 상대가치 산정 배수(EV/EBITDA·EV/EBIT·PER·PBR)", TEAL]);
    const fvName = BOTH ? "적정가치" : MT.dcf ? "DCF = 적정가치" : "상대가치 종합 = 적정가치";
    leg.push([x.listed ? `■ 최종 비교(${fvName} vs 시장가치)` : x.refs ? `■ 최종 비교(${fvName} vs 참고가격 3종)` : `■ 적정가치${BOTH ? "" : MT.dcf ? "(DCF)" : "(상대가치 종합)"}`, ORANGE]);
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
    ["시트 안내", "요약(방법별 결과·적정가치·차트) → 가정(바꿀 값) → 재무자료(공시 원자료·주주가치 조정 항목)" + (wsP ? " → 시장가격(기준주가)" : "") + (wsRef ? " → 참고가격(비상장사 시장가치 대용 3종)" : "") + (MT.dcf ? " → WACC → DCF_회사" : "") + (MT.rel ? " → 상대가치(피어 배수)" : "")],
    ["글자색 범례", "파랑 = 입력값, 검정 = 계산식, 녹색 = 다른 시트 참조, 노란 바탕 = 결과에 영향이 큰 핵심 가정·결과"],
    ["차트 색", (MT.dcf && MT.rel ? "남색 = 적정가치 산정 요소(DCF·상대가치 종합), " : "") + (MT.rel ? "청록 = 상대가치 산정 배수, " : "") + "주황 = 최종 비교(적정가치·시장가치" + (wsRef ? "·참고가격" : "") + "). 막대 왼쪽 = 하단, 오른쪽 = 상단, 막대 안 흰 글자 = 중앙값(막대가 짧으면 생략)"],
    ["다시 계산", "파일을 열면 전 시트가 다시 계산됨(Excel·Google 스프레드시트). 가정 시트의 파란 글자를 바꾸면 요약·차트까지 바뀜"],
    ["유의사항", spec.disclaimer || "공시·시장 자료로 만든 참고용 모델이며 평가 의견·투자 권유가 아님. 실사 결과와 거래 조건에 따라 달라질 수 있음"],
    ["자료", spec.source || ""]
  ];
  kv.forEach(([k, v]) => { S.put(wsCover, `A${r}`, k, { bold: true, fill: "EEF2F8" }); S.put(wsCover, `B${r}`, v, { wrap: true }); wsCover.getRow(r).height = 30; r++; });
  setup(wsCover, conf);

  const buf = await wb.xlsx.writeBuffer();
  const out = await injectCharts(Buffer.from(buf), charts);
  return { buffer: out, title: spec.title || `${names.join("·")} 가치평가`, summary: M.cos.map(x => ({ name: x.c.name, dcf: x.dcf, comp: x.comp, fair: x.fv, market: x.mkt, wacc: x.wacc, refs: x.refs ? { tx: x.refs.tx, supp: x.refs.supp, book: x.refs.book, sel: REF_LABEL[x.refs.sel] } : null, base_price: x.mp ? x.mp.base : null })) };
}

module.exports = { buildValuationWorkbook, compute, validate };
