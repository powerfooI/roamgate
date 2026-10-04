import { describe, expect, test } from "bun:test";
import type { LegacyConnectionRuntime } from "../connections/runtime";
import { shQuote } from "../utils/process-utils";
import { createWorkspaceWorktree, syncWorktreeBase } from "./create";

const commit = "a".repeat(40);
const remoteHead = `ref: refs/heads/master\tHEAD\n${commit}\tHEAD\n`;

describe("worktree creation preparation", () => {
  test.each([
    { name: "local SHA-1", host: undefined, oid: commit },
    { name: "SSH SHA-256", host: "dev@example.test", oid: "b".repeat(64) },
  ])(
    "fetches the advertised commit without writing refs ($name)",
    async ({ host, oid }) => {
      const calls: string[][] = [];
      const fetchCommand = `git fetch --no-tags --no-write-fetch-head --refmap= origin '${oid}'`;
      const results = [
        {
          code: 0,
          stdout: `ref: refs/heads/master\tHEAD\n${oid}\tHEAD\n`,
          stderr: "",
        },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "fetched\n" },
        { code: 0, stdout: `${oid}\n`, stderr: "" },
      ];
      const result = await syncWorktreeBase({
        workspaceId: "w1",
        resolveGitRoot: async () => ({ root: "/repo with spaces" }),
        host,
        shQuote,
        runProcessWithCodeTimeout: async (argv) => {
          calls.push(argv);
          const result = results.shift();
          if (!result) throw new Error("unexpected process call");
          return result;
        },
      });
      expect(calls).toHaveLength(4);
      expect(calls[0][0]).toBe(host ? "ssh" : "sh");
      if (host) expect(calls[0].slice(-3, -1)).toEqual(["--", host]);
      expect(calls.map((argv) => argv.at(-1))).toEqual([
        "GIT_TERMINAL_PROMPT=0 git -C '/repo with spaces' ls-remote --symref origin HEAD",
        "GIT_TERMINAL_PROMPT=0 git -C '/repo with spaces' check-ref-format 'refs/heads/master'",
        `GIT_TERMINAL_PROMPT=0 git -C '/repo with spaces' ${fetchCommand.slice(4)}`,
        `GIT_TERMINAL_PROMPT=0 git -C '/repo with spaces' rev-parse --verify '${oid}^{commit}'`,
      ]);
      expect(result).toMatchObject({
        workspace_id: "w1",
        root: "/repo with spaces",
        base: "origin/master",
        commit: oid,
        command: fetchCommand,
        stderr: "fetched",
      });
    },
  );

  test.each([
    {
      name: "remote lookup fails",
      results: [{ code: 128, stdout: "", stderr: "origin is unavailable" }],
      error:
        "Unable to determine origin's default branch: origin is unavailable",
    },
    {
      name: "remote HEAD has no symbolic branch",
      results: [{ code: 0, stdout: `${commit}\tHEAD\n`, stderr: "" }],
      error: "origin HEAD does not identify a branch",
    },
    {
      name: "remote is empty",
      results: [{ code: 0, stdout: "", stderr: "" }],
      error: "origin HEAD does not identify a branch",
    },
    {
      name: "remote HEAD is invalid",
      results: [
        { code: 0, stdout: "ref: refs/heads/bad:name\tHEAD\n", stderr: "" },
        { code: 1, stdout: "", stderr: "" },
      ],
      error: "origin HEAD contains an invalid branch ref",
    },
    {
      name: "remote HEAD has no valid object ID",
      results: [
        {
          code: 0,
          stdout: "ref: refs/heads/master\tHEAD\n$(id)\tHEAD\n",
          stderr: "",
        },
        { code: 0, stdout: "", stderr: "" },
      ],
      error: "origin HEAD does not identify a commit",
    },
    {
      name: "fetch fails",
      results: [
        { code: 0, stdout: remoteHead, stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 128, stdout: "", stderr: "remote master is unavailable" },
      ],
      error: "Unable to update origin/master: remote master is unavailable",
    },
    {
      name: "fetched commit cannot be resolved",
      results: [
        { code: 0, stdout: remoteHead, stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 128, stdout: "", stderr: "missing commit" },
      ],
      error:
        "Unable to resolve origin/master after fetching it: missing commit",
    },
    {
      name: "resolved commit differs from the advertised object",
      results: [
        { code: 0, stdout: remoteHead, stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "b".repeat(40), stderr: "" },
      ],
      error: "Unable to resolve origin/master after fetching it",
    },
  ])(
    "does not fall back to another base when $name",
    async ({ results, error }) => {
      let calls = 0;
      await expect(
        syncWorktreeBase({
          workspaceId: "w1",
          resolveGitRoot: async () => ({ root: "/repo" }),
          shQuote,
          runProcessWithCodeTimeout: async () => {
            const result = results[calls++];
            if (!result) throw new Error("unexpected process call");
            return result;
          },
        }),
      ).rejects.toThrow(error);
      expect(calls).toBe(results.length);
    },
  );
});

