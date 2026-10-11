import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { Readable } from "node:stream";
import { sshCommandArgv } from "./ssh-command";
import {
  classifySshTunnelFailure,
  readBoundedStderr,
  SshTunnelError,
  type RunProcess,
  type SshTunnelConfig,
  type SshTunnelManager,
} from "./ssh-tunnel";

const SSH_KEEPALIVE_ARGS = [
  "-o",
  "ServerAliveInterval=20",
  "-o",
  "ServerAliveCountMax=3",
] as const;

export function powershellCommand(script: string): string {
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function windowsHerdrBridgeCommand(
  path: string,
  session: string,
  kind: "control" | "client",
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(session))
    throw new Error("Invalid Windows Herdr session name");
  const command =
    kind === "control" ? "remote-api-bridge" : "remote-client-bridge";
  // Inherit native stdio: PowerShell's & pipeline corrupts binary terminal frames.
  return powershellCommand(
    `$p = Start-Process -FilePath ${psQuote(path)} -ArgumentList ${psQuote(`--session ${session} ${command}`)} -NoNewWindow -PassThru -ErrorAction Stop; $null = $p.Handle; $p.WaitForExit(); exit $p.ExitCode`,
  );
}

export function createWindowsSshTunnel(args: {
  config: SshTunnelConfig;
  runProcess: RunProcess;
  onUnexpectedExit?: (error: SshTunnelError) => void;
  spawnBridge?: (argv: string[]) => ChildProcessWithoutNullStreams;
}): SshTunnelManager {
  const { config } = args;
  const servers = new Set<Server>();
  const sockets = new Set<Socket>();
  const children = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  let disposed = false;
  let stopping = false;
  let starting: Promise<void> | null = null;
  let cleanup: Promise<void> | null = null;
  let stopTask: Promise<void> | null = null;

  async function stop(): Promise<void> {
    if (stopTask) return stopTask;
    stopping = true;
    stopTask = (async () => {
      const closed = [...servers].map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      );
      servers.clear();
      for (const socket of sockets) socket.destroy();
      const processes = [...children];
      for (const [child] of processes) child.kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exited = Promise.all(processes.map(([, exited]) => exited));
      try {
        await Promise.race([
          exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              for (const [child] of processes) child.kill("SIGKILL");
              resolve();
            }, 1500);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      try {
        await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Windows SSH bridges did not exit")),
              1000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      await Promise.all(closed);
      for (const path of [config.socketPath, config.clientSocketPath])
        rmSync(path, { force: true });
    })();
    try {
      await stopTask;
    } finally {
      stopTask = null;
    }
  }

  async function resolveHerdr(): Promise<string> {
    const path = config.remoteHerdrPath
      ? `$path = ${psQuote(config.remoteHerdrPath)}`
      : "$command = Get-Command herdr.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; $path = if ($command) { $command.Source } else { Join-Path $env:LOCALAPPDATA 'Programs\\Herdr\\bin\\herdr.exe' }";
    const command = powershellCommand(
      `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ${path}; if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw 'roamgate-windows-herdr-unavailable' }; $check = & $path remote-api-bridge --check; if ($LASTEXITCODE -ne 0 -or $check -ne 'herdr-api-bridge-v1') { throw 'roamgate-windows-herdr-unavailable' }; $status = & $path --session ${psQuote(config.session ?? "default")} status server --json; if ($LASTEXITCODE -ne 0 -or !($status | ConvertFrom-Json).running) { throw 'roamgate-windows-session-unavailable' }; [Console]::Out.WriteLine('roamgate-herdr-path:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($path)))`,
    );
    try {
      const { stdout } = await args.runProcess(
        sshCommandArgv(config.sshHost!, command, SSH_KEEPALIVE_ARGS),
      );
      const encoded = stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith("roamgate-herdr-path:"))
        ?.slice("roamgate-herdr-path:".length);
      if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
        throw new Error("roamgate-windows-herdr-unavailable");
      const resolved = Buffer.from(encoded, "base64").toString("utf8");
      if (
        resolved.length > 1024 ||
        !/^[A-Za-z]:\\[^\u0000-\u001f\u007f-\u009f]+\.exe$/i.test(resolved)
      )
        throw new Error("roamgate-windows-herdr-unavailable");
      return resolved;
    } catch (error) {
      const diagnostic = String(error);
      if (diagnostic.includes("roamgate-windows-session-unavailable"))
        throw new SshTunnelError(
          "The selected Windows Herdr session is not running. Start it on the remote host before connecting.",
          true,
          "unreachable",
          -1,
        );
      if (
        !diagnostic.includes("roamgate-windows-herdr-unavailable") &&
        !/powershell\.exe['":\s]+(?:is not recognized|(?:command )?not found)/i.test(
          diagnostic,
        )
      )
        throw classifySshTunnelFailure(-1, diagnostic);
      throw new SshTunnelError(
        "Windows SSH requires Windows PowerShell and Herdr 0.9.1+ with remote-api-bridge. Install it on the remote host or set its executable path.",
        false,
        "unsupported",
        -1,
      );
    }
  }

  async function listen(path: string, command: string): Promise<void> {
    if (disposed) return;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      if (disposed || stopping) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
      const [program, ...argv] = sshCommandArgv(
        config.sshHost!,
        command,
        SSH_KEEPALIVE_ARGS,
      );
      const child = args.spawnBridge
        ? args.spawnBridge([program, ...argv])
        : spawn(program, argv, {
            stdio: "pipe",
            env: { ...process.env, LC_ALL: "C" },
          });
      const stderr = readBoundedStderr(
        Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>,
      ).catch(() => "");
      const exited = new Promise<void>((resolve) => {
        child.once("error", () => socket.destroy());
        child.once("close", (code) => {
          const report =
            !disposed && !stopping && !socket.destroyed && code !== 0;
          children.delete(child);
          if (code === 0) socket.end();
          else socket.destroy();
          resolve();
          if (report)
            void stderr.then((text) =>
              args.onUnexpectedExit?.(
                classifySshTunnelFailure(code ?? -1, text),
              ),
            );
        });
      });
      children.set(child, exited);
      child.stdin.on("error", () => socket.destroy());
      child.stdout.on("error", () => socket.destroy());
      socket.once("close", () => {
        sockets.delete(socket);
        child.kill();
      });
      socket.pipe(child.stdin);
      child.stdout.pipe(socket, { end: false });
    });
    servers.add(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    server.on("error", () =>
      args.onUnexpectedExit?.(
        new SshTunnelError("Windows SSH listener failed", true, "exited", -1),
      ),
    );
  }

  function startAutoSshTunnel(): Promise<void> {
    if (disposed)
      return Promise.reject(new Error("SSH tunnel manager is disposed"));
    if (starting) return starting;
    const task = (async () => {
      await stop();
      stopping = false;
      const path = await resolveHerdr();
      if (disposed) return;
      const session = config.session ?? "default";
      try {
        await listen(
          config.socketPath,
          windowsHerdrBridgeCommand(path, session, "control"),
        );
        await listen(
          config.clientSocketPath,
          windowsHerdrBridgeCommand(path, session, "client"),
        );
      } catch (error) {
        await stop();
        throw error;
      }
    })();
    starting = task;
    void task.then(
      () => {
        if (starting === task) starting = null;
      },
      () => {
        if (starting === task) starting = null;
      },
    );
    return task;
  }

  function cleanupAutoSshTunnel(): Promise<void> {
    if (cleanup) return cleanup;
    disposed = true;
    cleanup = (async () => {
      await starting?.catch(() => undefined);
      await stop();
      if (config.ownedRuntimeDirectory)
        rmSync(config.ownedRuntimeDirectory, { recursive: true, force: true });
    })();
    return cleanup;
  }

  return { startAutoSshTunnel, cleanupAutoSshTunnel };
}
