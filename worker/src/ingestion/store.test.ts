import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createSource } from "./store";

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
