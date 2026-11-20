/**
 * The env var a frontend reads its backend's URL from, by framework.
 *
 * Each framework only exposes variables with its own prefix to browser code,
 * and inlines them at build time, so the name has to match the framework and
 * the value has to be on the Vercel project before it builds.
 *
 * | Framework                         | Key                   |
 * |-----------------------------------|-----------------------|
 * | nextjs                            | NEXT_PUBLIC_API_URL   |
 * | nuxt                              | NUXT_PUBLIC_API_URL   |
 * | astro, sveltekit                  | PUBLIC_API_URL        |
 * | react built with react-scripts    | REACT_APP_API_URL     |
 * | vite, vue, react (Vite)           | VITE_API_URL          |
 * | anything else                     | API_URL               |
 */
export function apiUrlKey(framework: string | null | undefined, buildCmd?: string | null): string {
  switch ((framework ?? "").trim().toLowerCase()) {
    case "nextjs":
    case "next":
      return "NEXT_PUBLIC_API_URL";
    case "nuxt":
      return "NUXT_PUBLIC_API_URL";
    case "astro":
    case "sveltekit":
      return "PUBLIC_API_URL";
    case "react":
      return /react-scripts|craco|react-app-rewired/.test(buildCmd ?? "") ? "REACT_APP_API_URL" : "VITE_API_URL";
    case "vite":
    case "vue":
      return "VITE_API_URL";
    default:
      return "API_URL";
  }
}
