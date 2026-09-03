import { describe, expect, it } from "vitest";
import { issueCsrfToken, verifyCsrfToken } from "./csrf";

describe("homepage publication CSRF", () => {
  it("verifies a newly issued HMAC token with a binary signature", async () => {
    const now = Date.parse("2026-09-03T12:00:00.000Z");
    const env = { CSRF_SECRET: "csrf-test-secret-at-least-sixteen-bytes" };
    const { token } = await issueCsrfToken(env, "access-subject-1", now);

    await expect(verifyCsrfToken(env, "access-subject-1", token, now + 1)).resolves.toBe(true);
  });
});
