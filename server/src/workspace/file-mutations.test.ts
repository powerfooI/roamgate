import { describe, expect, spyOn, test } from "bun:test";
import { renameSync, writeFileSync } from "node:fs";
import {
  lstat,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shQuote } from "../utils/process-utils";
import { createFileHandlers } from "./files";
import { runBinaryProcessWithTimeout } from "./process";
import * as atomicMove from "./atomic-file-move";

for (const remote of [false, true]) {
  describe(`${remote ? "SSH shell" : "local"} file mutations`, () => {
    async function fixture(
      run: (
        files: ReturnType<typeof createFileHandlers>,
        root: string,
        outside: string,
      ) => Promise<void>,
      transformCommand: (command: string) => string = (command) => command,
    ) {
      const temp = await mkdtemp(join(tmpdir(), "roamgate-mutations-"));
      const root = join(temp, "checkout");
      const outside = join(temp, "outside");
      await mkdir(root);
      await mkdir(outside);
      const files = createFileHandlers({
        herdr: {
          call: async () => ({
            workspace: {
              workspace_id: "w1",
              worktree: { checkout_path: root },
            },
          }),
        } as any,
        sshHost: () => (remote ? "example.invalid" : undefined),
        shQuote,
        runProcessWithCodeTimeout: async (argv, timeout) => {
          const result = await runBinaryProcessWithTimeout(
            ["bash", "-c", transformCommand(argv.at(-1)!)],
            timeout,
          );
          return { ...result, stdout: result.stdout.toString("utf8") };
        },
      });
      try {
        await run(files, root, outside);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    }

    const params = { workspace_id: "w1" };

    test("creates root/nested folders and preserves existing entries", async () => {
      await fixture(async (files, root) => {
        const name = "folder 'quoted $name";
        expect(
          await files.createWorkspaceDirectory({ ...params, name }),
        ).toMatchObject({ path: name });
        expect(
          await files.createWorkspaceDirectory({
            ...params,
            directory: name,
            name: "nested",
          }),
        ).toMatchObject({ path: `${name}/nested` });
        await expect(
          files.createWorkspaceDirectory({ ...params, name }),
        ).rejects.toThrow();
        await writeFile(join(root, "existing"), "keep");
        await expect(
          files.createWorkspaceDirectory({ ...params, name: "existing" }),
        ).rejects.toThrow();
        expect(await readFile(join(root, "existing"), "utf8")).toBe("keep");
      });
    });

    test("moves files into folders and back to root without changing their contents", async () => {
      await fixture(async (files, root) => {
        await mkdir(join(root, "target"));
        const name = "a 'quoted $name.txt";
        await writeFile(join(root, name), "contents");
        expect(
          await files.moveWorkspaceFile({
            ...params,
            path: name,
            directory: "target",
          }),
        ).toMatchObject({ path: `target/${name}` });
        await expect(lstat(join(root, name))).rejects.toThrow();
        expect(await readFile(join(root, "target", name), "utf8")).toBe(
          "contents",
        );
        expect(
          await files.moveWorkspaceFile({
            ...params,
            path: `target/${name}`,
            directory: "",
          }),
        ).toMatchObject({ path: name });
      });
    });

    test.skipIf(process.platform === "win32")(
      "literal backslashes in POSIX names do not move a different file",
      async () => {
        await fixture(async (files, root) => {
          await mkdir(join(root, "from"));
          await mkdir(join(root, "target"));
          await writeFile(join(root, "from/name"), "other file");
          await writeFile(join(root, "from\\name"), "selected file");
          await files.moveWorkspaceFile({
            ...params,
            path: "from\\name",
            directory: "target",
          });
          expect(await readFile(join(root, "target/from\\name"), "utf8")).toBe(
            "selected file",
          );
          expect(await readFile(join(root, "from/name"), "utf8")).toBe(
            "other file",
          );
          await expect(lstat(join(root, "from\\name"))).rejects.toThrow();
        });
      },
    );

    test.skipIf(process.platform === "win32")(
      "moves POSIX names that resemble Windows paths",
      async () => {
        await fixture(async (files, root) => {
          await files.createWorkspaceDirectory({ ...params, name: "a:target" });
          await files.createWorkspaceDirectory({
            ...params,
            directory: "a:target",
            name: "nested",
          });
          for (const name of ["a:notes", "C:\\notes", "\\notes"]) {
            await writeFile(join(root, name), name);
            expect(
              await files.moveWorkspaceFile({
                ...params,
                path: name,
                directory: "a:target/nested",
              }),
            ).toMatchObject({ path: `a:target/nested/${name}` });
            expect(
              await readFile(join(root, "a:target/nested", name), "utf8"),
            ).toBe(name);
            await expect(lstat(join(root, name))).rejects.toThrow();
          }
        });
      },
    );

    test("never overwrites a destination file, directory or symlink", async () => {
      await fixture(async (files, root, outside) => {
        await mkdir(join(root, "target"));
        for (const name of ["file", "folder", "link"])
          await writeFile(join(root, name), "source");
        await writeFile(join(root, "target/file"), "destination");
        await mkdir(join(root, "target/folder"));
        await symlink(join(outside, "missing"), join(root, "target/link"));
        for (const path of ["file", "folder", "link"]) {
          await expect(
            files.moveWorkspaceFile({ ...params, path, directory: "target" }),
          ).rejects.toThrow();
          expect(await readFile(join(root, path), "utf8")).toBe("source");
        }
        expect(await readFile(join(root, "target/file"), "utf8")).toBe(
          "destination",
        );
        expect((await lstat(join(root, "target/folder"))).isDirectory()).toBe(
          true,
        );
        expect(await readlink(join(root, "target/link"))).toBe(
          join(outside, "missing"),
        );
      });
    });

    test.skipIf(process.platform === "win32")(
      "trailing newlines in directory names do not redirect a move",
      async () => {
        await fixture(async (files, root) => {
          for (const directory of ["source", "source\n", "target", "target\n"])
            await mkdir(join(root, directory));
          await writeFile(join(root, "source/a"), "other file");
          await writeFile(join(root, "source\n/a"), "selected file");
          await files.moveWorkspaceFile({
            ...params,
            path: "source\n/a",
            directory: "target\n",
          });
          expect(await readFile(join(root, "target\n/a"), "utf8")).toBe(
            "selected file",
          );
          expect(await readFile(join(root, "source/a"), "utf8")).toBe(
            "other file",
          );
          await expect(lstat(join(root, "source\n/a"))).rejects.toThrow();
          await expect(lstat(join(root, "target/a"))).rejects.toThrow();
        });
      },
    );

    test("keeps batch failures intact while independent files move", async () => {
      await fixture(async (files, root) => {
        await mkdir(join(root, "target"));
        await writeFile(join(root, "a"), "a");
        await writeFile(join(root, "b"), "b");
        await writeFile(join(root, "target/b"), "keep");
        const results = await Promise.allSettled(
          ["a", "b"].map((path) =>
            files.moveWorkspaceFile({ ...params, path, directory: "target" }),
          ),
        );
        expect(results.map((result) => result.status)).toEqual([
          "fulfilled",
          "rejected",
        ]);
        expect(await readFile(join(root, "target/a"), "utf8")).toBe("a");
        expect(await readFile(join(root, "b"), "utf8")).toBe("b");
        expect(await readFile(join(root, "target/b"), "utf8")).toBe("keep");
      });
    });

    test("preserves saves immediately before and after the atomic move", async () => {
      const renameExclusive = atomicMove.renameFileExclusive;
      const spy = remote
        ? undefined
        : spyOn(atomicMove, "renameFileExclusive").mockImplementation(
            (source, target) => {
              renameSync(`${source}.save`, source);
              renameExclusive(source, target);
              writeFileSync(source, "later save");
            },
          );
      const script = atomicMove.REMOTE_EXCLUSIVE_RENAME.replace(
        "result = rename(*args)",
        `os.replace(source + ".save", source)
result = rename(*args)
if result == 0:
    with open(source, "w") as saved:
        saved.write("later save")`,
      );
      try {
        await fixture(
          async (files, root) => {
            await mkdir(join(root, "target"));
            await writeFile(join(root, "a"), "original");
            await writeFile(join(root, "a.save"), "concurrent save");
            await files.moveWorkspaceFile({
              ...params,
              path: "a",
              directory: "target",
            });
            expect(await readFile(join(root, "target/a"), "utf8")).toBe(
              "concurrent save",
            );
            expect(await readFile(join(root, "a"), "utf8")).toBe("later save");
            if (spy) expect(spy).toHaveBeenCalledTimes(1);
          },
          (command) =>
            command.replace(
              shQuote(atomicMove.REMOTE_EXCLUSIVE_RENAME),
              shQuote(script),
            ),
        );
      } finally {
        spy?.mockRestore();
      }
    });

    test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "a read-only source directory leaves no destination and can be retried",
      async () => {
        await fixture(async (files, root) => {
          const source = join(root, "source");
          await mkdir(source);
          await mkdir(join(root, "target"));
          await writeFile(join(source, "a"), "keep");
          await chmod(source, 0o500);
          try {
            await expect(
              files.moveWorkspaceFile({
                ...params,
                path: "source/a",
                directory: "target",
              }),
            ).rejects.toThrow();
            expect(await readFile(join(source, "a"), "utf8")).toBe("keep");
            await expect(lstat(join(root, "target/a"))).rejects.toThrow();
          } finally {
            await chmod(source, 0o700);
          }
          await files.moveWorkspaceFile({
            ...params,
            path: "source/a",
            directory: "target",
          });
          expect(await readFile(join(root, "target/a"), "utf8")).toBe("keep");
        });
      },
    );

    test("concurrent moves to the same name preserve the losing source", async () => {
      await fixture(async (files, root) => {
        for (const directory of ["one", "two", "target"])
          await mkdir(join(root, directory));
        await writeFile(join(root, "one/a"), "one");
        await writeFile(join(root, "two/a"), "two");
        const results = await Promise.allSettled(
          ["one", "two"].map((directory) =>
            files.moveWorkspaceFile({
              ...params,
              path: `${directory}/a`,
              directory: "target",
            }),
          ),
        );
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        const loser = results[0].status === "rejected" ? "one" : "two";
        expect(await readFile(join(root, loser, "a"), "utf8")).toBe(loser);
        expect(await readFile(join(root, "target/a"), "utf8")).toBe(
          loser === "one" ? "two" : "one",
        );
      });
    });

    if (remote) {
      test("unsupported atomic primitives fail without changing either path", async () => {
        const script = atomicMove.REMOTE_EXCLUSIVE_RENAME.replace(
          "import ctypes, os, sys",
          'import ctypes, os, sys\nsys.platform = "unsupported"',
        );
        await fixture(
          async (files, root) => {
            await mkdir(join(root, "target"));
            await writeFile(join(root, "a"), "keep");
            await expect(
              files.moveWorkspaceFile({
                ...params,
                path: "a",
                directory: "target",
              }),
            ).rejects.toThrow("unsupported");
            expect(await readFile(join(root, "a"), "utf8")).toBe("keep");
            await expect(lstat(join(root, "target/a"))).rejects.toThrow();
          },
          (command) =>
            command.replace(
              shQuote(atomicMove.REMOTE_EXCLUSIVE_RENAME),
              shQuote(script),
            ),
        );
      });

      test("missing Python fails before changing either path", async () => {
        await fixture(
          async (files, root) => {
            await mkdir(join(root, "target"));
            await writeFile(join(root, "a"), "keep");
            await expect(
              files.moveWorkspaceFile({
                ...params,
                path: "a",
                directory: "target",
              }),
            ).rejects.toThrow("requires Python 3");
            expect(await readFile(join(root, "a"), "utf8")).toBe("keep");
            await expect(lstat(join(root, "target/a"))).rejects.toThrow();
          },
          (command) => command.replace("command -v python3", "false"),
        );
      });
    }

    test("moves symlinks themselves and rejects directory or same-parent moves", async () => {
      await fixture(async (files, root, outside) => {
        await mkdir(join(root, "target"));
        await symlink(join(outside, "missing"), join(root, "link"));
        await files.moveWorkspaceFile({
          ...params,
          path: "link",
          directory: "target",
        });
        expect(await readlink(join(root, "target/link"))).toBe(
          join(outside, "missing"),
        );
        await expect(
          files.moveWorkspaceFile({ ...params, path: "target", directory: "" }),
        ).rejects.toThrow();
        await expect(
          files.moveWorkspaceFile({
            ...params,
            path: "target/link",
            directory: "target",
          }),
        ).rejects.toThrow();
        expect((await lstat(join(root, "target/link"))).isSymbolicLink()).toBe(
          true,
        );
      });
    });

    test("blocks symlink parent escapes for both source and destination", async () => {
      await fixture(async (files, root, outside) => {
        await symlink(outside, join(root, "escape"));
        await writeFile(join(root, "a"), "inside");
        await writeFile(join(outside, "a"), "outside");
        await expect(
          files.createWorkspaceDirectory({
            ...params,
            directory: "escape",
            name: "new",
          }),
        ).rejects.toThrow();
        await expect(
          files.moveWorkspaceFile({
            ...params,
            path: "a",
            directory: "escape",
          }),
        ).rejects.toThrow();
        await expect(
          files.moveWorkspaceFile({
            ...params,
            path: "escape/a",
            directory: "",
          }),
        ).rejects.toThrow();
        expect(await readFile(join(root, "a"), "utf8")).toBe("inside");
        expect(await readFile(join(outside, "a"), "utf8")).toBe("outside");
        await expect(lstat(join(outside, "new"))).rejects.toThrow();
      });
    });

    test("rejects invalid mutation paths, names, scopes and missing workspace identity", async () => {
      await fixture(async (files) => {
        const invalidPaths = [
          "../outside",
          "/absolute",
          "bad\0path",
          ...(process.platform === "win32"
            ? ["C:\\outside", "C:outside", "\\outside"]
            : []),
        ];
        for (const directory of invalidPaths) {
          await expect(
            files.createWorkspaceDirectory({
              ...params,
              directory,
              name: "new",
            }),
          ).rejects.toThrow();
          await expect(
            files.moveWorkspaceFile({ ...params, path: "a", directory }),
          ).rejects.toThrow();
        }
        for (const path of ["", ".", ...invalidPaths])
          await expect(
            files.moveWorkspaceFile({ ...params, path }),
          ).rejects.toThrow();
        for (const name of ["", ".", "..", "a/b", "a\\b", "bad\0name"])
          await expect(
            files.createWorkspaceDirectory({ ...params, name }),
          ).rejects.toThrow();
        await expect(
          files.createWorkspaceDirectory({
            ...params,
            name: "new",
            scope: "filesystem",
          }),
        ).rejects.toThrow("workspace scope");
        await expect(
          files.moveWorkspaceFile({
            ...params,
            path: "a",
            scope: "filesystem",
          }),
        ).rejects.toThrow("workspace scope");
        await expect(
          files.createWorkspaceDirectory({ name: "new" }),
        ).rejects.toThrow("workspace_id");
        await expect(files.moveWorkspaceFile({ path: "a" })).rejects.toThrow(
          "workspace_id",
        );
      });
    });
  });
}
