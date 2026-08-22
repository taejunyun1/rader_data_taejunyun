import { describe, expect, it } from "vitest";
import { deriveSourceAccess } from "./sourceAccess";

describe("deriveSourceAccess", () => {
  it("labels arXiv PDFs without claiming a free article", () => {
    expect(deriveSourceAccess({ provider: "arxiv", href: "https://arxiv.org/pdf/1234" }).kind).toBe("PDF");
  });

  it("uses institution wording for RISS", () => {
    expect(deriveSourceAccess({ provider: "riss", href: "https://www.riss.kr/link" })).toMatchObject({ kind: "INSTITUTION", label: "기관 인증 여부 확인" });
  });

  it("does not claim access when no URL exists", () => {
    expect(deriveSourceAccess({ provider: "openalex", href: null })).toMatchObject({ kind: "UNKNOWN", href: null });
  });

  it("treats an OpenAlex work page as access metadata, not full text", () => {
    expect(deriveSourceAccess({ provider: "openalex", href: "https://openalex.org/W123", verified: true }).kind).toBe("ABSTRACT");
  });

  it("marks known publisher pages as potentially paywalled", () => {
    expect(deriveSourceAccess({ provider: "rss", href: "https://www.artnews.com/art-news/example/" })).toMatchObject({
      kind: "PAYWALLED",
      label: "구독·유료 접근 가능성",
      actionLabel: "접근 상태 확인",
    });
  });
});
