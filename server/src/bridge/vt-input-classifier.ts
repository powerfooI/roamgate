import { BinWriter } from "./bincode";

// Classifies browser VT input bytes (what xterm.js emits from key events)
// into Herdr's stable semantic pane-input events, and encodes them as
// ClientShellPaneInput frames for the endpoint path.
//
// ponytail: covers the common key space — printable text, Enter/Backspace/
// Tab, arrows, Home/End/Insert/Delete/PageUp/PageDown, F1-F12, Ctrl+letter,
// Alt+char, modified CSI keys, bracketed paste and SGR cell mouse reports.
// Basic CSI-u disambiguates printable ASCII and common modified keys; full
// Kitty keyboard protocol extensions and pixel mouse are not supported.

// crossterm KeyModifiers bits used on the wire.
export const MOD_SHIFT = 0x1;
export const MOD_CONTROL = 0x2;
export const MOD_ALT = 0x4;
export const MOD_SUPER = 0x8;

// ClientKeyCode variant indices (frozen wire order).
export const KEY = {
  Backspace: 0,
  Enter: 1,
  Left: 2,
  Right: 3,
  Up: 4,
  Down: 5,
  Home: 6,
  End: 7,
  PageUp: 8,
  PageDown: 9,
  Tab: 10,
  BackTab: 11,
  Delete: 12,
  Insert: 13,
  Esc: 14,
  Char: 15,
  F: 16,
  Null: 17,
} as const;

// Herdr v0.9.0 src/protocol/wire.rs (endpoint generation 1 frozen order).
export const MOUSE_KIND = {
  Down: 0,
  Up: 1,
  Drag: 2,
  Moved: 3,
  ScrollUp: 4,
  ScrollDown: 5,
  ScrollLeft: 6,
  ScrollRight: 7,
} as const;

export type PaneMouseEvent = {
  type: "mouse";
  kind: number;
  button?: number; // ClientMouseButton: Left=0, Right=1, Middle=2
  column: number; // zero-based, relative to the cropped pane content
  row: number;
  modifiers: number;
  lines: number;
};

export type PaneInputEvent =
  | PaneMouseEvent
  | {
      type: "key";
      code: number;
      char?: number; // codepoint for KEY.Char
      fn?: number; // number for KEY.F
      modifiers: number;
      generatedText?: string;
    }
  | { type: "text"; text: string }
  | { type: "paste"; text: string };

/** Encode events as one ClientShellPaneInput frame payload (variant 13). */
export function encodePaneInput(
  paneId: string,
  events: PaneInputEvent[],
): Buffer {
  const w = new BinWriter();
  w.variant(13); // ClientMessage::ClientShellPaneInput
  w.string(paneId);
  w.varint(events.length);
  for (const e of events) {
    if (e.type === "key") {
      w.variant(0); // ClientPaneInputEvent::Key
      w.variant(e.code);
      if (e.code === KEY.Char) w.varint(e.char ?? 0);
      if (e.code === KEY.F) w.varint(e.fn ?? 1);
      w.u8(e.modifiers);
      w.variant(0); // ClientKeyKind::Press
      w.varint(1); // repeat_count
      w.bool(false); // shifted_codepoint: None
      if (e.generatedText !== undefined) {
        w.bool(true);
        w.string(e.generatedText);
      } else {
        w.bool(false);
      }
      w.bool(false); // tracks_release
      w.bool(false); // physical_key_id: None
      w.bool(false); // windows_record: None
    } else if (e.type === "mouse") {
      w.variant(2); // ClientPaneInputEvent::Mouse
      w.variant(e.kind);
      if (e.kind <= MOUSE_KIND.Drag) w.variant(e.button!);
      w.variant(0); // ClientMousePosition::Cell
      w.varint(e.column);
      w.varint(e.row);
      w.bool(false); // geometry: None (only needed for pixels)
      w.u8(e.modifiers);
      w.varint(e.lines);
    } else if (e.type === "text") {
      w.variant(1); // ClientPaneInputEvent::TextCommit
      w.string(e.text);
    } else {
      w.variant(3); // ClientPaneInputEvent::Paste
      w.string(e.text);
    }
  }
  return w.toBuffer();
}

