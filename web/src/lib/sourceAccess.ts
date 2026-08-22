import { classifyDiscoveryAccess, type DiscoveryAccessStatus } from "@radar/shared/discovery";

export type SourceAccessKind = "DIRECT" | "PDF" | "INSTITUTION" | "ABSTRACT" | "PAYWALLED" | "UNKNOWN";

export interface SourceAccessInput {
  provider?: string | null;
  href?: string | null;
  verified?: boolean;
  accessStatus?: DiscoveryAccessStatus;
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
  const accessStatus = input.accessStatus ?? classifyDiscoveryAccess(provider, href);
  if (accessStatus === "INSTITUTION") {
    return { kind: "INSTITUTION", label: "기관 인증 여부 확인", actionLabel: "RISS에서 확인", href };
  }
  if (accessStatus === "PDF") {
    return { kind: "PDF", label: "PDF 제공", actionLabel: "PDF 읽기", href };
  }
  if (accessStatus === "UNKNOWN" && (provider === "openalex" || href.includes("openalex.org"))) {
    return { kind: "ABSTRACT", label: "서지·접근 정보", actionLabel: "OpenAlex에서 확인", href };
  }
  if (accessStatus === "PAYWALLED") {
    return { kind: "PAYWALLED", label: "구독·유료 접근 가능성", actionLabel: "접근 상태 확인", href };
  }
  if (accessStatus === "FREE_FULLTEXT") {
    return { kind: "DIRECT", label: "무료 원문 확인", actionLabel: "원문 읽기", href };
  }
  return { kind: "UNKNOWN", label: "접근 여부 미확인", actionLabel: "출처 확인", href };
}
