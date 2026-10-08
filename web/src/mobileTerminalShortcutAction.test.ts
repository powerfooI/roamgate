import { describe, expect, test } from "bun:test";
import { mobileTerminalShortcutExecution } from "./mobileTerminalShortcutAction";
import { mobileTerminalKeyCombinationBytes } from "./mobileTerminalKeyCombination";
import { mobileTerminalShortcutBytes } from "./mobileTerminalShortcuts";
import { terminalPageScroll } from "./terminalScroll";

describe("mobile terminal shortcut execution", () => {
  test.each([
    ["/", true, false, false, "\x1f"],
    ["/", true, false, true, "\x7f"],
    ["/", true, true, false, "\x1b\x1f"],
    ["/", true, true, true, "\x1b\x7f"],
    ["Backspace", true, false, false, "\b"],
    ["Backspace", true, true, false, "\x1b\b"],
    ["Escape", false, true, false, "\x1b\x1b"],
    ["[", false, true, false, "\x1b["],
    ["O", false, true, false, "\x1bO"],
    ["o", false, true, true, "\x1bO"],
    ["x", true, false, true, "\x18"],
    ["x", true, true, true, "\x1b\x18"],
    ["[", true, true, false, "\x1b\x1b"],
    ["@", true, true, false, "\x1b\x00"],
    [";", true, true, false, ""],
    [",", true, true, false, ""],
    ["Enter", false, false, true, "\x1b[13;2u"],
  ] as const)(
    "keeps raw-PTY bytes for %s (Ctrl=%s Alt=%s Shift=%s)",
    (key, ctrl, alt, shift, sequence) => {
      const action = { key, ctrl, alt, shift };
      const bytes = Array.from(Buffer.from(sequence));
      expect(mobileTerminalKeyCombinationBytes(action, false)).toEqual(bytes);
      expect(mobileTerminalShortcutBytes(action, false)).toEqual(bytes);
      expect(mobileTerminalShortcutExecution(action, false)).toEqual(
        bytes.length ? { type: "input", bytes } : null,
      );
    },
  );

  test("sends ordinary configured keys as terminal input", () => {
    expect(mobileTerminalShortcutExecution("ctrl-c")).toEqual({
      type: "input",
      bytes: [0x03],
    });
    expect(mobileTerminalShortcutExecution("ctrl-x")).toEqual({
      type: "input",
      bytes: [0x18],
    });
    expect(mobileTerminalShortcutExecution("alt-up")).toEqual({
      type: "input",
      bytes: [0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x41],
    });
  });

  test("mobile half-page actions carry explicit history intent like keyboard shortcuts", () => {
    for (const action of ["alt-page-up", "alt-page-down"] as const) {
      const execution = mobileTerminalShortcutExecution(action);
      if (execution?.type !== "scroll") throw new Error("expected scroll");
      expect(
        terminalPageScroll(execution.direction, 30, execution.amount),
      ).toEqual({
        direction: execution.direction,
        lines: 14,
        source: "history",
      });
    }
  });

  test("routes page actions to full or half scrollback", () => {
    expect(mobileTerminalShortcutExecution("page-up")).toEqual({
      type: "scroll",
      direction: "up",
      amount: "full",
    });
    expect(mobileTerminalShortcutExecution("page-down")).toEqual({
      type: "scroll",
      direction: "down",
      amount: "full",
    });
    expect(mobileTerminalShortcutExecution("alt-page-up")).toEqual({
      type: "scroll",
      direction: "up",
      amount: "half",
    });
    expect(mobileTerminalShortcutExecution("alt-page-down")).toEqual({
      type: "scroll",
      direction: "down",
      amount: "half",
    });
  });
});
