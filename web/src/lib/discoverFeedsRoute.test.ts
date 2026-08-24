import { describe, expect, it } from "vitest";
import discover from "../../../worker/src/routes/discover";

describe("discover feeds route", () => {
  it("filters malformed non-string feed entries instead of throwing an internal error", async () => {
    const response = await discover.request(
      "http://localhost/feeds",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          feeds: [
            42,
            "https://custom.example/feed.xml",
            "https://unthinking.photography/feed",
          ],
        }),
      },
      { DB: createKvDb() } as { DB: D1Database } as Env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      feeds: ["https://custom.example/feed.xml"],
    });
  });
});

function createKvDb(): D1Database {
  const store = new Map<string, string>();

  return {
    prepare(query: string): D1PreparedStatement {
      let bindings: unknown[] = [];

      return {
        bind(...values: unknown[]): D1PreparedStatement {
          bindings = values;
          return this;
        },
        async first<T = Record<string, unknown>>() {
          if (!query.startsWith("SELECT value FROM kv WHERE key = ?")) return null;
          const value = store.get(String(bindings[0]));
          return value === undefined ? null : ({ value } as T);
        },
        async run() {
          if (query.startsWith("INSERT INTO kv")) {
            store.set(String(bindings[0]), String(bindings[1]));
          }
          return { meta: { changes: 1 } };
        },
      } as D1PreparedStatement;
    },
  } as D1Database;
}
