import { connectionStorageKey } from "./connectionStorage";
import type { GitDiffKind, Pane } from "./types";
import { resourceOwnerKey, type ResourceScope } from "./workspaceResource";

export type ReviewAnnotationSide = "old" | "new";

type ReviewAnnotationBase = {
  id: string;
  quote: string;
  comment: string;
  createdAt: number;
  stale?: boolean;
};

export type DiffReviewAnnotation = ReviewAnnotationBase & {
  source: "diff";
  path: string;
  kind: GitDiffKind;
  side: ReviewAnnotationSide;
  line: number;
  endSide?: ReviewAnnotationSide;
  endLine?: number;
  hunk: string;
};

export type FileLineReviewAnnotation = ReviewAnnotationBase & {
  source: "file";
  path: string;
  anchor: "line";
  line: number;
  endLine?: number;
};

export type MarkdownReviewAnnotation = ReviewAnnotationBase & {
  source: "file";
  path: string;
  anchor: "quote";
  section: string[];
};

export type TerminalReviewAnnotation = ReviewAnnotationBase & {
  source: "terminal";
  anchor: "quote";
  paneId: string;
  title: string;
};

export type ReviewAnnotation =
  | TerminalReviewAnnotation
  | DiffReviewAnnotation
  | FileLineReviewAnnotation
  | MarkdownReviewAnnotation;

export type NewReviewAnnotation =
  | Omit<TerminalReviewAnnotation, "id" | "createdAt" | "stale">
  | Omit<DiffReviewAnnotation, "id" | "createdAt" | "stale">
  | Omit<FileLineReviewAnnotation, "id" | "createdAt" | "stale">
  | Omit<MarkdownReviewAnnotation, "id" | "createdAt" | "stale">;

export type ParsedDiffLine = {
  side: ReviewAnnotationSide;
  line: number;
  quote: string;
  hunk: string;
};

export type DiffReviewSelectionRange = {
  start: number;
  side?: "deletions" | "additions";
  end: number;
  endSide?: "deletions" | "additions";
};

export type DiffReviewSelection = {
  side: ReviewAnnotationSide;
  line: number;
  endSide?: ReviewAnnotationSide;
  endLine?: number;
  quote: string;
  hunk: string;
};

type ParsedDiffRow = {
  old?: ParsedDiffLine;
  new?: ParsedDiffLine;
};

const ANNOTATION_STORAGE_PREFIX = "workspaceAnnotations:v1:";
const MAX_STORED_ANNOTATIONS = 200;
const MAX_PATH_LENGTH = 4_096;
export const MAX_QUOTE_LENGTH = 20_000;
const MAX_COMMENT_LENGTH = 10_000;
const MAX_HUNK_LENGTH = 1_000;
const MAX_SECTION_DEPTH = 12;

