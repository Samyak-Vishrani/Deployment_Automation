/**
 * Turns the cause of a failed Render deploy, found in its last log lines,
 * into one sentence of advice. Render's own status says only "build_failed"
 * or "update_failed"; the reason is in the log.
 */

const HINTS: Array<[RegExp, string]> = [
  [
    /no open ports? (were )?detected|port scan timeout/i,
    "Render found no open port. Your server must listen on process.env.PORT (Render sets it to 10000), on host 0.0.0.0.",
  ],
  [
    /could not (read|access|clone|find) (the )?(repo|repository)|repository not found|permission denied \(publickey\)/i,
    "Render cannot read the repository. Connect Render to GitHub (dashboard.render.com → Account Settings → Git) and give it access to this repo.",
  ],
  [
    /cannot find module|module not found|err_module_not_found/i,
    "A module is missing at runtime. Check that the build command builds the app and the start command runs the built output.",
  ],
  [
    /command not found|is not recognized as an internal or external command/i,
    "A command in the build or start command does not exist on Render. Check both commands on the Configure screen.",
  ],
  [
    /out of memory|javascript heap out of memory|exited with code 137/i,
    "The service ran out of memory. Free instances have 512 MB; reduce memory use or choose a bigger plan.",
  ],
];

export function hintFor(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const [pattern, hint] of HINTS) {
      if (pattern.test(lines[i])) return hint;
    }
  }
  return null;
}

/** Render's status in words, for the failure message. */
export function describeFailure(status: string): string {
  switch (status) {
    case "build_failed":
      return "The Render build failed.";
    case "update_failed":
      return "The Render build succeeded but the service did not start.";
    case "pre_deploy_failed":
      return "The Render pre-deploy command failed.";
    default:
      return `The Render deploy failed (${status || "unknown status"}).`;
  }
}

/** Accepts only an https *.onrender.com origin with no credentials in it. */
export function safeServiceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".onrender.com") && !url.username && !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
