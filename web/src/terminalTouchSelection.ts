/// <reference lib="es2022.intl" />
import type { Terminal } from "@xterm/xterm";

export const TERMINAL_LONG_PRESS_MS = 450;
const SLOP = 8;
type Point = { x: number; y: number };

/** Public buffer cells preserve graphemes and omit only wide-wrap filler. */
export function terminalSelectedText(term: Terminal): string {
  const range = term.getSelectionPosition();
  if (!range) return "";
  let text = "";
  for (let y = range.start.y; y <= range.end.y; y++) {
    const line = term.buffer.active.getLine(y);
    if (!line || (y === range.end.y && range.end.x === 0)) break;
    const next = term.buffer.active.getLine(y + 1);
    let start = y === range.start.y ? range.start.x : 0;
    let end = y === range.end.y ? range.end.x : term.cols;
    if (start > 0 && line.getCell(start)?.getWidth() === 0) start--;
    if (end < term.cols && line.getCell(end)?.getWidth() === 0) end++;
    if (
      next?.isWrapped &&
      next.getCell(0)?.getWidth() === 2 &&
      end === term.cols &&
      line.getCell(end - 1)?.getCode() === 0 &&
      line.getCell(end - 1)?.getWidth() === 1
    )
      end--;
    const continues = y < range.end.y && next?.isWrapped;
    text += line.translateToString(!continues, start, end);
    if (
      y < range.end.y &&
      !continues &&
      !(y + 1 === range.end.y && range.end.x === 0)
    )
      text += "\n";
  }
  return text;
}

/** Touch ranges stay in the displayed viewport; scroll before selecting. */
export class TerminalTouchSelection {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private origin: Point | null = null;
  private intent = 0;
  private reserved = false;
  private endpoints: [number, number] | null = null;
  active = false;

  constructor(
    private term: Terminal,
    private options: {
      begin: (activate: () => void) => void;
      changed: () => void;
      release: () => void;
    },
  ) {}

  private bounds() {
    return this.term.element
      ?.querySelector(".xterm-screen")
      ?.getBoundingClientRect();
  }

  private cell(point: Point, boundary = false) {
    const rect = this.bounds();
    if (!rect?.width || !rect.height) return 0;
    const row = Math.max(
      0,
      Math.min(
        this.term.rows - 1,
        Math.floor(((point.y - rect.top) * this.term.rows) / rect.height),
      ),
    );
    const col = Math.max(
      0,
      Math.min(
        this.term.cols - (boundary ? 0 : 1),
        (boundary ? Math.round : Math.floor)(
          ((point.x - rect.left) * this.term.cols) / rect.width,
        ),
      ),
    );
    return row * this.term.cols + col;
  }

  start(point: Point) {
    this.cancelPending();
    if (this.active) return;
    this.origin = point;
    const intent = this.intent;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reserved = true;
      this.options.begin(() => {
        if (intent !== this.intent || !this.origin) return;
        this.selectWord(point);
      });
    }, TERMINAL_LONG_PRESS_MS);
  }

  move(point: Point) {
    if (
      this.origin &&
      Math.hypot(point.x - this.origin.x, point.y - this.origin.y) > SLOP
    )
      this.cancelPending();
  }

  cancelPending() {
    if (this.reserved && !this.active) this.options.release();
    this.reserved = false;
    this.intent++;
    this.origin = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private selectWord(point: Point) {
    const { term } = this;
    const hit = this.cell(point);
    let first = Math.floor(hit / term.cols),
      last = first;
    const buffer = term.buffer.active,
      base = buffer.viewportY;
    while (first > 0 && buffer.getLine(base + first)?.isWrapped) first--;
    while (last + 1 < term.rows && buffer.getLine(base + last + 1)?.isWrapped)
      last++;
    let text = "",
      offset = 0;
    const cells: {
      start: number;
      end: number;
      position: number;
      width: number;
    }[] = [];
    for (let row = first; row <= last; row++) {
      const line = buffer.getLine(base + row);
      for (let col = 0; col < term.cols; col++) {
        const cell = line?.getCell(col),
          width = cell?.getWidth() ?? 1;
        if (width === 0) continue;
        if (
          col === term.cols - 1 &&
          cell?.getCode() === 0 &&
          buffer.getLine(base + row + 1)?.isWrapped &&
          buffer
            .getLine(base + row + 1)
            ?.getCell(0)
            ?.getWidth() === 2
        )
          continue;
        const chars = cell?.getChars() || " ";
        const position = row * term.cols + col;
        if (hit >= position && hit < position + width) offset = text.length;
        cells.push({
          start: text.length,
          end: text.length + chars.length,
          position,
          width,
        });
        text += chars;
      }
    }
    const segment = [
      ...new Intl.Segmenter(undefined, { granularity: "word" }).segment(text),
    ].find(
      (part) =>
        offset >= part.index && offset < part.index + part.segment.length,
    );
    if (!segment || !segment.segment.trim()) {
      this.options.release();
      return;
    }
    const selected = cells.filter(
      (cell) =>
        cell.end > segment.index &&
        cell.start < segment.index + segment.segment.length,
    );
    const end = selected[selected.length - 1];
    this.endpoints = [selected[0].position, end.position + end.width];
    this.active = true;
    this.highlight();
  }

  drag(index: 0 | 1, point: Point) {
    this.adjust(index, this.cell(point, true));
  }

  nudge(index: 0 | 1, delta: number) {
    if (this.endpoints) this.adjust(index, this.endpoints[index] + delta);
  }

  private adjust(index: 0 | 1, value: number) {
    if (!this.endpoints) return;
    value = Math.max(0, Math.min(this.term.rows * this.term.cols, value));
    const row = Math.floor(value / this.term.cols),
      col = value % this.term.cols;
    if (
      this.term.buffer.active
        .getLine(this.term.buffer.active.viewportY + row)
        ?.getCell(col)
        ?.getWidth() === 0
    )
      value += value > this.endpoints[index] ? 1 : -1;
    if (value === this.endpoints[1 - index]) return;
    this.endpoints[index] = value;
    this.highlight();
  }

  private highlight() {
    if (!this.endpoints) return;
    const [start, end] = [...this.endpoints].sort((a, b) => a - b);
    this.term.select(
      start % this.term.cols,
      this.term.buffer.active.viewportY + Math.floor(start / this.term.cols),
      end - start,
    );
    this.options.changed();
  }

  get handles() {
    const rect = this.bounds();
    if (!rect || !this.endpoints) return [];
    return this.endpoints.map((value, index) => {
      const end = value > this.endpoints![1 - index];
      const row = Math.floor((value - (end ? 1 : 0)) / this.term.cols);
      const col = end
        ? ((value - 1) % this.term.cols) + 1
        : value % this.term.cols;
      return {
        index: index as 0 | 1,
        label: end ? "Selection end" : "Selection start",
        x: rect.left + (col * rect.width) / this.term.cols,
        markerY:
          rect.top + ((row + (end ? 1 : 0)) * rect.height) / this.term.rows,
        cellY: rect.top + ((row + 0.5) * rect.height) / this.term.rows,
        y:
          rect.top +
          ((row + (end ? 1 : 0)) * rect.height) / this.term.rows +
          (end ? 8 : 0),
      };
    });
  }

  reset() {
    this.cancelPending();
    this.active = false;
    this.endpoints = null;
    this.term.clearSelection();
    this.options.release();
    this.options.changed();
  }
}
