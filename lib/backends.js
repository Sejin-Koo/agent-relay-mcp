// 중계 대상 서버와 열어 둘 도구 목록.
// - 서버를 추가하려면 항목 하나를 더하고 재배포한다.
// - tools 에 적은 도구만 공개된다(목록 밖 도구는 tools/list 에도 안 보이고 호출도 거부된다).
// - 접근 키는 코드에 두지 않는다. 기본은 환경변수 BACKEND_KEY, 서버별로 다르면 keyEnv 로 지정한다.
// - 외부 서버처럼 키를 보내면 안 되는 곳은 noKey: true 로 둔다.
// - path 가 /api/mcp 가 아닌 서버가 있으므로(sec-edgar 는 /mcp) 주소는 전체를 적는다.
// - prefix 를 두면 이 서버의 도구는 "prefix+원래이름"으로 공개되고, 호출할 때는 원래 이름으로 넘긴다.
//   외부 서버의 도구 이름이 search·fetch처럼 너무 일반적일 때 쓴다. tools 에는 원래 이름을 적는다.
//   descNote 는 그렇게 이름을 바꾼 도구의 설명 끝에 붙는다(설명 속 원래 이름을 새 이름으로 읽게 하는 안내).

const BACKENDS = {
  kma: {
    label: "기상청 날씨",
    url: "https://kma-weather-mcp.vercel.app/api/mcp",
    tools: [
      "kma_short_forecast", "kma_mid_forecast", "kma_warnings", "kma_find_code",
      "kma_forecast_text", "kma_forecast_version", "kma_forecast_archive", "kma_impact_forecast",
      "kma_warning_history", "kma_warning_map", "kma_highway_weather", "kma_road_weather",
      "kma_tour_weather", "kma_living_index", "kma_uv_observation"
    ]
  },
  naver: {
    label: "네이버·카카오 검색",
    url: "https://naver-search-mcp-ten.vercel.app/api/mcp",
    tools: [
      "collect_naver_news", "collect_naver_comments", "search_naver", "search_kakao", "datalab_search_trend",
      "datalab_shopping_insight"
    ]
  },
  pubdata: {
    label: "공공데이터",
    url: "https://public-data-portal-mcp.vercel.app/api/mcp",
    tools: [
      "resolve_bizno", "get_national_pension_workplace", "get_employment_insurance_workplace", "get_accident_insurance_rate",
      "search_narajangteo_scsbid", "scan_narajangteo_awards", "get_narajangteo_openg_result", "scan_narajangteo_procurement", "scan_agency_bids",
      "scan_dapa_plan", "scan_nia_board", "scan_gov_biz_announcements", "search_franchise_disclosure",
      "get_franchise_disclosure", "search_franchise_headquarters", "get_franchise_brand_stores", "search_drug_easy_info",
      "search_drug_ingredients", "search_drug_permission", "search_drug_permission_list", "search_health_functional_food", "analyze_health_functional_food",
      "search_pill_identification", "search_onbid_realestate", "get_onbid_realestate_detail", "search_onbid_bid_results",
      "search_onbid_notices", "get_onbid_notice_detail", "get_onbid_bid_info", "get_new_vehicle_registrations",
      "get_vehicle_registration_stock", "get_molit_vehicle_stat"
    ]
  },
  dart: {
    label: "DART 전자공시",
    url: "https://dart-mcp-koo3.vercel.app/api/mcp",
    tools: [
      "dart_search_corp_code", "dart_search_disclosure", "dart_get_company_info",
      "dart_get_representatives", "dart_get_financial_statement", "dart_get_periodic_report_item",
      "dart_get_equity_disclosure", "dart_get_major_report_item", "dart_get_document_text", "dart_get_securities_report_item"
    ]
  },
  // 자체 밸류에이션 서버(2026-10-21). dcf_calculate는 dart-mcp에서 옮겼고(dart-mcp에서는 삭제),
  // beta_regression·dart_business_section은 외부 DCF Peer Group의 compute_beta·get_business_content 대신 쓴다.
  // dart_ebitda_inputs(감가상각비·TTM 흐름값, 2026-10-22)는 기업가치 평가 에이전트의 EV/EBITDA·TTM 배수용.
  // peer_statistics·wacc_calculate·ecos_get_market_rates(2026-10-22)는 피어 통계·할인율을 모델이 손으로 계산하지 않게 하려고 연다.
  // 이 서버의 MCP_GATE_KEYS에 중계 서버 내부 키가 등록돼 있다.
  valuation: {
    label: "밸류에이션 계산",
    url: "https://valuation-mcp.vercel.app/api/mcp",
    tools: ["dcf_calculate", "beta_regression", "dart_business_section", "dart_ebitda_inputs", "peer_statistics", "wacc_calculate", "ecos_get_market_rates"]
  },
  ip: {
    label: "지식재산처",
    url: "https://kipris-mcp.vercel.app/api/mcp",
    tools: [
      "search_all_ip", "search_patents", "search_patents_keyword", "search_patents_advanced",
      "get_patent_detail", "search_trademarks", "search_trademarks_keyword", "search_designs",
      "search_designs_keyword"
    ]
  },
  corp: {
    label: "금융위 기업정보",
    url: "https://fss-corp-info-mcp.vercel.app/api/mcp",
    tools: [
      "get_corp_basic_info", "get_ksd_corp_info", "get_disclosure_info", "get_stock_issuance_info",
      "get_financial_company_info", "get_conglomerate_finance_status", "get_circular_investment_status"
    ]
  },
  krxd: {
    label: "KRX 시세",
    url: "https://krx-market-mcp-ten.vercel.app/api/mcp",
    tools: [
      "krx_get_stock_daily", "krx_get_index_daily", "krx_get_etf_daily", "krx_get_bond_daily",
      "krx_get_commodity_daily", "krx_get_timeseries", "krx_list_listed"
    ]
  },
  // 외부 공개 서버(우리 소유 아님, 키 없이 누구나 사용 — 사용자 확인 2026-10-21). 우리 접근 키를 보내지 않도록 noKey.
  // 주소는 운영자 공식 주소(2026-10-21 사용자 커넥터 재등록과 같은 주소로 변경, 이전 dcf-peergroup-search.vercel.app).
  // 수집 데이터가 필요한 3개만 연다. compute_beta·get_business_content·search_stock은 2026-10-21
  // valuation-mcp beta_regression·dart_business_section, KRX krx_list_listed로 대체해 닫았다.
  // dart_get_company·dart_get_financials·naver_get_market_data는 valuation_get_data와 겹쳐 열지 않는다.
  dcfpeer: {
    label: "DCF Peer Group(외부)",
    url: "https://krvaluation.procpa.co.kr/api/mcp",
    noKey: true,
    tools: [
      "search_by_industry", "peergroup_get_population", "valuation_get_data"
    ]
  },
  sec: {
    label: "SEC EDGAR",
    url: "https://sec-edgar-mcp-pied.vercel.app/mcp",
    tools: [
      "search_company", "get_company_filings", "get_company_facts", "get_major_shareholders",
      "get_filing_section", "full_text_search", "list_filing_documents", "get_executive_compensation",
      "get_institutional_holdings", "get_insider_transactions", "fetch_frames"
    ]
  },
  law: {
    label: "법제처",
    url: "https://korean-law-mcp-five.vercel.app/api/mcp",
    tools: [
      "search_law", "get_law_text", "get_law_history", "search_admin_rule",
      "get_admin_rule", "search_annex", "search_precedent", "get_precedent",
      "search_interpretation", "get_interpretation", "search_committee_decision", "get_committee_decision",
      "search_constitutional_decision", "search_law_term", "search_ordinance", "search_english_law"
    ]
  },
  krxr: {
    label: "KRX 거래소 규정",
    url: "https://krx-regulation-mcp.vercel.app/api/mcp",
    tools: ["search_krx_regulation", "get_krx_rule_fulltext", "get_krx_regulation_page"]
  },
  // 거래소 해설서(공시·상장관리 해설, 상장심사 실무서, 규정 별표) — 문서 저장소의 공개 컬렉션 하나만 연다.
  // 접속 키는 그 컬렉션의 조회 도구만 통과하는 범위 제한 키(PDF_DB_SCOPED_KEY)만 쓴다(strictKey — 없으면 BACKEND_KEY로 대신하지 않음).
  // 이 키로는 tools/list가 막히므로 도구 정의를 staticTools로 두고, collection은 forceArgs로 고정한다.
  // 사규·도서 등 다른 컬렉션은 여러 회사 사용자에게 열지 않는다(사내 자료 보호).
  krxdoc: {
    label: "거래소 해설서",
    url: "https://pdf-vector-db-mcp.vercel.app/api/mcp",
    keyEnv: "PDF_DB_SCOPED_KEY",
    strictKey: true,
    forceArgs: { collection: "krx_listing_disclosure" },
    tools: ["search_book_library", "get_chunk_text"],
    staticTools: [
      {
        name: "search_book_library",
        description: "한국거래소 해설서(유가증권·코스닥 공시·상장관리 해설, 상장심사 실무서, 규정 별표 해설)를 자연어로 의미 검색한다. 결과는 관련도 순으로 문서명·발행연월·페이지 범위·발췌문. 벌점 배점 실례, 위반 사례, 관리종목·실질심사 실무 해석을 찾을 때 쓴다. 해설서는 공식 규정이 아니므로 결론의 근거는 규정 원문으로 확인한다. 발췌가 '...'로 끝나면 max_chars=0으로 다시 부르거나 get_chunk_text로 전문을 받는다.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", description: "자연어 검색어 또는 질문" },
            top_k: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "결과 개수(기본 5)" },
            max_chars: { type: "integer", minimum: 0, maximum: 20000, default: 700, description: "발췌 최대 글자 수(0이면 청크 전문)" },
            collection: { type: "string", description: "넣지 않아도 된다(거래소 해설 컬렉션으로 고정)" }
          },
          required: ["query"]
        }
      },
      {
        name: "get_chunk_text",
        description: "거래소 해설서의 특정 부분 전문을 자르지 않고 받는다. search_book_library 결과의 문서명과 시작 페이지(p.앞 숫자)를 넣는다. page_start(정확 일치), page_from~page_to(범위), chunk_index 중 하나로 지정하고, 아무 조건도 없으면 그 문서의 페이지 청크 목록을 준다.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            doc_title: { type: "string", description: "문서명(부분일치, 공백 무시). 예: 코스닥시장 공시·상장관리 해설" },
            page_start: { type: "integer", description: "청크의 시작 페이지" },
            page_from: { type: "integer", description: "페이지 범위 시작" },
            page_to: { type: "integer", description: "페이지 범위 끝" },
            chunk_index: { type: "integer", description: "청크 인덱스" },
            limit: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "반환할 청크 최대 개수" },
            collection: { type: "string", description: "넣지 않아도 된다(거래소 해설 컬렉션으로 고정)" }
          }
        }
      }
    ]
  },
  kasb: {
    label: "회계기준원",
    url: "https://kasb-accounting-mcp.vercel.app/api/mcp",
    tools: ["search_kasb_standard", "get_kasb_standard_text", "search_kasb_qna", "get_kasb_qna_detail"]
  },
  // 외부 공개 서버(회계위키, 우리 소유 아님, 인증 없이 무료 — 사용자 확인 2026-10-21). 접근 키를 보내지 않도록 noKey.
  // 도구 이름이 search·fetch처럼 일반적이라 accwiki_ 접두어를 붙여 공개한다.
  // 운영자가 서버를 바꾸거나 내리면 이 도구들도 같이 멈춘다. 공식 해석이 아니며, 인용 시 응답의 출처 URL을 표기한다.
  accwiki: {
    label: "회계위키(외부)",
    url: "https://accountingwiki.co.kr/api/mcp",
    noKey: true,
    prefix: "accwiki_",
    descNote: " [중계 서버 안내: 이 설명에 나오는 회계위키 도구 이름(search·fetch·get_paragraphs 등)은 이 서버에서 앞에 accwiki_ 가 붙는다. 회계위키는 실무 참고용이며 공식 해석이 아니다.]",
    tools: [
      "find_evidence", "search", "fetch", "get_paragraphs",
      "get_standard", "get_qna", "list_standards", "get_related",
      "verify_quote", "list_audit_cases", "get_topic"
    ]
  },
  // ---- 업종별 에이전트용 서버(2026-10-21 추가). 이 서버들의 MCP_GATE_KEYS에 중계 서버 내부 키가 등록돼 있어야 한다 ----
  macro: {
    label: "시장·거시 지표",
    url: "https://market-macro-mcp.vercel.app/api/mcp",
    tools: [
      "exim_get_fx", "exim_get_fx_series", "exim_get_interest", "kosis_search_tables",
      "kosis_get_table_meta", "kosis_get_data", "kepco_get_data", "kepco_get_codes",
      "rtms_find_region", "rtms_get_deals", "holiday_get_days"
    ]
  },
  constr: {
    label: "건설",
    url: "https://construction-mcp.vercel.app/api/mcp",
    tools: [
      "search_housing_permits", "search_housing_sales", "scan_national_housing_pipeline", "scan_construction_pipeline",
      "search_arch_permits", "scan_arch_permits", "get_arch_permit_detail", "search_arch_aux_registers",
      "search_construction_firms", "search_construction_sanctions", "get_construction_notice_stats", "search_cals_construction",
      "get_cals_construction_detail", "search_cals_contractor", "search_cals_project_evaluation", "search_cals_quality_tests",
      "search_cals_road_occupancy"
    ]
  },
  trade: {
    label: "상권",
    url: "https://trade-area-mcp.vercel.app/api/mcp",
    tools: [
      "resolve_region", "stores_nearby", "store_industry_mix", "permit_open_close_trend",
      "search_permits", "region_demographics", "region_business_stats", "seoul_trade_areas",
      "seoul_trade_area_stats", "seoul_living_population", "seoul_living_population_trend", "seoul_dong_codes",
      "trade_area_report", "list_industry_codes", "list_data_sources", "convert_coords",
      "naver_geocode", "naver_reverse_geocode"
    ]
  },
  // 웹 검색·웹페이지 읽기(HWP·HWPX 포함). 2026-10-23 중계 서버 안(lib/web.js)에서 독립 서버로 옮겼다 —
  // 중계 서버를 내려도 계정 커넥터가 같은 도구를 쓸 수 있게(사용자 결정: 중계 서버에만 있는 도구는 두지 않는다).
  // sendCaller: 사람별 하루 한도를 에이전트 사용자 단위로 세도록 X-Relay-Caller 헤더를 보낸다(그 서버는 relay 키일 때만 믿는다).
  web: {
    label: "웹",
    url: "https://web-reader-mcp-five.vercel.app/api/mcp",
    sendCaller: true,
    tools: ["web_search", "fetch_page"]
  },
  // 업무 에이전트 페이지의 파일 만들기(lib/files.js). hidden이라 도구 목록·도구 찾기에는 나오지 않고 relay_call로만 부른다.
  files: {
    label: "파일 만들기",
    local: true,
    module: "files",
    hidden: true,
    tools: ["build_file", "file_chunk"]
  },
  // 논문 검색(2026-10-28): PubMed·Europe PMC·OpenAlex·Semantic Scholar·bioRxiv/medRxiv·Unpaywall.
  // 이 서버의 MCP_GATE_KEYS에 중계 서버 내부 키가 등록돼 있다.
  scholar: {
    label: "논문 검색",
    url: "https://scholar-mcp.vercel.app/api/mcp",
    tools: [
      "scholar_search", "scholar_get_paper", "scholar_citations", "scholar_preprints_recent",
      "scholar_find_pdf", "scholar_api_status"
    ]
  },
  // 신약·임상·규제·경쟁사(2026-10-28): ClinicalTrials.gov·openFDA·EMA·식약처 임상시험계획.
  // 이 서버의 MCP_GATE_KEYS에 중계 서버 내부 키가 등록돼 있다.
  pharmaintel: {
    label: "신약·임상·규제",
    url: "https://pharma-intel-mcp.vercel.app/api/mcp",
    tools: [
      "ct_search_trials", "ct_get_trial", "ct_landscape", "ct_company_pipeline",
      "fda_approvals", "fda_label", "fda_adverse_events", "fda_recalls",
      "ema_search", "mfds_clinical_trials", "pharma_competitor_profile", "pharma_api_status"
    ]
  },
  youtube: {
    label: "YouTube",
    url: "https://youtube-search-mcp-zeta.vercel.app/api/mcp",
    tools: [
      "youtube_search_videos", "youtube_get_videos", "youtube_get_comments", "youtube_search_channels",
      "youtube_get_channels", "youtube_list_channel_videos", "youtube_trending_videos"
    ]
  }
};

// 공개 이름 -> 서버 id, 공개 이름 -> 서버의 원래 이름. 이름이 겹치면 배포 전에 바로 드러나도록 예외를 던진다.
const ROUTE = {};
const UPSTREAM = {};
for (const [id, b] of Object.entries(BACKENDS)) {
  for (const t of b.tools) {
    const name = (b.prefix || "") + t;
    if (ROUTE[name]) throw new Error(`도구 이름 중복: ${name} (${ROUTE[name]}, ${id})`);
    ROUTE[name] = id;
    UPSTREAM[name] = t;
  }
}

module.exports = { BACKENDS, ROUTE, UPSTREAM };
