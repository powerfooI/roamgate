import { expect, test } from "bun:test";
import { readConnectionAgentSessions } from "./agent-sessions";
import { ConnectionManager } from "./manager";

function fixture() {
  const calls: string[] = [];
  const replies = new Map<string, (method: string) => unknown>();
  const parents = new Map<string, string>();
  const platforms = new Map<string, "windows">();
  const gitReads: string[] = [];
  const activityReads: string[] = [];
  const activityResults = new Map<string, unknown>();
  const runtime = (id: string) => ({
    identity: { id, label: id, source: "test" },
    remotePlatform: platforms.get(id),
    startTransport: async () => {},
    startBackground() {},
    stop: async () => {},
    worktreeParents: {
      enrichWorkspaceList: async (result: { workspaces: object[] }) => ({
        ...result,
        workspaces: result.workspaces.map((workspace) => ({
          ...workspace,
          ...(parents.has(id)
            ? { worktree: { parent_workspace_id: parents.get(id) } }
            : {}),
        })),
      }),
    },
    status: {
      enrichWorkspacesWithGitStatus: async (result: any) => {
        gitReads.push(id);
        return {
          ...result,
          workspaces: result.workspaces.map((workspace: any) => ({
            ...workspace,
            worktree: {
              ...workspace.worktree,
              git_status: { branch: `${id}/main`, dirty: true, untracked: 2 },
            },
          })),
        };
      },
    },
    agentSessions: {
      listWithActivity: async (params: Record<string, unknown>) => {
        expect(params).toEqual({});
        activityReads.push(id);
        if (activityResults.has(id)) return activityResults.get(id);
        if (replies.has(id)) return await replies.get(id)!("agent.list");
        return { agents: [{ id: "same-id" }] };
      },
    },
    herdr: {
      call: async (
        method: string,
        _params?: unknown,
        timeout?: number | null,
      ) => {
        calls.push(`${id}:${method}`);
        expect(timeout).toBe(5000);
        if (replies.has(id)) return await replies.get(id)!(method);
        return { [method.split(".")[0] + "s"]: [{ id: "same-id" }] };
      },
    },
  });
  const manager = new ConnectionManager<ReturnType<typeof runtime>>("alpha");
  for (const id of ["alpha", "beta", "offline"]) {
    manager.register({
      identity: runtime(id).identity,
      createRuntime: () => runtime(id),
    });
  }
  return {
    manager,
    calls,
    replies,
    parents,
    platforms,
    gitReads,
    activityReads,
    activityResults,
  };
}

test("summarizes only ready connections without switching or starting others", async () => {
  const { manager, calls, parents, activityReads } = fixture();
  parents.set("alpha", "alpha-parent");
  parents.set("beta", "beta-parent");
  try {
    await Promise.all([manager.start("alpha"), manager.start("beta")]);
    const result = await readConnectionAgentSessions(manager);
    expect(result.connections.map((entry) => entry.connection_id)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(result.connections[0]).toMatchObject({
      connection_generation: manager.status("alpha").generation,
      panes: [{ id: "same-id" }],
    });
    expect(result.connections[1].panes).toEqual(result.connections[0].panes);
    expect(
      result.connections[0].workspaces[0].worktree.parent_workspace_id,
    ).toBe("alpha-parent");
    expect(
      result.connections[1].workspaces[0].worktree.parent_workspace_id,
    ).toBe("beta-parent");
    expect(result.connections[0].workspaces[0].worktree.git_status).toEqual({
      branch: "alpha/main",
      dirty: true,
      untracked: 2,
    });
    expect(result.connections[1].workspaces[0].worktree.git_status).toEqual({
      branch: "beta/main",
      dirty: true,
      untracked: 2,
    });
    expect(manager.defaultId()).toBe("alpha");
    expect(manager.status("offline").state).toBe("disconnected");
    expect(calls).toHaveLength(6);
    expect(activityReads).toEqual(["alpha", "beta"]);
  } finally {
    await manager.stopAll();
  }
});

test("contains read failures and tolerates missing optional agent metadata", async () => {
  const { manager, replies } = fixture();
  replies.set("alpha", () => {
    throw new Error("password=hidden failed");
  });
  replies.set("beta", (method) => {
    if (method === "agent.list") throw new Error("unsupported");
    return { [method.split(".")[0] + "s"]: [] };
  });
  try {
    await Promise.all([manager.start("alpha"), manager.start("beta")]);
    const result = await readConnectionAgentSessions(manager);
    expect(result.connections[0]).toMatchObject({
      panes: [],
      error: "password=*** failed",
    });
    expect(result.connections[1]).toMatchObject({ panes: [], agents: null });
    expect(result.connections[1]).not.toHaveProperty("error");
    replies.set("beta", () => ({}));
    expect(
      (await readConnectionAgentSessions(manager)).connections[1],
    ).toMatchObject({
      panes: [],
      error: "Invalid session list from Herdr",
    });
  } finally {
    await manager.stopAll();
  }
});

test("discards a retired runtime even if its read finishes before other servers", async () => {
  const { manager, replies } = fixture();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<unknown>();
  replies.set("beta", async (method) => {
    started.resolve();
    await finish.promise;
    return { [method.split(".")[0] + "s"]: [] };
  });
  try {
    await Promise.all([manager.start("alpha"), manager.start("beta")]);
    const result = readConnectionAgentSessions(manager);
    await started.promise;
    await manager.stop("alpha");
    finish.resolve(null);
    expect(
      (await result).connections.map((entry) => entry.connection_id),
    ).toEqual(["beta"]);
  } finally {
    finish.resolve(null);
    await manager.stopAll();
  }
});

test("Windows summaries use raw agents and skip Unix enrichment", async () => {
  const { manager, parents, platforms, gitReads, calls, activityReads } =
    fixture();
  platforms.set("alpha", "windows");
  parents.set("alpha", "alpha-parent");
  try {
    await Promise.all([manager.start("alpha"), manager.start("beta")]);
    const result = await readConnectionAgentSessions(manager);
    expect(gitReads).toEqual(["beta"]);
    expect(activityReads).toEqual(["beta"]);
    expect(calls).toContain("alpha:agent.list");
    expect(calls).not.toContain("beta:agent.list");
    expect(result.connections[0].agents).toEqual({
      agents: [{ id: "same-id" }],
    });
    expect(result.connections[0].workspaces[0].worktree).toEqual({
      parent_workspace_id: "alpha-parent",
    });
    expect(result.connections[1].workspaces[0].worktree.git_status.branch).toBe(
      "beta/main",
    );
  } finally {
    await manager.stopAll();
  }
});

test("preserves each Unix runtime's durable activity metadata", async () => {
  const { manager, activityResults } = fixture();
  activityResults.set("alpha", {
    agents: [
      { pane_id: "w1:p1", state_change_seq: 999, last_activity_at: 1000 },
    ],
  });
  activityResults.set("beta", {
    agents: [{ pane_id: "w1:p1", state_change_seq: 1, last_activity_at: 2000 }],
  });
  try {
    await Promise.all([manager.start("alpha"), manager.start("beta")]);
    const result = await readConnectionAgentSessions(manager);
    expect(result.connections.map(({ agents }) => agents)).toEqual([
      activityResults.get("alpha"),
      activityResults.get("beta"),
    ]);
  } finally {
    await manager.stopAll();
  }
});
