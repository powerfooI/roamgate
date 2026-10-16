import { describe, expect, test } from "bun:test";
import { frameToAnsi } from "./frame-to-ansi";
import type { CellData, FrameData } from "./thin-client";

function cell(symbol: string, over: Partial<CellData> = {}): CellData {
  return {
    symbol,
    fg: 0,
    bg: 0,
    modifier: 0,
    skip: false,
    hyperlink: null,
    ...over,
  };
}

function frame(cells: CellData[], width: number, height: number): FrameData {
  return { cells, width, height, cursor: null, hyperlinks: [] };
}

describe("frameToAnsi", () => {
  test("emits a full repaint and hides a missing cursor", () => {
    const out = frameToAnsi(frame([cell("h"), cell("i")], 2, 1));
    expect(out).toStartWith("\x1b[0m\x1b[H");
    expect(out).toContain("hi");
    expect(out).toEndWith("\x1b[?25l");
  });

  test("encodes named, indexed, and RGB colors", () => {
    const red = cell("r", { fg: 0x00_00_00_02 }); // named Red
    const bright = cell("b", { fg: 0x00_00_00_0a }); // LightRed
    const indexed = cell("i", { fg: 0x01_00_00_7b }); // palette 123
    const rgb = cell("g", { fg: 0x02_12_34_56, bg: 0x02_ab_cd_ef });
    const out = frameToAnsi(frame([red, bright, indexed, rgb], 4, 1));
    expect(out).toContain("\x1b[0m\x1b[31;49m");
    expect(out).toContain("\x1b[0m\x1b[91;49m");
    expect(out).toContain("\x1b[0m\x1b[38;5;123;49m");
    expect(out).toContain("\x1b[0m\x1b[38;2;18;52;86;48;2;171;205;239m");
  });

  test("encodes modifiers including styled underlines", () => {
    const bold = cell("b", { modifier: 0x0001 });
    const curly = cell("u", { modifier: 0x0008 | (3 << 12) });
    const rev = cell("r", { modifier: 0x0040 });
    const out = frameToAnsi(frame([bold, curly, rev], 3, 1));
    expect(out).toContain("\x1b[1;39;49m");
    expect(out).toContain("\x1b[4:3;39;49m");
    expect(out).toContain("\x1b[7;39;49m");
  });

  test("skips spacer cells after wide graphemes", () => {
    const out = frameToAnsi(
      frame([cell("你"), cell("", { skip: true }), cell("x")], 3, 1),
    );
    expect(out).toContain("你\x1b[3Gx");
  });

  test.each(["中", "🙂", "👩‍💻", "🇨🇳", "ｶﾞ"])(
    "skips unmarked padding after %s without removing a real space",
    (symbol) => {
      const out = frameToAnsi(
        frame([cell(symbol), cell(" "), cell(" "), cell("x")], 4, 1),
      );
      expect(out).toContain(`${symbol}\x1b[3G x`);
      expect(out).not.toContain(`${symbol}  x`);
    },
  );

  test("does not skip the cell after a narrow combining grapheme", () => {
    const out = frameToAnsi(frame([cell("e\u0301"), cell("x")], 2, 1));
    expect(out).toContain("e\u0301x");
  });

  test("trims trailing default blanks but keeps styled blanks", () => {
    const styledBlank = cell(" ", { bg: 0x00_00_00_03 });
    const out = frameToAnsi(
      frame([cell("a"), styledBlank, cell(" "), cell(" ")], 4, 1),
    );
    // Two trailing default blanks are trimmed; the styled blank remains.
    expect(out).toContain("a\x1b[0m\x1b[39;42m ");
    expect(out.trimEnd().endsWith("\x1b[?25l")).toBe(true);
    expect(out).not.toContain("a\x1b[0m\x1b[39;42m   ");
  });

  test("opens and closes OSC 8 hyperlinks", () => {
    const linked = cell("L", { hyperlink: 0 });
    const f: FrameData = {
      ...frame([linked, cell("x")], 2, 1),
      hyperlinks: ["https://example.com"],
    };
    const out = frameToAnsi(f);
    expect(out).toContain("\x1b]8;;https://example.com\x1b\\L");
    expect(out).toContain("L\x1b]8;;\x1b\\");
  });

  test.each([true, false])(
    "positions the cursor when visible=%s",
    (visible) => {
      const f: FrameData = {
        ...frame(
          Array.from({ length: 12 }, () => cell("a")),
          3,
          4,
        ),
        cursor: { x: 2, y: 3, visible, shape: 5 },
      };
      const out = frameToAnsi(f);
      expect(out).toContain("\x1b[4;3H");
      if (visible) {
        expect(out).toEndWith("\x1b[5 q\x1b[?25h");
      } else {
        expect(out).toEndWith("\x1b[?25l");
        expect(out).not.toContain("\x1b[?25h");
      }
    },
  );

  test("positions rows without wrapping the cell grid", () => {
    const out = frameToAnsi(
      frame([cell("a"), cell("b"), cell("c"), cell("d")], 2, 2),
    );
    // Each row restarts style tracking, so row 2 opens with a fresh SGR.
    expect(out).toContain("ab\x1b[2;1H\x1b[0m\x1b[39;49mcd");
    expect(out).toContain("\x1b[?7l");
    expect(out).toContain("\x1b[?7h");
    expect(out).not.toContain("\r\n");
  });
});
