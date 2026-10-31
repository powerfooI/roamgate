import { describe, expect, test } from "bun:test";
import { repoSettingsKey, type GuiSettings } from "../config/gui-settings";
import { attachWorktreeParents, createWorktreeParentStore } from "./parents";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function settings(
  path: string,
  parentWorkspaceId: string,
  connectionId?: string,
): GuiSettings {
  return {
    version: 1,
    repositories: {},
    workspace_auto_sync: {},
    custom: {
      worktree_parent_by_checkout: {
        [repoSettingsKey(path, undefined, connectionId)]: parentWorkspaceId,
      },
    },
    ui: {},
  };
}

describe("worktree parent metadata", () => {
  const mainWorktree = {
    repo_key: "/repo/.git",
    repo_root: "/repo",
    checkout_path: "/repo",
    is_linked_worktree: false,
  };

  test("attaches the persisted source when a repo has several workspaces", () => {
    const linkedPath = "/worktrees/feature";
    const result = attachWorktreeParents(
      {
        workspaces: [
          { workspace_id: "w1", worktree: mainWorktree },
          { workspace_id: "w2", worktree: mainWorktree },
          {
            workspace_id: "w3",
            worktree: {
              ...mainWorktree,
              checkout_path: linkedPath,
              is_linked_worktree: true,
            },
          },
        ],
      },
      settings(linkedPath, "w1"),
    );

    expect(result.workspaces[2].worktree.parent_workspace_id).toBe("w1");
  });

  test("does not attach another connection's identical parent record", () => {
    const linkedPath = "/worktrees/feature";
    const input = {
      workspaces: [
        { workspace_id: "w1", worktree: mainWorktree },
        {
          workspace_id: "w2",
          worktree: {
            ...mainWorktree,
            checkout_path: linkedPath,
            is_linked_worktree: true,
          },
        },
      ],
    };
    const persisted = settings(linkedPath, "w1", "alpha");

    expect(
      attachWorktreeParents(input, persisted, undefined, "alpha").workspaces[1]
        .worktree.parent_workspace_id,
    ).toBe("w1");
    expect(attachWorktreeParents(input, persisted, undefined, "beta")).toEqual(
      input,
    );
  });

  test("does not commit stale parent additions or removals", async () => {
    const linkedPath = "/worktrees/feature";
    let current = true;
    let stored: GuiSettings = {
      version: 1,
      repositories: {},
      workspace_auto_sync: {},
      custom: {},
      ui: {},
    };
    const addGate = deferred();
    const addQueued = deferred();
    const addStore = createWorktreeParentStore({
      connectionId: "alpha",
      herdr: { call: async () => ({}) },
      sshHost: () => undefined,
      readSettings: async () => stored,
      updateSettings: async (update, shouldCommit = () => true) => {
        addQueued.resolve();
        await addGate.promise;
        if (!shouldCommit()) throw new Error("settings update cancelled");
        stored = await update(stored);
        return stored;
      },
    });
    const adding = addStore.rememberWorktreeParent(
      {
        workspace: {
          workspace_id: "w2",
          worktree: {
            ...mainWorktree,
            checkout_path: linkedPath,
            is_linked_worktree: true,
          },
        },
      },
      "w1",
      () => current,
    );
    await addQueued.promise;
    current = false;
    addGate.resolve();
    await expect(adding).rejects.toThrow("settings update cancelled");
    expect(stored.custom.worktree_parent_by_checkout).toBeUndefined();

    stored = settings(linkedPath, "w1", "alpha");
    current = true;
    const removeGate = deferred();
    const removeQueued = deferred();
    const removeStore = createWorktreeParentStore({
      connectionId: "alpha",
      herdr: { call: async () => ({}) },
      sshHost: () => undefined,
      readSettings: async () => stored,
      updateSettings: async (update, shouldCommit = () => true) => {
        removeQueued.resolve();
        await removeGate.promise;
        if (!shouldCommit()) throw new Error("settings update cancelled");
        stored = await update(stored);
        return stored;
      },
    });
    const removing = removeStore.forgetWorktree(linkedPath, () => current);
    await removeQueued.promise;
    current = false;
    removeGate.resolve();
    await expect(removing).rejects.toThrow("settings update cancelled");
    expect(
      (stored.custom.worktree_parent_by_checkout as Record<string, string>)[
        repoSettingsKey(linkedPath, undefined, "alpha")
      ],
    ).toBe("w1");
  });

  test("ignores a stale or incompatible parent record", () => {
    const linkedPath = "/worktrees/feature";
    const input = {
      workspaces: [
        {
          workspace_id: "w1",
          worktree: { ...mainWorktree, repo_key: "/other/.git" },
        },
        {
          workspace_id: "w2",
          worktree: {
            ...mainWorktree,
            checkout_path: linkedPath,
            is_linked_worktree: true,
          },
        },
      ],
    };

    expect(attachWorktreeParents(input, settings(linkedPath, "w1"))).toEqual(
      input,
    );
  });

  test("does not trust an unverified parent workspace", () => {
    const linkedPath = "/worktrees/feature";
    const input = {
      workspaces: [
        { workspace_id: "w1", label: "ordinary workspace" },
        {
          workspace_id: "w2",
          worktree: {
            ...mainWorktree,
            checkout_path: linkedPath,
            is_linked_worktree: true,
          },
        },
      ],
    };

    expect(attachWorktreeParents(input, settings(linkedPath, "w1"))).toEqual(
      input,
    );
  });
});
