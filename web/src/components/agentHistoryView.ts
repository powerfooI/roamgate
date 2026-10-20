import { roamgateLocalStorage } from "../browserStorage";
import type { HistoryEntry } from "./agentHistory";

export type AgentHistoryView = "chat" | "timeline";

const VIEW_STORAGE_KEY = "agentHistoryView";

export function readAgentHistoryView(): AgentHistoryView {
  return roamgateLocalStorage.getItem(VIEW_STORAGE_KEY) === "timeline"
    ? "timeline"
    : "chat";
}

export function writeAgentHistoryView(view: AgentHistoryView) {
  try {
    roamgateLocalStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    /* The choice still applies for this session when storage is full. */
  }
}

export type HistoryChatItem =
  | { type: "message"; entry: HistoryEntry; sequence: number }
  | { type: "tools"; id: string; entries: HistoryEntry[] };

// Consecutive tool entries collapse into one block so the conversation reads
// as alternating turns instead of a wall of tool chatter. Only message bubbles
// get a sequence: the minimap indexes bubbles, not tool blocks.
export function groupHistoryChatItems(
  entries: readonly HistoryEntry[],
): HistoryChatItem[] {
  const items: HistoryChatItem[] = [];
  let sequence = 0;
  for (const entry of entries) {
    if (entry.role !== "tool") {
      sequence += 1;
      items.push({ type: "message", entry, sequence });
      continue;
    }
    const last = items[items.length - 1];
    if (last?.type === "tools") last.entries.push(entry);
    else
      items.push({ type: "tools", id: `tools:${entry.id}`, entries: [entry] });
  }
  return items;
}

// Identifies one version of a redacted tool payload. Polling can rewrite an
// entry under the same id (e.g. tool arguments updated in place); its content
// hash changes with it, even at the same byte length, so fetch guards keyed
// this way refetch the new payload instead of treating it as already loaded.
// Bridges that predate hashes fall back to the byte length.
export function toolPayloadKey(
  entry: Pick<HistoryEntry, "id" | "text_bytes" | "text_hash">,
) {
  return `${entry.id}:${entry.text_hash ?? entry.text_bytes ?? 0}`;
}

// Picks which queued background fetches to start now, given the requests
// already in flight. Only the newest queued version of each entry is kept,
// and versions already started are dropped. An entry whose id has a request
// in flight (an older version, or a direct load) stays queued and starts once
// that request settles, so a rewritten payload is never discarded.
export function takeQueuedToolLoads(
  queue: readonly HistoryEntry[],
  {
    inFlight,
    limit,
    started,
    loadingIds,
  }: {
    inFlight: number;
    limit: number;
    started: ReadonlySet<string>;
    loadingIds: ReadonlySet<string>;
  },
): { start: HistoryEntry[]; rest: HistoryEntry[] } {
  const newest = new Map<string, string>();
  for (const entry of queue) newest.set(entry.id, toolPayloadKey(entry));
  const start: HistoryEntry[] = [];
  const rest: HistoryEntry[] = [];
  const seen = new Set<string>();
  for (const entry of queue) {
    const key = toolPayloadKey(entry);
    if (newest.get(entry.id) !== key || started.has(key) || seen.has(key))
      continue;
    seen.add(key);
    if (inFlight + start.length >= limit || loadingIds.has(entry.id))
      rest.push(entry);
    else start.push(entry);
  }
  return { start, rest };
}

export type ToolStep = {
  id: string;
  name: string;
  call?: HistoryEntry;
  result?: HistoryEntry;
};

// One step per call, with its result attached by call id. When either side
// lacks an id, the result pairs with the earliest unanswered call of the same
// tool. A result with no call in the block (it fell outside the history
// window) stands alone.
export function pairToolSteps(entries: readonly HistoryEntry[]): ToolStep[] {
  const steps: ToolStep[] = [];
  const byCallId = new Map<string, ToolStep>();
  for (const entry of entries) {
    const name = entry.tool_name ?? "tool";
    const callId = entry.source_call_id;
    if (entry.kind === "tool_result") {
      const step =
        (callId ? byCallId.get(callId) : undefined) ??
        steps.find(
          (item) =>
            item.call &&
            !item.result &&
            item.name === name &&
            (!callId || !item.call.source_call_id),
        );
      if (step && !step.result) step.result = entry;
      else steps.push({ id: entry.id, name, result: entry });
      continue;
    }
    const step: ToolStep = { id: entry.id, name, call: entry };
    if (callId) byCallId.set(callId, step);
    steps.push(step);
  }
  return steps;
}

