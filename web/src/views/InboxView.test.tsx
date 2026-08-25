import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import InboxView from "./InboxView";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    if (String(input) === "/api/inbox") return Promise.resolve(new Response(JSON.stringify({ items: [] })));
    return Promise.resolve(new Response(JSON.stringify({ ok: true, title: "메모" })));
  }));
});

describe("InboxView", () => {
  it("prioritizes original preservation with Korean capture actions", async () => {
    render(<InboxView />);
    expect(await screen.findByRole("heading", { name: "받은 자료" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "메모 보존하기" })).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText("읽은 문장이나 메모를 붙여 넣으세요"), "읽을 문장");
    expect(screen.getByRole("button", { name: "메모 보존하기" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "메모 보존하기" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("메모를 보존했습니다");
  });

  it("separates capture formats so the file guidance is visible before upload", async () => {
    render(<InboxView />);
    await userEvent.click(screen.getByRole("tab", { name: "파일" }));
    expect(screen.getByText("텍스트 PDF·스캔 PDF")).toBeInTheDocument();
    expect(screen.getByText(/PDF 원본은 R2에 보존합니다/)).toBeInTheDocument();
  });

  it("offers a dedicated visual capture mode without mixing it into document upload", async () => {
    render(<InboxView />);
    await userEvent.click(screen.getByRole("tab", { name: "이미지" }));
    expect(screen.getByRole("heading", { name: "이미지 보존" })).toBeInTheDocument();
    expect(screen.getByText(/원본 그대로 보존하고/)).toBeInTheDocument();
    expect(screen.getByLabelText("이미지 파일")).toHaveAttribute("accept", "image/jpeg,image/png,image/webp,image/gif");
  });

  it("shows immediate feedback while opening a selected item", async () => {
    let resolveDetail: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/inbox") {
        return Promise.resolve(new Response(JSON.stringify({
          items: [{
            sourceId: "source-1", title: "검수할 메모", kind: "NOTE", reliability: "PRIVATE", origin: "manual",
            ingestChannel: "MANUAL_TEXT", inputFormat: "PLAIN_TEXT", qualityStatus: "READY", activeVersionId: "version-1",
            versionCount: 1, pendingVersionCount: 0, analysisFresh: false, charCount: 12, status: "stored", error: null,
            createdAt: "2026-08-22T10:00:00.000Z", updatedAt: null,
          }],
        })));
      }
      if (String(input) === "/api/inbox/source-1") {
        return new Promise<Response>((resolve) => { resolveDetail = resolve; });
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    }));

    const user = userEvent.setup();
    render(<InboxView />);
    await user.click(await screen.findByRole("button", { name: /검수할 메모/ }));

    expect(screen.getByRole("status")).toHaveTextContent("자료를 여는 중입니다.");
    expect(screen.getByLabelText("자료 검수")).toHaveTextContent("자료를 여는 중입니다.");

    resolveDetail?.(new Response(JSON.stringify({
      item: {
        sourceId: "source-1", title: "검수할 메모", kind: "NOTE", reliability: "PRIVATE", origin: "manual",
        ingestChannel: "MANUAL_TEXT", inputFormat: "PLAIN_TEXT", qualityStatus: "READY", activeVersionId: "version-1",
        versionCount: 1, pendingVersionCount: 0, analysisFresh: false, charCount: 12, status: "stored", error: null,
        createdAt: "2026-08-22T10:00:00.000Z", updatedAt: null,
      },
      original: { available: true, r2Key: "source-1.txt", url: "/api/inbox/source-1/original" },
      activeVersion: {
        id: "version-1", version: 1, origin: "INITIAL_INGEST", reviewStatus: "ACTIVE", normalizationStatus: "READY",
        qualityStatus: "READY", charCount: 12, createdAt: "2026-08-22T10:00:00.000Z", reviewedAt: null, isActive: true,
        extractedText: "검수할 메모", normalizedText: "검수할 메모", report: null,
      },
      versions: [{
        id: "version-1", version: 1, origin: "INITIAL_INGEST", reviewStatus: "ACTIVE", normalizationStatus: "READY",
        qualityStatus: "READY", charCount: 12, createdAt: "2026-08-22T10:00:00.000Z", reviewedAt: null, isActive: true, parentVersionId: null,
      }],
    })));

    expect(await screen.findByRole("heading", { name: "검수할 메모" })).toBeInTheDocument();
  });

  it("keeps the newest selected item when detail responses arrive out of order", async () => {
    const makeItem = (sourceId: string, title: string) => ({
      sourceId, title, kind: "NOTE", reliability: "PRIVATE", origin: "manual", ingestChannel: "MANUAL_TEXT", inputFormat: "PLAIN_TEXT",
      qualityStatus: "READY", activeVersionId: `version-${sourceId}`, versionCount: 1, pendingVersionCount: 0, analysisFresh: false,
      charCount: 12, status: "stored", error: null, createdAt: "2026-08-22T10:00:00.000Z", updatedAt: null,
    });
    const makeDetail = (sourceId: string, title: string) => ({
      item: makeItem(sourceId, title), original: { available: true, r2Key: `${sourceId}.txt`, url: `/api/inbox/${sourceId}/original` },
      activeVersion: { id: `version-${sourceId}`, version: 1, origin: "INITIAL_INGEST", reviewStatus: "ACTIVE", normalizationStatus: "READY", qualityStatus: "READY", charCount: 12, createdAt: "2026-08-22T10:00:00.000Z", reviewedAt: null, isActive: true, extractedText: title, normalizedText: title, report: null },
      versions: [{ id: `version-${sourceId}`, version: 1, origin: "INITIAL_INGEST", reviewStatus: "ACTIVE", normalizationStatus: "READY", qualityStatus: "READY", charCount: 12, createdAt: "2026-08-22T10:00:00.000Z", reviewedAt: null, isActive: true, parentVersionId: null }],
    });
    let resolveFirst: ((response: Response) => void) | undefined;
    let resolveSecond: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/inbox") return Promise.resolve(new Response(JSON.stringify({ items: [makeItem("first", "첫 번째 자료"), makeItem("second", "두 번째 자료")] })));
      if (String(input) === "/api/inbox/first") return new Promise<Response>((resolve) => { resolveFirst = resolve; });
      if (String(input) === "/api/inbox/second") return new Promise<Response>((resolve) => { resolveSecond = resolve; });
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    }));

    const user = userEvent.setup();
    render(<InboxView />);
    await user.click(await screen.findByRole("button", { name: /첫 번째 자료/ }));
    await user.click(screen.getByRole("button", { name: /두 번째 자료/ }));
    resolveSecond?.(new Response(JSON.stringify(makeDetail("second", "두 번째 자료"))));
    expect(await screen.findByRole("heading", { name: "두 번째 자료" })).toBeInTheDocument();
    resolveFirst?.(new Response(JSON.stringify(makeDetail("first", "첫 번째 자료"))));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByRole("heading", { name: "두 번째 자료" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "첫 번째 자료" })).not.toBeInTheDocument();
  });
});
