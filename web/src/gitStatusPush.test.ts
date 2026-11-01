import { describe, expect, test } from "bun:test";
import { parseGitStatusPush, withGitStatuses } from "./gitStatusPush";
import type { GitStatusSummary, Workspace } from "./types";

function status(branch: string): GitStatusSummary {
  return {
    branch,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    dirty: false,
  };
}

function workspace(id: string, checkoutPath?: string): Workspace {
  return {
    workspace_id: id,
    number: 1,
    label: id,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    agent_status: "none",
    ...(checkoutPath
      ? {
          worktree: {
            repo_key: "repo",
            repo_name: "repo",
            repo_root: checkoutPath,
            checkout_path: checkoutPath,
            is_linked_worktree: false,
            git_status: status("old"),
          },
        }
      : {}),
  };
}

describe("git status push", () => {
  test("parses statuses and skips malformed entries", () => {
    const push = parseGitStatusPush({
      type: "workspace.git_status",
      statuses: [
        { checkout_path: "/a", git_status: status("main") },
        { checkout_path: 1, git_status: status("bad") },
        { checkout_path: "/c" },
      ],
    });
    expect([...(push ?? new Map()).keys()]).toEqual(["/a"]);
    expect(parseGitStatusPush({})).toBeNull();
  });

  test("patches only matching checkouts", () => {
    const workspaces = [workspace("w1", "/a"), workspace("w2", "/b")];
    workspaces.push(workspace("w3"));
    const next = withGitStatuses(
      workspaces,
      new Map([["/b", status("topic")]]),
    );
    expect(next[0]).toBe(workspaces[0]);
    expect(next[2]).toBe(workspaces[2]);
    expect(next[1].worktree?.git_status?.branch).toBe("topic");
    expect(workspaces[1].worktree?.git_status?.branch).toBe("old");
  });

  test("returns the same array when nothing matches", () => {
    const workspaces = [workspace("w1", "/a")];
    expect(withGitStatuses(workspaces, new Map([["/z", status("x")]]))).toBe(
      workspaces,
    );
  });
});
