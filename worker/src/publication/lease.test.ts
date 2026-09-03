import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  PUBLICATION_LEASE_MS,
  PUBLICATION_RENEW_MS,
  acquirePublicationLeaseController,
  createD1PublicationLeaseBackend,
  type PublicationLease,
  type PublicationLeaseBackend,
  type PublicationLeaseTimerClock,
} from "./lease";

describe("publication lease", () => {
  it("acquires, rejects a live owner, and releases conditionally", async () => {
    const backend = createD1PublicationLeaseBackend(env.DB);
    const first = await backend.acquire();
    expect(first.generation).toBeGreaterThan(0);
    await expect(backend.acquire()).rejects.toThrow("publication_in_progress");
    expect(await backend.release(first)).toBe(true);
    expect(await backend.release(first)).toBe(false);
  });

  it("renews only the current owner and generation", async () => {
    const backend = createD1PublicationLeaseBackend(env.DB);
    const lease = await backend.acquire();
    const renewed = await backend.renew(lease);
    expect(renewed.generation).toBe(lease.generation);
    await expect(backend.assertOwned({ ...lease, generation: lease.generation + 1 })).rejects.toThrow("publication_lease_lost");
    await backend.release(renewed);
  });

  it("keeps one serialized timer and stops without releasing", async () => {
    let now = 0;
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const clock: PublicationLeaseTimerClock = {
      monotonicNowMs: () => now,
      setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id as unknown as ReturnType<typeof setTimeout>; },
      clearTimeout: (handle) => { timers.delete(handle as unknown as number); },
    };
    let renewals = 0;
    const lease: PublicationLease = { ownerToken: "owner", generation: 1, expiresAtMs: PUBLICATION_LEASE_MS };
    const backend: PublicationLeaseBackend = {
      acquire: async () => lease,
      renew: async () => { renewals += 1; return { ...lease, expiresAtMs: now + PUBLICATION_LEASE_MS }; },
      assertOwned: async () => undefined,
      release: async () => { throw new Error("must not release"); },
    };
    const controller = await acquirePublicationLeaseController(backend, clock);
    expect(timers.size).toBe(1);
    now = PUBLICATION_RENEW_MS;
    const callback = [...timers.values()][0]!;
    timers.clear();
    callback();
    await Promise.resolve();
    expect(renewals).toBe(1);
    await controller.stop();
    expect(timers.size).toBe(0);
  });
});
