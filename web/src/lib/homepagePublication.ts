import {
  type CurrentResearchContent,
  type DistillHomepagePublicationState,
  type HomepageCsrfResponse,
  type HomepageCurrentStatus,
  type HomepagePreviewResponse,
  type HomepagePublicationStatusResponse,
  type HomepagePublishRequest,
  type HomepagePublishResponse,
  type HomepageWithdrawRequest,
  type HomepageWithdrawResponse,
  validateCurrentResearchPayload,
} from "@radar/shared";

export class HomepagePublicationApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId: string | null = null,
    readonly details?: unknown,
  ) {
    super(code);
    this.name = "HomepagePublicationApiError";
  }
}

export type HomepagePublicationAction =
  | { kind: "PUBLISH" | "UPDATE"; enabled: true; label: string }
  | { kind: "CURRENT" | "PURGING" | "PURGED" | "OLD"; enabled: false; label: string };

export interface ActionInput {
  sessionId: string;
  sessionState: DistillHomepagePublicationState;
  status: HomepagePublicationStatusResponse;
}

const COPY = {
  publish: "홈페이지에 반영",
  update: "새 결과로 업데이트",
  current: "현재 홈페이지에 공개 중",
  purging: "공개 삭제 처리 중…",
  purged: "공개 삭제됨 · 새 Distill 필요",
  old: "최신 Distill만 반영 가능",
  pending: "반영 중…",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isStringArray(value: unknown, max = Number.POSITIVE_INFINITY): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string");
}

function isContent(value: unknown): value is CurrentResearchContent {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "artworkDirections,displayTitle,keywords,questions,researchDirections,researchMaterials,thoughts") return false;
  if (typeof value.displayTitle !== "string") return false;
  if (!isStringArray(value.keywords, 6) || !isStringArray(value.thoughts, 3) || !isStringArray(value.questions, 3) || !isStringArray(value.researchDirections, 2) || !isStringArray(value.artworkDirections, 2)) return false;
  if (!Array.isArray(value.researchMaterials) || value.researchMaterials.length > 5) return false;
  return value.researchMaterials.every((material) => {
    if (!isRecord(material)) return false;
    if (Object.keys(material).sort().join(",") !== "author,title,url,year") return false;
    if (typeof material.title !== "string" || (material.author !== null && typeof material.author !== "string") || (material.year !== null && !Number.isInteger(material.year)) || typeof material.url !== "string") return false;
    try {
      const url = new URL(material.url);
      return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
    } catch {
      return false;
    }
  });
}

function validCurrent(value: unknown): value is HomepageCurrentStatus {
  if (!isRecord(value) || typeof value.state !== "string") return false;
  if (value.state === "NONE") return Object.keys(value).length === 1;
  if (value.state === "PUBLISHED") return typeof value.publicationId === "string" && typeof value.distillSessionId === "string" && typeof value.contentHash === "string" && isIsoDate(value.publishedAt) && isIsoDate(value.updatedAt);
  if (value.state === "WITHDRAWN") return (value.publicationId === null || typeof value.publicationId === "string") && (value.distillSessionId === null || typeof value.distillSessionId === "string") && (value.contentHash === null || typeof value.contentHash === "string") && isIsoDate(value.withdrawnAt);
  return false;
}

function validatePreview(value: unknown): HomepagePreviewResponse | null {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "changed,content,contentHash,currentRevision,distilledAt,excludedResearchMaterialCount,privateReview,sessionId") return null;
  if (typeof value.sessionId !== "string" || !isIsoDate(value.distilledAt) || typeof value.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(value.contentHash) || typeof value.currentRevision !== "string" || typeof value.changed !== "boolean" || typeof value.excludedResearchMaterialCount !== "number" || !Number.isInteger(value.excludedResearchMaterialCount) || value.excludedResearchMaterialCount < 0 || !isContent(value.content)) return null;
  if (!isRecord(value.privateReview) || Object.keys(value.privateReview).sort().join(",") !== "overall,warnings" || (value.privateReview.overall !== null && typeof value.privateReview.overall !== "string") || !Array.isArray(value.privateReview.warnings) || !value.privateReview.warnings.every((warning) => isRecord(warning) && typeof warning.category === "string" && typeof warning.note === "string")) return null;
  return value as unknown as HomepagePreviewResponse;
}

