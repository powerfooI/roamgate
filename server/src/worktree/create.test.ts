import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  updateGuiSettings,
  workspaceRepoSettingsKey,
} from "../config/gui-settings";
import type { LegacyConnectionRuntime } from "../connections/runtime";
import { shQuote } from "../utils/process-utils";
import type { GuiSettings } from "../config/gui-settings";
import {
  createWorkspaceWorktree,
  herdrDefaultCheckoutPath,
  syncWorktreeBase,
  WORKTREE_COMMAND_TIMEOUT_MS,
  worktreeCheckoutPath,
} from "./create";

const commit = "a".repeat(40);
const remoteHead = `ref: refs/heads/master\tHEAD\n${commit}\tHEAD\n`;

/** The script inside the `sh -c '<script>'` sent over ssh, unquoted by sh. */
function remoteScript(command: string) {
  expect(command).toStartWith("sh -c ");
  const run = Bun.spawnSync(["sh", "-c", `printf %s ${command.slice(6)}`]);
  return run.stdout.toString();
}

test("a worktree base without origin is the checked out commit, in any language", async () => {
  const oid = "a".repeat(40);
  const result = await syncWorktreeBase({
    workspaceId: "w1",
    resolveGitRoot: async () => ({ root: "/repo" }),
    shQuote,
    runProcessWithCodeTimeout: async (argv) => {
      const command = argv.at(-1) ?? "";
      if (command.includes("remote get-url origin"))
        return {
          code: 2,
          stdout: "",
          stderr: "error: No such remote 'origin'\n",
        };
      if (command.includes("rev-parse --verify 'HEAD^{commit}'"))
        return { code: 0, stdout: `${oid}\n`, stderr: "" };
      if (command.includes("for-each-ref"))
        return { code: 0, stdout: "", stderr: "" };
      // Git in French, as the user's machine may speak it.
      return {
        code: 128,
        stdout: "",
        stderr:
          "fatal : 'origin' ne semble pas être un dépôt git\nfatal : Impossible de lire le dépôt distant.\n",
      };
    },
  });
  expect(result).toMatchObject({ base: "HEAD", commit: oid });
});

