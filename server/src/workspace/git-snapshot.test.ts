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

  test("captures current gitlinks and their deletion", async () => {
    const root = await repository();
    try {
      const child = join(root, "module");
      await mkdir(child);
      await git(child, "init");
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
