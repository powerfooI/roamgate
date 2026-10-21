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
    const customExecutable = join(root, "custom codex");
    await writeFile(
      customExecutable,
      '#!/bin/sh\nprintf "%s\\0" "custom binary" "$@"\nexit 23\n',
    );
    await chmod(customExecutable, 0o755);
    for (const shell of ["bash", "zsh"]) {
      if (!Bun.which(shell)) continue;
      for (const [herdr, args, expected, codexAlias = ""] of [
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
        ["1", [], ["--no-daemon", "--yolo"], "codex --yolo"],
        [
          "1",
          ["resume", "thread-id"],
          ["--no-daemon", "--yolo", "resume", "thread-id"],
          "codex --yolo",
        ],
        [
          "",
          ["resume", "thread-id"],
          ["--yolo", "resume", "thread-id"],
          "codex --yolo",
        ],
        [
          "1",
          ["-c", "model=example", "agents"],
          ["-c", "model=example", "agents"],
        ],
        [
          "1",
          ["--config=model=example", "agents"],
          ["--config=model=example", "agents"],
        ],
        ["1", ["-cmodel=example", "agents"], ["-cmodel=example", "agents"]],
        ["1", ["--model", "agents"], ["--no-daemon", "--model", "agents"]],
        [
          "1",
          ["--image", "shot.png", "agents"],
          ["--no-daemon", "--image", "shot.png", "agents"],
        ],
        [
          "1",
          ["-i", "shot.png", "app-server", "remote-control"],
          ["--no-daemon", "-i", "shot.png", "app-server", "remote-control"],
        ],
        ["1", ["--image=shot.png", "agents"], ["--image=shot.png", "agents"]],
        ["1", ["-ishot.png", "agents"], ["-ishot.png", "agents"]],
        [
          "1",
          ["--image", "shot.png", "--model", "example", "agents"],
          ["--image", "shot.png", "--model", "example", "agents"],
        ],
        ["1", ["--", "agents"], ["--no-daemon", "--", "agents"]],
        [
          "1",
          ["--model", "example", "app-server", "daemon", "version"],
          ["--model", "example", "app-server", "daemon", "version"],
        ],
        [
          "1",
          ["--enable", "example", "remote-control"],
          ["--enable", "example", "remote-control"],
        ],
        [
          "1",
          ["--config", "model=example", "resume", "thread-id"],
          ["--no-daemon", "--config", "model=example", "resume", "thread-id"],
        ],
        [
          "1",
          ["agents"],
          ["-c", "model=example", "agents"],
          "codex -c model=example",
        ],
        ["1", [], ["--no-daemon", "--yolo"], "command codex --yolo"],
        [
          "1",
          ["agents"],
          ["-c", "model=example", "agents"],
          "command codex -c model=example",
        ],
        [
          "",
          ["resume", "thread-id"],
          ["--yolo", "resume", "thread-id"],
          "command codex --yolo",
        ],
        [
          "1",
          [],
          ["custom binary", "--no-daemon", "--yolo"],
          '"$CODEX_TEST_BIN" --yolo',
        ],
        [
          "1",
          ["agents"],
          ["custom binary", "-c", "model=example", "agents"],
          '"$CODEX_TEST_BIN" -c model=example',
        ],
        [
          "",
          ["resume", "thread-id"],
          ["custom binary", "--yolo", "resume", "thread-id"],
          '"$CODEX_TEST_BIN" --yolo',
        ],
      ] as const) {
        const proc = Bun.spawn(
          [
            shell,
            "-c",
            [
              shell === "bash" ? "shopt -s expand_aliases" : "",
              'if [ -n "$CODEX_TEST_ALIAS" ]; then alias codex="$CODEX_TEST_ALIAS"; fi',
              '. "$1"',
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
              CODEX_TEST_ALIAS: codexAlias,
              CODEX_TEST_BIN: customExecutable,
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
}, 20_000);
