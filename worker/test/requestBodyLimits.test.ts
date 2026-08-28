import { describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/httpErrors";
import { readJson } from "../src/lib/requestBody";

function context(body: string, headers: Record<string, string> = {}) {
  const request = new Request("https://radar.example/api/test", { method: "POST", body, headers });
  return { req: { raw: request, header: (name: string) => request.headers.get(name) ?? undefined } };
}

describe("bounded JSON request reader", () => {
  it("rejects an oversized declared body before parsing", async () => {
    await expect(readJson(context("{}", { "content-length": "100" }), 10)).rejects.toMatchObject<HttpError>({ status: 413, code: "request_body_too_large" });
  });

  it("rejects an oversized chunked body while reading", async () => {
    await expect(readJson(context("{" + "x".repeat(20) + "}"), 10)).rejects.toMatchObject<HttpError>({ status: 413, code: "request_body_too_large" });
  });

  it("parses bounded JSON without exposing the raw request body", async () => {
    await expect(readJson<{ ok: boolean }>(context('{"ok":true}'))).resolves.toEqual({ ok: true });
  });
});
