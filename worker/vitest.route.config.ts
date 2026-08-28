import { defineConfig } from "vitest/config";

const cloudflareWorkersShim = {
  name: "cloudflare-workers-test-shim",
  resolveId(id: string) {
    return id === "cloudflare:workers" ? "\0cloudflare-workers-test-shim" : null;
  },
  load(id: string) {
    return id === "\0cloudflare-workers-test-shim" ? "export class WorkflowEntrypoint {}" : null;
  },
};

export default defineConfig({
  plugins: [cloudflareWorkersShim],
  test: {
    include: ["test/settingsBackfillRoute.test.ts", "test/requestBodyLimits.test.ts"],
    environment: "node",
    restoreMocks: true,
  },
});
