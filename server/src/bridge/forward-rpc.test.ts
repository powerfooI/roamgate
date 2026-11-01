/// <reference types="bun-types" />

import { afterEach, describe, expect, jest, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ServerWebSocket } from "bun";
import {
  createForwardRpcHandler,
  FORWARD_SCAN_TIMEOUT_MS,
  MAX_FORWARD_CANDIDATES,
} from "./forward-rpc";
import {
  createSshForwards,
  LISTENING_PORTS_COMMAND,
  MAX_LIVE_FORWARDS,
  roamgateOwnPorts,
  type ForwardProcess,
  type SshForwards,
} from "./ssh-forward";

const ws = {} as ServerWebSocket<unknown>;

function fakeProcess() {
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    exit = resolve;
  });
  const stderrListeners: ((text: string) => void)[] = [];
  const killed: number[] = [];
  const proc: ForwardProcess = {
    exited,
    stderr: Promise.resolve("bind: Address already in use"),
    kill: (signal) => {
      killed.push(signal ?? 0);
      exit(143);
    },
    onStderr: (listener) => stderrListeners.push(listener),
  };
  return {
    proc,
    exit,
    killed,
    say: (text: string) => stderrListeners.forEach((l) => l(text)),
  };
}

function harness(
  forwards: SshForwards,
  options: {
    sshHost?: string;
    runProcess?: (
      argv: string[],
    ) => Promise<{ stdout: string; stderr: string }>;
  } = {},
) {
  const sent: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const handle = createForwardRpcHandler({
    sshHost: () => ("sshHost" in options ? options.sshHost : "user@desktop"),
    runProcess:
      options.runProcess ?? (async () => ({ stdout: "", stderr: "" })),
    forwards,
    safeSend: (_ws, payload) => {
      sent.push(JSON.parse(payload));
      return true;
    },
    markRpcError: (_ws, _id, detail) => {
      if (detail) errors.push(detail);
    },
  });
  const call = async (
    method: string,
    params: Record<string, unknown> = {},
    requestIsCurrent: () => boolean = () => true,
  ) => {
    await handle(ws, "1", method, params, requestIsCurrent);
    return sent.at(-1) as {
      result?: Record<string, any>;
      error?: { message: string };
    };
  };
  return { call, sent, errors };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("forward.open readiness", () => {
  test("a local forward is reported open only once its port accepts connections", async () => {
    const fake = fakeProcess();
    let bound = false;
    let probes = 0;
    const forwards = createSshForwards({
      spawn: () => fake.proc,
      isPortFree: () => true,
      probePort: async () => {
        probes += 1;
        if (probes === 3) bound = true;
        return bound;
      },
      pollIntervalMs: 0,
    });
    const reply = await harness(forwards).call("forward.open", {
      remote_port: 5173,
    });
    expect(bound).toBe(true);
    expect(reply.result?.forward).toMatchObject({
      local_port: 5173,
      state: "open",
    });
  });

  test("a remote forward waits for ssh's confirmation of the far bind", async () => {
    const fake = fakeProcess();
    const forwards = createSshForwards({
      spawn: () => fake.proc,
      isPortFree: () => true,
    });
    const { call } = harness(forwards);
    let settled = false;
    const pending = call("forward.open", {
      remote_port: 11434,
      direction: "remote",
    }).then((reply) => {
      settled = true;
      return reply;
    });
    await tick();
    fake.say("debug1: Authentication succeeded (publickey).\n");
    // Another port's confirmation is not ours.
    fake.say("debug1: remote forward success for: listen 127.0.0.1:9999, ");
    fake.say("connect localhost:9999\n");
    await tick();
    expect(settled).toBe(false);
    expect(forwards.list()[0].state).toBe("starting");
    // Split across chunks, as a pipe is free to deliver it.
    fake.say("debug1: remote forward success for: listen 127.0.0.1:11");
    fake.say("434, connect localhost:11434\n");
    expect((await pending).result?.forward.state).toBe("open");
  });

  test("a forward whose ssh exits is reported failed with ssh's reason", async () => {
    const fake = fakeProcess();
    const forwards = createSshForwards({
      spawn: () => fake.proc,
      isPortFree: () => true,
      probePort: async () => false,
      pollIntervalMs: 0,
    });
    const pending = harness(forwards).call("forward.open", {
      remote_port: 5173,
    });
    await tick();
    fake.exit(255);
    const reply = await pending;
    expect(reply.error?.message).toBeTruthy();
    expect(forwards.list()[0].state).toBe("failed");
  });

  test("a forward that never becomes ready is killed at the deadline", async () => {
    jest.useFakeTimers();
    try {
      const fake = fakeProcess();
      const forwards = createSshForwards({
        spawn: () => fake.proc,
        isPortFree: () => true,
        readyTimeoutMs: 20_000,
      });
      const pending = harness(forwards).call("forward.open", {
        remote_port: 11434,
        direction: "remote",
      });
      await Promise.resolve();
      jest.advanceTimersByTime(20_000);
      const reply = await pending;
      expect(reply.error?.message).toContain("not ready");
      expect(fake.killed.length).toBe(1);
      expect(forwards.list()[0].state).toBe("failed");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("forward.open against a real ssh process", () => {
  // A stand-in ssh on PATH that binds (or confirms) only after a delay longer
  // than any fixed grace period would allow, so the reply must wait for it.
  const created: string[] = [];
  const previousPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = previousPath;
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true });
  });

  function installFakeSsh() {
    const dir = mkdtempSync(join(tmpdir(), "roamgate-fake-ssh-"));
    created.push(dir);
    const marker = join(dir, "bound");
    const listener = join(dir, "listen.js");
    writeFileSync(
      listener,
      `const port = Number(process.argv[2]);
Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
await Bun.write(${JSON.stringify(marker)}, "");
setInterval(() => {}, 1000);
`,
    );
    writeFileSync(
      join(dir, "ssh"),
      `#!/bin/sh
mode=""; spec=""
while [ $# -gt 0 ]; do
  case "$1" in
    -L|-R) mode="$1"; spec="$2"; shift 2 ;;
    *) shift ;;
  esac
done
port=$(echo "$spec" | cut -d: -f2)
sleep 0.6
if [ "$mode" = "-R" ]; then
  : > ${JSON.stringify(marker)}
  echo "debug1: remote forward success for: listen 127.0.0.1:$port, connect localhost:$port" >&2
  exec sleep 30
fi
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(listener)} "$port"
`,
    );
    chmodSync(join(dir, "ssh"), 0o755);
    process.env.PATH = `${dir}:${previousPath}`;
    return marker;
  }

  function freePort() {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const port = server.port;
    server.stop(true);
    return port;
  }

  async function connects(port: number) {
    try {
      const socket = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: { data() {} },
      });
      socket.end();
      return true;
    } catch {
      return false;
    }
  }

  test.skipIf(process.platform === "win32")(
    "a local forward that binds late is reported open only once it is reachable",
    async () => {
      const marker = installFakeSsh();
      const port = freePort();
      const forwards = createSshForwards({});
      try {
        const reply = await harness(forwards).call("forward.open", {
          remote_port: port,
        });
        expect(reply.result?.forward.state).toBe("open");
        expect(existsSync(marker)).toBe(true);
        expect(await connects(reply.result?.forward.local_port)).toBe(true);
      } finally {
        forwards.closeAll();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "a remote forward is reported open only after ssh confirms it",
    async () => {
      const marker = installFakeSsh();
      const forwards = createSshForwards({});
      try {
        const reply = await harness(forwards).call("forward.open", {
          remote_port: freePort(),
          direction: "remote",
        });
        expect(reply.result?.forward.state).toBe("open");
        expect(existsSync(marker)).toBe(true);
      } finally {
        forwards.closeAll();
      }
    },
  );
});

describe("forward.candidates", () => {
  test("a failed scan lists nothing instead of failing the request", async () => {
    const forwards = createSshForwards({ spawn: () => fakeProcess().proc });
    const { call } = harness(forwards, {
      runProcess: async () => {
        throw new Error("netstat exited 64: illegal option -- l");
      },
    });
    for (const direction of ["local", "remote"]) {
      const reply = await call("forward.candidates", { direction });
      expect(reply.error).toBeUndefined();
      expect(reply.result?.candidates).toEqual([]);
    }
  });
});

describe("Roamgate's own ports", () => {
  const scan = [
    'LISTEN 0 511 127.0.0.1:8787 0.0.0.0:* users:(("roamgate",pid=7,fd=7))',
    'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=8,fd=7))',
    'LISTEN 0 511 127.0.0.1:11434 0.0.0.0:* users:(("ollama",pid=9,fd=7))',
  ].join("\n");

  test("are neither offered nor opened as remote forwards", async () => {
    let spawns = 0;
    const forwards = createSshForwards({
      spawn: () => {
        spawns += 1;
        return fakeProcess().proc;
      },
      reservedPorts: () => roamgateOwnPorts(8787, true),
    });
    const { call } = harness(forwards, {
      runProcess: async () => ({ stdout: scan, stderr: "" }),
    });
    const remote = await call("forward.candidates", { direction: "remote" });
    expect(remote.result?.candidates).toEqual([
      { port: 11434, process: "ollama" },
    ]);
    // Bringing a remote 8787 here exposes nothing of ours, so it stays.
    const local = await call("forward.candidates", { direction: "local" });
    expect(
      local.result?.candidates.map((c: { port: number }) => c.port),
    ).toEqual([5173, 8787, 11434]);

    for (const port of [8787, 5173]) {
      const reply = await call("forward.open", {
        remote_port: port,
        direction: "remote",
      });
      expect(reply.error?.message).toContain("Roamgate's own");
    }
    expect(spawns).toBe(0);
  });

  test("the Vite port is Roamgate's only in development", () => {
    expect(roamgateOwnPorts(8787, false)).toEqual([8787]);
    expect(roamgateOwnPorts(8788, true)).toEqual([8788, 5173]);
  });
});

describe("forward.open racing a disposed connection", () => {
  test("a request already stale spawns nothing", async () => {
    let spawns = 0;
    const forwards = createSshForwards({
      spawn: () => {
        spawns += 1;
        return fakeProcess().proc;
      },
      isPortFree: () => true,
    });
    const reply = await harness(forwards).call(
      "forward.open",
      { remote_port: 5173 },
      () => false,
    );
    expect(reply.error?.message).toBeTruthy();
    expect(spawns).toBe(0);
    expect(forwards.list()).toEqual([]);
  });

  test("a connection disposed while ssh starts leaves no ssh behind", async () => {
    const fake = fakeProcess();
    let current = true;
    const forwards = createSshForwards({
      spawn: () => fake.proc,
      isPortFree: () => true,
      probePort: async () => {
        // The runtime is disposed (and swept its forwards) mid-startup.
        current = false;
        return true;
      },
    });
    const reply = await harness(forwards).call(
      "forward.open",
      { remote_port: 5173 },
      () => current,
    );
    expect(reply.error?.message).toBeTruthy();
    expect(fake.killed.length).toBe(1);
    expect(forwards.list()).toEqual([]);
  });

  test("a stale request leaves a forward opened since alone", async () => {
    const first = fakeProcess();
    const second = fakeProcess();
    const procs = [first.proc, second.proc];
    let staleOpen!: () => void;
    const forwards = createSshForwards({
      spawn: () => procs.shift()!,
      isPortFree: () => true,
      probePort: () =>
        new Promise<boolean>((resolve) => {
          staleOpen ??= () => resolve(true);
          if (procs.length === 0) resolve(true);
        }),
    });
    let current = true;
    const { call } = harness(forwards);
    const stale = call("forward.open", { remote_port: 5173 }, () => current);
    await tick();
    // The runtime is replaced: its forward is swept and the new one reopens
    // the same port.
    current = false;
    forwards.loseConnection("");
    const fresh = await call("forward.open", { remote_port: 5173 });
    expect(fresh.result?.forward.state).toBe("open");
    staleOpen();
    expect((await stale).error?.message).toBeTruthy();
    expect(second.killed).toEqual([]);
    expect(forwards.list()[0].state).toBe("open");
  });
});

describe("bounded discovery and forwards", () => {
  test("concurrent scans share one process, with a deadline, and a capped list", async () => {
    const forwards = createSshForwards({ spawn: () => fakeProcess().proc });
    const runs: { argv: string[]; timeoutMs?: number }[] = [];
    let finish!: (stdout: string) => void;
    const { call } = createScanHarness(forwards, (argv, options) => {
      runs.push({ argv, timeoutMs: options?.timeoutMs });
      return new Promise((resolve) => {
        finish = (stdout) => resolve({ stdout, stderr: "" });
      });
    });
    const first = call("forward.candidates", { direction: "local" });
    const second = call("forward.candidates", { direction: "local" });
    await tick();
    expect(runs.length).toBe(1);
    expect(runs[0].timeoutMs).toBe(FORWARD_SCAN_TIMEOUT_MS);
    // Whatever the remote login shell is, the chain runs under sh.
    expect(runs[0].argv.at(-1)).toBe(`sh -c '${LISTENING_PORTS_COMMAND}'`);
    const lines = Array.from(
      { length: MAX_FORWARD_CANDIDATES + 20 },
      (_, i) =>
        `LISTEN 0 511 127.0.0.1:${20000 + i} 0.0.0.0:* users:(("node",pid=1,fd=1))`,
    );
    finish(lines.join("\n"));
    for (const reply of [await first, await second]) {
      expect(reply.result?.candidates.length).toBe(MAX_FORWARD_CANDIDATES);
      expect(reply.result?.candidates[0].port).toBe(20000);
    }
  });

  test("the server refuses forwards past its cap", () => {
    const forwards = createSshForwards({
      spawn: () => fakeProcess().proc,
      isPortFree: () => true,
    });
    for (let i = 0; i < MAX_LIVE_FORWARDS; i++) {
      forwards.open({
        connectionId: "desktop",
        destination: "user@desktop",
        port: 20000 + i * 100,
      });
    }
    expect(() =>
      forwards.open({
        connectionId: "desktop",
        destination: "user@desktop",
        port: 30000,
      }),
    ).toThrow(`Already forwarding ${MAX_LIVE_FORWARDS} ports`);
    // A port already forwarded is still answered: that is not a new one.
    expect(
      forwards.open({
        connectionId: "desktop",
        destination: "user@desktop",
        port: 20000,
      }).state,
    ).toBe("starting");
  });
});

function createScanHarness(
  forwards: SshForwards,
  runProcess: (
    argv: string[],
    options?: { timeoutMs?: number },
  ) => Promise<{ stdout: string; stderr: string }>,
) {
  const sent: Record<string, any>[] = [];
  const handle = createForwardRpcHandler({
    sshHost: () => "user@desktop",
    runProcess: (argv, _input, options) => runProcess(argv, options),
    forwards,
    safeSend: (_ws, payload) => {
      sent.push(JSON.parse(payload));
      return true;
    },
    markRpcError: () => {},
  });
  return {
    call: async (method: string, params: Record<string, unknown>) => {
      const before = sent.length;
      await handle(ws, "1", method, params, () => true);
      return sent[before] as { result?: Record<string, any> };
    },
  };
}

describe("forward.list, forward.close and local connections", () => {
  test("lists and closes forwards in wire form", async () => {
    const fake = fakeProcess();
    const forwards = createSshForwards({
      spawn: () => fake.proc,
      isPortFree: () => true,
      probePort: async () => true,
    });
    const { call } = harness(forwards);
    const opened = await call("forward.open", {
      remote_port: 5173,
      label: "  vite  ",
    });
    expect(opened.result?.forward).toEqual({
      id: ":local:5173",
      connection_id: "",
      direction: "local",
      remote_port: 5173,
      local_port: 5173,
      label: "vite",
      state: "open",
    });
    expect((await call("forward.list")).result?.forwards).toHaveLength(1);
    expect((await call("forward.close", {})).error?.message).toContain(
      "requires id",
    );
    expect((await call("forward.close", { id: ":local:5173" })).result).toEqual(
      { closed: true },
    );
    expect(fake.killed.length).toBe(1);
    expect((await call("forward.list")).result?.forwards).toEqual([]);
  });

  test("a connection without an SSH transport is refused", async () => {
    const forwards = createSshForwards({ spawn: () => fakeProcess().proc });
    const reply = await harness(forwards, { sshHost: undefined }).call(
      "forward.open",
      { remote_port: 5173 },
    );
    expect(reply.error?.message).toContain("SSH connections");
  });

  test("an invalid port is refused before anything starts", async () => {
    const forwards = createSshForwards({ spawn: () => fakeProcess().proc });
    const reply = await harness(forwards).call("forward.open", {
      remote_port: 70000,
    });
    expect(reply.error?.message).toContain("Invalid port");
    expect(forwards.list()).toEqual([]);
  });
});

test("the global forward registry can be closed while a local profile is active", async () => {
  const fake = fakeProcess();
  const forwards = createSshForwards({
    spawn: () => fake.proc,
    isPortFree: () => true,
  });
  const record = forwards.open({
    connectionId: "ssh-profile",
    destination: "user@host",
    port: 3000,
  });
  const h = harness(forwards, { sshHost: undefined });
  const result = await h.call("forward.close", { id: record.id });
  try {
    expect(result.result).toEqual({ closed: true });
    expect(fake.killed).toHaveLength(1);
    expect(forwards.list()).toHaveLength(0);
  } finally {
    forwards.closeAll();
  }
});
