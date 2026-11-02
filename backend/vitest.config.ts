import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // The integration services are separate services with their own vitest configs.
    exclude: ["**/node_modules/**", "vercel_integration/**", "render_integration/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
