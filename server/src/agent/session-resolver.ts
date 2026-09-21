import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
  AgentHistoryParams,
  AgentSessionInfo,
  AgentSessionResolved,
  HerdrCall,
  SessionFile,
} from "./session-types";
import {
  localAgentSessionFiles,
  type AgentSessionFileAccess,
} from "./session-file-access";
import {
  describeGrokSessionPath,
  findGrokSessionById,
  findGrokSessionForCwd,
} from "./grok-session";
import {
  describeAntigravitySessionPath,
  findAntigravitySessionById,
  findAntigravitySessionForCwd,
} from "./antigravity-session";
import { findMuseSession, type MuseMetadataCache } from "./muse-session";
import {
  integrationInstallCommand,
  isRecord,
  normalizeAgentName,
  stringValue,
} from "./session-utils";

export type AgentSessionResolverContext = {
  pathCache: Map<string, string>;
  museMetadata: MuseMetadataCache;
};

const DEFAULT_RESOLVER_CONTEXT = createAgentSessionResolverContext();

export function createAgentSessionResolverContext(): AgentSessionResolverContext {
  return { pathCache: new Map(), museMetadata: new Map() };
}

function normalizeParams(raw: Record<string, unknown>): AgentHistoryParams {
  return {
    pane_id: stringValue(raw.pane_id),
    workspace_id: stringValue(raw.workspace_id),
    tab_id: stringValue(raw.tab_id),
    agent: stringValue(raw.agent),
  };
}

function piAgentDirectory() {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) {
    return join(homedir(), configured.slice(2));
  }
  return resolve(configured);
}

async function walkFiles(root: string, match: (path: string) => boolean) {
  const results: string[] = [];
  async function visit(dir: string, depth: number) {
    if (depth > 8 || results.length > 200) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
      } else if (entry.isFile() && match(path)) {
        results.push(path);
      }
    }
  }
  await visit(root, 0);
  return results;
}

async function resolveCachedSessionPath(
  context: AgentSessionResolverContext,
  cacheKey: string,
  resolvePath: () => Promise<string | null>,
) {
  const cached = context.pathCache.get(cacheKey);
  if (cached && existsSync(cached)) return cached;
  const path = await resolvePath();
  if (path) context.pathCache.set(cacheKey, path);
  return path;
}

async function findCodexSession(
  id: string,
  context: AgentSessionResolverContext,
) {
  return resolveCachedSessionPath(context, `codex:${id}`, async () => {
    const root = join(homedir(), ".codex", "sessions");
    const files = await walkFiles(
      root,
      (path) => path.endsWith(".jsonl") && basename(path).includes(id),
    );
    return newestFile(files);
  });
}

async function findClaudeSession(
  id: string,
  context: AgentSessionResolverContext,
) {
  return resolveCachedSessionPath(context, `claude:${id}`, async () => {
    const root = join(homedir(), ".claude", "projects");
    const files = await walkFiles(
      root,
      (path) => basename(path) === `${id}.jsonl`,
    );
    return newestFile(files);
  });
}

async function findKimiSession(
  id: string,
  context: AgentSessionResolverContext,
) {
  return resolveCachedSessionPath(context, `kimi:${id}`, async () => {
    const root = join(homedir(), ".kimi-code", "sessions");
    const suffix = join(id, "agents", "main", "wire.jsonl");
    const files = await walkFiles(
      root,
      (path) =>
        path.endsWith(suffix) || path.includes(`/${id}/agents/main/wire.jsonl`),
    );
    return newestFile(files);
  });
}

async function findPiSession(id: string, context: AgentSessionResolverContext) {
  return resolveCachedSessionPath(context, `pi:${id}`, async () => {
    const root = join(piAgentDirectory(), "sessions");
    const files = await walkFiles(root, (path) => {
      const name = basename(path);
      return name === `${id}.jsonl` || name.endsWith(`_${id}.jsonl`);
    });
    return newestFile(files);
  });
}

