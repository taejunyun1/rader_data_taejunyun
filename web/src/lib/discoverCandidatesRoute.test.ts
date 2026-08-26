import { beforeEach, describe, expect, it, vi } from "vitest";

const { createSourceMock, enqueueResearchJobMock } = vi.hoisted(() => ({
  createSourceMock: vi.fn(),
  enqueueResearchJobMock: vi.fn(),
}));

vi.mock("../../../worker/src/ingestion/store", () => ({ createSource: createSourceMock }));
vi.mock("../../../worker/src/jobs/enqueue", () => ({ enqueueResearchJob: enqueueResearchJobMock }));

import discover from "../../../worker/src/routes/discover";

describe("discover candidate decision route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses the source and acquisition job when a kept candidate is submitted again", async () => {
    const state = {
      status: "CANDIDATE",
      sourceId: null as string | null,
      job: null as { id: string; status: string } | null,
    };
    const db = createCandidateDb(state);
    createSourceMock.mockResolvedValue({ sourceId: "source-1" });
    enqueueResearchJobMock.mockImplementation(async () => {
      state.job = { id: "job-1", status: "QUEUED" };
      return { job: { id: "job-1" }, reused: false };
    });

    const env = { DB: db } as unknown as Env;
    const first = await discover.request("http://localhost/candidates/candidate-1/keep", { method: "POST" }, env);
    const second = await discover.request("http://localhost/candidates/candidate-1/keep", { method: "POST" }, env);

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ sourceId: "source-1", jobId: "job-1", acquisitionStatus: "QUEUED" });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ sourceId: "source-1", jobId: "job-1", acquisitionStatus: "QUEUED" });
    expect(createSourceMock).toHaveBeenCalledTimes(1);
    expect(enqueueResearchJobMock).toHaveBeenCalledTimes(1);
    expect(state.sourceId).toBe("source-1");
  });
});

function createCandidateDb(state: { status: string; sourceId: string | null; job: { id: string; status: string } | null }): D1Database {
  return {
    prepare(query: string) {
      let bindings: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          bindings = values;
          return this;
        },
        async first<T = Record<string, unknown>>() {
          if (query.startsWith("SELECT id, openalex_id")) {
            return {
              id: "candidate-1",
              openalex_id: "https://arxiv.org/abs/1234.5678",
              title: "자료 후보",
              authors: "저자",
              year: 2026,
              status: state.status,
              provider: "arxiv",
              external_url: "https://arxiv.org/pdf/1234.5678.pdf",
              access_status: "PDF",
              source_id: state.sourceId,
            } as T;
          }
          if (query.includes("FROM research_jobs")) return state.job as T;
          return null;
        },
        async run() {
          if (query.startsWith("UPDATE discovery_candidates SET status")) state.status = String(bindings[0]);
          if (query.startsWith("UPDATE discovery_candidates SET source_id")) state.sourceId = String(bindings[0]);
          return { meta: { changes: 1 } };
        },
      } as D1PreparedStatement;
    },
  } as D1Database;
}
