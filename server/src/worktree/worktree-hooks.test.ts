import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runProcessWithCode, shQuote } from "../utils/process-utils";
import { createWorktreeHookRunner } from "./worktree-hooks";

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-gui-hooks-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("worktree hook runner", () => {
  test("loads paseo.json from checkout before source checkout", async () => {
    await withTempDir(async (root) => {
      const checkout = join(root, "checkout");
      const source = join(root, "source");
      await mkdir(checkout);
      await mkdir(source);
      await writeFile(
        join(source, "paseo.json"),
        JSON.stringify({ worktree: { setup: "echo source" } }),
      );
      await writeFile(
        join(checkout, "paseo.json"),
        JSON.stringify({ worktree: { setup: "echo checkout" } }),
      );

      const runner = createWorktreeHookRunner({
        herdr: { call: async () => ({}) },
        sshHost: () => undefined,
        runProcess: async () => ({ stdout: "", stderr: "" }),
        runProcessWithCode: async () => ({ code: 0, stdout: "", stderr: "" }),
        shQuote,
      });

      await expect(
        runner.readWorktreeHooks(checkout, source),
      ).resolves.toMatchObject({
        path: join(checkout, "paseo.json"),
        config: { setup: "echo checkout" },
      });
    });
  });

  test("runs configured paseo hooks with expected environment", async () => {
    await withTempDir(async (root) => {
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(
        join(root, "paseo.json"),
        JSON.stringify({
          worktree: {
            setup:
              'printf \'%s|%s|%s\' "$PASEO_HOOK" "$PASEO_CHECKOUT_PATH" "$PASEO_SOURCE_CHECKOUT_PATH"' +
              ' && test "$ROAMGATE_HOOK_EVENT" = "worktree.created"' +
              ' && test "$ROAMGATE_HOOK_EVENT" = "$HERDR_GUI_HOOK_EVENT"' +
              ' && test "$ROAMGATE_HOOK_CHECKOUT_PATH" = "$PASEO_CHECKOUT_PATH"' +
              ' && test "$ROAMGATE_HOOK_CHECKOUT_PATH" = "$HERDR_GUI_HOOK_CHECKOUT_PATH"' +
              ' && test "$ROAMGATE_HOOK_SOURCE_CHECKOUT_PATH" = "$PASEO_SOURCE_CHECKOUT_PATH"' +
              ' && test "$ROAMGATE_HOOK_SOURCE_CHECKOUT_PATH" = "$HERDR_GUI_HOOK_SOURCE_CHECKOUT_PATH"',
          },
        }),
      );

      const runner = createWorktreeHookRunner({
        herdr: { call: async () => ({}) },
        sshHost: () => undefined,
        runProcess: async () => ({ stdout: "", stderr: "" }),
        runProcessWithCode: async (argv) => {
          const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
          const [code, stdout, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ]);
          return { code, stdout, stderr };
        },
        shQuote,
      });

      const result = await runner.runWorktreeHook({
        hook: "setup",
        checkoutPath: root,
        sourceCheckoutPath: source,
      });

      expect(result.status).toBe("succeeded");
      expect(result.event).toBe("worktree.created");
      expect(result.stdout).toContain(`config: ${join(root, "paseo.json")}`);
      expect(result.stdout).toContain(`setup|${root}|${source}`);
    });
  });

  test("skips hooks when repo settings disable them", async () => {
    await withTempDir(async (root) => {
      await writeFile(join(root, "roamgate.json"), "invalid JSON");
      const runner = createWorktreeHookRunner({
        herdr: { call: async () => ({}) },
        sshHost: () => undefined,
        runProcess: async () => ({ stdout: "", stderr: "" }),
        runProcessWithCode: async () => {
          throw new Error("should not run");
        },
        shQuote,
        hooksEnabled: async () => false,
      });

      await expect(
        runner.runWorktreeHook({
          hook: "setup",
          checkoutPath: root,
          repoSettingsKey: "local:repo",
        }),
      ).resolves.toEqual({ event: "worktree.created", status: "skipped" });
    });
  });
});

