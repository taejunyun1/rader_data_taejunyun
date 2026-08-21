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
});
