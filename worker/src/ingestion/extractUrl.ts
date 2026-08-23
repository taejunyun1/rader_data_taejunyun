import type { TextScope } from "@radar/shared/ingestion";
import { extractStaticHtml } from "./extractHtml";
import { fetchRemoteDocument, RemoteFetchError } from "./fetchRemoteDocument";

export interface ExtractedPage {
  html: string;
  title: string;
  text: string;
  siteName: string | null;
  description: string | null;
  finalUrl: string;
  warnings: string[];
  scope: TextScope;
  method: "HTML_STATIC";
}

export async function fetchAndExtract(url: string): Promise<ExtractedPage> {
  const remote = await fetchRemoteDocument(url);
  if (remote.kind !== "HTML") throw new RemoteFetchError("UNSUPPORTED_CONTENT_TYPE");

  const html = new TextDecoder().decode(remote.body);
  const extracted = extractStaticHtml(html, remote.finalUrl);

  return {
    html,
    title: extracted.title,
    text: extracted.text,
    siteName: extracted.siteName,
    description: extracted.description,
    finalUrl: remote.finalUrl,
    warnings: extracted.warnings,
    scope: extracted.scope,
    method: extracted.method,
  };
}
