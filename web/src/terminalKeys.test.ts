import { describe, expect, test } from "bun:test";
import {
  terminalDisambiguatedKeySequence,
  terminalShortcutSequence,
} from "./terminalKeys";
import { defaultShortcutBindings } from "./shortcutBindings";
type KeyEvent = Parameters<typeof terminalShortcutSequence>[0];
const modifiedEnterSequence = (event: KeyEvent) =>
  terminalShortcutSequence(event, defaultShortcutBindings("linux"));
const macCommandEditingSequence = (event: KeyEvent, isMac: boolean) =>
  isMac
    ? terminalShortcutSequence(event, defaultShortcutBindings("mac"))
    : null;

function keyEvent(
  overrides: Partial<Parameters<typeof modifiedEnterSequence>[0]> = {},
): Parameters<typeof modifiedEnterSequence>[0] {
  return {
    type: "keydown",
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    ...overrides,
  };
}

describe("terminal modified Enter keys", () => {
  test("keeps Shift+Enter, Alt+Enter and Ctrl+Enter distinct", () => {
    expect(modifiedEnterSequence(keyEvent({ shiftKey: true }))).toBe(
      "\x1b[13;2u",
    );
    expect(modifiedEnterSequence(keyEvent({ altKey: true }))).toBe(
      "\x1b[13;3u",
    );
    for (const platform of ["mac", "windows", "linux"] as const) {
      for (const code of ["Enter", "NumpadEnter"]) {
        expect(
          terminalShortcutSequence(
            keyEvent({ code, ctrlKey: true }),
            defaultShortcutBindings(platform),
          ),
        ).toBe("\x1b[13;5u");
      }
    }
  });

  test("does not collapse other modifier combinations", () => {
    for (let modifiers = 0; modifiers < 16; modifiers++) {
      const sequence = modifiedEnterSequence(
        keyEvent({
          shiftKey: (modifiers & 1) !== 0,
          altKey: (modifiers & 2) !== 0,
          ctrlKey: (modifiers & 4) !== 0,
          metaKey: (modifiers & 8) !== 0,
        }),
      );
      const expected =
        modifiers === 1
          ? "\x1b[13;2u"
          : modifiers === 2
            ? "\x1b[13;3u"
            : modifiers === 4
              ? "\x1b[13;5u"
              : null;
      expect(sequence).toBe(expected);
    }
  });

  test("supports the numpad Enter code", () => {
    expect(
      modifiedEnterSequence(
        keyEvent({ key: "", code: "NumpadEnter", altKey: true }),
      ),
    ).toBe("\x1b[13;3u");
  });

  test("leaves unrelated and combined modifiers to xterm", () => {
    expect(modifiedEnterSequence(keyEvent())).toBeNull();
    expect(
      modifiedEnterSequence(keyEvent({ shiftKey: true, altKey: true })),
    ).toBeNull();
    expect(
      modifiedEnterSequence(keyEvent({ altKey: true, ctrlKey: true })),
    ).toBeNull();
    expect(
      modifiedEnterSequence(keyEvent({ type: "keyup", altKey: true })),
    ).toBeNull();
  });

  test("does not bypass IME composition handling", () => {
    expect(
      modifiedEnterSequence(keyEvent({ altKey: true, isComposing: true })),
    ).toBeNull();
    expect(
      modifiedEnterSequence(keyEvent({ altKey: true, keyCode: 229 })),
    ).toBeNull();
  });
});

describe("terminal macOS Command editing keys", () => {
  test("maps pure Command editing shortcuts to readline controls", () => {
    expect(
      macCommandEditingSequence(
        keyEvent({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true }),
        true,
      ),
    ).toBe("\x01");
    expect(
      macCommandEditingSequence(
        keyEvent({ key: "ArrowDown", code: "ArrowDown", metaKey: true }),
        true,
      ),
    ).toBe("\x05");
    expect(
      macCommandEditingSequence(
        keyEvent({ key: "Backspace", code: "Backspace", metaKey: true }),
        true,
      ),
    ).toBe("\x15");
  });

  test("does not downgrade additional modifiers to pure Command", () => {
    expect(
      macCommandEditingSequence(
        keyEvent({
          key: "ArrowLeft",
          code: "ArrowLeft",
          metaKey: true,
          shiftKey: true,
        }),
        true,
      ),
    ).toBeNull();
    expect(
      macCommandEditingSequence(
        keyEvent({
          key: "Backspace",
          code: "Backspace",
          metaKey: true,
          altKey: true,
        }),
        true,
      ),
    ).toBeNull();
  });

  test("does not reinterpret Meta keys on non-Apple platforms", () => {
    expect(
      macCommandEditingSequence(
        keyEvent({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true }),
        false,
      ),
    ).toBeNull();
  });

  test("does not bypass IME composition handling", () => {
    expect(
      macCommandEditingSequence(
        keyEvent({
          key: "Backspace",
          code: "Backspace",
          keyCode: 8,
          metaKey: true,
          isComposing: true,
        }),
        true,
      ),
    ).toBeNull();
  });
});

describe("terminal disambiguated control keys", () => {
  const slash = keyEvent({
    key: "/",
    code: "Slash",
    keyCode: 191,
    ctrlKey: true,
  });

  test("preserves an unshifted Ctrl+/ by character rather than physical key", () => {
    for (const code of ["Slash", "NumpadDivide", "Digit7"]) {
      expect(terminalDisambiguatedKeySequence({ ...slash, code })).toBe(
        "\x1b[47;5u",
      );
    }
  });

  test("retains additional slash modifiers instead of collapsing them to underscore", () => {
    expect(terminalDisambiguatedKeySequence({ ...slash, altKey: true })).toBe(
      "\x1b[47;7u",
    );
    expect(
      terminalDisambiguatedKeySequence({ ...slash, key: "?", shiftKey: true }),
    ).toBe("\x1b[63;6u");
  });

  test("leaves Apple Option text, AltGr text, and Meta shortcuts alone", () => {
    const alternate = { ...slash, altKey: true };
    expect(terminalDisambiguatedKeySequence(alternate, true)).toBeNull();
    expect(
      terminalDisambiguatedKeySequence({
        ...alternate,
        getModifierState: (key) => key === "AltGraph",
      }),
    ).toBeNull();
    expect(
      terminalDisambiguatedKeySequence({ ...alternate, metaKey: true }),
    ).toBeNull();
  });

  test("leaves other characters, modifiers, composition and keyup to xterm", () => {
    for (const changes of [
      { key: "_" },
      { key: "-" },
      { key: "?" },
      { ctrlKey: false },
      { metaKey: true },
      { isComposing: true },
      { keyCode: 229 },
      { type: "keyup" },
      { type: "keypress" },
    ]) {
      expect(
        terminalDisambiguatedKeySequence({ ...slash, ...changes }),
      ).toBeNull();
    }
  });
});
