import { describe, expect, it, vi } from "vitest";
import {
  planBulkDistill,
  runBoundedParallel,
  runBulkDistillSimulation,
  type BulkSource,
} from "../src/distill/bulkTest";

const sources: BulkSource[] = [
  {
    id: "source-a",
    versionId: "version-a",
    title: "사진의 물질성",
    kind: "PAPER_ACADEMIC",
    text: ["첫 번째 문단의 원문입니다.", "두 번째 문단은 인쇄와 노동을 연결합니다.", "세 번째 문단은 기계비전의 한계를 묻습니다."].join("\n\n"),
  },
  {
    id: "source-b",
    versionId: "version-b",
    title: "이미지와 데이터",
    kind: "NOTE",
    text: "짧은 메모지만 출처 연결을 유지해야 합니다.",
  },
];

describe("Bulk Distill scale harness", () => {
  it("splits sources into bounded chunks without losing provenance", () => {
    const plan = planBulkDistill(sources, {
      targetChunkTokens: 8,
      includeCounter: false,
      capUsd: 3,
      monthRemainingUsd: 10,
    });

    expect(plan.blocked).toBe(false);
    expect(plan.chunks.length).toBeGreaterThan(2);
    expect(plan.chunks.every((chunk) => chunk.sourceId && chunk.versionId && chunk.text.length > 0)).toBe(true);
    expect(new Set(plan.chunks.map((chunk) => chunk.sourceId))).toEqual(new Set(["source-a", "source-b"]));
    expect(plan.stages.find((stage) => stage.kind === "MAP")?.count).toBe(plan.chunks.length);
  });

  it("reserves the worst-case cost before a run and blocks over-cap work", () => {
    const plan = planBulkDistill(sources, {
      targetChunkTokens: 4,
      includeCounter: true,
      capUsd: 0.000001,
      monthRemainingUsd: 10,
    });

    expect(plan.blocked).toBe(true);
    expect(plan.blockReason).toBe("CAP_EXCEEDED");
    expect(plan.reserveUsd).toBeGreaterThan(plan.capUsd);
  });

  it("uses a monthly budget guard in addition to the per-run cap", () => {
    const plan = planBulkDistill(sources, {
      targetChunkTokens: 4,
      includeCounter: true,
      capUsd: 3,
      monthRemainingUsd: 0.000001,
    });

    expect(plan.blocked).toBe(true);
    expect(plan.blockReason).toBe("MONTHLY_BUDGET_EXCEEDED");
  });

  it("never exceeds the configured parallelism and preserves result order", async () => {
    let active = 0;
    let maxActive = 0;
    const result = await runBoundedParallel([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, value % 2 === 0 ? 2 : 0));
      active -= 1;
      return value * 10;
    });

    expect(maxActive).toBeLessThanOrEqual(3);
    expect(result).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it("reuses completed map artifacts and records actual usage", async () => {
    const calls: string[] = [];
    const executor = {
      call: vi.fn(async (request: { stage: string; artifactKey: string }) => {
        calls.push(request.artifactKey);
        return { outputRef: `${request.stage}:${request.artifactKey}`, costUsd: 0.0001 };
      }),
    };
    const options = {
      targetChunkTokens: 12,
      includeCounter: false,
      capUsd: 3,
      monthRemainingUsd: 10,
      concurrency: 2,
    } as const;

    const first = await runBulkDistillSimulation(sources, options, executor);
    const second = await runBulkDistillSimulation(sources, options, executor, first.cache);

    expect(first.status).toBe("SUCCEEDED");
    expect(first.actualCostUsd).toBeGreaterThan(0);
    expect(first.maxConcurrency).toBeLessThanOrEqual(2);
    expect(second.cacheHits).toBeGreaterThan(0);
    expect(second.actualCostUsd).toBeLessThan(first.actualCostUsd);
    expect(calls.length).toBeGreaterThan(0);
  });
});
