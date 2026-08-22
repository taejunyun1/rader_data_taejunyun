import {
  normalizeDiscoveryKeywords,
  normalizeDiscoveryProfile,
  type DiscoveryProfile,
} from "@radar/shared/discovery";

export const DISCOVERY_PROFILE_KEY = "discovery_profile_v2";
const LEGACY_QUERIES_KEY = "discovery_queries_v1";

async function readKv(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function writeKv(db: D1Database, key: string, value: unknown): Promise<void> {
  await db.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(key, JSON.stringify(value), new Date().toISOString()).run();
}

export async function loadDiscoveryProfile(db: D1Database): Promise<DiscoveryProfile> {
  const stored = await readKv(db, DISCOVERY_PROFILE_KEY);
  if (stored) {
    try {
      return normalizeDiscoveryProfile(JSON.parse(stored));
    } catch {
      /* recover below */
    }
  }

  let legacyKeywords: string[] = [];
  const legacy = await readKv(db, LEGACY_QUERIES_KEY);
  if (legacy) {
    try {
      legacyKeywords = normalizeDiscoveryKeywords(JSON.parse(legacy));
    } catch {
      legacyKeywords = [];
    }
  }
  const profile = normalizeDiscoveryProfile({
    original: { keywords: legacyKeywords, strength: 70 },
    counter: { keywords: [], strength: 30 },
  });
  await writeKv(db, DISCOVERY_PROFILE_KEY, profile);
  return profile;
}

export async function saveDiscoveryProfile(db: D1Database, value: unknown): Promise<DiscoveryProfile> {
  const profile = normalizeDiscoveryProfile(value, new Date().toISOString());
  await writeKv(db, DISCOVERY_PROFILE_KEY, profile);
  return profile;
}
