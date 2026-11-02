import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import {
  createWorktreeRemovalCoordinator,
  createWorktreeRemovalRuntime,
  isNotWorkingTreeRemoveError,
  parseCheckoutProcessIds,
  removeWorktreeWithRecovery,
  renderWorktreeRemoveCommand,
  runWorktreeRemoveCommand,
  type CheckoutState,
  type WorktreeRemovalRuntime,
} from "./remove";

function runtime(overrides: Partial<WorktreeRemovalRuntime> = {}) {
  return {
    inspectCheckout: async () => "clean" as CheckoutState,
    stopCheckoutProcesses: async () => [],
    preserveCheckout: async () => "/worktree.recovered",
    ...overrides,
  } satisfies WorktreeRemovalRuntime;
}

describe("worktree removal coordination", () => {
  test("shares one in-flight operation for the same workspace", async () => {
    const coordinator = createWorktreeRemovalCoordinator();
    let resolve!: (value: string) => void;
    let calls = 0;
    const operation = () => {
      calls += 1;
      return new Promise<string>((done) => {
        resolve = done;
      });
    };

    const first = coordinator.run("w1", operation);
    const second = coordinator.run("w1", operation);
    expect(calls).toBe(1);
    resolve("removed");
    expect(await Promise.all([first, second])).toEqual(["removed", "removed"]);
  });

  test("clears a failed operation so it can be retried", async () => {
    const coordinator = createWorktreeRemovalCoordinator();
    await expect(
      coordinator.run("w1", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(coordinator.run("w1", async () => "retried")).resolves.toBe(
      "retried",
    );
  });
});

describe("worktree removal recovery", () => {
  test("recognizes only the stale Herdr worktree error", () => {
    expect(
      isNotWorkingTreeRemoveError(
        new Error(
          "worktree_remove_failed: fatal: '/tmp/wt' is not a working tree",
        ),
      ),
    ).toBe(true);
    expect(
      isNotWorkingTreeRemoveError(
        new Error("worktree_remove_failed: contains modified files"),
      ),
    ).toBe(false);
  });

  test("finds only processes whose cwd is inside the checkout", () => {
    expect(
      parseCheckoutProcessIds(
        [
          "p12",
          "n/work/repo",
          "p13",
          "n/work/repo/apps/web",
          "p14",
          "n/work/repository",
          "p15",
          "n/work/repo (deleted)",
        ].join("\n"),
        "/work/repo",
      ),
    ).toEqual([12, 13, 15]);
  });

  test("lets Herdr shut down its workspace before cleaning residual processes", async () => {
    const order: string[] = [];
    let stopped = false;
    const outcome = await removeWorktreeWithRecovery({
      call: async () => {
        order.push("remove");
        return { ok: true };
      },
      params: { workspace_id: "w1", force: false },
      checkoutPath: "/work/repo",
      runtime: runtime({
        inspectCheckout: async () => "missing",
        stopCheckoutProcesses: async () => {
          stopped = true;
          order.push("stop");
          return [10, 11];
        },
      }),
    });

    expect(order).toEqual(["remove"]);
    expect(stopped).toBe(false);
    expect(outcome.cleanup).toBeUndefined();
  });

  test("does not stop processes when a checkout is dirty", async () => {
    let stopped = false;
    await expect(
      removeWorktreeWithRecovery({
        call: async () => {
          throw new Error("dirty_worktree_requires_force: dirty");
        },
        params: { workspace_id: "w1", force: false },
        checkoutPath: "/work/repo",
        runtime: runtime({
          inspectCheckout: async () => "dirty",
          stopCheckoutProcesses: async () => {
            stopped = true;
            return [];
          },
        }),
      }),
    ).rejects.toThrow("dirty_worktree_requires_force");
    expect(stopped).toBe(false);
  });

  test("preserves residual files and reconciles Herdr with force", async () => {
    const calls: Record<string, unknown>[] = [];
    const outcome = await removeWorktreeWithRecovery({
      call: async (_method, params) => {
        calls.push(params ?? {});
        if (calls.length === 1) {
          throw new Error(
            "worktree_remove_failed: fatal: '/work/repo' is not a working tree",
          );
        }
        return { ok: true };
      },
      params: { workspace_id: "w1", force: false },
      checkoutPath: "/work/repo",
      runtime: runtime({
        inspectCheckout: async () => "residual",
        stopCheckoutProcesses: async () => [21],
        preserveCheckout: async () => "/work/repo.recovered-1",
      }),
    });

    expect(calls).toEqual([
      { workspace_id: "w1", force: false },
      { workspace_id: "w1", force: true },
    ]);
    expect(outcome.cleanup).toEqual({
      terminated_processes: 1,
      recovered_stale_checkout: true,
      preserved_path: "/work/repo.recovered-1",
    });
  });

  test("recovers a residual checkout when the original request was forced", async () => {
    const calls: Record<string, unknown>[] = [];
    const outcome = await removeWorktreeWithRecovery({
      call: async (_method, params) => {
        calls.push(params ?? {});
        if (calls.length === 1) {
          throw new Error(
            "worktree_remove_failed: fatal: '/work/repo' is not a working tree",
          );
        }
        return { ok: true };
      },
      params: { workspace_id: "w1", force: true },
      checkoutPath: "/work/repo",
      runtime: runtime({
        inspectCheckout: async () => "residual",
        preserveCheckout: async () => "/work/repo.recovered-1",
      }),
    });

    expect(calls).toEqual([
      { workspace_id: "w1", force: true },
      { workspace_id: "w1", force: true },
    ]);
    expect(outcome.cleanup).toEqual({
      terminated_processes: 0,
      recovered_stale_checkout: true,
      preserved_path: "/work/repo.recovered-1",
    });
  });

  test("reconciles an already missing checkout without preserving files", async () => {
    const calls: Record<string, unknown>[] = [];
    const outcome = await removeWorktreeWithRecovery({
      call: async (_method, params) => {
        calls.push(params ?? {});
        if (calls.length === 1) {
          throw new Error(
            "worktree_remove_failed: fatal: '/work/repo' is not a worktree",
          );
        }
        return { ok: true };
      },
      params: { workspace_id: "w1", force: false },
      checkoutPath: "/work/repo",
      runtime: runtime({ inspectCheckout: async () => "missing" }),
    });

    expect(calls[1]).toEqual({ workspace_id: "w1", force: true });
    expect(outcome.cleanup).toEqual({
      terminated_processes: 0,
      recovered_stale_checkout: true,
    });
  });

  test("verifies the checkout again after a forced recovery retry", async () => {
    const calls: Record<string, unknown>[] = [];
    const preservedPaths: string[] = [];
    const outcome = await removeWorktreeWithRecovery({
      call: async (_method, params) => {
        calls.push(params ?? {});
        if (calls.length === 1) {
          throw new Error(
            "worktree_remove_failed: fatal: '/work/repo' is not a working tree",
          );
        }
        return { ok: true };
      },
      params: { workspace_id: "w1", force: false },
      checkoutPath: "/work/repo",
      runtime: runtime({
        inspectCheckout: async () => "residual",
        stopCheckoutProcesses: async () => [41],
        preserveCheckout: async () => {
          const path = `/work/repo.recovered-${preservedPaths.length + 1}`;
          preservedPaths.push(path);
          return path;
        },
      }),
    });

    expect(calls).toHaveLength(2);
    expect(preservedPaths).toEqual([
      "/work/repo.recovered-1",
      "/work/repo.recovered-2",
    ]);
    expect(outcome.cleanup).toEqual({
      terminated_processes: 1,
      recovered_stale_checkout: true,
      preserved_path: "/work/repo.recovered-2",
    });
  });

  test("does not move residual files when process cleanup fails", async () => {
    let preserved = false;
    let calls = 0;
    await expect(
      removeWorktreeWithRecovery({
        call: async () => {
          calls += 1;
          throw new Error(
            "worktree_remove_failed: fatal: '/work/repo' is not a working tree",
          );
        },
        params: { workspace_id: "w1", force: false },
        checkoutPath: "/work/repo",
        runtime: runtime({
          inspectCheckout: async () => "residual",
          stopCheckoutProcesses: async () => {
            throw new Error("process 42 survived");
          },
          preserveCheckout: async () => {
            preserved = true;
            return "/work/repo.recovered";
          },
        }),
        log: () => {},
      }),
    ).rejects.toThrow("unable to preserve the stale checkout");
    expect(calls).toBe(1);
    expect(preserved).toBe(false);
  });

  test("does not recover when the checkout is still a valid worktree", async () => {
    let calls = 0;
    await expect(
      removeWorktreeWithRecovery({
        call: async () => {
          calls += 1;
          throw new Error(
            "worktree_remove_failed: fatal: '/work/repo' is not a working tree",
          );
        },
        params: { workspace_id: "w1", force: false },
        checkoutPath: "/work/repo",
        runtime: runtime({ inspectCheckout: async () => "clean" }),
      }),
    ).rejects.toThrow("is not a working tree");
    expect(calls).toBe(1);
  });

  test("never performs local cleanup for an unsafe checkout path", async () => {
    let inspected = false;
    let stopped = false;
    let preserved = false;
    const logs: string[] = [];

    const outcome = await removeWorktreeWithRecovery({
      call: async () => ({ ok: true }),
      params: { workspace_id: "w1", force: true },
      checkoutPath: "/",
      runtime: runtime({
        inspectCheckout: async () => {
          inspected = true;
          return "residual";
        },
        stopCheckoutProcesses: async () => {
          stopped = true;
          return [];
        },
        preserveCheckout: async () => {
          preserved = true;
          return "/recovered";
        },
      }),
      log: (message) => logs.push(message),
    });

    expect(outcome.result).toEqual({ ok: true });
    expect(inspected).toBe(false);
    expect(stopped).toBe(false);
    expect(preserved).toBe(false);
    expect(logs).toEqual([
      "[bridge] refusing worktree cleanup for unsafe path: /",
    ]);
  });

  test("normalizes dot segments before checking cleanup path safety", async () => {
    const inspectedPaths: string[] = [];
    const logs: string[] = [];

    await removeWorktreeWithRecovery({
      call: async () => ({ ok: true }),
      params: { workspace_id: "w1", force: false },
      checkoutPath: "/tmp/..",
      runtime: runtime({
        inspectCheckout: async (path) => {
          inspectedPaths.push(path);
          return "clean";
        },
      }),
      log: (message) => logs.push(message),
    });

    expect(inspectedPaths).toEqual([]);
    expect(logs).toEqual([
      "[bridge] refusing worktree cleanup for unsafe path: /tmp/..",
    ]);
  });

  test("uses a normalized checkout path for cleanup operations", async () => {
    const inspectedPaths: string[] = [];
    const stoppedPaths: string[] = [];

    await removeWorktreeWithRecovery({
      call: async () => ({ ok: true }),
      params: { workspace_id: "w1", force: false },
      checkoutPath: "/work/parent/../repo",
      runtime: runtime({
        inspectCheckout: async (path) => {
          inspectedPaths.push(path);
          return "missing";
        },
        stopCheckoutProcesses: async (path) => {
          stoppedPaths.push(path);
          return [];
        },
      }),
    });

    expect(inspectedPaths).toEqual(["/work/repo"]);
    expect(stoppedPaths).toEqual([]);
  });

  test("preserves a residual directory left after Herdr reports success", async () => {
    const outcome = await removeWorktreeWithRecovery({
      call: async () => ({ ok: true }),
      params: { workspace_id: "w1", force: false },
      checkoutPath: "/work/repo",
      runtime: runtime({
        inspectCheckout: async () => "residual",
        stopCheckoutProcesses: async () => [31],
        preserveCheckout: async () => "/work/repo.recovered-2",
      }),
    });

    expect(outcome.cleanup).toEqual({
      terminated_processes: 1,
      recovered_stale_checkout: true,
      preserved_path: "/work/repo.recovered-2",
    });
  });

  test("reports incomplete cleanup without changing a successful remove into failure", async () => {
    const logs: string[] = [];
    const outcome = await removeWorktreeWithRecovery({
      call: async () => ({ ok: true }),
      params: { workspace_id: "w1", force: false },
      checkoutPath: "/work/repo",
      runtime: runtime({
        inspectCheckout: async () => "residual",
        stopCheckoutProcesses: async () => {
          throw new Error("process 42 survived");
        },
      }),
      log: (message) => logs.push(message),
    });

    expect(outcome.result).toEqual({ ok: true });
    expect(outcome.cleanup).toEqual({
      terminated_processes: 0,
      warning:
        "Herdr removed the worktree, but stale checkout cleanup failed: process 42 survived",
    });
    expect(logs).toEqual([
      "[bridge] Herdr removed the worktree, but stale checkout cleanup failed: process 42 survived",
    ]);
  });

  test("warns when a successful removal cannot be verified", async () => {
    const outcome = await removeWorktreeWithRecovery({
      call: async () => ({ ok: true }),
      params: { workspace_id: "w1", force: false },
      checkoutPath: "/work/repo",
      runtime: runtime({ inspectCheckout: async () => "unknown" }),
      log: () => {},
    });

    expect(outcome.cleanup).toEqual({
      terminated_processes: 0,
      warning:
        "Herdr reported success, but the checkout removal could not be verified at /work/repo",
    });
  });

  test("continues recovery if a residual directory disappears before preservation", async () => {
    const calls: Record<string, unknown>[] = [];
    let inspections = 0;
    const outcome = await removeWorktreeWithRecovery({
      call: async (_method, params) => {
        calls.push(params ?? {});
        if (calls.length === 1) {
          throw new Error(
            "worktree_remove_failed: fatal: '/work/repo' is not a working tree",
          );
        }
        return { ok: true };
      },
      params: { workspace_id: "w1", force: false },
      checkoutPath: "/work/repo",
      runtime: runtime({
        inspectCheckout: async () => {
          inspections += 1;
          return inspections === 1 ? "residual" : "missing";
        },
        preserveCheckout: async () => {
          throw new Error("ENOENT");
        },
      }),
    });

    expect(calls).toHaveLength(2);
    expect(outcome.cleanup).toEqual({
      terminated_processes: 0,
      recovered_stale_checkout: true,
    });
  });
});

describe("worktree removal checkout inspection", () => {
  test("does not mistake a directory inside another repository for a worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-gui-remove-"));
    const child = join(root, "stale-checkout");
    try {
      const initialized = await runProcessWithCodeTimeout(
        ["git", "init", "--quiet", root],
        10_000,
      );
      expect(initialized.code).toBe(0);
      await mkdir(child);

      const checkoutRuntime = createWorktreeRemovalRuntime({
        runProcessWithCodeTimeout,
        shQuote,
      });
      expect(await checkoutRuntime.inspectCheckout(root)).toBe("clean");
      expect(await checkoutRuntime.inspectCheckout(child)).toBe("residual");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stops a stable process whose cwd is inside the checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-gui-process-"));
    const sleeper = Bun.spawn(["sleep", "30"], {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const checkoutRuntime = createWorktreeRemovalRuntime({
        runProcessWithCodeTimeout,
        shQuote,
      });
      const stopped = await checkoutRuntime.stopCheckoutProcesses(root);
      expect(stopped).toContain(sleeper.pid);
      expect(await sleeper.exited).not.toBe(0);
    } finally {
      if (sleeper.exitCode === null) sleeper.kill();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});

describe("worktree remove command", () => {
  test("substitutes the checkout, its repository and --force when forced", () => {
    expect(
      renderWorktreeRemoveCommand("git recworktree remove {path} {force}", {
        path: "/w/it's",
        repo: "/src",
        force: true,
      }),
    ).toBe(
      `export ROAMGATE_WORKTREE_PATH='/w/it'\\''s'; export ROAMGATE_WORKTREE_REPO='/src'; cd "$ROAMGATE_WORKTREE_REPO" && git recworktree remove "$ROAMGATE_WORKTREE_PATH" --force`,
    );
    expect(
      renderWorktreeRemoveCommand("tool rm {path} {force} --repo {repo}", {
        path: "~/wt/a",
        repo: "/src",
        force: false,
      }),
    ).toBe(
      `export ROAMGATE_WORKTREE_PATH="$HOME"/'wt/a'; export ROAMGATE_WORKTREE_REPO='/src'; cd "$ROAMGATE_WORKTREE_REPO" && tool rm "$ROAMGATE_WORKTREE_PATH"  --repo "$ROAMGATE_WORKTREE_REPO"`,
    );
  });

  test("a hostile checkout path runs nothing, with a real sh", async () => {
    const root = mkdtempSync(join(tmpdir(), "roamgate-remove-sh-"));
    try {
      const marker = join(root, "pwned");
      const checkout = `${root}/a$(touch\${IFS}${marker})'$(touch\${IFS}${marker})'`;
      const remove = (template: string) =>
        runWorktreeRemoveCommand({
          template,
          checkoutPath: checkout,
          sourceCheckoutPath: root,
          force: false,
          runProcess: runProcessWithCodeTimeout,
        });
      // Quoted placeholders would put the value back into shell syntax.
      const outcomes: string[] = [];
      for (const template of [
        `printf '%s' "{path}" > out`,
        `printf '%s' '{path}' > out`,
      ])
        outcomes.push(
          await remove(template).then(
            () => "ran",
            (error: Error) => error.message,
          ),
        );
      expect(existsSync(marker)).toBe(false);
      expect(outcomes).toEqual([
        "Remove the quotes around {path}: Roamgate quotes placeholders itself.",
        "Remove the quotes around {path}: Roamgate quotes placeholders itself.",
      ]);
      expect(await remove(`printf '%s' {path} > out`)).toBeNull();
      expect(readFileSync(join(root, "out"), "utf8")).toBe(checkout);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runs from the source repository, over SSH on a remote host", async () => {
    const runs: string[][] = [];
    const fallback = await runWorktreeRemoveCommand({
      template: "git recworktree remove {path} {force}",
      checkoutPath: "/w/a",
      sourceCheckoutPath: "/src",
      force: false,
      host: "desktop",
      runProcess: async (argv) => {
        runs.push(argv);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(fallback).toBeNull();
    expect(runs).toHaveLength(2);
    expect(runs[0]!.at(-1)).toContain("command -v -- ");
    expect(runs[1]![0]).toBe("ssh");
    expect(runs[1]!.at(-1)).toBe(
      `sh -c 'export ROAMGATE_WORKTREE_PATH='\\''/w/a'\\''; export ROAMGATE_WORKTREE_REPO='\\''/src'\\''; cd "$ROAMGATE_WORKTREE_REPO" && git recworktree remove "$ROAMGATE_WORKTREE_PATH" '`,
    );
  });

  test("a command not installed on the host leaves the removal to Herdr, and says so", async () => {
    const calls: string[] = [];
    const runs: string[][] = [];
    const outcome = await removeWorktreeWithRecovery({
      call: async (method) => {
        calls.push(method);
        return { type: "worktree_removed" };
      },
      params: { workspace_id: "w2" },
      checkoutPath: "/w/a",
      runtime: runtime({ inspectCheckout: async () => "missing" }),
      removeWithCommand: async () => {
        const fallback = await runWorktreeRemoveCommand({
          template: "git recworktree remove {path}",
          checkoutPath: "/w/a",
          sourceCheckoutPath: "/src",
          force: false,
          runProcess: async (argv) => {
            runs.push(argv);
            return { code: 127, stdout: "", stderr: "" };
          },
        });
        return fallback
          ? { fallback }
          : { result: { type: "worktree_removed" } };
      },
    });
    expect(runs).toHaveLength(1);
    expect(calls).toEqual(["worktree.remove"]);
    expect(outcome.result).toEqual({ type: "worktree_removed" });
    expect(outcome.commandFallback).toBe(
      "git recworktree is not installed on this machine.",
    );
  });

  test("an exit 127 from inside an installed remove command is a failure", async () => {
    let call = 0;
    await expect(
      runWorktreeRemoveCommand({
        template: "git recworktree remove {path}",
        checkoutPath: "/w/a",
        sourceCheckoutPath: "/src",
        force: false,
        runProcess: async () =>
          ++call === 1
            ? { code: 0, stdout: "", stderr: "" }
            : { code: 127, stdout: "", stderr: "hook: rmtool: not found" },
      }),
    ).rejects.toThrow(
      "Worktree remove command failed (exit 127): hook: rmtool: not found",
    );
  });

  test("no sh on this machine leaves the removal to Herdr", async () => {
    const fallback = await runWorktreeRemoveCommand({
      template: "git recworktree remove {path}",
      checkoutPath: "C:/w/a",
      sourceCheckoutPath: "C:/src",
      force: false,
      runProcess: async () => {
        throw Object.assign(new Error("spawn sh ENOENT"), { code: "ENOENT" });
      },
    });
    expect(fallback).toBe("sh is not available on this machine.");
  });

  test("the command's removal skips Herdr's, and a failure stops it", async () => {
    const calls: string[] = [];
    const call = async (method: string) => {
      calls.push(method);
      return {};
    };
    const outcome = await removeWorktreeWithRecovery({
      call,
      params: { workspace_id: "w2" },
      checkoutPath: "/w/a",
      runtime: runtime({ inspectCheckout: async () => "missing" }),
      removeWithCommand: async () => ({
        result: { type: "worktree_removed", path: "/w/a" },
      }),
    });
    expect(calls).toEqual([]);
    expect(outcome.result.path).toBe("/w/a");
    expect(outcome.commandFallback).toBeUndefined();

    let run = 0;
    await expect(
      runWorktreeRemoveCommand({
        template: "git recworktree remove {path}",
        checkoutPath: "/w/a",
        sourceCheckoutPath: "/src",
        force: false,
        runProcess: async () =>
          ++run === 1
            ? { code: 0, stdout: "", stderr: "" }
            : {
                code: 1,
                stdout: "",
                stderr: "Error: worktree has uncommitted changes",
              },
      }),
    ).rejects.toThrow(
      "Worktree remove command failed (exit 1): Error: worktree has uncommitted changes",
    );
  });

  test("a command failing on a stale checkout gets the same recovery as Herdr", async () => {
    const calls: { method: string; params?: Record<string, unknown> }[] = [];
    const outcome = await removeWorktreeWithRecovery({
      call: async (method, params) => {
        calls.push({ method, params });
        return { type: "worktree_removed" };
      },
      params: { workspace_id: "w2" },
      checkoutPath: "/w/a",
      runtime: runtime({ inspectCheckout: async () => "missing" }),
      removeWithCommand: async () => {
        throw new Error(
          "Worktree remove command failed (exit 128): fatal: '/w/a' is not a working tree",
        );
      },
    });
    expect(calls).toEqual([
      {
        method: "worktree.remove",
        params: { workspace_id: "w2", force: true },
      },
    ]);
    expect(outcome.result).toEqual({ type: "worktree_removed" });
  });

  test("warnings after the command's removal name the command, not Herdr", async () => {
    const outcome = await removeWorktreeWithRecovery({
      call: async () => ({}),
      params: { workspace_id: "w2" },
      checkoutPath: "/w/a",
      runtime: runtime({ inspectCheckout: async () => "clean" }),
      removeWithCommand: async () => ({ result: { type: "worktree_removed" } }),
      log: () => {},
    });
    expect(outcome.cleanup?.warning).toBe(
      "The worktree remove command reported success, but the checkout is still a clean working tree at /w/a",
    );
  });
});
