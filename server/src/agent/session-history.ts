import { createHash } from "node:crypto";
import type { AtifTrajectory, SessionFile } from "./session-types";
import { isConversationStep } from "./session-messages";
import { historyWindowEntries } from "./session-history-window";
import { type PublishedArtifact, publishedArtifact } from "./session-artifacts";
import type { HistoryImage } from "./session-images";
export type { HistoryImage };

export type HistoryEntry = {
  id: string;
  role: "user" | "assistant" | "tool";
  kind: "message" | "tool_call" | "tool_result" | "error";
  text: string;
  sent_at: string;
  tool_name?: string;
  source_call_id?: string;
  is_error?: boolean;
  // A message the user sent while the agent worked, still waiting in its
  // queue. Once delivered it keeps its id and loses the flag.
  queued?: boolean;
  // The summary that replaced the earlier conversation when it was compacted.
  compact_summary?: boolean;
  // On an Artifact tool result: the page it published. Kept when the
  // payload is redacted, so the chat can link to it.
  artifact?: PublishedArtifact;
  // On a user message: the images it carried, without their data.
  images?: HistoryImage[];
  // On the result of a command that opened a merge or pull request (`glab
  // mr create`, `gh pr create`): its URL as the command printed it. Kept
  // when the payload is redacted, so the chat can list it.
  created_request?: string;
  // Set on redacted wire entries: UTF-8 byte length of the withheld text,
  // fetchable via agent_history.entry when the user expands the card.
  text_bytes?: number;
  // Set with text_bytes: a content hash of the withheld text, so clients can
  // tell a payload rewritten in place (even at the same length) from the one
  // they already fetched.
  text_hash?: string;
};
export type HistoryCursor = { epoch: string; revision: number };
export type HistoryUpdate = {
  history_version: 2;
  cursor: HistoryCursor;
  window_limit: number;
} & (
  | { mode: "snapshot"; entries: HistoryEntry[] }
  | {
      mode: "delta";
      base_revision: number;
      upserts: HistoryEntry[];
      removed: string[];
      order?: string[];
    }
);
export const HISTORY_WINDOW_LIMIT = 200;

export function historyEntriesFromTrajectory(
  file: SessionFile,
  trajectory: AtifTrajectory,
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  const occurrences = new Map<string, number>();
  const names = new Map<string, string>();
  const artifactCalls = new Map<string, Record<string, unknown>>();
  const createCalls = new Set<string>();
  for (const step of trajectory.steps) {
    for (const call of step.tool_calls ?? []) {
      names.set(call.tool_call_id, call.function_name);
      if (call.function_name === "Artifact")
        artifactCalls.set(call.tool_call_id, call.arguments);
      if (createsRequest(call.arguments?.command))
        createCalls.add(call.tool_call_id);
    }
  }
  const add = (entry: Omit<HistoryEntry, "id">) => {
    // Content identities survive step renumbering. Repeated identical items get
    // occurrence suffixes; revisions, not these IDs, define synchronization.
    const identity = entry.source_call_id
      ? [entry.kind, entry.source_call_id]
      : [entry.kind, entry.role, entry.text];
    const hash = createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex")
      .slice(0, 24);
    const occurrence = occurrences.get(hash) ?? 0;
    occurrences.set(hash, occurrence + 1);
    entries.push({ ...entry, id: `${hash}:${occurrence}` });
  };
  for (const step of trajectory.steps) {
    const sent_at = step.timestamp ?? new Date(file.mtimeMs).toISOString();
    if (!step.observation && isConversationStep(step)) {
      add({
        kind: "message",
        role: step.source === "user" ? "user" : "assistant",
        text: step.message,
        sent_at,
        ...(step.extra?.queued === true ? { queued: true } : {}),
        ...(step.extra?.compact_summary === true
          ? { compact_summary: true }
          : {}),
        ...(step.source === "user" && Array.isArray(step.extra?.images)
          ? {
              images: step.extra.images as HistoryImage[],
            }
          : {}),
      });
    }
    for (const call of step.tool_calls ?? []) {
      add({
        kind: "tool_call",
        role: "tool",
        tool_name: call.function_name,
        source_call_id: call.tool_call_id,
        text: JSON.stringify(call.arguments, null, 2),
        sent_at,
      });
    }
    for (const result of step.observation?.results ?? []) {
      add({
        kind: "tool_result",
        role: "tool",
        tool_name:
          typeof result.extra?.tool_name === "string"
            ? result.extra.tool_name
            : names.get(result.source_call_id ?? ""),
        source_call_id: result.source_call_id,
        text: result.content ?? step.message,
        is_error: result.extra?.is_error === true,
        sent_at,
        ...artifactField(
          artifactCalls.get(result.source_call_id ?? ""),
          result.extra?.is_error === true ? "" : (result.content ?? ""),
        ),
        ...createdRequestField(
          createCalls.has(result.source_call_id ?? "") &&
            result.extra?.is_error !== true
            ? (result.content ?? "")
            : "",
        ),
      });
    }
    if (typeof step.extra?.error_message === "string") {
      add({
        kind: "error",
        role: "assistant",
        text: step.extra.error_message,
        is_error: true,
        sent_at,
      });
    }
  }
  return historyWindowEntries(entries, HISTORY_WINDOW_LIMIT);
}

