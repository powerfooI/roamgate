import type {
  HistoryCursor,
  HistoryEntry,
  HistoryUpdate,
} from "../../../server/src/agent/session-history";
import { historyWindowEntries } from "../../../server/src/agent/session-history-window";
export type { HistoryCursor, HistoryEntry, HistoryUpdate };

export type AgentHistory = {
  status?: "ok" | "missing_session" | "missing_file";
  detail?: string;
  command?: string;
  agent: string;
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  updated_at: string;
  path: string;
  cursor: HistoryCursor;
  messages: HistoryEntry[];
};
export type AgentHistoryResponse = Omit<AgentHistory, "messages" | "cursor"> &
  HistoryUpdate;

export const HISTORY_CATEGORIES = ["user", "agent", "tool"] as const;
export type HistoryCategory = (typeof HISTORY_CATEGORIES)[number];
export type HistoryFilters = Record<HistoryCategory, boolean>;
export const ALL_HISTORY_FILTERS: HistoryFilters = {
  user: true,
  agent: true,
  tool: true,
};

// Tool payloads arrive redacted (metadata only) and are fetched on demand;
// an entry is pending until its text is loaded.
export function isToolContentPending(
  entry: Pick<HistoryEntry, "role" | "text" | "text_bytes">,
) {
  return (
    entry.role === "tool" &&
    entry.text.length === 0 &&
    (entry.text_bytes ?? 0) > 0
  );
}

export function historyEntryCategory(entry: HistoryEntry): HistoryCategory {
  return entry.role === "assistant" ? "agent" : entry.role;
}

// Filter only the rendered window, never the synchronized source or cursor.
export function selectHistoryEntries(
  entries: HistoryEntry[],
  filters: HistoryFilters,
  query = "",
) {
  const search = query.trim().toLowerCase();
  const counts: Record<HistoryCategory, number> = {
    user: 0,
    agent: 0,
    tool: 0,
  };
  const visible: HistoryEntry[] = [];
  for (const entry of entries) {
    const category = historyEntryCategory(entry);
    counts[category] += 1;
    if (
      filters[category] &&
      (!search || entry.text.toLowerCase().includes(search))
    )
      visible.push(entry);
  }
  return { visible, counts };
}

// The request cursor is required even for snapshots: an older reset response
// must not replace a newer epoch. Connection/pane leases are checked by the caller.
export function mergeAgentHistory(
  current: AgentHistory | null,
  response: AgentHistoryResponse,
  requested: HistoryCursor | null,
): AgentHistory | null {
  const sameCursor = (a: HistoryCursor | null, b: HistoryCursor | null) =>
    a?.epoch === b?.epoch && a?.revision === b?.revision;
  if (!sameCursor(current?.cursor ?? null, requested)) return current;
  if (
    response.history_version !== 2 ||
    !Number.isSafeInteger(response.cursor.revision) ||
    response.cursor.revision < 1
  )
    return current;
  if (
    current?.cursor.epoch === response.cursor.epoch &&
    current.cursor.revision >= response.cursor.revision
  )
    return current;
  let messages: HistoryEntry[];
  if (response.mode === "snapshot") {
    messages = response.entries;
  } else {
    if (
      !current ||
      response.cursor.epoch !== current.cursor.epoch ||
      response.base_revision !== current.cursor.revision
    )
      return current;
    const entries = new Map(current.messages.map((entry) => [entry.id, entry]));
    for (const id of response.removed) entries.delete(id);
    for (const entry of response.upserts) entries.set(entry.id, entry);
    const order = response.order ?? current.messages.map((entry) => entry.id);
    if (
      order.length !== entries.size ||
      new Set(order).size !== order.length ||
      order.some((id) => !entries.has(id))
    )
      return current;
    messages = order.map((id) => entries.get(id)!);
  }
  const limit = Math.max(1, Math.min(response.window_limit, 200));
  if (
    !Number.isInteger(limit) ||
    new Set(messages.map((entry) => entry.id)).size !== messages.length
  )
    return current;
  // Never retain transport deltas or full snapshots beside the visible list.
  // The window counts conversation entries only; tool entries ride along.
  return {
    status: response.status,
    detail: response.detail,
    command: response.command,
    agent: response.agent,
    pane_id: response.pane_id,
    workspace_id: response.workspace_id,
    tab_id: response.tab_id,
    updated_at: response.updated_at,
    path: response.path,
    cursor: response.cursor,
    messages: historyWindowEntries(messages, limit),
  };
}

export function historyEntryLabel(entry: HistoryEntry) {
  if (entry.kind === "tool_call")
    return `Tool call: ${entry.tool_name ?? "tool"}`;
  if (entry.kind === "tool_result")
    return `${entry.is_error ? "Tool error" : "Tool output"}: ${entry.tool_name ?? "tool"}`;
  if (entry.kind === "error") return "Assistant error";
  return entry.role === "assistant" ? "Assistant" : "You";
}
