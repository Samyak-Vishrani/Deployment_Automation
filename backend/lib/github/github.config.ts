/**
 * GitHub App configuration, read and validated from the environment.
 * Nothing here is ever sent to the frontend.
 *
 * Two things are deliberately absent:
 *
 * - OAuth (clientId / clientSecret / sessionSecret). The push-to-deploy
 *   pipeline is installation-scoped; repository OAuth belongs to the
 *   "Connect GitHub" flow and lives with the GitHubConnection model.
 * - A per-repository callback URL. A GitHub App has ONE webhook URL, set on the
 *   App itself, that receives events for every installed repository. There are
 *   no per-repo hooks to create, point anywhere, or clean up.
 */

export interface GithubConfig {
  appId: string;
  privateKey: string;
  /**
   * The App-level webhook secret. This is typed into the GitHub App settings
   * page; the backend only ever verifies against it, and never transmits it.
   */
  webhookSecret: string;
  /** URL slug of the app: https://github.com/apps/<slug> */
  appSlug: string;
  /**
   * Optional. When unset, the installation is resolved per repository, which
   * is the right default once the App is installed in more than one place.
   */
  installationId?: string;
}

export class MissingEnvError extends Error {
  constructor(missing: string[]) {
    super(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        "Copy .env.example to backend/.env and fill it in.",
    );
    this.name = "MissingEnvError";
  }
}

/**
 * .env files cannot hold real newlines, so private keys are usually stored with
 * literal "\n" sequences (and sometimes wrapped in quotes). Normalise both.
 */
function normalisePrivateKey(value: string): string {
  let key = value.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  // The pattern matches a literal backslash followed by "n" - the two-character
  // sequence a .env file stores - and replaces it with a real newline. Writing
  // /\n/g here instead would match an actual newline and be a silent no-op,
  // leaving the PEM on one line so that signing fails with the distinctly
  // unhelpful "DECODER routines::unsupported".
  return key.replace(/\\n/g, "\n").trim() + "\n";
}

export function loadGithubConfig(env: NodeJS.ProcessEnv = process.env): GithubConfig {
  const required = [
    "GITHUB_APP_ID",
    "GITHUB_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "GITHUB_APP_SLUG",
  ];
  const missing = required.filter((name) => !env[name] || env[name]!.trim() === "");
  if (missing.length > 0) {
    throw new MissingEnvError(missing);
  }

  const privateKey = normalisePrivateKey(env.GITHUB_PRIVATE_KEY!);
  if (!privateKey.includes("BEGIN") || !privateKey.includes("PRIVATE KEY")) {
    throw new Error(
      "GITHUB_PRIVATE_KEY does not look like a PEM private key. It must contain the full " +
        '"-----BEGIN RSA PRIVATE KEY----- ... -----END RSA PRIVATE KEY-----" block.',
    );
  }

  const installationId = env.GITHUB_INSTALLATION_ID?.trim();
  if (installationId && !/^\d+$/.test(installationId)) {
    throw new Error("GITHUB_INSTALLATION_ID must be a number.");
  }

  return {
    appId: env.GITHUB_APP_ID!.trim(),
    privateKey,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET!,
    appSlug: env.GITHUB_APP_SLUG!.trim(),
    installationId: installationId || undefined,
  };
}