function validateStatus(value: unknown): HomepagePublicationStatusResponse | null {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "current,currentRevision,latestPublishable,ledgerReconcilePending") return null;
  if (typeof value.currentRevision !== "string" || typeof value.ledgerReconcilePending !== "boolean" || !validCurrent(value.current)) return null;
  if (value.latestPublishable !== null) {
    if (!isRecord(value.latestPublishable) || Object.keys(value.latestPublishable).sort().join(",") !== "contentHash,distilledAt,sessionId" || typeof value.latestPublishable.sessionId !== "string" || typeof value.latestPublishable.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(value.latestPublishable.contentHash) || !isIsoDate(value.latestPublishable.distilledAt)) return null;
  }
  return value as unknown as HomepagePublicationStatusResponse;
}

function validateCsrf(value: unknown): HomepageCsrfResponse | null {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "expiresAt,token" || typeof value.token !== "string" || !value.token || !isIsoDate(value.expiresAt)) return null;
  return value as unknown as HomepageCsrfResponse;
}

function validatePublish(value: unknown): HomepagePublishResponse | null {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "currentRevision,idempotent,ledgerReconcilePending,ok,publication" || value.ok !== true || typeof value.currentRevision !== "string" || typeof value.idempotent !== "boolean" || typeof value.ledgerReconcilePending !== "boolean" || !validateCurrentResearchPayload(value.publication)) return null;
  return value as unknown as HomepagePublishResponse;
}

function validateWithdraw(value: unknown): HomepageWithdrawResponse | null {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "currentRevision,idempotent,ledgerReconcilePending,state,withdrawnAt,withdrawnPublicationId" || value.ok !== true || value.state !== "WITHDRAWN" || typeof value.currentRevision !== "string" || typeof value.idempotent !== "boolean" || typeof value.ledgerReconcilePending !== "boolean" || typeof value.withdrawnPublicationId !== "string" || !isIsoDate(value.withdrawnAt)) return null;
  return value as unknown as HomepageWithdrawResponse;
}

function requestId(response: Response, body: unknown): string | null {
  if (response.headers.get("X-Request-Id")) return response.headers.get("X-Request-Id");
  return isRecord(body) && typeof body.requestId === "string" ? body.requestId : null;
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("Content-Type") ?? "";
  const text = await response.text();
  if (!/\bapplication\/json\b|\+json\b/i.test(contentType)) throw new HomepagePublicationApiError(response.status, "invalid_response", requestId(response, null), { reason: "content_type" });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HomepagePublicationApiError(response.status, "invalid_response", requestId(response, null), { reason: "json" });
  }
}

async function getJson<T>(url: string, validate: (value: unknown) => T | null, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: "no-store", credentials: "same-origin" });
  const body = await readJson(response);
  if (!response.ok) {
    const error = isRecord(body) && typeof body.error === "string" ? body.error : "request_failed";
    const details = isRecord(body) ? body.details : undefined;
    throw new HomepagePublicationApiError(response.status, error, requestId(response, body), details);
  }
  const result = validate(body);
  if (!result) throw new HomepagePublicationApiError(response.status, "invalid_response", requestId(response, body), { reason: "shape" });
  return result;
}

export function fetchHomepagePublicationStatus(signal?: AbortSignal) {
  return getJson("/api/distill/homepage-publication", validateStatus, signal);
}

export function fetchHomepagePreview(sessionId: string, signal?: AbortSignal) {
  return getJson(`/api/distill/sessions/${encodeURIComponent(sessionId)}/homepage-preview`, validatePreview, signal);
}

async function freshCsrf(): Promise<HomepageCsrfResponse> {
  return getJson("/api/distill/homepage-publication/csrf", validateCsrf);
}

