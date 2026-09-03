import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "cloudflare-workers-test-shim",
      resolveId(id) {
        return id === "cloudflare:workers" ? "\0cloudflare-workers-test-shim" : null;
      },
      load(id) {
        return id === "\0cloudflare-workers-test-shim" ? "export class WorkflowEntrypoint {}" : null;
      },
    },
  ],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    restoreMocks: true,
    exclude: ["**/node_modules/**", "tests/e2e/**"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
