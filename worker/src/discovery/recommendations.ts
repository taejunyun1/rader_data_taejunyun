import {
  isUsableDiscoveryQuery,
  normalizeDiscoveryTitle,
  normalizeDiscoveryKeywords,
  type DiscoveryKeywordRecommendation,
  type DiscoveryLane,
  type DiscoveryProfile,
  type DiscoveryRecommendationSource,
} from "@radar/shared/discovery";

export type CandidateRecommendation = Omit<DiscoveryKeywordRecommendation, "selected">;

const recommendationSourceOrder: DiscoveryRecommendationSource[] = [
  "SAVED",
  "MOMENTUM",
  "DISTILL",
  "RESEARCH_GAP",
  "UNDERREPRESENTED",
  "COUNTER",
];

function cleanKeyword(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const keyword = normalizeDiscoveryKeywords([value], 1)[0];
  return keyword && isUsableDiscoveryQuery(keyword) ? keyword : null;
}

function addRecommendation(
  list: CandidateRecommendation[],
  value: unknown,
  lane: DiscoveryLane,
  source: DiscoveryRecommendationSource,
  score: number,
  reason: string,
): void {
  const keyword = cleanKeyword(value);
  if (!keyword) return;
  list.push({ keyword, lane, source, score, reason });
}

function compareCandidates(a: CandidateRecommendation, b: CandidateRecommendation): number {
  return b.score - a.score
    || a.keyword.localeCompare(b.keyword)
    || recommendationSourceOrder.indexOf(a.source) - recommendationSourceOrder.indexOf(b.source);
}

export function diversifyRecommendations(items: CandidateRecommendation[], selected: string[]): DiscoveryKeywordRecommendation[] {
  const best = new Map<string, CandidateRecommendation>();
  for (const item of items) {
    const key = normalizeDiscoveryTitle(item.keyword);
    const previous = best.get(key);
    if (!previous || compareCandidates(item, previous) < 0) best.set(key, item);
  }

  const bySource = new Map<DiscoveryRecommendationSource, CandidateRecommendation[]>();
  for (const item of best.values()) {
    const sourceItems = bySource.get(item.source) ?? [];
    sourceItems.push(item);
    bySource.set(item.source, sourceItems);
  }
  for (const sourceItems of bySource.values()) sourceItems.sort(compareCandidates);

  const offsets = new Map<DiscoveryRecommendationSource, number>();
  const diversified: CandidateRecommendation[] = [];
  while (diversified.length < 8) {
    let added = false;
    for (const source of recommendationSourceOrder) {
      const sourceItems = bySource.get(source) ?? [];
      const offset = offsets.get(source) ?? 0;
      if (offset >= sourceItems.length) continue;
      const item = sourceItems[offset];
      if (!item) continue;
      diversified.push(item);
      offsets.set(source, offset + 1);
      added = true;
      if (diversified.length === 8) break;
    }
    if (!added) break;
  }

  const selectedKeywords = new Set(selected.map(normalizeDiscoveryTitle));
  return diversified.map((item) => ({ ...item, selected: selectedKeywords.has(normalizeDiscoveryTitle(item.keyword)) }));
}

function finalize(list: CandidateRecommendation[], selected: string[]): DiscoveryKeywordRecommendation[] {
  return diversifyRecommendations(list, selected);
}

