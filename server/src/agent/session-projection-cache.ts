import { randomUUID } from "node:crypto";
import type { AgentSessionFileAccess } from "./session-file-access";
import type { AgentSessionResolved, SessionFile } from "./session-types";
import { conversationMessagesFromTrajectory } from "./session-messages";
import { projectAgentTrajectory } from "./session-trajectory";
import {
  historyEntriesFromTrajectory,
  historyUpdate,
  type HistoryEntry,
} from "./session-history";
import { isRecord } from "./session-utils";
import { summarizeTokenUsage } from "./token-usage";
import { readAntigravitySessionRecords } from "./antigravity-session";

function parseJsonl(text: string) {
  const records: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (isRecord(record)) records.push(record);
    } catch {
      // A writer may not have finished its last JSONL record yet.
    }
  }
  return records;
}

export async function readSessionProjection(
  agent: string,
  file: SessionFile,
  files: AgentSessionFileAccess,
  fallbackTime = file.createdAtMs ?? file.mtimeMs,
) {
  const records =
    agent === "agy"
      ? await readAntigravitySessionRecords(file.path)
      : parseJsonl(await files.readText(file.path));
  const projectionFile = { ...file, mtimeMs: fallbackTime };
  const trajectory = projectAgentTrajectory(agent, projectionFile, records);
  const messages = conversationMessagesFromTrajectory(
    projectionFile,
    trajectory,
  );
  return {
    file,
    trajectory,
    messages,
    entries: historyEntriesFromTrajectory(projectionFile, trajectory),
    stats: {
      turns: messages.filter((message) => message.role === "user").length,
      records: records.length,
      token_usage: summarizeTokenUsage(records),
    },
  };
}

type Projection = Awaited<ReturnType<typeof readSessionProjection>>;
type Cached = {
  projection: Projection;
  signature: string;
  epoch: string;
  revision: number;
  versions: Map<number, HistoryEntry[]>;
  bytes: number;
  fallbackTime: number;
};
// Cache admission only needs a conservative retained-value estimate, not a
// serialized copy. Count shared values again; stop at the budget or deep input.
export function estimateRetainedBytes(
  value: unknown,
  budget: number,
  depth = 0,
): number {
  if (depth > 64 || budget < 0) return Infinity;
  if (typeof value === "string") {
    const bytes = 32 + 2 * value.length;
    return bytes > budget ? Infinity : bytes;
  }
  if (value === null || typeof value !== "object")
    return budget < 16 ? Infinity : 16;

  let bytes = 64;
  if (bytes > budget) return Infinity;
  if (Array.isArray(value)) {
    for (const item of value) {
      bytes += 8 + estimateRetainedBytes(item, budget - bytes - 8, depth + 1);
      if (bytes > budget) return Infinity;
    }
  } else {
    const record = value as Record<string, unknown>;
    for (const key in record) {
      if (!Object.hasOwn(record, key)) continue;
      bytes += 32 + 2 * key.length;
      if (bytes > budget) return Infinity;
      bytes += estimateRetainedBytes(record[key], budget - bytes, depth + 1);
      if (bytes > budget) return Infinity;
    }
  }
  return bytes;
}

function signature(file: SessionFile) {
  return JSON.stringify([
    file.path,
    file.mtimeMs,
    file.size,
    file.identity,
    file.changeToken,
    file.sessionId,
    file.createdAtMs,
    file.modelName,
    file.agentVersion,
  ]);
}
function sessionKey(resolved: AgentSessionResolved) {
  return JSON.stringify([
    resolved.agent,
    resolved.session?.kind,
    resolved.session?.value,
  ]);
}

