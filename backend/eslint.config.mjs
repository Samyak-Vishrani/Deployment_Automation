import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([
    ".next/**",
    "node_modules/**",
    "coverage/**",
    "data/**",
    // A separate service with its own toolchain.
    "vercel_integration/**",
    "render_integration/**",
    "next-env.d.ts",
  ]),
  {
    // test/e2e-push.js is run by plain `node`, outside the Next.js build, so it
    // has to be CommonJS. The TypeScript-oriented rules below do not apply to
    // it, and forcing ESM here would only mean adding a build step to a script
    // whose whole point is having none.
    files: ["test/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
]);
