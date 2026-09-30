import { expect, test } from "bun:test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import { PREVIEW_MAX_BYTES } from "./file-constants";
import {
  listCommits,
  readCommit,
  readCommitFile,
  readCommitPreview,
} from "./git-history";

async function git(root: string, ...args: string[]) {
  const result = await runProcessWithCodeTimeout(
    ["git", "-C", root, ...args],
    5000,
  );
  if (result.code) throw new Error(result.stderr);
  return result.stdout.trim();
}

test("commit history reads root, rename and deleted content from revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "roamgate-commits-"));
  const context = { root, shQuote, runProcessWithCodeTimeout };
  try {
    await git(root, "init");
    await git(root, "config", "user.name", "Test User");
    await git(root, "config", "user.email", "test@example.com");
    expect((await listCommits(context, {})).commits).toEqual([]);

    await writeFile(join(root, "original.txt"), "original\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "First commit", "-m", "Body line");
    const first = await git(root, "rev-parse", "HEAD");
    const rootDetail = await readCommit(context, first);
    expect(rootDetail).toMatchObject({
      base: null,
      parents: [],
      message: "First commit\n\nBody line",
    });
    expect(rootDetail.entries).toMatchObject([
      { path: "original.txt", status: "added", additions: 1, deletions: 0 },
    ]);
    expect(
      (
        await readCommitFile(context, {
          sha: first,
          base: null,
          path: "original.txt",
        })
      ).diff,
    ).toContain("+original");

    await rename(join(root, "original.txt"), join(root, "renamed.txt"));
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "Rename file");
    const second = await git(root, "rev-parse", "HEAD");
    const renamed = await readCommit(context, second);
    expect(renamed.entries).toMatchObject([
      { path: "renamed.txt", old_path: "original.txt", status: "renamed" },
    ]);

    await git(root, "rm", "renamed.txt");
    await git(root, "commit", "-m", "Delete file");
    const third = await git(root, "rev-parse", "HEAD");
    const deleted = await readCommit(context, third);
    expect(deleted.entries).toMatchObject([
      { path: "renamed.txt", status: "deleted", deletions: 1 },
    ]);
    await writeFile(join(root, "renamed.txt"), "uncommitted\n");
    expect(
      (await readCommitPreview(context, { sha: second, path: "renamed.txt" }))
        .text,
    ).toBe("original\n");
    expect(
      (await readCommitPreview(context, { sha: first, path: "original.txt" }))
        .text,
    ).toBe("original\n");
    const page = await listCommits(context, {});
    expect(page.commits.map((commit) => commit.sha)).toEqual([
      third,
      second,
      first,
    ]);
    expect(page.has_more).toBe(false);
    await expect(
      readCommitFile(context, { sha: "HEAD", base: null, path: "x" }),
    ).rejects.toThrow("invalid commit id");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merge changes compare with the first parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "roamgate-merge-"));
  const context = { root, shQuote, runProcessWithCodeTimeout };
  try {
    await git(root, "init");
    await git(root, "config", "user.name", "Test User");
    await git(root, "config", "user.email", "test@example.com");
    await writeFile(join(root, "base.txt"), "base\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "Base");
    const branch = await git(root, "branch", "--show-current");
    await git(root, "checkout", "-b", "feature");
    await writeFile(join(root, "feature.txt"), "feature\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "Feature");
    await git(root, "checkout", branch);
    await writeFile(join(root, "main.txt"), "main\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "Main");
    const firstParent = await git(root, "rev-parse", "HEAD");
    await git(root, "merge", "--no-ff", "feature", "-m", "Merge feature");
    const merge = await readCommit(
      context,
      await git(root, "rev-parse", "HEAD"),
    );
    expect(merge.parents).toHaveLength(2);
    expect(merge.base).toBe(firstParent);
    expect(merge.entries.map((entry) => entry.path)).toEqual(["feature.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("history pages remain anchored and shallow boundaries are explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "roamgate-history-pages-"));
  const clone = await mkdtemp(join(tmpdir(), "roamgate-history-shallow-"));
  const context = { root, shQuote, runProcessWithCodeTimeout };
  try {
    await git(root, "init");
    await git(root, "config", "user.name", "Test User");
    await git(root, "config", "user.email", "test@example.com");
    for (let index = 0; index < 32; index++) {
      await writeFile(join(root, "file.txt"), `${index}\n`);
      await git(root, "add", ".");
      await git(root, "commit", "-m", `Commit ${index}`);
    }
    const first = await listCommits(context, {});
    expect(first.commits).toHaveLength(30);
    expect(first.has_more).toBe(true);
    await writeFile(join(root, "file.txt"), "new head\n");
    await git(root, "commit", "-am", "New head");
    const second = await listCommits(context, { head: first.head, offset: 30 });
    expect(second.commits.map((commit) => commit.subject)).toEqual([
      "Commit 1",
      "Commit 0",
    ]);
    expect(second.has_more).toBe(false);

    await git(root, "clone", "--depth=1", `file://${root}`, clone);
    const shallow = await listCommits({ ...context, root: clone }, {});
    expect(shallow.shallow).toBe(true);
    expect(shallow.commits).toHaveLength(1);
    const boundary = await readCommit(
      { ...context, root: clone },
      shallow.commits[0]!.sha,
    );
    expect(boundary.shallow_boundary).toBe(true);
    expect(boundary.entries).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(clone, { recursive: true, force: true });
  }
});

test("binary files and oversized historical previews are bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "roamgate-history-binary-"));
  const context = { root, shQuote, runProcessWithCodeTimeout };
  try {
    await git(root, "init");
    await git(root, "config", "user.name", "Test User");
    await git(root, "config", "user.email", "test@example.com");
    await writeFile(join(root, "data.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, "large.txt"), "x".repeat(PREVIEW_MAX_BYTES + 1));
    await git(root, "add", ".");
    await git(root, "commit", "-m", "Add assets");
    const sha = await git(root, "rev-parse", "HEAD");
    const detail = await readCommit(context, sha);
    const binary = detail.entries.find((entry) => entry.path === "data.bin");
    expect(binary).toMatchObject({ binary: true });
    expect(binary?.additions).toBeUndefined();
    expect(binary?.deletions).toBeUndefined();
    expect(
      await readCommitPreview(context, { sha, path: "data.bin" }),
    ).toMatchObject({ binary: true, text: null, truncated: false });
    expect(
      await readCommitPreview(context, { sha, path: "large.txt" }),
    ).toMatchObject({ text: null, truncated: true });
    expect(
      (await readCommitFile(context, { sha, base: null, path: "large.txt" }))
        .truncated,
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
