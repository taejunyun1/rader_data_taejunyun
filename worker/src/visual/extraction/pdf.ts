export interface PdfPageCandidate {
  bbox: { x: number; y: number; width: number; height: number };
  visualKind: "PHOTO" | "ARTWORK" | "INSTALLATION" | "GRAPHIC" | "DIAGRAM" | "DOCUMENT_SCAN" | "DECORATIVE";
  figureLabel: string | null;
  caption: string | null;
  reason: string;
  confidence: number;
}

export interface ParsedPdfPageCandidates {
  accepted: Array<Omit<PdfPageCandidate, "visualKind"> & { visualKind: Exclude<PdfPageCandidate["visualKind"], "DECORATIVE"> }>;
  rejected: Array<{ candidate: PdfPageCandidate; reason: string }>;
}

const HEADER_FOOTER_BAND = 0.12;
const OVERLAP_THRESHOLD = 0.92;

export function parsePdfPageCandidates(candidates: PdfPageCandidate[]): ParsedPdfPageCandidates {
  const accepted: ParsedPdfPageCandidates["accepted"] = [];
  const rejected: ParsedPdfPageCandidates["rejected"] = [];

  for (const candidate of candidates) {
    const bboxIssue = validateBbox(candidate.bbox);
    if (bboxIssue) {
      rejected.push({ candidate, reason: bboxIssue });
      continue;
    }
    if (isRepeatedBackground(candidate)) {
      rejected.push({ candidate, reason: "decorative_repeated_background" });
      continue;
    }
    if (isDecorativeHeaderFooter(candidate)) {
      rejected.push({ candidate, reason: "decorative_header_footer" });
      continue;
    }
    if (accepted.some((existing) => overlapRatio(existing.bbox, candidate.bbox) >= OVERLAP_THRESHOLD)) {
      rejected.push({ candidate, reason: "bbox_duplicate_overlap" });
      continue;
    }
    if (candidate.visualKind === "DECORATIVE") {
      rejected.push({ candidate, reason: "decorative_candidate" });
      continue;
    }
    accepted.push(candidate as ParsedPdfPageCandidates["accepted"][number]);
  }

  return { accepted, rejected };
}

export function buildPdfVisionPrompt(input: {
  title?: string | null;
  pageNumber: number;
  figureContext: Array<{ figureLabel: string | null; caption: string | null }>;
}): string {
  const figureLines = input.figureContext
    .map((item) => [item.figureLabel, item.caption].filter(Boolean).join(" "))
    .filter(Boolean)
    .join("\n- ");

  return [
    "You are identifying visual regions within one PDF page for Research Radar.",
    `Document title: ${input.title?.trim() || "unknown"}`,
    `Page number: ${input.pageNumber}`,
    "Use only the page-local figure/caption context below. Do not infer from the rest of the document.",
    figureLines ? `Page-local figure context:\n- ${figureLines}` : "Page-local figure context: none",
    "Return strict JSON as an array of candidates with bbox(x,y,width,height normalized 0..1), visualKind, figureLabel, caption, reason, confidence.",
  ].join("\n");
}

function validateBbox(bbox: PdfPageCandidate["bbox"]): string | null {
  if (bbox.width <= 0 || bbox.height <= 0) return "bbox_zero_area";
  if (bbox.x < 0 || bbox.y < 0 || bbox.width > 1 || bbox.height > 1) return "bbox_out_of_range";
  if (bbox.x + bbox.width > 1 || bbox.y + bbox.height > 1) return "bbox_out_of_range";
  return null;
}

function isDecorativeHeaderFooter(candidate: PdfPageCandidate): boolean {
  if (candidate.visualKind !== "DECORATIVE") return false;
  const topBand = candidate.bbox.y <= HEADER_FOOTER_BAND;
  const bottomBand = candidate.bbox.y + candidate.bbox.height >= 1 - HEADER_FOOTER_BAND;
  return (topBand || bottomBand) && candidate.bbox.height <= 0.15;
}

function isRepeatedBackground(candidate: PdfPageCandidate): boolean {
  if (candidate.visualKind !== "DECORATIVE") return false;
  const spansWidth = candidate.bbox.width >= 0.9;
  const shallowBand = candidate.bbox.height <= 0.12;
  const mentionsBackground = /background|band|repeat/i.test(`${candidate.reason} ${candidate.caption ?? ""}`);
  return spansWidth && shallowBand && mentionsBackground;
}

function overlapRatio(
  left: PdfPageCandidate["bbox"],
  right: PdfPageCandidate["bbox"],
): number {
  const overlapWidth = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const overlapHeight = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const overlapArea = overlapWidth * overlapHeight;
  if (overlapArea <= 0) return 0;
  const leftArea = left.width * left.height;
  const rightArea = right.width * right.height;
  return overlapArea / Math.min(leftArea, rightArea);
}
