import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import { syncWorktreeBase } from "../worktree/create";
import { syncWorkspaceBranch } from "./auto-sync";

async function git(...args: string[]) {
  const result = await runProcessWithCodeTimeout(["git", ...args], 10_000);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function commit(root: string, message: string) {
  await git(
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    message,
  );
  return git("-C", root, "rev-parse", "HEAD");
}

describe("origin default branch with real Git", () => {
  test.each([
    "main",
    "master",
    "release/next",
    "head-topic",
    "release/quote'$(printf${IFS}x)&`printf${IFS}y`",
  ])(
    "creates and syncs from %s, ignoring stale origin/HEAD",
    async (branch) => {
      const directory = await mkdtemp(
        join(tmpdir(), "roamgate-default-branch-"),
      );
      try {
        const seed = join(directory, "seed");
        const remote = join(directory, "remote.git");
        const root = join(directory, "checkout with spaces");
        await git("init", "--initial-branch=main", seed);
        const before = await commit(seed, "initial");
        await git("clone", "--bare", seed, remote);
        await git("clone", remote, root);
        await git("-C", root, "checkout", "-b", "feature/test");
        if (branch !== "main") await git("-C", seed, "checkout", "-b", branch);
        const expectedCommit = await commit(seed, "default branch update");
        await git("-C", seed, "push", remote, `HEAD:refs/heads/${branch}`);
        await git("-C", remote, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
        // Keep a stale local default and a stale main branch on the remote.
        expect(
          await git(
            "-C",
            root,
            "symbolic-ref",
            "--short",
            "refs/remotes/origin/HEAD",
          ),
        ).toBe("origin/main");
        // Exercise explicit fetch destinations with a narrow fetch configuration.
        await git(
          "-C",
          root,
          "config",
          "remote.origin.fetch",
          "+refs/heads/main:refs/remotes/origin/main",
        );
        const dirty = join(root, "uncommitted.txt");
        await writeFile(dirty, "keep me");
        const status = await git("-C", root, "status", "--porcelain");
        const base = await syncWorktreeBase({
          workspaceId: "w1",
          resolveGitRoot: async () => ({ root }),
          shQuote,
          runProcessWithCodeTimeout,
        });
        expect(base.base).toBe(`origin/${branch}`);
        expect(base.commit).toBe(expectedCommit);
        expect(await git("-C", root, "rev-parse", "HEAD")).toBe(before);
        expect(await git("-C", root, "status", "--porcelain")).toBe(status);
        expect(await readFile(dirty, "utf8")).toBe("keep me");
        await git(
          "-C",
          root,
          "worktree",
          "add",
          "-b",
          "created",
          join(directory, "created"),
          base.base,
        );
        expect(
          await git("-C", directory + "/created", "rev-parse", "HEAD"),
        ).toBe(expectedCommit);
        await unlink(dirty);
        const sync = await syncWorkspaceBranch({
          root,
          shQuote,
          runProcessWithCodeTimeout,
        });
        expect(sync).toMatchObject({
          last_status: "updated",
          last_message: `Merged origin/${branch} into feature/test.`,
        });
        expect(await git("-C", root, "rev-parse", "HEAD")).toBe(expectedCommit);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test.each(["HEAD", "head", "Head", "HEAD/topic", "head/topic", "Head/topic"])(
    "rejects a default named %s without overwriting tracking refs",
    async (branch) => {
      const directory = await mkdtemp(join(tmpdir(), "roamgate-default-head-"));
      try {
        const seed = join(directory, "seed");
        const remote = join(directory, "remote.git");
        const root = join(directory, "checkout");
        await git("init", "--initial-branch=main", seed);
        const original = await commit(seed, "initial");
        await git("clone", "--bare", seed, remote);
        await git("clone", remote, root);
        const next = await commit(seed, "different default branch");
        await git("-C", seed, "push", remote, `${next}:refs/heads/${branch}`);
        await git("-C", remote, "symbolic-ref", "HEAD", `refs/heads/${branch}`);

        await expect(
          syncWorktreeBase({
            workspaceId: "w1",
            resolveGitRoot: async () => ({ root }),
            shQuote,
            runProcessWithCodeTimeout,
          }),
        ).rejects.toThrow("origin/HEAD is reserved");
        expect(
          await git("-C", root, "rev-parse", "refs/remotes/origin/main"),
        ).toBe(original);

        const sync = await syncWorkspaceBranch({
          root,
          shQuote,
          runProcessWithCodeTimeout,
        });
        expect(sync.last_status).toBe("failed");
        expect(sync.last_message).toContain("origin/HEAD is reserved");
        expect(
          await git("-C", root, "rev-parse", "refs/remotes/origin/main"),
        ).toBe(original);
        expect(await git("-C", root, "rev-parse", "HEAD")).toBe(original);
        expect(
          await git("-C", root, "symbolic-ref", "refs/remotes/origin/HEAD"),
        ).toBe("refs/remotes/origin/main");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test("supports a master-only remote", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roamgate-master-only-"));
    try {
      const seed = join(directory, "seed");
      const remote = join(directory, "remote.git");
      const root = join(directory, "checkout");
      await git("init", "--initial-branch=master", seed);
      const expectedCommit = await commit(seed, "initial");
      await git("clone", "--bare", seed, remote);
      await git("clone", remote, root);
      const base = await syncWorktreeBase({
        workspaceId: "w1",
        resolveGitRoot: async () => ({ root }),
        shQuote,
        runProcessWithCodeTimeout,
      });
      expect(base.base).toBe("origin/master");
      expect(base.commit).toBe(expectedCommit);
      const sync = await syncWorkspaceBranch({
        root,
        shQuote,
        runProcessWithCodeTimeout,
      });
      expect(sync.last_status).toBe("up_to_date");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
