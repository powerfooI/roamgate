import type { IBufferLine, ILink, Terminal } from "@xterm/xterm";
import { terminalLinkModifierMatches } from "./shortcutPreferences";
import {
  findTerminalHttpLinks,
  sanitizeTerminalHttpUrl,
  terminalFileUriPath,
} from "./terminalLinks";
import {
  findTerminalFileLinkCandidates,
  MAX_CANDIDATES_PER_LINE,
  type TerminalFileLinkCandidate,
  type TextRange,
} from "./terminalFileLinks";

const MAX_CONTEXT_CELLS = 16_384;
const MAX_INFERRED_JOINS = 8;
const PATH_EDGE = /^[A-Za-z0-9._~:@%+=,/-]$/;
type Position = { x: number; y: number };
type CellSpan = { start: Position; end: Position };

function lineTextWithCells(line: IBufferLine, cols: number, y: number) {
  const reusable = line.getCell(0);
  let text = "";
  const cells: CellSpan[] = [];
  for (let x = 0; x < Math.min(line.length, cols); x++) {
    const cell = line.getCell(x, reusable);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    const span = {
      start: { x: x + 1, y },
      end: { x: Math.min(cols, x + cell.getWidth()), y },
    };
    for (let i = 0; i < chars.length; i++) cells.push(span);
    text += chars;
  }
  return { text, cells, wrapped: line.isWrapped };
}

/** Reconstruct logical text while retaining xterm's cell-based coordinates. */
function readLinkContext(
  term: Terminal,
  row: number,
  inferContinuations: boolean,
) {
  const rows = new Map<number, ReturnType<typeof lineTextWithCells>>();
  const read = (y: number) => {
    if (rows.has(y)) return rows.get(y);
    const line = term.buffer.active.getLine(y - 1);
    if (!line) return undefined;
    const value = lineTextWithCells(line, term.cols, y);
    rows.set(y, value);
    return value;
  };
  const joins = (y: number) => {
    const previous = read(y - 1);
    const next = read(y);
    if (!previous || !next) return false;
    if (next.wrapped) return true;
    // Screen repaints have no soft-wrap metadata. TUI applications also wrap
    // prose with indentation/padding. These joins are only file candidates:
    // they must resolve to an existing file before becoming a link.
    return (
      inferContinuations &&
      !/https?:\/\/\S*$/i.test(previous.text.trimEnd()) &&
      PATH_EDGE.test(previous.text.trimEnd().slice(-1)) &&
      PATH_EDGE.test(next.text.trimStart().slice(0, 1))
    );
  };
  if (term.cols < 1 || term.cols > MAX_CONTEXT_CELLS || !read(row))
    return undefined;
  let first = row;
  let last = row;
  const withinBudget = () =>
    (last - first + 1) * term.cols <= MAX_CONTEXT_CELLS;
  let inferred = 0;
  while (first > 1 && joins(first)) {
    if (!read(first)!.wrapped && inferred++ >= MAX_INFERRED_JOINS) break;
    first--;
    if (!withinBudget()) return undefined;
  }
  inferred = 0;
  while (joins(last + 1)) {
    if (!read(last + 1)!.wrapped && inferred++ >= MAX_INFERRED_JOINS) break;
    last++;
    if (!withinBudget()) return undefined;
  }
  let text = "";
  const cells: CellSpan[] = [];
  const segments: TextRange[] = [];
  let segmentStart = 0;
  for (let y = first; y <= last; y++) {
    const line = read(y)!;
    const inferredBefore = y > first && !line.wrapped;
    const inferredAfter = y < last && !read(y + 1)!.wrapped;
    if (inferredBefore) {
      segments.push({ start: segmentStart, end: text.length });
      segmentStart = text.length;
    }
    const start = inferredBefore
      ? line.text.length - line.text.trimStart().length
      : 0;
    let end = inferredAfter ? line.text.trimEnd().length : line.text.length;
    // Wide glyphs and resizes can leave null padding before a soft wrap.
    // Remove only empty cells; explicit spaces remain token boundaries.
    if (y < last && read(y + 1)!.wrapped) {
      const source = term.buffer.active.getLine(y - 1)!;
      while (
        end > start &&
        !source.getCell(line.cells[end - 1]!.start.x - 1)?.getChars()
      )
        end--;
    }
    text += line.text.slice(start, end);
    cells.push(...line.cells.slice(start, end));
  }
  segments.push({ start: segmentStart, end: text.length });
  return { text, cells, segments };
}

function overlaps(a: TextRange, b: TextRange) {
  return a.start < b.end && a.end > b.start;
}

export type TerminalTouchLink =
  | { kind: "url"; value: string }
  | { kind: "file"; value: string };

