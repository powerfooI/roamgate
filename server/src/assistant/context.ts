import { randomUUID } from "node:crypto";
import type {
  AssistantActionKind,
  AssistantSource,
  AssistantWorkspace,
  AssistantWorkspaceRef,
} from "../../../shared/assistant";
import { ASSISTANT_MAX_WORKSPACES } from "../../../shared/assistant";
import { isRecord } from "../agent/session-utils";
import { validateConnectionId } from "../connections/protocol";
import type { LegacyConnectionRuntime } from "../connections/runtime";
import { sanitizeExplorerPath } from "../workspace/file-paths";
import {
  prepareAssistantAction,
  type AssistantWorktreeCreator,
} from "./actions";
import {
  ASSISTANT_DEFAULT_TERMINAL_LINES,
  ASSISTANT_MAX_TERMINAL_LINES,
} from "./tools";

const MAX_ITEMS = 80;
const MAX_TEXT = 32_000;
const MAX_CATALOG_WORKSPACES = 512;
const INCOMPLETE_NOTICE =
  "Some data was truncated. This is partial evidence; do not infer that omitted records do not exist.";

type RuntimeLease = {
  runtime: LegacyConnectionRuntime;
  generation: number;
  isCurrent(): boolean;
};

function identifier(value: unknown, name: string): string {
  try {
    return validateConnectionId(value);
  } catch {
    throw new Error(`Invalid ${name}`);
  }
}

function limitedText(value: unknown, limit = 200): string {
  if (typeof value !== "string") return "";
  return value.length > limit ? `${value.slice(0, limit)} [truncated]` : value;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function relativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    /^[\\/:]|^[a-z]:/i.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("Diff path must be a relative workspace path");
  }
  const path = sanitizeExplorerPath(value);
  if (!path) throw new Error("Diff path must be a relative workspace path");
  return path;
}

