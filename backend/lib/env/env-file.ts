/**
 * Parses the text of a .env file (Phase 9). Pure, and copied verbatim to
 * frontend/lib/deploy/env-file.ts for the "Paste .env" import: keep the two
 * copies identical.
 *
 * Supports `KEY=value`, `export KEY=value`, `# comments`, inline ` # comments`
 * after unquoted values, 'single-quoted' (literal) and "double-quoted" values
 * (with \n, \r, \t, \" and \\ escapes). Quoted values may span lines. A later
 * line with the same key wins, as with dotenv.
 */

export type DotenvEntry = { key: string; value: string };
export type DotenvSkip = { line: number; reason: string };

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseDotenv(text: string): { entries: DotenvEntry[]; skipped: DotenvSkip[] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const values = new Map<string, string>();
  const skipped: DotenvSkip[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();

    const eq = line.indexOf("=");
    if (eq <= 0) {
      skipped.push({ line: lineNo, reason: "no KEY=value" });
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!KEY.test(key)) {
      skipped.push({ line: lineNo, reason: `"${key.slice(0, 40)}" is not a valid name` });
      continue;
    }

    let rest = line.slice(eq + 1).trimStart();
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      // Collect until the closing quote, across lines if needed.
      let body = rest.slice(1);
      let end = closingQuote(body, quote);
      while (end < 0 && i + 1 < lines.length) {
        i++;
        body += "\n" + lines[i];
        end = closingQuote(body, quote);
      }
      if (end < 0) {
        skipped.push({ line: lineNo, reason: `${key}: the ${quote} quote is never closed` });
        continue;
      }
      const raw = body.slice(0, end);
      values.set(key, quote === '"' ? unescape(raw) : raw);
      continue;
    }

    // Unquoted: an inline comment starts at whitespace + #.
    const hash = rest.search(/\s#/);
    if (hash >= 0) rest = rest.slice(0, hash);
    values.set(key, rest.trim());
  }

  return { entries: [...values].map(([key, value]) => ({ key, value })), skipped };
}

function closingQuote(body: string, quote: string): number {
  for (let j = 0; j < body.length; j++) {
    if (quote === '"' && body[j] === "\\") {
      j++;
      continue;
    }
    if (body[j] === quote) return j;
  }
  return -1;
}

function unescape(raw: string): string {
  return raw.replace(/\\([nrt"\\])/g, (_, c: string) => ({ n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" })[c] ?? c);
}