function key(
  code: number,
  opts: {
    char?: number;
    fn?: number;
    modifiers?: number;
    generatedText?: string;
  } = {},
): PaneInputEvent {
  return {
    type: "key",
    code,
    char: opts.char,
    fn: opts.fn,
    modifiers: opts.modifiers ?? 0,
    generatedText: opts.generatedText,
  };
}

const CSI_FINALS: Record<string, number> = {
  A: KEY.Up,
  B: KEY.Down,
  C: KEY.Right,
  D: KEY.Left,
  H: KEY.Home,
  F: KEY.End,
  Z: KEY.BackTab,
};

const CSI_FN_FINALS: Record<string, number> = {
  P: 1,
  Q: 2,
  R: 3,
  S: 4,
};

const CSI_TILDE_KEYS: Record<number, number> = {
  1: KEY.Home,
  2: KEY.Insert,
  3: KEY.Delete,
  4: KEY.End,
  5: KEY.PageUp,
  6: KEY.PageDown,
  7: KEY.Home,
  8: KEY.End,
};

const CSI_TILDE_FN: Record<number, number> = {
  11: 1,
  12: 2,
  13: 3,
  14: 4,
  15: 5,
  17: 6,
  18: 7,
  19: 8,
  20: 9,
  21: 10,
  23: 11,
  24: 12,
};

const SS3_KEYS: Record<string, PaneInputEvent> = {
  A: key(KEY.Up),
  B: key(KEY.Down),
  C: key(KEY.Right),
  D: key(KEY.Left),
  H: key(KEY.Home),
  F: key(KEY.End),
  P: key(KEY.F, { fn: 1 }),
  Q: key(KEY.F, { fn: 2 }),
  R: key(KEY.F, { fn: 3 }),
  S: key(KEY.F, { fn: 4 }),
};

/** xterm modifier param (1+bits: shift=1, alt=2, ctrl=4, super=8) → crossterm bits. */
function xtermModifiers(param: number): number {
  const bits = Math.max(0, param - 1);
  let mods = 0;
  if (bits & 1) mods |= MOD_SHIFT;
  if (bits & 2) mods |= MOD_ALT;
  if (bits & 4) mods |= MOD_CONTROL;
  if (bits & 8) mods |= MOD_SUPER;
  return mods;
}

/** Control byte 0x00-0x1f → key event, or null when handled elsewhere. */
function controlByteKey(b: number): PaneInputEvent | null {
  if (b === 0x0d) return key(KEY.Enter);
  if (b === 0x09) return key(KEY.Tab);
  if (b === 0x7f) return key(KEY.Backspace);
  if (b === 0x08) return key(KEY.Char, { char: 0x68, modifiers: MOD_CONTROL }); // ctrl+h
  if (b >= 0x01 && b <= 0x1a) {
    return key(KEY.Char, {
      char: 0x60 + b, // ctrl+a .. ctrl+z
      modifiers: MOD_CONTROL,
    });
  }
  if (b === 0x00) {
    return key(KEY.Char, { char: 0x20, modifiers: MOD_CONTROL }); // ctrl+space
  }
  // 0x1c-0x1f: ctrl+\ ctrl+] ctrl+^ ctrl+_
  if (b >= 0x1c && b <= 0x1f) {
    const chars = [0x5c, 0x5d, 0x5e, 0x5f];
    return key(KEY.Char, {
      char: chars[b - 0x1c],
      modifiers: MOD_CONTROL,
    });
  }
  return null;
}

function utf8Length(first: number): number {
  if (first < 0x80) return 1;
  if (first >= 0xf0) return 4;
  if (first >= 0xe0) return 3;
  if (first >= 0xc0) return 2;
  return 1; // stray continuation byte; treat as single
}

const PASTE_START = Buffer.from("\x1b[200~");
const PASTE_END = Buffer.from("\x1b[201~");

export class VtInputClassifier {
  private pending = Buffer.alloc(0);

