import { decodeHtmlEntities } from "../../ingestion/extractHtml";

export interface HtmlVisualCandidate {
  candidateKey: string;
  sourceUrl: string;
  sourceSetUrls: string[];
  alt: string | null;
  figureLabel: string | null;
  caption: string | null;
  nearbyText: string | null;
  declaredWidth: number | null;
  declaredHeight: number | null;
  signals: string[];
}

export interface HtmlVisualExtractionDebugResult {
  candidates: HtmlVisualCandidate[];
  rejected: Array<{
    candidateKey: string;
    sourceUrl: string | null;
    signals: string[];
  }>;
}

interface RawObservation {
  candidateKey: string;
  sourceUrl: string | null;
  sourceSetUrls: string[];
  alt: string | null;
  figureLabel: string | null;
  caption: string | null;
  nearbyText: string | null;
  declaredWidth: number | null;
  declaredHeight: number | null;
  signals: string[];
}

interface SourceSetCandidate {
  url: string;
  descriptor: { kind: "width" | "density" | "order"; value: number };
}

interface SourceSetCollection {
  candidates: SourceSetCandidate[];
  signals: string[];
}

const CONTAINER_TAGS = ["header", "footer", "nav", "aside"] as const;
const AD_RE = /\b(ad|ads|advert|sponsor|promo|banner)\b/i;
const LOGO_RE = /\blogo\b/i;
const ICON_RE = /\b(icon|share|social)\b/i;
const TRACKER_RE = /\b(pixel|tracker|beacon|analytics)\b/i;

export function inspectHtmlVisualCandidates(html: string, baseUrl: string, selectedFragmentHtml?: string | null): HtmlVisualExtractionDebugResult {
  const scope = selectedFragmentHtml?.trim() ? selectedFragmentHtml : extractTagFragment(html, "body") ?? html;
  const rejected = new Map<string, RawObservation>();
  const candidates = new Map<string, RawObservation>();
  const containerFragments: string[] = [];

  for (const tag of CONTAINER_TAGS) {
    for (const fragment of collectTagFragments(html, tag)) {
      containerFragments.push(fragment);
      for (const observation of scanFragment(fragment, baseUrl, [`container:${tag}`], fragment)) {
        mergeObservation(rejected, observation);
      }
    }
  }

  const contentScope = removeFragments(scope, containerFragments);

  for (const observation of scanFragment(contentScope, baseUrl, [], contentScope)) {
    const target = shouldReject(observation) ? rejected : candidates;
    mergeObservation(target, observation);
  }

  const logoCounts = new Map<string, number>();
  for (const observation of [...rejected.values(), ...candidates.values()]) {
    if (observation.sourceUrl && observation.signals.includes("logo_asset")) {
      logoCounts.set(observation.sourceUrl, (logoCounts.get(observation.sourceUrl) ?? 0) + 1);
    }
  }

  for (const observation of [...rejected.values(), ...candidates.values()]) {
    if (observation.sourceUrl && (logoCounts.get(observation.sourceUrl) ?? 0) > 1) {
      addSignal(observation.signals, "repeated_logo");
      if (!shouldReject(observation)) {
        candidates.delete(observation.candidateKey);
        rejected.set(observation.candidateKey, observation);
      }
    }
  }

  return {
    candidates: [...candidates.values()].map(toCandidate),
    rejected: [...rejected.values()].map((observation) => ({
      candidateKey: observation.candidateKey,
      sourceUrl: observation.sourceUrl,
      signals: observation.signals,
    })),
  };
}

function scanFragment(fragment: string, baseUrl: string, baseSignals: string[], scope: string): RawObservation[] {
  const observations: RawObservation[] = [];
  const figureBlocks = collectTagFragments(fragment, "figure");
  const figureRemoved = removeFragments(fragment, figureBlocks);
  const pictureBlocks = collectTagFragments(figureRemoved, "picture");
  const pictureRemoved = removeFragments(figureRemoved, pictureBlocks);
  const imageTags = collectImgTags(pictureRemoved);

  for (const block of figureBlocks) {
    const observation = buildObservation(block, baseUrl, baseSignals, scope, true);
    if (observation) observations.push(observation);
  }
  for (const block of pictureBlocks) {
    const observation = buildObservation(block, baseUrl, baseSignals, scope, false);
    if (observation) observations.push(observation);
  }
  for (const block of imageTags) {
    const observation = buildObservation(block, baseUrl, baseSignals, scope, false);
    if (observation) observations.push(observation);
  }

  return observations;
}