// Chat search: messages match on their own text, while a tool call and its
// result match together, so a hit on either keeps the whole step.
export function searchHistoryChatEntries(
  entries: readonly HistoryEntry[],
  query: string,
): HistoryEntry[] {
  const search = query.trim().toLowerCase();
  if (!search) return entries as HistoryEntry[];
  const matches = (entry: HistoryEntry | undefined) =>
    !!entry && entry.text.toLowerCase().includes(search);
  const kept = new Set<string>();
  let run: HistoryEntry[] = [];
  const flushRun = () => {
    for (const step of pairToolSteps(run)) {
      if (!matches(step.call) && !matches(step.result)) continue;
      if (step.call) kept.add(step.call.id);
      if (step.result) kept.add(step.result.id);
    }
    run = [];
  };
  for (const entry of entries) {
    if (entry.role === "tool") {
      run.push(entry);
      continue;
    }
    flushRun();
    if (matches(entry)) kept.add(entry.id);
  }
  flushRun();
  return entries.filter((entry) => kept.has(entry.id));
}

function parseToolArguments(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isArgumentObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Keys that best identify what a call does, in priority order. Agents name
// them differently, so this covers the common spellings.
const HEADLINE_KEYS = [
  "command",
  "cmd",
  "file_path",
  "filePath",
  "path",
  "pattern",
  "query",
  "url",
  "prompt",
  "description",
];

// Single-line values that still read best as code.
const CODE_KEYS = new Set(["command", "cmd"]);

function firstLine(value: string) {
  return (
    value
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

// A one-line summary of a call's arguments for its collapsed row.
export function toolArgumentHeadline(text: string): string {
  const parsed = parseToolArguments(text);
  if (!isArgumentObject(parsed)) return firstLine(text);
  for (const key of HEADLINE_KEYS) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim()) return firstLine(value);
  }
  const value = Object.values(parsed).find(
    (item): item is string => typeof item === "string" && !!item.trim(),
  );
  return value ? firstLine(value) : firstLine(JSON.stringify(parsed));
}

export type ToolArgumentField = { key: string; value: string; code: boolean };

// Arguments as labelled fields: strings verbatim, other values as formatted
// JSON. Text that is not a JSON object becomes a single unlabelled field.
export function toolArgumentFields(text: string): ToolArgumentField[] {
  const parsed = parseToolArguments(text);
  if (!isArgumentObject(parsed)) {
    return text.trim() ? [{ key: "", value: text, code: true }] : [];
  }
  return Object.entries(parsed).map(([key, value]) =>
    typeof value === "string"
      ? { key, value, code: value.includes("\n") || CODE_KEYS.has(key) }
      : { key, value: JSON.stringify(value, null, 2), code: true },
  );
}

// Clip argument fields to one character budget across the whole payload, so
// many short fields cannot add up to an unbounded preview. Keys count toward
// the budget (at least one character per field), which also bounds the
// number of rendered fields.
export function previewToolArgumentFields(
  fields: readonly ToolArgumentField[],
  limit: number,
): { fields: ToolArgumentField[]; truncated: boolean } {
  const preview: ToolArgumentField[] = [];
  let remaining = limit;
  for (const field of fields) {
    const cost = Math.max(1, field.key.length);
    if (remaining < cost) return { fields: preview, truncated: true };
    remaining -= cost;
    if (field.value.length > remaining) {
      preview.push({ ...field, value: field.value.slice(0, remaining) });
      return { fields: preview, truncated: true };
    }
    remaining -= field.value.length;
    preview.push(field);
  }
  return { fields: preview, truncated: false };
}

export type ToolBlockSummary = {
  calls: number;
  errors: number;
  tools: { name: string; count: number }[];
};

// A collapsed block counts the same paired steps its rows show, so the
// header and the rows always agree. Tools are listed most-used first.
export function summarizeToolSteps(
  steps: readonly ToolStep[],
): ToolBlockSummary {
  const counts = new Map<string, number>();
  for (const step of steps) {
    counts.set(step.name, (counts.get(step.name) ?? 0) + 1);
  }
  return {
    calls: steps.length,
    errors: steps.filter((step) => step.result?.is_error).length,
    tools: [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
  };
}
