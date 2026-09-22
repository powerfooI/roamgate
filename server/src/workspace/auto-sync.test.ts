import { describe, expect, test } from "bun:test";
import { shQuote } from "../utils/process-utils";
import { createWorkspaceAutoSync, syncWorkspaceBranch } from "./auto-sync";

type Result = { code: number; stdout: string; stderr: string };
const fetchedCommit = "a".repeat(40);
const remoteHead = `ref: refs/heads/master\tHEAD\n${fetchedCommit}\tHEAD\n`;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached");
    await Bun.sleep(1);
  }
}

function autoSyncSettings() {
  return {
    version: 1 as const,
    repositories: {},
    workspace_auto_sync: {
      "local:/repo": {
        enabled: true,
        interval_minutes: 1,
        checkout_path: "/repo",
      },
    },
    custom: {},
  };
}

function runner(results: Result[], commands: string[]) {
  return async (argv: string[]) => {
    commands.push(argv.at(-1) ?? "");
    const result = results.shift();
    if (!result) throw new Error("unexpected process call");
    return result;
  };
}

describe("workspace branch auto-sync", () => {
  test("skips a workspace with uncommitted changes", async () => {
    const commands: string[] = [];
    const result = await syncWorkspaceBranch({
      root: "/repo",
      shQuote,
      runProcessWithCodeTimeout: runner(
        [
          { code: 0, stdout: "true\n", stderr: "" },
          { code: 0, stdout: "feature/test\n", stderr: "" },
          { code: 0, stdout: " M src/index.ts\n", stderr: "" },
        ],
        commands,
      ),
    });

    expect(result).toEqual({
      last_status: "skipped",
      last_message: "Skipped because the workspace has uncommitted changes.",
      last_branch: "feature/test",
    });
    expect(commands).toHaveLength(3);
    expect(commands[2]).toContain("status --porcelain=v1");
  });

  test("fetches and merges origin's default branch into a clean branch", async () => {
    const commands: string[] = [];
    const result = await syncWorkspaceBranch({
      root: "/repo",
      shQuote,
      runProcessWithCodeTimeout: runner(
        [
          { code: 0, stdout: "true\n", stderr: "" },
          { code: 0, stdout: "feature/test\n", stderr: "" },
          { code: 0, stdout: "", stderr: "" },
          { code: 0, stdout: "before\n", stderr: "" },
          { code: 0, stdout: remoteHead, stderr: "" },
          { code: 0, stdout: "", stderr: "" },
          { code: 0, stdout: "", stderr: "" },
          { code: 0, stdout: fetchedCommit, stderr: "" },
          { code: 0, stdout: "feature/test\n", stderr: "" },
          { code: 0, stdout: "", stderr: "" },
          { code: 0, stdout: "before\n", stderr: "" },
          { code: 0, stdout: "Merge made by the ort strategy.\n", stderr: "" },
          { code: 0, stdout: "after\n", stderr: "" },
        ],
        commands,
      ),
    });

    expect(result).toEqual({
      last_status: "updated",
      last_message: "Merged origin/master into feature/test.",
      last_branch: "feature/test",
    });
    expect(commands[4]).toContain("ls-remote --symref origin HEAD");
    expect(commands[6]).toContain(
      `fetch --no-tags --no-write-fetch-head --refmap= origin '${fetchedCommit}'`,
    );
    expect(commands[11]).toContain(
      `-c commit.gpgsign=false merge --no-edit --no-stat '${fetchedCommit}'`,
    );
  });

  test("aborts a conflicting merge", async () => {
    const commands: string[] = [];
    const result = await syncWorkspaceBranch({
      root: "/repo",
      shQuote,
      runProcessWithCodeTimeout: runner(
        [
          { code: 0, stdout: "true\n", stderr: "" },
          { code: 0, stdout: "feature/test\n", stderr: "" },
          { code: 0, stdout: "", stderr: "" },
          { code: 0, stdout: "before\n", stderr: "" },
          { code: 0, stdout: remoteHead, stderr: "" },
          { code: 0, stdout: "", stderr: "" },
          { code: 0, stdout: "", stderr: "" },
          { code: 0, stdout: fetchedCommit, stderr: "" },
          { code: 0, stdout: "feature/test\n", stderr: "" },
          { code: 0, stdout: "", stderr: "" },
          { code: 0, stdout: "before\n", stderr: "" },
          { code: 1, stdout: "", stderr: "CONFLICT (content): conflict\n" },
          { code: 0, stdout: "", stderr: "" },
        ],
        commands,
      ),
    });

    expect(result).toMatchObject({
      last_status: "failed",
      last_message: "CONFLICT (content): conflict",
      last_branch: "feature/test",
    });
    expect(commands.at(-1)).toContain("merge --abort");
  });

  test("reports a workspace that is no longer a Git repository", async () => {
    const result = await syncWorkspaceBranch({
      root: "/repo",
      shQuote,
      runProcessWithCodeTimeout: runner(
        [
          {
            code: 128,
            stdout: "",
            stderr: "fatal: not a git repository\n",
          },
        ],
        [],
      ),
    });

    expect(result).toEqual({
      last_status: "failed",
      last_message: "fatal: not a git repository",
    });
  });

  test("does not merge if the checkout changes during fetch", async () => {
    const commands: string[] = [];
    const result = await syncWorkspaceBranch({
      root: "/repo",
      shQuote,
      runProcessWithCodeTimeout: runner(
        [
          { code: 0, stdout: "true\n", stderr: "" },
          { code: 0, stdout: "feature/test\n", stderr: "" },
          { code: 0, stdout: "", stderr: "" },
          { code: 0, stdout: "before\n", stderr: "" },
          { code: 0, stdout: remoteHead, stderr: "" },
          { code: 0, stdout: "", stderr: "" },
          { code: 0, stdout: "", stderr: "" },
          { code: 0, stdout: fetchedCommit, stderr: "" },
          { code: 0, stdout: "feature/other\n", stderr: "" },
          { code: 0, stdout: "", stderr: "" },
          { code: 0, stdout: "after\n", stderr: "" },
        ],
        commands,
      ),
    });

    expect(result).toEqual({
      last_status: "skipped",
      last_message:
        "Skipped because the workspace changed while origin/master was being fetched.",
      last_branch: "feature/other",
    });
    expect(commands.some((command) => command.includes(" merge "))).toBe(false);
  });
});

