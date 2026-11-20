import { afterEach, describe, expect, jest, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../utils/logger";
import { sshCommandArgv, sshReadCommandArgv } from "./ssh-command";
import { createSshProcessMonitor } from "./ssh-metrics";
import {
  acquireSshSession,
  currentSshLane,
  holdSshSession,
  isSshBackgroundShed,
  runInSshLane,
  SSH_BACKGROUND_SESSION_LIMIT,
  SSH_BACKGROUND_WAITER_LIMIT,
  SSH_MASTER_RECYCLE_AFTER_MS,
  registerSshMaster,
  runSshCommand,
  SSH_SESSION_DEFAULT_WAIT_MS,
  SSH_SESSION_LIMIT,
  SSH_REFUSED_COOLDOWN_MS,
  SSH_REFUSED_RETRY_DELAYS_MS,
  SSH_REMOTE_GRACE_S,
  SSH_SESSION_WAITER_LIMIT,
  unregisterSshMaster,
  withoutMuxNoise,
  withRemoteDeadline,
} from "./ssh-sessions";

const REFUSED =
  "mux_client_request_session: session request failed: Session open refused by peer";

/** Lets settled promises run their continuations. */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

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
      monitor.track(attempt, Promise.resolve(attempt.includes("-S") ? 255 : 0));
      await Bun.sleep(0);
      alive = false;
      return { code: attempt.includes("-S") ? 255 : 0, stderr: "" };
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
    // Only where a multiplexed command may still log in on its own: on
    // Windows, whose OpenSSH has no POSIX `false` for ProxyCommand.
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
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
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  test("runs over the master without OpenSSH's own fallback login", async () => {
    fakeMaster("muxonly-box");
    const argv = sshCommandArgv("muxonly-box", "true");
    const runs: string[][] = [];
    await runSshCommand(argv, async (attempt) => {
      runs.push(attempt);
      return { code: 0, stderr: "" };
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.slice(0, 3)).toEqual(argv.slice(0, 3));
    // Given ahead of the user's config, so it wins over theirs.
    expect(runs[0]!.slice(3, 5)).toEqual(["-o", "ProxyCommand=false"]);
    expect(runs[0]!.slice(-3)).toEqual(argv.slice(-3));
    // Callers that spawn the argv themselves keep OpenSSH's fallback.
    expect(argv).not.toContain("ProxyCommand=false");
  });

  test("runs a command whose master socket is gone on its own connection", async () => {
    fakeMaster("gone-box");
    const argv = sshCommandArgv("gone-box", "git worktree add ../next");
    const runs: string[][] = [];
    const result = await runSshCommand(argv, async (attempt) => {
      runs.push(attempt);
      return runs.length === 1
        ? {
            code: 255,
            stderr:
              "Control socket connect(/tmp/x/m.ctl): No such file or directory\nkex_exchange_identification: Connection closed by remote host\nConnection closed by UNKNOWN port 65535",
          }
        : { code: 0, stderr: "" };
    });
    expect(result).toEqual({ code: 0, stderr: "" });
    expect(runs).toHaveLength(2);
    expect(runs[1]).not.toContain("-S");
  });

  test("retries a refused session over the master after a short wait", async () => {
    jest.useFakeTimers();
    try {
      fakeMaster("refuse-box");
      const argv = sshCommandArgv("refuse-box", "touch made");
      const runs: string[][] = [];
      const done = runSshCommand(argv, async (attempt) => {
        runs.push(attempt);
        return runs.length < 3
          ? { code: 255, stderr: REFUSED }
          : { code: 0, stderr: "warning: kept\n" };
      });
      await flush();
      expect(runs).toHaveLength(1);
      jest.advanceTimersByTime(SSH_REFUSED_RETRY_DELAYS_MS[0]);
      await flush();
      expect(runs).toHaveLength(2);
      jest.advanceTimersByTime(SSH_REFUSED_RETRY_DELAYS_MS[1]);
      const result = await done;
      expect(result).toEqual({ code: 0, stderr: "warning: kept\n" });
      expect(runs).toHaveLength(3);
      for (const run of runs) expect(run).toContain("ProxyCommand=false");
    } finally {
      jest.useRealTimers();
    }
  });

  test("runs a session refused every time on its own connection at last", async () => {
    jest.useFakeTimers();
    try {
      fakeMaster("always-refused-box");
      const argv = sshCommandArgv("always-refused-box", "true");
      const runs: string[][] = [];
      const done = runSshCommand(argv, async (attempt) => {
        runs.push(attempt);
        return attempt.includes("-S")
          ? { code: 255, stderr: REFUSED }
          : { code: 1, stderr: `${REFUSED}\nnot found: x\n` };
      });
      for (const delay of SSH_REFUSED_RETRY_DELAYS_MS) {
        await flush();
        jest.advanceTimersByTime(delay);
      }
      const result = await done;
      expect(runs).toHaveLength(SSH_REFUSED_RETRY_DELAYS_MS.length + 2);
      expect(runs.at(-1)).not.toContain("-S");
      // The command's own error, not OpenSSH's line about the master.
      expect(result).toEqual({ code: 1, stderr: "not found: x\n" });
    } finally {
      jest.useRealTimers();
    }
  });

  test("gives no new slot for a while after a refusal", async () => {
    jest.useFakeTimers();
    try {
      fakeMaster("cooldown-box");
      const held = await Promise.all(
        Array.from({ length: 3 }, () => acquireSshSession("cooldown-box")),
      );
      let refusals = 0;
      const refused = runSshCommand(
        sshCommandArgv("cooldown-box", "true"),
        async () => {
          refusals += 1;
          return refusals === 1
            ? { code: 255, stderr: REFUSED }
            : { code: 0, stderr: "" };
        },
      );
      await flush();
      // Four in use when the host refused: no fifth until they drop to three.
      let granted = false;
      const next = acquireSshSession("cooldown-box").then((release) => {
        granted = true;
        return release;
      });
      await flush();
      expect(granted).toBeFalse();
      held[0]!();
      await flush();
      expect(granted).toBeFalse();
      held[1]!();
      await flush();
      expect(granted).toBeTrue();
      jest.advanceTimersByTime(SSH_REFUSED_RETRY_DELAYS_MS[0]);
      await refused;
      (await next)();
      held[2]!();
      // Past the cooldown every slot is given again.
      jest.advanceTimersByTime(SSH_REFUSED_COOLDOWN_MS);
      const all = await Promise.all(
        Array.from({ length: SSH_SESSION_LIMIT }, () =>
          acquireSshSession("cooldown-box"),
        ),
      );
      for (const release of all) release();
    } finally {
      jest.useRealTimers();
    }
  });

  test("recycles a master only while its host serves no session at all", async () => {
    jest.useFakeTimers();
    try {
      const { controlPath, owner } = fakeMaster("streak-box");
      let recycles = 0;
      registerSshMaster(owner, {
        destination: "streak-box",
        controlPath,
        isListening: () => existsSync(controlPath),
        isAlive: async () => true,
        recycle: () => {
          recycles += 1;
        },
      });
      let serve = false;
      const run = async (attempt: string[]) =>
        attempt.includes("-S") && !serve
          ? { code: 255, stderr: REFUSED }
          : { code: 0, stderr: "" };
      async function command() {
        let settled = false;
        const done = runSshCommand(
          sshReadCommandArgv("streak-box", "true"),
          run,
        ).finally(() => {
          settled = true;
        });
        while (!settled) {
          await flush();
          jest.advanceTimersByTime(100);
        }
        return done;
      }
      // Refused, then a session served: the host is busy, not broken.
      await command();
      jest.advanceTimersByTime(SSH_MASTER_RECYCLE_AFTER_MS);
      serve = true;
      await command();
      serve = false;
      await command();
      expect(recycles).toBe(0);
      // Refused again past the threshold, with nothing served between.
      jest.advanceTimersByTime(SSH_MASTER_RECYCLE_AFTER_MS);
      await command();
      expect(recycles).toBe(1);
      // Not again right away, even while the host keeps refusing.
      jest.advanceTimersByTime(SSH_MASTER_RECYCLE_AFTER_MS);
      await command();
      await command();
      expect(recycles).toBe(1);
      jest.advanceTimersByTime(SSH_REFUSED_COOLDOWN_MS);
    } finally {
      jest.useRealTimers();
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

describe("SSH session lanes", () => {
  test("work is interactive unless it runs in the background lane", async () => {
    expect(currentSshLane()).toBe("interactive");
    const seen = await runInSshLane("background", async () => {
      await Bun.sleep(0);
      return currentSshLane();
    });
    expect(seen).toBe("background");
    expect(currentSshLane()).toBe("interactive");
  });

  test("background work keeps slots free for interactive work", async () => {
    const background = await Promise.all(
      Array.from({ length: SSH_BACKGROUND_SESSION_LIMIT }, () =>
        acquireSshSession("lane-box", {}, "background"),
      ),
    );
    let queued = false;
    const more = acquireSshSession("lane-box", {}, "background").then(
      (release) => {
        queued = true;
        return release;
      },
    );
    await Bun.sleep(0);
    expect(queued).toBeFalse();
    // Every slot background work may not take is still there for the user.
    const interactive = await Promise.all(
      Array.from(
        { length: SSH_SESSION_LIMIT - SSH_BACKGROUND_SESSION_LIMIT },
        () => acquireSshSession("lane-box"),
      ),
    );
    background[0]!();
    const release = await more;
    expect(queued).toBeTrue();
    release();
    for (const each of [...background, ...interactive]) each();
  });

  test("a full background queue never delays an interactive command", async () => {
    jest.useFakeTimers();
    try {
      const held = await Promise.all(
        Array.from({ length: SSH_SESSION_LIMIT }, (_, index) =>
          acquireSshSession(
            "queue-box",
            {},
            index < SSH_BACKGROUND_SESSION_LIMIT ? "background" : "interactive",
          ),
        ),
      );
      const backlog = Array.from({ length: SSH_BACKGROUND_WAITER_LIMIT }, () =>
        acquireSshSession("queue-box", { timeoutMs: 60_000 }, "background"),
      );
      for (const waiter of backlog) waiter.catch(() => {});
      let granted = false;
      const interactive = acquireSshSession("queue-box", {
        timeoutMs: 60_000,
      }).then((release) => {
        granted = true;
        return release;
      });
      // The first slot freed goes to the interactive command, ahead of the
      // whole background line.
      held[0]!();
      const release = await interactive;
      expect(granted).toBeTrue();
      release();
      jest.advanceTimersByTime(60_000);
      await Promise.allSettled(backlog);
      for (const done of held) done();
    } finally {
      jest.useRealTimers();
    }
  });

  test("sheds background work quietly once its line is full", async () => {
    jest.useFakeTimers();
    try {
      const held = await Promise.all(
        Array.from({ length: SSH_SESSION_LIMIT }, () =>
          acquireSshSession("shed-box"),
        ),
      );
      const backlog = Array.from({ length: SSH_BACKGROUND_WAITER_LIMIT }, () =>
        acquireSshSession("shed-box", { timeoutMs: 1000 }, "background"),
      );
      for (const waiter of backlog) waiter.catch(() => {});
      const shed = await runInSshLane("background", () =>
        acquireSshSession("shed-box").catch((error) => error),
      );
      expect(isSshBackgroundShed(shed)).toBeTrue();
      // Interactive commands have a line of their own.
      const interactive = acquireSshSession("shed-box", { timeoutMs: 1000 });
      interactive.catch(() => {});
      jest.advanceTimersByTime(1000);
      await Promise.allSettled([...backlog, interactive]);
      for (const done of held) done();
    } finally {
      jest.useRealTimers();
    }
  });
});

test("withoutMuxNoise keeps the command's own lines", () => {
  expect(withoutMuxNoise("plain\n")).toBe("plain\n");
  expect(
    withoutMuxNoise(
      `not found: /a/b\n${REFUSED}\nControl socket connect(/x): Connection refused\n`,
    ),
  ).toBe("not found: /a/b\n");
});

describe("remote deadlines", () => {
  test("a hung remote command frees its slot, and the host's later", async () => {
    jest.useFakeTimers();
    try {
      const destination = "hung-box";
      fakeMaster(destination);
      const held = await Promise.all(
        Array.from({ length: SSH_SESSION_LIMIT - 1 }, () =>
          acquireSshSession(destination),
        ),
      );
      let ran: string[] = [];
      // As the process helpers do: the client is killed at the deadline
      // and the run rejects, while the command still runs on the host.
      const hung = runSshCommand(
        sshReadCommandArgv(destination, "glab auth status"),
        (argv, remainingMs) => {
          ran = argv;
          return new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("ssh timed out after 1000ms")),
              remainingMs,
            ),
          );
        },
        { timeoutMs: 1000 },
      );
      hung.catch(() => {});
      await flush();
      expect(ran.at(-1)).toBe(
        withRemoteDeadline("glab auth status", 1 + SSH_REMOTE_GRACE_S),
      );
      let granted = false;
      const next = acquireSshSession(destination).then((release) => {
        granted = true;
        return release;
      });
      await flush();
      expect(granted).toBeFalse();
      jest.advanceTimersByTime(1000);
      await expect(hung).rejects.toThrow("timed out");
      // Free here, but the host counts the session until its deadline.
      await flush();
      expect(granted).toBeFalse();
      jest.advanceTimersByTime(SSH_REMOTE_GRACE_S * 1000);
      await flush();
      expect(granted).toBeTrue();
      (await next)();
      for (const release of held) release();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("runs commands without a deadline as they are", async () => {
    fakeMaster("plain-box");
    const argv = sshCommandArgv("plain-box", "glab auth status");
    let ran: string[] = [];
    await runSshCommand(argv, async (attempt) => {
      ran = attempt;
      return { code: 0, stderr: "" };
    });
    expect(ran.at(-1)).toBe("glab auth status");
  });

  test("leaves PowerShell commands for Windows hosts alone", () => {
    const command = "powershell.exe -NoLogo -EncodedCommand AAAA";
    expect(withRemoteDeadline(command, 5)).toBe(command);
  });

  const setsid = Bun.which("setsid");
  test.skipIf(!setsid)(
    "passes output, input and status through, from sh or fish, to sh",
    async () => {
      // POSIX only: fish, even when SHELL names it, would refuse v=.
      const command = `cat; v='a\\b'; printf '%s|' "$v" "x'y"; exit 3`;
      for (const shell of ["sh", Bun.which("fish")]) {
        if (!shell) continue;
        const proc = Bun.spawn(
          [setsid!, "-w", shell, "-c", withRemoteDeadline(command, 30)],
          {
            stdin: Buffer.from("in|"),
            stdout: "pipe",
            env: { ...process.env, SHELL: Bun.which("fish") ?? shell },
          },
        );
        expect(await new Response(proc.stdout).text()).toBe("in|a\\b|x'y|");
        expect(await proc.exited).toBe(3);
      }
    },
  );

  test.skipIf(!setsid)(
    "kills a hung command and what it started at the deadline",
    async () => {
      const marker = `roamgate-hung-${process.pid}`;
      const startedAt = Date.now();
      const proc = Bun.spawn(
        [
          setsid!,
          "-w",
          "sh",
          "-c",
          withRemoteDeadline(`sh -c 'sleep 30; echo ${marker}'`, 1),
        ],
        { stdout: "pipe" },
      );
      expect(await new Response(proc.stdout).text()).toBe("");
      await proc.exited;
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      const left = Bun.spawnSync(["pgrep", "-f", `echo ${marker}`]);
      expect(left.stdout.toString()).toBe("");
    },
    15_000,
  );
});