// One instance per connection. Pending work coalesces, while completed payloads
// are LRU bounded (including the small revision history). Oversize sessions are
// served but not retained. Changed files still require a full provider projection.
export function createSessionProjectionCache(
  files: AgentSessionFileAccess,
  limits = { entries: 16, bytes: 32 * 1024 * 1024 },
) {
  const cache = new Map<string, Cached>();
  const pending = new Map<string, Promise<Cached>>();
  let retainedBytes = 0;
  function remove(key: string) {
    const old = cache.get(key);
    if (old) retainedBytes -= old.bytes;
    cache.delete(key);
  }
  function invalidate(resolved: AgentSessionResolved) {
    const prefix = `${sessionKey(resolved)}:`;
    for (const key of cache.keys()) if (key.startsWith(prefix)) remove(key);
    for (const key of pending.keys())
      if (key.startsWith(prefix)) pending.delete(key);
  }
  async function load(resolved: AgentSessionResolved): Promise<Cached> {
    const file = resolved.file;
    if (!file) throw new Error("Session file unavailable");
    const key = `${sessionKey(resolved)}:${file.path}`;
    const running = pending.get(key);
    if (running) return running;
    const isCurrent = () => pending.get(key) === task;
    const task: Promise<Cached> = (async () => {
      const old = cache.get(key);
      // Re-stat even if resolution came from a provider's descriptor cache.
      let before = await files.statFile(file.path);
      if (!before)
        throw new Error(
          "Session file disappeared; refresh to resolve it again",
        );
      let current = { ...file, ...before };
      if (old?.signature === signature(current)) {
        if (isCurrent() && cache.get(key) === old) {
          cache.delete(key);
          cache.set(key, old);
        }
        return old;
      }
      let projection: Projection | undefined;
      const isReset = () =>
        !old ||
        old.projection.file.identity !== current.identity ||
        (current.size ?? 0) < (old.projection.file.size ?? 0);
      let fallbackTime = current.createdAtMs ?? current.mtimeMs;
      for (let attempt = 0; attempt < 3; attempt++) {
        // Keep synthetic timestamps stable on append, but respect explicit
        // corrections (including removal) of the descriptor's creation time.
        fallbackTime =
          !isReset() &&
          old &&
          old.projection.file.createdAtMs === current.createdAtMs
            ? old.fallbackTime
            : (current.createdAtMs ?? current.mtimeMs);
        projection = await readSessionProjection(
          resolved.agent,
          current,
          files,
          fallbackTime,
        );
        const after = await files.statFile(file.path);
        if (!after) throw new Error("Session file disappeared while reading");
        if (signature({ ...file, ...after }) === signature(current)) break;
        projection = undefined;
        before = after;
        current = { ...file, ...before };
      }
      if (!projection)
        throw new Error(
          "Session file changed while reading; retry on the next refresh",
        );
      const reset = isReset();
      const revision = reset ? 1 : old!.revision + 1;
      const versions = reset
        ? new Map<number, HistoryEntry[]>()
        : new Map(old!.versions);
      versions.set(revision, projection.entries);
      while (versions.size > 4) versions.delete(versions.keys().next().value!);
      const value: Cached = {
        projection,
        signature: signature(current),
        epoch: reset ? randomUUID() : old!.epoch,
        revision,
        versions,
        bytes: 0,
        fallbackTime,
      };
      value.bytes = estimateRetainedBytes(
        [projection, ...versions.values()],
        limits.bytes,
      );
      if (!isCurrent()) return value;
      remove(key);
      if (value.bytes <= limits.bytes && limits.entries > 0) {
        cache.set(key, value);
        retainedBytes += value.bytes;
        while (cache.size > limits.entries || retainedBytes > limits.bytes)
          remove(cache.keys().next().value!);
      }
      return value;
    })();
    pending.set(key, task);
    try {
      return await task;
    } catch (error) {
      if (pending.get(key) === task) remove(key);
      throw error;
    } finally {
      if (pending.get(key) === task) pending.delete(key);
    }
  }
  return {
    invalidate,
    async get(resolved: AgentSessionResolved) {
      return (await load(resolved)).projection;
    },
    async history(resolved: AgentSessionResolved, cursor: unknown) {
      const cached = await load(resolved);
      return {
        projection: cached.projection,
        update: historyUpdate(
          { epoch: cached.epoch, revision: cached.revision },
          cached.projection.entries,
          cursor,
          cached.versions,
        ),
      };
    },
  };
}
export type SessionProjectionCache = ReturnType<
  typeof createSessionProjectionCache
>;
