import {
  validateCurrentResearchPayload,
  validateCurrentResearchStorageWrapper,
  type CurrentResearchPayload,
  type CurrentResearchStorageWrapper,
  type ExploringCurrentResearchPayload,
} from "@radar/shared";
import { canonicalJson } from "./projection";

export const CURRENT_RESEARCH_KEY = "homepage/current-research.json";
export const PURGE_MARKER_PREFIX = "homepage/purge-markers/sessions/";

type ExistingCurrentPublicationSnapshot = {
  exists: true;
  etag: string;
  currentRevision: string;
  wrapper: CurrentResearchStorageWrapper;
};
export type CurrentPublicationSnapshot =
  | ExistingCurrentPublicationSnapshot
  | { exists: false; etag: null; currentRevision: string; wrapper: null };

type PurgeMarker = { distillSessionId: string; requestedPublicationId: string; createdAt: string };

class PublicationStorageError extends Error {
  readonly code: string;

  constructor(code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "PublicationStorageError";
    this.code = code;
  }
}

const storageError = (code: string, cause?: unknown): PublicationStorageError => new PublicationStorageError(code, cause);

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f/\\]/.test(value) || value === "." || value === "..") {
    throw storageError(`${label}_invalid`);
  }
}

function assertDate(value: string, label: string): void {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value)) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw storageError(`${label}_invalid`);
  }
}

function parseJson(text: string, code: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw storageError(code, error);
  }
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function contentHash(payload: ExploringCurrentResearchPayload): Promise<string> {
  return sha256Hex(canonicalJson({ distilledAt: payload.distilledAt, content: payload.content }));
}

async function assertPayload(value: unknown): Promise<CurrentResearchPayload> {
  const payload = validateCurrentResearchPayload(value);
  if (!payload) throw storageError("publication_storage_invalid");
  if (payload.state === "EXPLORING" && await contentHash(payload) !== payload.contentHash) {
    throw storageError("publication_storage_invalid");
  }
  return payload;
}

function revisionFor(etag: string | null): Promise<string> {
  return sha256Hex(etag ?? "MISSING");
}

function etagOf(object: R2Object): string {
  // `etag` is the opaque token accepted by R2 conditional writes.  The
  // convenience `httpEtag` value may be quoted for an HTTP header and must
  // not be used as the CAS token.
  const etag = object.etag || object.httpEtag?.replace(/^"|"$/g, "");
  if (!etag) throw storageError("publication_storage_invalid");
  return etag;
}

function putOptions(expected: CurrentPublicationSnapshot): R2PutOptions {
  return expected.exists
    ? { onlyIf: { etagMatches: expected.etag }, httpMetadata: { contentType: "application/json; charset=utf-8" } }
    : { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json; charset=utf-8" } };
}

function snapshotFromPut(object: R2Object, wrapper: CurrentResearchStorageWrapper): Promise<CurrentPublicationSnapshot> {
  const etag = etagOf(object);
  return revisionFor(etag).then((currentRevision) => ({ exists: true, etag, currentRevision, wrapper }));
}

export function historyKey(publicationId: string, eventAt: string): string {
  assertIdentifier(publicationId, "publication_id");
  assertDate(eventAt, "event_at");
  return `homepage/history/${publicationId}/${eventAt}.json`;
}

export function purgeMarkerKey(distillSessionId: string): string {
  assertIdentifier(distillSessionId, "distill_session_id");
  return `${PURGE_MARKER_PREFIX}${distillSessionId}.json`;
}

export async function hasPermanentPurgeMarker(bucket: R2Bucket, distillSessionId: string): Promise<boolean> {
  const object = await bucket.head(purgeMarkerKey(distillSessionId));
  return object !== null;
}

export async function readPurgeMarker(bucket: R2Bucket, distillSessionId: string): Promise<PurgeMarker | null> {
  const object = await bucket.get(purgeMarkerKey(distillSessionId));
  if (!object) return null;
  const value = parseJson(await object.text(), "publication_purge_marker_corrupt");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw storageError("publication_purge_marker_corrupt");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "createdAt,distillSessionId,requestedPublicationId" ||
      record.distillSessionId !== distillSessionId || typeof record.requestedPublicationId !== "string" ||
      typeof record.createdAt !== "string") {
    throw storageError("publication_purge_marker_corrupt");
  }
  try {
    assertIdentifier(record.requestedPublicationId, "requested_publication_id");
    assertDate(record.createdAt, "created_at");
  } catch (error) {
    throw storageError("publication_purge_marker_corrupt", error);
  }
  return {
    distillSessionId,
    requestedPublicationId: record.requestedPublicationId,
    createdAt: record.createdAt,
  };
}