test("does not merge when the remote default cannot be determined", async () => {
  const commands: string[] = [];
  const result = await syncWorkspaceBranch({
    root: "/repo",
    shQuote,
    runProcessWithCodeTimeout: runner(
      [
        { code: 0, stdout: "true\n", stderr: "" },
        { code: 0, stdout: "feature/test\n", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "before\n", stderr: "" },
        { code: 128, stdout: "", stderr: "origin unavailable" },
      ],
      commands,
    ),
  });
  expect(result).toEqual({
    last_status: "failed",
    last_message:
      "Unable to determine origin's default branch: origin unavailable",
    last_branch: "feature/test",
  });
  expect(commands).toHaveLength(5);
});

describe("workspace auto-sync lifecycle", () => {
  test("same-path runtimes execute and update only their connection keys", async () => {
    const settings = {
      version: 1 as const,
      repositories: {},
      workspace_auto_sync: {
        "connection:alpha:local:/repo": {
          enabled: true,
          interval_minutes: 1,
          checkout_path: "/repo",
        },
        "connection:beta:local:/repo": {
          enabled: true,
          interval_minutes: 1,
          checkout_path: "/repo",
        },
      },
      custom: {},
    };

    for (const connectionId of ["alpha", "beta"]) {
      let syncCalls = 0;
      const updatedKeys: string[] = [];
      const autoSync = createWorkspaceAutoSync({
        connectionId,
        herdr: {
          call: async () => ({
            workspaces: [{ workspace_id: "same", cwd: "/repo" }],
          }),
        } as any,
        sshHost: () => undefined,
        shQuote,
        runProcessWithCodeTimeout: async () => ({
          code: 0,
          stdout: "",
          stderr: "",
        }),
        invalidateGitStatus: () => undefined,
        resolveWorkspaceGitRoot: async () => ({ root: "/repo" }),
        readSettings: async () => settings,
        updateSettings: async (update) => {
          const updated = await update(settings);
          for (const [key, entry] of Object.entries(
            updated.workspace_auto_sync,
          )) {
            if (entry.last_run_at) updatedKeys.push(key);
          }
          return updated;
        },
        syncBranch: async () => {
          syncCalls += 1;
          return { last_status: "up_to_date" as const };
        },
      });

      autoSync.start();
      await waitUntil(() => updatedKeys.length === 1);
      await autoSync.stop();
      expect(syncCalls).toBe(1);
      expect(updatedKeys).toEqual([`connection:${connectionId}:local:/repo`]);
    }
  });

  test("stop drains an active Git operation without publishing retired results", async () => {
    const syncResult = deferred<{
      last_status: "updated";
      last_message: string;
    }>();
    let syncCalls = 0;
    let updateCalls = 0;
    let invalidations = 0;
    let workspaceCalls = 0;
    const settings = autoSyncSettings();
    const autoSync = createWorkspaceAutoSync({
      herdr: {
        call: async () => {
          workspaceCalls += 1;
          return {
            workspaces: [{ workspace_id: "w1", cwd: "/repo" }],
          };
        },
      } as any,
      sshHost: () => undefined,
      shQuote,
      runProcessWithCodeTimeout: async () => ({
        code: 0,
        stdout: "",
        stderr: "",
      }),
      invalidateGitStatus: () => {
        invalidations += 1;
      },
      resolveWorkspaceGitRoot: async () => ({ root: "/repo" }),
      readSettings: async () => settings,
      updateSettings: async (update) => {
        updateCalls += 1;
        return update(settings);
      },
      syncBranch: async () => {
        syncCalls += 1;
        return syncResult.promise;
      },
    });

    autoSync.start();
    await waitUntil(() => syncCalls === 1);
    autoSync.settingsChanged("local:/repo", true);
    let stopped = false;
    const stop = autoSync.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(0);
    expect(stopped).toBe(false);

    syncResult.resolve({
      last_status: "updated",
      last_message: "updated",
    });
    await stop;
    await Bun.sleep(0);

    expect(autoSync.isRunning("local:/repo")).toBe(false);
    expect(workspaceCalls).toBe(1);
    expect(syncCalls).toBe(1);
    expect(invalidations).toBe(0);
    expect(updateCalls).toBe(0);
  });

  test("stop drains a deferred metadata read and prevents Git work", async () => {
    const workspaceResult = deferred<unknown>();
    let syncCalls = 0;
    let updateCalls = 0;
    const settings = autoSyncSettings();
    const autoSync = createWorkspaceAutoSync({
      herdr: {
        call: () => workspaceResult.promise,
      } as any,
      sshHost: () => undefined,
      shQuote,
      runProcessWithCodeTimeout: async () => ({
        code: 0,
        stdout: "",
        stderr: "",
      }),
      invalidateGitStatus: () => undefined,
      resolveWorkspaceGitRoot: async () => ({ root: "/repo" }),
      readSettings: async () => settings,
      updateSettings: async (update) => {
        updateCalls += 1;
        return update(settings);
      },
      syncBranch: async () => {
        syncCalls += 1;
        return { last_status: "up_to_date" };
      },
    });

    autoSync.start();
    await Bun.sleep(0);
    let stopped = false;
    const firstStop = autoSync.stop().then(() => {
      stopped = true;
    });
    const secondStop = autoSync.stop();
    await Bun.sleep(0);
    expect(stopped).toBe(false);

    workspaceResult.resolve({
      workspaces: [{ workspace_id: "w1", cwd: "/repo" }],
    });
    await Promise.all([firstStop, secondStop]);

    expect(syncCalls).toBe(0);
    expect(updateCalls).toBe(0);
  });
});
