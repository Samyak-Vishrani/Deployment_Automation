/**
 * Terminal colour and cursor codes, as Render's app logs carry them
 * ("ESC[32m==>ESC(B ESC[m Running 'npm start'"). The viewer is not a
 * terminal, and search and error matching need plain text.
 */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(
  [
    `${ESC}\\[[0-9;?]*[ -/]*[@-~]`, // CSI: colours, cursor moves
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, // OSC: titles, links
    `${ESC}[()][A-Za-z0-9]`, // character set selection, e.g. ESC(B
    `${ESC}[=>78MDEc]`, // single-character controls
  ].join("|"),
  "g",
);

export function stripAnsi(text: string): string {
  return text.includes(ESC) ? text.replace(ANSI, "") : text;
}
