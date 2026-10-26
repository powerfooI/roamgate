import { marked, type MarkedToken, type Token, type Tokens } from "marked";

// These are presentation limits, not attempts to summarize technical content.
const MAX_TABLE_ROWS = 12;
const MAX_TABLE_COLUMNS = 6;
const MAX_TABLE_CELL = 160;

function spokenText(text: string, decodeEntities = true): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  const decoded = decodeEntities
    ? text
        // Marked already decodes valid numeric references in text tokens.
        .replace(/&#(?:x[\da-f]+|\d+);/gi, " ")
        .replace(
          /&(amp|lt|gt|quot|apos|nbsp);/gi,
          (_, name: string) => entities[name.toLowerCase()]!,
        )
    : text;
  // Only omit long ASCII values; prose in other languages may have no spaces.
  return decoded
    .replace(/https?:\/\/[^\s<>]+/gi, (url) => {
      try {
        return `link to ${new URL(url).hostname}`;
      } catch {
        return "link";
      }
    })
    .replace(/\b[\da-f]{24,}\b/gi, "long hash omitted")
    .replace(/[!-~]{100,}/g, "long value omitted")
    .replace(/([^\s])\1{9,}/gu, "$1 repeated")
    .replace(/[\t ]+/g, " ");
}

function inline(tokens: Token[]): string {
  return tokens.map(tokenToSpeech).join("");
}

function tokenToSpeech(value: Token): string {
  // This lexer has no custom extensions; Generic tokens are not produced.
  const token = value as MarkedToken;
  switch (token.type) {
    case "escape":
    case "codespan":
      return spokenText(token.text, false);
    case "text":
      return token.tokens ? inline(token.tokens) : spokenText(token.text);
    case "heading":
    case "paragraph":
    case "strong":
    case "em":
    case "del":
    case "link":
      return inline(token.tokens);
    case "image": {
      const description = inline(token.tokens).trim();
      return description ? `Image: ${description}.` : "";
    }
    case "br":
      return "\n";
    case "blockquote":
      return blocks(token.tokens);
    case "list":
      return token.items
        .map((item, index) => {
          const prefix = item.task
            ? item.checked
              ? "Completed. "
              : "Not completed. "
            : token.ordered
              ? `${Number(token.start) + index}. `
              : "";
          return prefix + blocks(item.tokens);
        })
        .join("\n\n");
    case "code": {
      const language = token.lang?.split(/\s+/)[0] ?? "";
      if (language.toLowerCase() === "mermaid")
        return "Mermaid diagram omitted.";
      return `${language ? `${spokenText(language)} code` : "Code"} block omitted.`;
    }
    case "table":
      return table(token);
    // Raw HTML, separators, and reference definitions have no spoken content.
    default:
      return "";
  }
}

function table(token: Tokens.Table): string {
  const cells = [token.header, ...token.rows];
  if (
    token.rows.length > MAX_TABLE_ROWS ||
    token.header.length > MAX_TABLE_COLUMNS ||
    cells.some((row) =>
      row.some((cell) => cell.text.length > MAX_TABLE_CELL),
    ) ||
    cells.flat().reduce((size, cell) => size + cell.text.length, 0) > 2000
  ) {
    return "Table omitted.";
  }
  const headers = token.header.map((cell) => inline(cell.tokens).trim());
  return [
    "Table.",
    ...token.rows.map((row) =>
      row
        .map((cell, index) => {
          const value = inline(cell.tokens).trim();
          return headers[index]
            ? `${headers[index]}: ${value || "empty"}.`
            : `${value || "empty"}.`;
        })
        .join(" "),
    ),
  ].join("\n\n");
}

function blocks(tokens: Token[]): string {
  return tokens
    .map(tokenToSpeech)
    .filter((text) => text.trim())
    .join("\n\n");
}

function omitRepeatedLines(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  for (let index = 0; index < lines.length; ) {
    const line = lines[index]!;
    let end = index + 1;
    while (line.trim() && lines[end] === line) end += 1;
    const count = end - index;
    if (count >= 4)
      result.push(line, `Repeated line omitted ${count - 1} times.`);
    else result.push(...lines.slice(index, end));
    index = end;
  }
  return result.join("\n");
}

/** Deterministic, DOM-free speech formatting using the renderer's Markdown parser. */
export function markdownToSpeech(markdown: string): string {
  return omitRepeatedLines(
    blocks(marked.lexer(markdown, { gfm: true, breaks: true })),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Bound utterances, preferring paragraphs, sentences, then word boundaries. */
export function chunkSpeech(text: string, limit = 240): string[] {
  if (!Number.isInteger(limit) || limit < 2)
    throw new Error("Invalid speech chunk limit");
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const prefix = rest.slice(0, limit);
    const paragraphs = prefix.lastIndexOf("\n\n");
    const sentences = [...prefix.matchAll(/[.!?](?:\s|$)/g)];
    let end =
      paragraphs > 0 ? paragraphs : sentences[sentences.length - 1]?.index;
    if (paragraphs <= 0 && end !== undefined) end += 1;
    if (!end) end = prefix.lastIndexOf(" ");
    if (end <= 0) {
      end = limit;
      // Do not split a UTF-16 surrogate pair.
      if (/[\uD800-\uDBFF]/.test(rest[end - 1]!)) end -= 1;
    }
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
