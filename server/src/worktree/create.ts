import { sshCommandArgv } from "../bridge/ssh-command";
import { fetchOriginDefaultBranch } from "../workspace/default-branch";
import { GIT_PULL_TIMEOUT_MS } from "../workspace/file-constants";
import type { RunProcessWithCodeTimeout } from "../workspace/file-types";
import type { LegacyConnectionRuntime } from "../connections/runtime";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import type { WorktreeHookExpectation } from "./worktree-hooks";

type GitRootResolver = (workspaceId: string) => Promise<{ root: string }>;

/** Refresh origin's default branch without changing the source checkout. */
export async function syncWorktreeBase({
  workspaceId,
  resolveGitRoot,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  workspaceId: string;
  resolveGitRoot: GitRootResolver;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}) {
  if (!workspaceId) throw new Error("worktree.create requires workspace_id");
  const { root } = await resolveGitRoot(workspaceId);
  const runGit = (args: string) => {
    const command = `GIT_TERMINAL_PROMPT=0 git -C ${shQuote(root)} ${args}`;
    return runProcessWithCodeTimeout(
      host ? sshCommandArgv(host, command) : ["sh", "-lc", command],
      GIT_PULL_TIMEOUT_MS,
    );
  };
  return {
    workspace_id: workspaceId,
    root,
    ...(await fetchOriginDefaultBranch(runGit, shQuote)),
  };
}

/** Shared by the workspace UI and Ranger's confirmed operations. */
export async function createWorkspaceWorktree(
  runtime: LegacyConnectionRuntime,
  params: Record<string, unknown>,
  isCurrent: () => boolean,
  parentWarning: (error: unknown) => void = () => {},
  syncBase = syncWorktreeBase,
) {
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error("The worktree target changed.");
  };
  assertCurrent();
  const {
    expected_setup_hook: expectedCommand,
    expected_hooks_enabled: expectedEnabled,
    expected_source_root: expectedRoot,
    ...createParams
  } = params;
  const guardedRoot = Object.hasOwn(params, "expected_source_root");
  if (guardedRoot && (typeof expectedRoot !== "string" || !expectedRoot.trim()))
    throw new Error("Confirmed source repository is invalid.");
  let expected: WorktreeHookExpectation | undefined;
  if (
    Object.hasOwn(params, "expected_setup_hook") ||
    Object.hasOwn(params, "expected_hooks_enabled")
  ) {
    if (
      (typeof expectedCommand !== "string" && expectedCommand !== null) ||
      typeof expectedEnabled !== "boolean"
    )
      throw new Error("Confirmed setup hook configuration is invalid.");
    expected = { command: expectedCommand, enabled: expectedEnabled };
  }
  const sourceWorkspace =
    await runtime.worktreeHooks.sourceWorkspaceForWorktreeCreate(createParams);
  assertCurrent();
  const workspaceId = String(createParams.workspace_id ?? "");
  const resolveGitRoot: GitRootResolver = async (id) => {
    assertCurrent();
    const result = await runtime.files.resolveWorkspaceGitRoot({
      workspace_id: id,
    });
    assertCurrent();
    if (guardedRoot && result.root !== expectedRoot)
      throw new Error("The worktree source repository changed.");
    return result;
  };
  const baseSync = await syncBase({
    workspaceId,
    resolveGitRoot,
    host: runtime.sshHost(),
    shQuote,
    runProcessWithCodeTimeout: async (argv, timeout) => {
      assertCurrent();
      const result = await runProcessWithCodeTimeout(argv, timeout);
      assertCurrent();
      return result;
    },
  });
  assertCurrent();
  const rpcParams: Record<string, unknown> = {
    ...createParams,
    base: baseSync.commit,
  };
  if (guardedRoot) {
    if (baseSync.root !== expectedRoot)
      throw new Error("The worktree source repository changed.");
    await resolveGitRoot(workspaceId);
    delete rpcParams.workspace_id;
    rpcParams.cwd = expectedRoot;
  }
  assertCurrent();
  const result = await runtime.herdr.call("worktree.create", rpcParams);
  assertCurrent();
  let parentTrackingFailed = false;
  await runtime.worktreeParents
    .rememberWorktreeParent(result, workspaceId, isCurrent)
    .catch((error) => {
      parentTrackingFailed = true;
      parentWarning(error);
    });
  assertCurrent();
  const hookSourceWorkspace = sourceWorkspace
    ? {
        ...sourceWorkspace,
        cwd:
          sourceWorkspace.worktree?.checkout_path ||
          sourceWorkspace.cwd ||
          baseSync.root,
      }
    : { cwd: baseSync.root };
  const setupHook = await runtime.worktreeHooks.runWorktreeSetupHook(
    result,
    hookSourceWorkspace,
    expected,
    isCurrent,
  );
  assertCurrent();
  return {
    ...result,
    base_sync: baseSync,
    setup_hook: setupHook,
    ...(parentTrackingFailed ? { parent_tracking_failed: true } : {}),
  };
}
