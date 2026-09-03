import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      remoteBindings: false,
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        compatibilityDate: "2026-07-02",
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(__dirname, "migrations")),
        },
      },
    })),
  ],
  test: {
    include: ["test/aiCallSettlement.test.ts", "test/backfillDiscovery.test.ts", "test/bulkScale.test.ts", "test/jobDispatchConcurrency.test.ts", "test/requestBodyLimits.test.ts", "test/scheduledDispatch.test.ts", "test/sourceVersionIntegrity.test.ts", "src/discovery/recommendations.test.ts", "src/ingestion/dedup.test.ts", "src/ingestion/matching.test.ts", "src/ingestion/store.test.ts", "src/ingestion/versioning.test.ts", "src/radar/snapshot.test.ts", "src/reservoir/canonicalSource.test.ts", "src/reservoir/deleteSource.test.ts", "src/reservoir/deletionClaim.test.ts", "src/reservoir/mergeGroups.test.ts", "src/reservoir/refresh.test.ts", "src/routes/reservoir.test.ts", "src/distill/outputSchema.test.ts", "src/distill/prompts.test.ts", "src/distill/run.test.ts", "src/publication/contracts.test.ts", "src/publication/projection.test.ts", "src/publication/lease.test.ts", "src/publication/storage.test.ts", "src/publication/ledger.test.ts", "src/publication/service.test.ts", "test/homepagePublicationReconciliation.test.ts", "src/security/csrf.test.ts", "src/routes/homepagePublication.test.ts", "src/reservoir/publicationInterlock.test.ts", "src/publication/hardPurge.test.ts", "src/routes/operations.test.ts"],
    exclude: ["test/settingsBackfillRoute.test.ts"],
    setupFiles: ["./test/helpers/runtime.ts"],
    fileParallelism: false,
    maxConcurrency: 1,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
});