async function postJson<T>(url: string, body: unknown, validate: (value: unknown) => T | null): Promise<T> {
  const csrf = await freshCsrf();
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
    body: JSON.stringify(body),
  });
  const resultBody = await readJson(response);
  if (!response.ok) {
    const error = isRecord(resultBody) && typeof resultBody.error === "string" ? resultBody.error : "request_failed";
    const details = isRecord(resultBody) ? resultBody.details : undefined;
    throw new HomepagePublicationApiError(response.status, error, requestId(response, resultBody), details);
  }
  const result = validate(resultBody);
  if (!result) throw new HomepagePublicationApiError(response.status, "invalid_response", requestId(response, resultBody), { reason: "shape" });
  return result;
}

export function publishHomepagePreview(sessionId: string, expected: HomepagePublishRequest) {
  return postJson(`/api/distill/sessions/${encodeURIComponent(sessionId)}/homepage-publish`, {
    expectedContentHash: expected.expectedContentHash,
    expectedCurrentRevision: expected.expectedCurrentRevision,
  }, validatePublish);
}

export function withdrawHomepagePublication(expected: HomepageWithdrawRequest) {
  return postJson("/api/distill/homepage-publication/withdraw", {
    expectedPublicationId: expected.expectedPublicationId,
    expectedContentHash: expected.expectedContentHash,
    expectedCurrentRevision: expected.expectedCurrentRevision,
  }, validateWithdraw);
}

export function formatHomepagePublicationDate(iso: string): string {
  const formatter = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = formatter.formatToParts(new Date(iso));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}.${part("month")}.${part("day")}`;
}

export function deriveHomepagePublicationAction({ sessionId, sessionState, status }: ActionInput): HomepagePublicationAction {
  if (sessionState === "PURGING") return { kind: "PURGING", enabled: false, label: COPY.purging };
  if (sessionState === "PURGED") return { kind: "PURGED", enabled: false, label: COPY.purged };
  if (status.current.state === "PUBLISHED" && status.current.distillSessionId === sessionId) return { kind: "CURRENT", enabled: false, label: `${COPY.current} · ${formatHomepagePublicationDate(status.current.updatedAt)}` };
  if (status.latestPublishable?.sessionId === sessionId) return status.current.state === "PUBLISHED" ? { kind: "UPDATE", enabled: true, label: COPY.update } : { kind: "PUBLISH", enabled: true, label: COPY.publish };
  return { kind: "OLD", enabled: false, label: COPY.old };
}

export function homepagePublicationErrorMessage(action: "status" | "preview" | "publish" | "withdraw", code: string): string {
  const messages: Record<string, string> = {
    latest_distill_required: "최신 Distill만 홈페이지에 반영할 수 있습니다.",
    distill_output_not_ready: "완료된 Distill 결과가 필요합니다.",
    public_projection_empty: "홈페이지에 공개할 연구 내용이 없습니다.",
    public_projection_invalid: "공개용 연구 내용을 확인해 주세요.",
    preview_stale: "연구 내용이 변경되었습니다. 미리보기를 다시 확인해 주세요.",
    withdrawal_stale: "공개본이 변경되었습니다. 철회 대상을 다시 확인해 주세요.",
    publication_state_changed: "홈페이지 공개 상태가 변경되었습니다. 다시 확인해 주세요.",
    publication_in_progress: "다른 공개 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.",
    source_delete_in_progress: "자료 삭제가 진행 중입니다. 완료 후 다시 시도해 주세요.",
    publication_ledger_unavailable: "공개 상태를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
    publication_purged: "공개 삭제된 연구입니다. 새 Distill이 필요합니다.",
    csrf_invalid: "보안 확인이 만료되었습니다. 다시 시도해 주세요.",
  };
  if (action === "status") return messages[code] ?? "홈페이지 공개 상태를 확인하지 못했습니다.";
  if (action === "preview") return messages[code] ?? "미리보기를 불러오지 못했습니다. 다시 시도해 주세요.";
  return messages[code] ?? "홈페이지 공개 요청을 완료하지 못했습니다. 다시 시도해 주세요.";
}

export const homepagePublicationCopy = COPY;