/** A shell command that opens a merge or pull request. */
export function createsRequest(command: unknown): boolean {
  return (
    typeof command === "string" &&
    /\b(?:glab\s+mr\s+create|gh\s+pr\s+create)\b/.test(command)
  );
}

const REQUEST_URL =
  /https:\/\/[^\s"'<>()]+?\/(?:-\/merge_requests|pull)\/\d{1,9}\b/;

/** The request URL `glab mr create` or `gh pr create` printed. */
export function createdRequestField(
  output: string,
): Pick<HistoryEntry, "created_request"> {
  const url = output ? REQUEST_URL.exec(output.slice(0, 200_000))?.[0] : null;
  return url ? { created_request: url } : {};
}

function artifactField(
  args: Record<string, unknown> | undefined,
  output: string,
) {
  const artifact = args && publishedArtifact(args, output);
  return artifact ? { artifact } : {};
}

// Short content hash of a tool payload, shared by redacted entries and
// agent_history.entry replies.
export function historyTextHash(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function redactHistoryEntry(entry: HistoryEntry): HistoryEntry {
  if (entry.role !== "tool" || entry.text.length === 0) return entry;
  return {
    ...entry,
    text: "",
    text_bytes: Buffer.byteLength(entry.text, "utf8"),
    text_hash: historyTextHash(entry.text),
  };
}

// Tool payloads are bulky and rarely read, so the wire format carries only
// their metadata. The projection cache keeps full text for on-demand fetches.
export function redactHistoryUpdate(update: HistoryUpdate): HistoryUpdate {
  if (update.mode === "snapshot") {
    return { ...update, entries: update.entries.map(redactHistoryEntry) };
  }
  return { ...update, upserts: update.upserts.map(redactHistoryEntry) };
}

export function historyUpdate(
  cursor: HistoryCursor,
  entries: HistoryEntry[],
  requested: unknown,
  versions: Map<number, HistoryEntry[]>,
): HistoryUpdate {
  const base =
    typeof requested === "object" && requested !== null
      ? (requested as Partial<HistoryCursor>)
      : null;
  const previous =
    base?.epoch === cursor.epoch && Number.isSafeInteger(base.revision)
      ? versions.get(base.revision as number)
      : undefined;
  if (!previous || (base?.revision ?? Infinity) > cursor.revision) {
    return {
      history_version: 2,
      mode: "snapshot",
      cursor,
      window_limit: HISTORY_WINDOW_LIMIT,
      entries,
    };
  }
  if (base?.revision === cursor.revision) {
    return {
      history_version: 2,
      mode: "delta",
      cursor,
      base_revision: cursor.revision,
      window_limit: HISTORY_WINDOW_LIMIT,
      upserts: [],
      removed: [],
    };
  }
  const old = new Map(previous.map((entry) => [entry.id, entry]));
  const ids = new Set(entries.map((entry) => entry.id));
  const order = entries.map((entry) => entry.id);
  return {
    history_version: 2,
    mode: "delta",
    cursor,
    base_revision: base!.revision!,
    window_limit: HISTORY_WINDOW_LIMIT,
    upserts: entries.filter(
      (entry) => JSON.stringify(old.get(entry.id)) !== JSON.stringify(entry),
    ),
    removed: previous
      .filter((entry) => !ids.has(entry.id))
      .map((entry) => entry.id),
    ...(order.join() === previous.map((entry) => entry.id).join()
      ? {}
      : { order }),
  };
}
