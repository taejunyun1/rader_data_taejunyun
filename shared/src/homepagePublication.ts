export interface CurrentResearchMaterial { title: string; author: string | null; year: number | null; url: string; }
export interface CurrentResearchContent { displayTitle: string; keywords: string[]; thoughts: string[]; questions: string[]; researchDirections: string[]; artworkDirections: string[]; researchMaterials: CurrentResearchMaterial[]; }
export type ExploringCurrentResearchPayload = { schemaVersion: 1; kind: "CURRENT_RESEARCH"; source: "research-radar"; state: "EXPLORING"; publicationId: string; distilledAt: string; publishedAt: string; updatedAt: string; contentHash: string; content: CurrentResearchContent; };
export type WithdrawnCurrentResearchPayload = { schemaVersion: 1; kind: "CURRENT_RESEARCH"; source: "research-radar"; state: "WITHDRAWN"; withdrawnPublicationId: string | null; withdrawnContentHash: string | null; withdrawnAt: string; };
export type CurrentResearchPayload = ExploringCurrentResearchPayload | WithdrawnCurrentResearchPayload;
export interface CurrentResearchStorageWrapper { storageRevision: string; payload: CurrentResearchPayload; }
export type DistillHomepagePublicationState = "NONE" | "CURRENT" | "SUPERSEDED" | "WITHDRAWN" | "FAILED" | "PURGING" | "PURGED";
export interface HomepagePreviewResponse { sessionId: string; distilledAt: string; contentHash: string; content: CurrentResearchContent; currentRevision: string; changed: boolean; excludedResearchMaterialCount: number; privateReview: { warnings: Array<{ category: string; note: string }>; overall: string | null; }; }
export type HomepageCurrentStatus = { state: "NONE" } | { state: "PUBLISHED"; publicationId: string; distillSessionId: string; contentHash: string; publishedAt: string; updatedAt: string; } | { state: "WITHDRAWN"; publicationId: string | null; distillSessionId: string | null; contentHash: string | null; withdrawnAt: string; };
export interface HomepagePublicationStatusResponse { currentRevision: string; current: HomepageCurrentStatus; latestPublishable: null | { sessionId: string; distilledAt: string; contentHash: string }; ledgerReconcilePending: boolean; }
export interface HomepageCsrfResponse { token: string; expiresAt: string; }
export interface ApiErrorResponse { error: string; requestId: string; details?: unknown; }
export type HomepagePublishRequest = { expectedContentHash: string; expectedCurrentRevision: string; };
export type HomepagePublishResponse = { ok: true; publication: ExploringCurrentResearchPayload; currentRevision: string; idempotent: boolean; ledgerReconcilePending: boolean; };
export type HomepageWithdrawRequest = { expectedPublicationId: string; expectedContentHash: string; expectedCurrentRevision: string; };
export type HomepageWithdrawResponse = { ok: true; state: "WITHDRAWN"; withdrawnPublicationId: string; withdrawnAt: string; currentRevision: string; idempotent: boolean; ledgerReconcilePending: boolean; };

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const HASH = /^[0-9a-f]{64}$/;
const clean = (s: string) => !/[\u0000-\u001f\u007f]/.test(s) && !/<!--[\s\S]*-->|<!doctype\b|<\/?[a-z][^>]*>/i.test(s);
const validDate = (s: unknown) => { if (typeof s !== "string" || !ISO.test(s) || Number.isNaN(Date.parse(s))) return false; const d = new Date(s); const m = s.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)\.(\d{3})Z$/)!; return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3]) && d.getUTCHours() === Number(m[4]) && d.getUTCMinutes() === Number(m[5]) && d.getUTCSeconds() === Number(m[6]) && d.getUTCMilliseconds() === Number(m[7]); };
const keys = (v: Record<string, unknown>, expected: string[]) => JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...expected].sort());
const textArray = (v: unknown, max: number, itemMax: number) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.length <= itemMax && clean(x));