  /** Feed one browser input chunk; returns complete events. */
  feed(chunk: Buffer): PaneInputEvent[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const events: PaneInputEvent[] = [];
    let text = "";
    const flushText = () => {
      if (text) {
        events.push({ type: "text", text });
        text = "";
      }
    };

    let i = 0;
    const buf = this.pending;
    while (i < buf.length) {
      const b = buf[i];

      if (b === 0x1b) {
        // Bracketed paste?
        if (matchesAt(buf, i, PASTE_START)) {
          const end = buf.indexOf(PASTE_END, i + PASTE_START.length);
          if (end === -1) break; // wait for the rest of the paste
          flushText();
          events.push({
            type: "paste",
            text: buf.subarray(i + PASTE_START.length, end).toString("utf8"),
          });
          i = end + PASTE_END.length;
          continue;
        }
        const parsed = this.parseEscape(buf, i);
        if (parsed === null) break; // incomplete; wait for more bytes
        flushText();
        for (const e of parsed.events) events.push(e);
        i = parsed.next;
        continue;
      }

      if (b < 0x20 || b === 0x7f) {
        const ev = controlByteKey(b);
        if (ev) {
          flushText();
          events.push(ev);
        }
        i++;
        continue;
      }

      const len = utf8Length(b);
      if (i + len > buf.length) break; // incomplete UTF-8 char
      text += buf.toString("utf8", i, i + len);
      i += len;
    }

    flushText();
    this.pending = buf.subarray(i);
    return events;
  }

  /** Flush a lone ESC as the Esc key (call after a short idle timeout). */
  flush(): PaneInputEvent[] {
    if (this.pending.length === 1 && this.pending[0] === 0x1b) {
      this.pending = Buffer.alloc(0);
      return [key(KEY.Esc)];
    }
    return [];
  }

  /**
   * Parse one escape sequence at buf[i] (buf[i] === 0x1b).
   * Returns null when the sequence is incomplete.
   */
  private parseEscape(
    buf: Buffer,
    i: number,
  ): { events: PaneInputEvent[]; next: number } | null {
    if (i + 1 >= buf.length) return null; // lone ESC so far
    const second = buf[i + 1];

    if (second === 0x5b && buf[i + 2] === 0x3c) {
      // Keep malformed SGR mouse fields out of the text/key path too. A new
      // ESC cancels a truncated report and is reprocessed independently.
      let j = i + 3;
      while (j < buf.length && (buf[j] < 0x40 || buf[j] > 0x7e)) {
        if (buf[j] === 0x1b) return { events: [], next: j };
        j++;
      }
      if (j >= buf.length) return null;
      const event = parseSgrMouse(
        buf.toString("utf8", i + 2, j),
        String.fromCharCode(buf[j]),
      );
      return { events: event ? [event] : [], next: j + 1 };
    }

    if (second === 0x5b) {
      // CSI: ESC [ params final
      let j = i + 2;
      while (j < buf.length && buf[j] >= 0x30 && buf[j] <= 0x3f) j++;
      if (j >= buf.length) return null;
      const final = String.fromCharCode(buf[j]);
      if (buf[j] < 0x40 || buf[j] > 0x7e) {
        // Not a valid CSI final; drop the ESC.
        return { events: [key(KEY.Esc)], next: i + 1 };
      }
      const params = buf
        .toString("ascii", i + 2, j)
        .split(";")
        .map((p) => (p === "" ? 1 : Number(p)));
      const next = j + 1;
      if (final === "~") {
        const n = params[0] ?? 1;
        const mods = xtermModifiers(params[1] ?? 1);
        if (n in CSI_TILDE_KEYS) {
          return {
            events: [key(CSI_TILDE_KEYS[n], { modifiers: mods })],
            next,
          };
        }
        if (n in CSI_TILDE_FN) {
          return {
            events: [key(KEY.F, { fn: CSI_TILDE_FN[n], modifiers: mods })],
            next,
          };
        }
        return { events: [], next }; // unknown ~ sequence: swallow
      }
      if (final in CSI_FINALS) {
        const mods = xtermModifiers(params[1] ?? 1);
        return { events: [key(CSI_FINALS[final], { modifiers: mods })], next };
      }
      if (final in CSI_FN_FINALS && params[0] === 1) {
        const mods = xtermModifiers(params[1] ?? 1);
        return {
          events: [
            key(KEY.F, {
              fn: CSI_FN_FINALS[final],
              modifiers: mods,
            }),
          ],
          next,
        };
      }
      // TerminalView and custom mobile keys use basic CSI-u where legacy
      // control bytes lose key identity or modifiers. Keep this bounded to
      // the supported named keys and printable ASCII, not full Kitty events.
      if (final === "u" && params.length <= 2) {
        const codepoint = params[0];
        const modifierParam = params[1] ?? 1;
        const namedKeys: Record<number, number> = {
          9: KEY.Tab,
          13: KEY.Enter,
          27: KEY.Esc,
          127: KEY.Backspace,
        };
        if (
          Number.isSafeInteger(codepoint) &&
          (codepoint in namedKeys || (codepoint >= 32 && codepoint <= 126)) &&
          Number.isSafeInteger(modifierParam) &&
          modifierParam >= 1 &&
          modifierParam <= 16
        ) {
          return {
            events: [
              key(namedKeys[codepoint] ?? KEY.Char, {
                ...(codepoint in namedKeys ? {} : { char: codepoint }),
                modifiers: xtermModifiers(modifierParam),
              }),
            ],
            next,
          };
        }
      }
      return { events: [], next }; // unknown CSI: swallow
    }

    if (second === 0x4f) {
      // SS3: ESC O final
      if (i + 2 >= buf.length) return null;
      const final = String.fromCharCode(buf[i + 2]);
      const ev = SS3_KEYS[final];
      return { events: ev ? [ev] : [], next: i + 3 };
    }

    if (second === 0x1b) {
      // Two ESCs: first is a real Esc, reprocess the second.
      return { events: [key(KEY.Esc)], next: i + 1 };
    }

    // ESC + printable char → Alt+char.
    const len = utf8Length(second);
    if (i + 1 + len > buf.length) return null;
    if (second >= 0x20 && second !== 0x7f) {
      const ch = buf.toString("utf8", i + 1, i + 1 + len);
      return {
        events: [
          key(KEY.Char, {
            char: ch.codePointAt(0)!,
            modifiers: MOD_ALT,
          }),
        ],
        next: i + 1 + len,
      };
    }
    // xterm represents Alt+Backspace and Alt+Ctrl combinations by prefixing
    // the ordinary control byte with ESC, just as it does for printable chars.
    const controlEvent = controlByteKey(second);
    if (controlEvent?.type === "key") {
      return {
        events: [
          {
            ...controlEvent,
            modifiers: controlEvent.modifiers | MOD_ALT,
          },
        ],
        next: i + 2,
      };
    }
    return { events: [key(KEY.Esc)], next: i + 1 };
  }
}

