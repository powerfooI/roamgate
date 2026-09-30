import { describe, expect, test } from "bun:test";
import { mobileTerminalShortcutExecution } from "./mobileTerminalShortcutAction";
import { terminalPageScroll } from "./terminalScroll";

describe("mobile terminal shortcut execution", () => {
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
