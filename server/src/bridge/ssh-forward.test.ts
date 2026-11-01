/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import {
  FORWARD_BIND_HOST,
  chooseLocalPort,
  createSshForwards,
  defaultPortIsFree,
  forwardId,
  ownedListeningPorts,
  LISTENING_PORTS_COMMAND,
  parseListeningPorts,
  sshForwardArgv,
  validateForwardPort,
  type ForwardProcess,
} from "./ssh-forward";

function deferredProcess() {
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    exit = resolve;
  });
  const killed: number[] = [];
  const proc: ForwardProcess = {
    exited,
    stderr: Promise.resolve("bind: Address already in use"),
    kill: (signal) => killed.push(signal ?? 0),
  };
  return { proc, exit, killed };
}

describe("forward argv", () => {
  test("binds loopback locally and resolves localhost on the far host", () => {
    const argv = sshForwardArgv("user@host", 5173, 3000);
    expect(argv).toContain("-N");
    expect(argv).toContain("-L");
    // The far side of the pair is the remote's own localhost: that is where a
    // dev server printing http://localhost:3000 is actually listening.
    expect(argv).toContain(`${FORWARD_BIND_HOST}:5173:localhost:3000`);
    // A refused bind must exit rather than run on without the forward.
    expect(argv).toContain("ExitOnForwardFailure=yes");
    expect(argv[argv.length - 1]).toBe("user@host");
  });

  test("refuses a destination that is not a plain ssh target", () => {
    expect(() => sshForwardArgv("-oProxyCommand=evil", 1, 2)).toThrow();
  });
});

describe("port handling", () => {
  test("rejects anything outside a usable port", () => {
    expect(validateForwardPort(3000)).toBe(3000);
    expect(validateForwardPort("3000")).toBe(3000);
    for (const bad of [0, -1, 65536, 1.5, "http", null, undefined]) {
      expect(() => validateForwardPort(bad)).toThrow();
    }
  });

  test("prefers the remote's own number, then walks upwards", () => {
    expect(chooseLocalPort(3000, () => true)).toBe(3000);
    // The address in the terminal output is the address the user types, so
    // matching numbers matter more than picking anything free.
    expect(chooseLocalPort(3000, (port) => port >= 3002)).toBe(3002);
  });

  test("gives up rather than binding something wildly unrelated", () => {
    expect(() => chooseLocalPort(3000, () => false, 4)).toThrow(
      /No free local port/,
    );
  });
});

describe("forward supervisor", () => {
  test("reports a forward only once it has survived startup", () => {
    const { proc } = deferredProcess();
    const forwards = createSshForwards({
      spawn: () => proc,
      isPortFree: () => true,
    });
    const record = forwards.open({
      connectionId: "desktop",
      destination: "user@desktop",
      port: 5173,
    });

    expect(record).toMatchObject({
      id: forwardId("desktop", 5173),
      localPort: 5173,
      state: "starting",
    });
    forwards.markOpen(record.id);
    expect(forwards.list()[0].state).toBe("open");
  });

  test("a refused bind fails that forward alone, with ssh's reason", async () => {
    const first = deferredProcess();
    const second = deferredProcess();
    const spawned: ForwardProcess[] = [first.proc, second.proc];
    const forwards = createSshForwards({
      spawn: () => spawned.shift()!,
      isPortFree: () => true,
    });
    const changes: number[] = [];
    forwards.onChange((list) => changes.push(list.length));

    const a = forwards.open({
      connectionId: "desktop",
      destination: "user@desktop",
      port: 5173,
    });
    const b = forwards.open({
      connectionId: "desktop",
      destination: "user@desktop",
      port: 3000,
    });
    first.exit(255);
    // The exit handler awaits ssh's stderr before classifying, so let the
    // macrotask queue drain rather than guessing a microtask count.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const byId = new Map(forwards.list().map((r) => [r.id, r]));
    expect(byId.get(a.id)?.state).toBe("failed");
    expect(byId.get(a.id)?.error).toBeTruthy();
    // The sibling keeps running: one process each is the point.
    expect(byId.get(b.id)?.state).not.toBe("failed");
    expect(changes.length).toBeGreaterThan(0);
  });

  test("a second request for the same port reuses the live forward", () => {
    const { proc } = deferredProcess();
    let spawns = 0;
    const forwards = createSshForwards({
      spawn: () => {
        spawns++;
        return proc;
      },
      isPortFree: () => true,
    });
    const request = {
      connectionId: "desktop",
      destination: "user@desktop",
      port: 5173,
    };

    const first = forwards.open(request);
    const again = forwards.open(request);
    expect(spawns).toBe(1);
    expect(again.id).toBe(first.id);
    expect(forwards.list()).toHaveLength(1);
  });

  test("two forwards never land on the same local port", () => {
    const procs = [deferredProcess().proc, deferredProcess().proc];
    const forwards = createSshForwards({
      spawn: () => procs.shift()!,
      isPortFree: () => true,
    });
    forwards.open({
      connectionId: "a",
      destination: "user@a",
      port: 5173,
    });
    const second = forwards.open({
      connectionId: "b",
      destination: "user@b",
      port: 5173,
    });
    // Same remote number on two connections: the second has to move.
    expect(second.localPort).toBe(5174);
  });

  test("losing a connection kills its forwards, lists them lost, and leaves others alone", () => {
    const desktop = deferredProcess();
    const laptop = deferredProcess();
    const procs = [desktop.proc, laptop.proc];
    const forwards = createSshForwards({
      spawn: () => procs.shift()!,
      isPortFree: () => true,
    });
    forwards.open({
      connectionId: "desktop",
      destination: "user@desktop",
      port: 5173,
    });
    forwards.open({
      connectionId: "laptop",
      destination: "user@laptop",
      port: 8080,
    });

    forwards.loseConnection("desktop");
    expect(desktop.killed).toHaveLength(1);
    expect(laptop.killed).toHaveLength(0);
    const byConnection = new Map(
      forwards.list().map((r) => [r.connectionId, r]),
    );
    // Still listed, so a reconnect does not make it vanish unexplained.
    expect(byConnection.get("desktop")).toMatchObject({
      state: "failed",
      error: expect.stringContaining("Lost with its connection"),
    });
    expect(byConnection.get("laptop")?.state).toBe("starting");

    // Forwarding the port again replaces the lost entry.
    const desktopAgain = deferredProcess();
    procs.push(desktopAgain.proc);
    expect(
      forwards.open({
        connectionId: "desktop",
        destination: "user@desktop",
        port: 5173,
      }).state,
    ).toBe("starting");
    expect(forwards.list()).toHaveLength(2);
  });
});

