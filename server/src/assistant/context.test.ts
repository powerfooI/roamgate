import { describe, expect, mock, test } from "bun:test";
import type { AssistantWorkspaceRef } from "../../../shared/assistant";
import type { LegacyConnectionRuntime } from "../connections/runtime";
import {
  AssistantRecoveryNotReadyError,
  createAssistantContext,
} from "./context";
import { callWorkspaceTool, type WorkspaceToolReader } from "./tools";

const first: AssistantWorkspaceRef = {
  connection_id: "local",
  workspace_id: "w1",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(recovery = false) {
  let generation = 1;
  let ready = true;
  let endpointFingerprint = "1".repeat(64);
  const workspaces = [
    {
      workspace_id: "w1",
      label: "Allowed",
      cwd: "/secret/repo",
      agent_status: "working",
      pane_count: 1,
      tab_count: 1,
      socket_path: "/secret/socket",
    },
    { workspace_id: "w2", label: "PRIVATE WORKSPACE", agent_status: "blocked" },
  ];
  const panes = [
    {
      pane_id: "w1:p1",
      workspace_id: "w1",
      tab_id: "w1:t1",
      label: "Agent",
      agent: "pi",
      agent_status: "working",
      agent_session: { value: "/secret/session" },
      api_key: "private-key",
    },
    {
      pane_id: "w2:p1",
      workspace_id: "w2",
      tab_id: "w2:t1",
      label: "PRIVATE PANE",
      agent: "codex",
      agent_status: "blocked",
    },
  ];
  const call = mock(
    async (
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<any> => {
      if (method === "workspace.list") return { workspaces };
      if (method === "workspace.get")
        return {
          workspace: workspaces.find(
            (item) => item.workspace_id === params.workspace_id,
          ),
        };
      if (method === "pane.list") return { panes };
      if (method === "pane.get")
        return { pane: panes.find((item) => item.pane_id === params.pane_id) };
      if (method === "pane.read")
        return {
          type: "pane_read",
          read: {
            pane_id: "w1:p1",
            workspace_id: "w1",
            tab_id: "w1:t1",
            text: "tests passed",
            source: "recent",
            truncated: false,
          },
        };
      throw new Error(`Unexpected RPC ${method}`);
    },
  );
  const readHistory = mock(
    async (): Promise<any> => ({
      pane_id: "w1:p1",
      workspace_id: "w1",
      agent: "pi",
      status: "ok",
      updated_at: "2026-10-03T00:00:00.000Z",
      path: "/secret/session.jsonl",
      session: { value: "secret-session-id" },
      file: { path: "/secret/session.jsonl" },
      messages: [
        {
          role: "assistant",
          text: "The feature is ready",
          sent_at: "2026-10-03T00:00:00.000Z",
        },
      ],
    }),
  );
  const readGitDiffSummary = mock(
    async (): Promise<any> => ({
      workspace_id: "w1",
      root: "/secret/repo",
      mode: "working",
      baseline_available: true,
      counts: { staged: 0, unstaged: 1 },
      entries: [{ path: "src/main.ts", kind: "unstaged", status: "M" }],
    }),
  );
  const readGitDiffFile = mock(
    async (): Promise<any> => ({
      workspace_id: "w1",
      root: "/secret/repo",
      path: "src/main.ts",
      kind: "unstaged",
      diff: "+good change",
      truncated: false,
    }),
  );
  const runtime = {
    herdr: { call },
    agentSessions: { readHistory },
    files: { readGitDiffSummary, readGitDiffFile },
  } as unknown as LegacyConnectionRuntime;
  const recoveryIdentity = mock(async (): Promise<string | null> => "boot-1");
  runtime.recoveryIdentity = recoveryIdentity;
  const lease = mock(() => {
    if (!ready) return null;
    const capturedGeneration = generation;
    return {
      runtime,
      generation: capturedGeneration,
      isCurrent: () => ready && capturedGeneration === generation,
    };
  });
  const context = createAssistantContext({
    catalog: () => [
      {
        id: "local",
        label: "Local",
        socket_path: "/secret/socket",
        api_key: "secret-key",
      },
    ],
    lease,
    ...(recovery ? { recoveryFingerprint: () => endpointFingerprint } : {}),
  });
  return {
    context,
    runtime,
    lease,
    call,
    readHistory,
    readGitDiffSummary,
    readGitDiffFile,
    panes,
    workspaces,
    recoveryIdentity,
    replaceEndpoint: () => {
      endpointFingerprint = "2".repeat(64);
    },
    retire: () => {
      generation += 1;
    },
    disconnect: () => {
      ready = false;
    },
  };
}

describe("assistant recovery scope", () => {
  test("restores the same endpoint into fresh leases without exposing private identities", async () => {
    const f = fixture(true);
    const captured = await f.context.captureScope([first]);
    const targets = await f.context.recoveryScope(captured);
    expect(targets).toEqual([
      {
        ...first,
        endpoint_fingerprint: "1".repeat(64),
        herdr_boot_id: "boot-1",
        workspace_identity: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(JSON.stringify(targets)).not.toContain("/secret/");
    f.retire();
    f.workspaces[0]!.label = "Renamed";
    const restored = await f.context.restoreScope(targets);
    expect(restored[0]?.runtime_generation).toBe(2);
    expect(restored[0]?.label).toBe("Renamed");
    const output = await f.context.read("status", restored, {});
    expect(JSON.stringify([restored, output])).not.toContain("boot-1");
    expect(JSON.stringify([restored, output])).not.toContain("fingerprint");
    await expect(f.context.read("status", captured, {})).rejects.toThrow(
      "Connection changed",
    );
  });

  test("changed endpoints and server boots reject before workspace reads", async () => {
    for (const change of ["endpoint", "boot"] as const) {
      const f = fixture(true);
      const targets = await f.context.recoveryScope(
        await f.context.captureScope([first]),
      );
      f.call.mockClear();
      if (change === "endpoint") f.replaceEndpoint();
      else f.recoveryIdentity.mockResolvedValue("another-server-boot");
      await expect(f.context.restoreScope(targets)).rejects.toThrow(
        change === "endpoint" ? "endpoint changed" : "server identity changed",
      );
      expect(f.call).not.toHaveBeenCalled();
    }
  });

  test("same-ID workspace replacement rejects both capture and restore", async () => {
    const f = fixture(true);
    const captured = await f.context.captureScope([first]);
    const targets = await f.context.recoveryScope(captured);
    f.workspaces[0]!.cwd = "/another/repo";
    await expect(f.context.recoveryScope(captured)).rejects.toThrow(
      "workspace changed",
    );
    await expect(f.context.restoreScope(targets)).rejects.toThrow(
      "workspace changed",
    );
    f.workspaces[0]!.cwd = "/secret/repo";
    Object.assign(f.workspaces[0]!, {
      worktree: { repo_key: "another-repo", checkout_path: "/secret/repo" },
    });
    await expect(f.context.restoreScope(targets)).rejects.toThrow(
      "workspace changed",
    );
  });

  test("unsupported identity leaves ordinary reads available and cannot restore", async () => {
    const f = fixture(true);
    const captured = await f.context.captureScope([first]);
    const targets = await f.context.recoveryScope(captured);
    f.recoveryIdentity.mockResolvedValue(null);
    expect(await f.context.recoveryScope(captured)).toEqual([]);
    expect((await f.context.read("status", captured, {})).sources).toHaveLength(
      1,
    );
    await expect(f.context.restoreScope(targets)).rejects.toThrow(
      "server identity changed",
    );
    const legacy = fixture();
    expect(
      await legacy.context.recoveryScope(
        await legacy.context.captureScope([first]),
      ),
    ).toEqual([]);
    expect(legacy.recoveryIdentity).not.toHaveBeenCalled();
  });

  test("not-ready recovery is distinguishable from changed or invalid targets", async () => {
    const f = fixture(true);
    const targets = await f.context.recoveryScope(
      await f.context.captureScope([first]),
    );
    f.disconnect();
    await expect(f.context.restoreScope(targets)).rejects.toBeInstanceOf(
      AssistantRecoveryNotReadyError,
    );
    f.replaceEndpoint();
    await expect(f.context.restoreScope(targets)).rejects.toThrow(
      "endpoint changed",
    );
    await expect(f.context.restoreScope([])).rejects.toThrow("Invalid");
    await expect(
      f.context.restoreScope([
        { ...targets[0]!, endpoint_fingerprint: "/socket" },
      ]),
    ).rejects.toThrow("Invalid");
    await expect(
      f.context.restoreScope([
        ...targets,
        { ...targets[0]!, workspace_id: "w2", herdr_boot_id: "different" },
      ]),
    ).rejects.toThrow("Inconsistent");
  });

  test("aborting an identity probe rejects promptly and stale leases cannot resume", async () => {
    for (const operation of ["capture", "restore"] as const) {
      const f = fixture(true);
      const captured = await f.context.captureScope([first]);
      const targets = await f.context.recoveryScope(captured);
      const pending = deferred<string>();
      f.recoveryIdentity.mockImplementation(() => pending.promise);
      const controller = new AbortController();
      const work =
        operation === "capture"
          ? f.context.recoveryScope(captured, controller.signal)
          : f.context.restoreScope(targets, controller.signal);
      controller.abort(new Error("Stopped recovery"));
      await expect(work).rejects.toThrow("Stopped recovery");
      pending.resolve("boot-1");
    }
    const f = fixture(true);
    const targets = await f.context.recoveryScope(
      await f.context.captureScope([first]),
    );
    f.recoveryIdentity.mockImplementation(async () => {
      f.retire();
      return "boot-1";
    });
    await expect(f.context.restoreScope(targets)).rejects.toThrow(
      "Connection changed",
    );
  });

  test("recovery admission snapshots its input and rechecks endpoint changes", async () => {
    const f = fixture(true);
    const targets = await f.context.recoveryScope(
      await f.context.captureScope([first]),
    );
    const pending = deferred<string>();
    f.recoveryIdentity.mockImplementation(() => pending.promise);
    const work = f.context.restoreScope(targets);
    targets[0]!.herdr_boot_id = "mutated-by-caller";
    targets[0]!.workspace_id = "w2";
    pending.resolve("boot-1");
    expect((await work)[0]?.workspace_id).toBe("w1");
    const captured = await f.context.captureScope([first]);
    f.recoveryIdentity.mockImplementation(async () => {
      f.replaceEndpoint();
      return "boot-1";
    });
    await expect(f.context.recoveryScope(captured)).rejects.toThrow(
      "endpoint changed",
    );
  });
});

describe("assistant approved context", () => {
  test("catalog exposes only workspace metadata and reports disconnected connections", async () => {
    const f = fixture();
    expect(await f.context.catalog()).toEqual({
      workspaces: [
        {
          ...first,
          connection_label: "Local",
          label: "Allowed",
          runtime_generation: 1,
        },
        {
          connection_id: "local",
          workspace_id: "w2",
          connection_label: "Local",
          label: "PRIVATE WORKSPACE",
          runtime_generation: 1,
        },
      ],
      errors: [],
    });
    f.disconnect();
    expect(await f.context.catalog()).toEqual({
      workspaces: [],
      errors: ["Connection Local is not ready"],
    });
  });

  test("catalog reads connections independently, keeps healthy results and bounds lists", async () => {
    const healthy = fixture();
    const broken = fixture();
    const gate = deferred<any>();
    healthy.call.mockImplementationOnce(() => gate.promise);
    broken.call.mockRejectedValueOnce(
      new Error("api_key=SECRET /private/socket"),
    );
    const context = createAssistantContext({
      catalog: () => [
        { id: "healthy", label: "Healthy" },
        { id: "broken", label: "Broken" },
      ],
      lease: (id) => (id === "healthy" ? healthy.lease() : broken.lease()),
    });
    const pending = context.catalog();
    expect(healthy.call).toHaveBeenCalledTimes(1);
    expect(broken.call).toHaveBeenCalledTimes(1);
    gate.resolve({ workspaces: healthy.workspaces });
    const result = await pending;
    expect(result.workspaces).toHaveLength(2);
    expect(result.workspaces[0]?.connection_id).toBe("healthy");
    expect(result.errors).toEqual([
      "Unable to list workspaces for connection Broken",
    ]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("/private/socket");
    healthy.workspaces.push(
      ...Array.from({ length: 600 }, (_, index) => ({
        ...healthy.workspaces[0]!,
        workspace_id: `w${index + 3}`,
      })),
    );
    const bounded = await healthy.context.catalog();
    expect(bounded.workspaces).toHaveLength(512);
    expect(bounded.errors[0]).toContain("truncated");
  });

  test("scope requires explicit, valid, ready workspaces", async () => {
    const f = fixture();
    await expect(f.context.captureScope([])).rejects.toThrow("Choose between");
    await expect(
      f.context.captureScope([{ ...first, connection_id: "" }]),
    ).rejects.toThrow("Invalid connection_id");
    await expect(
      f.context.captureScope([{ ...first, workspace_id: "w".repeat(129) }]),
    ).rejects.toThrow("Invalid workspace_id");
    await expect(
      f.context.captureScope([{ ...first, connection_id: "other" }]),
    ).rejects.toThrow("Unknown connection");
    await expect(
      f.context.captureScope([{ ...first, workspace_id: "missing" }]),
    ).rejects.toThrow("no longer available");
    await expect(f.context.captureScope([first, first])).rejects.toThrow(
      "Duplicate",
    );
    f.disconnect();
    await expect(f.context.captureScope([first])).rejects.toThrow("not ready");
  });

  test("capture clones requested refs before waiting and freezes turn scope", async () => {
    const f = fixture();
    const gate = deferred<any>();
    f.call.mockImplementationOnce(async () => gate.promise);
    const refs = [{ ...first }, { ...first, workspace_id: "w2" }];
    const pending = f.context.captureScope(refs);
    refs[1]!.workspace_id = "changed";
    gate.resolve({ workspace: f.workspaces[0] });
    const captured = await pending;
    expect(captured[1]!.workspace_id).toBe("w2");
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured[0])).toBe(true);
  });

  test("stopping scope admission rejects without waiting or reading subsequent workspaces", async () => {
    const f = fixture();
    const gate = deferred<any>();
    f.call.mockImplementationOnce(async () => gate.promise);
    const controller = new AbortController();
    const pending = f.context.captureScope(
      [first, { ...first, workspace_id: "w2" }],
      controller.signal,
    );
    expect(f.call).toHaveBeenCalledTimes(1);
    controller.abort(new Error("Stopped during scope admission"));
    await expect(pending).rejects.toThrow("Stopped during scope admission");
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.lease).toHaveBeenCalledTimes(1);
    gate.resolve({ workspace: f.workspaces[0] });

    await expect(
      f.context.captureScope([first], controller.signal),
    ).rejects.toThrow("Stopped during scope admission");
    expect(f.call).toHaveBeenCalledTimes(1);
  });

  test("status includes only approved topology and safe fields", async () => {
    const f = fixture();
    const captured = await f.context.captureScope([first]);
    const result = await f.context.read("status", captured, {});
    const status = JSON.parse(result.text)[0];
    expect(status.panes).toEqual([
      {
        pane_id: "w1:p1",
        tab_id: "w1:t1",
        label: "Agent",
        agent: "pi",
        agent_status: "working",
      },
    ]);
    expect(result.text).not.toContain("PRIVATE");
    expect(result.text).not.toContain("secret");
    expect(result.sources[0]).toMatchObject({
      ...first,
      kind: "status",
      runtime_generation: 1,
    });
    expect(Number.isFinite(Date.parse(result.sources[0]!.read_at))).toBe(true);
    expect(f.readHistory).not.toHaveBeenCalled();
    expect(f.call).toHaveBeenLastCalledWith(
      "pane.list",
      { workspace_id: "w1" },
      5000,
    );
  });

  test("other connections, workspaces, panes and forged scopes are denied", async () => {
    const f = fixture();
    const captured = await f.context.captureScope([first]);
    await expect(
      f.context.read("status", captured, { ...first, workspace_id: "w2" }),
    ).rejects.toThrow("outside");
    await expect(
      f.context.read("status", captured, { ...first, connection_id: "other" }),
    ).rejects.toThrow("outside");
    await expect(
      f.context.read("status", captured, { workspace_id: "w1" }),
    ).rejects.toThrow("Invalid connection_id");
    await expect(
      f.context.read("history", captured, { ...first, pane_id: "w2:p1" }),
    ).rejects.toThrow("outside");
    await expect(f.context.read("status", [...captured], {})).rejects.toThrow(
      "not approved",
    );
    expect(f.readHistory).not.toHaveBeenCalled();
  });

  test("history is pane scoped without transcript paths or arbitrary parameters", async () => {
    const f = fixture();
    const captured = await f.context.captureScope([first]);
    const result = await f.context.read("history", captured, {
      ...first,
      pane_id: "w1:p1",
    });
    expect(result.text).toContain("The feature is ready");
    expect(result.text).not.toContain("secret");
    expect(f.readHistory).toHaveBeenCalledWith({
      pane_id: "w1:p1",
      workspace_id: "w1",
    });
    expect(result.sources[0]).toMatchObject({
      kind: "history",
      pane_id: "w1:p1",
    });
    await expect(
      f.context.read("history", captured, {
        ...first,
        pane_id: "w1:p1",
        path: "/secret/session",
      }),
    ).rejects.toThrow("Unsupported");
    f.readHistory.mockResolvedValueOnce({
      pane_id: "w1:p1",
      workspace_id: "w2",
      messages: [{ text: "PRIVATE" }],
    });
    await expect(
      f.context.read("history", captured, { ...first, pane_id: "w1:p1" }),
    ).rejects.toThrow("changed workspace");
  });

  test("diff validates paths and the public tool forwards working-tree change kinds", async () => {
    const f = fixture();
    const captured = await f.context.captureScope([first]);
    for (const path of [
      "../secret",
      "/secret",
      "C:\\secret",
      "\\secret",
      "src/../../secret",
      ":(glob)**",
      "bad\0path",
    ]) {
      await expect(
        f.context.read("diff", captured, { ...first, path }),
      ).rejects.toThrow();
    }
    await expect(
      f.context.read("diff", captured, { ...first, scope: "filesystem" }),
    ).rejects.toThrow("Unsupported");
    await expect(
      f.context.read("diff", captured, { ...first, mode: "arbitrary" }),
    ).rejects.toThrow("Invalid diff mode");
    expect(f.readGitDiffFile).not.toHaveBeenCalled();
    const read: WorkspaceToolReader = (kind, params, signal) =>
      f.context.read(kind, captured, params, signal);
    const summary = await callWorkspaceTool("workspace_diff", first, read);
    expect(summary.text).toContain("src/main.ts");
    expect(summary.text).not.toContain("/secret/repo");
    for (const kind of [
      undefined,
      "unstaged",
      "staged",
      "untracked",
      "conflicted",
    ]) {
      const selection = kind === undefined ? {} : { kind };
      const diff = await callWorkspaceTool(
        "workspace_diff",
        { ...first, path: "src\\main.ts", ...selection },
        read,
      );
      expect(diff.text).toContain("+good change");
      expect(diff.text).not.toContain("/secret/repo");
      expect(f.readGitDiffFile).toHaveBeenLastCalledWith({
        workspace_id: "w1",
        mode: "working",
        path: "src/main.ts",
        ...selection,
      });
    }
  });

  test("terminal uses verified readonly pane.read with bounded lines", async () => {
    const f = fixture();
    const captured = await f.context.captureScope([first]);
    const result = await f.context.read("terminal", captured, {
      ...first,
      pane_id: "w1:p1",
    });
    expect(result.text).toContain("tests passed");
    expect(JSON.parse(result.text)[0]).toMatchObject({ requested_lines: 120 });
    expect(f.call).toHaveBeenLastCalledWith(
      "pane.read",
      {
        pane_id: "w1:p1",
        source: "recent",
        lines: 120,
        format: "text",
        strip_ansi: true,
      },
      25_000,
    );
    const read: WorkspaceToolReader = (kind, params, signal) =>
      f.context.read(kind, captured, params, signal);
    for (const lines of [1, 500, 1000]) {
      const selected = await callWorkspaceTool(
        "workspace_terminal",
        { ...first, pane_id: "w1:p1", lines },
        read,
      );
      expect(JSON.parse(selected.text)[0]?.requested_lines).toBe(lines);
      expect(f.call).toHaveBeenLastCalledWith(
        "pane.read",
        {
          pane_id: "w1:p1",
          source: "recent",
          lines,
          format: "text",
          strip_ansi: true,
        },
        25_000,
      );
    }
    for (const lines of [null, "500", 0, -1, 1.5, 1001, NaN, Infinity]) {
      await expect(
        f.context.read("terminal", captured, {
          ...first,
          pane_id: "w1:p1",
          lines,
        }),
      ).rejects.toThrow("between 1 and 1000");
    }
    f.call.mockImplementation(async (method) => {
      if (method === "workspace.get") return { workspace: f.workspaces[0] };
      if (method === "pane.get") return { pane: f.panes[0] };
      throw new Error("private api_key=SECRET /secret/socket");
    });
    try {
      await f.context.read("terminal", captured, {
        ...first,
        pane_id: "w1:p1",
      });
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as Error).message).toContain("may not support pane.read");
      expect((error as Error).message).not.toContain("SECRET");
      expect((error as Error).message).not.toContain("/secret");
    }
  });

  test("large terminal reads retain newest evidence within the text budget", async () => {
    const f = fixture();
    const captured = await f.context.captureScope([first]);
    let text =
      "VERY OLD MARKER\n" +
      "OLDER OUTPUT\n".repeat(4000) +
      "LATEST RESULT: tests passed";
    f.call.mockImplementation(async (method) => {
      if (method === "workspace.get") return { workspace: f.workspaces[0] };
      if (method === "pane.get") return { pane: f.panes[0] };
      if (method === "pane.read")
        return {
          read: {
            pane_id: "w1:p1",
            workspace_id: "w1",
            text,
            truncated: false,
          },
        };
      throw new Error(`Unexpected RPC ${method}`);
    });
    const result = await f.context.read("terminal", captured, {
      ...first,
      pane_id: "w1:p1",
      lines: 1000,
    });
    const output = JSON.parse(result.text)[0];
    expect(output.requested_lines).toBe(1000);
    expect(result.text.length).toBeLessThanOrEqual(32_000);
    expect(output.text).not.toContain("VERY OLD MARKER");
    expect(output.text).toEndWith("LATEST RESULT: tests passed");
    expect(output.truncated).toBe(true);
    expect(output.warning).toContain("partial evidence");
    expect(output.terminal_window).toContain("older output");
    expect(result.sources[0]).toMatchObject({
      kind: "terminal",
      pane_id: "w1:p1",
    });
    text = "\u0000".repeat(7000) + "LATEST RESULT: tests passed";
    const escaped = await f.context.read("terminal", captured, {
      ...first,
      pane_id: "w1:p1",
      lines: 1000,
    });
    expect(escaped.text.length).toBeLessThanOrEqual(32_000);
    expect(JSON.parse(escaped.text)[0]).toMatchObject({ truncated: true });
    expect(JSON.parse(escaped.text)[0].text).toEndWith(
      "LATEST RESULT: tests passed",
    );
  });

  test("stopping a terminal read does not wait for native history collection", async () => {
    const f = fixture();
    const captured = await f.context.captureScope([first]);
    const gate = deferred<any>();
    const started = deferred<void>();
    f.call.mockImplementation(async (method) => {
      if (method === "workspace.get") return { workspace: f.workspaces[0] };
      if (method === "pane.get") return { pane: f.panes[0] };
      if (method === "pane.read") {
        started.resolve();
        return gate.promise;
      }
      throw new Error(`Unexpected RPC ${method}`);
    });
    const controller = new AbortController();
    const pending = f.context.read(
      "terminal",
      captured,
      { ...first, pane_id: "w1:p1", lines: 500 },
      controller.signal,
    );
    await started.promise;
    controller.abort(new Error("Stopped"));
    await expect(pending).rejects.toThrow("Stopped");
    expect(f.call).toHaveBeenLastCalledWith(
      "pane.read",
      {
        pane_id: "w1:p1",
        source: "recent",
        lines: 500,
        format: "text",
        strip_ansi: true,
      },
      25_000,
    );
    gate.resolve({ read: { text: "late result" } });
  });

  test("stale leases reject before and after awaits without replacement fallback", async () => {
    const f = fixture();
    const captured = await f.context.captureScope([first]);
    const gate = deferred<any>();
    const started = deferred<void>();
    f.readGitDiffFile.mockImplementationOnce(() => {
      started.resolve();
      return gate.promise;
    });
    const pending = f.context.read("diff", captured, {
      ...first,
      path: "src/main.ts",
    });
    await started.promise;
    f.retire();
    gate.resolve({
      workspace_id: "w1",
      path: "src/main.ts",
      diff: "PRIVATE stale result",
    });
    await expect(pending).rejects.toThrow("Connection changed");
    const calls = f.call.mock.calls.length;
    await expect(f.context.read("status", captured, {})).rejects.toThrow(
      "Connection changed",
    );
    expect(f.call.mock.calls.length).toBe(calls);
    expect(f.lease).toHaveBeenCalledTimes(1);
  });

  test("shared tool invocation preserves approved scopes, lease checks, sources and cancellation", async () => {
    const f = fixture();
    const captured = await f.context.captureScope([first]);
    const read: WorkspaceToolReader = (kind, params, signal) =>
      f.context.read(kind, captured, params, signal);
    const result = await callWorkspaceTool("workspace_status", {}, read);
    expect(JSON.parse(result.text)[0]).toMatchObject({
      ...first,
      label: "Allowed",
      agent_status: "working",
    });
    expect(result.sources).toHaveLength(1);
    expect(result.sources?.[0]).toMatchObject({
      ...first,
      kind: "status",
      runtime_generation: 1,
    });

    const calls = f.call.mock.calls.length;
    await expect(
      callWorkspaceTool("workspace_status", {}, (kind, params, signal) =>
        f.context.read(kind, [...captured], params, signal),
      ),
    ).rejects.toThrow();
    expect(f.call.mock.calls.length).toBe(calls);

    const gate = deferred<any>();
    const started = deferred<void>();
    f.call.mockImplementationOnce(() => {
      started.resolve();
      return gate.promise;
    });
    const controller = new AbortController();
    const pending = callWorkspaceTool(
      "workspace_status",
      {},
      read,
      controller.signal,
    );
    await started.promise;
    controller.abort(new Error("Stopped"));
    await expect(pending).rejects.toThrow();
    expect(f.call.mock.calls.length).toBe(calls + 1);
    gate.resolve({ workspace: f.workspaces[0] });

    f.retire();
    await expect(
      callWorkspaceTool("workspace_status", {}, read),
    ).rejects.toThrow();
    expect(f.call.mock.calls.length).toBe(calls + 1);
    expect(f.lease).toHaveBeenCalledTimes(1);
  });

  test("abort stops an in-flight read and bounded outputs mark truncation", async () => {
    const f = fixture();
    const captured = await f.context.captureScope([first]);
    const gate = deferred<any>();
    const started = deferred<void>();
    f.readGitDiffFile.mockImplementationOnce(() => {
      started.resolve();
      return gate.promise;
    });
    const controller = new AbortController();
    const pending = f.context.read(
      "diff",
      captured,
      { ...first, path: "src/main.ts" },
      controller.signal,
    );
    await started.promise;
    controller.abort(new Error("Stopped"));
    await expect(pending).rejects.toThrow("Stopped");
    gate.resolve({});
    f.panes.push(
      ...Array.from({ length: 100 }, (_, index) => ({
        ...f.panes[0]!,
        pane_id: `w1:p${index + 2}`,
      })),
    );
    const status = JSON.parse(
      (await f.context.read("status", captured, {})).text,
    )[0];
    expect(status.panes).toHaveLength(80);
    expect(status.truncated).toBe(true);
    expect(status.warning).toContain("partial evidence");
    f.readGitDiffFile.mockResolvedValueOnce({
      workspace_id: "w1",
      path: "src/main.ts",
      diff: "x".repeat(100_000),
      truncated: false,
    });
    const diff = await f.context.read("diff", captured, {
      ...first,
      path: "src/main.ts",
    });
    expect(diff.text.length).toBeLessThan(32_100);
    expect(diff.text).toContain("[truncated]");
    expect(diff.text).toContain("partial evidence");
  });
});
