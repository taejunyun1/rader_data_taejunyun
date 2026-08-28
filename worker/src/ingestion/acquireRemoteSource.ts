import { classifyTextScope, normalizeIngestText, type ExtractionMethod, type TextScope } from "@radar/shared/ingestion";
import { extractStaticHtml } from "./extractHtml";
import {
  fetchRemoteDocument,
  RemoteFetchError,
  type RemoteDocumentKind,
  type RemoteFetchErrorCode,
  type RemoteFetchFailureReason,
} from "./fetchRemoteDocument";
import { sha256Hex } from "./ids";

export interface RemoteAcquisitionInput {
  sourceId: string;
  url: string;
  version: number;
  versionId?: string;
}

export interface RemoteAcquisitionResult {
  kind: "HTML" | "PDF";
  r2Key: string;
  extractedText: string;
  title: string | null;
  contentType: string;
  finalUrl: string;
  warnings: string[];
  textScope: TextScope;
  extractionMethod: ExtractionMethod;
  rawContentHash: string;
}

interface RemoteAcquisitionOptions {
  fetchImpl?: typeof fetch;
}

export type RemoteAcquisitionFailureReason = RemoteFetchFailureReason;

function remoteAcquisitionErrorMessage(input: {
  code: RemoteAcquisitionErrorCode;
  status?: number;
  reason?: RemoteAcquisitionFailureReason;
}): string {
  const fields = [
    "remote_acquisition_failure",
    "code=" + input.code,
  ];
  if (typeof input.status === "number") fields.push("status=" + String(input.status));
  if (input.reason) fields.push("reason=" + input.reason);
  return fields.join(";");
}

export class RemoteAcquisitionError extends Error {
  constructor(
    readonly code: RemoteAcquisitionErrorCode,
    readonly status?: number,
    readonly reason?: RemoteAcquisitionFailureReason,
    readonly finalUrl?: string,
  ) {
    super(remoteAcquisitionErrorMessage({ code, status, reason }));
    this.name = "RemoteAcquisitionError";
  }
}

export type RemoteAcquisitionErrorCode =
  | RemoteFetchErrorCode
  | "EXTRACTION_EMPTY"
  | "PDF_CONVERSION_FAILED";

export async function acquireRemoteSource(
  env: Env,
  input: RemoteAcquisitionInput,
  options: RemoteAcquisitionOptions = {},
): Promise<RemoteAcquisitionResult> {
  try {
    const remote = await fetchRemoteDocument(input.url, { fetchImpl: options.fetchImpl });
    const r2Key = buildOriginalKey(input.sourceId, input.version, input.versionId, remote.kind);
    await env.ORIGINALS.put(r2Key, remote.body);
    const rawContentHash = await sha256Hex(remote.body);

    if (remote.kind === "PDF") {
      const extracted = await extractRemotePdf(env, input, remote.body);
      return {
        kind: remote.kind,
        r2Key,
        extractedText: extracted.text,
        title: null,
        contentType: remote.contentType,
        finalUrl: remote.finalUrl,
        warnings: extracted.warnings,
        textScope: extracted.scope,
        extractionMethod: "PDF_REMOTE_TO_MARKDOWN",
        rawContentHash,
      };
    }

    const html = new TextDecoder().decode(remote.body);
    const extracted = extractStaticHtml(html, remote.finalUrl);
    if (!extracted.text.trim()) throw new RemoteAcquisitionError("EXTRACTION_EMPTY");

    return {
      kind: remote.kind,
      r2Key,
      extractedText: extracted.text,
      title: extracted.title || null,
      contentType: remote.contentType,
      finalUrl: remote.finalUrl,
      warnings: extracted.warnings,
      textScope: extracted.scope,
      extractionMethod: extracted.method,
      rawContentHash,
    };
  } catch (error) {
    if (error instanceof RemoteAcquisitionError) throw error;

    if (error instanceof RemoteFetchError) {
      if (error.code === "PDF_SIGNATURE_INVALID" && error.document) {
        try {
          const r2Key = buildOriginalKey(input.sourceId, input.version, input.versionId, "PDF");
          await env.ORIGINALS.put(r2Key, error.document.body);
        } catch {
          throw new RemoteAcquisitionError("HTTP_5XX");
        }
      }
      throw new RemoteAcquisitionError(
        error.code,
        error.status,
        error.reason,
        error.finalUrl,
      );
    }

    if (isAbortError(error)) throw new RemoteAcquisitionError("FETCH_TIMEOUT");
    throw new RemoteAcquisitionError("HTTP_5XX");
  }
}

function buildOriginalKey(sourceId: string, version: number, versionId: string | undefined, kind: RemoteDocumentKind): string {
  if (versionId) return `originals/${sourceId}/${versionId}.${kind === "HTML" ? "html" : "pdf"}`;
  return `originals/${sourceId}/v${version}.${kind === "HTML" ? "html" : "pdf"}`;
}

async function extractRemotePdf(
  env: Env,
  input: RemoteAcquisitionInput,
  rawBody: ArrayBuffer,
): Promise<{ text: string; warnings: string[]; scope: TextScope }> {
  let converted: unknown;
  try {
    converted = await env.AI.toMarkdown([
      {
        name: `${input.sourceId}.pdf`,
        blob: new Blob([rawBody], { type: "application/pdf" }),
      },
    ]);
  } catch {
    throw new RemoteAcquisitionError("PDF_CONVERSION_FAILED");
  }

  const text = await readMarkdownConversion(converted);
  const normalized = normalizeIngestText(text, "PDF_TEXT");
  const { scope } = classifyTextScope({
    format: "PDF_TEXT",
    meaningfulChars: normalized.report.meaningfulChars,
    warnings: normalized.report.warnings,
    extractionMethod: "PDF_REMOTE_TO_MARKDOWN",
  });

  return {
    text,
    warnings: normalized.report.warnings,
    scope,
  };
}

async function readMarkdownConversion(value: unknown): Promise<string> {
  const results = Array.isArray(value) ? value : [value];
  const parts: string[] = [];

  for (const result of results) {
    if (!result || typeof result !== "object") continue;

    const errorFormat = "format" in result && result.format === "error";
    if (errorFormat) throw new RemoteAcquisitionError("PDF_CONVERSION_FAILED");

    if ("data" in result && typeof result.data === "string") {
      parts.push(result.data);
      continue;
    }

    if ("blob" in result && result.blob instanceof Blob) {
      parts.push(await result.blob.text());
    }
  }

  return parts.join("\n\n").trim();
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "AbortError";
}
