#!/usr/bin/env node
/**
 * Obsidian → Research Radar sync CLI (zero dependencies, Node 18+)
 *
 * Usage:
 *   RADAR_CLI_TOKEN=xxx node cli/obsidian-sync.mjs --vault /path/to/vault
 *   node cli/obsidian-sync.mjs --vault ~/Documents/Obsidian/MyVault --api https://radar.taejunyun.com --watch
 *
 * Options:
 *   --vault <path>     Obsidian vault folder (required)
 *   --api <url>        Radar URL (default https://radar.taejunyun.com)
 *   --token <tok>      CLI token (or env RADAR_CLI_TOKEN)
 *   --watch            Keep running, re-scan every 30s
 *   --force            Re-upload even unchanged files
 *
 * State: <vault>/.radar-sync.json  (add to .obsidian ignore; safe to delete — full re-sync)
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { homedir } from "node:os";
import process from "node:process";

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const VAULT = arg("vault") ? String(arg("vault")).replace(/^~/, homedir()) : null;
const API = String(arg("api", "https://radar.taejunyun.com")).replace(/\/$/, "");
const TOKEN = String(arg("token", process.env.RADAR_CLI_TOKEN ?? ""));
const WATCH = Boolean(arg("watch", false));
const FORCE = Boolean(arg("force", false));
const STATE_FILE = ".radar-sync.json";
const SKIP_DIRS = new Set([".obsidian", ".trash", ".radar", "node_modules", ".git"]);

if (!VAULT) {
  console.error("Usage: node cli/obsidian-sync.mjs --vault /path/to/vault [--api URL] [--token TOK] [--watch] [--force]");
  process.exit(1);
}
if (!TOKEN) {
  console.error("Missing token: pass --token or set RADAR_CLI_TOKEN");
  process.exit(1);
}

async function loadState() {
  try {
    return JSON.parse(await readFile(join(VAULT, STATE_FILE), "utf8"));
  } catch {
    return {};
  }
}

async function saveState(state) {
  await writeFile(join(VAULT, STATE_FILE), JSON.stringify(state, null, 2));
}

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== STATE_FILE) {
      if (SKIP_DIRS.has(e.name)) continue;
    }
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(full);
    } else if (e.isFile() && /\.md$/i.test(e.name)) {
      yield full;
    }
  }
}

async function uploadOne(absPath, state) {
  const relPath = relative(VAULT, absPath);
  const content = await readFile(absPath, "utf8");
  const hash = createHash("sha256").update(content).digest("hex");
  const prev = state[relPath];

  if (!FORCE && prev === hash) return { relPath, status: "unchanged" };

  let mtime;
  try {
    mtime = (await stat(absPath)).mtimeMs;
  } catch {
    mtime = undefined;
  }

  const res = await fetch(`${API}/api/sync/obsidian`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path: relPath, filename: relPath.split("/").pop(), text: content, mtime }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { relPath, status: `error_${res.status}`, detail: body.slice(0, 200) };
  }
  const d = await res.json();
  state[relPath] = hash;
  return { relPath, status: d.status };
}

async function runOnce(label) {
  const state = await loadState();
  const results = [];
  for await (const f of walk(VAULT)) {
    results.push(await uploadOne(f, state));
  }
  await saveState(state);

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const summary = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ");
  console.log(`[${label}] ${results.length} files — ${summary}`);
  for (const r of results) {
    if (r.status.startsWith("error")) console.error(`  ✗ ${r.relPath}: ${r.status} ${r.detail ?? ""}`);
    else if (r.status === "created" || r.status === "updated") console.log(`  ${r.status === "created" ? "+" : "~"} ${r.relPath}`);
  }
}

if (WATCH) {
  console.log(`Watching ${VAULT} (rescan every 30s). Ctrl+C to stop.`);
  await runOnce(new Date().toLocaleTimeString());
  setInterval(() => {
    runOnce(new Date().toLocaleTimeString()).catch((e) => console.error(e.message));
  }, 30_000);
} else {
  await runOnce("sync");
}