function newestFile(paths: string[]) {
  return (
    paths
      .map((path) => {
        try {
          return { path, mtimeMs: statSync(path).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((file): file is SessionFile => !!file)
      .toSorted((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path ?? null
  );
}

async function sessionFileFor(
  agent: string,
  session: AgentSessionInfo,
  cwd: string,
  files: AgentSessionFileAccess,
  context: AgentSessionResolverContext,
) {
  if (agent === "grok") {
    const descriptor =
      session.kind === "path"
        ? await describeGrokSessionPath(resolve(session.value))
        : await findGrokSessionById(session.value, cwd);
    return descriptor?.file ?? null;
  }
  if (agent === "agy") {
    const descriptor =
      session.kind === "path"
        ? await describeAntigravitySessionPath(resolve(session.value))
        : await findAntigravitySessionById(session.value, cwd);
    return descriptor?.file ?? null;
  }
  if (session.kind === "path") {
    const path = resolve(session.value);
    return files.statFile(path);
  }
  if (agent === "muse") {
    // A remote ID must never resolve to this machine's unrelated transcript.
    return files.remote ? null : findMuseSession({ id: session.value });
  }
  if (agent === "pi" && files.remote) {
    return files.findPiSessionById(session.value);
  }
  let path: string | null = null;
  if (agent === "codex") path = await findCodexSession(session.value, context);
  if (agent === "claude")
    path = await findClaudeSession(session.value, context);
  if (agent === "kimi") path = await findKimiSession(session.value, context);
  if (agent === "pi") path = await findPiSession(session.value, context);
  if (path) return files.statFile(path);
  return null;
}

function parseAgentInfo(result: unknown) {
  return isRecord(result) && isRecord(result.agent) ? result.agent : null;
}

function parseAgentSession(agentInfo: Record<string, unknown> | null) {
  const raw = agentInfo?.agent_session;
  if (!isRecord(raw)) return null;
  const kind = stringValue(raw.kind).toLowerCase();
  const value = stringValue(raw.value);
  if ((kind !== "id" && kind !== "path") || !value) return null;
  return {
    source: stringValue(raw.source),
    agent: stringValue(raw.agent),
    kind,
    value,
  } satisfies AgentSessionInfo;
}

export async function resolveAgentSession(
  rawParams: Record<string, unknown>,
  herdrCall: HerdrCall,
  files: AgentSessionFileAccess = localAgentSessionFiles,
  context: AgentSessionResolverContext = DEFAULT_RESOLVER_CONTEXT,
): Promise<AgentSessionResolved> {
  const params = normalizeParams(rawParams);
  if (!params.pane_id) throw new Error("agent session requires pane_id");

  const result = await herdrCall("agent.get", { target: params.pane_id });
  return resolveAgentSessionInfo(
    rawParams,
    parseAgentInfo(result),
    files,
    context,
  );
}

/** Resolve an existing agent snapshot without another Herdr request. */
export async function resolveAgentSessionInfo(
  rawParams: Record<string, unknown>,
  agentInfo: Record<string, unknown> | null,
  files: AgentSessionFileAccess,
  context: AgentSessionResolverContext,
): Promise<AgentSessionResolved> {
  const params = normalizeParams(rawParams);
  if (!params.pane_id) throw new Error("agent session requires pane_id");
  const session = parseAgentSession(agentInfo);
  const agent = normalizeAgentName(
    stringValue(agentInfo?.agent) || session?.agent || params.agent || "",
  );
  if (
    agent !== "codex" &&
    agent !== "claude" &&
    agent !== "kimi" &&
    agent !== "grok" &&
    agent !== "pi" &&
    agent !== "muse" &&
    agent !== "agy"
  ) {
    throw new Error(
      `agent session only supports codex, claude, kimi, grok, pi, muse, and agy`,
    );
  }
  // Native session files follow the agent process, which may have been
  // launched after `cd`. Herdr's `cwd` remains the pane's identity directory.
  const cwd =
    stringValue(agentInfo?.foreground_cwd) || stringValue(agentInfo?.cwd);
  const base = {
    version: 1 as const,
    agent,
    pane_id: params.pane_id,
    workspace_id:
      stringValue(agentInfo?.workspace_id) || params.workspace_id || "",
    tab_id: stringValue(agentInfo?.tab_id) || params.tab_id || "",
  };
  let resolvedSession = session;
  let file: SessionFile | null = null;
  if (agent === "grok" && !resolvedSession) {
    const descriptor = await findGrokSessionForCwd(cwd);
    if (descriptor) {
      file = descriptor.file;
      resolvedSession = {
        source: "grok-local",
        agent: "grok",
        kind: "id",
        value: descriptor.session.sessionId,
      };
    }
  }
  if (agent === "agy" && !resolvedSession) {
    const descriptor = await findAntigravitySessionForCwd(cwd);
    if (descriptor) {
      file = descriptor.file;
      resolvedSession = {
        source: "agy-local",
        agent: "agy",
        kind: "id",
        value: descriptor.session.sessionId,
      };
    }
  }
  if (agent === "muse" && !resolvedSession && !files.remote) {
    file = await findMuseSession({ cwd, metadataCache: context.museMetadata });
    if (file?.sessionId) {
      resolvedSession = {
        source: "muse-local",
        agent: "muse",
        kind: "id",
        value: file.sessionId,
      };
    }
  }
  if (!resolvedSession) {
    return {
      ...base,
      status: "missing_session",
      detail:
        agent === "muse"
          ? files.remote
            ? "Muse session inspection over SSH requires a Herdr-reported transcript path. Local session discovery is not used for remote panes."
            : cwd
              ? `No local Muse Code session was found for ${cwd}. Start Muse Code in this directory without --no-session-log, then refresh Session Inspect.`
              : "Herdr did not report a working directory for this Muse Code pane."
          : agent === "grok"
            ? cwd
              ? `No local Grok Build session was found for ${cwd}. Start Grok Build in this directory, then refresh Session Inspect.`
              : "Herdr did not report a working directory for this Grok Build pane."
            : agent === "agy"
              ? cwd
                ? `No local Antigravity session was found for ${cwd}. Start Antigravity in this directory, then refresh Session Inspect.`
                : "Herdr did not report a working directory for this Antigravity pane."
              : "Herdr has not received an agent session id for this pane. Install the Herdr integration for this agent and start a new agent session.",
      command:
        agent === "grok" || agent === "muse"
          ? undefined
          : integrationInstallCommand(agent),
      updated_at: new Date(0).toISOString(),
      path: "",
      session: null,
      file: null,
    };
  }

  file ??= await sessionFileFor(agent, resolvedSession, cwd, files, context);
  if (!file) {
    return {
      ...base,
      status: "missing_file",
      detail: `Could not find the ${agent} session transcript for ${resolvedSession.value}.`,
      updated_at: new Date(0).toISOString(),
      path: "",
      session: resolvedSession,
      file: null,
    };
  }
  return {
    ...base,
    status: "ok",
    detail: "",
    updated_at: new Date(file.mtimeMs).toISOString(),
    path: file.path,
    session: resolvedSession,
    file,
  };
}
