import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Fastify's first boot is slow on a cold Windows run while other suites load.
    testTimeout: 20_000,
  },
});
