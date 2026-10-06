import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import { syncWorkspaceBranch } from "./auto-sync";
import { collectWorktreeFingerprints, runGitFileAction } from "./git-actions";
import { readDiffFile, readDiffSummary } from "./git-diff";
import {
  listCommits,
  readCommit,
  readCommitFile,
  readCommitPreview,
} from "./git-history";
import { gitShellCommandArgv } from "./git-shell";
import type { RunProcessWithCodeTimeout } from "./file-types";

test.each(["local", "SSH"])(
  "Git features preserve quoted paths and shell routing (%s)",
  async (connection) => {
    const host = connection === "SSH" ? "git-test.example" : undefined;
    const root = await mkdtemp(join(tmpdir(), "roamgate git's shell-"));
    const path = "file $(touch injected) 'quoted' & name.txt";
    const untracked = "remove $(touch injected) 'quoted'.txt";
    let shellCalls = 0;
    const runner: RunProcessWithCodeTimeout = async (argv, timeout) => {
      const script = argv.at(-1)!;
      expect(argv).toEqual(gitShellCommandArgv(script, host));
      shellCalls += 1;
      // Assert SSH argv without needing an SSH server, then execute the exact
      // remote script locally. Local runs use the platform's real shell choice.
      return runProcessWithCodeTimeout(gitShellCommandArgv(script), timeout);
    };
    const context = { root, host, shQuote, runProcessWithCodeTimeout: runner };
    const diffContext = { ...context, workspaceId: "shell-test" };
    const git = async (...args: string[]) => {
      const result = await runProcessWithCodeTimeout(
        ["git", "-C", root, ...args],
        5000,
      );
      if (result.code) throw new Error(result.stderr);
      return result.stdout.trim();
    };

    try {
      await git("init", "-b", "main");
      await git("config", "user.name", "Shell Test");
      await git("config", "user.email", "shell@example.com");
      await writeFile(join(root, path), "original\n");
      await git("add", ".");
      await git("commit", "-m", "Quoted file");
      const history = await listCommits(context, {});
      const sha = history.head!;
      expect(history.commits[0]?.subject).toBe("Quoted file");
      expect((await readCommit(context, sha)).entries).toMatchObject([
        { path },
      ]);
      expect((await readCommitPreview(context, { sha, path })).text).toBe(
        "original\n",
      );
      expect(
        (await readCommitFile(context, { sha, path, base: null })).diff,
      ).toContain("+original");

      await writeFile(join(root, path), "changed\n");
      const summary = await readDiffSummary({
        ...diffContext,
        workspace: {},
        params: {},
      });
      expect(summary.entries).toMatchObject([
        { path, kind: "unstaged", size: 8 },
      ]);
      expect(
        (
          await readDiffFile({
            ...diffContext,
            params: { path, kind: "unstaged" },
          })
        ).diff,
      ).toContain("+changed");
      await runGitFileAction({ context, params: { action: "stage", path } });
      expect(await git("diff", "--cached", "--name-only")).toBe(path);
      await runGitFileAction({ context, params: { action: "unstage", path } });
      expect(await git("diff", "--cached", "--name-only")).toBe("");

      await writeFile(join(root, untracked), "temporary\n");
      const fingerprint = (
        await collectWorktreeFingerprints(context, [untracked])
      ).get(untracked);
      expect(fingerprint?.size).toBe(10);
      await runGitFileAction({
        context,
        params: { action: "delete_untracked", path: untracked, ...fingerprint },
      });
      expect((await readdir(root)).sort()).toEqual([".git", path]);
      expect(await syncWorkspaceBranch(context)).toMatchObject({
        last_status: "skipped",
      });
      expect(shellCalls).toBeGreaterThan(20);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