export function annotationDraftStorageKey(scope: ResourceScope) {
  return connectionStorageKey(
    scope.connectionId,
    `${ANNOTATION_STORAGE_PREFIX}${resourceOwnerKey(scope)}`,
  );
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function finitePositiveLine(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

export function parseReviewAnnotation(value: unknown): ReviewAnnotation | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const id = boundedString(candidate.id, 200);
  const path = boundedString(candidate.path, MAX_PATH_LENGTH);
  const quote = boundedString(candidate.quote, MAX_QUOTE_LENGTH);
  const comment = boundedString(candidate.comment, MAX_COMMENT_LENGTH);
  const createdAt =
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt) &&
    candidate.createdAt >= 0
      ? candidate.createdAt
      : null;
  if (!id || quote === null || comment === null || createdAt === null) {
    return null;
  }
  const base = {
    id,
    quote,
    comment,
    createdAt,
    ...(candidate.stale === true ? { stale: true } : {}),
  };

  if (candidate.source === "terminal") {
    const paneId = boundedString(candidate.paneId, 200);
    const title = boundedString(candidate.title, 500);
    if (
      !paneId?.trim() ||
      !title?.trim() ||
      !quote.trim() ||
      candidate.anchor !== "quote"
    )
      return null;
    return { ...base, source: "terminal", anchor: "quote", paneId, title };
  }
  if (!path) return null;

  if (candidate.source === "diff") {
    const line = finitePositiveLine(candidate.line);
    const hunk = boundedString(candidate.hunk, MAX_HUNK_LENGTH);
    const endLine =
      candidate.endLine === undefined
        ? undefined
        : finitePositiveLine(candidate.endLine);
    const endSide =
      candidate.endSide === undefined ? undefined : candidate.endSide;
    const validKind = [
      "staged",
      "unstaged",
      "untracked",
      "conflicted",
      "branch",
      "last-step",
    ].includes(String(candidate.kind));
    if (
      line === null ||
      hunk === null ||
      !validKind ||
      (candidate.side !== "old" && candidate.side !== "new") ||
      endLine === null ||
      (endSide !== undefined && endSide !== "old" && endSide !== "new") ||
      (endSide !== undefined && endLine === undefined)
    ) {
      return null;
    }
    return {
      ...base,
      path,
      source: "diff",
      kind: candidate.kind as GitDiffKind,
      side: candidate.side,
      line,
      ...(endLine === undefined ? {} : { endLine }),
      ...(endSide === undefined ? {} : { endSide }),
      hunk,
    };
  }

  if (candidate.source !== "file") return null;
  if (candidate.anchor === "line") {
    const line = finitePositiveLine(candidate.line);
    const endLine =
      candidate.endLine === undefined
        ? undefined
        : finitePositiveLine(candidate.endLine);
    if (
      line === null ||
      endLine === null ||
      (endLine !== undefined && endLine < line)
    ) {
      return null;
    }
    return {
      ...base,
      path,
      source: "file",
      anchor: "line",
      line,
      ...(endLine === undefined ? {} : { endLine }),
    };
  }
  if (candidate.anchor !== "quote" || !Array.isArray(candidate.section)) {
    return null;
  }
  const section = candidate.section
    .slice(0, MAX_SECTION_DEPTH)
    .map((part) => boundedString(part, 500))
    .filter((part): part is string => part !== null && part.length > 0);
  return { ...base, path, source: "file", anchor: "quote", section };
}

export function readReviewAnnotations(
  storage: Pick<Storage, "getItem">,
  key: string,
): ReviewAnnotation[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .slice(0, MAX_STORED_ANNOTATIONS)
      .map(parseReviewAnnotation)
      .filter((item): item is ReviewAnnotation => item !== null);
  } catch {
    return [];
  }
}

export function writeReviewAnnotations(
  storage: Pick<Storage, "setItem" | "removeItem">,
  key: string,
  annotations: readonly ReviewAnnotation[],
) {
  try {
    if (annotations.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(annotations));
    return true;
  } catch {
    return false;
  }
}