describe("listening port discovery", () => {
  test("reads ss output, keeping loopback and wildcard listeners", () => {
    const output = [
      'LISTEN 0 4096 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=42,fd=23))',
      'LISTEN 0 4096 127.0.0.1:5174 0.0.0.0:* users:(("node",pid=42,fd=25))',
      'LISTEN 0 511 0.0.0.0:8787 0.0.0.0:* users:(("roamgate",pid=7,fd=7))',
      "LISTEN 0 128 [::1]:9229 [::]:* ",
    ].join("\n");

    expect(parseListeningPorts(output)).toEqual([
      { port: 5173, process: "node" },
      // The websocket beside the dev server: never printed as a URL, which is
      // the whole reason for scanning rather than reading output.
      { port: 5174, process: "node" },
      { port: 8787, process: "roamgate" },
      { port: 9229 },
    ]);
  });

  test("reads lsof output, as macOS has neither ss nor netstat -p", () => {
    const output = [
      "COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
      "node      41234 me     23u  IPv6 0x798e7cda42e3b5b1      0t0  TCP [::1]:5173 (LISTEN)",
      "node      41234 me     24u  IPv4 0x7671e0373c8cc6b2      0t0  TCP 127.0.0.1:5173 (LISTEN)",
      "ollama      566 me     12u  IPv4 0x96eeac0de9a49e53      0t0  TCP *:11434 (LISTEN)",
      "tailscale  1081 me     15u  IPv4 0x891a01d18e480c2e      0t0  TCP 100.64.0.2:54906 (LISTEN)",
    ].join("\n");
    expect(parseListeningPorts(output)).toEqual([
      { port: 5173, process: "node" },
      { port: 11434, process: "ollama" },
    ]);
  });

  test.skipIf(process.platform === "win32")(
    "the scan command finds a listener on this machine",
    async () => {
      // Run for real: on macOS a chain without lsof ends in a netstat that
      // rejects -ltnp and finds nothing.
      const server = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { data() {} },
      });
      try {
        const proc = Bun.spawn(["sh", "-c", LISTENING_PORTS_COMMAND], {
          stdout: "pipe",
          stderr: "ignore",
        });
        const stdout = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        expect(
          parseListeningPorts(stdout).map((entry) => entry.port),
        ).toContain(server.port);
      } finally {
        server.stop(true);
      }
    },
  );

  test("drops listeners that are already reachable without a tunnel", () => {
    const output = [
      "LISTEN 0 128 192.168.1.10:5432 0.0.0.0:*",
      "LISTEN 0 128 10.0.0.4:6379 0.0.0.0:*",
      "LISTEN 0 128 127.0.0.1:5432 0.0.0.0:*",
    ].join("\n");

    expect(parseListeningPorts(output).map((entry) => entry.port)).toEqual([
      5432,
    ]);
  });

  test("reads netstat output and its header", () => {
    const output = [
      "Active Internet connections (only servers)",
      "Proto Recv-Q Send-Q Local Address           Foreign Address         State",
      "tcp        0      0 127.0.0.1:3000          0.0.0.0:*               LISTEN",
      "tcp6       0      0 ::1:3001                :::*                    LISTEN",
    ].join("\n");

    expect(parseListeningPorts(output).map((entry) => entry.port)).toEqual([
      3000, 3001,
    ]);
  });

  test("reports each port once, preferring the line that names a process", () => {
    const output = [
      "LISTEN 0 128 0.0.0.0:3000 0.0.0.0:*",
      'LISTEN 0 128 [::]:3000 [::]:* users:(("api",pid=9,fd=3))',
    ].join("\n");

    expect(parseListeningPorts(output)).toEqual([
      { port: 3000, process: "api" },
    ]);
  });

  test("survives empty or unexpected output", () => {
    expect(parseListeningPorts("")).toEqual([]);
    expect(parseListeningPorts("ss: command not found")).toEqual([]);
  });
});