/** SGR is explicitly negotiated by the endpoint frontend; coordinates are cells. */
function parseSgrMouse(params: string, final: string): PaneMouseEvent | null {
  if ((final !== "M" && final !== "m") || !/^<\d+;\d+;\d+$/.test(params)) {
    return null;
  }
  const [code, x, y] = params.slice(1).split(";").map(Number);
  if (
    !Number.isInteger(code) ||
    code < 0 ||
    code > 127 ||
    !Number.isInteger(x) ||
    x < 1 ||
    x > 65536 ||
    !Number.isInteger(y) ||
    y < 1 ||
    y > 65536
  )
    return null;
  const button = code & 3;
  const motion = (code & 32) !== 0;
  const wheel = (code & 64) !== 0;
  // Wheel releases, wheel motion and anonymous button releases are not SGR events.
  if (
    (wheel && (motion || final === "m")) ||
    (!wheel && ((motion && final === "m") || (!motion && button === 3)))
  ) {
    return null;
  }
  let modifiers = 0;
  if (code & 4) modifiers |= MOD_SHIFT;
  if (code & 8) modifiers |= MOD_ALT;
  if (code & 16) modifiers |= MOD_CONTROL;
  const kind = wheel
    ? MOUSE_KIND.ScrollUp + button
    : motion
      ? button === 3
        ? MOUSE_KIND.Moved
        : MOUSE_KIND.Drag
      : final === "m"
        ? MOUSE_KIND.Up
        : MOUSE_KIND.Down;
  return {
    type: "mouse",
    kind,
    ...(kind <= MOUSE_KIND.Drag ? { button: [0, 2, 1][button] } : {}),
    column: x - 1,
    row: y - 1,
    modifiers,
    lines: 1,
  };
}

function matchesAt(buf: Buffer, offset: number, needle: Buffer): boolean {
  if (offset + needle.length > buf.length) return false;
  for (let k = 0; k < needle.length; k++) {
    if (buf[offset + k] !== needle[k]) return false;
  }
  return true;
}