function buildObservation(
  blockHtml: string,
  baseUrl: string,
  baseSignals: string[],
  scope: string,
  isFigure: boolean,
): RawObservation | null {
  const imgTag = blockHtml.match(/<img\b[^>]*>/i)?.[0] ?? null;
  if (!imgTag) return null;

  const srcAttr = getAttribute(imgTag, "src");
  const srcResult = srcAttr ? canonicalizeUrl(srcAttr, baseUrl) : null;
  const sourceSetCollection = collectSourceSetCandidates(blockHtml, baseUrl);
  const sourceSetUrls = uniqueList(sourceSetCollection.candidates.map((candidate) => candidate.url));
  const sourceUrl = selectPrimarySourceUrl(sourceSetCollection.candidates) ?? srcResult?.url ?? null;
  if (!sourceUrl) {
    return {
      candidateKey: `missing-source:${normalizeKey(toPlainText(blockHtml)).slice(0, 120)}`,
      sourceUrl: null,
      sourceSetUrls,
      alt: normalizeText(getAttribute(imgTag, "alt")),
      figureLabel: null,
      caption: null,
      nearbyText: null,
      declaredWidth: toNumber(getAttribute(imgTag, "width")),
      declaredHeight: toNumber(getAttribute(imgTag, "height")),
      signals: uniqueSignals([...baseSignals, ...sourceSetCollection.signals, srcResult?.signal ?? "missing_source_url"]),
    };
  }

  const captionText = normalizeText(extractTagText(blockHtml, "figcaption"));
  const [figureLabel, caption] = splitFigureCaption(captionText);
  const nearbyText = extractNearbyText(scope, blockHtml, captionText);
  const alt = normalizeText(getAttribute(imgTag, "alt"));
  const declaredWidth = toNumber(getAttribute(imgTag, "width"));
  const declaredHeight = toNumber(getAttribute(imgTag, "height"));
  const hasContextualCue = Boolean(figureLabel || caption || nearbyText || hasMeaningfulAlt(alt));
  const signals = uniqueSignals([
    ...baseSignals,
    isFigure ? "context:figure" : "context:embedded",
    ...(sourceSetUrls.length ? ["has_srcset"] : []),
    ...(figureLabel ? ["has_figure_label"] : []),
    ...(caption ? ["has_caption"] : []),
    ...(nearbyText ? ["has_nearby_text"] : []),
    ...sourceSetCollection.signals,
    ...(srcResult?.signal ? [srcResult.signal] : []),
  ]);

  if (TRACKER_RE.test(sourceUrl) || (declaredWidth === 1 && declaredHeight === 1)) addSignal(signals, "tracker_pixel");
  if (AD_RE.test(blockHtml) || AD_RE.test(alt ?? "") || AD_RE.test(sourceUrl)) addSignal(signals, "ad_related");
  if (LOGO_RE.test(sourceUrl) || LOGO_RE.test(alt ?? "")) addSignal(signals, "logo_asset");
  if ((declaredWidth ?? 0) > 0 && (declaredWidth ?? 0) <= 32 && (declaredHeight ?? 0) > 0 && (declaredHeight ?? 0) <= 32) {
    addSignal(signals, "small_dimensions");
    if (hasContextualCue) {
      addSignal(signals, "review_small_context");
    } else {
      addSignal(signals, "decorative_icon");
    }
  } else if ((declaredWidth ?? 0) > 0 && (declaredWidth ?? 0) <= 180 && (declaredHeight ?? 0) > 0 && (declaredHeight ?? 0) <= 120) {
    addSignal(signals, "small_dimensions");
    if (hasContextualCue) addSignal(signals, "review_small_context");
  }
  if (!hasContextualCue && ((alt ?? "").length <= 2 || ICON_RE.test(sourceUrl) || ICON_RE.test(alt ?? ""))) {
    addSignal(signals, "decorative_icon");
  }

  const candidateKey = `${sourceUrl}|${normalizeKey(figureLabel)}|${normalizeKey(caption)}|${normalizeKey(alt)}`;
  return {
    candidateKey,
    sourceUrl,
    sourceSetUrls,
    alt,
    figureLabel,
    caption,
    nearbyText,
    declaredWidth,
    declaredHeight,
    signals,
  };
}

function shouldReject(observation: RawObservation): boolean {
  return observation.signals.some((signal) => signal.startsWith("container:"))
    || observation.signals.includes("tracker_pixel")
    || observation.signals.includes("ad_related")
    || observation.signals.includes("decorative_icon")
    || observation.signals.includes("repeated_logo")
    || (!observation.sourceUrl && (
      observation.signals.includes("private_source_url")
      || observation.signals.includes("blocked_source_scheme")
      || observation.signals.includes("missing_source_url")
    ));
}

