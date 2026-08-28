import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { findDuplicate } from "./dedup";
import { normalizeOriginIdentity } from "./normalize";

describe("origin-aware deduplication", () => {
  it("normalizes an Obsidian worktree origin and finds its logical source", async () => {
    expect(normalizeOriginIdentity("obsidian:.worktrees/paper-faithful-deck/10_PROJECTS/a.md"))
      .toBe("obsidian:10_PROJECTS/a.md");

    const timestamp = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO sources (id, kind, title, reliability, status, origin, created_at, updated_at)
       VALUES (?, 'NOTE', 'Existing Obsidian note', 'PRIMARY', 'stored', ?, ?, ?)`,
    ).bind("source-1", "obsidian:10_PROJECTS/a.md", timestamp, timestamp).run();

    expect(await findDuplicate(env.DB, { origin: "obsidian:.worktrees/branch/10_PROJECTS/a.md" }))
      .toEqual({ sourceId: "source-1", field: "origin" });
  });
});
