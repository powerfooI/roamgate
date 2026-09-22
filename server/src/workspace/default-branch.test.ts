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
    "HEAD",
    "head",
    "HEAD/topic",
    "head/topic",
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
        // A narrow fetch configuration must not constrain the default commit.
        await git(
          "-C",
          root,
          "config",
          "remote.origin.fetch",
          "+refs/heads/main:refs/remotes/origin/main",
        );
        const trackingRefs = await git(
          "-C",
          root,
          "show-ref",
          "--verify",
          "refs/remotes/origin/main",
        );
        const fetchHeadPath = join(root, ".git", "FETCH_HEAD");
        const fetchHead = `${before}\t\tbranch 'unrelated' of test\n`;
        await writeFile(fetchHeadPath, fetchHead);
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
        expect(
          await git(
            "-C",
            root,
            "show-ref",
            "--verify",
            "refs/remotes/origin/main",
          ),
        ).toBe(trackingRefs);
        expect(await readFile(fetchHeadPath, "utf8")).toBe(fetchHead);
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
          base.commit,
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
        expect(
          await git(
            "-C",
            root,
            "show-ref",
            "--verify",
            "refs/remotes/origin/main",
          ),
        ).toBe(trackingRefs);
        expect(await readFile(fetchHeadPath, "utf8")).toBe(fetchHead);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test.each([
    ["foo", "foo/bar"],
    ["foo/bar", "foo"],
  ])(
    "supports a prefix-related default rename from %s to %s",
    async (from, to) => {
      const directory = await mkdtemp(
        join(tmpdir(), "roamgate-default-rename-"),
      );
      try {
        const seed = join(directory, "seed");
        const remote = join(directory, "remote.git");
        const root = join(directory, "checkout");
        await git("init", `--initial-branch=${from}`, seed);
        const original = await commit(seed, "initial");
        await git("clone", "--bare", seed, remote);
        await git("clone", remote, root);
        await git("-C", root, "checkout", "-b", "feature/test");
        await git("-C", root, "config", "fetch.prune", "true");
        const next = await commit(seed, "renamed default");
        await git("-C", remote, "symbolic-ref", "HEAD", `refs/heads/${to}`);
        await git("-C", remote, "update-ref", "-d", `refs/heads/${from}`);
        await git("-C", seed, "push", remote, `${next}:refs/heads/${to}`);

        const base = await syncWorktreeBase({
          workspaceId: "w1",
          resolveGitRoot: async () => ({ root }),
          shQuote,
          runProcessWithCodeTimeout,
        });
        expect(base.base).toBe(`origin/${to}`);
        expect(base.commit).toBe(next);
        await git(
          "-C",
          root,
          "worktree",
          "add",
          "-b",
          "created",
          join(directory, "created"),
          base.commit,
        );
        expect(
          await git("-C", join(directory, "created"), "rev-parse", "HEAD"),
        ).toBe(next);
        const sync = await syncWorkspaceBranch({
          root,
          shQuote,
          runProcessWithCodeTimeout,
        });
        expect(sync.last_status).toBe("updated");
        expect(await git("-C", root, "rev-parse", "HEAD")).toBe(next);
        expect(
          await git("-C", root, "rev-parse", `refs/remotes/origin/${from}`),
        ).toBe(original);
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
