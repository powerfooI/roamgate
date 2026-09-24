/** OSC 8 file URIs are local paths, never network/UNC shares or shell schemes. */
export function terminalFileUriPath(raw: string): string | null {
  if (
    !/^file:\/\//i.test(raw) ||
    raw !== raw.trim() ||
    /[?#\u0000-\u001f\u007f-\u009f]/.test(raw)
  )
    return null;
  try {
    const uri = new URL(raw);
    if (
      uri.protocol !== "file:" ||
      (uri.hostname && uri.hostname !== "localhost") ||
      uri.search ||
      uri.hash
    )
      return null;
    const path = decodeURIComponent(uri.pathname);
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /[\\\u0000-\u001f\u007f-\u009f]/.test(path)
    )
      return null;
    return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

const HTTP_URL_START_RE = /https?:\/\//gi;
const HTTP_URL_PREFIX_RE = /^https?:\/\//i;
const ASCII_URL_CHARACTER_RE = /^[A-Za-z0-9\-._~:/?#\x5b\x5d@!$&()*+,;=%]$/;
const UNICODE_URL_CHARACTER_RE = /^[\p{L}\p{N}\p{M}\p{S}]$/u;
const ASCII_TRAILING_PROSE_RE = /[.,;:!?]+$/;
const CLOSING_DELIMITERS: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
};
const OPENING_DELIMITERS = Object.fromEntries(
  Object.entries(CLOSING_DELIMITERS).map(([closing, opening]) => [
    opening,
    closing,
  ]),
) as Record<string, string>;

export type TerminalHttpLink = {
  url: string;
  start: number;
  end: number;
};

function isUrlCharacter(character: string): boolean {
  return character.charCodeAt(0) <= 0x7f
    ? ASCII_URL_CHARACTER_RE.test(character)
    : UNICODE_URL_CHARACTER_RE.test(character);
}

function firstUnclosedOpeningDelimiter(candidate: string): number | null {
  const openings: Array<{ character: string; index: number }> = [];
  for (let index = 0; index < candidate.length; index += 1) {
    const character = candidate[index] ?? "";
    if (OPENING_DELIMITERS[character]) {
      openings.push({ character, index });
      continue;
    }
    const expectedOpening = CLOSING_DELIMITERS[character];
    if (!expectedOpening) continue;
    const latestOpening = openings[openings.length - 1];
    if (latestOpening?.character === expectedOpening) openings.pop();
  }
  return openings[0]?.index ?? null;
}

function trimTrailingProse(candidate: string): string {
  let url = candidate;
  while (url) {
    const before = url;
    url = url.replace(ASCII_TRAILING_PROSE_RE, "");
    const closing = url[url.length - 1] ?? "";
    const opening = CLOSING_DELIMITERS[closing];
    if (opening) {
      const openingCount = Array.from(url).filter(
        (character) => character === opening,
      ).length;
      const closingCount = Array.from(url).filter(
        (character) => character === closing,
      ).length;
      if (closingCount > openingCount) url = url.slice(0, -1);
    }
    const unclosedOpening = firstUnclosedOpeningDelimiter(url);
    if (unclosedOpening !== null) url = url.slice(0, unclosedOpening);
    if (url === before) break;
  }
  return url;
}

export function sanitizeTerminalHttpUrl(raw: string): string | null {
  const input = raw.trimStart();
  const prefix = input.match(HTTP_URL_PREFIX_RE)?.[0];
  if (!prefix) return null;
  let candidate = prefix;
  for (const character of input.slice(prefix.length)) {
    if (!isUrlCharacter(character)) break;
    candidate += character;
  }
  const url = trimTrailingProse(candidate);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.hostname
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

// Return exact spans instead of one greedy regex match. This lets a URL keep
// Unicode path characters while stopping at Unicode prose punctuation and
// still finds another URL immediately after that delimiter.
export function findTerminalHttpLinks(text: string): TerminalHttpLink[] {
  const links: TerminalHttpLink[] = [];
  HTTP_URL_START_RE.lastIndex = 0;
  for (
    let match = HTTP_URL_START_RE.exec(text);
    match;
    match = HTTP_URL_START_RE.exec(text)
  ) {
    const start = match.index;
    const previous = text[start - 1];
    if (previous && /[A-Za-z0-9_]/.test(previous)) continue;
    const url = sanitizeTerminalHttpUrl(text.slice(start));
    if (!url) continue;
    const end = start + url.length;
    links.push({ url, start, end });
    HTTP_URL_START_RE.lastIndex = end;
  }
  return links;
}

type GestureEnvironment = {
  userActivation?: { readonly isActive: boolean } | null;
  open: (url: string, target: string, features: string) => unknown;
};

/**
 * Opens an already sanitized terminal URL from a touch gesture. Returns false
 * when the gesture no longer grants activation (e.g. after an async lookup),
 * so the caller can offer an explicit button instead of a blocked popup.
 * `noopener` hides whether a popup opened, so activation is checked first.
 */
export function openTerminalUrlFromGesture(
  url: string,
  env: GestureEnvironment = {
    userActivation:
      typeof navigator === "undefined" ? null : navigator.userActivation,
    open: (href, target, features) => window.open(href, target, features),
  },
): boolean {
  if (env.userActivation && !env.userActivation.isActive) return false;
  env.open(url, "_blank", "noopener,noreferrer");
  return true;
}
