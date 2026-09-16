import { describe, expect, test, jest } from "bun:test";
import { Terminal } from "@xterm/xterm";
import {
  TerminalTouchSelection,
  TERMINAL_LONG_PRESS_MS,
} from "./terminalTouchSelection";
import { TerminalEndpointPresentation } from "./terminalEndpointPresentation";

describe("TerminalTouchSelection deadlines", () => {
  test("slop, cancel and reset invalidate even a parser-deferred long press", () => {
    jest.useFakeTimers();
    const term = { clearSelection() {} } as Terminal;
    let begins = 0,
      releases = 0;
    let activate: (() => void) | null = null;
    const selection = new TerminalTouchSelection(term, {
      begin: (callback) => {
        begins++;
        activate = callback;
      },
      changed() {},
      release() {
        releases++;
      },
    });
    try {
      selection.start({ x: 10, y: 10 });
      selection.move({ x: 19, y: 10 });
      jest.advanceTimersByTime(TERMINAL_LONG_PRESS_MS);
      expect(begins).toBe(0);
      selection.start({ x: 10, y: 10 });
      selection.cancelPending();
      jest.advanceTimersByTime(TERMINAL_LONG_PRESS_MS);
      expect(begins).toBe(0);
      selection.start({ x: 10, y: 10 });
      jest.advanceTimersByTime(TERMINAL_LONG_PRESS_MS);
      expect(begins).toBe(1);
      selection.reset();
      (activate as unknown as () => void)();
      expect(selection.active).toBe(false);
      expect(releases).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("incremental selection presentation", () => {
  test("waits for parsing, drains every queued chunk in order, and resumes live output", () => {
    let selected = false;
    const writes: string[] = [];
    const parsers: (() => void)[] = [];
    const presentation = new TerminalEndpointPresentation(
      () => selected,
      (text, parsed) => {
        writes.push(text);
        parsers.push(parsed);
      },
    );
    const overflow = () => {
      throw new Error("unexpected overflow");
    };
    presentation.updateIncremental("first", overflow);
    expect(
      presentation.beginSelection(() => {
        selected = true;
      }),
    ).toBe(false);
    presentation.updateIncremental("second", overflow);
    presentation.updateIncremental("third", overflow);
    expect(writes).toEqual(["first"]);
    parsers.shift()!();
    expect(selected).toBe(true);
    expect(writes).toEqual(["first"]);
    selected = false;
    presentation.cancelSelection();
    expect(writes).toEqual(["first", "secondthird"]);
    parsers.shift()!();
    presentation.updateIncremental("fourth", overflow);
    expect(writes.join("")).toBe("firstsecondthirdfourth");
    parsers.shift()!();
  });

  test("1 MiB UTF-16 cap releases display hold without dropping the triggering chunk", () => {
    let selected = true,
      overflows = 0;
    const writes: string[] = [];
    const presentation = new TerminalEndpointPresentation(
      () => selected,
      (text, parsed) => {
        writes.push(text);
        parsed();
      },
    );
    const overflow = () => {
      overflows++;
      selected = false;
      presentation.cancelSelection();
    };
    const payload = "a".repeat(512 * 1024);
    presentation.updateIncremental(payload, overflow);
    presentation.updateIncremental("", overflow);
    expect(writes).toEqual([]);
    presentation.updateIncremental("END", overflow);
    presentation.updateIncremental("LIVE", overflow);
    expect(overflows).toBe(1);
    expect(writes.join("")).toBe(`${payload}ENDLIVE`);
  });
});

test.each([false, true])(
  "incremental reset distinguishes same route from disposal (%s)",
  (discard) => {
    const writes: string[] = [];
    const parsers: (() => void)[] = [];
    const presentation = new TerminalEndpointPresentation(
      () => false,
      (text, parsed) => {
        writes.push(text);
        parsers.push(parsed);
      },
    );
    const overflow = () => {
      throw new Error("unexpected overflow");
    };
    presentation.updateIncremental("parsed first", overflow);
    presentation.beginSelection(() => {
      throw new Error("stale activation");
    });
    presentation.updateIncremental("pending second", overflow);
    presentation.reset(discard);
    presentation.updateIncremental("live third", overflow);
    parsers.shift()!();
    expect(writes.join("")).toBe(
      discard
        ? "parsed firstlive third"
        : "parsed firstpending secondlive third",
    );
    parsers.shift()!();
  },
);
