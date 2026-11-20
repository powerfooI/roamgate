/**
 * Whether a message the user typed is written in Markdown: a code fence,
 * inline code, a link, a list, or emphasis set off by spaces. Plain text,
 * and text that only happens to hold Markdown's characters (an `_` or a
 * `*` in a path, a word or a sum), shows as typed.
 */
const SIGNS = [
  // A code fence.
  /^ {0,3}(?:```|~~~)/m,
  // Inline code.
  /`[^`\n]+`/,
  // A link.
  /\[[^\]\n]+\]\([^)\s]+\)/,
  // A list item.
  /^ {0,3}(?:[-*+]|\d{1,3}[.)]) +\S/m,
  // Strong emphasis, or emphasis between spaces (not inside a word or path).
  /(?:^|[\s([{])(\*\*|__)(?=\S)[^\n]*?\S\1(?=$|[\s)\]}.,;:!?])/m,
  /(?:^|[\s([{])([*_])(?=[^\s*_])[^\n*_]*[^\s*_]\1(?=$|[\s)\]}.,;:!?])/m,
];

export function looksLikeMarkdown(text: string): boolean {
  return SIGNS.some((sign) => sign.test(text));
}
