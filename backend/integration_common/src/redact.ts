/**
 * Removes secrets from text before it is written to a log file or streamed to
 * a browser.
 *
 * The build log is the single most likely place for a credential to escape: it
 * is captured from child processes we do not control, persisted to disk, and
 * served over SSE. Installation tokens in particular are short-lived but fully
 * privileged, and a tool that echoes its arguments on failure will happily put
 * one there.
 *
 * Defence in depth, not the primary control. The primary control is never
 * putting a secret on a command line in the first place - see
 * GithubAppService.openSourceTarball.
 */

const MASK = "***REDACTED***";

/**
 * GitHub token formats, as a backstop for secrets that never passed through
 * `extra`: ghs_ (installation), ghp_ (classic PAT), gho_/ghu_ (OAuth),
 * github_pat_ (fine-grained), and the legacy x-access-token URL form.
 */
const TOKEN_PATTERNS: RegExp[] = [
  /gh[psuo]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /x-access-token:[^@\s]+@/g,
  /Bearer\s+[A-Za-z0-9._-]{20,}/gi,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param text   the line to clean
 * @param extra  known literal secrets (the actual token this build is using)
 */
export function redact(text: string, extra: (string | undefined | null)[] = []): string {
  let out = text;

  // Literal values first: exact and cheap, and covers secrets whose shape is
  // not one we recognise (env var values, for instance).
  for (const secret of extra) {
    // Very short strings would mangle ordinary output, so ignore them.
    if (typeof secret === "string" && secret.length >= 8) {
      out = out.replace(new RegExp(escapeRegExp(secret), "g"), MASK);
    }
  }

  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, MASK);
  }

  return out;
}
