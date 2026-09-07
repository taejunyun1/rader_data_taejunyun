import { describe, expect, it } from "vitest";
import exportRoute from "../src/routes/export";

async function csvFor(values: Record<string, unknown> = {}) {
  const row = {
    id: "source-1", kind: "NOTE", title: "사진 연구", authors: null, year: 2026,
    reliability: "PRIMARY", status: "indexed", origin: "manual",
    canonical_url: null, doi: null, created_at: "2026-09-07T00:00:00.000Z", ...values,
  };
  const env = { DB: { batch: async (statements: unknown[]) => statements.map(() => ({ success: true, results: [row] })), prepare: () => ({ all: async () => ({ results: [row] }) }) } } as unknown as Env;
  const response = await exportRoute.request("https://radar.example/csv", {}, env);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
  expect(response.headers.get("Content-Disposition")).toMatch(/^attachment; filename="radar-sources-/);
  return { csv: await response.text(), row, env };
}

describe("CSV spreadsheet-safe export", () => {
  it.each([
    "=1+1", "+1+1", "-1+1", "@SUM(1)",
    " =1+1", "\t=1+1", "\r=1+1", "\n=1+1", "\r\n=1+1",
    "\u0000=1+1", "\u001f+1", "\u0085=1", "\u00a0=1", "\uFEFF=1", "\u200b=1",
    "＝1+1", "＋1", "－1", "＠SUM(1)", "\ttext", "\rtext", "\ntext",
  ])("exports formula-leading title %j as literal text", async (title) => {
    const { csv, row } = await csvFor({ title });
    expect(csv).toContain(`"source-1","NOTE","'${title}",`);
    expect(row.title).toBe(title);
  });

  it("protects every textual column and keeps quoted numeric years unchanged", async () => {
    const { csv } = await csvFor({
      id: "=1", kind: "+1", title: "-1", authors: "@name", reliability: "=2",
      status: "+2", origin: "-2", canonical_url: "@url", doi: "=3", created_at: "+3",
    });
    expect(csv.split("\n")[1]).toBe('"\'=1","\'+1","\'-1","\'@name","2026","\'=2","\'+2","\'-2","\'@url","\'=3","\'+3"');
  });

  it("keeps commas, quotes and line breaks inside the original cell", async () => {
    const { csv } = await csvFor({title: '=1,"quoted"\n@next'});
    expect(csv).toContain('"NOTE","\'=1,""quoted""\n@next","",');
  });

  it("preserves ordinary Korean text, URLs, empty fields and CSV escaping", async () => {
    const { csv } = await csvFor({title: '빛, "그림자"\n두 번째 줄', authors: "윤태준", canonical_url: "https://example.com/?q=a=b"});
    expect(csv).toBe('id,kind,title,authors,year,reliability,status,origin,canonical_url,doi,created_at\n"source-1","NOTE","빛, ""그림자""\n두 번째 줄","윤태준","2026","PRIMARY","indexed","manual","https://example.com/?q=a=b","","2026-09-07T00:00:00.000Z"');
  });

  it("does not add a second prefix to an already literal title", async () => {
    const { csv } = await csvFor({title: "'=1+1"});
    expect(csv).toContain('"NOTE","\'=1+1","",');
    expect(csv).not.toContain("''=1+1");
  });

  it("preserves the original metadata in JSON after CSV export", async () => {
    const title = '=1,"quoted"\n@next';
    const { env, row } = await csvFor({ title, authors: "@author" });
    const response = await exportRoute.request("https://radar.example/json", {}, env);
    expect(response.status).toBe(200);
    const payload = await response.json() as { sources: unknown[] };
    expect(payload.sources).toEqual([row]);
    expect(row.title).toBe(title);
    expect(row.authors).toBe("@author");
  });
});
