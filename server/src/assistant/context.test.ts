import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  isAssistantMentionCatalog,
  type AssistantMentionTarget,
  type AssistantWorkspaceRef,
} from "../../../shared/assistant";
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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
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
      terminal_id: "term1",
      label: "Agent",
      agent: "pi",
      agent_status: "working",
      agent_session: { kind: "path", value: "/secret/session" },
      api_key: "private-key",
    },
    {
      pane_id: "w2:p1",
      workspace_id: "w2",
      tab_id: "w2:t1",
      terminal_id: "term2",
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
      if (method === "agent.get")
        return { agent: panes.find((item) => item.pane_id === params.target) };
      if (method === "pane.process_info")
        return {
          process_info: {
            pane_id: params.pane_id,
            shell_pid: 101,
            foreground_processes: [{ pid: 202, name: "pi" }],
          },
        };
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

function scopeFixture(count = 24) {
  const f = fixture(true);
  f.workspaces.splice(
    0,
    f.workspaces.length,
    ...Array.from({ length: count }, (_, index) => ({
      agent_status: "working",
      pane_count: 1,
      tab_count: 1,
      socket_path: "/secret/socket",
      workspace_id: `w${index + 1}`,
      label: `Workspace ${index + 1}`,
      cwd: `/repo/${index + 1}`,
    })),
  );
  const refs = f.workspaces.map(({ workspace_id }) => ({
    connection_id: "local",
    workspace_id,
  }));
  return { ...f, refs };
}

function gatedWorkspaceReads(f: ReturnType<typeof fixture>) {
  const requests: {
    workspaceId: string;
    resolve(): void;
    missing(): void;
    reject(error: Error): void;
  }[] = [];
  const waiting = new Map<number, ReturnType<typeof deferred<void>>>();
  let active = 0;
  let maximum = 0;
  f.call.mockClear();
  f.call.mockImplementation(async (method, params = {}) => {
    expect(method).toBe("workspace.get");
    const workspaceId = String(params.workspace_id);
    const gate = deferred<any>();
    requests.push({
      workspaceId,
      resolve: () =>
        gate.resolve({
          workspace: structuredClone(
            f.workspaces.find((item) => item.workspace_id === workspaceId),
          ),
        }),
      missing: () => gate.resolve({ workspace: undefined }),
      reject: gate.reject,
    });
    maximum = Math.max(maximum, ++active);
    waiting.get(requests.length)?.resolve();
    try {
      return await gate.promise;
    } finally {
      active -= 1;
    }
  });
  return {
    requests,
    waitFor(count: number) {
      if (requests.length >= count) return Promise.resolve();
      const gate = deferred<void>();
      waiting.set(count, gate);
      return gate.promise;
    },
    get active() {
      return active;
    },
    get maximum() {
      return maximum;
    },
  };
}

// Let cancelled, uncancellable transport replies drain without wall-clock waits.
async function flushReads() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
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

describe("bounded Ranger scope validation", () => {
  test("capture, recovery and restore keep 512 workspace and identity results ordered with at most eight reads", async () => {
    const f = scopeFixture(512);
    async function finishInReverseBatches(
      reads: ReturnType<typeof gatedWorkspaceReads>,
    ) {
      for (let start = 0; start < 512; start += 8) {
        await reads.waitFor(start + 8);
        expect(reads.active).toBe(8);
        reads.requests
          .slice(start, start + 8)
          .reverse()
          .forEach((request) => request.resolve());
      }
    }
    const captureReads = gatedWorkspaceReads(f);
    const capturing = f.context.captureScope(f.refs);
    await finishInReverseBatches(captureReads);
    const captured = await capturing;
    expect(captured.map(({ workspace_id }) => workspace_id)).toEqual(
      f.refs.map(({ workspace_id }) => workspace_id),
    );
    expect(captureReads.maximum).toBe(8);
    expect(captureReads.active).toBe(0);
    expect(f.lease).toHaveBeenCalledTimes(1);

    const recoveryReads = gatedWorkspaceReads(f);
    const recovering = f.context.recoveryScope(captured);
    await finishInReverseBatches(recoveryReads);
    const targets = await recovering;
    expect(recoveryReads.maximum).toBe(8);
    expect(recoveryReads.active).toBe(0);
    expect(f.recoveryIdentity).toHaveBeenCalledTimes(1);
    expect(targets).toEqual(
      f.refs.map((ref, index) => ({
        ...ref,
        endpoint_fingerprint: "1".repeat(64),
        herdr_boot_id: "boot-1",
        workspace_identity: createHash("sha256")
          .update(JSON.stringify([`/repo/${index + 1}`, null, null, null]))
          .digest("hex"),
      })),
    );

    const restoreReads = gatedWorkspaceReads(f);
    const restoring = f.context.restoreScope(targets);
    await finishInReverseBatches(restoreReads);
    const restored = await restoring;
    expect(restored).toEqual(captured);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(restored.every(Object.isFrozen)).toBe(true);
    expect(restoreReads.maximum).toBe(8);
    expect(restoreReads.active).toBe(0);
    expect(f.lease).toHaveBeenCalledTimes(2);
    expect(f.recoveryIdentity).toHaveBeenCalledTimes(2);
  });

  test("concurrent scope failures preserve the first error, stop queued reads and expose no partial scope", async () => {
    for (const operation of ["capture", "recovery", "restore"] as const) {
      for (const change of [
        "abort",
        "retire",
        "disconnect",
        "missing",
        "transport",
        "identity",
      ] as const) {
        if (operation === "capture" && change === "identity") continue;
        const f = scopeFixture();
        const captured = await f.context.captureScope(f.refs);
        const targets = await f.context.recoveryScope(captured);
        const reads = gatedWorkspaceReads(f);
        const controller = new AbortController();
        let approved: unknown;
        const pending = (
          operation === "capture"
            ? f.context.captureScope(f.refs, controller.signal)
            : operation === "recovery"
              ? f.context.recoveryScope(captured, controller.signal)
              : f.context.restoreScope(targets, controller.signal)
        ).then((result) => {
          approved = result;
          return result;
        });
        await reads.waitFor(8);
        let message: string;
        if (change === "abort") {
          message = "Stopped concurrent admission";
          controller.abort(new Error(message));
        } else if (change === "retire" || change === "disconnect") {
          message = "Connection changed";
          f[change]();
          reads.requests[2]!.resolve();
        } else if (change === "missing") {
          message = "Workspace w3 is no longer available";
          reads.requests[2]!.missing();
        } else if (change === "transport") {
          message = "Unable to read workspace w3";
          reads.requests[2]!.reject(new Error("SECRET /private/socket"));
        } else {
          message = "Ranger recovery workspace changed";
          f.workspaces[2]!.cwd = "/replaced/repo";
          reads.requests[2]!.resolve();
        }
        await expect(pending).rejects.toThrow(message);
        expect(approved).toBeUndefined();
        expect(reads.requests).toHaveLength(8);
        reads.requests.forEach((request, index) => {
          if (index === 4) request.reject(new Error("A later failure"));
          else request.resolve();
        });
        await flushReads();
        expect(reads.active).toBe(0);
        expect(reads.requests).toHaveLength(8);
        expect(f.lease).toHaveBeenCalledTimes(operation === "recovery" ? 1 : 2);
        const fabricated = captured.map((item) => ({ ...item }));
        await expect(f.context.read("status", fabricated, {})).rejects.toThrow(
          "not approved",
        );
      }
    }
  });

  test("endpoint changes while parallel validation is pending reject recovery and restore", async () => {
    for (const operation of ["recovery", "restore"] as const) {
      const f = scopeFixture(8);
      const captured = await f.context.captureScope(f.refs);
      const targets = await f.context.recoveryScope(captured);
      const reads = gatedWorkspaceReads(f);
      const pending =
        operation === "recovery"
          ? f.context.recoveryScope(captured)
          : f.context.restoreScope(targets);
      await reads.waitFor(8);
      f.replaceEndpoint();
      reads.requests.forEach((request) => request.resolve());
      await expect(pending).rejects.toThrow("endpoint changed");
      expect(reads.requests).toHaveLength(8);
      expect(reads.active).toBe(0);
    }
  });

  test("the final boundary rejects an earlier connection retired while another connection is still reading", async () => {
    for (const operation of ["capture", "recovery", "restore"] as const) {
      const fast = scopeFixture(4);
      const slow = scopeFixture(8);
      const context = createAssistantContext({
        catalog: () => [
          { id: "fast", label: "Fast" },
          { id: "slow", label: "Slow" },
        ],
        lease: (id) => (id === "fast" ? fast.lease() : slow.lease()),
        recoveryFingerprint: (id) => (id === "fast" ? "1" : "2").repeat(64),
      });
      const refs = [
        ...fast.refs.map((ref) => ({ ...ref, connection_id: "fast" })),
        ...slow.refs.map((ref) => ({ ...ref, connection_id: "slow" })),
      ];
      const captured = await context.captureScope(refs);
      const targets = await context.recoveryScope(captured);
      const fastReads = gatedWorkspaceReads(fast);
      const slowReads = gatedWorkspaceReads(slow);
      const pending =
        operation === "capture"
          ? context.captureScope(refs)
          : operation === "recovery"
            ? context.recoveryScope(captured)
            : context.restoreScope(targets);
      await fastReads.waitFor(4);
      await slowReads.waitFor(4);
      fastReads.requests.forEach((request) => request.resolve());
      await slowReads.waitFor(8);
      expect(fastReads.active).toBe(0);
      fast.retire();
      slowReads.requests.forEach((request) => request.resolve());
      await expect(pending).rejects.toThrow("Connection changed");
      expect(fastReads.active + slowReads.active).toBe(0);
      expect(fast.recoveryIdentity).toHaveBeenCalledTimes(
        operation === "capture" ? 1 : 2,
      );
      expect(slow.recoveryIdentity).toHaveBeenCalledTimes(
        operation === "capture" ? 1 : 2,
      );
    }
  });

  test("one shared pending boot probe gates parallel workspace reads and changed boots reject all workers", async () => {
    const f = scopeFixture();
    const targets = await f.context.recoveryScope(
      await f.context.captureScope(f.refs),
    );
    f.recoveryIdentity.mockClear();
    const boot = deferred<string>();
    f.recoveryIdentity.mockImplementation(() => boot.promise);
    const reads = gatedWorkspaceReads(f);
    const pending = f.context.restoreScope(targets);
    expect(f.recoveryIdentity).toHaveBeenCalledTimes(1);
    expect(reads.requests).toHaveLength(0);
    boot.resolve("changed-boot");
    await expect(pending).rejects.toThrow("server identity changed");
    expect(reads.requests).toHaveLength(0);
    expect(f.recoveryIdentity).toHaveBeenCalledTimes(1);
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
      connection_ids: ["local"],
      complete_connection_ids: ["local"],
      truncated: false,
    });
    f.disconnect();
    expect(await f.context.catalog()).toEqual({
      workspaces: [],
      errors: ["Connection Local is not ready"],
      connection_ids: ["local"],
      complete_connection_ids: [],
      truncated: false,
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
    expect(result.connection_ids).toEqual(["healthy", "broken"]);
    expect(result.complete_connection_ids).toEqual(["healthy"]);
    expect(result.truncated).toBe(false);
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
    expect(bounded.complete_connection_ids).toEqual([]);
    expect(bounded.truncated).toBe(true);
  });

  test("empty successful listings and removed connections are authoritative", async () => {
    const f = fixture();
    f.workspaces.length = 0;
    expect(await f.context.catalog()).toEqual({
      workspaces: [],
      errors: [],
      connection_ids: ["local"],
      complete_connection_ids: ["local"],
      truncated: false,
    });
    const context = createAssistantContext({
      catalog: () => [],
      lease: f.lease,
    });
    expect(await context.catalog()).toEqual({
      workspaces: [],
      errors: [],
      connection_ids: [],
      complete_connection_ids: [],
      truncated: false,
    });
    expect(f.lease).toHaveBeenCalledTimes(1);
  });

  test("malformed or duplicate workspace records cannot establish removals", async () => {
    for (const payload of [
      null,
      {},
      { workspaces: null },
      { workspaces: [null] },
      { workspaces: [{ workspace_id: "w1" }, false] },
      { workspaces: [{ workspace_id: "w1" }, {}] },
      { workspaces: [{ workspace_id: "w1" }, { workspace_id: "invalid/id" }] },
      { workspaces: [{ workspace_id: "w1" }, { workspace_id: "w1" }] },
      { workspaces: new Array(1) },
    ]) {
      const f = fixture();
      f.call.mockResolvedValueOnce(payload);
      expect(await f.context.catalog()).toEqual({
        workspaces: [],
        errors: ["Unable to list workspaces for connection Local"],
        connection_ids: ["local"],
        complete_connection_ids: [],
        truncated: false,
      });
    }
  });

  test("catalog completeness respects the exact per-connection bound", async () => {
    const f = fixture();
    const workspaces = Array.from({ length: 513 }, (_, index) => ({
      workspace_id: `w${index}`,
      label: `Workspace ${index}`,
    }));
    f.call.mockResolvedValueOnce({ workspaces: workspaces.slice(0, 512) });
    const complete = await f.context.catalog();
    expect(complete.workspaces).toHaveLength(512);
    expect(complete.complete_connection_ids).toEqual(["local"]);
    expect(complete.truncated).toBe(false);
    expect(complete.errors).toEqual([]);
    f.call.mockResolvedValueOnce({ workspaces });
    const partial = await f.context.catalog();
    expect(partial.workspaces).toHaveLength(512);
    expect(partial.complete_connection_ids).toEqual([]);
    expect(partial.truncated).toBe(true);
    expect(partial.errors).toEqual([
      "Workspace list for connection Local was truncated to 512 entries",
    ]);
  });

  test("global truncation invalidates all connection completeness", async () => {
    for (const total of [512, 513]) {
      const first = fixture();
      const second = fixture();
      const entries = Array.from({ length: total }, (_, index) => ({
        workspace_id: `w${index}`,
      }));
      first.call.mockResolvedValueOnce({ workspaces: entries.slice(0, 256) });
      second.call.mockResolvedValueOnce({ workspaces: entries.slice(256) });
      const context = createAssistantContext({
        catalog: () => [
          { id: "first", label: "First" },
          { id: "second", label: "Second" },
        ],
        lease: (id) => (id === "first" ? first.lease() : second.lease()),
      });
      const result = await context.catalog();
      expect(result.workspaces).toHaveLength(512);
      expect(result.connection_ids).toEqual(["first", "second"]);
      expect(result.complete_connection_ids).toEqual(
        total === 512 ? ["first", "second"] : [],
      );
      expect(result.truncated).toBe(total > 512);
      expect(result.errors).toEqual(
        total === 512 ? [] : ["Workspace catalog was truncated to 512 entries"],
      );
    }
  });

  test("catalog uses the final configured connections and omits removed listings", async () => {
    const f = fixture();
    const connections = [{ id: "local", label: "Local" }];
    const gate = deferred<any>();
    f.call.mockImplementationOnce(() => gate.promise);
    const context = createAssistantContext({
      catalog: () => connections,
      lease: f.lease,
    });
    const pending = context.catalog();
    connections[0]!.id = "added";
    connections[0]!.label = "Added";
    gate.resolve({ workspaces: f.workspaces });
    expect(await pending).toEqual({
      workspaces: [],
      errors: ["Unable to list workspaces for connection Local"],
      connection_ids: ["added"],
      complete_connection_ids: [],
      truncated: false,
    });
  });

  test("catalog rechecks successful leases after slower connections finish", async () => {
    for (const change of ["retire", "disconnect", "endpoint"] as const) {
      const fast = fixture(true);
      const slow = fixture();
      const gate = deferred<any>();
      const readFinished = deferred<void>();
      const lease = fast.lease()!;
      let checks = 0;
      let endpoint = "1".repeat(64);
      slow.call.mockImplementationOnce(() => gate.promise);
      const context = createAssistantContext({
        catalog: () => [
          { id: "fast", label: "Fast" },
          { id: "slow", label: "Slow" },
        ],
        recoveryFingerprint: (id) =>
          id === "fast" ? endpoint : "2".repeat(64),
        lease: (id) =>
          id === "slow"
            ? slow.lease()
            : {
                ...lease,
                isCurrent: () => {
                  const current = lease.isCurrent();
                  if (++checks === 2) readFinished.resolve();
                  return current;
                },
              },
      });
      const pending = context.catalog();
      await readFinished.promise;
      if (change === "endpoint") endpoint = "3".repeat(64);
      else fast[change]();
      gate.resolve({ workspaces: slow.workspaces });
      const result = await pending;
      expect(result.workspaces).toHaveLength(2);
      expect(
        result.workspaces.every((item) => item.connection_id === "slow"),
      ).toBe(true);
      expect(result.connection_ids).toEqual(["fast", "slow"]);
      expect(result.complete_connection_ids).toEqual(["slow"]);
      expect(result.errors).toEqual([
        "Unable to list workspaces for connection Fast",
      ]);
    }
  });

  test("scope captures 512 workspaces and rejects 513 before reading", async () => {
    const f = fixture();
    f.workspaces.push(
      ...Array.from({ length: 510 }, (_, index) => ({
        ...f.workspaces[0]!,
        workspace_id: `w${index + 3}`,
      })),
    );
    const refs = f.workspaces.map(({ workspace_id }) => ({
      connection_id: "local",
      workspace_id,
    }));
    const captured = await f.context.captureScope(refs);
    expect(captured).toHaveLength(512);
    expect(captured[511]?.workspace_id).toBe("w512");
    expect(Object.isFrozen(captured)).toBe(true);
    expect(f.lease).toHaveBeenCalledTimes(1);
    f.call.mockClear();
    await expect(
      f.context.captureScope([
        ...refs,
        { connection_id: "local", workspace_id: "w513" },
      ]),
    ).rejects.toThrow("Choose between 1 and 512");
    expect(f.call).not.toHaveBeenCalled();
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

  test("stopping scope admission rejects promptly and never dispatches queued workspaces", async () => {
    const f = scopeFixture();
    const reads = gatedWorkspaceReads(f);
    const controller = new AbortController();
    const pending = f.context.captureScope(f.refs, controller.signal);
    expect(reads.requests).toHaveLength(8);
    controller.abort(new Error("Stopped during scope admission"));
    await expect(pending).rejects.toThrow("Stopped during scope admission");
    expect(reads.requests).toHaveLength(8);
    expect(f.lease).toHaveBeenCalledTimes(1);
    reads.requests.forEach((request) => request.resolve());
    await flushReads();
    expect(reads.active).toBe(0);
    expect(reads.requests).toHaveLength(8);

    await expect(
      f.context.captureScope([first], controller.signal),
    ).rejects.toThrow("Stopped during scope admission");
    expect(reads.requests).toHaveLength(8);
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

describe("Ranger structured mention targets", () => {
  async function selectedAgent(
    f: ReturnType<typeof fixture>,
    captured: Awaited<ReturnType<typeof f.context.captureScope>>,
  ) {
    const catalog = await f.context.mentionCatalog(captured);
    const agent = catalog.targets.find((target) => target.kind === "agent");
    expect(agent?.kind).toBe("agent");
    return agent as Extract<AssistantMentionTarget, { kind: "agent" }>;
  }

  test("catalog includes authorized canonical objects and only opaque concrete agent identities", async () => {
    const f = fixture();
    const captured = await f.context.captureScope([first]);
    const catalog = await f.context.mentionCatalog(captured);
    expect(isAssistantMentionCatalog(catalog)).toBe(true);
    expect(catalog.targets).toHaveLength(2);
    expect(catalog.targets[0]).toMatchObject({
      kind: "workspace",
      ...first,
      label: "Allowed",
      workspace_label: "Allowed",
      connection_label: "Local",
      runtime_generation: 1,
    });
    expect(catalog.targets[1]).toMatchObject({
      kind: "agent",
      ...first,
      pane_id: "w1:p1",
      terminal_id: "term1",
      agent: "pi",
    });
    const serialized = JSON.stringify(catalog);
    for (const secret of [
      "/secret",
      "api_key",
      "private-key",
      "foreground_processes",
      "PRIVATE WORKSPACE",
      "PRIVATE PANE",
    ])
      expect(serialized).not.toContain(secret);
    const calls = f.call.mock.calls.length;
    await expect(f.context.mentionCatalog([...captured])).rejects.toThrow(
      "not approved",
    );
    expect(f.call.mock.calls).toHaveLength(calls);
  });

  test("duplicate display names preserve parent identity and cross-workspace or forged references are denied", async () => {
    const f = fixture();
    f.workspaces[1]!.label = "Allowed";
    Object.assign(f.panes[1]!, {
      label: "Agent",
      agent_session: { kind: "id", value: "different-session" },
    });
    const captured = await f.context.captureScope([
      first,
      { ...first, workspace_id: "w2" },
    ]);
    const catalog = await f.context.mentionCatalog(captured);
    const agents = catalog.targets.filter((target) => target.kind === "agent");
    expect(agents.map((target) => target.label)).toEqual(["Agent", "Agent"]);
    expect(agents.map((target) => target.workspace_id)).toEqual(["w1", "w2"]);
    for (const change of [
      { connection_id: "other" },
      { workspace_id: "private" },
      { runtime_generation: 2 },
      { workspace_id: "w2" },
      { agent_identity: "b".repeat(64) },
    ])
      await expect(
        f.context.bindMentions(captured, [{ ...agents[0]!, ...change }]),
      ).rejects.toThrow();
    await expect(
      f.context.bindMentions([...captured], agents),
    ).rejects.toThrow();
    await expect(
      f.context.bindMentions(captured, [
        { ...agents[0]!, path: "/secret" } as AssistantMentionTarget,
      ]),
    ).rejects.toThrow();
  });

  test("catalog does not invent an agent-session binding when the concrete session is unavailable", async () => {
    const f = fixture();
    const captured = await f.context.captureScope([first]);
    Object.assign(f.panes[0]!, { agent_session: null });
    const catalog = await f.context.mentionCatalog(captured);
    expect(catalog.targets.map((target) => target.kind)).toEqual(["workspace"]);
    expect(catalog.errors).toHaveLength(1);
  });

  test("workspace rename and bridge reconnect preserve concrete agent identity without relaxing generation checks", async () => {
    const f = fixture();
    const captured = await f.context.captureScope([first]);
    const selected = await selectedAgent(f, captured);
    f.workspaces[0]!.label = "Renamed";
    f.panes[0]!.label = "Renamed agent";
    const canonical = await f.context.bindMentions(captured, [selected]);
    expect(canonical[0]).toMatchObject({
      workspace_label: "Renamed",
      label: "Renamed agent",
      agent_identity: selected.agent_identity,
    });
    f.retire();
    await expect(f.context.bindMentions(captured, [selected])).rejects.toThrow(
      "Connection changed",
    );
    const restored = await f.context.captureScope([first]);
    const current = await selectedAgent(f, restored);
    expect(current.agent_identity).toBe(selected.agent_identity);
    await expect(f.context.bindMentions(restored, [selected])).rejects.toThrow(
      "connection changed",
    );
    await expect(
      f.context.bindMentions(restored, [
        { ...selected, runtime_generation: current.runtime_generation },
      ]),
    ).resolves.toHaveLength(1);
  });

  test("selection and bound history or terminal reads fail when the agent session changes", async () => {
    for (const kind of ["history", "terminal"] as const) {
      const f = fixture();
      const captured = await f.context.captureScope([first]);
      const selected = await selectedAgent(f, captured);
      await f.context.bindMentions(captured, [selected]);
      f.panes[0]!.agent_session!.value = "/secret/new-session";
      await expect(
        f.context.bindMentions(captured, [selected]),
      ).rejects.toThrow("session changed");
      await expect(
        f.context.read(kind, captured, { ...first, pane_id: selected.pane_id }),
      ).rejects.toThrow("session changed");
      expect(f.readHistory).not.toHaveBeenCalled();
      expect(f.call.mock.calls.some(([method]) => method === "pane.read")).toBe(
        false,
      );
    }
  });

  test("a replacement during history reading is rejected before evidence can leave the context", async () => {
    const f = fixture();
    const captured = await f.context.captureScope([first]);
    const selected = await selectedAgent(f, captured);
    await f.context.bindMentions(captured, [selected]);
    f.readHistory.mockImplementationOnce(async () => {
      f.panes[0]!.agent_session!.value = "/secret/replaced";
      return {
        pane_id: selected.pane_id,
        workspace_id: "w1",
        agent: "pi",
        status: "ok",
        messages: [{ role: "assistant", text: "Wrong agent private data" }],
      };
    });
    await expect(
      f.context.read("history", captured, {
        ...first,
        pane_id: selected.pane_id,
      }),
    ).rejects.toThrow("session changed");
    expect(f.readHistory).toHaveBeenCalledTimes(1);
  });

  test("binding another subset does not erase existing agent guards", async () => {
    const f = fixture();
    const captured = await f.context.captureScope([first]);
    const catalog = await f.context.mentionCatalog(captured);
    const selected = catalog.targets.find((target) => target.kind === "agent")!;
    await f.context.bindMentions(captured, [selected]);
    await f.context.bindMentions(captured, [catalog.targets[0]!]);
    f.panes[0]!.terminal_id = "replacement-terminal";
    await expect(
      f.context.read("history", captured, { ...first, pane_id: "w1:p1" }),
    ).rejects.toThrow("session changed");
  });

  test("a replacement during terminal reading is rejected after the native read", async () => {
    const f = fixture();
    const captured = await f.context.captureScope([first]);
    const selected = await selectedAgent(f, captured);
    await f.context.bindMentions(captured, [selected]);
    f.call.mockImplementation(async (method, params = {}) => {
      if (method === "workspace.get") return { workspace: f.workspaces[0] };
      if (method === "pane.get") return { pane: f.panes[0] };
      if (method === "agent.get") return { agent: f.panes[0] };
      if (method === "pane.process_info")
        return {
          process_info: {
            pane_id: params.pane_id,
            shell_pid: 101,
            foreground_processes: [{ pid: 202, name: "pi" }],
          },
        };
      if (method === "pane.read") {
        f.panes[0]!.agent_session!.value = "/secret/replaced";
        return {
          read: {
            pane_id: "w1:p1",
            workspace_id: "w1",
            text: "Wrong agent private output",
          },
        };
      }
      throw new Error("Unexpected RPC");
    });
    await expect(
      f.context.read("terminal", captured, {
        ...first,
        pane_id: selected.pane_id,
      }),
    ).rejects.toThrow("session changed");
    expect(
      f.call.mock.calls.filter(([method]) => method === "pane.read"),
    ).toHaveLength(1);
  });

  test("agent replacements block both proposal preparation and later confirmation without sending a prompt", async () => {
    const f = fixture();
    const captured = await f.context.captureScope([first]);
    const selected = await selectedAgent(f, captured);
    await f.context.bindMentions(captured, [selected]);
    const params = { ...first, pane_id: selected.pane_id, prompt: "Continue" };
    const prepared = await f.context.prepareAction(
      "send_prompt",
      captured,
      params,
    );
    f.panes[0]!.agent_session!.value = "/secret/replaced";
    await expect(
      f.context.prepareAction("send_prompt", captured, params),
    ).rejects.toThrow("session changed");
    expect(await prepared.execute()).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("Nothing was sent"),
    });
    expect(
      f.call.mock.calls.some(([method]) => method === "agent.prompt"),
    ).toBe(false);
  });

  test("catalog discovery bounds large inventories while preserving the requested workspace order", async () => {
    const f = scopeFixture(65);
    const captured = await f.context.captureScope([...f.refs].reverse());
    const catalog = await f.context.mentionCatalog(captured);
    expect(
      catalog.targets.filter((target) => target.kind === "workspace"),
    ).toHaveLength(65);
    expect(catalog.targets[0]!.workspace_id).toBe("w65");
    expect(catalog.truncated).toBe(true);
    expect(
      f.call.mock.calls.filter(([method]) => method === "pane.list"),
    ).toHaveLength(64);
    const many = fixture();
    many.panes.splice(1, 1);
    many.panes.push(
      ...Array.from({ length: 200 }, (_, index) => ({
        ...many.panes[0]!,
        pane_id: `w1:p${index + 2}`,
        terminal_id: `term${index + 2}`,
      })),
    );
    const scope = await many.context.captureScope([first]);
    const limited = await many.context.mentionCatalog(scope);
    expect(
      limited.targets.filter((target) => target.kind === "agent"),
    ).toHaveLength(200);
    expect(limited.truncated).toBe(true);
    expect(
      many.call.mock.calls.filter(([method]) => method === "agent.get"),
    ).toHaveLength(200);
  });
});