describe("worktree creation preparation", () => {
  test.each([
    { name: "local SHA-1", host: undefined, oid: commit },
    { name: "SSH SHA-256", host: "dev@example.test", oid: "b".repeat(64) },
  ])(
    "fetches the advertised commit and refreshes its tracking ref ($name)",
    async ({ host, oid }) => {
      const calls: string[][] = [];
      const fetchCommand = `git fetch --no-tags --no-write-fetch-head --refmap= origin '${oid}'`;
      const results = [
        { code: 0, stdout: "", stderr: "" },
        {
          code: 0,
          stdout: `ref: refs/heads/master\tHEAD\n${oid}\tHEAD\n`,
          stderr: "",
        },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "fetched\n" },
        { code: 0, stdout: `${oid}\n`, stderr: "" },
        { code: 1, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
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
      expect(calls).toHaveLength(7);
      expect(calls[0][0]).toBe(host ? "ssh" : "sh");
      if (host) expect(calls[0].slice(-3, -1)).toEqual(["--", host]);
      expect(calls.map((argv) => argv.at(-1))).toEqual([
        "GIT_TERMINAL_PROMPT=0 git -C '/repo with spaces' for-each-ref --format='%(refname) %(objectname) %(symref)' refs/remotes/origin/",
        "GIT_TERMINAL_PROMPT=0 git -C '/repo with spaces' ls-remote --symref origin HEAD",
        "GIT_TERMINAL_PROMPT=0 git -C '/repo with spaces' check-ref-format 'refs/heads/master'",
        `GIT_TERMINAL_PROMPT=0 git -C '/repo with spaces' ${fetchCommand.slice(4)}`,
        `GIT_TERMINAL_PROMPT=0 git -C '/repo with spaces' rev-parse --verify '${oid}^{commit}'`,
        "GIT_TERMINAL_PROMPT=0 git -C '/repo with spaces' symbolic-ref --quiet 'refs/remotes/origin/master'",
        `GIT_TERMINAL_PROMPT=0 git -C '/repo with spaces' update-ref --no-deref 'refs/remotes/origin/master' '${oid}' ''`,
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
      name: "tracking lookup fails",
      results: [{ code: 128, stdout: "", stderr: "unable to read refs" }],
      error: "Unable to read origin's tracking refs: unable to read refs",
    },
    {
      name: "remote lookup fails",
      results: [
        { code: 0, stdout: "", stderr: "" },
        { code: 128, stdout: "", stderr: "origin is unavailable" },
      ],
      error:
        "Unable to determine origin's default branch: origin is unavailable",
    },
    {
      name: "remote HEAD has no symbolic branch",
      results: [
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: `${commit}\tHEAD\n`, stderr: "" },
      ],
      error: "origin HEAD does not identify a branch",
    },
    {
      name: "remote is empty",
      results: [
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
      ],
      error: "origin HEAD does not identify a branch",
    },
    {
      name: "remote HEAD is invalid",
      results: [
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "ref: refs/heads/bad:name\tHEAD\n", stderr: "" },
        { code: 1, stdout: "", stderr: "" },
      ],
      error: "origin HEAD contains an invalid branch ref",
    },
    {
      name: "remote HEAD has no valid object ID",
      results: [
        { code: 0, stdout: "", stderr: "" },
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
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: remoteHead, stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 128, stdout: "", stderr: "remote master is unavailable" },
      ],
      error: "Unable to update origin/master: remote master is unavailable",
    },
    {
      name: "fetched commit cannot be resolved",
      results: [
        { code: 0, stdout: "", stderr: "" },
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
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: remoteHead, stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "b".repeat(40), stderr: "" },
      ],
      error: "Unable to resolve origin/master after fetching it",
    },
    {
      name: "symbolic tracking lookup fails",
      results: [
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: remoteHead, stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: commit, stderr: "" },
        { code: 128, stdout: "", stderr: "unable to read tracking ref" },
      ],
      error:
        "Unable to check origin/master's tracking ref: unable to read tracking ref",
    },
    {
      name: "tracking update fails",
      results: [
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: remoteHead, stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: commit, stderr: "" },
        { code: 1, stdout: "", stderr: "" },
        { code: 128, stdout: "", stderr: "tracking ref changed" },
        { code: 1, stdout: "", stderr: "" },
      ],
      error:
        "Unable to update origin/master's tracking ref: tracking ref changed",
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
  settings: Partial<GuiSettings> = {},
) {
  const calls: string[] = [];
  const methods: string[] = [];
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
        methods.push(method);
        rpcParams.push(params);
        record("create");
        return method === "worktree.open"
          ? { workspace, already_open: false }
          : { workspace };
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
          worktree: { checkout_path: "/source/checkout", repo_name: "Source" },
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
  const readSettings = async (): Promise<GuiSettings> => ({
    version: 1,
    repositories: {},
    workspace_auto_sync: {},
    custom: {},
    ui: {},
    ...settings,
  });
  return {
    runtime,
    syncBase,
    readSettings,
    isCurrent,
    calls,
    methods,
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
      undefined,
      { readSettings: fixture.readSettings },
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
        worktree: { checkout_path: "/source/checkout", repo_name: "Source" },
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
      undefined,
      { readSettings: fixture.readSettings },
    );
    expect(fixture.calls.at(-1)).toBe("setup");
    expect(fixture.hookArgs[0]?.[2]).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(result.parent_tracking_failed).toBe(true);
    expect(JSON.stringify(result)).not.toContain("parent storage unavailable");
    expect(fixture.methods).toEqual(["worktree.create"]);
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
        undefined,
        { readSettings: fixture.readSettings },
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
          undefined,
          { readSettings: fixture.readSettings },
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
          undefined,
          { readSettings: fixture.readSettings },
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
          undefined,
          { readSettings: fixture.readSettings },
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
          undefined,
          { readSettings: fixture.readSettings },
        ),
      ).rejects.toThrow("Confirmed setup hook configuration is invalid.");
      expect(fixture.calls).toEqual([]);
    },
  );
});

