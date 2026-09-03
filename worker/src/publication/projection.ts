import type { CurrentResearchContent, CurrentResearchMaterial } from "@radar/shared";
import { SourceDeletionClaimError } from "../reservoir/deletionClaim";
import { parseCriticOutput, parseDistillOutput, type CriticOutput, type DistillOutput } from "../distill/outputSchema";

const MAX_PAYLOAD_BYTES = 64 * 1024;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const HTML_LIKE = /<!--[\s\S]*?-->|<!doctype\b|<\/?[a-z][^>]*>/i;

export interface PublishableDistillSession {
  id: string;
  createdAt: string;
  sourcesUsed: Array<{ id: string; title: string }>;
  output: DistillOutput;
  critic: CriticOutput | null;
}

export interface HomepageProjectionDraft {
  sessionId: string;
  sourceIds: string[];
  distilledAt: string;
  content: CurrentResearchContent;
  contentHash: string;
  excludedResearchMaterialCount: number;
  privateReview: { warnings: Array<{ category: string; note: string }>; overall: string | null };
}

type SessionRow = {
  id: string;
  createdAt: string;
  sourcesUsedJson: string | null;
  outputJson: string | null;
  criticJson: string | null;
};

type SourceRow = {
  ordinal: number;
  title: string;
  authors: string | null;
  year: number | null;
  canonicalUrl: string | null;
  doi: string | null;
};

export class PublicProjectionError extends Error {
  readonly code: "public_projection_invalid" | "public_projection_empty" | "source_delete_in_progress";

  constructor(code: PublicProjectionError["code"], message: string = code) {
    super(message);
    this.name = "PublicProjectionError";
    this.code = code;
  }
}

function parseJson(value: string | null): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function cleanText(value: string): string {
  return value.replace(CONTROL_CHARS, "").trim();
}

function safeText(value: string, field: string, maxLength: number): string {
  const cleaned = cleanText(value);
  if (HTML_LIKE.test(cleaned)) throw new PublicProjectionError("public_projection_invalid", `${field}_html_like`);
  if (cleaned.length > maxLength) throw new PublicProjectionError("public_projection_invalid", `${field}_too_long`);
  return cleaned;
}

function boundedTextArray(values: string[], field: string, count: number, maxLength: number): string[] {
  if (values.length > count) throw new PublicProjectionError("public_projection_invalid", `${field}_count_too_large`);
  return values.map((value) => safeText(value, field, maxLength));
}

function nonEmptyFirst(values: unknown): string | null {
  if (!Array.isArray(values)) return null;
  for (const value of values) {
    if (typeof value !== "string") continue;
    const cleaned = cleanText(value);
    if (cleaned) return cleaned;
  }
  return null;
}

export function deriveDisplayTitle(input: Pick<DistillOutput, "questions" | "research_directions"> | { questions: string[]; researchDirections?: string[] }): string {
  const question = nonEmptyFirst(input.questions);
  const directions = "research_directions" in input ? input.research_directions : input.researchDirections ?? [];
  const direction = nonEmptyFirst(directions);
  const selected = question ?? direction ?? "현재 연구";
  const cleaned = cleanText(selected);
  return Array.from(cleaned).length > 200 ? `${Array.from(cleaned).slice(0, 199).join("")}…` : cleaned;
}

function parseSourcesUsed(value: unknown): Array<{ id: string; title: string }> | null {
  if (value === null) return [];
  if (!Array.isArray(value)) return null;
  const result: Array<{ id: string; title: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id.trim() || typeof row.title !== "string") return null;
    result.push({ id: row.id, title: row.title });
  }
  return result;
}

function parseSession(row: SessionRow): PublishableDistillSession | null {
  const output = parseDistillOutput(parseJson(row.outputJson));
  const sourcesUsed = parseSourcesUsed(parseJson(row.sourcesUsedJson));
  // A Distill without provenance cannot be published as a current research
  // edition, even when the stored output itself is schema-valid.
  if (!output || !sourcesUsed || sourcesUsed.length === 0) return null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    sourcesUsed,
    output,
    critic: parseCriticOutput(parseJson(row.criticJson)),
  };
}

