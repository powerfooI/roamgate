import { expect, test } from "bun:test";

// Run only against a disposable bridge with two dedicated Windows sessions.
const url = process.env.ROAMGATE_LIVE_WINDOWS_SSH_URL;
const sessions = [
  process.env.ROAMGATE_LIVE_WINDOWS_SSH_SESSION,
  process.env.ROAMGATE_LIVE_WINDOWS_SSH_OTHER_SESSION,
];
const live =
  url && sessions.every((session) => session?.startsWith("roamgate-ssh-"))
    ? test
    : test.skip;

live(
  "Windows SSH supports browser RPC, PowerShell, resize, reconnect, and session isolation",
  async () => {
    const target = new URL(url!);
    expect(["127.0.0.1", "localhost"]).toContain(target.hostname);
    const ws = new WebSocket(
      `${target.protocol === "https:" ? "wss" : "ws"}://${target.host}/ws`,
    );
    const pending = new Map<string, (message: any) => void>();
    const terminals: any[] = [];
    const listeners = new Set<() => void>();
    let sequence = 0;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === "string") pending.get(message.id)?.(message);
      if (message.terminal) {
        terminals.push(message);
        if (terminals.length > 200) terminals.shift();
        for (const listener of listeners) listener();
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });

    async function rpc(
      method: string,
      params: Record<string, unknown> = {},
      connection?: { id: string; generation: number },
    ) {
      const id = `live-${++sequence}`;
      let timer: ReturnType<typeof setTimeout>;
      const reply = new Promise<any>((resolve, reject) => {
        pending.set(id, resolve);
        timer = setTimeout(
          () => reject(new Error(`RPC timeout: ${method}`)),
          25_000,
        );
      });
      ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(connection
            ? {
                connection_id: connection.id,
                connection_generation: connection.generation,
              }
            : {}),
        }),
      );
      const message = await reply.finally(() => {
        clearTimeout(timer);
        pending.delete(id);
      });
      if (message.error) throw new Error(message.error.message);
      return message.result;
    }

    function terminalFrame(
      connectionId: string,
      predicate: (terminal: any) => boolean,
    ) {
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          const last = terminals.findLast(
            (message) => message.connection_id === connectionId,
          );
          reject(
            new Error(
              `Terminal frame timeout: ${connectionId}: ${last ? `${last.terminal.width}x${last.terminal.height} ` + Buffer.from(last.terminal.bytes, "base64").toString().slice(-1200) : "no frames"}`,
            ),
          );
        }, 20_000);
        function check() {
          const found = terminals.findLast(
            (message) =>
              message.connection_id === connectionId &&
              predicate(message.terminal),
          );
          if (!found) return;
          clearTimeout(timer);
          listeners.delete(check);
          resolve(found.terminal);
        }
        listeners.add(check);
        check();
      });
    }

    async function input(
      connection: { id: string; generation: number },
      terminalId: string,
      command: string,
      output: string,
    ) {
      const received = terminalFrame(connection.id, (terminal) =>
        Buffer.from(terminal.bytes, "base64")
          .toString()
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
          .includes(output),
      );
      try {
        await rpc(
          "terminal.input",
          {
            terminal_id: terminalId,
            data: Buffer.from(command).toString("base64"),
          },
          connection,
        );
        await rpc(
          "terminal.input",
          {
            terminal_id: terminalId,
            data: Buffer.from("\r").toString("base64"),
          },
          connection,
        );
        await received;
      } catch (error) {
        void received.catch(() => undefined);
        throw error;
      }
    }

    try {
      const catalog = await rpc("connections.list");
      const connections = sessions.map((session) =>
        catalog.connections.find(
          (connection: any) =>
            connection.remote_platform === "windows" &&
            connection.remote_session === session,
        ),
      );
      expect(connections.every(Boolean)).toBeTrue();
      for (const connection of connections)
        expect(connection.state).toBe("ready");
      const [first, second] = connections;
      expect(
        Array.isArray((await rpc("agent.list", {}, first)).agents),
      ).toBeTrue();
      await expect(
        rpc("file.list", { workspace_id: "w1" }, first),
      ).rejects.toThrow("Unix SSH host");
      const unsupportedTransfer = await fetch(
        `${target.origin}/api/connections/${first.id}/file/download?connection_generation=${first.generation}&workspace_id=w1&path=example.txt`,
      );
      expect(unsupportedTransfer.status).toBe(501);
      const terminalsByConnection: string[] = [];
      for (const connection of connections) {
        const result = await rpc("pane.list", {}, connection);
        expect(result.panes.length).toBeGreaterThan(0);
        const terminalId = result.panes[0].terminal_id;
        terminalsByConnection.push(terminalId);
        await rpc(
          "terminal.attach",
          { terminal_id: terminalId, cols: 90, rows: 28 },
          connection,
        );
        await terminalFrame(
          connection.id,
          (terminal) => terminal.terminal_id === terminalId,
        );
      }
      const token = crypto.randomUUID().replaceAll("-", "");
      await input(
        first,
        terminalsByConnection[0],
        `$env:ROAMGATE_E2E_TOKEN = 'ALPHA_' + '${token}'; Write-Output $env:ROAMGATE_E2E_TOKEN`,
        `ALPHA_${token}`,
      );
      await input(
        second,
        terminalsByConnection[1],
        `if ($env:ROAMGATE_E2E_TOKEN) { Write-Output 'LEAK' } else { Write-Output ('ISOLATION_' + '${token}') }`,
        `ISOLATION_${token}`,
      );
      await input(
        first,
        terminalsByConnection[0],
        `Write-Output ([char]0x4e2d + [string][char]0x6587 + '_${token}')`,
        `\u4e2d\u6587_${token}`,
      );
      const resized = terminalFrame(
        first.id,
        (terminal) => terminal.width === 101 && terminal.height === 33,
      );
      await rpc(
        "terminal.resize",
        { terminal_id: terminalsByConnection[0], cols: 101, rows: 33 },
        first,
      );
      await resized;
      await input(
        first,
        terminalsByConnection[0],
        `Write-Output ('SIZE_${token}_' + $Host.UI.RawUI.WindowSize.Width + 'x' + $Host.UI.RawUI.WindowSize.Height)`,
        `SIZE_${token}_101x33`,
      );

      await expect(
        rpc("connections.test", {
          profile: {
            id: "bad-windows",
            label: "Bad Windows",
            type: "ssh",
            ssh_destination: first.ssh_destination,
            remote_platform: "windows",
            remote_herdr_path: String.raw`C:\roamgate-missing\herdr.exe`,
            remote_session: first.remote_session,
            remote_control_socket_path: "",
            remote_client_socket_path: "",
            auto_connect: false,
          },
        }),
      ).rejects.toThrow("Herdr 0.9.1");
      const before = first.generation;
      await rpc("connections.disconnect", { id: first.id });
      await expect(rpc("pane.list", {}, first)).rejects.toThrow();
      const other = await rpc("pane.list", {}, second);
      expect(other.panes[0].terminal_id).toBe(terminalsByConnection[1]);
      await rpc("connections.connect", { id: first.id });
      const after = (await rpc("connections.list")).connections.find(
        (connection: any) => connection.id === first.id,
      );
      expect(after.state).toBe("ready");
      expect(after.generation).toBeGreaterThan(before);
      await expect(
        rpc(
          "terminal.input",
          {
            terminal_id: terminalsByConnection[0],
            data: Buffer.from("Write-Output 'STALE'\r").toString("base64"),
          },
          first,
        ),
      ).rejects.toThrow();
      await rpc(
        "terminal.attach",
        { terminal_id: terminalsByConnection[0], cols: 101, rows: 33 },
        after,
      );
      await input(
        after,
        terminalsByConnection[0],
        "Write-Output ('PERSISTED_' + $env:ROAMGATE_E2E_TOKEN)",
        `PERSISTED_ALPHA_${token}`,
      );
      await input(
        after,
        terminalsByConnection[0],
        `Remove-Item Env:ROAMGATE_E2E_TOKEN; Write-Output ('CLEANUP_' + '${token}')`,
        `CLEANUP_${token}`,
      );
    } finally {
      ws.close();
    }
  },
  180_000,
);
