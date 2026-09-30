export type MobileTerminalKeyCombination = {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
};

const cursorKeys: Record<string, string> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
};
const functionKeys: Record<string, number> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
};
export const MOBILE_TERMINAL_CUSTOM_SPECIAL_KEYS = [
  "Space",
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  ...Object.keys(cursorKeys),
  "F1",
  "F2",
  "F3",
  "F4",
  ...Object.keys(functionKeys),
];
const supportedKeys = new Set(MOBILE_TERMINAL_CUSTOM_SPECIAL_KEYS);

/** Fixed xterm-style sequences, matching the mobile presets; no text or macros. */
export function mobileTerminalKeyCombinationBytes(value: unknown): number[] {
  if (!value || typeof value !== "object") return [];
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.key !== "string" ||
    (!/^[!-~]$/.test(raw.key) && !supportedKeys.has(raw.key)) ||
    [raw.ctrl, raw.alt, raw.shift].some(
      (modifier) => typeof modifier !== "boolean",
    ) ||
    Object.keys(raw).some(
      (key) => !["key", "ctrl", "alt", "shift"].includes(key),
    )
  )
    return [];
  const { key, ctrl, alt, shift } = raw as MobileTerminalKeyCombination;
  const modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  const suffix = modifier === 1 ? "" : `;${modifier}`;
  let sequence: string;
  if (cursorKeys[key]) {
    sequence = `\x1b[${modifier === 1 ? "" : `1${suffix}`}${cursorKeys[key]}`;
  } else if (/^F[1-4]$/.test(key)) {
    const final = "PQRS"[Number(key.slice(1)) - 1];
    sequence = modifier === 1 ? `\x1bO${final}` : `\x1b[1${suffix}${final}`;
  } else if (functionKeys[key]) {
    sequence = `\x1b[${functionKeys[key]}${suffix}~`;
  } else if (key === "Enter") {
    sequence = modifier === 1 ? "\r" : `\x1b[13${suffix}u`;
  } else {
    if (key === "Tab") {
      if (ctrl || alt) return [];
      sequence = shift ? "\x1b[Z" : "\t";
    } else if (key === "Escape") {
      if (ctrl || shift) return [];
      sequence = "\x1b";
    } else if (key === "Backspace") {
      if (shift) return [];
      sequence = ctrl ? "\b" : "\x7f";
    } else {
      sequence = key === "Space" ? " " : key;
      if (shift) {
        const index = "`1234567890-=[]\\;',./".indexOf(sequence);
        sequence =
          index >= 0 ? '~!@#$%^&*()_+{}|:"<>?'[index] : sequence.toUpperCase();
      }
      if (ctrl) {
        const code = sequence.toUpperCase().charCodeAt(0);
        if (code >= 0x40 && code <= 0x5f)
          sequence = String.fromCharCode(code - 0x40);
        else if (sequence === " " || sequence === "2") sequence = "\x00";
        else if (sequence === "/") sequence = "\x1f";
        else if (/^[3-7]$/.test(sequence))
          sequence = String.fromCharCode(Number(sequence) + 24);
        else if (sequence === "8" || sequence === "?") sequence = "\x7f";
        else return [];
      }
    }
    if (alt) sequence = `\x1b${sequence}`;
  }
  return Array.from(sequence, (character) => character.charCodeAt(0));
}

export function mobileTerminalKeyCombinationLabel({
  key,
  ctrl,
  alt,
  shift,
}: MobileTerminalKeyCombination): string {
  return [
    ctrl && "Ctrl",
    alt && "Alt",
    shift && "Shift",
    key.length === 1 && (ctrl || shift) ? key.toUpperCase() : key,
  ]
    .filter(Boolean)
    .join("+");
}
