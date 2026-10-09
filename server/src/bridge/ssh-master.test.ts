import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { sshCommandArgv } from "./ssh-command";
import { holdSshSession } from "./ssh-sessions";
import {
  createSshMaster,
  type SshMaster,
  sweepOrphanedSshMasters,
} from "./ssh-master";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

const CONTROL_PATH = "/tmp/rg-master-test/m.ctl";

function harness(
  overrides: {
    exists?: () => boolean;
    restartDelayMs?: number;
    remove?: (path: string) => void;
    drainTimeoutMs?: number;
  } = {},
) {
  const controls: string[][] = [];
  const spawned: Array<{
    argv: string[];
    exit: (code: number) => void;
    signals: Array<number | undefined>;
  }> = [];
  const removed: string[] = [];
  let socket = false;
  const master = createSshMaster({
    destination: "dev-box",
    controlPath: CONTROL_PATH,
    dependencies: {
      spawn: (argv) => {
        const exited = deferred<number>();
        const signals: Array<number | undefined> = [];
        spawned.push({ argv, exit: exited.resolve, signals });
        return {
          exited: exited.promise,
          kill: (signal) => {
            signals.push(signal);
            socket = false;
            exited.resolve(signal === 9 ? 137 : 143);
          },
        };
      },
      exists: overrides.exists ?? (() => socket),
      remove: (path) => {
        overrides.remove?.(path);
        removed.push(path);
        socket = false;
      },
      runCheck: async (argv) => {
        controls.push(argv);
        return socket ? 0 : 255;
      },
      drainTimeoutMs: overrides.drainTimeoutMs ?? 5_000,
      pollIntervalMs: 1,
      readyTimeoutMs: 50,
      restartDelayMs: overrides.restartDelayMs ?? 1000,
      stopTimeoutMs: 10,
      forceKillTimeoutMs: 10,
    },
  });
  masters.push(master);
  return {
    master,
    spawned,
    removed,
    controls,
    listen: () => {
      socket = true;
    },
    crash: (index: number) => {
      socket = false;
      spawned[index].exit(255);
    },
  };
}

const masters: SshMaster[] = [];

afterEach(async () => {
  jest.useRealTimers();
  await Promise.all(masters.splice(0).map((master) => master.stop()));
});