function fallbackAnnotationId() {
  return `annotation-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

export function createReviewAnnotation(
  input: NewReviewAnnotation,
  createId: () => string = () =>
    globalThis.crypto?.randomUUID?.() ?? fallbackAnnotationId(),
  createdAt = Date.now(),
): ReviewAnnotation {
  return { ...input, id: createId(), createdAt } as ReviewAnnotation;
}

export function moveReviewAnnotation(
  annotations: readonly ReviewAnnotation[],
  id: string,
  delta: -1 | 1,
): ReviewAnnotation[] {
  const index = annotations.findIndex((annotation) => annotation.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= annotations.length) {
    return [...annotations];
  }
  const next = [...annotations];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function parseDiffReviewRows(patch: string): ParsedDiffRow[] {
  const result: ParsedDiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let hunk = "";

  for (const rawLine of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/.exec(rawLine);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunk = rawLine;
      continue;
    }
    if (!hunk || rawLine.startsWith("\\")) continue;
    if (rawLine.startsWith("+")) {
      result.push({
        new: {
          side: "new",
          line: newLine,
          quote: rawLine.slice(1),
          hunk,
        },
      });
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith("-")) {
      result.push({
        old: {
          side: "old",
          line: oldLine,
          quote: rawLine.slice(1),
          hunk,
        },
      });
      oldLine += 1;
      continue;
    }
    if (rawLine.startsWith(" ")) {
      const quote = rawLine.slice(1);
      result.push({
        old: { side: "old", line: oldLine, quote, hunk },
        new: { side: "new", line: newLine, quote, hunk },
      });
      oldLine += 1;
      newLine += 1;
    }
  }
  return result;
}

function parseSplitDiffReviewRows(patch: string): ParsedDiffRow[] {
  const result: ParsedDiffRow[] = [];
  let deletions: ParsedDiffLine[] = [];
  let additions: ParsedDiffLine[] = [];
  let changeHunk = "";
  const flushChanges = () => {
    const length = Math.max(deletions.length, additions.length);
    for (let index = 0; index < length; index += 1) {
      result.push({ old: deletions[index], new: additions[index] });
    }
    deletions = [];
    additions = [];
    changeHunk = "";
  };

  for (const row of parseDiffReviewRows(patch)) {
    if (row.old && row.new) {
      flushChanges();
      result.push(row);
      continue;
    }
    const line = row.old ?? row.new;
    if (!line) continue;
    if (changeHunk && changeHunk !== line.hunk) flushChanges();
    changeHunk = line.hunk;
    if (row.old) deletions.push(row.old);
    else if (row.new) additions.push(row.new);
  }
  flushChanges();
  return result;
}

export function parseDiffReviewLines(patch: string): ParsedDiffLine[] {
  return parseDiffReviewRows(patch).flatMap((row) =>
    row.old && row.new ? [row.old, row.new] : [row.old ?? row.new!],
  );
}

export function findDiffReviewLine(
  patch: string,
  side: ReviewAnnotationSide,
  line: number,
): ParsedDiffLine | null {
  return (
    parseDiffReviewLines(patch).find(
      (candidate) => candidate.side === side && candidate.line === line,
    ) ?? null
  );
}

function reviewSide(side: "deletions" | "additions" | undefined) {
  return side === "deletions" ? "old" : side === "additions" ? "new" : null;
}

function rowLine(row: ParsedDiffRow, side: ReviewAnnotationSide) {
  return side === "old" ? row.old : row.new;
}

function diffRowQuotes(row: ParsedDiffRow, diffStyle: "split" | "unified") {
  if (row.old && row.new && row.old.quote === row.new.quote) {
    return [row.old.quote];
  }
  if (diffStyle === "split") {
    return [row.old?.quote, row.new?.quote].filter(
      (quote): quote is string => quote !== undefined,
    );
  }
  return [row.old?.quote ?? row.new?.quote ?? ""];
}

export function findDiffReviewSelection(
  patch: string,
  range: DiffReviewSelectionRange,
  diffStyle: "split" | "unified" = "unified",
): DiffReviewSelection | null {
  const startSide = reviewSide(range.side);
  const endSide = reviewSide(range.endSide ?? range.side);
  if (!startSide || !endSide) return null;

  const rows =
    diffStyle === "split"
      ? parseSplitDiffReviewRows(patch)
      : parseDiffReviewRows(patch);
  const startIndex = rows.findIndex(
    (row) => rowLine(row, startSide)?.line === range.start,
  );
  const endIndex = rows.findIndex(
    (row) => rowLine(row, endSide)?.line === range.end,
  );
  if (startIndex < 0 || endIndex < 0) return null;

  if (startSide === endSide) {
    const firstLine = Math.min(range.start, range.end);
    const lastLine = Math.max(range.start, range.end);
    const selected = parseDiffReviewLines(patch).filter(
      (line) =>
        line.side === startSide &&
        line.line >= firstLine &&
        line.line <= lastLine,
    );
    if (!selected.length) return null;
    const quote = selected.map((line) => line.quote).join("\n");
    if (quote.length > MAX_QUOTE_LENGTH) return null;
    return {
      side: startSide,
      line: firstLine,
      ...(lastLine === firstLine ? {} : { endLine: lastLine }),
      quote,
      hunk: selected[0].hunk,
    };
  }

  const firstIndex = Math.min(startIndex, endIndex);
  const lastIndex = Math.max(startIndex, endIndex);
  const firstIsStart = firstIndex === startIndex;
  const firstSide = firstIsStart ? startSide : endSide;
  const lastSide = firstIsStart ? endSide : startSide;
  const first = rowLine(rows[firstIndex], firstSide);
  const last = rowLine(rows[lastIndex], lastSide);
  if (!first || !last) return null;
  const selected = rows
    .slice(firstIndex, lastIndex + 1)
    .flatMap((row) => diffRowQuotes(row, diffStyle));
  const quote = selected.join("\n");
  if (quote.length > MAX_QUOTE_LENGTH) return null;
  return {
    side: firstSide,
    line: first.line,
    endSide: lastSide,
    endLine: last.line,
    quote,
    hunk: first.hunk,
  };
}

export function diffReviewLineLabel(
  annotation: Pick<
    DiffReviewAnnotation,
    "side" | "line" | "endSide" | "endLine"
  >,
) {
  if (annotation.endLine === undefined) {
    return `${annotation.side} line ${annotation.line}`;
  }
  const endSide = annotation.endSide ?? annotation.side;
  return endSide === annotation.side
    ? `${annotation.side} lines ${annotation.line}–${annotation.endLine}`
    : `${annotation.side} line ${annotation.line} → ${endSide} line ${annotation.endLine}`;
}

function chooseNearestLine<T extends { line: number }>(
  candidates: T[],
  previousLine: number,
): T | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort(
    (left, right) =>
      Math.abs(left.line - previousLine) - Math.abs(right.line - previousLine),
  );
  if (
    sorted.length > 1 &&
    Math.abs(sorted[0].line - previousLine) ===
      Math.abs(sorted[1].line - previousLine)
  ) {
    return null;
  }
  return sorted[0];
}

function matchingWindowStarts(values: string[], wanted: string[]) {
  if (!wanted.length || wanted.length > values.length) return [];
  const result: number[] = [];
  for (let start = 0; start <= values.length - wanted.length; start += 1) {
    if (wanted.every((value, offset) => values[start + offset] === value)) {
      result.push(start);
    }
  }
  return result;
}

function pierreSide(side: ReviewAnnotationSide) {
  return side === "old" ? ("deletions" as const) : ("additions" as const);
}

function reanchorDiffRange(
  annotation: DiffReviewAnnotation,
  patch: string,
): DiffReviewAnnotation | null {
  const annotationEndLine = annotation.endLine;
  if (annotationEndLine === undefined) return null;
  const endSide = annotation.endSide ?? annotation.side;
  const styles = ["unified", "split"] as const;
  const exact = styles
    .map((diffStyle) =>
      findDiffReviewSelection(
        patch,
        {
          start: annotation.line,
          side: pierreSide(annotation.side),
          end: annotationEndLine,
          endSide: pierreSide(endSide),
        },
        diffStyle,
      ),
    )
    .find((selection) => selection?.quote === annotation.quote);
  if (exact) {
    if (!annotation.stale && exact.hunk === annotation.hunk) return annotation;
    return { ...annotation, hunk: exact.hunk, stale: false };
  }

  const wanted = annotation.quote.split("\n");
  if (annotation.side === endSide) {
    const lines = parseDiffReviewLines(patch).filter(
      (line) => line.side === annotation.side,
    );
    const starts = matchingWindowStarts(
      lines.map((line) => line.quote),
      wanted,
    );
    const candidates = starts.map((start) => ({
      line: lines[start].line,
      endLine: lines[start + wanted.length - 1].line,
      hunk: lines[start].hunk,
    }));
    const match = chooseNearestLine(candidates, annotation.line);
    return match
      ? {
          ...annotation,
          line: match.line,
          endLine: match.endLine,
          hunk: match.hunk,
          stale: false,
        }
      : null;
  }

  const candidates = styles.flatMap((diffStyle) => {
    const rows =
      diffStyle === "split"
        ? parseSplitDiffReviewRows(patch)
        : parseDiffReviewRows(patch);
    const entries = rows.flatMap((row, rowIndex) => {
      const quotes = diffRowQuotes(row, diffStyle);
      return quotes.map((quote, quoteIndex) => ({
        quote,
        quoteIndex,
        quoteCount: quotes.length,
        rowIndex,
      }));
    });
    const starts = matchingWindowStarts(
      entries.map((entry) => entry.quote),
      wanted,
    );
    return starts.flatMap((start) => {
      const firstEntry = entries[start];
      const lastEntry = entries[start + wanted.length - 1];
      if (
        firstEntry.quoteIndex !== 0 ||
        lastEntry.quoteIndex !== lastEntry.quoteCount - 1
      ) {
        return [];
      }
      const first = rowLine(rows[firstEntry.rowIndex], annotation.side);
      const last = rowLine(rows[lastEntry.rowIndex], endSide);
      return first && last
        ? [{ line: first.line, endLine: last.line, hunk: first.hunk }]
        : [];
    });
  });
  const match = chooseNearestLine(candidates, annotation.line);
  return match
    ? {
        ...annotation,
        line: match.line,
        endLine: match.endLine,
        hunk: match.hunk,
        stale: false,
      }
    : null;
}

export function reanchorDiffReviewAnnotations(
  annotations: readonly ReviewAnnotation[],
  path: string,
  kind: GitDiffKind,
  patch: string,
): ReviewAnnotation[] {
  const lines = parseDiffReviewLines(patch);
  return annotations.map((annotation) => {
    if (
      annotation.source !== "diff" ||
      annotation.path !== path ||
      annotation.kind !== kind
    ) {
      return annotation;
    }
    if (annotation.endLine !== undefined) {
      const anchored = reanchorDiffRange(annotation, patch);
      if (anchored) return anchored;
      return annotation.stale ? annotation : { ...annotation, stale: true };
    }
    const current = lines.find(
      (line) => line.side === annotation.side && line.line === annotation.line,
    );
    if (current?.quote === annotation.quote) {
      if (!annotation.stale && current.hunk === annotation.hunk)
        return annotation;
      return { ...annotation, hunk: current.hunk, stale: false };
    }
    const match = chooseNearestLine(
      lines.filter(
        (line) =>
          line.side === annotation.side && line.quote === annotation.quote,
      ),
      annotation.line,
    );
    if (!match) {
      return annotation.stale ? annotation : { ...annotation, stale: true };
    }
    return {
      ...annotation,
      line: match.line,
      hunk: match.hunk,
      stale: false,
    };
  });
}

function normalizedSearchText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function fileReviewLineLabel(
  annotation: Pick<FileLineReviewAnnotation, "line" | "endLine">,
) {
  return annotation.endLine !== undefined &&
    annotation.endLine !== annotation.line
    ? `lines ${annotation.line}-${annotation.endLine}`
    : `line ${annotation.line}`;
}

export function reanchorFileReviewAnnotations(
  annotations: readonly ReviewAnnotation[],
  path: string,
  text: string,
): ReviewAnnotation[] {
  const fileLines = text.split(/\r\n?|\n/);
  const normalizedText = normalizedSearchText(text);
  return annotations.map((annotation) => {
    if (annotation.source !== "file" || annotation.path !== path) {
      return annotation;
    }
    if (annotation.anchor === "quote") {
      const anchored =
        annotation.quote.length > 0 &&
        normalizedText.includes(normalizedSearchText(annotation.quote));
      if (anchored === !annotation.stale) return annotation;
      return { ...annotation, stale: !anchored };
    }
    const quoteLines = annotation.quote.split(/\r\n?|\n/);
    const span = (annotation.endLine ?? annotation.line) - annotation.line + 1;
    if (quoteLines.length !== span) {
      return annotation.stale ? annotation : { ...annotation, stale: true };
    }
    if (
      quoteLines.every(
        (quote, index) => fileLines[annotation.line - 1 + index] === quote,
      )
    ) {
      return annotation.stale ? { ...annotation, stale: false } : annotation;
    }
    const candidates = matchingWindowStarts(fileLines, quoteLines).map(
      (index) => ({ line: index + 1 }),
    );
    const match = chooseNearestLine(candidates, annotation.line);
    if (!match) {
      return annotation.stale ? annotation : { ...annotation, stale: true };
    }
    return {
      ...annotation,
      line: match.line,
      ...(annotation.endLine === undefined
        ? {}
        : { endLine: match.line + span - 1 }),
      stale: false,
    };
  });
}

function quotedPath(path: string) {
  return `\`${path.replace(/`/g, "\\`")}\``;
}

