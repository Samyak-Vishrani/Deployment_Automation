/**
 * Our framework ids (backend/lib/analysis/build-settings.ts) → Vercel framework
 * presets. A preset tells Vercel which builder to use and what its default
 * commands and output folder are.
 *
 * null means "Other": Vercel auto-detects, and our build/output settings are
 * all it has to go on. Run `npm run spike` to confirm Vercel still accepts
 * every preset here (it rejects an unknown slug on project create).
 */

const PRESETS: Record<string, string> = {
  nextjs: "nextjs",
  next: "nextjs",
  nuxt: "nuxtjs",
  nuxtjs: "nuxtjs",
  vite: "vite",
  vue: "vue",
  sveltekit: "sveltekit-1",
  astro: "astro",
  angular: "angular",
  gatsby: "gatsby",
  remix: "remix",
};

export function vercelFramework(framework: string | null, outputDir: string | null): string | null {
  const id = framework?.trim().toLowerCase();
  if (!id) return null;
  if (id === "react") {
    // React has no preset of its own; its bundler does. Create React App builds
    // to build/, Vite to dist/ - the analysis already derived outputDir from that.
    return outputDir?.replace(/\/+$/, "") === "build" ? "create-react-app" : "vite";
  }
  return PRESETS[id] ?? null;
}

/** Frameworks whose Vercel builder owns the output folder; setting one breaks the build. */
export const BUILDER_OWNS_OUTPUT: ReadonlySet<string> = new Set(["nextjs", "nuxtjs", "sveltekit-1", "remix"]);
