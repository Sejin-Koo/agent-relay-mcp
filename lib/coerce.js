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
  if (typeof v === "number" || typeof v === "boolean") v = String(v);
  if (typeof v !== "string") return v;
  if (Array.isArray(s.enum) && !s.enum.includes(v)) {
    const hit = s.enum.find(e => typeof e === "string" && e.toLowerCase() === v.trim().toLowerCase());
    if (hit !== undefined) return hit;
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

// 최상위 인자만 본다(배열 원소는 items 스키마로). 바꾼 내역을 함께 돌려준다.
function coerceArgs(schema, args) {
  if (!schema || typeof schema !== "object" || !schema.properties || !args || typeof args !== "object" || Array.isArray(args)) {
    return { args, changes: [] };
  }
  const out = {}, changes = [];
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
  return { args: out, changes };
}

module.exports = { coerceArgs, coerceValue };