describe("configured worktree command", () => {
  const repoKey = "ssh:host:/source/checkout";
  const template = "git recworktree add {path} --branch {branch} --base {base}";

  function commandFixture(
    settings: Partial<GuiSettings>,
    result = { code: 0, stdout: "made it\n\n/created/checkout\n", stderr: "" },
    probeCode = 0,
  ) {
    const fixture = creationFixture(undefined, false, undefined, settings);
    const processes: { argv: string[]; timeout: number }[] = [];
    const probes: string[][] = [];
    const self = {
      ...fixture,
      processes,
      probes,
      create: (params: Record<string, unknown> = {}) =>
        createWorkspaceWorktree(
          fixture.runtime,
          {
            workspace_id: "source",
            branch: "feature/x",
            focus: true,
            ...params,
          },
          fixture.isCurrent,
          undefined,
          self.syncBase,
          undefined,
          {
            readSettings: fixture.readSettings,
            runProcess: async (argv, timeout) => {
              if (argv.at(-1)!.includes("command -v")) {
                probes.push(argv);
                fixture.calls.push("probe");
                return { code: probeCode, stdout: "", stderr: "" };
              }
              processes.push({ argv, timeout });
              fixture.calls.push("command");
              return result;
            },
          },
        ),
    };
    return self;
  }

  test("defaults to Herdr's own checkout path", () => {
    expect(herdrDefaultCheckoutPath("herdr", "worktree/brave-river")).toBe(
      "~/.herdr/worktrees/herdr/worktree-brave-river",
    );
    expect(herdrDefaultCheckoutPath("r", "Issue/137 Spaces")).toBe(
      "~/.herdr/worktrees/r/issue-137-spaces",
    );
    expect(herdrDefaultCheckoutPath("r", "///")).toBe(
      "~/.herdr/worktrees/r/worktree",
    );
  });

  test("runs over SSH from the source root, then opens the path in Herdr", async () => {
    const fixture = commandFixture({
      repositories: {
        [repoKey]: { worktree_command: template, worktree_directory: "/wt" },
      },
    });
    const result = await fixture.create({ label: "X" });
    expect(fixture.calls).toEqual([
      "source",
      "sync",
      "resolve",
      "probe",
      "command",
      "create",
      "parent",
      "setup",
    ]);
    expect(remoteScript(fixture.probes[0]!.at(-1)!)).toBe(
      "command -v -- 'git' >/dev/null 2>&1 || exit 127; git --list-cmds=main,others,alias 2>/dev/null | grep -qxF -- 'recworktree' || exit 127",
    );
    const [{ argv, timeout }] = fixture.processes;
    expect(timeout).toBe(WORKTREE_COMMAND_TIMEOUT_MS);
    expect(argv[0]).toBe("ssh");
    expect(argv.slice(-3, -1)).toEqual(["--", "host"]);
    expect(remoteScript(argv.at(-1)!)).toBe(
      `export ROAMGATE_WORKTREE_PATH='/wt/feature-x'; export ROAMGATE_WORKTREE_BRANCH='feature/x'; export ROAMGATE_WORKTREE_BASE='${commit}'; export ROAMGATE_WORKTREE_REPO='/source/root'; cd "$ROAMGATE_WORKTREE_REPO" && git recworktree add "$ROAMGATE_WORKTREE_PATH" --branch "$ROAMGATE_WORKTREE_BRANCH" --base "$ROAMGATE_WORKTREE_BASE" && cd "$ROAMGATE_WORKTREE_PATH" && printf '\\n%s\\n' "$PWD"`,
    );
    expect(fixture.methods).toEqual(["worktree.open"]);
    expect(fixture.rpcParams).toEqual([
      {
        path: "/created/checkout",
        workspace_id: "source",
        focus: true,
        label: "X",
      },
    ]);
    expect(result).not.toHaveProperty("already_open");
    expect(result.workspace).toEqual({
      workspace_id: "created",
      cwd: "/created",
    });
  });

  test("uses the global default locally, at Herdr's default path", async () => {
    const fixture = commandFixture({ worktree_command: "mk {path} {repo}" });
    fixture.runtime.sshHost = () => undefined;
    const syncBase = fixture.syncBase;
    fixture.syncBase = (args) => syncBase({ ...args, host: "host" });
    await fixture.create();
    expect(fixture.processes[0]?.argv).toEqual([
      "sh",
      "-lc",
      `export ROAMGATE_WORKTREE_PATH="$HOME"/'.herdr/worktrees/Source/feature-x'; export ROAMGATE_WORKTREE_BRANCH='feature/x'; export ROAMGATE_WORKTREE_BASE='${commit}'; export ROAMGATE_WORKTREE_REPO='/source/root'; cd "$ROAMGATE_WORKTREE_REPO" && mk "$ROAMGATE_WORKTREE_PATH" "$ROAMGATE_WORKTREE_REPO" && cd "$ROAMGATE_WORKTREE_PATH" && printf '\\n%s\\n' "$PWD"`,
    ]);
    expect(fixture.rpcParams).toEqual([
      {
        path: "/created/checkout",
        workspace_id: "source",
        focus: true,
      },
    ]);
  });

  test("a repository command overrides the global default", async () => {
    const fixture = commandFixture({
      worktree_command: "global {path}",
      repositories: { [repoKey]: { worktree_command: "repo {branch}" } },
    });
    await fixture.create();
    expect(remoteScript(fixture.processes[0]!.argv.at(-1)!)).toContain(
      `cd "$ROAMGATE_WORKTREE_REPO" && repo "$ROAMGATE_WORKTREE_BRANCH" && `,
    );
  });

  test("a failing command surfaces its output and opens nothing", async () => {
    const fixture = commandFixture(
      { worktree_command: template },
      { code: 2, stdout: "progress\n", stderr: "\nfatal: branch exists\n\n" },
    );
    await expect(fixture.create()).rejects.toThrow(
      "Worktree command failed (exit 2): fatal: branch exists",
    );
    expect(fixture.methods).toEqual([]);
    expect(fixture.hookArgs).toEqual([]);
  });

  test("a command not installed on the host falls back to Herdr's worktree, and says so", async () => {
    const fixture = commandFixture(
      { worktree_command: template },
      undefined,
      127,
    );
    const result = await fixture.create();
    expect(fixture.processes).toEqual([]);
    expect(fixture.methods).toEqual(["worktree.create"]);
    expect(result.command_fallback).toBe(
      "git recworktree is not installed on host. Herdr created the worktree.",
    );
  });

  test("an exit 127 from inside an installed command is a failure, not a fallback", async () => {
    const fixture = commandFixture(
      { worktree_command: template },
      { code: 127, stdout: "", stderr: "post-checkout: mk: not found\n" },
    );
    await expect(fixture.create()).rejects.toThrow(
      "Worktree command failed (exit 127): post-checkout: mk: not found",
    );
    expect(fixture.methods).toEqual([]);
  });

  test("a checkout already open in Herdr does not rerun its setup hook", async () => {
    const fixture = commandFixture({ worktree_command: template });
    fixture.runtime.herdr.call = async (method: string) => {
      fixture.methods.push(method);
      return { workspace: { workspace_id: "old" }, already_open: true };
    };
    await expect(fixture.create()).rejects.toThrow(
      "The worktree command left /created/checkout, which was already open in Herdr; the setup hook was not run again.",
    );
    expect(fixture.methods).toEqual(["worktree.open"]);
    expect(fixture.hookArgs).toEqual([]);
  });

  test("a command changed since Ranger's confirmation runs nothing", async () => {
    const fixture = commandFixture({ worktree_command: template });
    await expect(
      fixture.create({ expected_worktree_command: "other {path}" }),
    ).rejects.toThrow("The worktree command changed.");
    await expect(
      fixture.create({ expected_worktree_command: null }),
    ).rejects.toThrow("The worktree command changed.");
    expect(fixture.processes).toEqual([]);
    expect(fixture.methods).toEqual([]);
    await fixture.create({ expected_worktree_command: template });
    expect(fixture.methods).toEqual(["worktree.open"]);
  });

  test("refuses a branch name with shell syntax before anything runs", async () => {
    const fixture = commandFixture({ worktree_command: template });
    for (const branch of ["a$(touch${IFS}/tmp/x)", "a`id`", "-b", "a..b"])
      await expect(fixture.create({ branch })).rejects.toThrow(
        "Invalid branch name",
      );
    expect(fixture.calls).toEqual([]);
    expect(fixture.processes).toEqual([]);
  });

  test("a target retired while the command runs is not opened", async () => {
    const fixture = commandFixture({ worktree_command: template });
    const runtime = fixture.runtime;
    let current = true;
    await expect(
      createWorkspaceWorktree(
        runtime,
        { workspace_id: "source", branch: "feature" },
        () => current,
        undefined,
        fixture.syncBase,
        undefined,
        {
          readSettings: fixture.readSettings,
          runProcess: async () => {
            current = false;
            return { code: 0, stdout: "", stderr: "" };
          },
        },
      ),
    ).rejects.toThrow("The worktree target changed.");
    expect(fixture.methods).toEqual([]);
  });
});

