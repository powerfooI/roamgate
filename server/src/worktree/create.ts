import { sshCommandArgv } from "../bridge/ssh-command";
import { fetchOriginDefaultBranch } from "../workspace/default-branch";
import { GIT_PULL_TIMEOUT_MS } from "../workspace/file-constants";
import type { RunProcessWithCodeTimeout } from "../workspace/file-types";

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
