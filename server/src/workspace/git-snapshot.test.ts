import { describe, expect, jest, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import type { RunProcessWithCodeTimeout } from "./file-types";
import { snapshotWorktreeTree } from "./git-diff";

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "roamgate-snapshot-safety-"));
  await git(root, "init");
  await git(root, "config", "core.bigFileThreshold", "1");
  return root;
}

async function git(root: string, ...args: string[]) {
  const result = await runProcessWithCodeTimeout(
    ["git", "-C", root, ...args],
    5000,
  );
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function capture(root: string, run = runProcessWithCodeTimeout) {
  return snapshotWorktreeTree({
    root,
    shQuote,
    runProcessWithCodeTimeout: run,
  });
}

function instrument(
  transform: (script: string) => string,
): RunProcessWithCodeTimeout {
  return (argv, timeout) =>
    runProcessWithCodeTimeout(
      [...argv.slice(0, -1), transform(argv.at(-1)!)],
      timeout,
    );
}

const tinyBudgets = instrument((script) =>
  script
    .replaceAll("8388609", "33")
    .replaceAll("8388608", "32")
    .replaceAll("33554432", "64"),
);

async function objectFiles(root: string) {
  const objects = join(root, ".git", "objects");
  return (await readdir(objects, { recursive: true })).sort();
}

async function objectState(root: string) {
  return Promise.all(
    ["", ...(await objectFiles(root))].map(async (path) => {
      const file = join(root, ".git", "objects", path);
      const info = await stat(file);
      return {
        path,
        mode: info.mode,
        contents: info.isFile() ? await readFile(file) : null,
      };
    }),
  );
}

const quarantine = (root: string) =>
  join(root, ".git", "roamgate-last-step-capture");

describe("bounded worktree snapshot transaction", () => {
  test.each([".repo", ".repo [meta] 'quote"])(
    "excludes an in-worktree Git directory %s without excluding neighboring files",
    async (name) => {
      const root = await repository();
      const gitDir = join(root, name);
      try {
        await git(root, "init", `--separate-git-dir=${gitDir}`);
        await writeFile(join(root, "tracked"), "staged\n");
        await git(root, "add", "tracked");
        await git(
          root,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "initial",
        );
        await writeFile(join(root, "tracked"), "changed\n");
        await writeFile(join(root, "untracked"), "new\n");
        const neighbor = `${name}-content`;
        await mkdir(join(root, neighbor));
        await writeFile(join(root, neighbor, "file"), "keep\n");
        const index = await readFile(join(gitDir, "index"));
        const first = await capture(root);
        expect(
          (await git(root, "ls-tree", "-rz", "--name-only", first))
            .split("\0")
            .filter(Boolean)
            .sort(),
        ).toEqual([`${neighbor}/file`, "tracked", "untracked"].sort());
        const objects = await readdir(join(gitDir, "objects"), {
          recursive: true,
        });
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(await capture(root)).toBe(first);
          expect(
            (
              await readdir(join(gitDir, "objects"), { recursive: true })
            ).sort(),
          ).toEqual(objects.toSorted());
        }
        expect(await readFile(join(gitDir, "index"))).toEqual(index);
        expect(await readdir(gitDir)).not.toContain(
          "roamgate-last-step-capture",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("refuses shared or ambiguous repository modes without changing objects, permissions, or staging", async () => {
    const root = await repository();
    try {
      await git(root, "init", "--shared=group");
      await writeFile(join(root, "staged"), "staged\n");
      await git(root, "add", "staged");
      await writeFile(join(root, "untracked"), "new snapshot content\n");
      const index = await readFile(join(root, ".git", "index"));
      const objects = await objectState(root);
      for (const mode of ["group", "all", "0660", "true", "unknown", ""]) {
        await git(
          root,
          "-c",
          "core.sharedRepository=0",
          "config",
          "core.sharedRepository",
          mode,
        );
        await expect(capture(root)).rejects.toThrow("shared repositories");
        expect(await objectState(root)).toEqual(objects);
        expect(await readFile(join(root, ".git", "index"))).toEqual(index);
        expect(await readdir(join(root, ".git"))).not.toContain(
          "roamgate-last-step-capture",
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses effective shared-repository configuration from included files", async () => {
    const root = await repository();
    try {
      await writeFile(join(root, "staged"), "staged\n");
      await git(root, "add", "staged");
      await writeFile(join(root, "untracked"), "new snapshot content\n");
      await writeFile(
        join(root, ".git", "shared-config"),
        "[core]\nsharedRepository = group\n",
      );
      await git(root, "config", "include.path", "shared-config");
      const index = await readFile(join(root, ".git", "index"));
      const objects = await objectState(root);
      await expect(capture(root)).rejects.toThrow("shared repositories");
      expect(await objectState(root)).toEqual(objects);
      expect(await readFile(join(root, ".git", "index"))).toEqual(index);
      expect(await readdir(join(root, ".git"))).not.toContain(
        "roamgate-last-step-capture",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("permits default and explicit non-shared repository modes", async () => {
    const root = await repository();
    try {
      await writeFile(join(root, "file"), "small");
      const tree = await capture(root);
      for (const mode of ["false", "0", "umask", "FALSE"]) {
        await git(root, "config", "core.sharedRepository", mode);
        expect(await capture(root)).toBe(tree);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("repeated unreadable captures leave no objects or packs and preserve staging", async () => {
    const root = await repository();
    try {
      await writeFile(join(root, "staged"), "staged\n");
      await git(root, "add", "staged");
      const index = await readFile(join(root, ".git", "index"));
      const objects = await objectFiles(root);
      const packs = await readdir(join(root, ".git", "objects", "pack"));
      await writeFile(join(root, "1-binary"), randomBytes(24));
      await writeFile(join(root, "2-unreadable"), "unreadable\n");
      await chmod(join(root, "2-unreadable"), 0);
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(capture(root)).rejects.toThrow(/unreadable|cannot read/);
        expect(await objectFiles(root)).toEqual(objects);
        expect(await readFile(join(root, ".git", "index"))).toEqual(index);
        expect(await readdir(join(root, ".git"))).not.toContain(
          "roamgate-last-step-capture",
        );
      }
      await chmod(join(root, "2-unreadable"), 0o600);
      const first = await capture(root);
      const published = await objectFiles(root);
      expect(await capture(root)).toBe(first);
      expect(await objectFiles(root)).toEqual(published);
      expect(await readFile(join(root, ".git", "index"))).toEqual(index);
      expect(await readdir(join(root, ".git", "objects", "pack"))).toEqual(
        packs,
      );
    } finally {
      await chmod(join(root, "2-unreadable"), 0o600).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  test("caps actual file and aggregate bytes including tracked modifications", async () => {
    const root = await repository();
    try {
      await writeFile(join(root, "tracked"), "before");
      await git(root, "add", "tracked");
      const before = await objectFiles(root);
      await writeFile(join(root, "tracked"), "x".repeat(33));
      await expect(capture(root, tinyBudgets)).rejects.toThrow("file exceeds");
      await writeFile(join(root, "tracked"), "x".repeat(32));
      await writeFile(join(root, "other"), "y".repeat(32));
      await writeFile(join(root, "third"), "z");
      await expect(capture(root, tinyBudgets)).rejects.toThrow(
        "worktree exceeds",
      );
      expect(await objectFiles(root)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses applicable filters without executing them, but permits unused filter config", async () => {
    const root = await repository();
    try {
      const marker = join(root, "filter-ran");
      await git(
        root,
        "config",
        "filter.expand.clean",
        `touch ${shQuote(marker)}; cat`,
      );
      await writeFile(join(root, "file"), "small");
      await capture(root);
      const before = await objectFiles(root);
      await writeFile(join(root, ".gitattributes"), "file filter=expand\n");
      await expect(capture(root)).rejects.toThrow("Git filter attributes");
      expect(await readdir(root)).not.toContain("filter-ran");
      expect(await objectFiles(root)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("captures raw CRLF bytes and executable files with shell-special names", async () => {
    const root = await repository();
    try {
      await git(root, "config", "core.autocrlf", "true");
      const path = "- quote'\" back\\slash.txt";
      await writeFile(join(root, path), "raw\r\nbytes\r\n");
      await chmod(join(root, path), 0o755);
      const tree = await capture(root);
      expect(await git(root, "ls-tree", tree)).toContain("100755");
      const result = await runProcessWithCodeTimeout(
        ["git", "-C", root, "show", `${tree}:${path}`],
        5000,
      );
      expect(result.stdout).toBe("raw\r\nbytes\r\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses symlinks and control-character paths rather than omitting them", async () => {
    const root = await repository();
    try {
      await symlink("missing", join(root, "link"));
      await expect(capture(root)).rejects.toThrow("symlink");
      await rm(join(root, "link"));
      for (const path of ["line\nbreak", "tab\tname"]) {
        await writeFile(join(root, path), "small");
        await expect(capture(root)).rejects.toThrow("newline/tab");
        await rm(join(root, path));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("pins files without dereferencing a raced final symlink", async () => {
    const root = await repository();
    try {
      await writeFile(join(root, "file"), "small");
      const runner = instrument((script) =>
        script.replace(
          '    ln -P "$file"',
          '    rm "$file"; ln -s /etc/passwd "$file"\n    ln -P "$file"',
        ),
      );
      const before = await objectFiles(root);
      await expect(capture(root, runner)).rejects.toThrow("file changed type");
      expect(await objectFiles(root)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not publish a file that grows after enumeration", async () => {
    const root = await repository();
    try {
      await writeFile(join(root, "file"), "small");
      const runner: RunProcessWithCodeTimeout = (argv, timeout) =>
        tinyBudgets(
          [
            ...argv.slice(0, -1),
            argv
              .at(-1)!
              .replace(
                '    ln -P "$file"',
                '    printf "%040d" 0 >> "$file"\n    ln -P "$file"',
              ),
          ],
          timeout,
        );
      const before = await objectFiles(root);
      await expect(capture(root, runner)).rejects.toThrow("file exceeds");
      expect(await objectFiles(root)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a raced ancestor symlink cannot redirect capture", async () => {
    const root = await repository();
    const outside = await mkdtemp(join(tmpdir(), "roamgate-snapshot-outside-"));
    try {
      await mkdir(join(root, "directory"));
      await writeFile(join(root, "directory", "file"), "inside");
      await writeFile(join(outside, "file"), "outside secret");
      const runner = instrument((script) =>
        script.replace(
          '    cd -P "$expected"',
          `    mv "$snapshot_root/directory" "$snapshot_root/original"; ln -s ${shQuote(outside)} "$snapshot_root/directory"\n    cd -P "$expected"`,
        ),
      );
      const before = await objectFiles(root);
      await expect(capture(root, runner)).rejects.toThrow("symlink ancestor");
      expect(await objectFiles(root)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("captures submodules through staging, deinitialization, and index-only removal", async () => {
    const root = await repository();
    const source = await repository();
    try {
      for (const repo of [root, source]) {
        await git(repo, "config", "user.name", "Test");
        await git(repo, "config", "user.email", "test@example.com");
        await git(repo, "commit", "--allow-empty", "-m", "initial");
      }
      const baseline = await capture(root);
      await git(
        root,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        source,
        "module",
      );
      const index = await readFile(join(root, ".git", "index"));
      const tree = await capture(root);
      expect(await git(root, "ls-tree", tree, "module")).toBe(
        `160000 commit ${await git(source, "rev-parse", "HEAD")}\tmodule`,
      );
      expect(await git(root, "diff", "--name-only", baseline, tree)).toBe(
        ".gitmodules\nmodule",
      );
      expect(await readFile(join(root, ".git", "index"))).toEqual(index);

      await git(root, "commit", "-m", "add module");
      await git(root, "submodule", "deinit", "-f", "module");
      const deinitializedIndex = await readFile(join(root, ".git", "index"));
      expect(await capture(root)).toBe(tree);
      expect(await readFile(join(root, ".git", "index"))).toEqual(
        deinitializedIndex,
      );

      await git(
        root,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "update",
        "--init",
        "module",
      );
      await git(root, "rm", "--cached", "module");
      expect(await git(root, "ls-files", "--stage", "--", "module")).toBe("");
      const removedIndex = await readFile(join(root, ".git", "index"));
      expect(await capture(root)).toBe(tree);
      expect(await readFile(join(root, ".git", "index"))).toEqual(removedIndex);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  });

  test.each(["regular", "sparse", "split"])(
    "preserves absent sparse-checkout entries with a %s index",
    async (mode) => {
      const root = await repository();
      try {
        await git(root, "config", "user.name", "Test");
        await git(root, "config", "user.email", "test@example.com");
        for (const directory of ["included", "excluded"]) {
          await mkdir(join(root, directory));
          await writeFile(join(root, directory, "file"), "initial\n");
        }
        await git(root, "add", ".");
        await git(root, "commit", "-m", "initial");
        await git(
          root,
          "sparse-checkout",
          "set",
          "--cone",
          mode === "sparse" ? "--sparse-index" : "--no-sparse-index",
          "included",
        );
        if (mode === "split") await git(root, "update-index", "--split-index");
        expect(await readdir(root)).not.toContain("excluded");
        const index = await readFile(join(root, ".git", "index"));
        const baseline = await capture(root);
        expect(await git(root, "show", `${baseline}:excluded/file`)).toBe(
          "initial",
        );
        expect(await readFile(join(root, ".git", "index"))).toEqual(index);

        await git(root, "sparse-checkout", "set", "included", "excluded");
        expect(await capture(root)).toBe(baseline);
        await writeFile(join(root, "excluded", "file"), "committed change\n");
        await git(root, "add", "excluded/file");
        await git(root, "commit", "-m", "change excluded file");
        await git(root, "sparse-checkout", "set", "included");
        expect(await readdir(root)).not.toContain("excluded");
        const changedIndex = await readFile(join(root, ".git", "index"));
        const current = await capture(root);
        expect(await git(root, "show", `${current}:excluded/file`)).toBe(
          "committed change",
        );
        expect(await git(root, "diff", "--name-only", baseline, current)).toBe(
          "excluded/file",
        );
        expect(await readFile(join(root, ".git", "index"))).toEqual(
          changedIndex,
        );

        await rm(join(root, "included", "file"));
        const deleted = await capture(root);
        expect(await git(root, "ls-tree", "-r", "--name-only", deleted)).toBe(
          "excluded/file",
        );
        expect(await readFile(join(root, ".git", "index"))).toEqual(
          changedIndex,
        );

        // A manually materialized sparse file must override its indexed blob.
        await mkdir(join(root, "excluded"));
        await writeFile(join(root, "excluded", "file"), "materialized edit\n");
        const materialized = await capture(root);
        expect(await git(root, "show", `${materialized}:excluded/file`)).toBe(
          "materialized edit",
        );
        expect(await readFile(join(root, ".git", "index"))).toEqual(
          changedIndex,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("captures current gitlinks and their deletion", async () => {
    const root = await repository();
    try {
      const child = join(root, "module");
      await mkdir(child);
      await git(child, "init");
      const objects = await objectFiles(root);
      await expect(capture(root)).rejects.toThrow();
      expect(await objectFiles(root)).toEqual(objects);
      await git(
        child,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "first",
      );
      const first = await git(child, "rev-parse", "HEAD");
      const untracked = await capture(root);
      expect(await git(root, "ls-tree", untracked)).toBe(
        `160000 commit ${first}\tmodule`,
      );
      await git(
        root,
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${first},module`,
      );
      await git(
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "module",
      );
      await git(
        child,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "second",
      );
      const current = await git(child, "rev-parse", "HEAD");
      const tree = await capture(root);
      expect(await git(root, "ls-tree", tree)).toBe(
        `160000 commit ${current}\tmodule`,
      );
      await rm(child, { recursive: true });
      const deleted = await capture(root);
      expect(await git(root, "ls-tree", deleted)).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unsignaled SSH transport failure may finish with complete deduplicated objects", async () => {
    const root = await repository();
    let remote: ReturnType<typeof runProcessWithCodeTimeout> | undefined;
    try {
      await writeFile(join(root, "file"), "small");
      await expect(
        snapshotWorktreeTree({
          root,
          host: "simulated-host",
          shQuote,
          runProcessWithCodeTimeout: async (argv) => {
            expect(argv[0]).toBe("ssh");
            remote = runProcessWithCodeTimeout(
              ["sh", "-lc", argv.at(-1)!],
              5000,
            );
            throw new Error("simulated SSH disconnect without remote signal");
          },
        }),
      ).rejects.toThrow("simulated SSH disconnect");
      const completed = await remote!;
      expect(completed.code).toBe(0);
      expect(completed.stdout.trim()).toMatch(/^[0-9a-f]{40,64}$/);
      const objects = await objectFiles(root);
      expect(await capture(root)).toBe(completed.stdout.trim());
      expect(await objectFiles(root)).toEqual(objects);
      expect(await readdir(join(root, ".git", "objects", "pack"))).toEqual([]);
    } finally {
      await remote;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cleans only its quarantine on failure after object creation", async () => {
    const root = await repository();
    try {
      await writeFile(join(root, "file"), randomBytes(24));
      const before = await objectFiles(root);
      const runner = instrument((script) =>
        script.replace(
          "tree=$(git write-tree)",
          "tree=$(git write-tree)\nexit 1",
        ),
      );
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(capture(root, runner)).rejects.toThrow();
        expect(await objectFiles(root)).toEqual(before);
        expect(await readdir(join(root, ".git"))).not.toContain(
          "roamgate-last-step-capture",
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("interrupted publication leaves only complete objects without missing tree children", async () => {
    const root = await repository();
    try {
      await mkdir(join(root, "nested"));
      await writeFile(join(root, "nested", "file"), "small");
      const runner = instrument((script) =>
        script.replace("  done\n}\nif [ -f", "    exit 1\n  done\n}\nif [ -f"),
      );
      await expect(capture(root, runner)).rejects.toThrow();
      await git(root, "fsck", "--full");
      await capture(root);
      await git(root, "fsck", "--full");
      expect(await readdir(join(root, ".git", "objects", "pack"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses an existing ownership directory and permits explicit recovery after quiescence", async () => {
    const root = await repository();
    try {
      await mkdir(quarantine(root));
      await writeFile(join(quarantine(root), "owner-pid"), "unknown");
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(capture(root)).rejects.toThrow("capture locked");
        expect(
          await readFile(join(quarantine(root), "owner-pid"), "utf8"),
        ).toBe("unknown");
      }
      // This disposable test has no live writer; production requires operator confirmation.
      await rm(quarantine(root), { recursive: true });
      await capture(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an expired capture cannot begin publication", async () => {
    const root = await repository();
    try {
      await writeFile(join(root, "file"), "small");
      const before = await objectFiles(root);
      const runner = instrument((script) =>
        script.replace(
          "tree=$(git write-tree)",
          "tree=$(git write-tree)\nstarted=0",
        ),
      );
      await expect(capture(root, runner)).rejects.toThrow(
        "capture deadline exceeded",
      );
      expect(await objectFiles(root)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const phase of ["capture", "publication"]) {
    test(`actual timeout during ${phase} retains ownership and blocks retries`, async () => {
      const root = await repository();
      const ready = Promise.withResolvers<Socket>();
      const server = createServer((socket) =>
        socket.once("data", () => ready.resolve(socket)),
      );
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("missing test socket");
      let child: Socket | undefined;
      try {
        await writeFile(join(root, "file"), "small");
        // A bounded child announces readiness and waits for explicit release.
        // Only the production helper's timer is advanced, never a sleep deadline.
        const childScript = `
          setTimeout(() => process.exit(1), 3000);
          await Bun.connect({ hostname: "127.0.0.1", port: ${address.port}, socket: {
            open(socket) { socket.write("ready"); },
            data(socket) { socket.end(); },
            close() { process.exit(0); },
          }});
        `;
        const pause = `${shQuote(process.execPath)} -e ${shQuote(childScript)}`;
        const runner = instrument((script) =>
          script.replace(
            phase === "capture"
              ? "tree=$(git write-tree)"
              : '    target="$objects/$prefix/$name"',
            phase === "capture"
              ? `${pause}\ntree=$(git write-tree)`
              : `${pause}\n    target="$objects/$prefix/$name"`,
          ),
        );
        jest.useFakeTimers();
        const captureResult = capture(root, runner).catch(
          (error: unknown) => error,
        );
        child = await ready.promise;
        jest.advanceTimersByTime(10000);
        expect(await captureResult).toMatchObject({
          message: expect.stringContaining("timed out"),
        });
        jest.useRealTimers();
        await expect(capture(root)).rejects.toThrow("capture locked");
        const exited = new Promise<void>((resolve) =>
          child!.once("close", () => resolve()),
        );
        child.end("release");
        await exited;
        expect(await readdir(join(root, ".git"))).toContain(
          "roamgate-last-step-capture",
        );
        expect(await readdir(join(root, ".git", "objects", "pack"))).toEqual(
          [],
        );
        expect(await git(root, "count-objects", "-v")).toContain("count: 0");
        await expect(capture(root)).rejects.toThrow("capture locked");
      } finally {
        jest.useRealTimers();
        child?.destroy();
        server.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
