import { lstat, readFile } from "node:fs/promises";
import { sshCommandArgv } from "../bridge/ssh-command";
import {
  repoWorktreeHooksEnabled,
  workspaceRepoSettingsKey,
} from "../config/gui-settings";
import {
  uniqueStrings,
  checkoutPath as workspaceCheckoutPath,
  sourceCheckoutPath as workspaceSourceCheckoutPath,
} from "../workspace/utils";

type RunProcess = (
  argv: string[],
  input?: string,
) => Promise<{ stdout: string; stderr: string }>;

type RunProcessWithCode = (
  argv: string[],
  input?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const WORKTREE_HOOK_EVENTS = [
  "worktree.created",
  "worktree.opened",
  "worktree.before_remove",
  "worktree.removed",
] as const;

export type WorktreeHookEvent = (typeof WORKTREE_HOOK_EVENTS)[number];

export type WorktreeHookRunResult = {
  event: WorktreeHookEvent;
  status: "skipped" | "succeeded" | "failed";
  reason?: "setup_hook_changed" | "hooks_enabled_changed";
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
};

export type WorktreeHookExpectation = {
  command: string | null;
  enabled: boolean;
};

type WorktreeHook = "setup" | "opened" | "teardown" | "removed";

export type WorktreeHookConfig = {
  setup?: string;
  opened?: string;
  teardown?: string;
  removed?: string;
};

export class WorktreeHookConfigError extends Error {
  constructor(
    readonly path: string,
    readonly source: "roamgate" | "paseo",
    cause: unknown,
  ) {
    super(
      `Failed to read worktree hooks from ${path}: ${(cause as Error).message}`,
      { cause },
    );
  }
}

export function createWorktreeHookRunner(args: {
  connectionId?: string;
  herdr: {
    call(method: string, params?: Record<string, unknown>): Promise<any>;
  };
  sshHost: () => string | undefined;
  runProcess: RunProcess;
  runProcessWithCode: RunProcessWithCode;
  shQuote: (value: string) => string;
  hooksEnabled?: (repoKey?: string | null) => Promise<boolean>;
}) {
  function repoSettingsKey(workspace: any): string | null {
    return workspaceRepoSettingsKey(
      workspace,
      args.sshHost(),
      args.connectionId,
    );
  }

  // Read on the execution host, distinguishing a missing file from empty content.
  async function readTextFileMaybe(path: string): Promise<string | null> {
    const host = args.sshHost();
    if (host) {
      const quoted = args.shQuote(path);
      const { stdout } = await args.runProcess(
        sshCommandArgv(
          host,
          `if [ -e ${quoted} ] || [ -L ${quoted} ]; then printf '1'; cat ${quoted}; fi`,
        ),
      );
      return stdout ? stdout.slice(1) : null;
    }
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return readFile(path, "utf8");
  }

  async function readWorktreeHooks(
    checkoutPath: string,
    sourceCheckoutPath?: string,
  ) {
    for (const source of ["roamgate", "paseo"] as const) {
      for (const base of uniqueStrings([checkoutPath, sourceCheckoutPath])) {
        const path = `${base.replace(/\/+$/, "")}/${source}.json`;
        try {
          const text = await readTextFileMaybe(path);
          if (text === null) continue;
          const raw = JSON.parse(text.replace(/^\uFEFF/, ""));
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new Error("configuration must be an object");
          }
          const config: WorktreeHookConfig = {};
          if ("worktree" in raw) {
            const worktree = raw.worktree;
            if (
              !worktree ||
              typeof worktree !== "object" ||
              Array.isArray(worktree)
            ) {
              throw new Error("worktree must be an object");
            }
            for (const hook of [
              "setup",
              "opened",
              "teardown",
              "removed",
            ] as const) {
              if (!(hook in worktree)) continue;
              if (typeof worktree[hook] !== "string") {
                throw new Error(`worktree.${hook} must be a string`);
              }
              config[hook] = worktree[hook];
            }
          }
          return { path, source, config };
        } catch (error) {
          throw new WorktreeHookConfigError(path, source, error);
        }
      }
    }
    return null;
  }

  // Map the hook vocabulary onto the existing GUI notice events.
  function worktreeHookEvent(hook: WorktreeHook): WorktreeHookEvent {
    switch (hook) {
      case "setup":
        return "worktree.created";
      case "opened":
        return "worktree.opened";
      case "teardown":
        return "worktree.before_remove";
      case "removed":
        return "worktree.removed";
    }
  }

  // Build shell-safe inline environment assignments for local and SSH execution.
  function shellEnvAssignments(env: Record<string, string>): string {
    return Object.entries(env)
      .map(([key, value]) => `${key}=${args.shQuote(value)}`)
      .join(" ");
  }

  // Execute a worktree hook inside the target checkout and capture output.
  async function runWorktreeHook(hookArgs: {
    hook: WorktreeHook;
    checkoutPath: string;
    sourceCheckoutPath?: string;
    cwdPath?: string;
    repoSettingsKey?: string | null;
    expected?: WorktreeHookExpectation;
    isCurrent?: () => boolean;
  }): Promise<WorktreeHookRunResult> {
    const event = worktreeHookEvent(hookArgs.hook);
    const assertCurrent = () => {
      if (hookArgs.isCurrent && !hookArgs.isCurrent())
        throw new Error("The worktree target changed.");
    };
    assertCurrent();
    if (!hookArgs.checkoutPath) return { event, status: "skipped" };
    const hooksEnabled = args.hooksEnabled ?? repoWorktreeHooksEnabled;
    const enabled = await hooksEnabled(hookArgs.repoSettingsKey);
    assertCurrent();
    if (hookArgs.expected && enabled !== hookArgs.expected.enabled) {
      return { event, status: "skipped", reason: "hooks_enabled_changed" };
    }
    if (!enabled && !hookArgs.expected) {
      return { event, status: "skipped" };
    }

    let loaded: Awaited<ReturnType<typeof readWorktreeHooks>>;
    try {
      loaded = await readWorktreeHooks(
        hookArgs.checkoutPath,
        hookArgs.sourceCheckoutPath,
      );
    } catch (e) {
      if (hookArgs.expected)
        return { event, status: "skipped", reason: "setup_hook_changed" };
      return {
        event,
        status: "failed",
        error: (e as Error).message,
      };
    }
    assertCurrent();
    const command = loaded?.config[hookArgs.hook] ?? null;
    if (hookArgs.expected && command !== hookArgs.expected.command) {
      return { event, status: "skipped", reason: "setup_hook_changed" };
    }
    if (!enabled || !loaded || typeof command !== "string" || !command.trim()) {
      return { event, status: "skipped" };
    }
    if (
      hookArgs.expected &&
      (await hooksEnabled(hookArgs.repoSettingsKey)) !==
        hookArgs.expected.enabled
    ) {
      return { event, status: "skipped", reason: "hooks_enabled_changed" };
    }
    assertCurrent();

    const env = shellEnvAssignments({
      PASEO_HOOK: hookArgs.hook,
      PASEO_CHECKOUT_PATH: hookArgs.checkoutPath,
      PASEO_SOURCE_CHECKOUT_PATH: hookArgs.sourceCheckoutPath ?? "",
      ROAMGATE_HOOK_EVENT: event,
      ROAMGATE_HOOK_CHECKOUT_PATH: hookArgs.checkoutPath,
      ROAMGATE_HOOK_SOURCE_CHECKOUT_PATH: hookArgs.sourceCheckoutPath ?? "",
      HERDR_GUI_HOOK_EVENT: event,
      HERDR_GUI_HOOK_CHECKOUT_PATH: hookArgs.checkoutPath,
      HERDR_GUI_HOOK_SOURCE_CHECKOUT_PATH: hookArgs.sourceCheckoutPath ?? "",
    });
    const cwdPath = hookArgs.cwdPath ?? hookArgs.checkoutPath;
    const script =
      `cd ${args.shQuote(cwdPath)} && ` +
      `${env} sh -c ${args.shQuote(command.trim())}`;
    const host = args.sshHost();
    const result = host
      ? await args.runProcessWithCode(sshCommandArgv(host, script))
      : await args.runProcessWithCode(["sh", "-c", script]);
    const prefix = [
      `worktree ${hookArgs.hook} hook`,
      `config: ${loaded.path}`,
      `checkout: ${hookArgs.checkoutPath}`,
      cwdPath !== hookArgs.checkoutPath ? `cwd: ${cwdPath}` : "",
      hookArgs.sourceCheckoutPath
        ? `source: ${hookArgs.sourceCheckoutPath}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      event,
      status: result.code === 0 ? "succeeded" : "failed",
      exit_code: result.code,
      stdout: [prefix, result.stdout.trim()].filter(Boolean).join("\n"),
      stderr: result.stderr,
    };
  }

  async function worktreeRemoveHookContext(
    params: Record<string, unknown>,
  ): Promise<{
    checkoutPath: string;
    sourceCheckoutPath: string;
    repoSettingsKey: string | null;
  } | null> {
    const workspaceId = String(params.workspace_id ?? "");
    if (!workspaceId) return null;
    const workspaceResult = await args.herdr.call("workspace.get", {
      workspace_id: workspaceId,
    });
    const workspace = workspaceResult?.workspace;
    const workspaceWorktree = workspace?.worktree;
    if (!workspaceWorktree?.is_linked_worktree) {
      return null;
    }
    return {
      checkoutPath: workspaceCheckoutPath(workspace),
      sourceCheckoutPath: workspaceSourceCheckoutPath(workspace),
      repoSettingsKey: repoSettingsKey(workspace),
    };
  }

  async function runWorktreeRemovedHook(
    context: Awaited<ReturnType<typeof worktreeRemoveHookContext>>,
  ): Promise<WorktreeHookRunResult> {
    if (!context) return { event: "worktree.removed", status: "skipped" };
    return runWorktreeHook({
      hook: "removed",
      checkoutPath: context.checkoutPath,
      sourceCheckoutPath: context.sourceCheckoutPath,
      cwdPath: context.sourceCheckoutPath,
      repoSettingsKey: context.repoSettingsKey,
    });
  }

  async function runWorktreeOpenedHook(
    result: any,
    sourceWorkspace: any | null,
  ): Promise<WorktreeHookRunResult> {
    const workspace =
      result?.workspace ?? (await resolveCreatedWorktreeWorkspace(result));
    if (!workspace?.worktree?.is_linked_worktree) {
      return { event: "worktree.opened", status: "skipped" };
    }
    return runWorktreeHook({
      hook: "opened",
      checkoutPath: workspaceCheckoutPath(workspace),
      sourceCheckoutPath: sourceWorkspace
        ? workspaceCheckoutPath(sourceWorkspace)
        : workspaceSourceCheckoutPath(workspace),
      repoSettingsKey: repoSettingsKey(workspace),
    });
  }

  // Capture the source workspace before Herdr mutates focus during creation.
  async function sourceWorkspaceForWorktreeCreate(
    params: Record<string, unknown>,
  ): Promise<any | null> {
    const workspaceId = String(params.workspace_id ?? "");
    if (!workspaceId) return null;
    const result = await args.herdr
      .call("workspace.get", { workspace_id: workspaceId })
      .catch(() => null);
    return result?.workspace ?? null;
  }

  // Resolve the newly created workspace from Herdr's create response.
  async function resolveCreatedWorktreeWorkspace(
    result: any,
  ): Promise<any | null> {
    if (result?.workspace) return result.workspace;
    const workspaceId =
      result?.workspace_id ??
      result?.worktree?.workspace_id ??
      result?.workspace?.workspace_id;
    if (workspaceId) {
      const workspaceResult = await args.herdr
        .call("workspace.get", { workspace_id: workspaceId })
        .catch(() => null);
      if (workspaceResult?.workspace) return workspaceResult.workspace;
    }
    const checkoutPath =
      result?.worktree?.checkout_path ??
      result?.worktree?.path ??
      result?.checkout_path ??
      result?.path;
    if (typeof checkoutPath === "string" && checkoutPath) {
      const list = await args.herdr
        .call("workspace.list", {})
        .catch(() => null);
      return (
        (list?.workspaces ?? []).find(
          (workspace: any) => workspaceCheckoutPath(workspace) === checkoutPath,
        ) ?? null
      );
    }
    return null;
  }

  // Run worktree.setup after Herdr has created and opened the worktree.
  async function runWorktreeSetupHook(
    result: any,
    sourceWorkspace: any | null,
    expected?: WorktreeHookExpectation,
    isCurrent?: () => boolean,
  ): Promise<WorktreeHookRunResult> {
    const workspace = await resolveCreatedWorktreeWorkspace(result);
    if (isCurrent && !isCurrent())
      throw new Error("The worktree target changed.");
    if (!workspace?.worktree?.is_linked_worktree) {
      return { event: "worktree.created", status: "skipped" };
    }
    return runWorktreeHook({
      hook: "setup",
      checkoutPath: workspaceCheckoutPath(workspace),
      sourceCheckoutPath: sourceWorkspace
        ? workspaceCheckoutPath(sourceWorkspace)
        : workspaceSourceCheckoutPath(workspace),
      repoSettingsKey: repoSettingsKey(workspace),
      expected,
      isCurrent,
    });
  }

  return {
    readWorktreeHooks,
    runWorktreeHook,
    worktreeRemoveHookContext,
    runWorktreeRemovedHook,
    runWorktreeOpenedHook,
    sourceWorkspaceForWorktreeCreate,
    runWorktreeSetupHook,
  };
}
