import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Herdr shell launches isolate Codex while preserving arguments and exit status", async () => {
  const root = await mkdtemp(join(tmpdir(), "roamgate-codex-launch-"));
  try {
    const executable = join(root, "codex");
    await writeFile(executable, '#!/bin/sh\nprintf "%s\\0" "$@"\nexit 23\n');
    await chmod(executable, 0o755);
    for (const shell of ["bash", "zsh"]) {
      if (!Bun.which(shell)) continue;
      for (const [herdr, args, expected, codexAlias = false] of [
        ["1", [], ["--no-daemon"]],
        ["1", ["--yolo"], ["--no-daemon", "--yolo"]],
        ["1", ["resume", "thread-id"], ["--no-daemon", "resume", "thread-id"]],
        ["1", ["fork", "thread-id"], ["--no-daemon", "fork", "thread-id"]],
        ["1", ["--no-daemon", "--yolo"], ["--no-daemon", "--yolo"]],
        [
          "1",
          ["--model", "a b", "a; $(exit 1)"],
          ["--no-daemon", "--model", "a b", "a; $(exit 1)"],
        ],
        ["", ["--yolo"], ["--yolo"]],
        ["1", ["agents"], ["agents"]],
        [
          "1",
          ["app-server", "daemon", "version"],
          ["app-server", "daemon", "version"],
        ],
        ["1", ["remote-control"], ["remote-control"]],
        ["1", ["--remote", "unix:///server"], ["--remote", "unix:///server"]],
        ["1", ["--remote=unix:///server"], ["--remote=unix:///server"]],
        ["1", [], ["--no-daemon", "--yolo"], true],
        [
          "1",
          ["resume", "thread-id"],
          ["--no-daemon", "--yolo", "resume", "thread-id"],
          true,
        ],
        ["", ["resume", "thread-id"], ["--yolo", "resume", "thread-id"], true],
      ] as const) {
        const proc = Bun.spawn(
          [
            shell,
            "-c",
            [
              shell === "bash" ? "shopt -s expand_aliases" : "",
              codexAlias ? "alias codex='codex --yolo'" : "",
              '. "$1"',
              "shift",
              // Parse after defining the alias, as an interactive shell does.
              `eval 'codex "$@"'`,
            ].join("\n"),
            "codex-test",
            join(import.meta.dir, "codex-herdr.sh"),
            ...args,
          ],
          {
            env: {
              ...process.env,
              PATH: `${root}:${process.env.PATH}`,
              HERDR_ENV: herdr,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(stderr).toBe("");
        expect(code).toBe(23);
        expect(stdout.split("\0").slice(0, -1)).toEqual([...expected]);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
