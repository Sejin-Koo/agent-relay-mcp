// 도구 인자를 담당 서버의 inputSchema 에 맞춰 고친다.
// 페이지의 모델은 묶음 도구의 args 를 자유 객체로 넘기므로 서버 스키마의 형식·범위를 모르고
// 숫자/문자열을 바꿔 쓰거나(year: 2025) 범위 밖 값(max_section_chars: 200)을 넣는다.
// 그러면 담당 서버가 -32602 입력 검증 오류를 돌려주고, 모델은 같은 호출을 되풀이한다.
// 뜻이 분명한 변환만 한다: 형 변환, 범위 끝으로 맞추기, 숫자 형식(날짜·코드)의 구분자 제거·앞자리 0,
// enum 대소문자, 스키마에 없는 인자(추가 인자를 받지 않는 도구) 빼기.

function typesOf(s) {
  if (!s || typeof s !== "object") return [];
  if (Array.isArray(s.type)) return s.type;
  return s.type ? [s.type] : [];
}

function matchesType(v, t) {
  switch (t) {
    case "string": return typeof v === "string";
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v);
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
    case "null": return v === null;
    default: return true;
  }
}

function patternOk(s, v) {
  if (!s.pattern) return true;
  try { return new RegExp(s.pattern).test(v); } catch (e) { return true; }
}

function fixString(s, v) {
  // 원소 하나짜리 목록(["1068104924"])은 그 원소로 푼다. 원소가 여럿이면 뜻을 골라야 하므로 두지 않는다
  if (Array.isArray(v) && v.length === 1 && ["string", "number", "boolean"].includes(typeof v[0])) v = v[0];
  if (typeof v === "number" || typeof v === "boolean") v = String(v);
  if (typeof v !== "string") return v;
  if (Array.isArray(s.enum) && !s.enum.includes(v)) {
    const hit = s.enum.find(e => typeof e === "string" && e.toLowerCase() === v.trim().toLowerCase());
    if (hit !== undefined) return hit;
    // 앞부분이 같은 값이 하나뿐이면 그 값(treasury_stock → treasury_stock_periodic). 4자 미만은 두지 않는다
    const t = v.trim().toLowerCase();
    // 한글 등 비ASCII 값은 두 글자부터(코스닥 → 코스닥시장), 영문은 네 글자부터
    if (t.length >= 4 || (t.length >= 2 && /[^\x00-\x7f]/.test(t))) {
      const pre = s.enum.filter(e => typeof e === "string" && e.toLowerCase().startsWith(t));
      if (pre.length === 1) return pre[0];
      // 반대로 enum 값 하나가 단어 경계(_ - 공백)까지 값의 앞부분과 같으면 그 값
      // (원 자료의 긴 필드명: indications_and_usage → indications, dosage_and_administration → dosage)
      const head = s.enum.filter(e => typeof e === "string" && e.length >= 4 &&
        t.startsWith(e.toLowerCase()) && /[_\-\s]/.test(t.charAt(e.length)));
      if (head.length === 1) return head[0];
    }
  }
  if (!patternOk(s, v)) {
    let w = v.trim().replace(/[\s\-./,]/g, "");
    // ^\d{6}$ 같은 고정 자릿수 숫자 형식이면 앞자리 0 을 채운다(053800 → 53800 으로 온 경우)
    const m = s.pattern && s.pattern.match(/^\^(?:\\d|\[[^\]]*0-9[^\]]*\])\{(\d+)\}\$$/);
    if (m && /^\d+$/.test(w) && w.length < Number(m[1])) w = w.padStart(Number(m[1]), "0");
    if (patternOk(s, w)) return w;
  }
  return v;
}

function fixNumber(s, v, integer) {
  if (typeof v === "string") {
    const t = v.trim().replace(/,/g, "");
    if (t !== "" && Number.isFinite(Number(t))) v = Number(t);
  } else if (typeof v === "boolean") {
    v = v ? 1 : 0;
  }
  if (typeof v !== "number" || !Number.isFinite(v)) return v;
  if (integer && !Number.isInteger(v)) v = Math.round(v);
  if (typeof s.minimum === "number" && v < s.minimum) v = s.minimum;
  if (typeof s.maximum === "number" && v > s.maximum) v = s.maximum;
  if (typeof s.exclusiveMinimum === "number" && v <= s.exclusiveMinimum) v = integer ? s.exclusiveMinimum + 1 : v;
  if (typeof s.exclusiveMaximum === "number" && v >= s.exclusiveMaximum) v = integer ? s.exclusiveMaximum - 1 : v;
  return v;
}

