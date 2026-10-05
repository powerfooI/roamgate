import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import type {
  AssistantAction,
  AssistantActionKind,
  AssistantWorkspace,
} from "../../../shared/assistant";
import { isRecord } from "../agent/session-utils";
import {
  repoWorktreeHooksEnabled,
  workspaceRepoSettingsKey,
} from "../config/gui-settings";
import { validateConnectionId } from "../connections/protocol";
import type { LegacyConnectionRuntime } from "../connections/runtime";
import { checkoutPath } from "../workspace/utils";

export type AssistantActionPreview = Omit<
  AssistantAction,
  "id" | "status" | "created_at" | "detail"
>;
export type AssistantActionResult = {
  status: "succeeded" | "failed" | "uncertain";
  detail: string;
};
export type PreparedAssistantAction = {
  preview: AssistantActionPreview;
  execute(authorized?: () => boolean): Promise<AssistantActionResult>;
};
export type AssistantActionLease = {
  runtime: LegacyConnectionRuntime;
  generation: number;
  isCurrent(): boolean;
};
export type AssistantWorktreeCreator = (
  runtime: LegacyConnectionRuntime,
  params: Record<string, unknown>,
  isCurrent: () => boolean,
  beforeDispatch: () => void,
) => Promise<unknown>;

class DispatchNotSentError extends Error {}

function text(value: unknown, max = 200): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    throw new Error("Invalid action parameters");
  return value;
}

function absolutePath(value: unknown): string {
  const path = text(value, 2048);
  if (/[\r\n\t]/.test(path)) throw new Error("Invalid action directory");
  if (win32.isAbsolute(path) && /^[a-z]:[\\/]|^\\\\/i.test(path))
    return win32.normalize(path);
  if (posix.isAbsolute(path)) return posix.normalize(path);
  throw new Error("Action directory must be absolute");
}

function list(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((entry) => !isRecord(entry)))
    throw new Error("Action target is unavailable");
  return value;
}

function sessionIdentity(value: unknown) {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    !["id", "path"].includes(String(value.kind)) ||
    typeof value.value !== "string"
  )
    throw new Error("Cannot verify the target session");
  return {
    source: value.source,
    agent: value.agent,
    kind: value.kind,
    value: value.value,
  };
}