function mergeObservation(target: Map<string, RawObservation>, observation: RawObservation): void {
  const existing = target.get(observation.candidateKey);
  if (!existing) {
    target.set(observation.candidateKey, observation);
    return;
  }
  if (existing.signals.includes("logo_asset") || observation.signals.includes("logo_asset")) {
    addSignal(existing.signals, "repeated_logo");
  }
  existing.sourceSetUrls = uniqueList([...existing.sourceSetUrls, ...observation.sourceSetUrls]);
  existing.signals = uniqueSignals([...existing.signals, ...observation.signals]);
  existing.nearbyText ??= observation.nearbyText;
}

function toCandidate(observation: RawObservation): HtmlVisualCandidate {
  return {
    candidateKey: observation.candidateKey,
    sourceUrl: observation.sourceUrl ?? "",
    sourceSetUrls: observation.sourceSetUrls,
    alt: observation.alt,
    figureLabel: observation.figureLabel,
    caption: observation.caption,
    nearbyText: observation.nearbyText,
    declaredWidth: observation.declaredWidth,
    declaredHeight: observation.declaredHeight,
    signals: observation.signals,
  };
}

function collectTagFragments(html: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
  return [...html.matchAll(pattern)].map((match) => match[0]);
}

function extractTagFragment(html: string, tag: string): string | null {
  return html.match(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "i"))?.[0] ?? null;
}

function extractTagText(html: string, tag: string): string | null {
  return html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] ?? null;
}

function removeFragments(html: string, fragments: string[]): string {
  let next = html;
  for (const fragment of fragments) next = next.replace(fragment, " ");
  return next;
}