async function sourcesAreLive(db: D1Database, sourcesUsed: Array<{ id: string; title: string }>): Promise<boolean> {
  const ids = [...new Set(sourcesUsed.map((source) => source.id))];
  if (ids.length === 0) return false;
  const placeholders = ids.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT id FROM sources WHERE id IN (${placeholders})`).bind(...ids).all<{ id: string }>();
  return new Set((rows.results ?? []).map((row) => row.id)).size === ids.length;
}

async function assertNoSourceDeletionClaim(db: D1Database, sourcesUsed: Array<{ id: string; title: string }>): Promise<void> {
  const ids = [...new Set(sourcesUsed.map((source) => source.id))];
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  const row = await db.prepare(`SELECT source_id FROM source_deletion_claims WHERE source_id IN (${placeholders}) LIMIT 1`).bind(...ids).first<{ source_id: string }>();
  if (row) {
    const error = new SourceDeletionClaimError("source_delete_in_progress");
    throw new PublicProjectionError("source_delete_in_progress", error.message);
  }
}

const SESSION_SELECT = `SELECT id, created_at AS createdAt, sources_used_json AS sourcesUsedJson,
                              output_json AS outputJson, critic_output_json AS criticJson
                       FROM distill_sessions`;

export async function loadLatestPublishableDistill(db: D1Database): Promise<PublishableDistillSession | null> {
  const rows = await db.prepare(`${SESSION_SELECT}
    WHERE output_json IS NOT NULL AND json_valid(output_json)
    ORDER BY created_at DESC, id DESC`).all<SessionRow>();
  for (const row of rows.results ?? []) {
    const session = parseSession(row);
    if (!session || !(await sourcesAreLive(db, session.sourcesUsed))) continue;
    await assertNoSourceDeletionClaim(db, session.sourcesUsed);
    return session;
  }
  return null;
}

export async function loadPublishableDistill(db: D1Database, sessionId: string): Promise<PublishableDistillSession | null> {
  const row = await db.prepare(`${SESSION_SELECT} WHERE id = ?`).bind(sessionId).first<SessionRow>();
  if (!row) return null;
  const session = parseSession(row);
  if (!session || !(await sourcesAreLive(db, session.sourcesUsed))) return null;
  await assertNoSourceDeletionClaim(db, session.sourcesUsed);
  return session;
}

function ipv4Parts(hostname: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return null;
  const parts = hostname.split(".").map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

function isIpLiteral(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4 = ipv4Parts(host);
  if (ipv4) return true;
  return host.includes(":");
}

function publicUrl(raw: string): string | null {
  const value = cleanText(raw);
  if (!value || HTML_LIKE.test(value)) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname) return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (hostname === "localhost" || hostname.endsWith(".local") || isIpLiteral(hostname)) return null;
    url.hash = "";
    const normalized = url.toString().replace(/\?$/, "");
    return normalized.length <= 2048 ? normalized : null;
  } catch {
    return null;
  }
}

function materialUrl(canonicalUrl: string | null, doi: string | null): string | null {
  if (canonicalUrl) {
    const canonical = publicUrl(canonicalUrl);
    if (canonical) return canonical;
  }
  if (!doi) return null;
  const normalized = cleanText(doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase();
  return normalized ? publicUrl(`https://doi.org/${normalized}`) : null;
}

function toContent(output: DistillOutput, materials: CurrentResearchMaterial[]): CurrentResearchContent {
  const content: CurrentResearchContent = {
    displayTitle: safeText(deriveDisplayTitle(output), "displayTitle", 200),
    keywords: boundedTextArray(output.keywords, "keyword", 7, 80),
    thoughts: boundedTextArray(output.thoughts_fragments, "thought", 5, 600),
    questions: boundedTextArray(output.questions, "question", 3, 400),
    researchDirections: boundedTextArray(output.research_directions, "researchDirection", 2, 600),
    artworkDirections: boundedTextArray(output.artwork_directions, "artworkDirection", 2, 600),
    researchMaterials: materials,
  };
  const hasContent = [content.keywords, content.thoughts, content.questions, content.researchDirections, content.artworkDirections].some((items) => items.length > 0);
  if (!hasContent) throw new PublicProjectionError("public_projection_empty");
  return content;
}

