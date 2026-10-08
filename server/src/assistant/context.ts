import { createHash, randomUUID } from "node:crypto";
import type {
  AssistantActionKind,
  AssistantMentionCatalog,
  AssistantMentionTarget,
  AssistantSource,
  AssistantWorkspace,
  AssistantWorkspaceCatalog,
  AssistantWorkspaceRef,
} from "../../../shared/assistant";
import {
  ASSISTANT_MAX_MENTIONS,
  ASSISTANT_MAX_WORKSPACES,
  isAssistantMentionTarget,
} from "../../../shared/assistant";
import { isRecord } from "../agent/session-utils";
import { validateConnectionId } from "../connections/protocol";
import type { LegacyConnectionRuntime } from "../connections/runtime";
import { sanitizeExplorerPath } from "../workspace/file-paths";
import {
  prepareAssistantAction,
  readAssistantPaneOccupant,
  type AssistantWorktreeCreator,
} from "./actions";
import {
  ASSISTANT_DEFAULT_TERMINAL_LINES,
  ASSISTANT_MAX_TERMINAL_LINES,
} from "./tools";

const MAX_SCOPE_READS = 8;
const MAX_ITEMS = 80;
const MAX_TEXT = 32_000;
const INCOMPLETE_NOTICE =
  "Some data was truncated. This is partial evidence; do not infer that omitted records do not exist.";

type RuntimeLease = {
  runtime: LegacyConnectionRuntime;
  generation: number;
  isCurrent(): boolean;
};

/** Private recovery metadata. Never include these identities in model context. */
export type RecoveryTarget = AssistantWorkspaceRef & {
  endpoint_fingerprint: string;
  herdr_boot_id: string;
  workspace_identity: string;
};

export class AssistantRecoveryNotReadyError extends Error {}

function workspaceIdentity(workspace: Record<string, unknown>): string {
  const worktree = isRecord(workspace.worktree) ? workspace.worktree : {};
  return createHash("sha256")
    .update(
      JSON.stringify([
        workspace.cwd ?? null,
        worktree.repo_key ?? null,
        worktree.repo_root ?? null,
        worktree.checkout_path ?? null,
      ]),
    )
    .digest("hex");
}

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

