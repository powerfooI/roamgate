import { describe, expect, test } from "bun:test";
import { mobileTerminalKeyCombinationBytes } from "./mobileTerminalKeyCombination";
import { mobileTerminalShortcutExecution } from "./mobileTerminalShortcutAction";
import {
  MAX_MOBILE_TERMINAL_SHORTCUTS_PER_ROW,
  defaultMobileTerminalShortcutRows,
  defaultMobileTerminalSideShortcuts,
  mobileTerminalShortcutBytes,
  mobileTerminalShortcutCount,
  mobileTerminalShortcutOption,
  mobileTerminalShortcutScroll,
  normalizeMobileTerminalShortcutRows,
  parseMobileTerminalShortcutRows,
  parseMobileTerminalSideShortcuts,
  serializeMobileTerminalShortcutRows,
  serializeMobileTerminalSideShortcuts,
} from "./mobileTerminalShortcuts";

describe("mobile terminal shortcuts", () => {
  test("keeps case-sensitive character labels consistent with sent bytes", () => {
    for (const key of ["x", "X"]) {
      for (const alt of [false, true]) {
        const action = { key, ctrl: false, alt, shift: false };
        expect(mobileTerminalShortcutOption(action)?.label).toBe(
          `${alt ? "Alt+" : ""}${key}`,
        );
        expect(mobileTerminalShortcutBytes(action)).toEqual([
          ...(alt ? [0x1b] : []),
          key.charCodeAt(0),
        ]);
      }
    }
  });

  test("keeps the key visible in default labels with multiple modifiers", () => {
    for (const [key, expected] of [
      ["x", "C-A-S-X"],
      ["y", "C-A-S-Y"],
      ["ArrowLeft", "C-A-S-Left"],
      ["ArrowRight", "C-A-S-Righ"],
      ["PageUp", "C-A-S-PgUp"],
      ["PageDown", "C-A-S-PgDn"],
    ]) {
      const action = { key, ctrl: true, alt: true, shift: true };
      expect(mobileTerminalShortcutOption(action)?.defaultButtonLabel).toBe(
        expected,
      );
      const shortcut = { id: "custom", label: "", action };
      expect(
        normalizeMobileTerminalShortcutRows([[shortcut], []])[0][0]?.label,
      ).toBe(expected);
      expect(
        parseMobileTerminalSideShortcuts(JSON.stringify([shortcut]))[0]?.label,
      ).toBe(expected);
    }
  });

  test.each([
    ["x", true, false, false, "\x18"],
    ["j", true, false, false, "\n"],
    ["x", false, true, false, "\x1bx"],
    ["x", true, true, false, "\x1b\x18"],
    ["x", false, false, true, "X"],
    ["2", false, true, true, "\x1b@"],
    ["6", true, false, true, "\x1e"],
    ["[", true, false, false, "\x1b"],
    ["/", true, false, false, "\x1f"],
    ["/", true, true, false, "\x1b\x1f"],
    ["Space", true, false, false, "\x00"],
    ["3", true, false, false, "\x1b"],
    ["8", true, false, false, "\x7f"],
    ["Tab", false, false, true, "\x1b[Z"],
    ["Escape", false, true, false, "\x1b\x1b"],
    ["Backspace", true, true, false, "\x1b\b"],
    ["ArrowUp", false, false, false, "\x1b[A"],
    ["ArrowLeft", true, true, true, "\x1b[1;8D"],
    ["Home", true, false, false, "\x1b[1;5H"],
    ["F1", false, false, false, "\x1bOP"],
    ["F4", false, true, false, "\x1b[1;3S"],
    ["F12", true, false, false, "\x1b[24;5~"],
    ["Delete", false, false, true, "\x1b[3;2~"],
    ["PageUp", false, false, false, "\x1b[5~"],
    ["PageDown", false, true, false, "\x1b[6;3~"],
    ["Enter", false, false, false, "\r"],
    ["Enter", true, false, false, "\x1b[13;5u"],
    ["Enter", false, false, true, "\x1b[13;2u"],
  ] as const)(
    "sends custom %s (Ctrl=%s Alt=%s Shift=%s) with no extra Enter",
    (key, ctrl, alt, shift, sequence) => {
      const action = { key, ctrl, alt, shift };
      const bytes = Array.from(sequence, (character) =>
        character.charCodeAt(0),
      );
      expect(mobileTerminalKeyCombinationBytes(action)).toEqual(bytes);
      expect(mobileTerminalShortcutExecution(action)).toEqual({
        type: "input",
        bytes,
      });
    },
  );

  test("round-trips custom panel and side buttons while rejecting unsupported stored actions", () => {
    const rows = defaultMobileTerminalShortcutRows();
    const action = { key: "o", ctrl: true, alt: true, shift: false };
    const shortcut = { id: "custom-o", label: "Open", action };
    rows[0][4] = shortcut;
    expect(
      parseMobileTerminalShortcutRows(
        serializeMobileTerminalShortcutRows(rows),
      ),
    ).toEqual(rows);
    expect(
      parseMobileTerminalSideShortcuts(
        serializeMobileTerminalSideShortcuts([null, shortcut, null, null]),
      ),
    ).toEqual([null, shortcut, null, null]);
    const invalidActions = [
      { ...action, key: "hello" },
      { ...action, key: "\x1b" },
      { ...action, key: "你" },
      { ...action, key: "constructor" },
      { ...action, key: "toString" },
      { ...action, key: "1" },
      { ...action, key: "Tab" },
      { ...action, key: "Escape" },
      { ...action, key: "Backspace", shift: true },
      { ...action, ctrl: "true" },
      { key: "x" },
      { ...action, meta: true },
      { ...action, bytes: [0x0d] },
      null,
      [],
    ];
    for (const action of invalidActions) {
      expect(mobileTerminalKeyCombinationBytes(action)).toEqual([]);
      const candidate = { ...shortcut, action };
      expect(
        normalizeMobileTerminalShortcutRows([[null, candidate], []])[0][1],
      ).toBeNull();
      expect(
        parseMobileTerminalSideShortcuts(JSON.stringify([null, candidate]))[1],
      ).toBeNull();
    }
  });

  test("uses the terminal controls across at most two aligned default rows", () => {
    const rows = defaultMobileTerminalShortcutRows();

    expect(rows).toHaveLength(2);
    expect(MAX_MOBILE_TERMINAL_SHORTCUTS_PER_ROW).toBe(8);
    expect(
      rows.map((row) => row.map((shortcut) => shortcut?.action ?? null)),
    ).toEqual([
      [
        "ctrl-c",
        "ctrl-d",
        "ctrl-r",
        "alt-up",
        null,
        "arrow-up",
        null,
        "page-up",
      ],
      [
        "escape",
        "tab",
        "enter",
        "backspace",
        "arrow-left",
        "arrow-down",
        "arrow-right",
        "page-down",
      ],
    ]);
    expect([
      rows[0][5]?.label,
      rows[1][4]?.label,
      rows[1][5]?.label,
      rows[1][6]?.label,
    ]).toEqual(["▲", "◀", "▼", "▶"]);
    expect(
      rows.every((row) => row.length <= MAX_MOBILE_TERMINAL_SHORTCUTS_PER_ROW),
    ).toBe(true);
  });

  test("upgrades untouched legacy arrays to the Backspace defaults only once", () => {
    const previous = defaultMobileTerminalShortcutRows();
    previous[1][3] = null;
    const migrated = parseMobileTerminalShortcutRows(JSON.stringify(previous));
    expect(migrated).toEqual(defaultMobileTerminalShortcutRows());
    expect(migrated[1][3]?.label).toBe("Bksp");
    expect(
      parseMobileTerminalShortcutRows(
        serializeMobileTerminalShortcutRows(migrated),
      ),
    ).toEqual(migrated);

    migrated[1][3] = null;
    expect(
      parseMobileTerminalShortcutRows(
        serializeMobileTerminalShortcutRows(migrated),
      ),
    ).toEqual(previous);
  });

  test("preserves customized legacy arrays when upgrading the saved format", () => {
    const customized = defaultMobileTerminalShortcutRows();
    customized[1][3] = null;
    customized[0][4] = { id: "home", label: "Home", action: "home" };
    const migrated = parseMobileTerminalShortcutRows(
      JSON.stringify(customized),
    );
    expect(migrated).toEqual(customized);
    expect(
      parseMobileTerminalShortcutRows(
        serializeMobileTerminalShortcutRows(migrated),
      ),
    ).toEqual(customized);
  });

  test("round-trips removing Backspace from current defaults", () => {
    const rows = defaultMobileTerminalShortcutRows();
    rows[1][3] = null;
    const saved = serializeMobileTerminalShortcutRows(rows);

    expect(JSON.parse(saved)).toEqual({ version: 1, rows });
    expect(parseMobileTerminalShortcutRows(saved)).toEqual(rows);
  });

  test("resetting restores Backspace without preventing subsequent removal", () => {
    const reset = parseMobileTerminalShortcutRows(
      serializeMobileTerminalShortcutRows(defaultMobileTerminalShortcutRows()),
    );
    expect(reset[1][3]?.action).toBe("backspace");
    reset[1][3] = null;
    expect(
      parseMobileTerminalShortcutRows(
        serializeMobileTerminalShortcutRows(reset),
      ),
    ).toEqual(reset);
  });

  test("normalizes untrusted stored rows, labels, actions, and ids", () => {
    const rows = normalizeMobileTerminalShortcutRows([
      [
        { id: "same", label: "  Interrupt  ", action: "ctrl-c" },
        { id: "same", label: "😀😀😀😀😀😀😀😀😀😀😀", action: "enter" },
        { id: "bad id", label: "Ignored", action: "not-a-key" },
        ...Array.from({ length: 8 }, (_, index) => ({
          id: `extra-${index}`,
          label: "Esc",
          action: "escape",
        })),
      ],
      [{ id: "up", label: "", action: "arrow-up" }],
      [{ id: "third", label: "Third", action: "tab" }],
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(MAX_MOBILE_TERMINAL_SHORTCUTS_PER_ROW);
    expect(rows[0][0]).toEqual({
      id: "same",
      label: "Interrupt",
      action: "ctrl-c",
    });
    expect(rows[0][1]?.id).toBe("same-2");
    expect(Array.from(rows[0][1]?.label ?? "")).toHaveLength(10);
    expect(rows[1]).toEqual([
      { id: "up", label: "▲", action: "arrow-up" },
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  test("drops removed paste actions from stored shortcuts", () => {
    const rows = normalizeMobileTerminalShortcutRows([
      [{ id: "old-paste", label: "Paste", action: "paste" }],
      [],
    ]);
    const sideShortcuts = parseMobileTerminalSideShortcuts(
      JSON.stringify([
        { id: "old-side-paste", label: "Paste", action: "paste" },
      ]),
    );

    expect(rows[0][0]).toBeNull();
    expect(sideShortcuts[0]).toBeNull();
  });

  test("migrates legacy compact rows past invalid entries", () => {
    const rows = normalizeMobileTerminalShortcutRows([
      [
        { id: "first", label: "First", action: "ctrl-a" },
        { id: "invalid", label: "Invalid", action: "unknown" },
        { id: "second", label: "Second", action: "ctrl-b" },
      ],
      [],
    ]);

    expect(rows[0][0]?.id).toBe("first");
    expect(rows[0][1]?.id).toBe("second");
    expect(rows[0][2]).toBeNull();
  });

  test("preserves empty slots instead of compacting later buttons", () => {
    const rows = normalizeMobileTerminalShortcutRows([
      [null, null, { id: "third", label: "Home", action: "home" }],
      [null, { id: "second", label: "End", action: "end" }],
    ]);

    expect(rows[0][0]).toBeNull();
    expect(rows[0][2]?.action).toBe("home");
    expect(rows[1][1]?.action).toBe("end");
    expect(
      parseMobileTerminalShortcutRows(
        serializeMobileTerminalShortcutRows(rows),
      ),
    ).toEqual(rows);
  });

  test("preserves four optional side shortcut slots", () => {
    const shortcuts = parseMobileTerminalSideShortcuts(
      JSON.stringify([
        null,
        { id: "side-two", label: " Half ", action: "alt-page-up" },
        { id: "invalid", label: "No", action: "unknown" },
        { id: "side-four", label: "End", action: "end" },
        { id: "ignored", label: "Esc", action: "escape" },
      ]),
    );

    expect(defaultMobileTerminalSideShortcuts()).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(shortcuts).toEqual([
      null,
      { id: "side-two", label: "Half", action: "alt-page-up" },
      null,
      { id: "side-four", label: "End", action: "end" },
    ]);
    expect(
      parseMobileTerminalSideShortcuts(
        serializeMobileTerminalSideShortcuts(shortcuts),
      ),
    ).toEqual(shortcuts);
    expect(parseMobileTerminalSideShortcuts("bad json")).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  test("allows users to clear all panel slots", () => {
    const empty = normalizeMobileTerminalShortcutRows([[], []]);

    expect(mobileTerminalShortcutCount(empty)).toBe(0);
    expect(
      parseMobileTerminalShortcutRows(
        serializeMobileTerminalShortcutRows(empty),
      ),
    ).toEqual(empty);
  });

  test("falls back safely for missing or malformed storage", () => {
    const expected = defaultMobileTerminalShortcutRows();

    expect(parseMobileTerminalShortcutRows(null)).toEqual(expected);
    expect(parseMobileTerminalShortcutRows("not json")).toEqual(expected);
    for (const value of [
      null,
      {},
      { rows: [[], []] },
      { version: 1 },
      { version: 1, rows: "invalid" },
      { version: 2, rows: [[], []] },
    ]) {
      expect(parseMobileTerminalShortcutRows(JSON.stringify(value))).toEqual(
        expected,
      );
    }
  });

  test("round-trips normalized rows without sharing mutable defaults", () => {
    const first = defaultMobileTerminalShortcutRows();
    first[0][0]!.label = "Changed";
    expect(defaultMobileTerminalShortcutRows()[0][0]?.label).toBe("C-c");

    const encoded = serializeMobileTerminalShortcutRows(first);
    const parsed = parseMobileTerminalShortcutRows(encoded);
    expect(parsed[0][0]?.label).toBe("Changed");
    expect(mobileTerminalShortcutCount(parsed)).toBe(14);
  });

  test("encodes control, navigation, and modified keys", () => {
    expect(mobileTerminalShortcutBytes("ctrl-c")).toEqual([0x03]);
    expect(mobileTerminalShortcutBytes("page-up")).toEqual([]);
    expect(mobileTerminalShortcutBytes("page-down")).toEqual([]);
    expect(mobileTerminalShortcutBytes("alt-up")).toEqual([
      0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x41,
    ]);
    expect(mobileTerminalShortcutBytes("alt-page-up")).toEqual([]);
    expect(mobileTerminalShortcutBytes("alt-page-down")).toEqual([]);
    expect(mobileTerminalShortcutBytes("shift-enter")).toEqual([
      0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x32, 0x75,
    ]);
  });

  test("routes page actions to scrollback instead of terminal input", () => {
    expect(mobileTerminalShortcutScroll("page-up")).toEqual({
      direction: "up",
      amount: "full",
    });
    expect(mobileTerminalShortcutScroll("page-down")).toEqual({
      direction: "down",
      amount: "full",
    });
    expect(mobileTerminalShortcutScroll("alt-page-up")).toEqual({
      direction: "up",
      amount: "half",
    });
    expect(mobileTerminalShortcutScroll("alt-page-down")).toEqual({
      direction: "down",
      amount: "half",
    });
    expect(mobileTerminalShortcutScroll("arrow-up")).toBeNull();
  });
});