function parse(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function recentKeywords(db: D1Database): Promise<string[]> {
  const rows = await db.prepare(
    `SELECT keyword, COUNT(*) AS n FROM keywords
     WHERE created_at >= datetime('now', '-30 days')
     GROUP BY keyword ORDER BY n DESC, keyword ASC LIMIT 8`
  ).all<{ keyword: string }>();
  return (rows.results ?? []).map((row) => row.keyword);
}

async function homepageKeywords(db: D1Database): Promise<string[]> {
  const rows = await db.prepare(
    `SELECT k.keyword, COUNT(*) AS n FROM keywords k
     JOIN sources s ON s.id = k.source_id
     WHERE s.origin = 'homepage'
     GROUP BY k.keyword ORDER BY n DESC, k.keyword ASC LIMIT 6`
  ).all<{ keyword: string }>();
  return (rows.results ?? []).map((row) => row.keyword);
}

export async function buildDiscoveryRecommendations(
  db: D1Database,
  profile: DiscoveryProfile,
): Promise<{ original: DiscoveryKeywordRecommendation[]; counter: DiscoveryKeywordRecommendation[] }> {
  const original: CandidateRecommendation[] = [];
  const counter: CandidateRecommendation[] = [];

  for (const keyword of profile.original.keywords) addRecommendation(original, keyword, "ORIGINAL", "SAVED", 1, "저장한 검색어");
  for (const keyword of profile.counter.keywords) addRecommendation(counter, keyword, "COUNTER", "COUNTER", 1, "저장한 카운터 검색어");

  const [momentum, homepage, distillRows, gaps, sources] = await Promise.all([
    recentKeywords(db),
    homepageKeywords(db),
    db.prepare("SELECT output_json, counter_output_json, critic_output_json FROM distill_sessions ORDER BY created_at DESC LIMIT 8").all<{ output_json: string | null; counter_output_json: string | null; critic_output_json: string | null }>(),
    db.prepare("SELECT gap_text FROM research_gaps ORDER BY created_at DESC LIMIT 8").all<{ gap_text: string }>(),
    db.prepare("SELECT topics FROM sources WHERE topics IS NOT NULL ORDER BY created_at DESC LIMIT 500").all<{ topics: string }>(),
  ]);

  for (const keyword of momentum) addRecommendation(original, keyword, "ORIGINAL", "MOMENTUM", 0.8, "최근 30일 자료에서 증가한 키워드");
  for (const keyword of homepage) addRecommendation(original, keyword, "ORIGINAL", "MOMENTUM", 0.75, "홈페이지 읽기 자료에서 반복된 키워드");
  for (const gap of gaps.results ?? []) addRecommendation(original, gap.gap_text, "ORIGINAL", "RESEARCH_GAP", 0.8, "최근 착즙에서 남은 연구 공백");

  const topicCounts = new Map<string, number>();
  for (const source of sources.results ?? []) {
    try {
      const topics = JSON.parse(source.topics) as unknown;
      if (Array.isArray(topics)) for (const topic of topics) {
        if (typeof topic === "string") topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
      }
    } catch {
      /* ignore malformed topic metadata */
    }
  }
  for (const [topic, count] of [...topicCounts.entries()].sort((a, b) => a[1] - b[1]).slice(0, 8)) {
    addRecommendation(counter, topic, "COUNTER", "UNDERREPRESENTED", 0.6, `저장소에서 상대적으로 적게 다뤄진 주제 · ${count}개 자료`);
  }

  for (const row of distillRows.results ?? []) {
    const output = parse(row.output_json);
    for (const keyword of Array.isArray(output?.keywords) ? output.keywords : []) {
      addRecommendation(original, keyword, "ORIGINAL", "DISTILL", 0.9, "최근 착즙에서 추출된 키워드");
    }
    const counterOutput = parse(row.counter_output_json);
    const validation = counterOutput?.validation && typeof counterOutput.validation === "object" ? counterOutput.validation as Record<string, unknown> : null;
    const validationStatus = validation?.status;
    if (validationStatus === "verified" || validationStatus === "corrected") {
      addRecommendation(counter, counterOutput?.opposing_thesis, "COUNTER", "COUNTER", 0.9, "검증된 반대 명제");
      const axes = Array.isArray(counterOutput?.axes) ? counterOutput.axes : [];
      for (const axis of axes) {
        if (!axis || typeof axis !== "object") continue;
        addRecommendation(counter, (axis as Record<string, unknown>).to, "COUNTER", "COUNTER", 0.9, "검증된 반대 축");
      }
      const suggestions = Array.isArray(counterOutput?.suggestions) ? counterOutput.suggestions : [];
      for (const suggestion of suggestions) {
        if (!suggestion || typeof suggestion !== "object") continue;
        addRecommendation(counter, (suggestion as Record<string, unknown>).direction, "COUNTER", "COUNTER", 0.9, "검증된 카운터 방향");
      }
    }
    const critic = parse(row.critic_output_json);
    const warnings = Array.isArray(critic?.warnings) ? critic.warnings : [];
    for (const warning of warnings) {
      if (!warning || typeof warning !== "object") continue;
      addRecommendation(counter, (warning as Record<string, unknown>).note, "COUNTER", "COUNTER", 0.75, "비평에서 지적된 편향 또는 취약점");
    }
  }

  return {
    original: finalize(original, profile.original.keywords),
    counter: finalize(counter, profile.counter.keywords),
  };
}