/** Keep admission reads bounded, ordered and fail-closed without queued work escaping. */
async function mapScopeReads<T, R>(
  items: readonly T[],
  read: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (!controller.signal.aborted && next < items.length) {
      const index = next++;
      try {
        results[index] = await read(items[index]!, index, controller.signal);
      } catch (error) {
        // Preserve the first failure and stop every leased read and queued item.
        controller.abort(error);
      }
    }
  }
  try {
    // Only these fixed workers are concurrent. Leased reads stop promptly on
    // abort; uncancellable transport calls are still bounded by this limit.
    await Promise.all(
      Array.from({ length: Math.min(MAX_SCOPE_READS, items.length) }, worker),
    );
    controller.signal.throwIfAborted();
    return results;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export function createAssistantContext(args: {
  catalog(): { id: string; label: string }[];
  lease(connectionId: string): RuntimeLease | null;
  /** SHA-256 of the configured endpoint, excluding labels and transient tunnels. */
  recoveryFingerprint?(connectionId: string): string;
  createWorktree?: AssistantWorktreeCreator;
}) {
  // Keep each turn's original leases, including runtime identity, out of model data.
  const scopes = new WeakMap<AssistantWorkspace[], Map<string, RuntimeLease>>();
  const workspaceIdentities = new WeakMap<AssistantWorkspace[], string[]>();
  const mentionGuards = new WeakMap<
    AssistantWorkspace[],
    Map<string, Extract<AssistantMentionTarget, { kind: "agent" }>>
  >();

  function fingerprint(connectionId: string): string | undefined {
    const value = args.recoveryFingerprint?.(connectionId);
    if (value !== undefined && !/^[a-f0-9]{64}$/.test(value))
      throw new Error("Ranger recovery endpoint identity is invalid");
    return value;
  }

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

  function mentionLabel(value: unknown, fallback: string) {
    const label =
      typeof value === "string"
        ? value
            .replace(/[\u0000-\u001f\u007f]/g, " ")
            .trim()
            .slice(0, 200)
        : "";
    return label || fallback.slice(0, 200);
  }

  function workspaceMention(
    target: AssistantWorkspace,
  ): AssistantMentionTarget {
    const label = mentionLabel(target.label, target.workspace_id);
    return {
      kind: "workspace",
      connection_id: target.connection_id,
      workspace_id: target.workspace_id,
      runtime_generation: target.runtime_generation,
      connection_label: mentionLabel(
        target.connection_label,
        target.connection_id,
      ),
      workspace_label: label,
      label,
    };
  }

  async function agentMention(
    target: AssistantWorkspace,
    lease: RuntimeLease,
    paneId: string,
    signal?: AbortSignal,
  ): Promise<Extract<AssistantMentionTarget, { kind: "agent" }>> {
    const occupant = await readAssistantPaneOccupant(
      (method, params) =>
        readLeased(
          lease,
          () => lease.runtime.herdr.call(method, params, 5000),
          `agent identity for pane ${paneId}`,
          signal,
        ),
      target.workspace_id,
      paneId,
    );
    if (
      !occupant.agentIdentity ||
      typeof occupant.agent.agent !== "string" ||
      !occupant.agent.agent
    )
      throw new Error("Agent session is not available for mention");
    const result = {
      ...workspaceMention(target),
      kind: "agent" as const,
      pane_id: identifier(paneId, "pane_id"),
      terminal_id: identifier(occupant.pane.terminal_id, "terminal_id"),
      agent: occupant.agent.agent,
      agent_identity: occupant.agentIdentity,
      label: mentionLabel(
        occupant.agent.name || occupant.pane.label,
        occupant.agent.agent,
      ),
    };
    if (!isAssistantMentionTarget(result))
      throw new Error("Agent session is not available for mention");
    return result;
  }

  const agentKey = (target: AssistantWorkspaceRef & { pane_id: string }) =>
    JSON.stringify([target.connection_id, target.workspace_id, target.pane_id]);

  async function assertMentionAgent(
    captured: AssistantWorkspace[],
    target: AssistantWorkspace,
    paneId: string,
    signal?: AbortSignal,
  ) {
    const expected = mentionGuards
      .get(captured)
      ?.get(agentKey({ ...target, pane_id: paneId }));
    if (!expected) return;
    const lease = scopes.get(captured)?.get(target.connection_id);
    if (!lease) throw new Error("Ranger workspace scope was not approved");
    const current = await agentMention(target, lease, paneId, signal);
    if (
      current.terminal_id !== expected.terminal_id ||
      current.agent !== expected.agent ||
      current.agent_identity !== expected.agent_identity
    )
      throw new Error("Mentioned agent session changed; select it again");
  }

  async function mentionCatalog(
    captured: AssistantWorkspace[],
    signal?: AbortSignal,
  ): Promise<AssistantMentionCatalog> {
    const leases = scopes.get(captured);
    if (!leases || !captured.length)
      throw new Error("Ranger workspace scope was not approved");
    const targets = captured.map(workspaceMention);
    const errors: string[] = [];
    let truncated = captured.length > 64;
    // ponytail: scan 64 workspaces and 200 agents; add paged discovery when these limits matter.
    const lists = await mapScopeReads(
      captured.slice(0, 64),
      async (target, _index, readSignal) => {
        const lease = leases.get(target.connection_id)!;
        try {
          await workspace(lease, target.workspace_id, readSignal);
          const result = await readLeased(
            lease,
            () =>
              lease.runtime.herdr.call(
                "pane.list",
                { workspace_id: target.workspace_id },
                5000,
              ),
            `panes for workspace ${target.workspace_id}`,
            readSignal,
          );
          if (!Array.isArray(result?.panes))
            throw new Error("Invalid pane list");
          const panes = records(result.panes).filter(
            (pane) => pane.workspace_id === target.workspace_id && pane.agent,
          );
          truncated ||= panes.length > 200;
          return panes.slice(0, 200).map((pane) => ({
            target,
            paneId: identifier(pane.pane_id, "pane_id"),
          }));
        } catch {
          readSignal.throwIfAborted();
          assertCurrent(lease, readSignal);
          errors.push(
            `Agents unavailable in ${mentionLabel(target.label, target.workspace_id)}`,
          );
          return [];
        }
      },
      signal,
    );
    const candidates = lists.flat();
    truncated ||= candidates.length > 200;
    const agents = await mapScopeReads(
      candidates.slice(0, 200),
      async ({ target, paneId }, _index, readSignal) => {
        const lease = leases.get(target.connection_id)!;
        try {
          return await agentMention(target, lease, paneId, readSignal);
        } catch {
          readSignal.throwIfAborted();
          assertCurrent(lease, readSignal);
          errors.push(
            `Agent unavailable in ${mentionLabel(target.label, target.workspace_id)} / ${paneId}`,
          );
          return null;
        }
      },
      signal,
    );
    for (const lease of leases.values()) assertCurrent(lease, signal);
    targets.push(...agents.filter((target) => target !== null));
    return { targets, errors, ...(truncated ? { truncated: true } : {}) };
  }

  async function bindMentions(
    captured: AssistantWorkspace[],
    targets: AssistantMentionTarget[],
    signal?: AbortSignal,
  ): Promise<AssistantMentionTarget[]> {
    const leases = scopes.get(captured);
    if (
      !leases ||
      !captured.length ||
      !Array.isArray(targets) ||
      targets.length > ASSISTANT_MAX_MENTIONS ||
      !targets.every(isAssistantMentionTarget)
    )
      throw new Error("Invalid Ranger mentions or unapproved workspace scope");
    const guards = new Map(mentionGuards.get(captured));
    const canonical = await mapScopeReads(
      targets.map((target) => ({ ...target })),
      async (mention, _index, readSignal) => {
        const target = captured.find(
          (item) =>
            item.connection_id === mention.connection_id &&
            item.workspace_id === mention.workspace_id &&
            item.runtime_generation === mention.runtime_generation,
        );
        if (!target)
          throw new Error(
            "Mention is outside the approved scope or its connection changed",
          );
        const lease = leases.get(target.connection_id)!;
        const currentWorkspace = await workspace(
          lease,
          target.workspace_id,
          readSignal,
        );
        const currentTarget = {
          ...target,
          label: mentionLabel(currentWorkspace.label, target.workspace_id),
        };
        if (mention.kind === "workspace")
          return workspaceMention(currentTarget);
        const current = await agentMention(
          currentTarget,
          lease,
          mention.pane_id,
          readSignal,
        );
        if (
          current.terminal_id !== mention.terminal_id ||
          current.agent !== mention.agent ||
          current.agent_identity !== mention.agent_identity
        )
          throw new Error("Mentioned agent session changed; select it again");
        const previous = guards.get(agentKey(current));
        if (previous && previous.agent_identity !== current.agent_identity)
          throw new Error("Mentioned agent session changed; select it again");
        guards.set(agentKey(current), Object.freeze({ ...current }));
        return current;
      },
      signal,
    );
    for (const lease of leases.values()) assertCurrent(lease, signal);
    const merged = new Map(mentionGuards.get(captured));
    for (const [key, guard] of guards) {
      if (
        merged.has(key) &&
        merged.get(key)!.agent_identity !== guard.agent_identity
      )
        throw new Error("Mentioned agent session changed; select it again");
      merged.set(key, guard);
    }
    mentionGuards.set(captured, merged);
    return canonical;
  }

  async function catalog(): Promise<AssistantWorkspaceCatalog> {
    const connections = args.catalog().map(({ id, label }) => ({ id, label }));
    const settled = await Promise.allSettled(
      connections.map(async (connection) => {
        const connectionId = identifier(connection.id, "connection_id");
        const lease = args.lease(connectionId);
        if (!lease)
          return {
            connectionId,
            lease,
            endpoint: undefined,
            truncated: false,
            workspaces: [],
            errors: [
              `Connection ${limitedText(connection.label)} is not ready`,
            ],
          };
        const endpoint = fingerprint(connectionId);
        const payload = await readLeased(
          lease,
          () => lease.runtime.herdr.call("workspace.list", {}, 5000),
          `workspace list for connection ${connectionId}`,
        );
        if (!Array.isArray(payload?.workspaces))
          throw new Error("Invalid workspace list");
        const seen = new Set<string>();
        const truncated = payload.workspaces.length > ASSISTANT_MAX_WORKSPACES;
        const listed = Array.from(
          payload.workspaces.slice(0, ASSISTANT_MAX_WORKSPACES),
          (item: unknown): AssistantWorkspace => {
            if (!isRecord(item)) throw new Error("Invalid workspace list");
            const workspaceId = identifier(item.workspace_id, "workspace_id");
            if (seen.has(workspaceId))
              throw new Error("Invalid workspace list");
            seen.add(workspaceId);
            return {
              connection_id: connectionId,
              workspace_id: workspaceId,
              connection_label: limitedText(connection.label),
              label: limitedText(item.label),
              runtime_generation: lease.generation,
            };
          },
        );
        return {
          connectionId,
          lease,
          endpoint,
          truncated,
          workspaces: listed,
          errors: truncated
            ? [
                `Workspace list for connection ${limitedText(connection.label)} was truncated to ${ASSISTANT_MAX_WORKSPACES} entries`,
              ]
            : [],
        };
      }),
    );
    // A new connection may have been configured while another list was pending.
    // Use the current snapshot so its saved selection cannot be mistaken for a
    // removed connection, and recheck every successful lease at this boundary.
    const connectionIds = new Set(
      args.catalog().map(({ id }) => identifier(id, "connection_id")),
    );
    const workspaces: AssistantWorkspace[] = [];
    const errors: string[] = [];
    const completeConnectionIds: string[] = [];
    let truncated = false;
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        const listed = result.value;
        if (!listed.lease) {
          errors.push(...listed.errors);
          return;
        }
        if (
          connectionIds.has(listed.connectionId) &&
          listed.lease.isCurrent() &&
          fingerprint(listed.connectionId) === listed.endpoint
        ) {
          workspaces.push(...listed.workspaces);
          errors.push(...listed.errors);
          truncated ||= listed.truncated;
          if (!listed.truncated)
            completeConnectionIds.push(listed.connectionId);
          return;
        }
      }
      errors.push(
        `Unable to list workspaces for connection ${limitedText(connections[index]?.label)}`,
      );
    });
    if (workspaces.length > ASSISTANT_MAX_WORKSPACES) {
      truncated = true;
      completeConnectionIds.length = 0;
      errors.push(
        `Workspace catalog was truncated to ${ASSISTANT_MAX_WORKSPACES} entries`,
      );
    }
    return {
      workspaces: workspaces.slice(0, ASSISTANT_MAX_WORKSPACES),
      errors,
      connection_ids: [...connectionIds],
      complete_connection_ids: completeConnectionIds,
      truncated,
    };
  }

  async function captureScope(
    refs: AssistantWorkspaceRef[],
    signal?: AbortSignal,
    recoveryTargets?: RecoveryTarget[],
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
    const bootIds = new Map<string, Promise<string | null>>();
    const seen = new Set<string>();
    const validated = await mapScopeReads(
      requested,
      async (ref, index, readSignal) => {
        const connectionId = ref.connection_id;
        const workspaceId = ref.workspace_id;
        const key = `${connectionId}\0${workspaceId}`;
        if (seen.has(key)) throw new Error("Duplicate Ranger workspace scope");
        seen.add(key);
        const connection = connections.find((item) => item.id === connectionId);
        if (!connection) throw new Error(`Unknown connection ${connectionId}`);
        const expected = recoveryTargets?.[index];
        if (
          expected &&
          fingerprint(connectionId) !== expected.endpoint_fingerprint
        )
          throw new Error("Ranger recovery endpoint changed");
        const lease = leases.get(connectionId) ?? args.lease(connectionId);
        if (!lease) {
          if (recoveryTargets)
            throw new AssistantRecoveryNotReadyError(
              `Connection ${connectionId} is not ready`,
            );
          throw new Error(`Connection ${connectionId} is not ready`);
        }
        leases.set(connectionId, lease);
        if (expected) {
          let pending = bootIds.get(connectionId);
          if (!pending) {
            pending = recoveryIdentity(lease, readSignal);
            bootIds.set(connectionId, pending);
          }
          const bootId = await pending;
          if (!bootId || bootId !== expected.herdr_boot_id)
            throw new Error("Ranger recovery server identity changed");
        }
        const item = await workspace(lease, workspaceId, readSignal);
        const identity = workspaceIdentity(item);
        if (expected && identity !== expected.workspace_identity)
          throw new Error("Ranger recovery workspace changed");
        return {
          identity,
          workspace: Object.freeze({
            connection_id: connectionId,
            workspace_id: workspaceId,
            connection_label: limitedText(connection.label),
            label: limitedText(item.label),
            runtime_generation: lease.generation,
          }),
        };
      },
      signal,
    );
    const captured = validated.map((item) => item.workspace);
    const identities = validated.map((item) => item.identity);
    for (const lease of leases.values()) assertCurrent(lease, signal);
    for (const expected of recoveryTargets ?? [])
      if (fingerprint(expected.connection_id) !== expected.endpoint_fingerprint)
        throw new Error("Ranger recovery endpoint changed");
    Object.freeze(captured);
    scopes.set(captured, leases);
    workspaceIdentities.set(captured, identities);
    return captured;
  }

  async function recoveryIdentity(lease: RuntimeLease, signal?: AbortSignal) {
    if (!lease.runtime.recoveryIdentity) return null;
    return readLeased(
      lease,
      () => lease.runtime.recoveryIdentity(signal),
      "Ranger recovery server identity",
      signal,
    );
  }

  async function recoveryScope(
    captured: AssistantWorkspace[],
    signal?: AbortSignal,
  ): Promise<RecoveryTarget[]> {
    signal?.throwIfAborted();
    const leases = scopes.get(captured);
    const identities = workspaceIdentities.get(captured);
    if (!leases || !identities || !captured.length)
      throw new Error("Ranger workspace scope was not approved");
    const connectionIdentities = await mapScopeReads(
      [...leases],
      async ([connectionId, lease], _index, readSignal) => {
        assertCurrent(lease, readSignal);
        const endpoint = fingerprint(connectionId);
        const bootId = endpoint
          ? await recoveryIdentity(lease, readSignal)
          : null;
        return { connectionId, endpoint, bootId };
      },
      signal,
    );
    if (
      connectionIdentities.some(({ endpoint, bootId }) => !endpoint || !bootId)
    )
      return [];
    const byConnection = new Map(
      connectionIdentities.map((identity) => [identity.connectionId, identity]),
    );
    const targets = await mapScopeReads(
      captured,
      async (ref, index, readSignal): Promise<RecoveryTarget> => {
        const lease = leases.get(ref.connection_id)!;
        const { endpoint, bootId } = byConnection.get(ref.connection_id)!;
        if (
          workspaceIdentity(
            await workspace(lease, ref.workspace_id, readSignal),
          ) !== identities[index]
        )
          throw new Error("Ranger recovery workspace changed");
        return {
          connection_id: ref.connection_id,
          workspace_id: ref.workspace_id,
          endpoint_fingerprint: endpoint!,
          herdr_boot_id: bootId!,
          workspace_identity: identities[index]!,
        };
      },
      signal,
    );
    for (const lease of leases.values()) assertCurrent(lease, signal);
    for (const target of targets)
      if (fingerprint(target.connection_id) !== target.endpoint_fingerprint)
        throw new Error("Ranger recovery endpoint changed");
    return targets;
  }

  async function restoreScope(
    targets: RecoveryTarget[],
    signal?: AbortSignal,
  ): Promise<AssistantWorkspace[]> {
    signal?.throwIfAborted();
    if (
      !Array.isArray(targets) ||
      !targets.length ||
      targets.length > ASSISTANT_MAX_WORKSPACES ||
      !targets.every(
        (target) =>
          isRecord(target) &&
          typeof target.endpoint_fingerprint === "string" &&
          /^[a-f0-9]{64}$/.test(target.endpoint_fingerprint) &&
          typeof target.workspace_identity === "string" &&
          /^[a-f0-9]{64}$/.test(target.workspace_identity) &&
          typeof target.herdr_boot_id === "string" &&
          !!target.herdr_boot_id &&
          target.herdr_boot_id.length <= 500,
      )
    )
      throw new Error("Invalid Ranger recovery scope");
    // Clone before awaiting: persisted targets cannot change during admission.
    const expected = structuredClone(targets);
    const connections = new Map<string, string>();
    for (const target of expected) {
      const identity = JSON.stringify([
        target.endpoint_fingerprint,
        target.herdr_boot_id,
      ]);
      if (
        connections.has(target.connection_id) &&
        connections.get(target.connection_id) !== identity
      )
        throw new Error("Inconsistent Ranger recovery connection identity");
      connections.set(target.connection_id, identity);
    }
    return captureScope(expected, signal, expected);
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
        await assertMentionAgent(captured, target, paneId, signal);
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
      if (paneId) await assertMentionAgent(captured, target, paneId, signal);
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
    const paneId =
      typeof params.pane_id === "string" ? params.pane_id : undefined;
    if (paneId) await assertMentionAgent(captured, target, paneId, signal);
    const prepared = await prepareAssistantAction({
      kind,
      target,
      lease,
      params,
      signal,
      createWorktree: args.createWorktree,
    });
    if (paneId) await assertMentionAgent(captured, target, paneId, signal);
    if (
      !paneId ||
      !mentionGuards
        .get(captured)
        ?.has(agentKey({ ...target, pane_id: paneId }))
    )
      return prepared;
    return Object.freeze({
      ...prepared,
      execute: async (authorized?: () => boolean) => {
        try {
          await assertMentionAgent(captured, target, paneId);
        } catch {
          return {
            status: "failed" as const,
            detail:
              "Mentioned agent session changed or is unavailable. Nothing was sent; select it again.",
          };
        }
        return prepared.execute(authorized);
      },
    });
  }

  return {
    catalog,
    captureScope,
    recoveryScope,
    restoreScope,
    mentionCatalog,
    bindMentions,
    read,
    prepareAction,
  };
}

export type AssistantContext = Omit<
  ReturnType<typeof createAssistantContext>,
  | "prepareAction"
  | "recoveryScope"
  | "restoreScope"
  | "mentionCatalog"
  | "bindMentions"
> &
  Partial<
    Pick<
      ReturnType<typeof createAssistantContext>,
      | "prepareAction"
      | "recoveryScope"
      | "restoreScope"
      | "mentionCatalog"
      | "bindMentions"
    >
  >;