/** Only context's approved turn leases may reach this preparation function. */
export async function prepareAssistantAction(args: {
  kind: AssistantActionKind;
  target: AssistantWorkspace;
  lease: AssistantActionLease;
  params: Record<string, unknown>;
  signal?: AbortSignal;
  createWorktree?: AssistantWorktreeCreator;
}): Promise<PreparedAssistantAction> {
  const { kind, target, lease, signal } = args;
  const { runtime } = lease;
  let preparing = true;
  const keys = {
    create_workspace: ["connection_id", "workspace_id", "label", "cwd"],
    create_worktree: ["connection_id", "workspace_id", "branch", "label"],
    create_tab: ["connection_id", "workspace_id"],
    split_pane: ["connection_id", "workspace_id", "pane_id", "direction"],
    start_agent: ["connection_id", "workspace_id", "pane_id", "agent"],
    send_prompt: ["connection_id", "workspace_id", "pane_id", "prompt"],
  };
  if (
    !Object.hasOwn(keys, kind) ||
    !isRecord(args.params) ||
    Object.keys(args.params).some((key) => !keys[kind].includes(key))
  )
    throw new Error("Unsupported action parameters");
  // Snapshot only allowlisted strings before the first await; the caller can mutate its input.
  const params = Object.freeze(
    Object.fromEntries(
      Object.entries(args.params).map(([key, value]) => [
        key,
        text(value, key === "prompt" ? 20_000 : key === "cwd" ? 2048 : 200),
      ]),
    ),
  );
  if (
    params.connection_id !== target.connection_id ||
    params.workspace_id !== target.workspace_id
  )
    throw new Error("Action is outside the approved workspace scope");

  function check() {
    if (preparing) signal?.throwIfAborted();
    if (!lease.isCurrent()) throw new Error("Action connection changed");
  }
  async function read<T>(operation: () => Promise<T>): Promise<T> {
    check();
    const readSignal = preparing ? signal : undefined;
    let cancel: (() => void) | undefined;
    try {
      const pending = operation();
      const result = readSignal
        ? await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              cancel = () => reject(new Error("Action stopped"));
              readSignal.addEventListener("abort", cancel, { once: true });
              if (readSignal.aborted) cancel();
            }),
          ])
        : await pending;
      check();
      return result;
    } finally {
      if (cancel) readSignal?.removeEventListener("abort", cancel);
    }
  }
  const call = (
    method: string,
    query: Record<string, unknown>,
    timeout = 5000,
  ) => read(() => runtime.herdr.call(method, query, timeout));
  async function workspace(workspaceId = target.workspace_id) {
    const result = await call("workspace.get", { workspace_id: workspaceId });
    if (
      !isRecord(result?.workspace) ||
      result.workspace.workspace_id !== workspaceId
    )
      throw new Error("Action workspace changed");
    return result.workspace;
  }
  async function workspaces() {
    return list((await call("workspace.list", {}))?.workspaces);
  }
  async function worktrees() {
    return list(
      (await call("worktree.list", { workspace_id: target.workspace_id }))
        ?.worktrees,
    );
  }
  async function panes() {
    return list(
      (await call("pane.list", { workspace_id: target.workspace_id }))?.panes,
    ).filter((pane) => pane.workspace_id === target.workspace_id);
  }
  async function tabs() {
    return list(
      (await call("tab.list", { workspace_id: target.workspace_id }))?.tabs,
    ).filter((tab) => tab.workspace_id === target.workspace_id);
  }
  async function pane(paneId: string) {
    const item = (await call("pane.get", { pane_id: paneId }))?.pane;
    if (
      !isRecord(item) ||
      item.pane_id !== paneId ||
      item.workspace_id !== target.workspace_id
    )
      throw new Error("Source pane changed");
    return {
      pane_id: validateConnectionId(item.pane_id),
      tab_id: validateConnectionId(item.tab_id),
      terminal_id: validateConnectionId(item.terminal_id),
      cwd: absolutePath(item.cwd),
    };
  }
  async function sourceDirectory(
    current: Record<string, unknown>,
  ): Promise<
    | { cwd: string }
    | { cwd: string; pane_id: string; tab_id: string; terminal_id: string }
  > {
    const path = checkoutPath(current);
    if (path) return { cwd: absolutePath(path) };
    const panes = list(
      (await call("pane.list", { workspace_id: target.workspace_id }))?.panes,
    ).filter((pane) => pane.workspace_id === target.workspace_id);
    const pane = panes.find((item) => item.focused) ?? panes[0];
    if (!pane || typeof pane.terminal_id !== "string" || !pane.terminal_id)
      throw new Error("Cannot verify the source directory");
    return {
      cwd: absolutePath(pane.cwd),
      pane_id: validateConnectionId(pane.pane_id),
      tab_id: validateConnectionId(pane.tab_id),
      terminal_id: validateConnectionId(pane.terminal_id),
    };
  }
  async function occupant(paneId: string) {
    const pane = (await call("pane.get", { pane_id: paneId }))?.pane;
    if (!isRecord(pane)) throw new Error("Action pane changed");
    // agent.get lists detected agents only; an empty shell is inspected through pane.get.
    const agent = pane.agent
      ? (await call("agent.get", { target: paneId }))?.agent
      : pane;
    const process = (await call("pane.process_info", { pane_id: paneId }))
      ?.process_info;
    if (
      !isRecord(pane) ||
      !isRecord(agent) ||
      !isRecord(process) ||
      pane.pane_id !== paneId ||
      agent.pane_id !== paneId ||
      process.pane_id !== paneId ||
      pane.workspace_id !== target.workspace_id ||
      agent.workspace_id !== target.workspace_id ||
      typeof pane.terminal_id !== "string" ||
      !pane.terminal_id ||
      agent.terminal_id !== pane.terminal_id ||
      (pane.agent ?? null) !== (agent.agent ?? null)
    )
      throw new Error("Action pane changed");
    const processes = list(process.foreground_processes ?? [])
      .map((entry) => {
        if (!Number.isSafeInteger(entry.pid) || Number(entry.pid) <= 0)
          throw new Error("Cannot verify the target process");
        return { pid: entry.pid, name: entry.name };
      })
      .sort((left, right) => Number(left.pid) - Number(right.pid));
    if (
      (!Number.isSafeInteger(process.shell_pid) ||
        Number(process.shell_pid) <= 0) &&
      !processes.length
    )
      throw new Error("Cannot verify the target process");
    const identity = JSON.stringify({
      terminal_id: pane.terminal_id,
      tab_id: pane.tab_id,
      agent: agent.agent ?? null,
      name: agent.name ?? null,
      session: sessionIdentity(agent.agent_session),
      shell_pid: process.shell_pid,
      foreground_process_group_id: process.foreground_process_group_id,
      processes,
    });
    return {
      pane: { ...pane },
      agent: { ...agent },
      process: { ...process },
      identity,
    };
  }
  async function hookState(current: Record<string, unknown>, root: string) {
    const source = { ...current, cwd: checkoutPath(current) || root };
    const hooks = await read(() =>
      runtime.worktreeHooks.readWorktreeHooks(source.cwd),
    );
    const command = hooks?.config.setup ?? null;
    if (
      command !== null &&
      (typeof command !== "string" || command.length > 20_000)
    )
      throw new Error("Cannot preview this setup hook");
    const enabled = await read(() =>
      repoWorktreeHooksEnabled(
        workspaceRepoSettingsKey(
          source,
          runtime.sshHost(),
          target.connection_id,
        ),
      ),
    );
    return { command, enabled };
  }

  try {
    const current = await workspace();
    const workspaceIdentity = (item: Record<string, unknown>) =>
      JSON.stringify({
        cwd: item.cwd,
        worktree: isRecord(item.worktree)
          ? {
              repo_key: item.worktree.repo_key,
              repo_root: item.worktree.repo_root,
              checkout_path: item.worktree.checkout_path,
            }
          : null,
      });
    const frozenWorkspace = workspaceIdentity(current);
    let previewParams: Record<string, string>;
    let summary: string;
    let perform: (
      dispatch: (
        operation: (beforeSend: () => void) => Promise<unknown>,
      ) => Promise<unknown>,
      isCurrent: () => boolean,
    ) => Promise<AssistantActionResult>;
    if (kind === "create_workspace") {
      const label = text(params.label);
      if (/[\r\n\t]/.test(label)) throw new Error("Invalid workspace label");
      const source =
        params.cwd === undefined ? await sourceDirectory(current) : undefined;
      const cwd = source?.cwd ?? absolutePath(params.cwd);
      previewParams = { label, cwd };
      summary =
        "Create a workspace on this connection using the displayed directory. It will not change focus.";
      perform = async (dispatch) => {
        if (source && "pane_id" in source && "terminal_id" in source) {
          const pane = (await call("pane.get", { pane_id: source.pane_id }))
            ?.pane;
          if (
            !isRecord(pane) ||
            pane.workspace_id !== target.workspace_id ||
            pane.terminal_id !== source.terminal_id ||
            absolutePath(pane.cwd) !== cwd
          )
            throw new Error("Source pane or directory changed");
        }
        const before = await workspaces();
        if (before.some((item) => item.label === label))
          return {
            status: "failed",
            detail:
              "A workspace with this label already exists. No duplicate was created.",
          };
        const previousIds = new Set(before.map((item) => item.workspace_id));
        let response: unknown;
        try {
          response = await dispatch((beforeSend) =>
            runtime.herdr.call(
              "workspace.create",
              {
                label,
                cwd,
                source_workspace_id: target.workspace_id,
                focus: false,
              },
              30_000,
              beforeSend,
            ),
          );
        } catch (error) {
          if (error instanceof DispatchNotSentError) throw error;
          /* A lost reply may still have created the workspace. Verify before any retry. */
        }
        const returnedId =
          isRecord(response) && isRecord(response.workspace)
            ? response.workspace.workspace_id
            : undefined;
        const found = (await workspaces()).filter(
          (item) =>
            item.label === label &&
            !previousIds.has(item.workspace_id) &&
            (returnedId === undefined || item.workspace_id === returnedId),
        );
        if (found.length !== 1)
          return {
            status: "uncertain",
            detail:
              "Workspace creation was sent, but the result could not be verified. Inspect this connection before retrying.",
          };
        const id = validateConnectionId(found[0]!.workspace_id);
        await workspace(id);
        const panes = list(
          (await call("pane.list", { workspace_id: id }))?.panes,
        );
        if (
          !panes.some(
            (pane) =>
              pane.workspace_id === id &&
              typeof pane.cwd === "string" &&
              absolutePath(pane.cwd) === cwd,
          )
        )
          return {
            status: "uncertain",
            detail:
              "A new workspace was observed, but its directory could not be verified. Inspect it before retrying.",
          };
        return {
          status: "succeeded",
          detail: "The new workspace and its directory were verified.",
        };
      };
    } else if (kind === "create_worktree") {
      if (!args.createWorktree)
        throw new Error("Worktree creation is unavailable");
      const branch = text(params.branch);
      if (
        /^[./-]|[\s~^:?*[\\]|\.\.|@\{|\/$|\.$|\.lock(?:\/|$)/.test(branch) ||
        branch === "@"
      )
        throw new Error("Invalid worktree branch");
      const label = params.label === undefined ? undefined : text(params.label);
      const resolved = await read(() =>
        runtime.files.resolveWorkspaceGitRoot({
          workspace_id: target.workspace_id,
        }),
      );
      const root = absolutePath(resolved.root);
      const hooks = await hookState(current, root);
      previewParams = {
        branch,
        ...(label ? { label } : {}),
        cwd: root,
        base: "Latest origin default branch (fetched at confirmation)",
        setup_hook: hooks.command ?? "(none configured)",
        setup_hook_enabled: String(hooks.enabled),
      };
      summary =
        "Fetch origin's default branch, create its worktree, save the source relationship, and run the displayed setup hook if enabled. Focus will stay unchanged.";
      perform = async (dispatch, isCurrent) => {
        const actualRoot = await read(() =>
          runtime.files.resolveWorkspaceGitRoot({
            workspace_id: target.workspace_id,
          }),
        );
        if (
          absolutePath(actualRoot.root) !== root ||
          JSON.stringify(await hookState(await workspace(), root)) !==
            JSON.stringify(hooks)
        )
          throw new Error("Worktree source or setup hook changed");
        if ((await worktrees()).some((item) => item.branch === branch))
          return {
            status: "failed",
            detail:
              "A worktree for this branch already exists. No duplicate was created; inspect the existing checkout.",
          };
        const response = await dispatch((beforeDispatch) =>
          args.createWorktree!(
            runtime,
            {
              workspace_id: target.workspace_id,
              branch,
              ...(label ? { label } : {}),
              focus: false,
              expected_setup_hook: hooks.command,
              expected_hooks_enabled: hooks.enabled,
              expected_source_root: root,
            },
            isCurrent,
            beforeDispatch,
          ),
        );
        const created =
          isRecord(response) && isRecord(response.workspace)
            ? response.workspace.workspace_id
            : undefined;
        if (typeof created !== "string")
          throw new Error("Worktree result unavailable");
        await workspace(validateConnectionId(created));
        if (
          !(await worktrees()).some(
            (item) =>
              item.branch === branch && item.open_workspace_id === created,
          )
        )
          throw new Error("Worktree result unavailable");
        if (isRecord(response) && response.parent_tracking_failed === true)
          return {
            status: "failed",
            detail:
              "The worktree was created, but its source relationship could not be saved. Inspect it before retrying.",
          };
        const hook =
          isRecord(response) && isRecord(response.setup_hook)
            ? response.setup_hook
            : undefined;
        if (
          hook?.reason === "setup_hook_changed" ||
          hook?.reason === "hooks_enabled_changed"
        )
          return {
            status: "failed",
            detail:
              "The worktree was created, but setup was skipped because its configuration changed. Inspect it before retrying.",
          };
        if (hook?.status === "failed")
          return {
            status: "failed",
            detail:
              "The worktree was created, but its setup hook failed. Inspect it before retrying.",
          };
        return {
          status: "succeeded",
          detail:
            "The worktree and its workspace were verified. The configured creation flow completed.",
        };
      };
    } else if (kind === "create_tab") {
      const source = await sourceDirectory(current);
      const cwd = source.cwd;
      previewParams = { ...source };
      summary =
        "Create a tab with a new shell pane in this workspace using the displayed directory. Focus will stay unchanged.";
      perform = async (dispatch) => {
        const previousIds = new Set((await tabs()).map((tab) => tab.tab_id));
        const previousPanes = await panes();
        if (
          workspaceIdentity(await workspace()) !== frozenWorkspace ||
          ("pane_id" in source &&
            JSON.stringify(await pane(source.pane_id)) !==
              JSON.stringify({
                pane_id: source.pane_id,
                tab_id: source.tab_id,
                terminal_id: source.terminal_id,
                cwd,
              }))
        )
          throw new Error("Source directory changed");
        const response = await dispatch((beforeSend) =>
          runtime.herdr.call(
            "tab.create",
            { workspace_id: target.workspace_id, cwd, focus: false },
            30_000,
            beforeSend,
          ),
        );
        if (
          !isRecord(response) ||
          response.type !== "tab_created" ||
          !isRecord(response.tab) ||
          !isRecord(response.root_pane)
        )
          throw new Error("Tab creation result unavailable");
        const tabId = validateConnectionId(response.tab.tab_id);
        const paneId = validateConnectionId(response.root_pane.pane_id);
        const created = await pane(paneId);
        if (
          previousIds.has(tabId) ||
          response.tab.workspace_id !== target.workspace_id ||
          response.root_pane.workspace_id !== target.workspace_id ||
          response.root_pane.tab_id !== tabId ||
          created.tab_id !== tabId ||
          created.terminal_id !== response.root_pane.terminal_id ||
          created.cwd !== cwd ||
          previousPanes.some(
            (item) =>
              item.pane_id === paneId ||
              item.terminal_id === created.terminal_id,
          ) ||
          !(await tabs()).some((tab) => tab.tab_id === tabId)
        )
          throw new Error("Tab creation target could not be verified");
        return {
          status: "succeeded",
          detail: `Created tab ${tabId} with pane ${paneId} in the authorized workspace. Its directory was verified.`,
        };
      };
    } else if (kind === "split_pane") {
      const paneId = validateConnectionId(params.pane_id);
      const direction = params.direction;
      if (direction !== "right" && direction !== "down")
        throw new Error("Invalid split direction");
      const source = await pane(paneId);
      previewParams = { ...source, direction };
      summary =
        "Split this exact pane in the displayed direction, creating a new shell in the same tab and directory. Focus will stay unchanged.";
      perform = async (dispatch) => {
        const previous = await panes();
        if (JSON.stringify(await pane(paneId)) !== JSON.stringify(source))
          throw new Error("Source pane or directory changed");
        const response = await dispatch((beforeSend) =>
          runtime.herdr.call(
            "pane.split",
            {
              target_pane_id: paneId,
              direction,
              cwd: source.cwd,
              focus: false,
            },
            30_000,
            beforeSend,
          ),
        );
        if (
          !isRecord(response) ||
          response.type !== "pane_info" ||
          !isRecord(response.pane)
        )
          throw new Error("Pane split result unavailable");
        const createdId = validateConnectionId(response.pane.pane_id);
        const created = await pane(createdId);
        if (
          response.pane.workspace_id !== target.workspace_id ||
          response.pane.tab_id !== source.tab_id ||
          created.tab_id !== source.tab_id ||
          created.terminal_id !== response.pane.terminal_id ||
          created.cwd !== source.cwd ||
          previous.some(
            (item) =>
              item.pane_id === createdId ||
              item.terminal_id === created.terminal_id,
          ) ||
          JSON.stringify(await pane(paneId)) !== JSON.stringify(source)
        )
          throw new Error("Pane split target could not be verified");
        return {
          status: "succeeded",
          detail: `Created pane ${createdId} in tab ${source.tab_id}. Its source pane and directory were verified.`,
        };
      };
    } else {
      const paneId = validateConnectionId(params.pane_id);
      const frozen = await occupant(paneId);
      if (kind === "start_agent") {
        const agent = validateConnectionId(params.agent);
        const manifests = list(
          (await call("server.agent_manifests", {}))?.manifests,
        );
        if (!manifests.some((entry) => entry.agent === agent))
          throw new Error("Unknown agent");
        if (frozen.agent.agent && frozen.agent.agent !== agent)
          throw new Error("Pane already has another agent");
        if (
          !frozen.agent.agent &&
          frozen.process.foreground_process_group_id &&
          frozen.process.foreground_process_group_id !==
            frozen.process.shell_pid
        )
          throw new Error("Pane has a foreground process");
        const name = `ranger-${createHash("sha256")
          .update(`${paneId}\0${agent}`)
          .digest("hex")
          .slice(0, 20)}`;
        previewParams = {
          pane_id: paneId,
          terminal_id: String(frozen.pane.terminal_id),
          agent,
          name,
        };
        summary =
          "Start the selected coding agent in this exact pane. No custom command or arguments will be added.";
        perform = async (dispatch) => {
          const before = await occupant(paneId);
          if (before.identity !== frozen.identity)
            throw new Error("Pane occupant changed");
          if (before.agent.agent === agent)
            return {
              status: "succeeded",
              detail:
                "This coding agent is already running in the verified pane. No second agent was started.",
            };
          const deadline = Date.now() + 60_000;
          let response: unknown;
          try {
            response = await dispatch((beforeSend) =>
              runtime.herdr.call(
                "agent.start",
                {
                  pane_id: paneId,
                  kind: agent,
                  name,
                  timeout_ms: 60_000,
                },
                65_000,
                beforeSend,
              ),
            );
          } catch (error) {
            if (error instanceof DispatchNotSentError) throw error;
            /* Inspect the pane after a lost startup reply; never launch twice. */
          }
          if (
            response !== undefined &&
            (!isRecord(response) ||
              !isRecord(response.agent) ||
              response.agent.pane_id !== paneId ||
              response.agent.terminal_id !== frozen.pane.terminal_id)
          )
            return {
              status: "uncertain",
              detail:
                "Agent startup returned an unexpected target. Inspect this pane before retrying.",
            };
          // Raw agent.start is asynchronous. Match the native CLI's readiness wait,
          // using agent.get rather than pane/list snapshots or state-only agent.wait.
          while (true) {
            const pane = (await call("pane.get", { pane_id: paneId }))?.pane;
            if (
              !isRecord(pane) ||
              pane.pane_id !== paneId ||
              pane.workspace_id !== target.workspace_id ||
              pane.terminal_id !== frozen.pane.terminal_id
            )
              throw new Error("Agent startup target changed");
            let live: unknown;
            try {
              live = (await call("agent.get", { target: paneId }))?.agent;
            } catch (error) {
              // Detection may lag the launch; only a missing agent is retryable.
              if (
                !(error instanceof Error) ||
                !/^agent_not_found:/.test(error.message)
              )
                throw error;
            }
            if (live !== undefined) {
              if (
                !isRecord(live) ||
                live.pane_id !== paneId ||
                live.workspace_id !== target.workspace_id ||
                live.terminal_id !== frozen.pane.terminal_id ||
                (live.agent != null && live.agent !== agent) ||
                live.name !== name
              )
                throw new Error("Agent startup identity changed");
              if (live.agent_status === "blocked")
                return {
                  status: "failed",
                  detail:
                    "Agent startup was attempted, but the agent is blocked before becoming interactive. It may still be running; inspect this pane before retrying.",
                };
              if (
                live.agent === agent &&
                live.interactive_ready === true &&
                (["idle", "done"].includes(String(live.agent_status)) ||
                  (agent === "codex" && live.agent_status === "unknown"))
              )
                return {
                  status: "succeeded",
                  detail:
                    "The selected coding agent was verified as interactive in the original terminal.",
                };
              if (
                ["idle", "done"].includes(String(live.agent_status)) &&
                live.launch_pending !== true
              )
                return {
                  status: "failed",
                  detail:
                    "Agent startup was attempted, but Herdr reports that startup ended before the agent became interactive. Inspect this pane before retrying.",
                };
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0)
              return {
                status: "uncertain",
                detail:
                  "Agent startup was sent, but interactive readiness was not verified before the timeout. It may still be running; inspect this pane before retrying.",
              };
            await read(
              () =>
                new Promise<void>((resolve) =>
                  setTimeout(resolve, Math.min(100, remaining)),
                ),
            );
          }
        };
      } else {
        const prompt = text(params.prompt, 20_000);
        if (!frozen.agent.agent) throw new Error("Pane has no coding agent");
        previewParams = {
          pane_id: paneId,
          terminal_id: String(frozen.pane.terminal_id),
          agent: String(frozen.agent.agent),
          prompt,
        };
        summary =
          "Send the exact displayed prompt to this coding agent. It may trigger work or change files. Delivery will not be automatically retried.";
        perform = async (dispatch) => {
          if ((await occupant(paneId)).identity !== frozen.identity)
            throw new Error("Pane occupant changed");
          let result: unknown;
          try {
            result = await dispatch((beforeSend) =>
              runtime.herdr.call(
                "agent.prompt",
                { target: paneId, text: prompt },
                5000,
                beforeSend,
              ),
            );
          } catch (error) {
            // The public API rejects blocked agents before submitting any input.
            if (error instanceof Error && /^agent_blocked:/.test(error.message))
              return {
                status: "failed",
                detail:
                  "Herdr rejected the prompt because the agent is blocked. No prompt was submitted.",
              };
            throw error;
          }
          if (
            !isRecord(result) ||
            !isRecord(result.agent) ||
            result.agent.pane_id !== paneId ||
            (await occupant(paneId)).identity !== frozen.identity
          )
            return {
              status: "uncertain",
              detail:
                "Prompt submission was sent, but its target or delivery could not be verified. Inspect this pane; do not resend automatically.",
            };
          return {
            status: "uncertain",
            detail:
              "Herdr accepted the prompt. Delivery and the agent's response have not been independently verified. Do not resend automatically.",
          };
        };
      }
    }
    check();
    const preview = Object.freeze({
      kind,
      connection_id: target.connection_id,
      workspace_id: target.workspace_id,
      runtime_generation: lease.generation,
      connection_label: target.connection_label,
      workspace_label: target.label,
      params: Object.freeze(previewParams),
      summary,
    });
    // Pi may abort tool signals when disposing its session. Confirmation has its own admission.
    preparing = false;
    let execution: Promise<AssistantActionResult> | undefined;
    return Object.freeze({
      preview,
      execute(authorized?: () => boolean) {
        // The service persists admission before calling this one-shot closure.
        execution ??= (async () => {
          let dispatched = false;
          try {
            check();
            if (workspaceIdentity(await workspace()) !== frozenWorkspace)
              throw new Error("Source workspace changed");
            const isCurrent = () =>
              lease.isCurrent() && (!authorized || authorized());
            const result = await perform(async (operation) => {
              const assertAuthorized = () => {
                if (!isCurrent())
                  throw new DispatchNotSentError(
                    "Action authorization expired before dispatch",
                  );
              };
              assertAuthorized();
              try {
                return await read(() =>
                  operation(() => {
                    assertAuthorized();
                    dispatched = true;
                  }),
                );
              } catch (error) {
                if (!dispatched)
                  throw new DispatchNotSentError("Action was not dispatched");
                throw error;
              }
            }, isCurrent);
            check();
            return result;
          } catch {
            return {
              status: dispatched ? "uncertain" : "failed",
              detail: dispatched
                ? "The operation started, but its final state could not be verified. Inspect the target before retrying."
                : authorized && !authorized()
                  ? "Automatic approval was disabled before dispatch. Nothing was sent."
                  : "The target changed or the operation is unavailable. Nothing was sent; prepare a new preview.",
            } satisfies AssistantActionResult;
          }
        })();
        return execution;
      },
    });
  } catch {
    throw new Error(
      "Action preview is unavailable, outside the approved scope, or the target changed.",
    );
  }
}