describe("narrowing a scan to what is worth offering", () => {
  // Taken from a real desktop: the daemons are unnamed because an
  // unprivileged user cannot see root's sockets, which is the whole signal.
  const scanned = parseListeningPorts(
    [
      "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*",
      "LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*",
      "LISTEN 0 128 127.0.0.1:631 0.0.0.0:*",
      "LISTEN 0 4096 0.0.0.0:5355 0.0.0.0:*",
      'LISTEN 0 511 0.0.0.0:5173 0.0.0.0:* users:(("node",pid=3537556,fd=31))',
      'LISTEN 0 512 0.0.0.0:3000 0.0.0.0:* users:(("gst-dots-viewer",pid=3684462,fd=13))',
      "LISTEN 0 128 127.0.0.1:9222 0.0.0.0:*",
    ].join("\n"),
  );

  test("keeps the ports the user started and drops the machine's own", () => {
    expect(ownedListeningPorts(scanned)).toEqual([
      { port: 3000, process: "gst-dots-viewer" },
      { port: 5173, process: "node" },
    ]);
  });

  test("keeps everything when nothing is named at all", () => {
    // ss without -p support: the split carries no information, so reporting
    // an empty machine would be worse than reporting noise.
    const unnamed = parseListeningPorts(
      [
        "LISTEN 0 511 127.0.0.1:5173 0.0.0.0:*",
        "LISTEN 0 128 127.0.0.1:3000 0.0.0.0:*",
      ].join("\n"),
    );
    expect(ownedListeningPorts(unnamed).map((entry) => entry.port)).toEqual([
      3000, 5173,
    ]);
  });
});

describe("reverse forwards", () => {
  test("a remote forward binds the far host's loopback, not its interfaces", () => {
    const argv = sshForwardArgv("user@host", 11434, 11434, "remote");
    expect(argv).toContain("-R");
    expect(argv).not.toContain("-L");
    // Explicit 127.0.0.1: honoured unless the far sshd sets GatewayPorts yes.
    // exposing our service to its network is not what was asked for.
    expect(argv).toContain("127.0.0.1:11434:localhost:11434");
  });

  test("the two directions are separate forwards on the same number", () => {
    expect(forwardId("desktop", 3000, "local")).not.toBe(
      forwardId("desktop", 3000, "remote"),
    );
  });

  test("a remote forward keeps the port asked for rather than moving it", () => {
    const procs = [deferredProcess().proc, deferredProcess().proc];
    const forwards = createSshForwards({
      spawn: () => procs.shift()!,
      // Taken here, which for a reverse tunnel is irrelevant: the port that
      // must be free belongs to the far host, and only ssh can say.
      isPortFree: () => false,
    });

    const reverse = forwards.open({
      connectionId: "desktop",
      destination: "user@desktop",
      port: 11434,
      direction: "remote",
    });
    expect(reverse.remotePort).toBe(11434);
    expect(reverse.localPort).toBe(11434);
    expect(reverse.direction).toBe("remote");
  });

  test("a local forward still moves off a taken port", () => {
    const procs = [deferredProcess().proc];
    const forwards = createSshForwards({
      spawn: () => procs.shift()!,
      isPortFree: (port) => port >= 3002,
    });
    expect(
      forwards.open({
        connectionId: "desktop",
        destination: "user@desktop",
        port: 3000,
      }).localPort,
    ).toBe(3002);
  });
});

describe("local port availability", () => {
  test("a port taken on ::1 alone is not free", () => {
    let server: { port: number; stop: (force?: boolean) => void };
    try {
      server = Bun.listen({ hostname: "::1", port: 0, socket: { data() {} } });
    } catch {
      return; // No IPv6 loopback on this machine: nothing to collide with.
    }
    try {
      // http://localhost:PORT would reach this listener, not the forward.
      expect(defaultPortIsFree(server.port)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("a port taken on 127.0.0.1 is not free", () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    try {
      expect(defaultPortIsFree(server.port)).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});

test("a spawn failure is failed immediately and does not retain a live slot", async () => {
  const forwards = createSshForwards({
    spawn: () => {
      throw new Error("spawn ssh ENOENT");
    },
    isPortFree: () => true,
  });
  try {
    const record = forwards.open({
      connectionId: "ssh",
      destination: "user@host",
      port: 3000,
    });
    expect(record.state).toBe("failed");
    expect((await forwards.waitUntilOpen(record.id))?.error).toContain(
      "ENOENT",
    );
    const retry = forwards.open({
      connectionId: "ssh",
      destination: "user@host",
      port: 3000,
    });
    expect(retry.state).toBe("failed");
  } finally {
    forwards.closeAll();
  }
});
