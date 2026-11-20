import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // The integration services (and their shared library) have their own vitest configs.
    exclude: [
      "**/node_modules/**",
      "vercel_integration/**",
      "render_integration/**",
      "neondb_integration/**",
      "integration_common/**",
      "logs/**",
      "ai/**",
      // Files renamed xxx_* are superseded copies kept for review, not code.
      "**/xxx*",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
