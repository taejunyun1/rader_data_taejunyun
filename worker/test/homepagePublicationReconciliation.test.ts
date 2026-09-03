import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { acquirePublicationLeaseController, createD1PublicationLeaseBackend } from "../src/publication/lease";
import { reconcileHomepagePublications } from "../src/operations/reconcileHomepagePublications";

describe("homepage publication reconciliation", () => {
  it("reports a live publication lease as busy without failing the hourly operation", async () => {
    const backend = createD1PublicationLeaseBackend(env.DB);
    const controller = await acquirePublicationLeaseController(backend);
    try {
      await expect(reconcileHomepagePublications(env)).resolves.toEqual({ scanned: 0, repaired: 0, failed: 0, busy: true });
    } finally {
      await controller.stop();
      await backend.release(controller.currentLease());
    }
  });
});