export async function putPermanentPurgeMarker(
  bucket: R2Bucket,
  input: PurgeMarker,
): Promise<void> {
  assertIdentifier(input.distillSessionId, "distill_session_id");
  assertIdentifier(input.requestedPublicationId, "requested_publication_id");
  assertDate(input.createdAt, "created_at");
  const key = purgeMarkerKey(input.distillSessionId);
  const body = JSON.stringify(input);
  let result: R2Object | null = null;
  try {
    result = await bucket.put(key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  } catch (error) {
    const existing = await readPurgeMarker(bucket, input.distillSessionId);
    if (existing && JSON.stringify(existing) === body) return;
    throw error;
  }
  if (result) return;
  const existing = await readPurgeMarker(bucket, input.distillSessionId);
  if (!existing) throw storageError("publication_purge_marker_conflict");
  if (JSON.stringify(existing) !== body) throw storageError("publication_purge_marker_conflict");
}

export async function readCurrentPublication(bucket: R2Bucket): Promise<CurrentPublicationSnapshot> {
  const object = await bucket.get(CURRENT_RESEARCH_KEY);
  if (!object) return { exists: false, etag: null, currentRevision: await revisionFor(null), wrapper: null };
  const value = parseJson(await object.text(), "publication_storage_invalid");
  const wrapper = validateCurrentResearchStorageWrapper(value);
  if (!wrapper) throw storageError("publication_storage_invalid");
  await assertPayload(wrapper.payload);
  const etag = etagOf(object);
  return { exists: true, etag, currentRevision: await revisionFor(etag), wrapper };
}

async function readHistoryPayload(bucket: R2Bucket, key: string): Promise<ExploringCurrentResearchPayload | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  return await assertPayload(parseJson(await object.text(), "publication_storage_invalid")) as ExploringCurrentResearchPayload;
}

function samePayload(left: CurrentResearchPayload, right: CurrentResearchPayload): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export async function putHistoryEventIfAbsent(
  bucket: R2Bucket,
  input: { distillSessionId: string; payload: ExploringCurrentResearchPayload },
): Promise<void> {
  const payload = await assertPayload(input.payload) as ExploringCurrentResearchPayload;
  const key = historyKey(payload.publicationId, payload.updatedAt);
  const body = JSON.stringify(payload);
  const markerPresent = await hasPermanentPurgeMarker(bucket, input.distillSessionId);
  if (markerPresent) throw storageError("publication_purged");
  let result: R2Object | null = null;
  try {
    result = await bucket.put(key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  } catch (error) {
    const existing = await readHistoryPayload(bucket, key);
    if (!(existing && samePayload(existing, payload))) throw error;
  }
  if (!result) {
    const existing = await readHistoryPayload(bucket, key);
    if (!existing) throw storageError("publication_history_conflict");
    if (existing.contentHash !== payload.contentHash) throw storageError("publication_history_conflict");
    if (!samePayload(existing, payload)) throw storageError("publication_history_conflict");
  }
  if (await hasPermanentPurgeMarker(bucket, input.distillSessionId)) {
    try { await bucket.delete(key); } finally { throw storageError("publication_purged"); }
  }
}

export async function compareAndSwapCurrent(
  bucket: R2Bucket,
  expected: CurrentPublicationSnapshot,
  payloadInput: CurrentResearchPayload,
): Promise<CurrentPublicationSnapshot> {
  const payload = await assertPayload(payloadInput);
  const wrapper: CurrentResearchStorageWrapper = { storageRevision: crypto.randomUUID(), payload };
  const body = JSON.stringify(wrapper);
  let result: R2Object | null;
  try {
    result = await bucket.put(CURRENT_RESEARCH_KEY, body, putOptions(expected));
  } catch (error) {
    try {
      const actual = await readCurrentPublication(bucket);
      if (actual.exists && samePayload(actual.wrapper.payload, payload)) return actual;
    } catch {
      // Preserve the original ambiguous R2 error. The caller can retry safely.
    }
    throw error;
  }
  if (!result) throw storageError("publication_state_changed");
  return snapshotFromPut(result, wrapper);
}

export async function fenceCurrentPublication(
  bucket: R2Bucket,
  expected: CurrentPublicationSnapshot,
): Promise<CurrentPublicationSnapshot> {
  if (!expected.exists) throw storageError("publication_state_changed");
  return compareAndSwapCurrent(bucket, expected, expected.wrapper.payload);
}

export async function deletePublicationHistory(
  bucket: R2Bucket,
  publicationId: string,
  heartbeat: () => Promise<void>,
): Promise<{ deleted: number; remaining: number }> {
  const prefix = `homepage/history/${publicationId}/`;
  let cursor: string | undefined;
  let deleted = 0;
  while (true) {
    await heartbeat();
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000 });
    if (page.objects.length > 0) {
      await heartbeat();
      await bucket.delete(page.objects.map((object) => object.key));
      deleted += page.objects.length;
    }
    if (page.truncated && page.cursor) {
      cursor = page.cursor;
      continue;
    }
    cursor = undefined;
    await heartbeat();
    const finalPage = await bucket.list({ prefix, limit: 1 });
    if (finalPage.objects.length === 0 && !finalPage.truncated) return { deleted, remaining: 0 };
    // A concurrent writer appeared after a page was deleted. Restart from the
    // prefix so no key is skipped and report only after a zero-count sweep.
  }
}
