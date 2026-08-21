export type SourceAccessKind = "DIRECT" | "PDF" | "INSTITUTION" | "ABSTRACT" | "UNKNOWN";

export interface SourceAccessInput {
  provider?: string | null;
  href?: string | null;
  verified?: boolean;
}

export interface SourceAccess {
  kind: SourceAccessKind;
  label: string;
  actionLabel: string;
  href: string | null;
}

export function deriveSourceAccess(input: SourceAccessInput): SourceAccess {
  const provider = input.provider?.toLowerCase() ?? "";
  const href = input.href ?? null;
  if (!href) return { kind: "UNKNOWN", label: "접근 경로 확인 필요", actionLabel: "출처 정보 보기", href: null };
  if (provider === "riss" || href.includes("riss.kr")) {
    return { kind: "INSTITUTION", label: "기관 인증 여부 확인", actionLabel: "RISS에서 확인", href };
  }
  if (provider === "arxiv" || href.includes("arxiv.org/pdf") || href.toLowerCase().endsWith(".pdf")) {
    return { kind: "PDF", label: "PDF 제공", actionLabel: "PDF 읽기", href };
  }
  if (provider === "openalex" || href.includes("openalex.org")) {
    return { kind: "ABSTRACT", label: "서지·접근 정보", actionLabel: "OpenAlex에서 확인", href };
  }
  return { kind: "DIRECT", label: "원문 링크", actionLabel: "원문에서 읽기", href };
}
