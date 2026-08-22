export const PROVIDER_LABELS: Record<string, string> = {
  openalex: "OpenAlex",
  arxiv: "arXiv",
  riss: "RISS",
  rss: "RSS",
  homepage: "홈페이지",
  manual: "직접 입력",
  upload: "파일 업로드",
};

export const SOURCE_KIND_LABELS: Record<string, string> = {
  PERSONAL_WORK: "개인 작업",
  PERSONAL_TEXT: "개인 텍스트",
  PAPER_ACADEMIC: "학술 논문",
  BOOK_ARTICLE: "책·아티클",
  ARTIST_ARTWORK: "작가·작품",
  TECHNICAL: "기술 자료",
  WEB: "웹 자료",
  NOTE: "메모",
  DISCOVERY: "발견 자료",
};

export const RELIABILITY_LABELS: Record<string, string> = {
  PRIMARY: "1차 자료",
  SECONDARY: "2차 자료",
  TERTIARY: "3차 자료",
  UNKNOWN: "출처 미상",
};

export const ORIGIN_LABELS: Record<string, string> = {
  upload: "파일 업로드",
  "upload:md": "마크다운 업로드",
  "upload:pdf": "PDF 업로드",
  manual: "직접 입력",
  url: "웹 주소 수집",
  discovery: "발견 수집",
};

export const INGEST_CHANNEL_LABELS: Record<string, string> = {
  MANUAL: "직접 입력",
  OBSIDIAN: "Obsidian 동기화",
  DISCOVERY: "발견 수집",
  HOMEPAGE: "홈페이지 수집",
};

export const INPUT_FORMAT_LABELS: Record<string, string> = {
  PLAIN_TEXT: "플레인 텍스트",
  MARKDOWN: "마크다운",
  OBSIDIAN_MARKDOWN: "Obsidian 마크다운",
  URL_HTML: "웹 페이지 HTML",
  PDF_TEXT: "텍스트 PDF",
  PDF_SCAN: "스캔 PDF",
  HOMEPAGE_JSON: "홈페이지 JSON",
  DISCOVERY_LINK: "발견 링크",
};

export const QUALITY_STATUS_LABELS: Record<string, string> = {
  UNREVIEWED: "검수 전",
  READY: "분석 가능",
  REVIEW: "검토 필요",
  EMPTY: "읽을 텍스트 없음",
  FAILED: "처리 실패",
};

export const VERSION_ORIGIN_LABELS: Record<string, string> = {
  INITIAL_INGEST: "최초 수신",
  OBSIDIAN_SYNC: "Obsidian 동기화",
  REEXTRACT: "다시 추출",
  RENORMALIZE: "다시 정규화",
  MANUAL_EDIT: "수동 편집",
};

export const VERSION_REVIEW_LABELS: Record<string, string> = {
  ACTIVE: "현재 사용 중",
  PENDING_REVIEW: "검토 대기",
  SUPERSEDED: "이전 버전",
  REJECTED: "제외됨",
};

export const PRIORITY_LABELS: Record<string, string> = {
  MUST: "우선 읽기",
  WORTH: "읽어볼 만함",
  REFERENCE: "참고",
};

export const PROVENANCE_LABELS: Record<string, string> = {
  SOURCE: "원자료",
  INTERPRETATION: "시스템 해석",
  SYNTHESIS: "종합 결과",
  DISCOVERY: "발견 후보",
};

export const RESEARCH_GAP_LABELS: Record<string, string> = {
  "under-evidenced": "근거 부족",
  "missing-source": "출처 필요",
  "conflicting-claims": "주장 충돌",
  "needs-firsthand-research": "직접 조사 필요",
  "artistically-possible-academically-untested": "작업 가능성·학술 검증 필요",
};

export const RADAR_SECTION_LABELS: Record<string, string> = {
  "rising keywords — what is growing this week": "이번 주 새로 떠오른 키워드",
  "이번 주 새로 떠오른 키워드": "이번 주 새로 떠오른 키워드",
  "recurring questions": "반복해서 남은 질문",
  "반복해서 남은 질문": "반복해서 남은 질문",
  "interesting sentences/fragments noticed": "눈에 걸린 문장과 단편",
  "new connections between distant materials": "멀리 있는 자료 사이의 새 연결",
  "unexpected material": "예상 밖의 자료",
  "repeating patterns": "반복되는 패턴",
  "movement of interests (what faded, what grew)": "관심의 이동",
  "research thread candidates": "연구 흐름 후보",
  "unresolved questions": "아직 풀리지 않은 질문",
  "over-concentrated areas (watch for fixation)": "집중이 과한 영역",
  "long-term research trajectory": "장기 연구 궤적",
  "recurring problematics across the year": "올해 반복된 문제의식",
  "new research axes that emerged": "새로 생긴 연구 축",
  "weakened interests": "약해진 관심",
  "next research possibilities": "다음 연구 가능성",
};

export const KEYWORD_LABELS: Record<string, string> = {
  photography: "사진",
  theory: "이론",
  "network-culture": "네트워크 문화",
  "machine-vision": "기계 비전",
  ai: "인공지능",
  data: "데이터",
  "visual-culture": "시각 문화",
  "contemporary-art": "동시대 미술",
  "photography-theory": "사진 이론",
  "image-theory": "이미지 이론",
  "data-epistemology": "데이터 인식론",
  "media-art-history": "미디어 아트 역사",
  materiality: "물질성",
  "body-embodiment": "신체·체화",
  "archive-memory": "아카이브·기억",
  "surveillance-power": "감시·권력",
  "network-transmission": "네트워크·전송",
  "light-optics": "빛·광학",
  "craft-analog": "공예·아날로그",
  "sound-audio": "소리·오디오",
};

export function labelOf(labels: Record<string, string>, value: unknown, fallback = "정보 없음"): string {
  if (value == null || value === "") return fallback;
  return labels[String(value)] ?? String(value);
}
