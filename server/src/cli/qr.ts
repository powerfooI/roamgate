import qrcode from "qrcode-generator";

const QUIET_ZONE = 4;
// 256-color black on white keeps the code scannable on dark terminal themes.
const COLORS = "\x1b[38;5;16;48;5;231m";
const RESET = "\x1b[0m";

/**
 * Render text as a QR code using half-block characters, two modules per row.
 * Colors are explicit because a code with inverted contrast often fails to scan.
 */
export function renderTerminalQr(text: string): string {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const size = code.getModuleCount();
  const dark = (row: number, col: number) =>
    row >= 0 && row < size && col >= 0 && col < size && code.isDark(row, col);
  const lines: string[] = [];
  for (let row = -QUIET_ZONE; row < size + QUIET_ZONE; row += 2) {
    let line = COLORS;
    for (let col = -QUIET_ZONE; col < size + QUIET_ZONE; col++) {
      const top = dark(row, col);
      const bottom = dark(row + 1, col);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line + RESET);
  }
  return lines.join("\n");
}
