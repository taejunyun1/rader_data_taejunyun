export const PUBLICATION_LEASE_MS = 60_000;
export const PUBLICATION_RENEW_MS = 15_000;
export const PUBLICATION_LEASE_SAFETY_MS = 5_000;

export interface PublicationLease {
  ownerToken: string;
  generation: number;
  expiresAtMs: number;
}

export interface PublicationLeaseBackend {
  acquire(): Promise<PublicationLease>;
  renew(lease: PublicationLease): Promise<PublicationLease>;
  assertOwned(lease: PublicationLease): Promise<void>;
  release(lease: PublicationLease): Promise<boolean>;
}

export interface PublicationLeaseTimerClock {
  monotonicNowMs(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface PublicationLeaseController {
  currentLease(): PublicationLease;
  checkpoint(): Promise<PublicationLease>;
  stop(): Promise<void>;
}

type LeaseRow = {
  owner_token: string | null;
  generation: number;
  expires_at_ms: number | null;
};

function mapLease(row: LeaseRow | null): PublicationLease | null {
  if (!row || typeof row.owner_token !== "string" || row.expires_at_ms === null) return null;
  return { ownerToken: row.owner_token, generation: Number(row.generation), expiresAtMs: Number(row.expires_at_ms) };
}

function lostError(): Error {
  return new Error("publication_lease_lost");
}

/**
 * The production backend deliberately takes no caller time. Every comparison
 * is made by SQLite in the same statement that mutates the singleton row.
 */
export function createD1PublicationLeaseBackend(db: D1Database): PublicationLeaseBackend {
  // Some local D1/SQLite builds predate the `subsec` modifier. Keep the
  // statement-local clock while providing a millisecond fallback so NULL can
  // never turn a successful acquisition into an immediately expired lease.
  const nowMs = "COALESCE(CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER))";
  const nowIso = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  async function read(ownerToken?: string, generation?: number): Promise<PublicationLease | null> {
    const row = await db.prepare("SELECT owner_token, generation, expires_at_ms FROM homepage_publication_lease WHERE lock_name = 'homepage-current-research'").first<LeaseRow>();
    const lease = mapLease(row);
    if (!lease || (ownerToken !== undefined && (lease.ownerToken !== ownerToken || (generation !== undefined && lease.generation !== generation)))) return null;
    return lease;
  }
  return {
    async acquire() {
      const ownerToken = crypto.randomUUID();
      const result = await db.prepare(`
        WITH clock(now_ms) AS (SELECT ${nowMs})
        UPDATE homepage_publication_lease
        SET owner_token = ?, generation = generation + 1,
            expires_at_ms = (SELECT now_ms + ${PUBLICATION_LEASE_MS} FROM clock),
            updated_at = ${nowIso}
        WHERE lock_name = 'homepage-current-research'
          AND (owner_token IS NULL OR expires_at_ms <= (SELECT now_ms FROM clock))
      `).bind(ownerToken).run();
      if (!result.meta.changes) throw new Error("publication_in_progress");
      const lease = await read(ownerToken);
      if (!lease) throw lostError();
      return lease;
    },
    async renew(lease) {
      const result = await db.prepare(`
        WITH clock(now_ms) AS (SELECT ${nowMs})
        UPDATE homepage_publication_lease
        SET expires_at_ms = (SELECT now_ms + ${PUBLICATION_LEASE_MS} FROM clock), updated_at = ${nowIso}
        WHERE lock_name = 'homepage-current-research'
          AND owner_token = ? AND generation = ?
          AND expires_at_ms > (SELECT now_ms FROM clock)
      `).bind(lease.ownerToken, lease.generation).run();
      if (!result.meta.changes) throw lostError();
      const renewed = await read(lease.ownerToken, lease.generation);
      if (!renewed) throw lostError();
      return renewed;
    },
    async assertOwned(lease) {
      const result = await db.prepare(`
        WITH clock(now_ms) AS (SELECT ${nowMs})
        UPDATE homepage_publication_lease SET updated_at = updated_at
        WHERE lock_name = 'homepage-current-research'
          AND owner_token = ? AND generation = ?
          AND expires_at_ms > (SELECT now_ms FROM clock)
      `).bind(lease.ownerToken, lease.generation).run();
      if (!result.meta.changes) throw lostError();
    },
    async release(lease) {
      const result = await db.prepare(`
        WITH clock(now_ms) AS (SELECT ${nowMs})
        UPDATE homepage_publication_lease
        SET owner_token = NULL, expires_at_ms = NULL, updated_at = ${nowIso}
        WHERE lock_name = 'homepage-current-research'
          AND owner_token = ? AND generation = ?
          AND expires_at_ms > (SELECT now_ms FROM clock)
      `).bind(lease.ownerToken, lease.generation).run();
      return Boolean(result.meta.changes);
    },
  };
}

const realClock: PublicationLeaseTimerClock = {
  monotonicNowMs: () => typeof performance !== "undefined" ? performance.now() : Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export async function acquirePublicationLeaseController(
  backend: PublicationLeaseBackend,
  clock: PublicationLeaseTimerClock = realClock,
): Promise<PublicationLeaseController> {
  const dispatchStarted = clock.monotonicNowMs();
  let lease = await backend.acquire();
  let deadline = dispatchStarted + PUBLICATION_LEASE_MS;
  if (deadline - clock.monotonicNowMs() <= PUBLICATION_LEASE_SAFETY_MS) {
    const renewStarted = clock.monotonicNowMs();
    lease = await backend.renew(lease);
    deadline = renewStarted + PUBLICATION_LEASE_MS;
    if (deadline - clock.monotonicNowMs() <= PUBLICATION_LEASE_SAFETY_MS) throw lostError();
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let renewal: Promise<void> | null = null;
  let nextDue = dispatchStarted + PUBLICATION_RENEW_MS;

  const renewNow = async (): Promise<void> => {
    if (renewal) return renewal;
    renewal = (async () => {
      const started = clock.monotonicNowMs();
      lease = await backend.renew(lease);
      deadline = started + PUBLICATION_LEASE_MS;
      nextDue += PUBLICATION_RENEW_MS;
      if (deadline - clock.monotonicNowMs() <= PUBLICATION_LEASE_SAFETY_MS) throw lostError();
    })().finally(() => { renewal = null; });
    return renewal;
  };

  const schedule = (): void => {
    if (stopped) return;
    if (timer) clock.clearTimeout(timer);
    const delay = Math.max(0, nextDue - clock.monotonicNowMs());
    timer = clock.setTimeout(() => {
      timer = null;
      void (async () => {
        try {
          while (!stopped && clock.monotonicNowMs() >= nextDue) await renewNow();
          schedule();
        } catch {
          // The next checkpoint observes the failed horizon. Avoid unhandled
          // timer rejections while keeping the controller fail-closed.
          stopped = true;
        }
      })();
    }, delay);
  };
  schedule();

  return {
    currentLease: () => lease,
    async checkpoint() {
      if (stopped) throw lostError();
      if (renewal) await renewal;
      if (deadline - clock.monotonicNowMs() <= PUBLICATION_LEASE_SAFETY_MS) await renewNow();
      await backend.assertOwned(lease);
      if (deadline - clock.monotonicNowMs() <= PUBLICATION_LEASE_SAFETY_MS) {
        await renewNow();
        await backend.assertOwned(lease);
      }
      return lease;
    },
    async stop() {
      stopped = true;
      if (timer) { clock.clearTimeout(timer); timer = null; }
      if (renewal) await renewal;
    },
  };
}
