import { beforeEach, describe, expect, it, vi } from "vitest";

const backfillDiscoverySources = vi.hoisted(() => vi.fn());

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
vi.mock("../src/ingestion/backfillDiscovery", () => ({ backfillDiscoverySources }));

import worker from "../src/index";

beforeEach(() => {
  backfillDiscoverySources.mockReset();
  backfillDiscoverySources.mockResolvedValue({ selected: 3, enqueued: 2, skipped: 1, errors: 0 });
});

describe("POST /api/settings/backfill-discovery", () => {
  it("is protected by the API access middleware", async () => {
    const response = await worker.fetch(
      new Request("https://radar.example/api/settings/backfill-discovery", { method: "POST" }),
      {
        ENVIRONMENT: "production",
        ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
        ACCESS_AUD: "audience",
      } as never,
    );

    expect(response.status).toBe(401);
    expect(backfillDiscoverySources).not.toHaveBeenCalled();
  });

  it("enqueues at most 10 sources and returns explicit counts", async () => {
    const env = { ENVIRONMENT: "development" } as never;
    const response = await worker.fetch(
      new Request("https://radar.example/api/settings/backfill-discovery", {
        method: "POST",
        headers: { "CF-Access-Authenticated-User-Email": "operator@example.com" },
      }),
      env,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ selected: 3, enqueued: 2, skipped: 1, errors: 0 });
    expect(backfillDiscoverySources).toHaveBeenCalledWith(env, "operator@example.com", 10);
  });
});
