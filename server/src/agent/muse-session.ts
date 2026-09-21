import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { localAgentSessionFiles } from "./session-file-access";
import type { SessionFile } from "./session-types";
import { isRecord, stringValue } from "./session-utils";

export type MuseMetadataCache = Map<
  string,
  {
    signature: string;
    workspace: Promise<string | null>;
  }
>;

function museSessionsRoot() {
  const configured = process.env.XDG_DATA_HOME?.trim();
  return join(
    configured && isAbsolute(configured)
      ? configured
      : join(homedir(), ".local", "share"),
    "muse",
    "sessions",
  );
}

function canonicalDirectory(path: string) {
  return realpath(path).catch(() => resolve(path));
}

async function readWorkspace(path: string) {
  try {
    const prefix = await localAgentSessionFiles.readPrefix(path, 256 * 1024);
    for (const line of new TextDecoder().decode(prefix).split("\n")) {
      if (!line.trim()) continue;
      const record: unknown = JSON.parse(line);
      if (
        isRecord(record) &&
        record.payload_type === "runtime.session.metadata" &&
        isRecord(record.payload) &&
        isRecord(record.payload.record)
      )
        return stringValue(record.payload.record.workspace_root) || null;
    }
  } catch {
    // Missing, truncated, or unreadable metadata cannot establish a cwd match.
  }
  return null;
}

async function cachedWorkspace(file: SessionFile, cache: MuseMetadataCache) {
  const signature = JSON.stringify([
    file.identity,
    file.changeToken,
    file.size,
    file.mtimeMs,
  ]);
  let entry = cache.get(file.path);
  if (entry?.signature !== signature) {
    entry = { signature, workspace: readWorkspace(file.path) };
  }
  // Per-connection LRU, including in-flight reads shared by History and summary.
  cache.delete(file.path);
  cache.set(file.path, entry);
  while (cache.size > 512) cache.delete(cache.keys().next().value!);
  const workspace = await entry.workspace;
  if (workspace === null && cache.get(file.path) === entry)
    cache.delete(file.path);
  return workspace;
}

// Muse stores top-level sessions by date; nested subagent/task logs must not
// replace the pane's conversation. Read only the metadata prefix for cwd lookup.
// ponytail: cwd lookup picks the newest session; reported IDs/paths disambiguate
// concurrent sessions in the same directory.
export async function findMuseSession(
  {
    id,
    cwd,
    metadataCache = new Map(),
  }: {
    id?: string;
    cwd?: string;
    metadataCache?: MuseMetadataCache;
  },
  root = museSessionsRoot(),
) {
  if (id ? id === "." || id === ".." || /[\\/\0]/.test(id) : !cwd) return null;
  const candidates = [];
  try {
    const glob = new Bun.Glob("????/??/??/*/session.jsonl");
    for await (const path of glob.scan({ cwd: root, absolute: true })) {
      if (id && basename(dirname(path)) !== id) continue;
      const file = await localAgentSessionFiles.statFile(path);
      if (file) candidates.push(file);
    }
  } catch {
    return null;
  }
  const directory = cwd ? await canonicalDirectory(cwd) : "";
  for (const file of candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    if (id) return { ...file, sessionId: id };
    const workspace = await cachedWorkspace(file, metadataCache);
    if (workspace && (await canonicalDirectory(workspace)) === directory)
      return { ...file, sessionId: basename(dirname(file.path)) };
  }
  return null;
}
