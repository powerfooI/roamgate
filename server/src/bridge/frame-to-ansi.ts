import type { CellData, FrameData } from "./thin-client";

// Serializes a Herdr wire FrameData cell grid into ANSI bytes for xterm.js.
// The stable endpoint path delivers server-rendered cells instead of an ANSI
// stream, so the bridge re-encodes them here.
//
// ponytail: full repaint per frame, no diffing. A 100x30 frame is ~20-60KB;
// add run/diff optimization only if websocket bandwidth measurably hurts.

const RESET = "\x1b[0m";

// ratatui Modifier bits (plus Herdr underline-style extension in bits 12-15).
const MOD_BOLD = 0x0001;
const MOD_DIM = 0x0002;
const MOD_ITALIC = 0x0004;
const MOD_UNDERLINED = 0x0008;
const MOD_BLINK = 0x0010 | 0x0020;
const MOD_REVERSED = 0x0040;
const MOD_HIDDEN = 0x0080;
const MOD_CROSSED_OUT = 0x0100;
const UNDERLINE_STYLE_SHIFT = 12;

function sgrColor(packed: number, foreground: boolean): string {
  const kind = packed >>> 24;
  const value = packed & 0x00ff_ffff;
  if (kind === 0x00) {
    if (value === 0) return foreground ? "39" : "49";
    if (value <= 8) return String((foreground ? 30 : 40) + value - 1);
    return String((foreground ? 90 : 100) + value - 9);
  }
  if (kind === 0x01) return `${foreground ? 38 : 48};5;${value & 0xff}`;
  // 0x02_RR_GG_BB
  const r = (value >>> 16) & 0xff;
  const g = (value >>> 8) & 0xff;
  const b = value & 0xff;
  return `${foreground ? 38 : 48};2;${r};${g};${b}`;
}

function sgrStyle(cell: CellData): string {
  const codes: string[] = [];
  const mod = cell.modifier;
  if (mod & MOD_BOLD) codes.push("1");
  if (mod & MOD_DIM) codes.push("2");
  if (mod & MOD_ITALIC) codes.push("3");
  if (mod & MOD_UNDERLINED) {
    const style = (mod & 0xf000) >>> UNDERLINE_STYLE_SHIFT;
    codes.push(style >= 1 && style <= 5 ? `4:${style}` : "4");
  }
  if (mod & MOD_BLINK) codes.push("5");
  if (mod & MOD_REVERSED) codes.push("7");
  if (mod & MOD_HIDDEN) codes.push("8");
  if (mod & MOD_CROSSED_OUT) codes.push("9");
  codes.push(sgrColor(cell.fg, true));
  codes.push(sgrColor(cell.bg, false));
  return `\x1b[${codes.join(";")}m`;
}

function styleKey(cell: CellData): string {
  return `${cell.fg},${cell.bg},${cell.modifier},${cell.hyperlink ?? ""}`;
}

function isDefaultBlank(cell: CellData): boolean {
  return (
    cell.symbol === " " &&
    cell.fg === 0 &&
    cell.bg === 0 &&
    cell.modifier === 0 &&
    cell.hyperlink === null
  );
}

/** Serialize one frame as a full repaint: home, styled rows, cursor. */
export function frameToAnsi(
  frame: FrameData,
  viewport = { cols: frame.width, rows: frame.height },
): string {
  const width = Math.min(frame.width, viewport.cols);
  const height = Math.min(frame.height, viewport.rows);
  // Frames are positioned cell grids, not flowing text. A stale frame can
  // exceed the viewer width during resize; never let it wrap and scroll.
  let out = `${RESET}\x1b[H\x1b[2J\x1b[?7l`;
  for (let y = 0; y < height; y++) {
    if (y > 0) out += `\x1b[${y + 1};1H`;
    const rowStart = y * frame.width;
    let rowEnd = width;
    // Trim trailing default blanks; the terminal background fills them.
    while (rowEnd > 0 && isDefaultBlank(frame.cells[rowStart + rowEnd - 1])) {
      rowEnd--;
    }
    let lastStyle: string | null = null;
    let linkOpen = false;
    for (let x = 0; x < rowEnd; x++) {
      const cell = frame.cells[rowStart + x];
      if (cell.skip) continue;
      const cellWidth = Bun.stringWidth(cell.symbol);
      if (x + cellWidth > width) break;
      const key = styleKey(cell);
      if (key !== lastStyle) {
        if (linkOpen) {
          out += "\x1b]8;;\x1b\\";
          linkOpen = false;
        }
        out += RESET + sgrStyle(cell);
        const link = cell.hyperlink;
        if (link !== null) {
          const uri = frame.hyperlinks[link];
          if (uri !== undefined) {
            out += `\x1b]8;;${uri}\x1b\\`;
            linkOpen = true;
          }
        }
        lastStyle = key;
      }
      out += cell.symbol;
      // Herdr's wide-character padding is often a normal blank (skip=false).
      const padding = Math.max(0, cellWidth - 1);
      x += padding;
      // xterm can render the same grapheme narrower; anchor the next source cell.
      if (padding && x + 1 < rowEnd) out += `\x1b[${x + 2}G`;
    }
    if (linkOpen) out += "\x1b]8;;\x1b\\";
  }
  out += "\x1b[?7h";
  const cursor = frame.cursor;
  if (cursor && cursor.x < width && cursor.y < height) {
    // Hidden cursors still anchor xterm's IME composition and candidate window.
    out += `${RESET}\x1b[${cursor.y + 1};${cursor.x + 1}H`;
    out += cursor.visible ? `\x1b[${cursor.shape} q\x1b[?25h` : "\x1b[?25l";
  } else {
    out += "\x1b[?25l";
  }
  return out;
}
