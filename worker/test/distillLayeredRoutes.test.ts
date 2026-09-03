import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import distill from "../src/routes/distill";

const app = new Hono<{ Bindings: Env }>();
app.route("/api/distill", distill);

async function seedLayeredSession() {
  const suffix = crypto.randomUUID();
  const sessionId = `distill-layered-${suffix}`;
  const activeSourceId = `layered-active-${suffix}`;
  const missingSourceId = `layered-missing-${suffix}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sources (id, kind, title, reliability, status, created_at, updated_at)
     VALUES (?, 'WEB', '현재 자료 제목', 'PRIMARY', 'indexed', ?, ?)`,
  ).bind(activeSourceId, now, now).run();

  const output = {
    keywords: ["사진"],
    thoughts_fragments: ["이미지는 절차로 발생한다"],
    questions: ["어떤 조건이 이미지를 발생시키는가?"],
    read_next: [],
    research_gaps: [],
    research_directions: [],
    artwork_directions: [],
    details: {
      thoughts: [{
        summaryIndex: 0,
        rationale: "자료의 제작 조건과 반복되는 관찰을 연결했다.",
        sourceIds: [activeSourceId, missingSourceId],
        uncertainty: "현장 기록이 더 필요하다.",
        nextCheck: "촬영 로그를 대조한다.",
      }],
      questions: [{
        summaryIndex: 0,
        whyNow: "현재 연구의 중심 질문으로 바로 이어진다.",
        method: "세 가지 제작 사례를 비교한다.",
        evidenceNeeded: "촬영·편집 로그와 출력물을 확인한다.",
        sourceIds: [activeSourceId],
      }],
      researchGaps: [],
      researchDirections: [],
      artworkDirections: [],
    },
  };

  await env.DB.prepare(
    `INSERT INTO distill_sessions (id, sources_used_json, output_json, created_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(
    sessionId,
    JSON.stringify([
      { id: activeSourceId, title: "스냅샷 제목" },
      { id: missingSourceId, title: "보존된 자료 제목" },
    ]),
    JSON.stringify(output),
    now,
  ).run();

  return { sessionId, activeSourceId, missingSourceId };
}

describe("layered Distill routes", () => {
  it("returns detail source availability alongside a session", async () => {
    const seeded = await seedLayeredSession();
    const response = await app.request(`/api/distill/sessions/${seeded.sessionId}`, undefined, env);

    expect(response.status).toBe(200);
    const body = await response.json() as {
      detailSources?: Array<{ id: string; title: string; available: boolean }>;
    };
    expect(body.detailSources).toEqual([
      { id: seeded.activeSourceId, title: "현재 자료 제목", available: true },
      { id: seeded.missingSourceId, title: "보존된 자료 제목", available: false },
    ]);
  });

  it("includes layered detail rationale and source labels in markdown export", async () => {
    const seeded = await seedLayeredSession();
    const response = await app.request(`/api/distill/sessions/${seeded.sessionId}/markdown`, undefined, env);

    expect(response.status).toBe(200);
    const markdown = await response.text();
    expect(markdown).toContain("## 상세 근거와 맥락");
    expect(markdown).toContain("### 생각의 조각 1");
    expect(markdown).toContain("근거: 자료의 제작 조건과 반복되는 관찰을 연결했다.");
    expect(markdown).toContain("불확실성: 현장 기록이 더 필요하다.");
    expect(markdown).toContain("출처: 스냅샷 제목, 보존된 자료 제목");
    expect(markdown).toContain("### 질문 1");
    expect(markdown).toContain("조사 방법: 세 가지 제작 사례를 비교한다.");
  });
});
