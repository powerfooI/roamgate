import { afterEach, describe, expect, jest, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../utils/logger";
import { sshCommandArgv, sshReadCommandArgv } from "./ssh-command";
import { createSshProcessMonitor } from "./ssh-metrics";
import {
  acquireSshSession,
  holdSshSession,
  registerSshMaster,
  runSshCommand,
  SSH_SESSION_DEFAULT_WAIT_MS,
  SSH_SESSION_LIMIT,
  SSH_SESSION_WAITER_LIMIT,
  unregisterSshMaster,
} from "./ssh-sessions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const owners: object[] = [];
const directories: string[] = [];

/** A registered master whose control socket exists on disk. */
function fakeMaster(
  destination: string,
  isAlive: () => Promise<boolean> = async () => true,
) {
  const directory = mkdtempSync("/tmp/rg-sessions-test-");
  directories.push(directory);
  const controlPath = join(directory, "m.ctl");
  writeFileSync(controlPath, "");
  const owner = {};
  owners.push(owner);
  registerSshMaster(owner, {
    destination,
    controlPath,
    isListening: () => existsSync(controlPath),
    isAlive,
  });
  return { owner, controlPath };
}

afterEach(() => {
  for (const owner of owners.splice(0)) unregisterSshMaster(owner);
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SSH command routing over a runtime master", () => {
  test("builds a cold login when no master is ready", () => {
    const argv = sshCommandArgv("dev-box", "true");
    expect(argv).not.toContain("-S");
    expect(argv).toContain("ControlPath=none");
    expect(argv.slice(-3)).toEqual(["--", "dev-box", "true"]);
  });

  test("multiplexes over the ready master with -S ahead of the policy", () => {
    const { controlPath } = fakeMaster("dev-box");
    const argv = sshCommandArgv("dev-box", "true");
    // -S must override ControlPath=none; a later -o ControlPath would not.
    expect(argv.slice(0, 3)).toEqual(["ssh", "-S", controlPath]);
    expect(argv).toContain("ControlMaster=no");
    expect(argv.slice(-3)).toEqual(["--", "dev-box", "true"]);
    expect(sshCommandArgv("other-box", "true")).not.toContain("-S");
  });

  test("keeps masters per runtime when two runtimes reach one host", () => {
    const first = fakeMaster("dev-box");
    const second = fakeMaster("dev-box");
    expect(sshCommandArgv("dev-box", "true")[2]).toBe(first.controlPath);
    unregisterSshMaster(first.owner);
    expect(sshCommandArgv("dev-box", "true")[2]).toBe(second.controlPath);
    unregisterSshMaster(second.owner);
    expect(sshCommandArgv("dev-box", "true")).not.toContain("-S");
  });

  test("falls back to a cold login when the control socket is missing", () => {
    const { controlPath } = fakeMaster("dev-box");
    rmSync(controlPath);
    expect(sshCommandArgv("dev-box", "true")).not.toContain("-S");
  });
});

describe("SSH command execution", () => {
  test("retries a read once cold when the master died under it", async () => {
    let alive = true;
    fakeMaster("dev-box", async () => alive);
    const argv = sshReadCommandArgv("dev-box", "git status");
    const runs: string[][] = [];
    const result = await runSshCommand(argv, async (attempt) => {
      runs.push(attempt);
      if (runs.length === 1) {
        alive = false;
        return { code: 255, stderr: "" };
      }
      return { code: 0, stderr: "" };
    });
    expect(result.code).toBe(0);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toContain("-S");
    expect(runs[1]).not.toContain("-S");
    expect(runs[1].slice(-3)).toEqual(["--", "dev-box", "git status"]);
  });

  test("logs the multiplexed run and its cold retry under one tag", async () => {
    const lines: string[] = [];
    const monitor = createSshProcessMonitor({
      logger: createLogger({
        level: "debug",
        scope: "ssh",
        stdout: (line) => lines.push(line),
        now: () => new Date(0),
      }),
    });
    let alive = true;
    fakeMaster("dev-box", async () => alive);
    const argv = sshReadCommandArgv("dev-box", "true", [], "files.read");
    await runSshCommand(argv, async (attempt) => {
      monitor.track(attempt, Promise.resolve(attempt === argv ? 255 : 0));
      await Bun.sleep(0);
      alive = false;
      return { code: attempt === argv ? 255 : 0, stderr: "" };
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("tag=files.read");
    expect(lines[0]).toContain("master=true");
    expect(lines[1]).toContain("tag=files.read");
    expect(lines[1]).not.toContain("master=");
  });

  test("reports a dead master's 255 for commands that are not reads", async () => {
    let alive = true;
    fakeMaster("dev-box", async () => alive);
    const argv = sshCommandArgv("dev-box", "git worktree add ../next");
    expect(argv).toContain("-S");
    let runs = 0;
    const result = await runSshCommand(argv, async () => {
      runs += 1;
      alive = false;
      return { code: 255, stderr: "" };
    });
    expect(result.code).toBe(255);
    expect(runs).toBe(1);
  });

  test("returns the cold retry's failure without a second retry", async () => {
    fakeMaster("dev-box", async () => false);
    const argv = sshReadCommandArgv("dev-box", "true");
    let runs = 0;
    const result = await runSshCommand(argv, async () => {
      runs += 1;
      return { code: 255, stderr: "" };
    });
    expect(result.code).toBe(255);
    expect(runs).toBe(2);
  });

  test("does not retry command failures while the master is alive", async () => {
    fakeMaster("dev-box");
    const argv = sshReadCommandArgv("dev-box", "exit 255");
    let runs = 0;
    for (const code of [255, 1, 0]) {
      await runSshCommand(argv, async () => {
        runs += 1;
        return { code, stderr: "" };
      });
    }
    expect(runs).toBe(3);
  });

  test("does not retry when OpenSSH already fell back to its own login", async () => {
    fakeMaster("dev-box", async () => false);
    const argv = sshReadCommandArgv("dev-box", "true");
    for (const stderr of [
      "mux_client_request_session: session request failed: Session open refused by peer\nssh: connect to host dev-box port 22: Connection refused",
      "Control socket connect(/tmp/x/m.ctl): Connection refused\nssh: connect to host dev-box port 22: Connection refused",
    ]) {
      let runs = 0;
      await runSshCommand(argv, async () => {
        runs += 1;
        return { code: 255, stderr };
      });
      expect(runs).toBe(1);
    }
  });

  test("passes argv that did not come from sshCommandArgv straight through", async () => {
    let runs = 0;
    const result = await runSshCommand(["git", "status"], async () => {
      runs += 1;
      return { code: 255, stderr: "" };
    });
    expect(result.code).toBe(255);
    expect(runs).toBe(1);
    const { release } = await holdSshSession(["git", "status"]);
    release();
  });

  test("bounds concurrent sessions per destination, cold or multiplexed", async () => {
    fakeMaster("dev-box");
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    let started = 0;
    const run = (destination: string) =>
      runSshCommand(sshCommandArgv(destination, "sleep"), async () => {
        started += 1;
        const gate = deferred<void>();
        gates.push(gate);
        await gate.promise;
        return { code: 0, stderr: "" };
      });
    const runs = Array.from({ length: SSH_SESSION_LIMIT + 2 }, () =>
      run("dev-box"),
    );
    // A cold destination has its own budget.
    const other = run("other-box");
    await Bun.sleep(0);
    expect(started).toBe(SSH_SESSION_LIMIT + 1);

    // A held stream slot counts against the same budget.
    const streamed = holdSshSession(sshCommandArgv("dev-box", "upload"));
    gates[0].resolve();
    await Bun.sleep(0);
    expect(started).toBe(SSH_SESSION_LIMIT + 2);
    gates[1].resolve();
    await Bun.sleep(0);
    expect(started).toBe(SSH_SESSION_LIMIT + 3);
    let streamReady = false;
    void streamed.then(() => {
      streamReady = true;
    });
    await Bun.sleep(0);
    expect(streamReady).toBeFalse();

    gates[2].resolve();
    const { release } = await streamed;
    release();
    release();
    for (const gate of gates) gate.resolve();
    await Promise.all([...runs, other]);
    expect(started).toBe(SSH_SESSION_LIMIT + 3);
  });
});

describe("SSH session wait", () => {
  /** Takes every slot of `destination`; returns their releases. */
  async function fill(destination: string) {
    return Promise.all(
      Array.from({ length: SSH_SESSION_LIMIT }, () =>
        acquireSshSession(destination),
      ),
    );
  }

  test("gives up at the caller's timeout and leaves the line", async () => {
    jest.useFakeTimers();
    try {
      const held = await fill("wait-box");
      const waiting = acquireSshSession("wait-box", { timeoutMs: 1000 });
      let failure: unknown;
      waiting.catch((error) => {
        failure = error;
      });
      jest.advanceTimersByTime(999);
      await Promise.resolve();
      expect(failure).toBeUndefined();
      jest.advanceTimersByTime(1);
      await expect(waiting).rejects.toThrow(
        "ssh timed out after 1000ms waiting for a session to wait-box",
      );
      expect(jest.getTimerCount()).toBe(0);

      // The slot freed later goes to a live waiter, not the expired one.
      const next = acquireSshSession("wait-box", { timeoutMs: 1000 });
      held[0]();
      const release = await next;
      release();
      for (const done of held) done();
    } finally {
      jest.useRealTimers();
    }
  });

  test("waits SSH_SESSION_DEFAULT_WAIT_MS without a timeout", async () => {
    jest.useFakeTimers();
    try {
      const held = await fill("default-box");
      const waiting = acquireSshSession("default-box");
      waiting.catch(() => {});
      jest.advanceTimersByTime(SSH_SESSION_DEFAULT_WAIT_MS);
      await expect(waiting).rejects.toThrow(
        `after ${SSH_SESSION_DEFAULT_WAIT_MS}ms`,
      );
      for (const done of held) done();
    } finally {
      jest.useRealTimers();
    }
  });

  test("stops waiting when the caller's signal aborts", async () => {
    const held = await fill("abort-box");
    const controller = new AbortController();
    const waiting = acquireSshSession("abort-box", {
      signal: controller.signal,
    });
    controller.abort(new Error("request gone"));
    await expect(waiting).rejects.toThrow("request gone");
    await expect(
      acquireSshSession("abort-box", { signal: controller.signal }),
    ).rejects.toThrow("request gone");
    for (const done of held) done();
  });

  test("refuses a command once the line is full", async () => {
    jest.useFakeTimers();
    try {
      const held = await fill("busy-box");
      const queued = Array.from({ length: SSH_SESSION_WAITER_LIMIT }, () =>
        acquireSshSession("busy-box", { timeoutMs: 1000 }),
      );
      for (const waiter of queued) waiter.catch(() => {});
      await expect(acquireSshSession("busy-box")).rejects.toThrow(
        `${SSH_SESSION_WAITER_LIMIT} commands already waiting for busy-box`,
      );
      jest.advanceTimersByTime(1000);
      await Promise.allSettled(queued);
      for (const done of held) done();
    } finally {
      jest.useRealTimers();
    }
  });

  test("counts the wait against the command's timeout", async () => {
    jest.useFakeTimers();
    try {
      const held = await fill("budget-box");
      const budgets: Array<number | undefined> = [];
      const running = runSshCommand(
        sshCommandArgv("budget-box", "true"),
        async (_argv, remainingMs) => {
          budgets.push(remainingMs);
          return { code: 0, stderr: "" };
        },
        { timeoutMs: 1000 },
      );
      jest.advanceTimersByTime(400);
      held[0]();
      await running;
      expect(budgets).toEqual([600]);

      // Full again, so the upload's hold has to wait too.
      held[0] = await acquireSshSession("budget-box");
      const hold = holdSshSession(sshCommandArgv("budget-box", "upload"), {
        timeoutMs: 1000,
      });
      jest.advanceTimersByTime(250);
      held[1]();
      const { release, remainingMs } = await hold;
      expect(remainingMs).toBe(750);
      release();
      for (const done of held) done();
    } finally {
      jest.useRealTimers();
    }
  });
});

test("an abort after a queued slot is granted still prevents command dispatch", async () => {
  const destination = "grant-abort-box";
  const held = await Promise.all(
    Array.from({ length: SSH_SESSION_LIMIT }, () =>
      acquireSshSession(destination),
    ),
  );
  const controller = new AbortController();
  let dispatched = false;
  const pending = runSshCommand(
    sshCommandArgv(destination, "write-operation"),
    async () => {
      dispatched = true;
      return { code: 0, stderr: "" };
    },
    { signal: controller.signal },
  );
  try {
    held[0]!();
    controller.abort(new Error("request cancelled"));
    await expect(pending).rejects.toThrow("request cancelled");
    expect(dispatched).toBe(false);
  } finally {
    for (const release of held) release();
  }
  const after = await Promise.all(
    Array.from({ length: SSH_SESSION_LIMIT }, () =>
      acquireSshSession(destination),
    ),
  );
  for (const release of after) release();
});