function creationFixture(
  retireAfter?: string,
  failParent = false,
  roots = ["/source/root"],
) {
  const calls: string[] = [];
  const rpcParams: Record<string, unknown>[] = [];
  const hookArgs: unknown[][] = [];
  const remainingRoots = [...roots];
  let current = retireAfter !== "initial";
  const isCurrent = () => current;
  const record = (stage: string) => {
    calls.push(stage);
    if (retireAfter === stage) current = false;
  };
  const workspace = { workspace_id: "created", cwd: "/created" };
  const setupHook = {
    event: "worktree.created" as const,
    status: "skipped" as const,
    reason: "setup_hook_changed" as const,
  };
  const runtime = {
    sshHost: () => "host",
    files: {
      resolveWorkspaceGitRoot: async (params: unknown) => {
        expect(params).toEqual({ workspace_id: "source" });
        record("resolve");
        return { root: remainingRoots.shift() ?? "/source/root" };
      },
    },
    herdr: {
      call: async (method: string, params: Record<string, unknown>) => {
        expect(method).toBe("worktree.create");
        rpcParams.push(params);
        record("create");
        return { workspace };
      },
    },
    worktreeParents: {
      rememberWorktreeParent: async (
        result: unknown,
        source: string,
        guard: () => boolean,
      ) => {
        expect(result).toEqual({ workspace });
        expect(source).toBe("source");
        expect(guard).toBe(isCurrent);
        record("parent");
        if (failParent) throw new Error("parent storage unavailable");
      },
    },
    worktreeHooks: {
      sourceWorkspaceForWorktreeCreate: async (
        params: Record<string, unknown>,
      ) => {
        expect(params).not.toHaveProperty("expected_setup_hook");
        expect(params).not.toHaveProperty("expected_hooks_enabled");
        expect(params).not.toHaveProperty("expected_source_root");
        record("source");
        return {
          cwd: "/source",
          worktree: { checkout_path: "/source/checkout" },
        };
      },
      runWorktreeSetupHook: async (...args: unknown[]) => {
        hookArgs.push(args);
        record("setup");
        return setupHook;
      },
    },
  } as unknown as LegacyConnectionRuntime;
  const syncBase: typeof syncWorktreeBase = async (args) => {
    record("sync");
    expect(args.workspaceId).toBe("source");
    expect(args.host).toBe("host");
    const { root } = await args.resolveGitRoot(args.workspaceId);
    return {
      workspace_id: "source",
      root,
      base: "origin/master",
      commit,
      command: "git fetch",
      stdout: "",
      stderr: "",
    };
  };
  return {
    runtime,
    syncBase,
    isCurrent,
    calls,
    rpcParams,
    hookArgs,
    setupHook,
  };
}