describe("SSH command master lifecycle", () => {
  test("a socket it cannot clear leaves commands cold without rejecting", async () => {
    const { master, spawned } = harness({
      remove: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    // ensure() runs unawaited from the tunnel and the restart timer.
    expect(await master.ensure()).toBeFalse();
    expect(spawned).toHaveLength(0);
    expect(sshCommandArgv("dev-box", "true")).not.toContain("-S");
    // Stopping still resolves.
    await master.stop();
  });

  test("starts an explicit master and routes commands once it listens", async () => {
    const { master, spawned, listen } = harness();
    const ready = master.ensure();
    expect(spawned).toHaveLength(1);
    const argv = spawned[0].argv;
    expect(argv.slice(0, 4)).toEqual(["ssh", "-M", "-S", CONTROL_PATH]);
    expect(argv).toContain("-N");
    expect(argv).toContain("BatchMode=yes");
    expect(argv.slice(-2)).toEqual(["--", "dev-box"]);
    expect(sshCommandArgv("dev-box", "true")).not.toContain("-S");

    listen();
    expect(await ready).toBeTrue();
    expect(sshCommandArgv("dev-box", "true").slice(0, 3)).toEqual([
      "ssh",
      "-S",
      CONTROL_PATH,
    ]);
    // A running master is reused rather than replaced.
    expect(await master.ensure()).toBeTrue();
    expect(spawned).toHaveLength(1);
  });

  test("shares one start between concurrent callers", async () => {
    const { master, spawned, listen } = harness();
    const first = master.ensure();
    const second = master.ensure();
    listen();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(spawned).toHaveLength(1);
  });

  test("leaves commands cold when the master exits before it listens", async () => {
    const { master, spawned } = harness();
    const ready = master.ensure();
    spawned[0].exit(255);
    expect(await ready).toBeFalse();
    expect(master.isRunning()).toBeFalse();
    expect(sshCommandArgv("dev-box", "true")).not.toContain("-S");
  });

  test("kills a master that never listens before the deadline", async () => {
    const { master, spawned } = harness({ exists: () => false });
    expect(await master.ensure()).toBeFalse();
    expect(spawned[0].signals).toEqual([undefined]);
    expect(master.isRunning()).toBeFalse();
  });

  test("removes a stale socket before starting", async () => {
    const { master, removed, listen } = harness();
    const ready = master.ensure();
    expect(removed).toEqual([CONTROL_PATH]);
    listen();
    await ready;
  });

  test("restarts after a ready master dies, not after one that never listens", async () => {
    jest.useFakeTimers();
    const { master, spawned, listen, crash } = harness();
    const ready = master.ensure();
    listen();
    // Readiness polls on a timer; the socket is already there.
    jest.advanceTimersByTime(1);
    expect(await ready).toBeTrue();

    crash(0);
    await flushMicrotasks();
    expect(master.isRunning()).toBeFalse();
    expect(sshCommandArgv("dev-box", "true")).not.toContain("-S");
    jest.advanceTimersByTime(999);
    expect(spawned).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(spawned).toHaveLength(2);

    // This one never becomes ready: no further automatic restarts.
    spawned[1].exit(255);
    await flushMicrotasks();
    jest.advanceTimersByTime(10_000);
    expect(spawned).toHaveLength(2);
  });

  test("stops for good on dispose and removes its socket", async () => {
    jest.useFakeTimers();
    const { master, spawned, removed, listen, crash } = harness();
    const ready = master.ensure();
    listen();
    jest.advanceTimersByTime(1);
    await ready;
    crash(0);
    await flushMicrotasks();
    // A pending restart is cancelled by stop.
    await master.stop();
    jest.advanceTimersByTime(5_000);
    expect(spawned).toHaveLength(1);
    expect(await master.ensure()).toBeFalse();
    jest.useRealTimers();

    const live = harness();
    const liveReady = live.master.ensure();
    live.listen();
    await liveReady;
    await live.master.stop();
    expect(live.spawned[0].signals).toEqual([undefined]);
    expect(live.removed).toEqual([CONTROL_PATH, CONTROL_PATH]);
    expect(sshCommandArgv("dev-box", "true")).not.toContain("-S");
    expect(removed).toEqual([CONTROL_PATH]);
  });

  test("lets multiplexed commands finish before it stops", async () => {
    const { master, spawned, controls, listen } = harness();
    const ready = master.ensure();
    listen();
    await ready;
    const upload = await holdSshSession(sshCommandArgv("dev-box", "upload"));
    const stopping = master.stop();
    await flushMicrotasks();
    // Closed to new sessions, which now log in on their own...
    expect(controls.at(-1)).toContain("stop");
    expect(controls.at(-1)?.slice(0, 3)).toEqual(["ssh", "-S", CONTROL_PATH]);
    expect(sshCommandArgv("dev-box", "true")).not.toContain("-S");
    // ...while the running one keeps its master.
    await Bun.sleep(20);
    expect(spawned[0].signals).toEqual([]);
    upload.release();
    await stopping;
    expect(spawned[0].signals).toEqual([undefined]);
  });

  test("stops a master whose commands outlast the drain", async () => {
    const { master, spawned, listen } = harness({ drainTimeoutMs: 20 });
    const ready = master.ensure();
    listen();
    await ready;
    const upload = await holdSshSession(sshCommandArgv("dev-box", "upload"));
    await master.stop();
    expect(spawned[0].signals).toEqual([undefined]);
    upload.release();
  });

  test("kills a master that is still starting when the runtime stops", async () => {
    const { master, spawned } = harness();
    const ready = master.ensure();
    await master.stop();
    expect(spawned[0].signals).toEqual([undefined]);
    expect(await ready).toBeFalse();
    expect(sshCommandArgv("dev-box", "true")).not.toContain("-S");
  });

  test("reports a master that survives forced termination", async () => {
    const signals: Array<number | undefined> = [];
    let socket = false;
    const master = createSshMaster({
      destination: "dev-box",
      controlPath: CONTROL_PATH,
      dependencies: {
        spawn: () => ({
          exited: new Promise<number>(() => undefined),
          kill: (signal) => signals.push(signal),
        }),
        exists: () => socket,
        remove: () => undefined,
        runCheck: async () => 0,
        pollIntervalMs: 1,
        stopTimeoutMs: 1,
        forceKillTimeoutMs: 1,
      },
    });
    const ready = master.ensure();
    socket = true;
    await ready;
    await expect(master.stop()).rejects.toThrow("did not exit");
    expect(signals).toEqual([undefined, 9]);
  });
});

describe.skipIf(process.platform === "win32")("orphaned master sweep", () => {
  const roots: string[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise((resolve) => server.close(resolve))),
    );
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function runtimeDirectory(
    root: string,
    name: string,
    options: { owner?: number; mode?: number; socket?: boolean } = {},
  ) {
    const directory = join(root, name);
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, options.mode ?? 0o700);
    if (options.owner !== undefined) {
      writeFileSync(join(directory, "owner.pid"), `${options.owner}\n`);
    }
    if (options.socket !== false) {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolve) =>
        server.listen(join(directory, "m.ctl"), resolve),
      );
    }
    return directory;
  }

  test("ends masters only in private runtime directories of a dead Roamgate", async () => {
    const root = mkdtempSync("/tmp/rg-sweep-test-");
    roots.push(root);
    const deadPid = 2 ** 22 + 17;
    const orphan = await runtimeDirectory(root, "roamgate-ssh-Orph01", {
      owner: deadPid,
    });
    const kept = [
      // Another Roamgate on this account still runs.
      await runtimeDirectory(root, "roamgate-ssh-Live01", {
        owner: process.pid,
      }),
      // No owner record: not provably orphaned.
      await runtimeDirectory(root, "roamgate-ssh-NoOwn1"),
      // Not private.
      await runtimeDirectory(root, "roamgate-ssh-Open01", {
        owner: deadPid,
        mode: 0o755,
      }),
      // Not a runtime directory name.
      await runtimeDirectory(root, "other-ssh-Orph01", { owner: deadPid }),
    ];
    // A symlink to an orphan-looking directory is not followed.
    const elsewhere = mkdtempSync("/tmp/rg-sweep-target-");
    roots.push(elsewhere);
    const target = await runtimeDirectory(elsewhere, "roamgate-ssh-Targ01", {
      owner: deadPid,
    });
    symlinkSync(target, join(root, "roamgate-ssh-Link01"));

    const exits: string[][] = [];
    const options = {
      root,
      isProcessAlive: (pid: number) => pid === process.pid,
      runExit: async (argv: string[]) => {
        exits.push(argv);
        return 0;
      },
    };
    // Someone else's directories are never touched.
    expect(
      await sweepOrphanedSshMasters({
        ...options,
        uid: process.getuid!() + 1,
      }),
    ).toBe(0);
    expect(exits).toEqual([]);

    expect(await sweepOrphanedSshMasters(options)).toBe(1);
    expect(exits).toEqual([
      [
        "ssh",
        "-F",
        "/dev/null",
        "-S",
        join(orphan, "m.ctl"),
        "-O",
        "exit",
        "--",
        "roamgate-orphaned-master",
      ],
    ]);
    expect(existsSync(orphan)).toBeFalse();
    for (const directory of [...kept, target]) {
      expect(existsSync(join(directory, "m.ctl"))).toBeTrue();
    }
  });
});
