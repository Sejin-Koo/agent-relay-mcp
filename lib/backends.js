// 중계 대상 서버와 열어 둘 도구 목록.
// - 서버를 추가하려면 항목 하나를 더하고 재배포한다.
// - tools 에 적은 도구만 공개된다(목록 밖 도구는 tools/list 에도 안 보이고 호출도 거부된다).
// - 접근 키는 코드에 두지 않는다. 기본은 환경변수 BACKEND_KEY, 서버별로 다르면 keyEnv 로 지정한다.
// - 외부 서버처럼 키를 보내면 안 되는 곳은 noKey: true 로 둔다.
// - path 가 /api/mcp 가 아닌 서버가 있으므로(sec-edgar 는 /mcp) 주소는 전체를 적는다.

const BACKENDS = {
  kma: {
    label: "기상청 날씨",
    url: "https://kma-weather-mcp.vercel.app/api/mcp",
    tools: ["kma_short_forecast", "kma_mid_forecast", "kma_warnings", "kma_find_code"]
  },
  naver: {
    label: "네이버 검색",
    url: "https://naver-search-mcp-ten.vercel.app/api/mcp",
    tools: ["collect_naver_news", "collect_naver_comments", "search_naver"]
  },
  pubdata: {
    label: "공공데이터",
    url: "https://public-data-portal-mcp.vercel.app/api/mcp",
    tools: [
      "resolve_bizno", "get_national_pension_workplace", "get_employment_insurance_workplace",
      "search_narajangteo_scsbid", "get_narajangteo_openg_result",
      "scan_narajangteo_procurement", "scan_agency_bids", "scan_dapa_plan", "scan_nia_board",
      "scan_gov_biz_announcements"
    ]
  },
  dart: {
    label: "DART 전자공시",
    url: "https://dart-mcp-koo3.vercel.app/api/mcp",
    tools: [
      "dart_search_corp_code", "dart_search_disclosure", "dart_get_company_info",
      "dart_get_representatives", "dart_get_financial_statement", "dart_get_periodic_report_item",
      "dart_get_equity_disclosure", "dart_get_major_report_item", "dart_get_document_text",
      "dcf_calculate"
    ]
  },
  ip: {
    label: "지식재산처",
    url: "https://kipris-mcp.vercel.app/api/mcp",
    tools: ["search_all_ip"]
  },
  corp: {
    label: "금융위 기업정보",
    url: "https://fss-corp-info-mcp.vercel.app/api/mcp",
    tools: ["get_corp_basic_info", "get_ksd_corp_info"]
  },
  krxd: {
    label: "KRX 시세",
    url: "https://krx-market-mcp-ten.vercel.app/api/mcp",
    tools: ["krx_get_stock_daily"]
  },
  sec: {
    label: "SEC EDGAR",
    url: "https://sec-edgar-mcp-pied.vercel.app/mcp",
    tools: ["search_company", "get_company_filings", "get_company_facts", "get_major_shareholders", "get_filing_section"]
  },
  law: {
    label: "법제처",
    url: "https://korean-law-mcp-five.vercel.app/api/mcp",
    tools: [
      "search_law", "get_law_text", "get_law_history", "search_admin_rule", "get_admin_rule",
      "search_annex", "search_precedent", "get_precedent", "search_interpretation", "get_interpretation"
    ]
  },
  krxr: {
    label: "KRX 거래소 규정",
    url: "https://krx-regulation-mcp.vercel.app/api/mcp",
    tools: ["search_krx_regulation", "get_krx_rule_fulltext", "get_krx_regulation_page"]
  },
  kasb: {
    label: "회계기준원",
    url: "https://kasb-accounting-mcp.vercel.app/api/mcp",
    tools: ["search_kasb_standard", "get_kasb_standard_text", "search_kasb_qna", "get_kasb_qna_detail"]
  }
};

// 도구 이름 -> 서버 id. 이름이 겹치면 배포 전에 바로 드러나도록 예외를 던진다.
const ROUTE = {};
for (const [id, b] of Object.entries(BACKENDS)) {
  for (const t of b.tools) {
    if (ROUTE[t]) throw new Error(`도구 이름 중복: ${t} (${ROUTE[t]}, ${id})`);
    ROUTE[t] = id;
  }
}

module.exports = { BACKENDS, ROUTE };
