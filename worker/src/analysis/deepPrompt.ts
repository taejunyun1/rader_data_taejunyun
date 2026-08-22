import type { DeepProfile } from "./deepProfiles";

export interface DeepChunkResult {
  overview: string;
  arguments: { claim: string; evidence: string[] }[];
  structure: string[];
  quotes: string[];
  concepts: string[];
  uncertainties: string[];
}

export interface DeepAnalysisPayload {
  profile: DeepProfile;
  overview: string;
  arguments: { claim: string; evidence: string[] }[];
  structure: string[];
  quotes: string[];
  connections: string[];
  researchUses: string[];
  limitations: string[];
  meta: {
    sourceCharCount: number;
    analyzedCharCount: number;
    chunkCount: number;
  };
}

export function chunkText(text: string, maxChars: number, maxChunks = 4): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length && chunks.length < maxChunks) {
    const target = Math.min(cursor + maxChars, normalized.length);
    let end = target;
    if (target < normalized.length) {
      const paragraph = normalized.lastIndexOf("\n\n", target);
      const line = normalized.lastIndexOf("\n", target);
      const boundary = paragraph > cursor + Math.floor(maxChars * 0.55) ? paragraph : line;
      if (boundary > cursor) end = boundary;
    }
    chunks.push(normalized.slice(cursor, end).trim());
    if (end >= normalized.length) break;
    cursor = end;
  }
  return chunks.filter(Boolean);
}

export function deepChunkPrompt(chunk: string, index: number, total: number): string {
  return `Research Radar의 심층 독해 단계입니다. 아래는 원문 ${total}개 구간 중 ${index + 1}번째입니다.

원문에 없는 사실을 추가하지 말고, 인용은 반드시 아래 원문에서 그대로 가져오세요. 자료에 없는 항목은 빈 배열로 두세요. 모든 설명은 한국어로 작성하되 고유명사는 원문 표기를 유지하세요.

반환 JSON:
{
  "overview": "이 구간이 말하는 핵심을 3-6문장으로 정리",
  "arguments": [{"claim": "핵심 주장", "evidence": ["주장을 지지하는 원문 근거"]}],
  "structure": ["논지의 전개 단계"],
  "quotes": ["짧은 원문 인용"],
  "concepts": ["구간의 핵심 개념"],
  "uncertainties": ["근거가 부족하거나 열려 있는 지점"]
}

원문 구간:
"""
${chunk}
"""`;
}

export function deepSynthesisPrompt(results: DeepChunkResult[], profile: DeepProfile, sourceCharCount: number, analyzedCharCount: number): string {
  return `Research Radar의 최종 심층 정리 단계입니다. 여러 구간 분석을 하나의 자료 독해로 통합하세요.

프로필: ${profile}
전체 원문 글자 수: ${sourceCharCount}
분석한 글자 수: ${analyzedCharCount}

구간 분석:
${JSON.stringify(results, null, 2)}

반환 strict JSON:
{
  "overview": "자료 전체의 핵심을 6-10문장으로 요약",
  "arguments": [{"claim": "핵심 주장", "evidence": ["구간 분석에 실제로 등장한 근거"]}],
  "structure": ["자료의 논리·서사 전개를 순서대로 정리"],
  "quotes": ["구간 분석에 실제 존재하는 짧은 원문 인용"],
  "connections": ["사진·이미지·미디어·작업 연구와 연결되는 지점"],
  "researchUses": ["이 자료를 연구에서 어떻게 다시 사용할지"],
  "limitations": ["자료의 한계, 공백, 검증이 필요한 부분"]
}

규칙:
- 구간 분석에 없는 사실·인용·인물을 만들지 마세요.
- 요약은 원문을 대신하지 않는 해석임을 유지하세요.
- 중요한 주장에는 구체적인 근거를 연결하세요.
- 자료가 말하지 않는 연결은 추측이라고 표시하거나 제외하세요.
- 모든 설명은 한국어로 작성하세요.`;
}

export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

export function validateDeepPayload(raw: unknown, profile: DeepProfile, sourceCharCount: number, analyzedCharCount: number, chunkCount: number): DeepAnalysisPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const overview = typeof value.overview === "string" ? value.overview.trim().slice(0, 5000) : "";
  if (!overview) return null;
  const strings = (input: unknown, max: number, length: number): string[] => Array.isArray(input)
    ? input.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().slice(0, length)).slice(0, max)
    : [];
  const args = Array.isArray(value.arguments) ? value.arguments.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const claim = typeof (item as Record<string, unknown>).claim === "string" ? String((item as Record<string, unknown>).claim).trim().slice(0, 800) : "";
    if (!claim) return [];
    return [{ claim, evidence: strings((item as Record<string, unknown>).evidence, 4, 500) }];
  }).slice(0, 8) : [];
  return {
    profile,
    overview,
    arguments: args,
    structure: strings(value.structure, 8, 500),
    quotes: strings(value.quotes, 8, 500),
    connections: strings(value.connections, 8, 500),
    researchUses: strings(value.researchUses, 8, 500),
    limitations: strings(value.limitations, 8, 500),
    meta: { sourceCharCount, analyzedCharCount, chunkCount },
  };
}

export function keepVerbatimQuotes(payload: DeepAnalysisPayload, sourceText: string): DeepAnalysisPayload {
  const source = sourceText.replace(/\r\n?/g, "\n");
  return { ...payload, quotes: payload.quotes.filter((quote) => source.includes(quote)).slice(0, 8) };
}
