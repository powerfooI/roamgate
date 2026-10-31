/**
 * The keys an agent's question takes in its chat card, as the terminal would
 * get them: what to send to the pane, "box" for a letter that belongs in the
 * message box, or null for a key the card leaves alone.
 */
export function promptKeyInput(
  event: {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
  },
  /** The cursor is on "Type something.": letters go to the message box. */
  typing: boolean,
): string | "box" | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowLeft":
      return "\x1b[D";
    case "ArrowRight":
      return "\x1b[C";
    case "Tab":
      return event.shiftKey ? "\x1b[Z" : "\t";
    case "Enter":
      return "\r";
    case "Escape":
      return "\x1b";
  }
  // The answer of one's own is written in the message box.
  if (typing) return event.key.length === 1 ? "box" : null;
  switch (event.key) {
    case "k":
      return "\x1b[A";
    case "j":
      return "\x1b[B";
    case "h":
      return "\x1b[D";
    case "l":
      return "\x1b[C";
    case " ":
      return " ";
  }
  return /^[1-9]$/.test(event.key) ? event.key : null;
}
