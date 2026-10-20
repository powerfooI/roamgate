export function shortId(id: string): string {
  // "w1:t1" -> "t1", "w1:p2" -> "p2"
  const i = id.indexOf(":");
  return i === -1 ? id : id.slice(i + 1);
}

export function prefersReducedMotion(): boolean {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}

export function cn(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(" ");
}

export function agentClass(status?: string): string {
  switch ((status ?? "unknown").toLowerCase()) {
    case "working":
      return "badge badge-working";
    case "done":
      return "badge badge-done";
    case "blocked":
      return "badge badge-blocked";
    case "idle":
      return "badge badge-idle";
    default:
      return "badge badge-unknown";
  }
}

export function basename(path?: string): string {
  if (!path) return "";
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? trimmed : trimmed.slice(i + 1) || trimmed;
}

// Remove ANSI escape sequences so colored TUIs render as clean plain text.
const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/* ------------------------------------------------------------------ *
 * ANSI SGR → HTML (colors + basic text attributes) for terminal output
 * ------------------------------------------------------------------ */

// 16-color ANSI palette tuned for the dark app background.
const PALETTE: string[] = [
  "#545862", // 0  black (dark gray so it stays visible)
  "#ff6b6b", // 1  red
  "#51cf66", // 2  green
  "#f0c453", // 3  yellow
  "#6ea8ff", // 4  blue
  "#c678dd", // 5  magenta
  "#56b6c2", // 6  cyan
  "#abb2bf", // 7  white
  "#6b6f7d", // 8  bright black
  "#ff8a8a", // 9  bright red
  "#7ee081", // 10 bright green
  "#f6d177", // 11 bright yellow
  "#91b9ff", // 12 bright blue
  "#d99cee", // 13 bright magenta
  "#7ed0da", // 14 bright cyan
  "#ffffff", // 15 bright white
];