function fixBoolean(v) {
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true" || t === "1" || t === "yes") return true;
    if (t === "false" || t === "0" || t === "no") return false;
  }
  if (v === 1) return true;
  if (v === 0) return false;
  return v;
}

function fixArray(s, v) {
  if (!Array.isArray(v)) {
    if (typeof v === "string") {
      const t = v.trim();
      let parsed = null;
      if (t.startsWith("[")) { try { parsed = JSON.parse(t); } catch (e) { parsed = null; } }
      if (Array.isArray(parsed)) v = parsed;
      else if (t.includes(",")) v = t.split(",").map(x => x.trim()).filter(Boolean);
      else v = [v];
    } else if (v !== undefined && v !== null) {
      v = [v];
    } else {
      return v;
    }
  }
  return s.items ? v.map(x => coerceValue(s.items, x)) : v;
}

function coerceValue(s, v) {
  if (!s || typeof s !== "object" || v === undefined) return v;
  const alts = s.anyOf || s.oneOf;
  if (Array.isArray(alts) && alts.length) {
    if (alts.some(a => typesOf(a).length === 0)) return v; // 아무 형이나 받는 갈래가 있다
    const same = alts.find(a => typesOf(a).some(t => matchesType(v, t)));
    if (same) return coerceValue(same, v);
    for (const a of alts) {
      const w = coerceValue(a, v);
      if (typesOf(a).some(t => matchesType(w, t))) return w;
    }
    return v;
  }
  const types = typesOf(s);
  if (!types.length) return v;
  if (v === null && types.includes("null")) return v;
  // 이미 맞는 형이면 그 형의 범위·형식만 맞춘다
  const order = types.find(t => matchesType(v, t)) ? [types.find(t => matchesType(v, t))] : types;
  for (const t of order) {
    let w = v;
    if (t === "string") w = fixString(s, v);
    else if (t === "integer") w = fixNumber(s, v, true);
    else if (t === "number") w = fixNumber(s, v, false);
    else if (t === "boolean") w = fixBoolean(v);
    else if (t === "array") w = fixArray(s, v);
    if (matchesType(w, t)) return w;
  }
  return v;
}

// ---------- 인자 이름 짝짓기 ----------
// 모델이 스키마와 다른 이름으로 인자를 넣는 일이 잦다(date↔ymd, query↔question, type↔infoType 등).
// 스키마에 없는 이름이 왔고, 스키마의 인자 중 아직 비어 있는 것과 짝이 '하나만' 맞으면 이름을 바꾼다.
// 짝 판정 순서: ① 대소문자·_·- 무시하고 같음 ② 단수·복수 ③ 같은 뜻 이름 묶음 ④ 끝부분 일치(type → infoType).
// 후보가 둘 이상이면 비어 있는 필수 인자로 좁히고, 그래도 둘 이상이면 바꾸지 않는다(뜻을 골라야 하므로).
const SYNONYMS = [
  ["date", "ymd", "day", "yyyymmdd", "basedate", "valuationdate", "evaldate"],
  ["query", "q", "question", "search", "searchterm", "term"],
  ["standard", "std", "standardno", "stdno"],
  ["paragraphs", "paragraph", "paras", "para", "paragraphnos"],
  ["type", "infotype", "kind"],
  ["item", "reportitem"],
  ["company", "companies", "companyname", "corpname"],
  ["industry", "industrycode", "ksic", "ksiccode"],
  ["limit", "maxresults", "max", "size", "topn", "num", "rows", "numofrows"],
  ["bizno", "brno", "businessno", "bizregno"],
  // 기간 — start·end는 쪽 번호로 쓰는 도구가 있어 넣지 않는다
  ["from", "since", "fromdate", "startdate", "sdate", "begindate", "bgnde", "datefrom"],
  ["to", "until", "todate", "enddate", "edate", "endde", "dateto"]
];
const norm = k => String(k).toLowerCase().replace(/[_\-\s]/g, "");
function singular(n) { return n.endsWith("ies") ? n.slice(0, -3) + "y" : n.endsWith("s") ? n.slice(0, -1) : n; }
function nameMatches(from, to) {
  const a = norm(from), b = norm(to);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (singular(a) === singular(b)) return 2;
  if (SYNONYMS.some(g => g.includes(a) && g.includes(b))) return 3;
  if (a.length >= 4 && b.endsWith(a)) return 4;
  return 0;
}
function mapNames(schema, args) {
  const props = schema.properties, required = Array.isArray(schema.required) ? schema.required : [];
  const out = Object.assign({}, args), changes = [];
  for (const k of Object.keys(args)) {
    if (props[k]) continue;
    const empty = Object.keys(props).filter(p => out[p] === undefined);
    let best = 0, cands = [];
    for (const p of empty) {
      const m = nameMatches(k, p);
      if (!m) continue;
      if (!best || m < best) { best = m; cands = [p]; } else if (m === best) cands.push(p);
    }
    if (cands.length > 1) cands = cands.filter(p => required.includes(p));
    if (cands.length !== 1) continue;
    out[cands[0]] = out[k];
    delete out[k];
    changes.push(`${k} → ${cands[0]}(이름)`);
  }
  return { args: out, changes };
}

