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

export function labelOf(labels: Record<string, string>, value: unknown, fallback = "정보 없음"): string {
  if (value == null || value === "") return fallback;
  return labels[String(value)] ?? String(value);
}
