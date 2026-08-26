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

  it.each([
    ["a failed", { id: "job-failed", status: "FAILED" }],
    ["a blocked", { id: "job-blocked", status: "BLOCKED" }],
    ["a missing", null],
  ] as const)("re-enqueues acquisition for a persisted source with %s job", async (_label, existingJob) => {
    const state = {
      status: "KEPT",
      sourceId: "source-1",
      job: existingJob,
    };
    const db = createCandidateDb(state);
    enqueueResearchJobMock.mockImplementation(async () => {
      state.job = { id: "job-recovered", status: "QUEUED" };
      return { job: { id: "job-recovered" }, reused: false };
    });

    const response = await discover.request(
      "http://localhost/candidates/candidate-1/keep",
      { method: "POST" },
      { DB: db } as unknown as Env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ sourceId: "source-1", jobId: "job-recovered", acquisitionStatus: "QUEUED" });
    expect(createSourceMock).not.toHaveBeenCalled();
    expect(enqueueResearchJobMock).toHaveBeenCalledTimes(1);
    expect(enqueueResearchJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ DB: db }),
      { kind: "SOURCE_ACQUISITION", input: { sourceId: "source-1", url: "https://arxiv.org/pdf/1234.5678.pdf" } },
      "local",
    );
  });

  it("returns link-only when a persisted source has no recoverable acquisition URL", async () => {
    const state = {
      status: "KEPT",
      sourceId: "source-1",
      job: { id: "job-failed", status: "FAILED" },
      provider: "manual",
      openalexId: null,
      externalUrl: null,
    };

    const response = await discover.request(
      "http://localhost/candidates/candidate-1/keep",
      { method: "POST" },
      { DB: createCandidateDb(state) } as unknown as Env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ sourceId: "source-1", acquisitionStatus: "LINK_ONLY" });
    expect(createSourceMock).not.toHaveBeenCalled();
    expect(enqueueResearchJobMock).not.toHaveBeenCalled();
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

  it("reuses a succeeded acquisition without enqueueing again", async () => {
    const state = {
      status: "KEPT",
      sourceId: "source-1",
      job: { id: "job-succeeded", status: "SUCCEEDED" },
    };

    const response = await discover.request(
      "http://localhost/candidates/candidate-1/keep",
      { method: "POST" },
      { DB: createCandidateDb(state) } as unknown as Env,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ sourceId: "source-1", jobId: "job-succeeded" });
    expect(body).not.toHaveProperty("acquisitionStatus");
    expect(enqueueResearchJobMock).not.toHaveBeenCalled();
  });
});

function createCandidateDb(state: { status: string; sourceId: string | null; job: { id: string; status: string } | null; provider?: string; openalexId?: string | null; externalUrl?: string | null }): D1Database {
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
              openalex_id: state.openalexId === undefined ? "https://arxiv.org/abs/1234.5678" : state.openalexId,
              title: "자료 후보",
              authors: "저자",
              year: 2026,
              status: state.status,
              provider: state.provider ?? "arxiv",
              external_url: state.externalUrl === undefined ? "https://arxiv.org/pdf/1234.5678.pdf" : state.externalUrl,
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