// 도구별로 서버 내부 조건 때문에 스키마만으로는 알 수 없는 보정. 뜻이 분명한 것만 둔다.
const TOOL_RULES = {
  // 피어 행: valuation_get_data 응답을 그대로 옮기면 marketCap·ibd가 객체라 서버가 NaN으로 거절한다.
  // 시가총액은 price × shares(없으면 total), 이자부부채는 total, 리스는 byCategory.lease, 실적은 financials.* 로 펼친다.
  peer_statistics(a) {
    if (!Array.isArray(a.peers)) return null;
    const num = x => typeof x === "number" && Number.isFinite(x);
    const FIN = ["revenue", "operatingIncome", "netIncomeParent", "equityParent", "incomeMonths", "cash", "shortTermDeposits"];
    let n = 0;
    const peers = a.peers.map(p => {
      if (!p || typeof p !== "object" || Array.isArray(p)) return p;
      const o = Object.assign({}, p); let ch = false;
      const mc = o.marketCap;
      if (mc && typeof mc === "object") {
        o.marketCap = num(mc.price) && num(mc.shares) ? mc.price * mc.shares : (num(mc.total) ? mc.total : null); ch = true;
      }
      const ibd = o.ibd;
      if (ibd && typeof ibd === "object") {
        if (o.lease === undefined && ibd.byCategory && num(ibd.byCategory.lease)) o.lease = ibd.byCategory.lease;
        o.ibd = num(ibd.total) ? ibd.total : null; ch = true;
      }
      const f = o.financials;
      if (f && typeof f === "object") {
        FIN.forEach(k => { if (o[k] === undefined && num(f[k])) { o[k] = f[k]; ch = true; } });
        if ((o.report === undefined || typeof o.report === "object") && f.report && typeof f.report.name === "string") { o.report = f.report.name; ch = true; }
      }
      if (ch) n++;
      return o;
    });
    if (!n) return null;
    return { args: Object.assign({}, a, { peers }), change: `peers: 객체 값을 숫자로 펼침(${n}개 행 — 시가총액=종가×주식수, 이자부부채=total, 실적=financials)` };
  },
  // count 모드는 keywords(목록)만 받는다. keyword 하나를 넣으면 목록으로 옮긴다(extract는 둘 다 받으므로 건드리지 않음)
  dart_get_document_text(a) {
    if (a.mode === "count" && a.keywords === undefined && typeof a.keyword === "string") {
      const o = Object.assign({}, a, { keywords: [a.keyword] }); delete o.keyword;
      return { args: o, change: "keyword → keywords(count 모드)" };
    }
    return null;
  }
};

// 최상위 인자만 본다(배열 원소는 items 스키마로). 바꾼 내역을 함께 돌려준다.
function coerceArgs(schema, args, toolName) {
  if (!schema || typeof schema !== "object" || !schema.properties || !args || typeof args !== "object" || Array.isArray(args)) {
    return { args, changes: [] };
  }
  const mapped = mapNames(schema, args);
  args = mapped.args;
  const out = {}, changes = mapped.changes.slice();
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties[k];
    if (!p) {
      if (schema.additionalProperties === false) { changes.push(`${k}: 제거(스키마에 없음)`); continue; }
      out[k] = v;
      continue;
    }
    const w = coerceValue(p, v);
    if (JSON.stringify(w) !== JSON.stringify(v)) changes.push(`${k}: ${JSON.stringify(v).slice(0, 40)} → ${JSON.stringify(w).slice(0, 40)}`);
    out[k] = w;
  }
  const rule = toolName && TOOL_RULES[toolName];
  if (rule) {
    const r = rule(out);
    if (r) { changes.push(r.change); return { args: r.args, changes }; }
  }
  return { args: out, changes };
}

// 보정 뒤에도 비어 있는 필수 인자 — 담당 서버에 보내기 전에 이름을 알려 주는 데 쓴다
function missingRequired(schema, args, extra) {
  if (!schema || !Array.isArray(schema.required)) return [];
  return schema.required.filter(p => (args || {})[p] === undefined && !(extra && extra[p] !== undefined));
}

module.exports = { coerceArgs, coerceValue, missingRequired, nameMatches };
