import { describe, expect, test } from "bun:test";
import { terminalDisambiguatedKeySequence } from "../../../web/src/terminalKeys";
import {
  KEY,
  MOD_ALT,
  MOD_CONTROL,
  MOD_SHIFT,
  VtInputClassifier,
} from "./vt-input-classifier";

type KeyEvent = Parameters<typeof terminalDisambiguatedKeySequence>[0];
function event(key: string, changes: Partial<KeyEvent> = {}): KeyEvent {
  return {
    type: "keydown",
    key,
    code: key,
    keyCode: 0,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    ...changes,
  };
}

describe("hardware terminal key round trips", () => {
  test("preserves ambiguous keys and modifiers all the way to pane input", () => {
    const cases: [KeyEvent, number, number | undefined, number][] = [
      [event("/", { ctrlKey: true }), KEY.Char, 47, MOD_CONTROL],
      [
        event("/", { ctrlKey: true, altKey: true }),
        KEY.Char,
        47,
        MOD_CONTROL | MOD_ALT,
      ],
      [
        event("Backspace", { ctrlKey: true }),
        KEY.Backspace,
        undefined,
        MOD_CONTROL,
      ],
      [
        event("Backspace", { ctrlKey: true, altKey: true }),
        KEY.Backspace,
        undefined,
        MOD_CONTROL | MOD_ALT,
      ],
      [
        event("Backspace", { ctrlKey: true, shiftKey: true }),
        KEY.Backspace,
        undefined,
        MOD_CONTROL | MOD_SHIFT,
      ],
      [
        event("Enter", { ctrlKey: true, shiftKey: true }),
        KEY.Enter,
        undefined,
        MOD_CONTROL | MOD_SHIFT,
      ],
      [
        event("Enter", { ctrlKey: true, altKey: true, shiftKey: true }),
        KEY.Enter,
        undefined,
        MOD_CONTROL | MOD_ALT | MOD_SHIFT,
      ],
      [event("PageUp", { altKey: true }), KEY.PageUp, undefined, MOD_ALT],
      [event("PageDown", { altKey: true }), KEY.PageDown, undefined, MOD_ALT],
      [event("Escape", { altKey: true }), KEY.Esc, undefined, MOD_ALT],
      [event("[", { altKey: true }), KEY.Char, 91, MOD_ALT],
      [
        event("O", { altKey: true, shiftKey: true }),
        KEY.Char,
        79,
        MOD_ALT | MOD_SHIFT,
      ],
      [
        event(";", { ctrlKey: true, altKey: true }),
        KEY.Char,
        59,
        MOD_CONTROL | MOD_ALT,
      ],
      [
        event("X", { ctrlKey: true, shiftKey: true }),
        KEY.Char,
        88,
        MOD_CONTROL | MOD_SHIFT,
      ],
    ];
    for (const [input, code, char, modifiers] of cases) {
      const sequence = terminalDisambiguatedKeySequence(input);
      expect(sequence).not.toBeNull();
      const bytes = Buffer.from(sequence!);
      for (let split = 1; split < bytes.length; split++) {
        const classifier = new VtInputClassifier();
        expect(classifier.feed(bytes.subarray(0, split))).toEqual([]);
        expect(
          classifier.feed(
            Buffer.concat([bytes.subarray(split), Buffer.from("A")]),
          ),
        ).toMatchObject([
          { type: "key", code, char, modifiers },
          { type: "text", text: "A" },
        ]);
        expect(classifier.flush()).toEqual([]);
      }
    }
  });

  test("leaves working navigation, ordinary text and traditional aliases to xterm", () => {
    for (const key of [
      "i",
      "m",
      "[",
      "_",
      " ",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "ArrowLeft",
      "Home",
      "End",
      "Delete",
    ]) {
      expect(
        terminalDisambiguatedKeySequence(event(key, { ctrlKey: true })),
      ).toBeNull();
    }
    for (const input of [
      event("Tab", { shiftKey: true }),
      event("PageUp", { shiftKey: true }),
      event("PageDown", { shiftKey: true, altKey: true }),
      event("Backspace", { altKey: true }),
      event("x", { altKey: true }),
      event("/"),
      event("["),
      event("O"),
    ]) {
      expect(terminalDisambiguatedKeySequence(input)).toBeNull();
    }
    const classifier = new VtInputClassifier();
    expect(
      classifier.feed(
        Buffer.from("\x08\x1f\x00\t\r\x1b[Z\x1b\x7f\x1b[1;5D\x1b[3;3~"),
      ),
    ).toMatchObject([
      { type: "key", code: KEY.Char, char: 104, modifiers: MOD_CONTROL },
      { type: "key", code: KEY.Char, char: 95, modifiers: MOD_CONTROL },
      { type: "key", code: KEY.Char, char: 32, modifiers: MOD_CONTROL },
      { type: "key", code: KEY.Tab, modifiers: 0 },
      { type: "key", code: KEY.Enter, modifiers: 0 },
      { type: "key", code: KEY.BackTab, modifiers: 0 },
      { type: "key", code: KEY.Backspace, modifiers: MOD_ALT },
      { type: "key", code: KEY.Left, modifiers: MOD_CONTROL },
      { type: "key", code: KEY.Delete, modifiers: MOD_ALT },
    ]);
  });
});