function color256(n: number): string {
  if (n < 16) return PALETTE[n];
  if (n < 232) {
    const v = n - 16;
    const r = Math.floor(v / 36);
    const g = Math.floor((v % 36) / 6);
    const b = v % 6;
    const conv = (x: number) => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${conv(r)},${conv(g)},${conv(b)})`;
  }
  const gray = 8 + (n - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

interface TermStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

function clearStyle(s: TermStyle) {
  s.fg = s.bg = undefined;
  s.bold = s.dim = s.italic = s.underline = undefined;
}

function applySgr(params: string, s: TermStyle) {
  const codes = params.split(";").map((p) => (p === "" ? 0 : Number(p)));
  for (let k = 0; k < codes.length; k++) {
    const n = codes[k];
    if (n === 0) clearStyle(s);
    else if (n === 1) s.bold = true;
    else if (n === 2) s.dim = true;
    else if (n === 3) s.italic = true;
    else if (n === 4) s.underline = true;
    else if (n === 22) {
      s.bold = false;
      s.dim = false;
    } else if (n === 23) s.italic = false;
    else if (n === 24) s.underline = false;
    else if (n >= 30 && n <= 37) s.fg = PALETTE[n - 30];
    else if (n === 39) s.fg = undefined;
    else if (n >= 40 && n <= 47) s.bg = PALETTE[n - 40];
    else if (n === 49) s.bg = undefined;
    else if (n >= 90 && n <= 97) s.fg = PALETTE[n - 90 + 8];
    else if (n >= 100 && n <= 107) s.bg = PALETTE[n - 100 + 8];
    else if (n === 38 || n === 48) {
      const mode = codes[k + 1];
      let col: string | undefined;
      if (mode === 5 && codes[k + 2] != null) {
        col = color256(codes[k + 2]);
        k += 2;
      } else if (mode === 2 && codes[k + 4] != null) {
        col = `rgb(${codes[k + 2]},${codes[k + 3]},${codes[k + 4]})`;
        k += 4;
      }
      if (col) {
        if (n === 38) s.fg = col;
        else s.bg = col;
      }
    }
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function styleToCss(s: TermStyle): string {
  const parts: string[] = [];
  if (s.fg) parts.push(`color:${s.fg}`);
  if (s.bg) parts.push(`background:${s.bg}`);
  if (s.bold) parts.push("font-weight:700");
  if (s.dim) parts.push("opacity:.6");
  if (s.italic) parts.push("font-style:italic");
  if (s.underline) parts.push("text-decoration:underline");
  return parts.join(";");
}

function wrap(text: string, s: TermStyle): string {
  const safe = escHtml(text);
  const css = styleToCss(s);
  return css ? `<span style="${css}">${safe}</span>` : safe;
}

/**
 * Convert terminal text (with ANSI escape codes) into HTML with colored spans.
 * Non-SGR control sequences are stripped; text is HTML-escaped.
 */
export function ansiToHtml(input: string): string {
  const lines = input.split("\n");
  const style: TermStyle = {};
  const out: string[] = [];

  for (const line of lines) {
    if (isRuleLine(line)) {
      // Replace long horizontal-rule lines (agent turn separators) with a
      // CSS line that auto-fits the container width instead of overflowing.
      const col = ruleColor(line, style) ?? "#3a4252";
      renderWithState(line, style); // carry any SGR state the line contains
      out.push(`<span class="hr-line" style="--hr:${col}"></span>`);
    } else {
      const r = renderWithState(line, style);
      out.push(r.html);
    }
  }
  return out.join("\n");
}

// A line is treated as a horizontal rule only when its visible content is
// purely rule characters + whitespace (so we never swallow real text).
const HORIZONTAL_RE = /[─━═―‑‒–—−]/;

function isRuleLine(line: string): boolean {
  const vis = line.replace(/\x1b\[[0-9:;<=>?]*[A-Za-z]/g, "").trim();
  if (vis.length < 8) return false;
  if (!/^[─━═―‑‒–—−\s]+$/.test(vis)) return false;
  let n = 0;
  for (const ch of vis) if (HORIZONTAL_RE.test(ch)) n++;
  return n >= 8;
}

// Color active at the first rule character (the dashes usually inherit it).
function ruleColor(line: string, initial: TermStyle): string | undefined {
  const s: TermStyle = { ...initial };
  let i = 0;
  const len = line.length;
  while (i < len) {
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      let j = i + 2;
      while (j < len && /[0-9:;<=>?]/.test(line[j])) j++;
      if (line[j] === "m") applySgr(line.slice(i + 2, j), s);
      i = j + 1;
    } else {
      if (HORIZONTAL_RE.test(line[i])) return s.fg;
      i++;
    }
  }
  return s.fg;
}

// Render `input` into HTML, mutating `style` to carry SGR state across lines.
function renderWithState(
  input: string,
  style: TermStyle,
): { html: string; style: TermStyle } {
  let out = "";
  let i = 0;
  let textStart = 0;
  const len = input.length;

  while (i < len) {
    const c = input[i];
    if (c === "\x1b" && input[i + 1] === "[") {
      if (i > textStart) out += wrap(input.slice(textStart, i), style);
      let j = i + 2;
      // CSI params are in 0x30–0x3F, intermediates 0x20–0x2F, final byte 0x40–0x7E.
      while (j < len && /[0-9:;<=>?]/.test(input[j])) j++;
      const cmd = input[j] ?? "";
      const params = input.slice(i + 2, j);
      if (cmd === "m") applySgr(params, style);
      // other CSI sequences (cursor movement, erase, etc.) are dropped
      i = j + 1;
      textStart = i;
    } else if (c === "\x1b") {
      if (i > textStart) out += wrap(input.slice(textStart, i), style);
      // Skip a lone ESC + following char (e.g. ESC ( B, ESC ] ... ST).
      i += input[i + 1] === "]" ? len : 2;
      textStart = i;
    } else {
      i++;
    }
  }
  if (textStart < len) out += wrap(input.slice(textStart), style);
  return { html: out, style };
}
