import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect } from "vitest";

type RuntimeTestEnv = Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const runtimeEnv = env as RuntimeTestEnv;

beforeAll(async () => {
  await applyD1Migrations(runtimeEnv.DB, runtimeEnv.TEST_MIGRATIONS);

  const sourcesTable = await runtimeEnv.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sources'",
  ).first<{ name: string }>();
  expect(sourcesTable?.name).toBe("sources");

  const probeKey = "tests/runtime/probe.txt";
  await runtimeEnv.ORIGINALS.put(probeKey, "ok");
  const probe = await runtimeEnv.ORIGINALS.get(probeKey);
  expect(await probe?.text()).toBe("ok");

  const publicationProbeKey = "tests/runtime/publications-probe.txt";
  await runtimeEnv.PUBLICATIONS.put(publicationProbeKey, "ok");
  const publicationProbe = await runtimeEnv.PUBLICATIONS.get(publicationProbeKey);
  expect(await publicationProbe?.text()).toBe("ok");
});
