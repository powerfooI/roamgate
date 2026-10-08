import { matchesShortcut, type ShortcutBindings } from "./shortcutBindings";
type TerminalKeyEvent = Pick<
  KeyboardEvent,
  | "type"
  | "key"
  | "code"
  | "keyCode"
  | "shiftKey"
  | "altKey"
  | "ctrlKey"
  | "metaKey"
  | "isComposing"
> &
  Partial<Pick<KeyboardEvent, "getModifierState">>;

function isCompositionEvent(event: TerminalKeyEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** Configured terminal actions emit the same protocol bytes as the built-ins. */
export function terminalShortcutSequence(
  event: TerminalKeyEvent,
  bindings: ShortcutBindings,
): string | null {
  if (event.type !== "keydown" || isCompositionEvent(event)) return null;
  const sequences = {
    "terminal.multiline": "\x1b[13;2u",
    "terminal.altEnter": "\x1b[13;3u",
    "terminal.ctrlEnter": "\x1b[13;5u",
    "terminal.lineStart": "\x01",
    "terminal.lineEnd": "\x05",
    "terminal.deleteToStart": "\x15",
  } as const;
  for (const id of Object.keys(sequences) as (keyof typeof sequences)[]) {
    if (matchesShortcut(event, id, bindings)) return sequences[id];
  }
  return null;
}

/** Preserve keys whose identity is lost in xterm's legacy control bytes. */
export function terminalDisambiguatedKeySequence(
  event: TerminalKeyEvent,
  applePlatform = false,
): string | null {
  if (event.type !== "keydown" || isCompositionEvent(event) || event.metaKey)
    return null;
  // Option produces text on Apple platforms. AltGr can also produce text on
  // international layouts; never turn those characters into terminal commands.
  if (event.altKey && (applePlatform || event.getModifierState?.("AltGraph")))
    return null;
  const modifier =
    1 +
    (event.shiftKey ? 1 : 0) +
    (event.altKey ? 2 : 0) +
    (event.ctrlKey ? 4 : 0);
  if (modifier === 1) return null;
  let codepoint: number | null = null;
  if (event.key === "Enter") codepoint = 13;
  else if (event.key === "Backspace" && event.ctrlKey) codepoint = 127;
  else if (event.key === "Escape" && event.altKey) codepoint = 27;
  else if (
    (event.key === "PageUp" || event.key === "PageDown") &&
    event.altKey &&
    !event.shiftKey
  ) {
    return `\x1b[${event.key === "PageUp" ? 5 : 6};${modifier}~`;
  } else if (
    // Ctrl+/ otherwise becomes Ctrl+_. Ctrl+Alt punctuation drops Control,
    // and Ctrl+Shift letters lose Shift (or produce no input at all).
    (event.ctrlKey && event.key === "/") ||
    (event.ctrlKey &&
      event.altKey &&
      /^[ -~]$/.test(event.key) &&
      !/^[a-z0-9]$/i.test(event.key)) ||
    (event.ctrlKey && event.shiftKey && /^[a-z]$/i.test(event.key)) ||
    // ESC+[ and ESC+O are ambiguous incomplete CSI/SS3 prefixes; they can
    // consume the next ordinary key rather than send the intended Alt chord.
    (event.altKey && !event.ctrlKey && (event.key === "[" || event.key === "O"))
  ) {
    codepoint = event.key.charCodeAt(0);
  }
  return codepoint === null ? null : `\x1b[${codepoint};${modifier}u`;
}