// Execute SSH command bodies through a real shell while checking transport routing.
function testRunner(ssh = false) {
  const commands: string[][] = [];
  const execute = async (argv: string[]) => {
    commands.push(argv);
    if (ssh) {
      expect(argv[0]).toBe("ssh");
      expect(argv.at(-2)).toBe("hook-test-host");
      return runProcessWithCode(["sh", "-c", argv.at(-1)!]);
    }
    expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
    return runProcessWithCode(argv);
  };
  const runner = createWorktreeHookRunner({
    herdr: { call: async () => ({}) },
    sshHost: () => (ssh ? "hook-test-host" : undefined),
    runProcess: async (argv) => {
      const result = await execute(argv);
      if (result.code) throw new Error(result.stderr);
      return result;
    },
    runProcessWithCode: execute,
    shQuote,
    hooksEnabled: async () => true,
  });
  return { runner, commands };
}

for (const ssh of [false, true]) {
  describe(ssh ? "SSH hook shell" : "local hook shell", () => {
    test("selects one file in native/legacy target/source order for every combination", async () => {
      await withTempDir(async (root) => {
        const checkout = join(root, "target ' quoted");
        const source = join(root, "source");
        await mkdir(checkout);
        await mkdir(source);
        const paths = [
          join(checkout, "roamgate.json"),
          join(source, "roamgate.json"),
          join(checkout, "paseo.json"),
          join(source, "paseo.json"),
        ];
        const { runner } = testRunner(ssh);
        for (let mask = 0; mask < 16; mask++) {
          for (const [index, path] of paths.entries()) {
            await rm(path, { force: true });
            if (mask & (1 << index)) {
              await writeFile(
                path,
                JSON.stringify({
                  worktree: { setup: `printf selected-${index}` },
                }),
              );
            }
          }
          const selected = paths.findIndex((_, index) => mask & (1 << index));
          const loaded = await runner.readWorktreeHooks(checkout, source);
          const result = await runner.runWorktreeHook({
            hook: "setup",
            checkoutPath: checkout,
            sourceCheckoutPath: source,
          });
          if (selected < 0) {
            expect(loaded).toBeNull();
            expect(result.status).toBe("skipped");
          } else {
            expect(loaded).toMatchObject({
              path: paths[selected],
              source: selected < 2 ? "roamgate" : "paseo",
            });
            expect(result.status).toBe("succeeded");
            expect(result.stdout?.match(/selected-\d/g)).toEqual([
              `selected-${selected}`,
            ]);
          }
        }
      });
    });

    test("empty and partial configurations suppress fallback and ignore unknown fields", async () => {
      await withTempDir(async (root) => {
        const { runner } = testRunner(ssh);
        await writeFile(
          join(root, "paseo.json"),
          JSON.stringify({ worktree: { setup: "exit 42" } }),
        );
        for (const config of [
          {},
          { worktree: {} },
          { worktree: { setup: " " } },
          { worktree: { opened: "true", future: 3 }, future: [] },
        ]) {
          await writeFile(join(root, "roamgate.json"), JSON.stringify(config));
          expect(
            (
              await runner.runWorktreeHook({
                hook: "setup",
                checkoutPath: root,
                sourceCheckoutPath: root,
              })
            ).status,
          ).toBe("skipped");
        }
      });
    });

    test("invalid JSON, types, and unreadable files fail with their path without fallback", async () => {
      await withTempDir(async (root) => {
        const { runner } = testRunner(ssh);
        const path = join(root, "roamgate.json");
        await writeFile(
          join(root, "paseo.json"),
          '{"worktree":{"setup":"true"}}',
        );
        for (const text of [
          "",
          " ",
          "{",
          "null",
          "[]",
          "1",
          '{"worktree":null}',
          '{"worktree":[]}',
          ...["setup", "opened", "teardown", "removed"].flatMap((hook) =>
            [null, 1, false, [], {}].map((value) =>
              JSON.stringify({ worktree: { [hook]: value } }),
            ),
          ),
        ]) {
          await writeFile(path, text);
          await expect(runner.readWorktreeHooks(root)).rejects.toThrow(path);
          const result = await runner.runWorktreeHook({
            hook: "setup",
            checkoutPath: root,
          });
          expect(result.status).toBe("failed");
          expect(result.error).toContain(path);
        }
        if (process.platform !== "win32" && process.getuid?.() !== 0) {
          await chmod(path, 0);
          try {
            await expect(runner.readWorktreeHooks(root)).rejects.toThrow(path);
          } finally {
            await chmod(path, 0o600);
          }
        }
        await rm(path);
        await mkdir(path);
        await expect(runner.readWorktreeHooks(root)).rejects.toThrow(path);
      });
    });

    for (const filename of ["roamgate.json", "paseo.json"]) {
      test(`reads a UTF-8 BOM in ${filename} and runs teardown`, async () => {
        await withTempDir(async (root) => {
          const path = join(root, filename);
          const config = { teardown: "printf 'bom-\uFEFF-kept'" };
          await writeFile(
            path,
            "\uFEFF" + JSON.stringify({ worktree: config }),
          );
          const { runner } = testRunner(ssh);

          await expect(runner.readWorktreeHooks(root)).resolves.toMatchObject({
            path,
            config,
          });
          const result = await runner.runWorktreeHook({
            hook: "teardown",
            checkoutPath: root,
          });
          expect(result.status).toBe("succeeded");
          expect(result.stdout).toContain("bom-\uFEFF-kept");
        });
      });

      test(`runs all lifecycle hooks from ${filename} with cwd, aliases, and source after removal`, async () => {
        await withTempDir(async (root) => {
          const checkout = join(root, "target ' quoted");
          const source = join(root, "source");
          await mkdir(checkout);
          await mkdir(source);
          const hooks = Object.fromEntries(
            ["setup", "opened", "teardown", "removed"].map((hook) => [
              hook,
              'test "$ROAMGATE_HOOK_EVENT" = "$HERDR_GUI_HOOK_EVENT" && ' +
                'test "$ROAMGATE_HOOK_CHECKOUT_PATH" = "$PASEO_CHECKOUT_PATH" && ' +
                'test "$ROAMGATE_HOOK_CHECKOUT_PATH" = "$HERDR_GUI_HOOK_CHECKOUT_PATH" && ' +
                'test "$ROAMGATE_HOOK_SOURCE_CHECKOUT_PATH" = "$PASEO_SOURCE_CHECKOUT_PATH" && ' +
                'test "$ROAMGATE_HOOK_SOURCE_CHECKOUT_PATH" = "$HERDR_GUI_HOOK_SOURCE_CHECKOUT_PATH" && ' +
                `test "$PASEO_HOOK" = ${hook} && ` +
                'printf "%s|%s|%s|%s" "$PWD" "$ROAMGATE_HOOK_EVENT" "$ROAMGATE_HOOK_CHECKOUT_PATH" "$ROAMGATE_HOOK_SOURCE_CHECKOUT_PATH"',
            ]),
          );
          await writeFile(
            join(checkout, filename),
            JSON.stringify({ worktree: hooks }),
          );
          await writeFile(
            join(source, filename),
            JSON.stringify({
              worktree: { removed: hooks.removed + " && printf source-only" },
            }),
          );
          const { runner } = testRunner(ssh);
          const workspace = {
            worktree: {
              is_linked_worktree: true,
              checkout_path: checkout,
              repo_root: source,
            },
          };
          const setup = await runner.runWorktreeSetupHook(
            { workspace },
            { cwd: source },
          );
          const opened = await runner.runWorktreeOpenedHook(
            { workspace },
            { cwd: source },
          );
          const teardown = await runner.runWorktreeHook({
            hook: "teardown",
            checkoutPath: checkout,
            sourceCheckoutPath: source,
          });
          for (const [result, event] of [
            [setup, "worktree.created"],
            [opened, "worktree.opened"],
            [teardown, "worktree.before_remove"],
          ] as const) {
            expect(result.status).toBe("succeeded");
            expect(result.stdout).toContain(
              `${checkout}|${event}|${checkout}|${source}`,
            );
          }
          await rm(checkout, { recursive: true });
          const removed = await runner.runWorktreeRemovedHook({
            checkoutPath: checkout,
            sourceCheckoutPath: source,
            repoSettingsKey: null,
          });
          expect(removed.status).toBe("succeeded");
          expect(removed.stdout).toContain(`config: ${join(source, filename)}`);
          expect(removed.stdout).toContain(
            `${source}|worktree.removed|${checkout}|${source}source-only`,
          );
        });
      });
    }
  });
}