function collectImgTags(html: string): string[] {
  return [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
}

function getAttribute(tag: string, name: string): string | null {
  const quoted = tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"))?.[1];
  if (quoted != null) return decodeHtmlEntities(quoted).trim();
  const bare = tag.match(new RegExp(`\\b${name}=([^\\s>]+)`, "i"))?.[1];
  return bare ? decodeHtmlEntities(bare.replace(/^['"]|['"]$/g, "")).trim() : null;
}

function collectSourceSetCandidates(blockHtml: string, baseUrl: string): SourceSetCollection {
  const candidates: SourceSetCandidate[] = [];
  const signals: string[] = [];
  for (const match of blockHtml.matchAll(/\bsrcset=["']([^"']+)["']/gi)) {
    const srcset = match[1]?.trim();
    if (!srcset) continue;
    let order = 0;
    for (const part of srcset.split(",")) {
      const pieces = part.trim().split(/\s+/).filter(Boolean);
      const raw = pieces[0];
      if (!raw) continue;
      const normalized = canonicalizeUrl(raw, baseUrl);
      if (!normalized.url) {
        if (normalized.signal) addSignal(signals, normalized.signal);
        order += 1;
        continue;
      }
      candidates.push({
        url: normalized.url,
        descriptor: parseSourceSetDescriptor(pieces[1] ?? null, order),
      });
      order += 1;
    }
  }
  return { candidates, signals: uniqueSignals(signals) };
}

function parseSourceSetDescriptor(raw: string | null, order: number): SourceSetCandidate["descriptor"] {
  if (!raw) return { kind: "order", value: order };
  const width = raw.match(/^(\d+(?:\.\d+)?)w$/i);
  if (width) return { kind: "width", value: Number(width[1]) };
  const density = raw.match(/^(\d+(?:\.\d+)?)x$/i);
  if (density) return { kind: "density", value: Number(density[1]) };
  return { kind: "order", value: order };
}

function selectPrimarySourceUrl(candidates: SourceSetCandidate[]): string | null {
  if (!candidates.length) return null;
  const ranked = [...candidates].sort(compareSourceSetCandidates);
  return ranked[0]?.url ?? null;
}

function compareSourceSetCandidates(left: SourceSetCandidate, right: SourceSetCandidate): number {
  const rank = (candidate: SourceSetCandidate): number => {
    if (candidate.descriptor.kind === "width") return 3;
    if (candidate.descriptor.kind === "density") return 2;
    return 1;
  };
  const rankDiff = rank(right) - rank(left);
  if (rankDiff !== 0) return rankDiff;
  const valueDiff = right.descriptor.value - left.descriptor.value;
  if (valueDiff !== 0) return valueDiff;
  return right.url.localeCompare(left.url);
}

function canonicalizeUrl(raw: string, baseUrl: string): { url: string | null; signal?: string } {
  try {
    const url = new URL(raw, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return { url: null, signal: "blocked_source_scheme" };
    if (isPrivateUrl(url)) return { url: null, signal: "private_source_url" };
    url.hash = "";
    const kept: Array<[string, string]> = [];
    const seenPairs = new Set<string>();
    for (const [key, value] of [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) return leftValue.localeCompare(rightValue);
      return leftKey.localeCompare(rightKey);
    })) {
      if (/^(utm_[^=]*|fbclid|gclid)$/i.test(key)) continue;
      const pair = `${key}=${value}`;
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      kept.push([key, value]);
    }
    url.search = "";
    for (const [key, value] of kept) url.searchParams.append(key, value);
    return { url: url.toString() };
  } catch {
    return { url: null, signal: "blocked_source_scheme" };
  }
}

function isPrivateUrl(url: URL): boolean {
  const normalizedHost = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalizedHost === "localhost" || normalizedHost.endsWith(".local")) return true;
  const ipv4 = parseIpv4Host(normalizedHost) ?? parseIpv4MappedHost(normalizedHost);
  if (ipv4) return isPrivateIpv4(ipv4);
  const ipv6 = expandIpv6Hextets(normalizedHost);
  if (!ipv6) return false;
  const firstHextet = ipv6[0];
  if (firstHextet == null) return false;
  if (ipv6.slice(0, 7).every((segment, index) => index < 7 ? segment === 0 : true) && ipv6[7] === 1) return true;
  return (firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80;
}

function parseIpv4Host(host: string): number[] | null {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  const parts = host.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function parseIpv4MappedHost(host: string): number[] | null {
  const hextets = expandIpv6Hextets(host);
  if (!hextets) return null;
  if (!hextets.slice(0, 5).every((segment) => segment === 0) || hextets[5] !== 0xffff) return null;
  const left = hextets[6];
  const right = hextets[7];
  if (left == null || right == null) return null;
  return [(left >> 8) & 0xff, left & 0xff, (right >> 8) & 0xff, right & 0xff];
}

function isPrivateIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  return a === 172 && b != null && b >= 16 && b <= 31;
}

function expandIpv6Hextets(host: string): number[] | null {
  if (!host.includes(":")) return null;
  const normalized = host.toLowerCase();
  if (normalized.indexOf("::") !== normalized.lastIndexOf("::")) return null;

  const hasIpv4Tail = normalized.includes(".");
  let working = normalized;
  const tailSegments: string[] = [];
  if (hasIpv4Tail) {
    const lastColon = working.lastIndexOf(":");
    if (lastColon < 0) return null;
    const ipv4Tail = working.slice(lastColon + 1);
    const ipv4 = parseIpv4Host(ipv4Tail);
    if (!ipv4) return null;
    const [a, b, c, d] = ipv4;
    if (a == null || b == null || c == null || d == null) return null;
    tailSegments.push(((a << 8) | b).toString(16));
    tailSegments.push(((c << 8) | d).toString(16));
    working = working.slice(0, lastColon);
  }

  const [leftRaw, rightRaw = ""] = working.split("::");
  const left = leftRaw ? leftRaw.split(":").filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(":").filter(Boolean) : [];
  const explicit = [...left, ...right, ...tailSegments];
  if (explicit.some((segment) => !/^[0-9a-f]{1,4}$/i.test(segment))) return null;
  const zeroFill = working.includes("::") ? 8 - explicit.length : 0;
  if (zeroFill < 0) return null;
  if (!working.includes("::") && explicit.length !== 8) return null;
  const expanded = [
    ...left,
    ...Array.from({ length: zeroFill }, () => "0"),
    ...right,
    ...tailSegments,
  ];
  if (expanded.length !== 8) return null;
  return expanded.map((segment) => Number.parseInt(segment, 16));
}

function splitFigureCaption(value: string | null): [string | null, string | null] {
  if (!value) return [null, null];
  const match = value.match(/^(figure\s*\d+|fig\.\s*\d+|도판\s*\d+|이미지\s*\d+)[.:]?\s*(.*)$/i);
  if (!match) return [null, value];
  return [match[1]?.replace(/\s+/g, " ").trim() ?? null, match[2]?.trim() || null];
}

function extractNearbyText(scope: string, blockHtml: string, captionText: string | null): string | null {
  const index = scope.indexOf(blockHtml);
  if (index < 0) return null;
  const before = toPlainText(scope.slice(Math.max(0, index - 400), index));
  const after = toPlainText(scope.slice(index + blockHtml.length, index + blockHtml.length + 400));
  const joined = normalizeText(`${before} ${after}`.replace(captionText ?? "", ""));
  return joined && joined.length > 20 ? joined : null;
}

function toPlainText(value: string): string {
  return decodeHtmlEntities(value.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeText(value: string | null): string | null {
  return value ? toPlainText(value).replace(/\s+/g, " ").trim() || null : null;
}

function hasMeaningfulAlt(value: string | null): boolean {
  return Boolean(value && value.replace(/\s+/g, " ").trim().length >= 3);
}

function normalizeKey(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function toNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function addSignal(target: string[], signal: string): void {
  if (!target.includes(signal)) target.push(signal);
}

function uniqueSignals(values: string[]): string[] {
  return uniqueList(values).sort((left, right) => left.localeCompare(right));
}

function uniqueList(values: string[]): string[] {
  return [...new Set(values)];
}
