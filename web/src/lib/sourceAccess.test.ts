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
});