export type TerminalResolvedLink = {
  /** Untrusted OSC8 target from the displayed cell, never its visible label. */
  uri?: string | null;
  url: string | null;
  regions: { row: number; start_col: number; end_col: number }[];
};

export function registerTerminalLinkProvider(
  term: Terminal,
  onPreviewPath?: (path: string, event: MouseEvent) => void,
  resolvePaths?: (paths: string[]) => Promise<Map<string, string>>,
  inferContinuations: () => boolean = () => false,
  upstream?: {
    state: () => unknown;
    resolve: (
      row: number,
      col: number,
      touch?: boolean,
    ) => Promise<TerminalResolvedLink | null>;
  },
) {
  let disposed = false;
  let requestGeneration = 0;
  type TargetLink = ILink & { target: TerminalTouchLink };
  // xterm keeps its hovered link private. Track it so a modifier click can
  // activate on mousedown, before mouse reporting forwards it to the app.
  let hovered: TargetLink | null = null;
  const track = (link: TargetLink) => {
    const { hover, leave } = link;
    link.hover = (event, text) => {
      hovered = link;
      hover?.(event, text);
    };
    link.leave = (event, text) => {
      if (hovered === link) hovered = null;
      leave?.(event, text);
    };
    return link;
  };
  const provideLinks = (
    bufferLineNumber: number,
    reply: (links: TargetLink[] | undefined) => void,
    touch?: { col: number; current: () => boolean },
  ) => {
    const generation = touch ? requestGeneration : ++requestGeneration;
    const requestCurrent = () =>
      touch ? touch.current() : generation === requestGeneration;
    // xterm stores replies in its current row cache, even for older requests.
    const callback = (links: TargetLink[] | undefined) => {
      if (touch) reply(links);
      else if (!disposed && requestCurrent()) reply(links?.map(track));
    };
    const activeBuffer = term.buffer.active;
    const columnCount = term.cols;
    const rowCount = term.rows;
    const viewport = activeBuffer.viewportY;
    const state = upstream?.state();
    const infer = inferContinuations();
    const context = readLinkContext(term, bufferLineNumber, infer);
    if (!context || state === null) {
      callback(undefined);
      return;
    }
    const snapshot = JSON.stringify(context);
    const { text, cells, segments } = context;
    const isCurrent = () =>
      !disposed &&
      requestCurrent() &&
      term.buffer.active === activeBuffer &&
      term.cols === columnCount &&
      term.rows === rowCount &&
      activeBuffer.viewportY === viewport &&
      upstream?.state() === state &&
      inferContinuations() === infer &&
      JSON.stringify(readLinkContext(term, bufferLineNumber, infer)) ===
        snapshot;
    const hover = () => {
      // Inactive row caches survive repaint. Reject their actions and ask
      // xterm to reread now that this stale link is active again.
      if (!isCurrent())
        queueMicrotask(() => {
          if (!disposed) term.refresh(0, term.rows - 1);
        });
    };
    const rangeFor = (span: TextRange) => {
      const start = cells[span.start]?.start;
      const end = cells[span.end - 1]?.end;
      return start &&
        end &&
        start.y <= bufferLineNumber &&
        end.y >= bufferLineNumber
        ? { start, end }
        : undefined;
    };
    const links: TargetLink[] = [];
    // HTTP links use only real soft wraps. Heuristic joins cannot verify a URL.
    for (const segment of segments) {
      for (const match of findTerminalHttpLinks(
        text.slice(segment.start, segment.end),
      )) {
        const range = rangeFor({
          start: segment.start + match.start,
          end: segment.start + match.end,
        });
        if (!range || (infer && range.end.x >= columnCount - 1)) continue;
        links.push({
          range,
          hover,
          text: match.url,
          target: { kind: "url", value: match.url },
          activate(event, raw) {
            event.preventDefault();
            if (!isCurrent() || !terminalLinkModifierMatches(event)) return;
            const url = sanitizeTerminalHttpUrl(raw);
            if (url) {
              term.clearSelection?.();
              window.open(url, "_blank", "noopener,noreferrer");
            }
          },
        });
      }
    }
    const candidates: Array<TerminalFileLinkCandidate & { inferred: boolean }> =
      [];
    if (onPreviewPath) {
      // Exclude whole URLs as well as the individual row forms so a wrapped
      // URL's path fragment never becomes a local file link.
      const excluded = findTerminalHttpLinks(text);
      const add = (part: TextRange) => {
        for (const match of findTerminalFileLinkCandidates(
          text.slice(part.start, part.end),
        )) {
          const candidate = {
            ...match,
            start: part.start + match.start,
            end: part.start + match.end,
          };
          if (
            !rangeFor(candidate) ||
            excluded.some((span) => overlaps(candidate, span))
          )
            continue;
          if (
            candidates.some(
              (span) =>
                span.start === candidate.start && span.end === candidate.end,
            )
          )
            continue;
          candidates.push({
            ...candidate,
            inferred: segments.some(
              (segment) =>
                candidate.start < segment.end && candidate.end > segment.end,
            ),
          });
        }
      };
      add({ start: 0, end: text.length });
      if (segments.length > 1) {
        // A path may end before another prose row or start after one. Try
        // complete segment spans around the requested row, not just the
        // longest guessed token and individual fragments.
        for (let first = 0; first < segments.length; first++) {
          for (let last = first; last < segments.length; last++) {
            const span = {
              start: segments[first]!.start,
              end: segments[last]!.end,
            };
            if (rangeFor(span)) add(span);
          }
        }
      }
    }
    // Prefer the complete existing path; retain standalone row links when a
    // speculative join does not resolve. Validate ambiguous absolute fragments
    // too, instead of making a known partial path immediately clickable.
    candidates.sort((a, b) => b.end - b.start - (a.end - a.start));
    const needsResolution = (candidate: (typeof candidates)[number]) =>
      !candidate.absolute ||
      candidate.inferred ||
      candidates.some((other) => other.inferred && overlaps(candidate, other));
    const pending = candidates.filter(needsResolution);
    const finish = (resolved = new Map<string, string>()) => {
      if (disposed) {
        if (touch) callback(undefined);
        return;
      }
      if (!isCurrent()) {
        callback(undefined);
        return;
      }
      const accepted: TextRange[] = [];
      for (const candidate of candidates) {
        const path = needsResolution(candidate)
          ? resolved.get(candidate.path)
          : candidate.path;
        if (!path || accepted.some((span) => overlaps(candidate, span)))
          continue;
        accepted.push(candidate);
        links.push({
          range: rangeFor(candidate)!,
          hover,
          text: candidate.path,
          target: { kind: "file", value: path },
          activate(event) {
            event.preventDefault();
            if (isCurrent() && terminalLinkModifierMatches(event)) {
              term.clearSelection?.();
              onPreviewPath?.(path, event);
            }
          },
        });
      }
      if (!upstream) {
        callback(links.length ? links : undefined);
        return;
      }
      // Probe URL starts and one continuation cell, never every terminal cell.
      const row = bufferLineNumber - 1 - (viewport ?? 0);
      const rowLine = activeBuffer.getLine(bufferLineNumber - 1);
      const rowText = rowLine
        ? lineTextWithCells(rowLine, columnCount, bufferLineNumber)
        : null;
      const first = rowText?.text.search(/\S/) ?? -1;
      const columns = new Set<number>();
      const rowUrls = findTerminalHttpLinks(rowText?.text ?? "");
      // A complete visible URL is already authoritative. Probing it remotely
      // can replace its trimmed punctuation with a wider region, or lose every
      // reply while a TUI timer repaints. Reserve RPCs for wraps/clipped edges.
      const previousLine = activeBuffer.getLine(bufferLineNumber - 2);
      const continuation =
        first === 0 &&
        previousLine &&
        lineTextWithCells(previousLine, columnCount, bufferLineNumber - 1)
          .text.slice(-2)
          .trim();
      if (first >= 0 && (rowUrls.length === 0 || continuation))
        columns.add(rowText!.cells[first]!.start.x - 1);
      for (const link of rowUrls) {
        const col = rowText!.cells[link.start]!.start.x - 1;
        // Sanitization can hide an unclosed suffix at the screen edge. Require
        // a raw token boundary, leaving room for a possible wide-glyph spacer.
        // An interior suffix like part/http://x.test has no proven left edge.
        // Leading indentation may be an application's own wrapping boundary.
        const whitespace = rowText!.text.slice(link.end).search(/\s/);
        const complete =
          /(?:^|\s)[("'`[{<]*$/.test(rowText!.text.slice(0, link.start)) &&
          whitespace >= 0 &&
          rowText!.cells[link.end + whitespace]!.start.x < columnCount &&
          links.some(
            (local) =>
              local.target.kind === "url" &&
              local.range.start.y === bufferLineNumber &&
              local.range.end.y === bufferLineNumber &&
              local.range.start.x === col + 1 &&
              local.range.end.x < columnCount - 1 &&
              link.start > first,
          );
        if (!complete) columns.add(col);
      }
      if (touch) {
        columns.clear();
        columns.add(touch.col);
      }
      const resolve = async () => {
        const resolved: TerminalResolvedLink[] = [];
        for (const col of [...columns].slice(0, MAX_CANDIDATES_PER_LINE)) {
          if (!isCurrent()) {
            callback(undefined);
            return;
          }
          if (
            resolved.some((link) =>
              link.regions.some(
                (r) => r.row === row && r.start_col <= col && r.end_col >= col,
              ),
            )
          )
            continue;
          try {
            const link = await upstream.resolve(row, col, !!touch);
            if (touch && link && "uri" in link) {
              if (!isCurrent()) {
                callback(undefined);
                return;
              }
              const uri = link.uri ?? "";
              const path = terminalFileUriPath(uri);
              const url = sanitizeTerminalHttpUrl(uri);
              const target: TerminalTouchLink | null = path
                ? { kind: "file", value: path }
                : url && url === uri
                  ? { kind: "url", value: url }
                  : null;
              callback(
                target
                  ? [
                      {
                        text: uri,
                        target,
                        range: {
                          start: { x: col + 1, y: bufferLineNumber },
                          end: { x: col + 1, y: bufferLineNumber },
                        },
                        activate() {},
                      },
                    ]
                  : undefined,
              );
              return;
            }
            if (link) resolved.push(link);
          } catch {
            if (touch) {
              callback(undefined);
              return;
            }
            break;
          }
        }
        if (!isCurrent()) {
          callback(undefined);
          return;
        }
        const regions = resolved.flatMap((link) => link.regions);
        const accepted = links.filter(
          (link) =>
            !regions.some((r) => {
              const y = r.row + (viewport ?? 0) + 1;
              return (
                link.range.start.y <= y &&
                link.range.end.y >= y &&
                (link.range.start.y < y ||
                  link.range.start.x <= r.end_col + 1) &&
                (link.range.end.y > y || link.range.end.x >= r.start_col + 1)
              );
            }),
        );
        for (const link of resolved) {
          if (!link.url || sanitizeTerminalHttpUrl(link.url) !== link.url)
            continue;
          if (!link.regions.some((region) => region.row === row)) continue;
          // The bridge validates contiguous regions. Keep one logical range so
          // xterm underlines every wrapped row, whichever row is hovered.
          const first = link.regions[0]!;
          const last = link.regions[link.regions.length - 1]!;
          accepted.push({
            text: link.url,
            target: { kind: "url", value: link.url },
            hover,
            range: {
              start: {
                x: first.start_col + 1,
                y: first.row + (viewport ?? 0) + 1,
              },
              end: {
                x: last.end_col + 1,
                y: last.row + (viewport ?? 0) + 1,
              },
            },
            activate(event) {
              event.preventDefault();
              if (isCurrent() && terminalLinkModifierMatches(event)) {
                term.clearSelection?.();
                window.open(link.url!, "_blank", "noopener,noreferrer");
              }
            },
          });
        }
        callback(accepted.length ? accepted : undefined);
      };
      void resolve();
    };
    if (!pending.length || !resolvePaths) {
      finish();
      return;
    }
    const resolveAll = async () => {
      const paths = [...new Set(pending.map((candidate) => candidate.path))];
      const resolved = new Map<string, string>();
      // Contexts can exceed the per-line cache and server batch limit.
      for (let i = 0; i < paths.length; i += MAX_CANDIDATES_PER_LINE) {
        if (!isCurrent()) break;
        const batch = await resolvePaths(
          paths.slice(i, i + MAX_CANDIDATES_PER_LINE),
        );
        for (const [candidate, path] of batch) resolved.set(candidate, path);
      }
      return resolved;
    };
    void resolveAll().then(finish, () => finish());
  };
  const registration = term.registerLinkProvider({ provideLinks });
  return {
    /** Independent lookup: never replaces xterm's pending hover row generation. */
    resolveTouch(row: number, col: number, current: () => boolean) {
      const y = term.buffer.active.viewportY + row + 1;
      return new Promise<TerminalTouchLink | null>((reply) => {
        provideLinks(
          y,
          (links) => {
            const link = links?.find(
              ({ range }) =>
                range.start.y <= y &&
                range.end.y >= y &&
                (range.start.y < y || range.start.x <= col + 1) &&
                (range.end.y > y || range.end.x >= col + 1),
            );
            reply(current() ? (link?.target ?? null) : null);
          },
          { col, current },
        );
      });
    },
    /** Activates the link under the pointer; false when none is hovered. */
    activateHovered(event: MouseEvent) {
      if (!hovered) return false;
      hovered.activate(event, hovered.text);
      return true;
    },
    dispose() {
      disposed = true;
      hovered = null;
      registration.dispose();
    },
  };
}
