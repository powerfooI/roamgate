import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import {
  createWindowsSshTunnel,
  windowsHerdrBridgeCommand,
} from "./ssh-windows";
import type { SshTunnelError } from "./ssh-tunnel";

const herdrPath = String.raw`C:\Herdr O'Brien\herdr.exe`;

function config() {
  const directory = mkdtempSync("/tmp/roamgate-stdio-test-");
  return {
    socketPath: `${directory}/control.sock`,
    clientSocketPath: `${directory}/render.sock`,
    ownedRuntimeDirectory: directory,
    sshHost: "windows-host",
    session: "isolated-session",
    remotePlatform: "windows" as const,
    remoteHerdrPath: herdrPath,
    hasExplicitSocketPath: false,
    hasExplicitClientSocketPath: false,
  };
}

function discovered() {
  return {
    stdout: `roamgate-herdr-path:${Buffer.from(herdrPath).toString("base64")}\r\n`,
    stderr: "",
  };
}

describe.skipIf(process.platform === "win32")(
  "Windows SSH stdio transport",
  () => {
    test("quotes executable paths and selects both bridges without a PowerShell pipeline", () => {
      for (const kind of ["control", "client"] as const) {
        const command = windowsHerdrBridgeCommand(
          herdrPath,
          "isolated-session",
          kind,
        );
        const script = Buffer.from(
          command.split(" ").at(-1)!,
          "base64",
        ).toString("utf16le");
        expect(script).toContain("-FilePath 'C:\\Herdr O''Brien\\herdr.exe'");
        expect(script).toContain(
          `--session isolated-session remote-${kind === "control" ? "api" : "client"}-bridge`,
        );
        expect(script).toContain("-NoNewWindow");
        expect(script).not.toContain("& ");
      }
      expect(() =>
        windowsHerdrBridgeCommand(herdrPath, "default --update", "client"),
      ).toThrow("session");
    });

    test("preserves binary data on both channels and terminates active children on cleanup", async () => {
      const settings = config();
      const children: ReturnType<typeof spawn>[] = [];
      const manager = createWindowsSshTunnel({
        config: settings,
        runProcess: async () => discovered(),
        spawnBridge: (argv) => {
          expect(argv).toContain("BatchMode=yes");
          expect(argv).toContain("StrictHostKeyChecking=yes");
          expect(argv).toContain("ServerAliveCountMax=3");
          const child = spawn(
            process.execPath,
            ["-e", "process.stdin.pipe(process.stdout)"],
            { stdio: "pipe" },
          );
          children.push(child);
          return child;
        },
      });
      try {
        await manager.startAutoSshTunnel();
        for (const path of [settings.socketPath, settings.clientSocketPath]) {
          const socket = createConnection(path);
          socket.on("error", () => undefined);
          const bytes = Buffer.from([0, 255, 128, 13, 10, 27, 65]);
          const received = once(socket, "data");
          socket.write(bytes);
          expect((await received)[0]).toEqual(bytes);
          socket.destroy();
        }
        const active = createConnection(settings.clientSocketPath);
        active.on("error", () => undefined);
        await once(active, "connect");
        const closed = once(active, "close");
        await manager.cleanupAutoSshTunnel();
        await closed;
        expect(
          children.every(
            (child) => child.exitCode !== null || child.signalCode !== null,
          ),
        ).toBeTrue();
        expect(existsSync(settings.ownedRuntimeDirectory)).toBeFalse();
      } finally {
        await manager.cleanupAutoSshTunnel();
      }
    });

    test("reports authentication failures without leaking stderr", async () => {
      const settings = config();
      let report!: (error: SshTunnelError) => void;
      const failure = new Promise<SshTunnelError>((resolve) => {
        report = resolve;
      });
      const manager = createWindowsSshTunnel({
        config: settings,
        runProcess: async () => discovered(),
        onUnexpectedExit: report,
        spawnBridge: () =>
          spawn(
            process.execPath,
            [
              "-e",
              "process.stderr.write('Permission denied (publickey). private detail'); process.exit(255)",
            ],
            { stdio: "pipe" },
          ),
      });
      try {
        await manager.startAutoSshTunnel();
        const socket = createConnection(settings.socketPath);
        socket.on("error", () => undefined);
        expect(await failure).toMatchObject({
          kind: "authentication",
          retryable: false,
        });
        socket.destroy();
      } finally {
        await manager.cleanupAutoSshTunnel();
      }
    });

    test("cleanup during discovery prevents late listeners", async () => {
      const settings = config();
      let resolve!: (value: ReturnType<typeof discovered>) => void;
      const manager = createWindowsSshTunnel({
        config: settings,
        runProcess: () =>
          new Promise((done) => {
            resolve = done;
          }),
      });
      const starting = manager.startAutoSshTunnel();
      // Discovery begins after stop() has settled.
      while (!resolve) await Promise.resolve();
      const cleanup = manager.cleanupAutoSshTunnel();
      resolve(discovered());
      await Promise.all([starting, cleanup]);
      expect(existsSync(settings.ownedRuntimeDirectory)).toBeFalse();
    });

    test("rejects unavailable bridges permanently without starting listeners", async () => {
      const settings = config();
      const manager = createWindowsSshTunnel({
        config: settings,
        runProcess: async () => {
          throw new Error("roamgate-windows-herdr-unavailable");
        },
      });
      try {
        await expect(manager.startAutoSshTunnel()).rejects.toMatchObject({
          kind: "unsupported",
          retryable: false,
        });
        expect(existsSync(settings.socketPath)).toBeFalse();
      } finally {
        await manager.cleanupAutoSshTunnel();
      }
    });

    test.each([
      "ssh exited 255: kex_exchange_identification: read: Connection reset by peer",
      "ssh exited 255: Connection closed by remote host",
      "ssh exited 255: client_loop: send disconnect: Broken pipe",
    ])("keeps transient preflight failures retryable: %s", async (message) => {
      const settings = config();
      const manager = createWindowsSshTunnel({
        config: settings,
        runProcess: async () => {
          throw new Error(message);
        },
      });
      try {
        await expect(manager.startAutoSshTunnel()).rejects.toMatchObject({
          kind: "exited",
          retryable: true,
        });
        expect(existsSync(settings.socketPath)).toBeFalse();
      } finally {
        await manager.cleanupAutoSshTunnel();
      }
    });

    test.each([
      "ssh exited 1: 'powershell.exe' is not recognized as an internal or external command",
      "ssh exited 127: powershell.exe: command not found",
    ])("rejects missing PowerShell permanently: %s", async (message) => {
      const settings = config();
      const manager = createWindowsSshTunnel({
        config: settings,
        runProcess: async () => {
          throw new Error(message);
        },
      });
      try {
        await expect(manager.startAutoSshTunnel()).rejects.toMatchObject({
          kind: "unsupported",
          retryable: false,
        });
        expect(existsSync(settings.socketPath)).toBeFalse();
      } finally {
        await manager.cleanupAutoSshTunnel();
      }
    });

    test("classifies a stopped session as retryable without starting listeners", async () => {
      const settings = config();
      const manager = createWindowsSshTunnel({
        config: settings,
        runProcess: async () => {
          throw new Error("roamgate-windows-session-unavailable");
        },
      });
      try {
        await expect(manager.startAutoSshTunnel()).rejects.toMatchObject({
          kind: "unreachable",
          retryable: true,
        });
        expect(existsSync(settings.socketPath)).toBeFalse();
      } finally {
        await manager.cleanupAutoSshTunnel();
      }
    });
  },
);