export function createAssistantContext(args: {
  catalog(): { id: string; label: string }[];
  lease(connectionId: string): RuntimeLease | null;
  createWorktree?: AssistantWorktreeCreator;
}) {
  // Keep each turn's original leases, including runtime identity, out of model data.
  const scopes = new WeakMap<AssistantWorkspace[], Map<string, RuntimeLease>>();

  function assertCurrent(lease: RuntimeLease, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!lease.isCurrent()) {
      throw new Error(
        "Connection changed during Ranger read; start a new turn",
      );
    }
  }

  async function readLeased<T>(
    lease: RuntimeLease,
    action: () => Promise<T>,
    description: string,
    signal?: AbortSignal,
  ): Promise<T> {
    assertCurrent(lease, signal);
    let cancel: (() => void) | undefined;
    try {
      const pending = action();
      const result = signal
        ? await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              cancel = () =>
                reject(signal.reason ?? new Error("Ranger read stopped"));
              signal.addEventListener("abort", cancel, { once: true });
              if (signal.aborted) cancel();
            }),
          ])
        : await pending;
      assertCurrent(lease, signal);
      return result;
    } catch {
      assertCurrent(lease, signal);
      // Transport and filesystem errors can contain socket paths or credentials.
      throw new Error(`Unable to read ${description}`);
    } finally {
      if (cancel) signal?.removeEventListener("abort", cancel);
    }
  }

  async function workspace(
    lease: RuntimeLease,
    workspaceId: string,
    signal?: AbortSignal,
  ) {
    const result = await readLeased(
      lease,
      () =>
        lease.runtime.herdr.call(
          "workspace.get",
          { workspace_id: workspaceId },
          5000,
        ),
      `workspace ${workspaceId}`,
      signal,
    );
    const item = isRecord(result?.workspace) ? result.workspace : result;
    if (!isRecord(item) || item.workspace_id !== workspaceId) {
      throw new Error(`Workspace ${workspaceId} is no longer available`);
    }
    return item;
  }

  async function catalog(): Promise<{
    workspaces: AssistantWorkspace[];
    errors: string[];
  }> {
    const connections = args.catalog();
    const settled = await Promise.allSettled(
      connections.map(async (connection) => {
        const connectionId = identifier(connection.id, "connection_id");
        const lease = args.lease(connectionId);
        if (!lease)
          return {
            workspaces: [],
            errors: [
              `Connection ${limitedText(connection.label)} is not ready`,
            ],
          };
        const payload = await readLeased(
          lease,
          () => lease.runtime.herdr.call("workspace.list", {}, 5000),
          `workspace list for connection ${connectionId}`,
        );
        if (!Array.isArray(payload?.workspaces))
          throw new Error("Invalid workspace list");
        const listed = records(payload.workspaces);
        return {
          workspaces: listed.slice(0, MAX_CATALOG_WORKSPACES).map(
            (item): AssistantWorkspace => ({
              connection_id: connectionId,
              workspace_id: identifier(item.workspace_id, "workspace_id"),
              connection_label: limitedText(connection.label),
              label: limitedText(item.label),
              runtime_generation: lease.generation,
            }),
          ),
          errors:
            listed.length > MAX_CATALOG_WORKSPACES
              ? [
                  `Workspace list for connection ${limitedText(connection.label)} was truncated to ${MAX_CATALOG_WORKSPACES} entries`,
                ]
              : [],
        };
      }),
    );
    const workspaces: AssistantWorkspace[] = [];
    const errors: string[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        workspaces.push(...result.value.workspaces);
        errors.push(...result.value.errors);
      } else {
        errors.push(
          `Unable to list workspaces for connection ${limitedText(connections[index]?.label)}`,
        );
      }
    });
    if (workspaces.length > MAX_CATALOG_WORKSPACES)
      errors.push(
        `Workspace catalog was truncated to ${MAX_CATALOG_WORKSPACES} entries`,
      );
    return { workspaces: workspaces.slice(0, MAX_CATALOG_WORKSPACES), errors };
  }

  async function captureScope(
    refs: AssistantWorkspaceRef[],
    signal?: AbortSignal,
  ): Promise<AssistantWorkspace[]> {
    signal?.throwIfAborted();
    if (
      !Array.isArray(refs) ||
      !refs.length ||
      refs.length > ASSISTANT_MAX_WORKSPACES
    ) {
      throw new Error(
        `Choose between 1 and ${ASSISTANT_MAX_WORKSPACES} workspaces for Ranger`,
      );
    }
    const requested = refs.map((ref) => {
      if (!isRecord(ref)) throw new Error("Invalid Ranger workspace scope");
      return {
        connection_id: identifier(ref.connection_id, "connection_id"),
        workspace_id: identifier(ref.workspace_id, "workspace_id"),
      };
    });
    const connections = args.catalog();
    const leases = new Map<string, RuntimeLease>();
    const captured: AssistantWorkspace[] = [];
    const seen = new Set<string>();
    for (const ref of requested) {
      const connectionId = ref.connection_id;
      const workspaceId = ref.workspace_id;
      const key = `${connectionId}\0${workspaceId}`;
      if (seen.has(key)) throw new Error("Duplicate Ranger workspace scope");
      seen.add(key);
      const connection = connections.find((item) => item.id === connectionId);
      if (!connection) throw new Error(`Unknown connection ${connectionId}`);
      const lease = leases.get(connectionId) ?? args.lease(connectionId);
      if (!lease) throw new Error(`Connection ${connectionId} is not ready`);
      leases.set(connectionId, lease);
      const item = await workspace(lease, workspaceId, signal);
      captured.push(
        Object.freeze({
          connection_id: connectionId,
          workspace_id: workspaceId,
          connection_label: limitedText(connection.label),
          label: limitedText(item.label),
          runtime_generation: lease.generation,
        }),
      );
    }
    for (const lease of leases.values()) assertCurrent(lease, signal);
    Object.freeze(captured);
    scopes.set(captured, leases);
    return captured;
  }

  async function read(
    kind: AssistantSource["kind"],
    captured: AssistantWorkspace[],
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ text: string; sources: AssistantSource[] }> {
    const leases = scopes.get(captured);
    if (!leases || !captured.length)
      throw new Error("Ranger workspace scope was not approved");
    const allowedKeys = {
      status: ["connection_id", "workspace_id"],
      history: ["connection_id", "workspace_id", "pane_id"],
      diff: [
        "connection_id",
        "workspace_id",
        "path",
        "old_path",
        "mode",
        "kind",
        "snapshot_id",
      ],
      terminal: ["connection_id", "workspace_id", "pane_id", "lines"],
    };
    if (!Object.hasOwn(allowedKeys, kind))
      throw new Error("Unknown Ranger read tool");
    if (
      !isRecord(params) ||
      Object.keys(params).some((key) => !allowedKeys[kind].includes(key))
    ) {
      throw new Error("Unsupported Ranger read parameters");
    }
    const selected =
      kind === "status" && !Object.keys(params).length
        ? captured
        : captured.filter(
            (item) =>
              item.connection_id ===
                identifier(params.connection_id, "connection_id") &&
              item.workspace_id ===
                identifier(params.workspace_id, "workspace_id"),
          );
    if (!selected.length)
      throw new Error("Workspace is outside the approved Ranger scope");
    const sources: AssistantSource[] = [];
    const output: Record<string, unknown>[] = [];
    for (const target of selected) {
      const lease = leases.get(target.connection_id)!;
      assertCurrent(lease, signal);
      const currentWorkspace = await workspace(
        lease,
        target.workspace_id,
        signal,
      );
      let paneId: string | undefined;
      let data: Record<string, unknown>;
      if (kind === "status") {
        const payload = await readLeased(
          lease,
          () =>
            lease.runtime.herdr.call(
              "pane.list",
              { workspace_id: target.workspace_id },
              5000,
            ),
          `panes for workspace ${target.workspace_id}`,
          signal,
        );
        const panes = records(payload?.panes).filter(
          (pane) => pane.workspace_id === target.workspace_id,
        );
        data = {
          agent_status: limitedText(currentWorkspace.agent_status),
          pane_count: count(currentWorkspace.pane_count),
          tab_count: count(currentWorkspace.tab_count),
          panes: panes.slice(0, MAX_ITEMS).map((pane) => ({
            pane_id: limitedText(pane.pane_id, 128),
            tab_id: limitedText(pane.tab_id, 128),
            label: limitedText(pane.label),
            agent: limitedText(pane.agent),
            agent_status: limitedText(pane.agent_status),
          })),
          truncated: panes.length > MAX_ITEMS,
        };
      } else if (kind === "history" || kind === "terminal") {
        paneId = identifier(params.pane_id, "pane_id");
        const payload = await readLeased(
          lease,
          () => lease.runtime.herdr.call("pane.get", { pane_id: paneId }, 5000),
          `pane ${paneId}`,
          signal,
        );
        const pane = isRecord(payload?.pane) ? payload.pane : payload;
        if (
          !isRecord(pane) ||
          pane.pane_id !== paneId ||
          pane.workspace_id !== target.workspace_id
        ) {
          throw new Error(
            "Pane is outside the approved workspace or is no longer available",
          );
        }
        if (kind === "history") {
          const history = await readLeased(
            lease,
            () =>
              lease.runtime.agentSessions.readHistory({
                pane_id: paneId,
                workspace_id: target.workspace_id,
              }),
            `agent history for pane ${paneId}`,
            signal,
          );
          if (
            history.pane_id !== paneId ||
            history.workspace_id !== target.workspace_id
          ) {
            throw new Error(
              "Pane changed workspace during Ranger history read",
            );
          }
          const messages =
            "messages" in history ? records(history.messages) : [];
          data = {
            pane_id: paneId,
            agent: limitedText(history.agent),
            status: history.status,
            updated_at: limitedText(history.updated_at),
            unavailable:
              history.status !== "ok"
                ? "Agent transcript is not available"
                : undefined,
            history_window:
              "Recent conversation messages; tool calls, tool outputs and older messages are not included",
            messages: messages.slice(-MAX_ITEMS).map((message) => ({
              role: limitedText(message.role),
              sent_at: limitedText(message.sent_at),
              text: limitedText(message.text, 8000),
            })),
            truncated:
              messages.length > MAX_ITEMS ||
              messages.some(
                (message) =>
                  typeof message.text === "string" &&
                  message.text.length > 8000,
              ),
          };
        } else {
          if (
            params.lines !== undefined &&
            (!Number.isInteger(params.lines) ||
              Number(params.lines) < 1 ||
              Number(params.lines) > ASSISTANT_MAX_TERMINAL_LINES)
          ) {
            throw new Error(
              `Terminal lines must be between 1 and ${ASSISTANT_MAX_TERMINAL_LINES}`,
            );
          }
          // Herdr can collect idle agents' application history and restore their viewport.
          const result = await readLeased(
            lease,
            () =>
              lease.runtime.herdr.call(
                "pane.read",
                {
                  pane_id: paneId,
                  source: "recent",
                  lines: params.lines ?? ASSISTANT_DEFAULT_TERMINAL_LINES,
                  format: "text",
                  strip_ansi: true,
                },
                25_000,
              ),
            `terminal output for pane ${paneId}; this Herdr connection may not support pane.read`,
            signal,
          );
          const terminal = result?.read;
          if (
            !isRecord(terminal) ||
            terminal.pane_id !== paneId ||
            terminal.workspace_id !== target.workspace_id ||
            typeof terminal.text !== "string"
          ) {
            throw new Error(
              "Terminal output unavailable or pane changed workspace during read",
            );
          }
          data = {
            pane_id: paneId,
            requested_lines: params.lines ?? ASSISTANT_DEFAULT_TERMINAL_LINES,
            terminal_window:
              "Most recent available terminal output; older output outside the requested line window is not included. Application history recovery depends on Herdr support and agent state",
            text: terminal.text.slice(-MAX_TEXT),
            truncated:
              terminal.truncated === true || terminal.text.length > MAX_TEXT,
          };
        }
      } else {
        const mode = params.mode ?? "working";
        if (!["working", "branch-main", "last-step"].includes(String(mode)))
          throw new Error("Invalid diff mode");
        if (
          params.kind !== undefined &&
          ![
            "staged",
            "unstaged",
            "untracked",
            "conflicted",
            "branch",
            "last-step",
          ].includes(String(params.kind))
        )
          throw new Error("Invalid diff kind");
        const query: Record<string, unknown> = {
          workspace_id: target.workspace_id,
          mode,
        };
        if (params.kind !== undefined) query.kind = params.kind;
        if (params.old_path !== undefined)
          query.old_path = relativePath(params.old_path);
        if (params.snapshot_id !== undefined)
          query.snapshot_id = identifier(params.snapshot_id, "snapshot_id");
        if (params.path !== undefined) {
          query.path = relativePath(params.path);
          const diff = await readLeased(
            lease,
            () => lease.runtime.files.readGitDiffFile(query),
            `diff for workspace ${target.workspace_id}`,
            signal,
          );
          if (diff.workspace_id !== target.workspace_id)
            throw new Error("Workspace changed during Ranger diff read");
          data = {
            path: limitedText(diff.path, 1024),
            kind: diff.kind,
            diff: limitedText(diff.diff, MAX_TEXT),
            truncated: diff.truncated || diff.diff.length > MAX_TEXT,
          };
        } else {
          const diff = await readLeased(
            lease,
            () => lease.runtime.files.readGitDiffSummary(query),
            `diff summary for workspace ${target.workspace_id}`,
            signal,
          );
          if (diff.workspace_id !== target.workspace_id)
            throw new Error("Workspace changed during Ranger diff read");
          data = {
            mode: diff.mode,
            baseline_available: diff.baseline_available,
            snapshot_id: diff.snapshot_id,
            counts: {
              staged: count(diff.counts.staged),
              unstaged: count(diff.counts.unstaged),
              untracked: count(diff.counts.untracked),
              conflicted: count(diff.counts.conflicted),
              branch: count(diff.counts.branch),
              "last-step": count(diff.counts["last-step"]),
            },
            entries: diff.entries.slice(0, MAX_ITEMS).map((entry) => ({
              path: limitedText(entry.path, 1024),
              old_path: limitedText(entry.old_path, 1024),
              kind: entry.kind,
              status: entry.status,
              additions: entry.additions,
              deletions: entry.deletions,
            })),
            truncated: diff.entries.length > MAX_ITEMS,
          };
        }
      }
      assertCurrent(lease, signal);
      const base = { ...target, read_at: new Date().toISOString() };
      output.push({
        ...base,
        ...data,
        ...(data.truncated === true ? { warning: INCOMPLETE_NOTICE } : {}),
      });
      sources.push({
        ...target,
        id: randomUUID(),
        title: `${limitedText(target.label)}${paneId ? ` / ${paneId}` : ""}`,
        kind,
        ...(paneId ? { pane_id: paneId } : {}),
        read_at: base.read_at,
      });
    }
    for (const lease of leases.values()) assertCurrent(lease, signal);
    let serialized = JSON.stringify(output);
    if (kind === "terminal" && serialized.length > MAX_TEXT) {
      // JSON escaping and metadata count against the budget; retain the newest evidence.
      const terminal = output[0]!;
      terminal.truncated = true;
      terminal.warning = INCOMPLETE_NOTICE;
      const text = terminal.text as string;
      let low = 0;
      let high = text.length;
      while (low < high) {
        const length = Math.ceil((low + high) / 2);
        terminal.text = text.slice(text.length - length);
        if (JSON.stringify(output).length <= MAX_TEXT) low = length;
        else high = length - 1;
      }
      terminal.text = text.slice(text.length - low);
      serialized = JSON.stringify(output);
    }
    return {
      text:
        serialized.length > MAX_TEXT
          ? `${limitedText(serialized, MAX_TEXT - INCOMPLETE_NOTICE.length - 14)}\n${INCOMPLETE_NOTICE}`
          : serialized,
      sources,
    };
  }

  async function prepareAction(
    kind: AssistantActionKind,
    captured: AssistantWorkspace[],
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const leases = scopes.get(captured);
    if (!leases || !captured.length || !isRecord(params))
      throw new Error("Ranger workspace scope was not approved");
    const connectionId = identifier(params.connection_id, "connection_id");
    const workspaceId = identifier(params.workspace_id, "workspace_id");
    const target = captured.find(
      (item) =>
        item.connection_id === connectionId &&
        item.workspace_id === workspaceId,
    );
    if (!target) throw new Error("Action is outside the approved Ranger scope");
    const lease = leases.get(connectionId)!;
    assertCurrent(lease, signal);
    return prepareAssistantAction({
      kind,
      target,
      lease,
      params,
      signal,
      createWorktree: args.createWorktree,
    });
  }

  return { catalog, captureScope, read, prepareAction };
}

export type AssistantContext = Omit<
  ReturnType<typeof createAssistantContext>,
  "prepareAction"
> &
  Partial<Pick<ReturnType<typeof createAssistantContext>, "prepareAction">>;
