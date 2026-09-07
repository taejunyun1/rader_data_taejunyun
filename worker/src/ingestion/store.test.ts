import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createSource } from "./store";
import { sha256Hex } from "./ids";
import sync from "../routes/sync";

describe("origin-aware source storage", () => {
  it("appends changed Obsidian worktree bytes as version 2 of the original source", async () => {
    const first = await createSource(env as unknown as Env, {
      kind: "NOTE",
      title: "Obsidian path identity",
      origin: "obsidian:10_PROJECTS/task-2-origin-aware.md",
      original: "original note bytes",
      extractedText: "original note bytes",
      inputFormat: "OBSIDIAN_MARKDOWN",
      textScope: "FULLTEXT",
      extractionMethod: "MANUAL_TEXT",
    });
    const changed = await createSource(env as unknown as Env, {
      kind: "NOTE",
      title: "Obsidian path identity",
      origin: "obsidian:.worktrees/paper-faithful-deck/10_PROJECTS/task-2-origin-aware.md",
      original: "changed note bytes",
      extractedText: "changed note bytes",
      inputFormat: "OBSIDIAN_MARKDOWN",
      textScope: "FULLTEXT",
      extractionMethod: "MANUAL_TEXT",
    });

    expect(changed.sourceId).toBe(first.sourceId);
    expect(changed.duplicateOf).toBe(first.sourceId);

    const versions = await env.DB.prepare(
      "SELECT version, r2_key FROM source_versions WHERE source_id = ? ORDER BY version",
    ).bind(first.sourceId).all<{ version: number; r2_key: string | null }>();
    expect(versions.results.map((row) => row.version)).toEqual([1, 2]);
    expect(await (await env.ORIGINALS.get(versions.results[1]!.r2_key!))?.text()).toBe("changed note bytes");
  });
});

const upload = (name: string, original: string) => ({
  kind: "NOTE" as const, title: name, canonicalUrl: `https://example.com/integrity/${name}`,
  origin: `manual:${name}`, original, extractedText: original, filename: "original.md",
});

async function expectPreservedVersions(sourceId: string, expected: string[]) {
  const rows = await env.DB.prepare("SELECT version, r2_key, raw_content_hash FROM source_versions WHERE source_id = ? ORDER BY version")
    .bind(sourceId).all<{ version: number; r2_key: string; raw_content_hash: string }>();
  expect(rows.results.map(row => row.version)).toEqual(expected.map((_, i) => i + 1));
  expect(new Set(rows.results.map(row => row.r2_key)).size).toBe(expected.length);
  const contents: string[] = [];
  for (const row of rows.results) {
    const body = await (await env.ORIGINALS.get(row.r2_key))!.text();
    expect(await sha256Hex(body)).toBe(row.raw_content_hash);
    contents.push(body);
  }
  expect(contents.sort()).toEqual([...expected].sort());
}

describe("immutable incoming source versions", () => {
  it("preserves every original and reserves distinct versions during concurrent reuploads", async () => {
    const first = await createSource(env as unknown as Env, upload("parallel", "initial"));
    await Promise.all(["incoming A", "incoming B", "incoming C"].map(text => createSource(env as unknown as Env, upload("parallel", text))));
    await expectPreservedVersions(first.sourceId, ["initial", "incoming A", "incoming B", "incoming C"]);
  });

  it("keeps manual edits active and incoming reuploads pending with the correct result identity", async () => {
    const first = await createSource(env as unknown as Env, { ...upload("manual", "human correction"), versionOrigin: "MANUAL_EDIT" });
    const incoming = await createSource(env as unknown as Env, upload("manual", "new original"));
    expect(incoming.activeVersionId).toBe(first.activeVersionId);
    const rows = await env.DB.prepare("SELECT review_status FROM source_versions WHERE source_id = ? ORDER BY version")
      .bind(first.sourceId).all<{ review_status: string }>();
    expect(rows.results.map(row => row.review_status)).toEqual(["ACTIVE", "PENDING_REVIEW"]);
    await expectPreservedVersions(first.sourceId, ["human correction", "new original"]);
  });

  it("rechecks manual-edit protection when a correction arrives during the original write", async () => {
    const first = await createSource(env as unknown as Env, upload("manual-race", "initial race bytes"));
    let manualId: string | undefined;
    const originals = new Proxy(env.ORIGINALS, { get(target, prop) {
      if (prop !== "put") {
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (key: string, value: string, options: R2PutOptions) => {
        if (key.startsWith(`originals/${first.sourceId}/`)) {
          const manual = await createSource(env as unknown as Env, {
            ...upload("manual-race", "concurrent human correction"), versionOrigin: "MANUAL_EDIT",
          });
          manualId = manual.activeVersionId;
        }
        return target.put(key, value, options);
      };
    } });
    const incoming = await createSource({ ...env, ORIGINALS: originals } as unknown as Env, upload("manual-race", "late incoming bytes"));
    expect(incoming.activeVersionId).toBe(manualId);
    const pending = await env.DB.prepare("SELECT review_status FROM source_versions WHERE source_id = ? AND extracted_text = ?")
      .bind(first.sourceId, "late incoming bytes").first<{ review_status: string }>();
    expect(pending?.review_status).toBe("PENDING_REVIEW");
    await expectPreservedVersions(first.sourceId, ["initial race bytes", "concurrent human correction", "late incoming bytes"]);
  });

  it("activates a normal Obsidian sync and recognizes its next unchanged upload", async () => {
    const first = await createSource(env as unknown as Env, {
      ...upload("sync-normal", "old sync bytes"), origin: "obsidian:notes/normal.md",
    });
    const request = () => sync.request("http://local/obsidian", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "notes/normal.md", filename: "normal.md", text: "new sync bytes" }),
    }, env, { waitUntil() {}, passThroughOnException() {}, props: {} });
    expect(await (await request()).json()).toMatchObject({ status: "updated", version: 2 });
    expect(await (await request()).json()).toMatchObject({ status: "unchanged" });
    await expectPreservedVersions(first.sourceId, ["old sync bytes", "new sync bytes"]);
  });

  it("preserves concurrent Obsidian originals and keeps manual edits pending review", async () => {
    const first = await createSource(env as unknown as Env, {
      ...upload("sync-manual", "manual sync correction"), origin: "obsidian:notes/integrity.md", versionOrigin: "MANUAL_EDIT",
    });
    const deferred: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => { deferred.push(promise); }, passThroughOnException() {}, props: {} };
    const responses = await Promise.all(["sync A", "sync B"].map(text => sync.request("http://local/obsidian", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "notes/integrity.md", filename: "integrity.md", text }),
    }, env, ctx)));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "review_required" });
    }
    await Promise.all(deferred);
    const repeated = await sync.request("http://local/obsidian", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "notes/integrity.md", filename: "integrity.md", text: "sync A" }),
    }, env, ctx);
    expect(await repeated.json()).toMatchObject({ status: "unchanged" });
    const source = await env.DB.prepare("SELECT active_version_id, file_hash FROM sources WHERE id = ?")
      .bind(first.sourceId).first<{ active_version_id: string; file_hash: string }>();
    expect(source?.active_version_id).toBe(first.activeVersionId);
    expect(source?.file_hash).toBe(await sha256Hex("manual sync correction"));
    await expectPreservedVersions(first.sourceId, ["manual sync correction", "sync A", "sync B"]);
  });
});
