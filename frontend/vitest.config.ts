import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
  },
  resolve: {
    // Mirrors the "@/*" path in tsconfig.json. Without it any test whose import
    // graph reaches an aliased module fails to resolve, which is what kept
    // mock-provider.test.ts red.
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
