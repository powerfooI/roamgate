import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { GuiSettings } from "../config/gui-settings";
import { shQuote } from "../utils/process-utils";
import {
  createStatusEnricher,
  GIT_STATUS_COLD_BUDGET_MS,
  GIT_STATUS_REFRESH_MS,
  type GitStatusUpdate,
} from "./status";

type Run = {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  reply: PromiseWithResolvers<{ code: number; stdout: string; stderr: string }>;
};

// Most tests use no cold budget so a list never waits on a pending read.
function setup(host?: string, coldBudgetMs = 0) {
  const runs: Run[] = [];
  const pushes: GitStatusUpdate[][] = [];
  const status = createStatusEnricher({
    connectionId: "conn",
    sshHost: () => host,
    shQuote,
    runProcessWithCodeTimeout: (argv, _timeoutMs, options) => {
      const reply = Promise.withResolvers<{
        code: number;
        stdout: string;
        stderr: string;
      }>();
      runs.push({ argv, env: options?.env, reply });
      return reply.promise;
    },
    onGitStatusChanged: (updates) => pushes.push(updates),
    readSettings: async () => ({ repositories: {} }) as unknown as GuiSettings,
    coldBudgetMs,
  });
  return { status, runs, pushes };
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function workspaceList(...paths: string[]) {
  return {
    workspaces: paths.map((path, index) => ({
      workspace_id: `w${index + 1}`,
      worktree: { repo_key: "repo", repo_root: path, checkout_path: path },
    })),
  };
}

async function list(
  status: ReturnType<typeof setup>["status"],
  ...paths: string[]
) {
  const result = (await status.enrichWorkspacesWithGitStatus(
    workspaceList(...paths),
  )) as {
    workspaces: Array<{ worktree: { git_status?: { branch?: string } } }>;
  };
  return result.workspaces.map(
    (workspace) => workspace.worktree.git_status?.branch,
  );
}

function localReply(run: Run, branch: string, dirty = false) {
  run.reply.resolve({
    code: 0,
    stdout: `## ${branch}\n${dirty ? " M file\n" : ""}`,
    stderr: "",
  });
}

function remoteReply(run: Run, branches: string[]) {
  const marker = run.argv.at(-1)?.match(/(__ROAMGATE_GIT_STATUS_\w+__)/)?.[1];
  run.reply.resolve({
    code: 0,
    stdout: branches
      .map(
        (branch, index) =>
          `${marker}BEGIN ${index}\n## ${branch}\n${marker}END ${index} 0\n`,
      )
      .join(""),
    stderr: "",
  });
}

describe("git status stale-while-revalidate", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse("2026-10-09T00:00:00Z") });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test("with no cold budget, the first list answers at once and pushes the result", async () => {
    const { status, runs, pushes } = setup();
    expect(await list(status, "/a")).toEqual([undefined]);
    expect(runs).toHaveLength(1);
    expect(runs[0].argv).toEqual([
      "git",
      "-C",
      "/a",
      "status",
      "--porcelain=v1",
      "--branch",
    ]);
    expect(runs[0].env?.GIT_OPTIONAL_LOCKS).toBe("0");

    localReply(runs[0], "main");
    await status.gitStatusRefreshSettled();
    expect(pushes).toEqual([
      [
        {
          checkout_path: "/a",
          git_status: expect.objectContaining({ branch: "main", dirty: false }),
        },
      ],
    ]);
    expect(await list(status, "/a")).toEqual(["main"]);
    expect(runs).toHaveLength(1);
  });

  test("the first list waits for a first read that lands within the budget", async () => {
    const { status, runs } = setup(undefined, GIT_STATUS_COLD_BUDGET_MS);
    const listing = list(status, "/a");
    await flushMicrotasks();
    localReply(runs[0], "main");
    expect(await listing).toEqual(["main"]);
  });

  test("a slow first read delays only one list, then arrives as a push", async () => {
    const { status, runs, pushes } = setup(
      "desktop",
      GIT_STATUS_COLD_BUDGET_MS,
    );
    const listing = list(status, "/a");
    await flushMicrotasks();
    expect(runs).toHaveLength(1);
    jest.advanceTimersByTime(GIT_STATUS_COLD_BUDGET_MS);
    expect(await listing).toEqual([undefined]);
    // The read is still pending, but this checkout already had its wait.
    expect(await list(status, "/a")).toEqual([undefined]);
    expect(runs).toHaveLength(1);

    remoteReply(runs[0], ["main"]);
    await status.gitStatusRefreshSettled();
    expect(pushes[0][0].git_status.branch).toBe("main");
    expect(await list(status, "/a")).toEqual(["main"]);
  });

  test("stale entries are served while one background refresh runs", async () => {
    const { status, runs, pushes } = setup();
    await list(status, "/a");
    localReply(runs[0], "main");
    await status.gitStatusRefreshSettled();

    jest.advanceTimersByTime(GIT_STATUS_REFRESH_MS);
    expect(await list(status, "/a")).toEqual(["main"]);
    expect(await list(status, "/a")).toEqual(["main"]);
    expect(runs).toHaveLength(2);

    localReply(runs[1], "topic");
    await status.gitStatusRefreshSettled();
    expect(pushes).toHaveLength(2);
    expect(pushes[1][0].git_status.branch).toBe("topic");
    expect(await list(status, "/a")).toEqual(["topic"]);
    expect(runs).toHaveLength(2);
  });

  test("an unchanged refresh pushes nothing", async () => {
    const { status, runs, pushes } = setup();
    await list(status, "/a");
    localReply(runs[0], "main");
    await status.gitStatusRefreshSettled();

    jest.advanceTimersByTime(GIT_STATUS_REFRESH_MS);
    await list(status, "/a");
    localReply(runs[1], "main");
    await status.gitStatusRefreshSettled();
    expect(pushes).toHaveLength(1);
  });

  test("invalidation refreshes immediately, even during a refresh", async () => {
    const { status, runs, pushes } = setup();
    await list(status, "/a");
    localReply(runs[0], "main");
    await status.gitStatusRefreshSettled();

    status.invalidateGitStatus("/a");
    expect(runs).toHaveLength(2);
    // A second git action lands while the first refresh is still reading.
    status.invalidateGitStatus("/a");
    expect(runs).toHaveLength(2);
    localReply(runs[1], "main", true);
    await flushMicrotasks();
    expect(runs).toHaveLength(3);
    localReply(runs[2], "main");
    await status.gitStatusRefreshSettled();

    expect(pushes.map((push) => push[0].git_status.dirty)).toEqual([
      false,
      true,
      false,
    ]);
    expect(await list(status, "/a")).toEqual(["main"]);
    expect(runs).toHaveLength(3);
  });

  test("workspace invalidation maps to its checkout", async () => {
    const { status, runs } = setup();
    await list(status, "/a", "/b");
    localReply(runs[0], "a");
    localReply(runs[1], "b");
    await status.gitStatusRefreshSettled();

    status.invalidateWorkspaceGitStatus("w2");
    expect(runs.slice(2).map((run) => run.argv[2])).toEqual(["/b"]);
    status.invalidateWorkspaceGitStatus("unknown");
    expect(runs).toHaveLength(3);
  });

  test("a transport failure keeps the last known status", async () => {
    const { status, runs, pushes } = setup("desktop");
    await list(status, "/a", "/b");
    expect(runs[0].argv[0]).toBe("ssh");
    expect(runs[0].argv.at(-1)).toStartWith("export GIT_OPTIONAL_LOCKS=0\n");
    remoteReply(runs[0], ["a", "b"]);
    await status.gitStatusRefreshSettled();
    expect(await list(status, "/a", "/b")).toEqual(["a", "b"]);

    jest.advanceTimersByTime(GIT_STATUS_REFRESH_MS);
    await list(status, "/a", "/b");
    runs[1].reply.reject(new Error("ssh timed out after 8000ms"));
    await status.gitStatusRefreshSettled();
    expect(pushes).toHaveLength(1);
    expect(await list(status, "/a", "/b")).toEqual(["a", "b"]);
    // The failed attempt still counts, so polling does not hammer ssh.
    expect(runs).toHaveLength(2);
  });

  test("a transport failure with no previous status reports the error", async () => {
    const { status, runs, pushes } = setup("desktop");
    await list(status, "/a");
    runs[0].reply.resolve({ code: 255, stdout: "", stderr: "unreachable" });
    await status.gitStatusRefreshSettled();
    expect(pushes[0][0].git_status.error).toBe("unreachable");
  });

  test("checkouts that leave the list are forgotten", async () => {
    const { status, runs, pushes } = setup();
    await list(status, "/a");
    // The workspace closes before its first read returns.
    await list(status);
    localReply(runs[0], "main");
    await status.gitStatusRefreshSettled();
    expect(pushes).toEqual([]);
    expect(await list(status, "/a")).toEqual([undefined]);
    expect(runs).toHaveLength(2);
  });

  test("dispose stops reads and drops the one in flight", async () => {
    const { status, runs, pushes } = setup();
    await list(status, "/a");
    status.dispose();
    localReply(runs[0], "main");
    await status.gitStatusRefreshSettled();
    expect(pushes).toEqual([]);

    status.invalidateGitStatus("/a");
    jest.advanceTimersByTime(GIT_STATUS_REFRESH_MS);
    expect(await list(status, "/a")).toEqual([undefined]);
    expect(runs).toHaveLength(1);
  });
});