test("Windows runtimes refuse worktree creation before any helper runs", async () => {
  const fixture = creationFixture();
  Object.assign(fixture.runtime, { remotePlatform: "windows" });
  await expect(
    createWorkspaceWorktree(
      fixture.runtime,
      { workspace_id: "source", branch: "feature" },
      fixture.isCurrent,
      undefined,
      fixture.syncBase,
      undefined,
      { readSettings: fixture.readSettings },
    ),
  ).rejects.toThrow("unavailable on Windows");
  expect(fixture.calls).toEqual([]);
});

describe("repository worktree directory", () => {
  test("a branch becomes one safe directory name under it", () => {
    expect(worktreeCheckoutPath("/w/repo", "feature/login")).toBe(
      "/w/repo/feature-login",
    );
    expect(worktreeCheckoutPath("/w/repo/", "  fix: a b  ")).toBe(
      "/w/repo/fix-a-b",
    );
    // Leading dots never climb out of the directory.
    expect(worktreeCheckoutPath("/w/repo", "../../etc")).toBe("/w/repo/etc");
    expect(() => worktreeCheckoutPath("/w/repo", "///")).toThrow("empty");
  });

  test("creation puts the worktree in the repository's directory unless a path is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roamgate-worktree-dir-"));
    const previous = process.env.ROAMGATE_SETTINGS_PATH;
    process.env.ROAMGATE_SETTINGS_PATH = join(dir, "settings.json");
    try {
      const key = workspaceRepoSettingsKey(
        { cwd: "/source", worktree: { checkout_path: "/source/checkout" } },
        "host",
        undefined,
      );
      expect(key).toBeTruthy();
      await updateGuiSettings((settings) => ({
        ...settings,
        repositories: {
          ...settings.repositories,
          [key!]: { worktree_directory: "/srv/trees" },
        },
      }));

      const placed = creationFixture();
      await createWorkspaceWorktree(
        placed.runtime,
        { workspace_id: "source", branch: "team/feature" },
        placed.isCurrent,
        undefined,
        placed.syncBase,
      );
      expect(placed.rpcParams[0]?.path).toBe("/srv/trees/team-feature");

      const explicit = creationFixture();
      await createWorkspaceWorktree(
        explicit.runtime,
        { workspace_id: "source", branch: "team/feature", path: "/elsewhere" },
        explicit.isCurrent,
        undefined,
        explicit.syncBase,
      );
      expect(explicit.rpcParams[0]?.path).toBe("/elsewhere");
    } finally {
      if (previous === undefined) delete process.env.ROAMGATE_SETTINGS_PATH;
      else process.env.ROAMGATE_SETTINGS_PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a command changed while its install probe runs is not dispatched", async () => {
  const template = "git recworktree add {path} --branch {branch}";
  const settings: Partial<GuiSettings> = { worktree_command: template };
  const f = creationFixture(undefined, false, undefined, settings);
  let executed = false;
  await expect(
    createWorkspaceWorktree(
      f.runtime,
      {
        workspace_id: "source",
        branch: "feature",
        expected_worktree_command: template,
      },
      f.isCurrent,
      undefined,
      f.syncBase,
      undefined,
      {
        readSettings: f.readSettings,
        runProcess: async (argv) => {
          if (argv.at(-1)!.includes("command -v")) {
            settings.worktree_command = "different-command {path}";
            return { code: 0, stdout: "", stderr: "" };
          }
          executed = true;
          return { code: 0, stdout: "/created/checkout\n", stderr: "" };
        },
      },
    ),
  ).rejects.toThrow("The worktree command changed");
  expect(executed).toBe(false);
  expect(f.methods).toEqual([]);
});