function assertPayloadSize(distilledAt: string, content: CurrentResearchContent): void {
  const worstCase = {
    schemaVersion: 1,
    kind: "CURRENT_RESEARCH",
    source: "research-radar",
    publicationId: "p".repeat(64),
    state: "EXPLORING",
    distilledAt,
    publishedAt: "9".repeat(24),
    updatedAt: "9".repeat(24),
    contentHash: "a".repeat(64),
    content,
  };
  if (new TextEncoder().encode(canonicalJson(worstCase)).byteLength > MAX_PAYLOAD_BYTES) {
    throw new PublicProjectionError("public_projection_invalid", "public_projection_too_large");
  }
}

export async function buildHomepageProjection(db: D1Database, session: PublishableDistillSession): Promise<HomepageProjectionDraft> {
  await assertNoSourceDeletionClaim(db, session.sourcesUsed);
  const usedJson = JSON.stringify(session.sourcesUsed);
  const rows = await db.prepare(`
    SELECT CAST(used.key AS INTEGER) AS ordinal,
           source.title, source.authors, source.year,
           source.canonical_url AS canonicalUrl, source.doi
    FROM json_each(?) AS used
    JOIN sources AS source ON source.id = json_extract(used.value, '$.id')
    ORDER BY ordinal`).bind(usedJson).all<SourceRow>();
  const byOrdinal = new Map((rows.results ?? []).map((row) => [row.ordinal, row]));
  const materials: CurrentResearchMaterial[] = [];
  let excluded = 0;
  for (let ordinal = 0; ordinal < session.sourcesUsed.length; ordinal += 1) {
    const source = byOrdinal.get(ordinal);
    if (!source) {
      excluded += 1;
      continue;
    }
    const title = safeText(source.title, "researchMaterialTitle", 300);
    const author = source.authors === null ? null : safeText(source.authors, "researchMaterialAuthor", 200);
    if (source.year !== null && (!Number.isInteger(source.year) || source.year < 0)) {
      throw new PublicProjectionError("public_projection_invalid", "researchMaterialYear_invalid");
    }
    const url = materialUrl(source.canonicalUrl, source.doi);
    if (!url) {
      excluded += 1;
      continue;
    }
    if (materials.length >= 5) {
      excluded += 1;
      continue;
    }
    materials.push({ title, author: author || null, year: source.year === null ? null : source.year, url });
  }
  const content = toContent(session.output, materials);
  assertPayloadSize(session.createdAt, content);
  const contentHash = await hashHomepageProjection(session.createdAt, content);
  return {
    sessionId: session.id,
    sourceIds: session.sourcesUsed.map((source) => source.id),
    distilledAt: session.createdAt,
    content,
    contentHash,
    excludedResearchMaterialCount: excluded,
    privateReview: session.critic ? { warnings: session.critic.warnings, overall: session.critic.overall } : { warnings: [], overall: null },
  };
}

export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  const encode = (current: unknown): string => {
    if (current === null) return "null";
    if (typeof current === "string") return JSON.stringify(current);
    if (typeof current === "boolean") return current ? "true" : "false";
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new PublicProjectionError("public_projection_invalid", "non_finite_number");
      return JSON.stringify(current);
    }
    if (typeof current !== "object") throw new PublicProjectionError("public_projection_invalid", "non_json_value");
    if (active.has(current)) throw new PublicProjectionError("public_projection_invalid", "cyclic_value");
    active.add(current);
    try {
      if (Array.isArray(current)) {
        const values: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(current, index)) throw new PublicProjectionError("public_projection_invalid", "sparse_array");
          values.push(encode(current[index]));
        }
        return `[${values.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new PublicProjectionError("public_projection_invalid", "non_plain_record");
      const entries = Object.entries(current as Record<string, unknown>).sort((left, right) => {
        const a = left[0]!;
        const b = right[0]!;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`).join(",")}}`;
    } finally {
      active.delete(current);
    }
  };
  return encode(value);
}

export async function hashHomepageProjection(distilledAt: string, content: CurrentResearchContent): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ distilledAt, content }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