export function validateCurrentResearchPayload(value: unknown): CurrentResearchPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.state === "WITHDRAWN") {
    if (!keys(v, ["kind", "schemaVersion", "source", "state", "withdrawnAt", "withdrawnContentHash", "withdrawnPublicationId"]) || v.schemaVersion !== 1 || v.kind !== "CURRENT_RESEARCH" || v.source !== "research-radar" || !validDate(v.withdrawnAt)) return null;
    if (v.withdrawnPublicationId !== null && (typeof v.withdrawnPublicationId !== "string" || !v.withdrawnPublicationId || !clean(v.withdrawnPublicationId))) return null;
    if (v.withdrawnContentHash !== null && (typeof v.withdrawnContentHash !== "string" || !HASH.test(v.withdrawnContentHash))) return null;
    if ((v.withdrawnPublicationId === null) !== (v.withdrawnContentHash === null)) return null;
    return v as unknown as WithdrawnCurrentResearchPayload;
  }
  if (v.state !== "EXPLORING" || !keys(v, ["content", "contentHash", "distilledAt", "kind", "publicationId", "publishedAt", "schemaVersion", "source", "state", "updatedAt"]) || v.schemaVersion !== 1 || v.kind !== "CURRENT_RESEARCH" || v.source !== "research-radar" || typeof v.publicationId !== "string" || !v.publicationId || !clean(v.publicationId) || !validDate(v.distilledAt) || !validDate(v.publishedAt) || !validDate(v.updatedAt) || typeof v.contentHash !== "string" || !HASH.test(v.contentHash)) return null;
  const c = v.content as Record<string, unknown>;
  if (!c || typeof c !== "object" || Array.isArray(c) || !keys(c, ["artworkDirections", "displayTitle", "keywords", "questions", "researchDirections", "researchMaterials", "thoughts"]) || typeof c.displayTitle !== "string" || c.displayTitle.length > 200 || !clean(c.displayTitle) || !textArray(c.keywords, 7, 80) || !textArray(c.thoughts, 5, 600) || !textArray(c.questions, 3, 400) || !textArray(c.researchDirections, 2, 600) || !textArray(c.artworkDirections, 2, 600) || !Array.isArray(c.researchMaterials) || c.researchMaterials.length > 5) return null;
  if (![c.keywords, c.thoughts, c.questions, c.researchDirections, c.artworkDirections].some((a) => (a as unknown[]).length > 0)) return null;
  if (!c.researchMaterials.every((m) => { if (!m || typeof m !== "object" || Array.isArray(m)) return false; const x = m as Record<string, unknown>; if (!keys(x, ["author", "title", "url", "year"]) || typeof x.title !== "string" || x.title.length > 300 || !clean(x.title) || (x.author !== null && (typeof x.author !== "string" || x.author.length > 200 || !clean(x.author))) || (x.year !== null && (!Number.isInteger(x.year) || (x.year as number) < 0)) || typeof x.url !== "string" || x.url.length > 2048 || !clean(x.url)) return false; try { const u = new URL(x.url); return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && !privateHost(u.hostname); } catch { return false; } })) return null;
  if (utf8Bytes(v) > 64 * 1024) return null;
  return v as unknown as ExploringCurrentResearchPayload;
}
export function validateCurrentResearchStorageWrapper(value: unknown): CurrentResearchStorageWrapper | null { if (!value || typeof value !== "object" || Array.isArray(value)) return null; const v = value as Record<string, unknown>; if (!keys(v, ["payload", "storageRevision"]) || typeof v.storageRevision !== "string" || !/^\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b$/i.test(v.storageRevision) || !validateCurrentResearchPayload(v.payload)) return null; return v as unknown as CurrentResearchStorageWrapper; }

function utf8Bytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function privateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local") || h === "::" || h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true;
  const octets = h.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return h.includes(":");
  return true;
}