function quoteBlock(value: string) {
  return value
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function compileReviewFeedback(
  annotations: readonly ReviewAnnotation[],
): string {
  const items = annotations
    .filter((annotation) => annotation.comment.trim())
    .map((annotation, index) => {
      const stale = annotation.stale ? "; anchor may be stale" : "";
      const location =
        annotation.source === "terminal"
          ? `terminal pane ${quotedPath(annotation.title)} (selected passage${stale})`
          : annotation.source === "diff"
            ? `${quotedPath(annotation.path)} (${diffReviewLineLabel(annotation)}${stale})`
            : annotation.anchor === "line"
              ? `${quotedPath(annotation.path)} (${fileReviewLineLabel(annotation)}${stale})`
              : annotation.section.length
                ? `${quotedPath(annotation.path)} § "${annotation.section.join(" › ")}"${annotation.stale ? " (anchor may be stale)" : ""}`
                : `${quotedPath(annotation.path)} (selected passage${stale})`;
      return `${index + 1}. ${location}:\n${quoteBlock(annotation.quote)}\n\n${annotation.comment.trim()}`;
    });
  return items.length ? `Review feedback:\n\n${items.join("\n\n")}` : "";
}

export function reviewAgentPanes(
  panes: readonly Pane[],
  workspaceId: string,
  preferredPaneId?: string,
): Pane[] {
  return panes
    .filter(
      (pane) =>
        pane.workspace_id === workspaceId &&
        typeof pane.agent === "string" &&
        pane.agent.trim().length > 0,
    )
    .sort((left, right) => {
      const leftRank =
        left.pane_id === preferredPaneId ? 0 : left.focused ? 1 : 2;
      const rightRank =
        right.pane_id === preferredPaneId ? 0 : right.focused ? 1 : 2;
      return leftRank - rightRank || left.pane_id.localeCompare(right.pane_id);
    });
}

// Only remove unchanged, nonblank comments included in the successful pre-fill.
export function removeDeliveredReviewAnnotations(
  current: readonly ReviewAnnotation[],
  delivered: readonly ReviewAnnotation[],
): ReviewAnnotation[] {
  const snapshots = new Map(
    delivered
      .filter((item) => item.comment.trim())
      .map((item) => [item.id, JSON.stringify(item)]),
  );
  return current.filter(
    (item) => snapshots.get(item.id) !== JSON.stringify(item),
  );
}

export function terminalAnnotationTitle(pane: Pane): string {
  return `${pane.agent?.trim() || "Terminal"} · ${pane.pane_id.slice(0, 8)}`;
}
