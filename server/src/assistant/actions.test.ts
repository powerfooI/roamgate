import { describe, expect, jest, mock, test } from "bun:test";
import type { AssistantActionKind } from "../../../shared/assistant";
import type { LegacyConnectionRuntime } from "../connections/runtime";
import { createWorkspaceWorktree } from "../worktree/create";
import { createAssistantContext } from "./context";

const ref = { connection_id: "local", workspace_id: "w1" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(paneId = "w1:p1") {
  const ref = {
    connection_id: "local",
    workspace_id: paneId.split(":")[0]!,
  };
  let generation = 7;
  let setup: string | null = null;
  const workspaces: Record<string, any>[] = [
    {
      workspace_id: ref.workspace_id,
      label: "Source",
      cwd: "/ranger-actions-fixture",
    },
  ];
  const panes: Record<string, any>[] = [
    {
      ...ref,
      pane_id: paneId,
      tab_id: `${ref.workspace_id}:t1`,
      terminal_id: "term1",
      cwd: "/ranger-actions-fixture",
      focused: true,
      agent: null,
      agent_session: null,
    },
  ];
  const agent: Record<string, any> = {
    ...panes[0],
    name: null,
    launch_pending: false,
  };
  const process: Record<string, any> = {
    pane_id: paneId,
    shell_pid: 101,
    foreground_process_group_id: 101,
    foreground_processes: [{ pid: 101, name: "shell" }],
  };
  const worktrees: Record<string, any>[] = [];
  const tabs: Record<string, any>[] = [
    {
      workspace_id: ref.workspace_id,
      tab_id: `${ref.workspace_id}:t1`,
      label: "Source",
    },
  ];
  const mutations: string[] = [];
  const createPane = (params: Record<string, unknown>, tabId: string) => {
    const pane = {
      workspace_id: ref.workspace_id,
      pane_id: `${ref.workspace_id}:p${panes.length + 1}`,
      tab_id: tabId,
      terminal_id: `term${panes.length + 1}`,
      cwd: params.cwd,
      agent: null,
    };
    panes.push(pane);
    return pane;
  };
  const createTab = (params: Record<string, unknown>) => {
    const tab = {
      workspace_id: params.workspace_id,
      tab_id: `${ref.workspace_id}:t${tabs.length + 1}`,
      label: "Tab",
    };
    tabs.push(tab);
    return {
      type: "tab_created",
      tab,
      root_pane: createPane(params, tab.tab_id),
    };
  };
  const createWorkspace = (params: Record<string, unknown>) => {
    const workspace = {
      workspace_id: "w2",
      label: params.label,
      cwd: params.cwd,
    };
    workspaces.push(workspace);
    panes.push({
      workspace_id: "w2",
      pane_id: "w2:p1",
      terminal_id: "term2",
      cwd: params.cwd,
    });
    return { type: "workspace_created", workspace };
  };
  const startAgent = (params: Record<string, unknown>) => {
    Object.assign(agent, {
      agent: params.kind,
      name: params.name,
      agent_status: "idle",
      interactive_ready: true,
    });
    panes[0]!.agent = params.kind;
    process.foreground_process_group_id = 202;
    process.foreground_processes = [{ pid: 202, name: params.kind }];
    return { type: "agent_started", agent: { ...agent } };
  };
  const call = mock(
    async (
      method: string,
      params: Record<string, unknown> = {},
      _timeout?: number,
      beforeSend?: () => void,
    ): Promise<any> => {
      beforeSend?.();
      if (
        [
          "workspace.create",
          "worktree.create",
          "tab.create",
          "pane.split",
          "agent.start",
          "agent.prompt",
        ].includes(method)
      )
        mutations.push(method);
      if (method === "workspace.get")
        return {
          workspace: workspaces.find(
            (item) => item.workspace_id === params.workspace_id,
          ),
        };
      if (method === "workspace.list") return { workspaces };
      if (method === "pane.list") return { panes };
      if (method === "tab.list") return { tabs };
      if (method === "pane.get")
        return { pane: panes.find((item) => item.pane_id === params.pane_id) };
      if (method === "agent.get") {
        if (!agent.agent)
          throw new Error("agent_not_found: No agent matched the pane");
        return { agent };
      }
      if (method === "pane.process_info")
        return { type: "pane_process_info", process_info: process };
      if (method === "server.agent_manifests")
        return { manifests: [{ agent: "pi" }] };
      if (method === "worktree.list") return { worktrees };
      if (method === "workspace.create") return createWorkspace(params);
      if (method === "tab.create") return createTab(params);
      if (method === "pane.split")
        return {
          type: "pane_info",
          pane: createPane(
            params,
            panes.find((item) => item.pane_id === params.target_pane_id)!
              .tab_id,
          ),
        };
      if (method === "agent.start") return startAgent(params);
      if (method === "agent.prompt")
        return {
          type: "agent_prompted",
          agent: { ...agent },
          secret: "private-key",
        };
      throw new Error(`Unexpected method ${method}`);
    },
  );
  const readWorktreeHooks = mock(async () =>
    setup === null
      ? null
      : {
          config: { setup },
          path: "/ranger-actions-fixture/roamgate.json",
          source: "roamgate" as const,
        },
  );
  const resolveWorkspaceGitRoot = mock(async () => ({
    root: "/ranger-actions-fixture",
    workspace: workspaces[0],
  }));
  const runtime = {
    herdr: { call },
    files: { resolveWorkspaceGitRoot },
    worktreeHooks: { readWorktreeHooks },
    sshHost: () => undefined,
  } as unknown as LegacyConnectionRuntime;
  const createWorktree = mock(
    async (
      _runtime: LegacyConnectionRuntime,
      params: Record<string, unknown>,
      isCurrent: () => boolean,
      beforeDispatch: () => void,
    ): Promise<any> => {
      if (!isCurrent()) throw new Error("retired");
      beforeDispatch();
      mutations.push("worktree.flow");
      const workspace = {
        workspace_id: "w2",
        label: params.label ?? params.branch,
        cwd: "/ranger-actions-child",
      };
      workspaces.push(workspace);
      worktrees.push({
        branch: params.branch,
        path: workspace.cwd,
        open_workspace_id: "w2",
      });
      return {
        workspace,
        setup_hook: { status: setup ? "succeeded" : "skipped" },
        secret: "private-key",
      };
    },
  );
  const lease = mock(() => {
    const capturedGeneration = generation;
    return {
      runtime,
      generation: capturedGeneration,
      isCurrent: () => generation === capturedGeneration,
    };
  });
  const context = createAssistantContext({
    catalog: () => [{ id: "local", label: "Local" }],
    lease,
    createWorktree,
  });
  return {
    context,
    runtime,
    call,
    lease,
    mutations,
    workspaces,
    panes,
    agent,
    process,
    worktrees,
    tabs,
    createWorkspace,
    startAgent,
    createWorktree,
    resolveWorkspaceGitRoot,
    readWorktreeHooks,
    setSetup: (value: string | null) => {
      setup = value;
    },
    retire: () => {
      generation++;
    },
    useAgent: () => {
      Object.assign(agent, {
        agent: "pi",
        name: "Worker",
        agent_session: {
          source: "herdr:pi",
          agent: "pi",
          kind: "id",
          value: "session1",
        },
      });
      Object.assign(panes[0]!, {
        agent: "pi",
        agent_session: agent.agent_session,
      });
      process.foreground_process_group_id = 202;
      process.foreground_processes = [{ pid: 202, name: "pi" }];
    },
    prepare: async (
      kind: AssistantActionKind,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ) =>
      context.prepareAction(
        kind,
        await context.captureScope([ref]),
        { ...ref, ...params },
        signal,
      ),
  };
}

describe("confirmed Ranger action targets", () => {
  test.each(["create_workspace", "create_tab", "start_agent"] as const)(
    "revocation at native %s dispatch sends nothing and does not enter lost-reply recovery",
    async (kind) => {
      const f = fixture();
      const params =
        kind === "create_workspace"
          ? { label: "Revoked" }
          : kind === "start_agent"
            ? { pane_id: "w1:p1", agent: "pi" }
            : {};
      const prepared = await f.prepare(kind, params);
      const connected = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let allowed = true;
      const original = f.call.getMockImplementation()!;
      f.call.mockImplementation(async (method, params, timeout, beforeSend) => {
        if (
          ["workspace.create", "tab.create", "agent.start"].includes(method)
        ) {
          connected.resolve();
          await release.promise;
        }
        return original(method, params, timeout, beforeSend);
      });
      const pending = prepared.execute(() => allowed);
      await connected.promise;
      allowed = false;
      release.resolve();
      expect(await pending).toEqual({
        status: "failed",
        detail:
          "Automatic approval was disabled before dispatch. Nothing was sent.",
      });
      expect(f.mutations).toEqual([]);
    },
  );

  test("worktree preparation forwards live permission through its awaited shared flow", async () => {
    const f = fixture();
    const prepared = await f.prepare("create_worktree", {
      branch: "feature/revoked",
    });
    const fetching = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let allowed = true;
    const original = f.createWorktree.getMockImplementation()!;
    f.createWorktree.mockImplementation(async (...args) => {
      fetching.resolve();
      await release.promise;
      return original(...args);
    });
    const pending = prepared.execute(() => allowed);
    await fetching.promise;
    allowed = false;
    release.resolve();
    expect(await pending).toEqual({
      status: "failed",
      detail:
        "Automatic approval was disabled before dispatch. Nothing was sent.",
    });
    expect(f.mutations).toEqual([]);
  });

  test.each(["preflight", "sync", "connect", "sent"] as const)(
    "worktree permission revoked at %s reports whether execution actually started",
    async (stage) => {
      const f = fixture();
      const prepared = await f.prepare("create_worktree", {
        branch: "feature/revoked",
      });
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const pause = async () => {
        reached.resolve();
        await release.promise;
      };
      f.runtime.worktreeHooks.sourceWorkspaceForWorktreeCreate = async () =>
        null;
      f.createWorktree.mockImplementation(
        (runtime, params, isCurrent, beforeDispatch) =>
          createWorkspaceWorktree(
            runtime,
            params,
            isCurrent,
            undefined,
            async (args) => {
              const { root } = await args.resolveGitRoot(args.workspaceId);
              if (stage === "sync") {
                await args.runProcessWithCodeTimeout(
                  [process.execPath, "-e", ""],
                  10_000,
                );
                f.mutations.push("base.sync");
              }
              if (stage === "preflight" || stage === "sync") await pause();
              return {
                workspace_id: args.workspaceId,
                root,
                base: "origin/main",
                commit: "a".repeat(40),
                command: "synthetic sync",
                stdout: "",
                stderr: "",
              };
            },
            beforeDispatch,
          ),
      );
      const original = f.call.getMockImplementation()!;
      f.call.mockImplementation(async (method, params, timeout, beforeSend) => {
        if (method !== "worktree.create")
          return original(method, params, timeout, beforeSend);
        if (stage === "connect") await pause();
        beforeSend?.();
        f.mutations.push(method);
        if (stage === "sent") await pause();
        throw new Error("Synthetic lost reply");
      });
      let allowed = true;
      const pending = prepared.execute(() => allowed);
      await reached.promise;
      allowed = false;
      release.resolve();
      const result = await pending;
      const started = stage === "sync" || stage === "sent";
      expect(result.status).toBe(started ? "uncertain" : "failed");
      expect(result.detail).toContain(
        started ? "operation started" : "Nothing was sent",
      );
      expect(f.mutations).toEqual(
        stage === "sync"
          ? ["base.sync"]
          : stage === "sent"
            ? ["worktree.create"]
            : [],
      );
      expect(await prepared.execute()).toBe(result);
    },
  );

  test.each([
    "create_workspace",
    "create_tab",
    "split_pane",
    "start_agent",
    "send_prompt",
  ] as const)(
    "native %s failure before sending does not enter lost-reply recovery",
    async (kind) => {
      const f = fixture();
      if (kind === "send_prompt") f.useAgent();
      const params =
        kind === "create_workspace"
          ? { label: "New" }
          : kind === "split_pane"
            ? { pane_id: "w1:p1", direction: "right" }
            : kind === "start_agent"
              ? { pane_id: "w1:p1", agent: "pi" }
              : kind === "send_prompt"
                ? { pane_id: "w1:p1", prompt: "Review" }
                : {};
      const prepared = await f.prepare(kind, params);
      const method = {
        create_workspace: "workspace.create",
        create_tab: "tab.create",
        split_pane: "pane.split",
        start_agent: "agent.start",
        send_prompt: "agent.prompt",
      }[kind];
      const original = f.call.getMockImplementation()!;
      f.call.mockImplementation(async (name, ...args) => {
        if (name === method) throw new Error("ECONNREFUSED: synthetic socket");
        return original(name, ...args);
      });
      const result = await prepared.execute();
      expect(result.status).toBe("failed");
      expect(result.detail).toContain("Nothing was sent");
      expect(f.mutations).toEqual([]);
      expect(await prepared.execute()).toBe(result);
      expect(
        f.call.mock.calls.filter(([name]) => name === method),
      ).toHaveLength(1);
    },
  );

  test("tab creation stays in the approved workspace and runs once after preview", async () => {
    const f = fixture();
    const prepared = await f.prepare("create_tab", {});
    expect(f.mutations).toEqual([]);
    expect(prepared.preview.params).toEqual({
      cwd: "/ranger-actions-fixture",
    });
    const [first, repeated] = await Promise.all([
      prepared.execute(),
      prepared.execute(),
    ]);
    expect(first).toBe(repeated);
    expect(first.status).toBe("succeeded");
    expect(first.detail).toContain("w1:t2");
    expect(first.detail).toContain("w1:p2");
    expect(f.mutations).toEqual(["tab.create"]);
    expect(f.call).toHaveBeenCalledWith(
      "tab.create",
      { workspace_id: "w1", cwd: "/ranger-actions-fixture", focus: false },
      30_000,
      expect.any(Function),
    );
    expect(f.workspaces).toHaveLength(1);
  });

  test("three previews can create three tabs without invalidating sibling proposals", async () => {
    const f = fixture();
    const proposals = await Promise.all(
      Array.from({ length: 3 }, () => f.prepare("create_tab", {})),
    );
    expect(f.mutations).toEqual([]);
    for (const proposal of proposals)
      expect((await proposal.execute()).status).toBe("succeeded");
    expect(f.tabs).toHaveLength(4);
    expect(f.panes).toHaveLength(4);
    expect(f.mutations).toEqual(["tab.create", "tab.create", "tab.create"]);
  });

  test("tab cwd is pinned despite another pane becoming focused", async () => {
    const f = fixture();
    delete f.workspaces[0]!.cwd;
    const prepared = await f.prepare("create_tab", {});
    expect(prepared.preview.params).toEqual({
      cwd: "/ranger-actions-fixture",
      pane_id: "w1:p1",
      tab_id: "w1:t1",
      terminal_id: "term1",
    });
    f.panes[0]!.focused = false;
    f.panes.push({
      workspace_id: "w1",
      pane_id: "w1:p2",
      tab_id: "w1:t1",
      terminal_id: "term2",
      cwd: "/other",
      focused: true,
    });
    expect((await prepared.execute()).status).toBe("succeeded");
    expect(f.call).toHaveBeenCalledWith(
      "tab.create",
      { workspace_id: "w1", cwd: "/ranger-actions-fixture", focus: false },
      30_000,
      expect.any(Function),
    );
  });

  test("splitting a busy pane creates a shell in the same tab with its pinned cwd", async () => {
    for (const direction of ["right", "down"]) {
      const f = fixture();
      f.useAgent();
      const prepared = await f.prepare("split_pane", {
        pane_id: "w1:p1",
        direction,
      });
      expect(f.mutations).toEqual([]);
      expect(prepared.preview.params).toEqual({
        pane_id: "w1:p1",
        tab_id: "w1:t1",
        terminal_id: "term1",
        cwd: "/ranger-actions-fixture",
        direction,
      });
      const result = await prepared.execute();
      expect(result.status).toBe("succeeded");
      expect(result.detail).toContain("w1:p2");
      expect(result.detail).toContain("w1:t1");
      expect(f.mutations).toEqual(["pane.split"]);
      expect(f.call).toHaveBeenCalledWith(
        "pane.split",
        {
          target_pane_id: "w1:p1",
          direction,
          cwd: "/ranger-actions-fixture",
          focus: false,
        },
        30_000,
        expect.any(Function),
      );
      expect(f.panes[0]!.agent).toBe("pi");
      expect(f.tabs).toHaveLength(1);
      expect(await prepared.execute()).toBe(result);
    }
  });

  test("layout proposals reject extra parameters and targets outside the authorized workspace", async () => {
    const f = fixture();
    for (const params of [
      { cwd: "/private" },
      { focus: true },
      { env: "SECRET=value" },
      { workspace_id: "w2" },
    ])
      await expect(f.prepare("create_tab", params)).rejects.toThrow();
    for (const params of [
      { pane_id: "w1:p1", direction: "left" },
      { pane_id: "w1:p1", direction: "right", ratio: "0.9" },
      { pane_id: "w1:p1", direction: "right", cwd: "/private" },
      { pane_id: "w2:p1", direction: "right" },
    ])
      await expect(f.prepare("split_pane", params)).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });

  test("layout target changes and retired runtimes reject before dispatch", async () => {
    for (const kind of ["create_tab", "split_pane"] as const) {
      for (const change of [
        "generation",
        "directory",
        "tab",
        "terminal",
        "workspace",
        "closed",
      ]) {
        const f = fixture();
        delete f.workspaces[0]!.cwd;
        const prepared = await f.prepare(
          kind,
          kind === "split_pane" ? { pane_id: "w1:p1", direction: "right" } : {},
        );
        if (change === "generation") f.retire();
        else if (change === "directory") f.panes[0]!.cwd = "/replacement";
        else if (change === "tab") f.panes[0]!.tab_id = "w1:t9";
        else if (change === "terminal") f.panes[0]!.terminal_id = "replacement";
        else if (change === "workspace") f.panes[0]!.workspace_id = "w2";
        else f.panes.length = 0;
        expect((await prepared.execute()).status).toBe("failed");
        expect(f.mutations).toEqual([]);
      }
    }
  });

  test("a lost layout reply is uncertain and never replays the creation", async () => {
    for (const kind of ["create_tab", "split_pane"] as const) {
      const f = fixture();
      const prepared = await f.prepare(
        kind,
        kind === "split_pane" ? { pane_id: "w1:p1", direction: "right" } : {},
      );
      const original = f.call.getMockImplementation()!;
      f.call.mockImplementation(
        async (method, params = {}, timeout, beforeSend) => {
          const result = await original(method, params, timeout, beforeSend);
          if (method === "tab.create" || method === "pane.split")
            throw new Error("timeout SECRET /private/socket");
          return result;
        },
      );
      const result = await prepared.execute();
      expect(result.status).toBe("uncertain");
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(await prepared.execute()).toBe(result);
      expect(f.mutations).toHaveLength(1);
    }
  });

  test("unexpected or replaced layout results are uncertain", async () => {
    for (const kind of ["create_tab", "split_pane"] as const) {
      for (const change of [
        "workspace",
        "tab",
        "directory",
        "terminal",
        "reused",
        "missing",
        "retired",
      ]) {
        const f = fixture();
        const prepared = await f.prepare(
          kind,
          kind === "split_pane" ? { pane_id: "w1:p1", direction: "right" } : {},
        );
        const original = f.call.getMockImplementation()!;
        f.call.mockImplementation(
          async (method, params = {}, timeout, beforeSend) => {
            const result = await original(method, params, timeout, beforeSend);
            if (method !== "tab.create" && method !== "pane.split")
              return result;
            const newPane = result.root_pane ?? result.pane;
            const returned = structuredClone(result);
            if (change === "workspace") newPane.workspace_id = "w2";
            else if (change === "tab") newPane.tab_id = "w1:t9";
            else if (change === "directory") newPane.cwd = "/wrong";
            else if (change === "terminal") newPane.terminal_id = "replacement";
            else if (change === "reused") newPane.terminal_id = "term1";
            else if (change === "missing") f.panes.pop();
            else f.retire();
            return returned;
          },
        );
        const result = await prepared.execute();
        expect(result.status).toBe("uncertain");
        expect(await prepared.execute()).toBe(result);
        expect(f.mutations).toHaveLength(1);
      }
    }
  });

  test("workspace preparation is readonly, freezes parameters, and executes only once", async () => {
    const f = fixture();
    const scope = await f.context.captureScope([ref]);
    const params = { ...ref, label: "New workspace" };
    const prepared = await f.context.prepareAction(
      "create_workspace",
      scope,
      params,
    );
    expect(f.mutations).toEqual([]);
    expect(prepared.preview).toMatchObject({
      ...ref,
      runtime_generation: 7,
      workspace_label: "Source",
      params: { label: "New workspace", cwd: "/ranger-actions-fixture" },
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.preview.params)).toBe(true);
    params.label = "Changed after preparation";
    const [first, second] = await Promise.all([
      prepared.execute(),
      prepared.execute(),
    ]);
    expect(first.status).toBe("succeeded");
    expect(second).toBe(first);
    expect(f.mutations).toEqual(["workspace.create"]);
    expect(f.call).toHaveBeenCalledWith(
      "workspace.create",
      {
        label: "New workspace",
        cwd: "/ranger-actions-fixture",
        source_workspace_id: "w1",
        focus: false,
      },
      30_000,
      expect.any(Function),
    );
  });

  test("a completed preview survives disposal of the model tool signal", async () => {
    const f = fixture();
    const controller = new AbortController();
    const prepared = await f.prepare(
      "create_workspace",
      { label: "New" },
      controller.signal,
    );
    controller.abort(new Error("Pi disposed its session"));
    expect((await prepared.execute()).status).toBe("succeeded");
    expect(f.mutations).toEqual(["workspace.create"]);
  });

  test("preparation cancellation stops admission without a write", async () => {
    const f = fixture();
    const scope = await f.context.captureScope([ref]);
    const gate = deferred<any>();
    f.call.mockImplementationOnce(() => gate.promise);
    const controller = new AbortController();
    const pending = f.context.prepareAction(
      "create_workspace",
      scope,
      { ...ref, label: "New" },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow("preview is unavailable");
    expect(f.mutations).toEqual([]);
    gate.resolve({ workspace: f.workspaces[0] });
  });

  test("forged, cross-workspace and unsupported action inputs never acquire capabilities", async () => {
    const f = fixture();
    const scope = await f.context.captureScope([ref]);
    await expect(
      f.context.prepareAction("create_workspace", [...scope], {
        ...ref,
        label: "New",
      }),
    ).rejects.toThrow("not approved");
    await expect(
      f.context.prepareAction("create_workspace", scope, {
        ...ref,
        workspace_id: "w2",
        label: "New",
      }),
    ).rejects.toThrow("outside");
    await expect(
      f.context.prepareAction("create_workspace", scope, {
        ...ref,
        label: "New",
        env: { SECRET: "key" },
      }),
    ).rejects.toThrow("Unsupported");
    await expect(
      f.context.prepareAction("create_workspace", scope, {
        ...ref,
        label: "New",
        cwd: "../private",
      }),
    ).rejects.toThrow("preview is unavailable");
    await expect(
      f.prepare("create_worktree", { branch: "-danger" }),
    ).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });

  test("retired connections and source directory changes reject before dispatch", async () => {
    for (const change of ["generation", "directory", "closed"]) {
      const f = fixture();
      const prepared = await f.prepare("create_workspace", { label: "New" });
      if (change === "generation") f.retire();
      else if (change === "directory") f.workspaces[0]!.cwd = "/replacement";
      else f.workspaces.length = 0;
      expect((await prepared.execute()).status).toBe("failed");
      expect(f.mutations).toEqual([]);
      expect(f.lease).toHaveBeenCalledTimes(1);
    }
  });

  test("inferred shell directories stay tied to the original pane", async () => {
    const f = fixture();
    delete f.workspaces[0]!.cwd;
    const prepared = await f.prepare("create_workspace", { label: "New" });
    f.panes[0]!.terminal_id = "replacement-terminal";
    expect((await prepared.execute()).status).toBe("failed");
    expect(f.mutations).toEqual([]);
  });

  test("workspace creation checks existing names and verifies a lost reply without retrying", async () => {
    const f = fixture();
    const prepared = await f.prepare("create_workspace", { label: "New" });
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(
      async (method, params = {}, timeout, beforeSend) => {
        if (method !== "workspace.create")
          return original(method, params, timeout, beforeSend);
        await original(method, params, timeout, beforeSend);
        throw new Error("connection closed: SECRET /private/socket");
      },
    );
    expect((await prepared.execute()).status).toBe("succeeded");
    await prepared.execute();
    expect(f.mutations).toEqual(["workspace.create"]);
    const duplicate = await f.prepare("create_workspace", { label: "New" });
    expect((await duplicate.execute()).status).toBe("failed");
    expect(f.mutations).toEqual(["workspace.create"]);
  });

  test("an unverified write is uncertain, sanitized, and is never replayed", async () => {
    const f = fixture();
    const prepared = await f.prepare("create_workspace", { label: "New" });
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(
      async (method, params = {}, timeout, beforeSend) => {
        if (method !== "workspace.create")
          return original(method, params, timeout, beforeSend);
        beforeSend?.();
        f.mutations.push(method);
        throw new Error("timeout: SECRET /private/socket");
      },
    );
    const result = await prepared.execute();
    expect(result.status).toBe("uncertain");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("/private");
    expect(await prepared.execute()).toBe(result);
    expect(f.mutations).toEqual(["workspace.create"]);
  });

  test("worktree preview includes the hook and uses the complete injected GUI flow", async () => {
    const f = fixture();
    f.setSetup("bun install");
    const prepared = await f.prepare("create_worktree", {
      branch: "feature/ranger",
      label: "Task",
    });
    expect(f.mutations).toEqual([]);
    expect(prepared.preview.params).toMatchObject({
      branch: "feature/ranger",
      setup_hook: "bun install",
      setup_hook_enabled: "true",
    });
    expect((await prepared.execute()).status).toBe("succeeded");
    expect(f.mutations).toEqual(["worktree.flow"]);
    expect(f.createWorktree.mock.calls[0]?.[1]).toEqual({
      workspace_id: "w1",
      branch: "feature/ranger",
      label: "Task",
      focus: false,
      expected_setup_hook: "bun install",
      expected_hooks_enabled: true,
      expected_source_root: "/ranger-actions-fixture",
    });
    expect(
      f.call.mock.calls.some(([method]) => method === "worktree.create"),
    ).toBe(false);
  });

  test("worktree source hook changes block dispatch and target hook guards report partial failure", async () => {
    const f = fixture();
    f.setSetup("bun install");
    const prepared = await f.prepare("create_worktree", {
      branch: "feature/ranger",
    });
    f.setSetup("changed command");
    expect((await prepared.execute()).status).toBe("failed");
    expect(f.createWorktree).not.toHaveBeenCalled();
    f.setSetup("bun install");
    const next = await f.prepare("create_worktree", {
      branch: "feature/ranger",
    });
    const original = f.createWorktree.getMockImplementation()!;
    f.createWorktree.mockImplementation(async (...args) => ({
      ...(await original(...args)),
      setup_hook: {
        status: "skipped",
        reason: "setup_hook_changed",
        stderr: "SECRET",
      },
    }));
    const result = await next.execute();
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("worktree was created");
    expect(result.detail).not.toContain("SECRET");
  });

  test("start uses a supported manifest, handles empty shells, and verifies the agent once", async () => {
    const f = fixture();
    const prepared = await f.prepare("start_agent", {
      pane_id: "w1:p1",
      agent: "pi",
    });
    expect(prepared.preview.params.name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(f.mutations).toEqual([]);
    expect(f.call.mock.calls.some(([method]) => method === "agent.get")).toBe(
      false,
    );
    expect((await prepared.execute()).status).toBe("succeeded");
    await prepared.execute();
    expect(f.mutations).toEqual(["agent.start"]);
    expect(f.call).toHaveBeenCalledWith(
      "agent.start",
      {
        pane_id: "w1:p1",
        kind: "pi",
        name: prepared.preview.params.name,
        timeout_ms: 60_000,
      },
      65_000,
      expect.any(Function),
    );
    await expect(
      f.prepare("start_agent", { pane_id: "w1:p1", agent: "uninstalled" }),
    ).rejects.toThrow();
  });

  test("start names stay valid and stable for uppercase and maximum-length pane IDs", async () => {
    const names: string[] = [];
    for (const paneId of ["wN:pW", "wn:pw", `wN:p${"W".repeat(124)}`]) {
      const f = fixture(paneId);
      const params = { pane_id: paneId, agent: "pi" };
      const prepared = await f.prepare("start_agent", params);
      const name = prepared.preview.params.name as string;
      expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
      expect((await f.prepare("start_agent", params)).preview.params.name).toBe(
        name,
      );
      expect((await prepared.execute()).status).toBe("succeeded");
      expect(f.call).toHaveBeenCalledWith(
        "agent.start",
        { pane_id: paneId, kind: "pi", name, timeout_ms: 60_000 },
        65_000,
        expect.any(Function),
      );
      expect(f.mutations).toEqual(["agent.start"]);
      names.push(name);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  test("raw asynchronous startup waits for agent.get readiness in the original terminal", async () => {
    jest.useFakeTimers();
    try {
      const f = fixture();
      const prepared = await f.prepare("start_agent", {
        pane_id: "w1:p1",
        agent: "pi",
      });
      const polled = deferred<void>();
      const original = f.call.getMockImplementation()!;
      f.call.mockImplementation(
        async (method, params = {}, timeout, beforeSend) => {
          const response = await original(method, params, timeout, beforeSend);
          if (method === "agent.start") {
            Object.assign(f.agent, {
              launch_pending: true,
              interactive_ready: false,
            });
            return { ...response, agent: { ...f.agent } };
          }
          if (method === "agent.get" && f.agent.interactive_ready === false)
            polled.resolve();
          return response;
        },
      );
      let finished = false;
      const executing = prepared.execute().then((result) => {
        finished = true;
        return result;
      });
      await polled.promise;
      // Flush the in-flight RPC continuation so the readiness retry timer is admitted.
      for (let index = 0; index < 10; index++) await Promise.resolve();
      expect(finished).toBe(false);
      expect(f.mutations).toEqual(["agent.start"]);
      Object.assign(f.agent, {
        agent_status: "done",
        interactive_ready: true,
      });
      // A stale launch_pending flag does not override explicit readiness from agent.get.
      jest.advanceTimersByTime(100);
      const result = await executing;
      expect(result.status).toBe("succeeded");
      expect(result.detail).toContain("interactive");
      expect(await prepared.execute()).toBe(result);
      expect(f.mutations).toEqual(["agent.start"]);
      expect(
        f.call.mock.calls.some(([method]) => method === "agent.wait"),
      ).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test("startup blocked or ended before readiness reports attempted startup without relaunching", async () => {
    for (const state of ["blocked", "exited"]) {
      const f = fixture();
      const prepared = await f.prepare("start_agent", {
        pane_id: "w1:p1",
        agent: "pi",
      });
      const original = f.call.getMockImplementation()!;
      f.call.mockImplementation(
        async (method, params = {}, timeout, beforeSend) => {
          const response = await original(method, params, timeout, beforeSend);
          if (method === "agent.start")
            Object.assign(f.agent, {
              agent_status: state === "blocked" ? "blocked" : "done",
              interactive_ready: false,
              launch_pending: state === "blocked",
            });
          return response;
        },
      );
      const result = await prepared.execute();
      expect(result.status).toBe("failed");
      expect(result.detail).toContain("startup was attempted");
      expect(result.detail.toLowerCase()).toContain("inspect this pane");
      expect(await prepared.execute()).toBe(result);
      expect(f.mutations).toEqual(["agent.start"]);
    }
  });

  test("startup wait is bounded and stops on retirement or terminal/name replacement", async () => {
    jest.useFakeTimers();
    try {
      for (const change of ["timeout", "retired", "terminal", "name"]) {
        const f = fixture();
        const prepared = await f.prepare("start_agent", {
          pane_id: "w1:p1",
          agent: "pi",
        });
        const polled = deferred<void>();
        const original = f.call.getMockImplementation()!;
        f.call.mockImplementation(
          async (method, params = {}, timeout, beforeSend) => {
            const response = await original(
              method,
              params,
              timeout,
              beforeSend,
            );
            if (method === "agent.start")
              Object.assign(f.agent, {
                interactive_ready: false,
                launch_pending: true,
              });
            if (method === "agent.get") polled.resolve();
            return response;
          },
        );
        const executing = prepared.execute();
        await polled.promise;
        for (let index = 0; index < 10; index++) await Promise.resolve();
        if (change === "retired") f.retire();
        if (change === "terminal")
          f.panes[0]!.terminal_id = f.agent.terminal_id = "replacement";
        if (change === "name") f.agent.name = "Replacement";
        jest.advanceTimersByTime(change === "timeout" ? 60_000 : 100);
        const result = await executing;
        expect(result.status).toBe("uncertain");
        if (change === "timeout") expect(result.detail).toContain("timeout");
        expect(await prepared.execute()).toBe(result);
        expect(f.mutations).toEqual(["agent.start"]);
        expect(f.lease).toHaveBeenCalledTimes(1);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  test("created worktrees report a lost parent relationship without retrying", async () => {
    const f = fixture();
    const prepared = await f.prepare("create_worktree", {
      branch: "feature/ranger",
    });
    const original = f.createWorktree.getMockImplementation()!;
    f.createWorktree.mockImplementation(async (...args) => ({
      ...(await original(...args)),
      parent_tracking_failed: true,
    }));
    const result = await prepared.execute();
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("worktree was created");
    expect(result.detail).toContain("source relationship could not be saved");
    expect(await prepared.execute()).toBe(result);
    expect(f.createWorktree).toHaveBeenCalledTimes(1);
  });

  test("target terminal, session, process and workspace replacements prevent prompting", async () => {
    for (const change of ["terminal", "session", "process", "workspace"]) {
      const f = fixture();
      f.useAgent();
      const prepared = await f.prepare("send_prompt", {
        pane_id: "w1:p1",
        prompt: "Review the selected changes.",
      });
      if (change === "terminal")
        f.panes[0]!.terminal_id = f.agent.terminal_id = "replacement";
      if (change === "session")
        f.agent.agent_session = { ...f.agent.agent_session, value: "session2" };
      if (change === "process")
        f.process.foreground_processes = [{ pid: 303, name: "pi" }];
      if (change === "workspace")
        f.panes[0]!.workspace_id = f.agent.workspace_id = "w2";
      expect((await prepared.execute()).status).toBe("failed");
      expect(f.mutations).toEqual([]);
    }
  });

  test("prompt acceptance stays uncertain and its exact content is submitted only once", async () => {
    const f = fixture();
    f.useAgent();
    const scope = await f.context.captureScope([ref]);
    const params = {
      ...ref,
      pane_id: "w1:p1",
      prompt: "Feedback:\nPlease add coverage.",
    };
    const prepared = await f.context.prepareAction(
      "send_prompt",
      scope,
      params,
    );
    params.prompt = "replacement";
    const result = await prepared.execute();
    expect(result.status).toBe("uncertain");
    expect(result.detail).toContain("accepted");
    expect(result.detail).not.toContain("private-key");
    expect(await prepared.execute()).toBe(result);
    expect(f.mutations).toEqual(["agent.prompt"]);
    expect(f.call).toHaveBeenCalledWith(
      "agent.prompt",
      { target: "w1:p1", text: "Feedback:\nPlease add coverage." },
      5000,
      expect.any(Function),
    );
  });

  test("a blocked prompt is explicitly rejected without claiming acceptance", async () => {
    const f = fixture();
    f.useAgent();
    const prepared = await f.prepare("send_prompt", {
      pane_id: "w1:p1",
      prompt: "Review",
    });
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(
      async (method, params = {}, timeout, beforeSend) => {
        if (method !== "agent.prompt")
          return original(method, params, timeout, beforeSend);
        beforeSend?.();
        throw new Error("agent_blocked: SECRET /private/session");
      },
    );
    const result = await prepared.execute();
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("No prompt was submitted");
    expect(result.detail).not.toContain("SECRET");
  });

  test("generation retirement during preflight prevents writes and after dispatch stays uncertain", async () => {
    for (const stage of ["before", "after"]) {
      const f = fixture();
      const prepared = await f.prepare("create_workspace", { label: "New" });
      const original = f.call.getMockImplementation()!;
      f.call.mockImplementation(
        async (method, params = {}, timeout, beforeSend) => {
          const result = await original(method, params, timeout, beforeSend);
          if (
            method ===
            (stage === "before" ? "workspace.get" : "workspace.create")
          )
            f.retire();
          return result;
        },
      );
      const result = await prepared.execute();
      expect(result.status).toBe(stage === "before" ? "failed" : "uncertain");
      expect(f.mutations).toEqual(
        stage === "before" ? [] : ["workspace.create"],
      );
      expect(f.lease).toHaveBeenCalledTimes(1);
    }
  });
});