describe("shared worktree creation pipeline", () => {
  test("retains sync/create/parent/setup ordering and strips trusted hook confirmation data", async () => {
    const fixture = creationFixture();
    const result = await createWorkspaceWorktree(
      fixture.runtime,
      {
        workspace_id: "source",
        branch: "feature",
        base: "ignored-base",
        expected_setup_hook: "printf approved",
        expected_hooks_enabled: true,
        expected_source_root: "/source/root",
      },
      fixture.isCurrent,
      undefined,
      fixture.syncBase,
    );
    expect(fixture.calls).toEqual([
      "source",
      "sync",
      "resolve",
      "resolve",
      "create",
      "parent",
      "setup",
    ]);
    expect(fixture.rpcParams).toEqual([
      { cwd: "/source/root", branch: "feature", base: commit },
    ]);
    expect(fixture.hookArgs[0]).toEqual([
      { workspace: result.workspace },
      {
        cwd: "/source/checkout",
        worktree: { checkout_path: "/source/checkout" },
      },
      { command: "printf approved", enabled: true },
      fixture.isCurrent,
    ]);
    expect(result.base_sync.commit).toBe(commit);
    expect(result.setup_hook).toBe(fixture.setupHook);
    expect(result).not.toHaveProperty("parent_tracking_failed");
  });

  test("GUI creation needs no expectations and parent storage failure does not skip setup", async () => {
    const fixture = creationFixture(undefined, true);
    const warnings: unknown[] = [];
    const result = await createWorkspaceWorktree(
      fixture.runtime,
      { workspace_id: "source", branch: "feature" },
      fixture.isCurrent,
      (error) => warnings.push(error),
      fixture.syncBase,
    );
    expect(fixture.calls.at(-1)).toBe("setup");
    expect(fixture.hookArgs[0]?.[2]).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(result.parent_tracking_failed).toBe(true);
    expect(JSON.stringify(result)).not.toContain("parent storage unavailable");
    expect(fixture.rpcParams).toEqual([
      { workspace_id: "source", branch: "feature", base: commit },
    ]);
  });

  test("a workspace repointed during fetch cannot dispatch worktree creation", async () => {
    const fixture = creationFixture(undefined, false, [
      "/source/root",
      "/another/repository",
    ]);
    await expect(
      createWorkspaceWorktree(
        fixture.runtime,
        {
          workspace_id: "source",
          branch: "feature",
          expected_source_root: "/source/root",
        },
        fixture.isCurrent,
        undefined,
        fixture.syncBase,
      ),
    ).rejects.toThrow("The worktree source repository changed.");
    expect(fixture.calls).toEqual(["source", "sync", "resolve", "resolve"]);
    expect(fixture.rpcParams).toEqual([]);
    expect(fixture.hookArgs).toEqual([]);
  });

  test("the root supplied to fetch and its reported root must match the preview", async () => {
    for (const changedBeforeFetch of [false, true]) {
      const fixture = creationFixture(undefined, false, [
        changedBeforeFetch ? "/another/repository" : "/source/root",
      ]);
      const syncBase: typeof syncWorktreeBase = async (args) => ({
        ...(await fixture.syncBase(args)),
        root: "/another/repository",
      });
      await expect(
        createWorkspaceWorktree(
          fixture.runtime,
          {
            workspace_id: "source",
            branch: "feature",
            expected_source_root: "/source/root",
          },
          fixture.isCurrent,
          undefined,
          syncBase,
        ),
      ).rejects.toThrow("The worktree source repository changed.");
      expect(fixture.rpcParams).toEqual([]);
      expect(fixture.hookArgs).toEqual([]);
    }
  });

  test.each([undefined, null, "", " "])(
    "rejects invalid expected roots before preparing or mutating a worktree",
    async (expected_source_root) => {
      const fixture = creationFixture();
      await expect(
        createWorkspaceWorktree(
          fixture.runtime,
          { workspace_id: "source", branch: "feature", expected_source_root },
          fixture.isCurrent,
          undefined,
          fixture.syncBase,
        ),
      ).rejects.toThrow("Confirmed source repository is invalid.");
      expect(fixture.calls).toEqual([]);
    },
  );

  test.each([
    ["initial", []],
    ["source", ["source"]],
    ["resolve", ["source", "sync", "resolve"]],
    ["sync", ["source", "sync"]],
    ["create", ["source", "sync", "resolve", "create"]],
    ["parent", ["source", "sync", "resolve", "create", "parent"]],
  ] as const)(
    "stops the pipeline when the target retires at %s",
    async (stage, calls) => {
      const fixture = creationFixture(stage);
      await expect(
        createWorkspaceWorktree(
          fixture.runtime,
          { workspace_id: "source", branch: "feature" },
          fixture.isCurrent,
          undefined,
          fixture.syncBase,
        ),
      ).rejects.toThrow("The worktree target changed.");
      expect(fixture.calls).toEqual([...calls]);
      expect(fixture.hookArgs).toEqual([]);
    },
  );

  test.each([
    { expected_setup_hook: "printf approved" },
    { expected_hooks_enabled: true },
    { expected_setup_hook: undefined, expected_hooks_enabled: true },
    { expected_setup_hook: null, expected_hooks_enabled: "true" },
  ])(
    "rejects incomplete hook confirmation before mutations",
    async (expected) => {
      const fixture = creationFixture();
      await expect(
        createWorkspaceWorktree(
          fixture.runtime,
          { workspace_id: "source", branch: "feature", ...expected },
          fixture.isCurrent,
          undefined,
          fixture.syncBase,
        ),
      ).rejects.toThrow("Confirmed setup hook configuration is invalid.");
      expect(fixture.calls).toEqual([]);
    },
  );
});
