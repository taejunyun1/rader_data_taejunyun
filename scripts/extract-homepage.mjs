#!/usr/bin/env node
/**
 * Extract PROJECT units from the taejunyun.com homepage source
 * (src/data/homeWorkspace.mjs + src/data/images.js) into
 * worker/src/data/homepage-projects.json for Research Radar ingestion.
 *
 * Usage: node scripts/extract-homepage.mjs <homepage-repo-root>
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = process.argv[2];
if (!repoRoot) {
  console.error("Usage: node scripts/extract-homepage.mjs <homepage-repo-root>");
  process.exit(1);
}

const homeSrc = readFileSync(resolve(repoRoot, "src/data/homeWorkspace.mjs"), "utf8");
const imagesSrc = readFileSync(resolve(repoRoot, "src/data/images.js"), "utf8");
const siteBase = "https://taejunyun.com";

const slugMap = new Map();
const yearMap = new Map();
const indexRe = /\{ id: 'work-[a-z]+', label: '([^']+)', year: '([^']+)',[^}]*to: '\/work\/([a-z]+)' \}/g;
let m;
while ((m = indexRe.exec(homeSrc))) {
  slugMap.set(m[3].toLowerCase(), m[1]);
  yearMap.set(m[3].toLowerCase(), m[2]);
}

function extractBlock(src, key) {
  const startRe = new RegExp(`^  ${key}: \\{`, "m");
  const sm = startRe.exec(src);
  if (!sm) return null;
  let depth = 1;
  let i = sm.index + sm[0].length;
  while (i < src.length && depth > 0) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  return src.slice(sm.index, i);
}

function extractTemplateLiteral(block, field) {
  const re = new RegExp(`${field}\\s*:\\s*\`([\\s\\S]*?)\``, "m");
  const mm = re.exec(block);
  return mm?.[1]?.trim() ?? null;
}

function extractQuoted(block, field) {
  const re = new RegExp(`${field}\\s*:\\s*\`(.*?)\`|${field}\\s*:\\s*'(.*?)'`, "m");
  const mm = re.exec(block);
  return mm?.[1] ?? mm?.[2] ?? null;
}

function extractImageCount(block) {
  const mm = /generateImages\(\s*'([A-Za-z]+)'\s*,\s*(\d+)/.exec(block);
  return mm ? { folder: mm[1], count: parseInt(mm[2], 10) } : null;
}

const keys = ["Trans", "Waterphoto", "Monument", "Network", "Ascent", "Firefly", "Middleturn", "Low", "Illusion", "Signal"];
const projects = [];

for (const key of keys) {
  const block = extractBlock(imagesSrc, key);
  if (!block) continue;
  const slug = key.toLowerCase();
  const title = extractQuoted(block, "title") ?? slugMap.get(slug) ?? key;
  const statement = extractTemplateLiteral(block, "statement");
  const imgs = extractImageCount(block);
  const videos = [...block.matchAll(/videoLink: '([^']+)'/g)].map((v) => v[1]);
  const yearRaw = yearMap.get(slug) ?? null;
  const yearMatch = yearRaw?.match(/(20\d{2})/);
  projects.push({
    slug,
    label: slugMap.get(slug) ?? title,
    title,
    year: yearMatch ? parseInt(yearMatch[1], 10) : null,
    yearRaw,
    projectUrl: `${siteBase}/work/${slug}`,
    statement,
    imageFolder: imgs?.folder ?? key,
    imageCount: imgs?.count ?? 0,
    videoUrls: videos,
  });
}

const outPath = resolve(dirname(fileURLToPath(import.meta.url)), "../worker/src/data/homepage-projects.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ siteBase, extractedAt: new Date().toISOString(), projects }, null, 2));
console.log(`Extracted ${projects.length} projects -> ${outPath}`);
for (const p of projects) {
  console.log(`  ${p.slug}: "${p.title}" year=${p.year} images=${p.imageCount} statement=${p.statement ? "yes" : "NO"} videos=${p.videoUrls.length}`);
}
