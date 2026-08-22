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
  });

  it("separates capture formats so the file guidance is visible before upload", async () => {
    render(<InboxView />);
    await userEvent.click(screen.getByRole("tab", { name: "파일" }));
    expect(screen.getByText("텍스트 PDF·스캔 PDF")).toBeInTheDocument();
    expect(screen.getByText(/PDF 원본은 R2에 보존합니다/)).toBeInTheDocument();
  });
});
