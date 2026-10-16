import { expect, test } from "bun:test";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Terminal } from "@xterm/xterm";
import { frameToAnsi } from "../../server/src/bridge/frame-to-ansi";
import type { FrameData } from "../../server/src/bridge/thin-client";

test.each(["中", "🙂", "👩‍💻", "🇨🇳", "ｶﾞ", "e\u0301"])(
  "keeps source columns and cursor after %s with production Unicode rendering",
  async (symbol) => {
    for (const cols of [5, 10]) {
      const term = new Terminal({ allowProposedApi: true, cols, rows: 3 });
      term.loadAddon(new UnicodeGraphemesAddon());
      try {
        const frame: FrameData = {
          width: 5,
          height: 2,
          cursor: { x: 4, y: 0, visible: true, shape: 1 },
          hyperlinks: [],
          cells: ["a", symbol, " ", " ", "x", symbol, " ", " ", "x", " "].map(
            (symbol) => ({
              symbol,
              fg: 0,
              bg: 0,
              modifier: 0,
              skip: false,
              hyperlink: null,
            }),
          ),
        };
        await new Promise<void>((resolve) =>
          term.write(frameToAnsi(frame), resolve),
        );
        const first = term.buffer.active.getLine(0)!;
        const second = term.buffer.active.getLine(1)!;
        expect(first.getCell(0)?.getChars()).toBe("a");
        expect(first.getCell(1)?.getChars()).toBe(symbol);
        expect(first.getCell(3)?.getChars()).toBe(" ");
        expect(first.getCell(4)?.getChars()).toBe("x");
        expect(second.getCell(0)?.getChars()).toBe(symbol);
        expect(second.getCell(2)?.getChars()).toBe(" ");
        expect(second.getCell(3)?.getChars()).toBe("x");
        expect(term.buffer.active.cursorX).toBe(4);
        expect(term.buffer.active.cursorY).toBe(0);
      } finally {
        term.dispose();
      }
    }
  },
);

test("keeps the IME anchor at hidden cursor coordinates across repaints", async () => {
  const term = new Terminal({ cols: 10, rows: 5 });
  const frame: FrameData = {
    width: 10,
    height: 5,
    cursor: null,
    hyperlinks: [],
    cells: Array.from({ length: 50 }, () => ({
      symbol: " ",
      fg: 0,
      bg: 0,
      modifier: 0,
      skip: false,
      hyperlink: null,
    })),
  };
  try {
    for (const [x, y, visible] of [
      [2, 1, false],
      [4, 0, false],
      [4, 0, true],
      [0, 2, false],
    ] as const) {
      frame.cursor = { x, y, visible, shape: 1 };
      const ansi = frameToAnsi(frame);
      await new Promise<void>((resolve) => term.write(ansi, resolve));
      expect(term.buffer.active.cursorX).toBe(x);
      expect(term.buffer.active.cursorY).toBe(y);
      expect(ansi).toEndWith(visible ? "\x1b[?25h" : "\x1b[?25l");
    }
  } finally {
    term.dispose();
  }
});

test.each([10, 11, 14])(
  "a %i-column TUI frame never wraps or scrolls a 10-column viewport",
  async (width) => {
    const term = new Terminal({ allowProposedApi: true, cols: 10, rows: 4 });
    term.loadAddon(new UnicodeGraphemesAddon());
    try {
      const lines = ["top", "item A", "item B", "bottom"].map(
        (text) => `|${text.padEnd(width - 2)}|`,
      );
      const frame: FrameData = {
        width,
        height: lines.length,
        cursor: null,
        hyperlinks: [],
        cells: Array.from(lines.join(""), (symbol) => ({
          symbol,
          fg: 0,
          bg: 0,
          modifier: 0,
          skip: false,
          hyperlink: null,
        })),
      };
      for (let repaint = 0; repaint < 2; repaint++) {
        await new Promise<void>((resolve) =>
          term.write(
            frameToAnsi(frame, { cols: term.cols, rows: term.rows }),
            resolve,
          ),
        );
        expect(term.buffer.active.baseY).toBe(0);
        for (let y = 0; y < lines.length; y++) {
          expect(term.buffer.active.getLine(y)?.translateToString(false)).toBe(
            lines[y].slice(0, 10),
          );
        }
        expect(term.modes.wraparoundMode).toBe(true);
      }
    } finally {
      term.dispose();
    }
  },
);

test("viewport clipping preserves the final column and row and hides outside cursors", async () => {
  const term = new Terminal({ allowProposedApi: true, cols: 10, rows: 3 });
  term.loadAddon(new UnicodeGraphemesAddon());
  const lines = ["123456789AB", "abcdefghijk", "ABCDEFGHIJK", "bottom-row!"];
  const frame: FrameData = {
    width: 11,
    height: 4,
    cursor: { x: 10, y: 3, visible: true, shape: 1 },
    hyperlinks: [],
    cells: Array.from(lines.join(""), (symbol) => ({
      symbol,
      fg: 0,
      bg: 0,
      modifier: 0,
      skip: false,
      hyperlink: null,
    })),
  };
  try {
    const ansi = frameToAnsi(frame, { cols: 10, rows: 3 });
    expect(ansi).toEndWith("\x1b[?25l");
    await new Promise<void>((resolve) => term.write(ansi, resolve));
    for (let y = 0; y < 3; y++) {
      expect(term.buffer.active.getLine(y)?.translateToString()).toBe(
        lines[y].slice(0, 10),
      );
    }
    frame.cells[9].symbol = "中";
    frame.cells[10].symbol = " ";
    await new Promise<void>((resolve) =>
      term.write(frameToAnsi(frame, { cols: 10, rows: 3 }), resolve),
    );
    expect(term.buffer.active.getLine(0)?.translateToString()).toBe(
      "123456789 ",
    );
    expect(term.buffer.active.baseY).toBe(0);
  } finally {
    term.dispose();
  }
});

test("endpoint repaints clear shortened text, blank rows, and a smaller pane", async () => {
  const term = new Terminal({ allowProposedApi: true, cols: 10, rows: 3 });
  try {
    for (const [text, width, height] of [
      ["abcdefghij".repeat(3), 10, 3],
      ["abc", 10, 3],
      ["x", 2, 1],
      ["", 2, 1],
    ] as const) {
      const frame: FrameData = {
        width,
        height,
        cursor: null,
        hyperlinks: [],
        cells: Array.from(text.padEnd(width * height), (symbol) => ({
          symbol,
          fg: 0,
          bg: 0,
          modifier: 0,
          skip: false,
          hyperlink: null,
        })),
      };
      await new Promise<void>((resolve) =>
        term.write(frameToAnsi(frame), resolve),
      );
      for (let y = 0; y < 3; y++) {
        expect(term.buffer.active.getLine(y)?.translateToString(true)).toBe(
          text.slice(y * width, (y + 1) * width),
        );
      }
    }
  } finally {
    term.dispose();
  }
});
