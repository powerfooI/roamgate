import { describe, expect, test } from "bun:test";
import type { ConnectionSummary } from "./api";
import { parseConnectionSummary } from "./api";
import {
  connectionErrorDetail,
  connectionLifecycleLabel,
  connectionProfileCapabilities,
  connectionTypeLabel,
  localConnectionProfilePayload,
  reconnectConnectionProfile,
  selectConnectionProfile,
  sshConnectionProfilePayload,
  suggestConnectionId,
} from "./connectionProfiles";

function connection(patch: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: "alpha",
    label: "Alpha",
    source: "local-profile",
    is_default: false,
    state: "ready",
    generation: 1,
    type: "local",
    read_only: false,
    auto_connect: true,
    control_socket_path: "/tmp/alpha.sock",
    client_socket_path: "/tmp/alpha-client.sock",
    ...patch,
  };
}

describe("local connection profile presentation", () => {
  test("round trips Windows SSH options through payloads and the catalog", () => {
    const payload = sshConnectionProfilePayload({
      id: "windows",
      label: "Windows",
      sshDestination: "pc",
      remoteControlSocketPath: "",
      remoteClientSocketPath: "",
      autoConnect: false,
      remotePlatform: "windows",
      remoteHerdrPath: String.raw`C:\Herdr O'Brien\herdr.exe`,
      remoteSession: "isolated-session",
    });
    expect(payload).toMatchObject({
      remote_platform: "windows",
      remote_session: "isolated-session",
    });
    expect(
      parseConnectionSummary({
        ...connection(),
        ...payload,
        source: "ssh-profile",
        control_socket_path: undefined,
        client_socket_path: undefined,
      }),
    ).toMatchObject(payload);
    expect(() =>
      sshConnectionProfilePayload({
        id: "windows",
        label: "Windows",
        sshDestination: "pc",
        remoteControlSocketPath: "",
        remoteClientSocketPath: "",
        autoConnect: false,
        remotePlatform: "windows",
        remoteSession: "default --update",
      }),
    ).toThrow("Session");
    expect(
      parseConnectionSummary(connection({ remote_platform: "windows" })),
    ).toBeNull();
  });
  test("labels every runtime lifecycle distinctly", () => {
    expect(connectionLifecycleLabel("ready")).toBe("Connected");
    expect(connectionLifecycleLabel("connecting")).toBe("Connecting");
    expect(connectionLifecycleLabel("reconnecting")).toBe("Reconnecting");
    expect(connectionLifecycleLabel("stopping")).toBe("Disconnecting");
    expect(connectionLifecycleLabel("error")).toBe("Error");
    expect(connectionLifecycleLabel("disconnected")).toBe("Disconnected");
  });

  test("suggests deterministic safe IDs without using the reserved ID", () => {
    expect(suggestConnectionId("Local Dév / Main")).toBe("local-dev-main");
    expect(suggestConnectionId("legacy default")).toBe("local-default");
    expect(suggestConnectionId("***")).toBe("local");
  });

  test("labels local and SSH profile types", () => {
    expect(connectionTypeLabel(connection())).toBe("Local");
    expect(connectionTypeLabel(connection({ type: "ssh" }))).toBe("SSH");
  });

  test("emits the exact strict backend payload", () => {
    expect(
      localConnectionProfilePayload({
        id: "local-dev",
        label: "Local Dev",
        controlSocketPath: " /tmp/control.sock ",
        clientSocketPath: " /tmp/client.sock ",
        autoConnect: false,
      }),
    ).toEqual({
      id: "local-dev",
      label: "Local Dev",
      type: "local",
      control_socket_path: "/tmp/control.sock",
      client_socket_path: "/tmp/client.sock",
      auto_connect: false,
    });
    expect(() =>
      localConnectionProfilePayload({
        id: "legacy-default",
        label: "Bad",
        controlSocketPath: "/tmp/control.sock",
        clientSocketPath: "/tmp/client.sock",
        autoConnect: true,
      }),
    ).toThrow("ID must");
    expect(() =>
      localConnectionProfilePayload({
        id: "bad",
        label: "Bad",
        controlSocketPath: "/tmp/../secret",
        clientSocketPath: "/tmp/client.sock",
        autoConnect: true,
      }),
    ).toThrow("parent traversal");

    expect(
      localConnectionProfilePayload({
        id: "windows-local",
        label: "Windows Local",
        controlSocketPath: String.raw`C:\Users\tester\herdr.sock`,
        clientSocketPath: String.raw`\\.\PIPE\C:\Users\tester\herdr-client.sock`,
        autoConnect: true,
      }),
    ).toMatchObject({
      control_socket_path: String.raw`C:\Users\tester\herdr.sock`,
      client_socket_path: String.raw`\\.\PIPE\C:\Users\tester\herdr-client.sock`,
    });
  });

  test("emits and validates the strict SSH backend payload", () => {
    const input = {
      id: "remote-dev",
      label: "Remote Dev",
      sshDestination: " operator@dev-box ",
      remoteControlSocketPath: "/remote/herdr.sock",
      remoteClientSocketPath: "/remote/herdr-client.sock",
      autoConnect: false,
    };
    expect(sshConnectionProfilePayload(input)).toEqual({
      id: "remote-dev",
      label: "Remote Dev",
      type: "ssh",
      ssh_destination: "operator@dev-box",
      remote_control_socket_path: "/remote/herdr.sock",
      remote_client_socket_path: "/remote/herdr-client.sock",
      auto_connect: false,
    });
    for (const sshDestination of [
      "-oProxyCommand=bad",
      "host name",
      "ssh://host",
      "host:22",
      "user@@host",
      "@host",
    ]) {
      expect(() =>
        sshConnectionProfilePayload({ ...input, sshDestination }),
      ).toThrow("OpenSSH alias");
    }
    expect(() =>
      sshConnectionProfilePayload({
        ...input,
        remoteControlSocketPath: "/tmp/../herdr.sock",
      }),
    ).toThrow("short absolute POSIX");
    expect(() =>
      sshConnectionProfilePayload({
        ...input,
        remoteClientSocketPath: input.remoteControlSocketPath,
      }),
    ).toThrow("must differ");
  });

  test("allows empty SSH socket paths so the bridge infers them", () => {
    const input = {
      id: "remote-dev",
      label: "Remote Dev",
      sshDestination: "operator@dev-box",
      remoteControlSocketPath: " ",
      remoteClientSocketPath: "",
      autoConnect: true,
    };
    expect(sshConnectionProfilePayload(input)).toEqual({
      id: "remote-dev",
      label: "Remote Dev",
      type: "ssh",
      ssh_destination: "operator@dev-box",
      remote_control_socket_path: "",
      remote_client_socket_path: "",
      auto_connect: true,
    });
    expect(
      sshConnectionProfilePayload({
        ...input,
        remoteControlSocketPath: "/remote/herdr.sock",
      }),
    ).toMatchObject({
      remote_control_socket_path: "/remote/herdr.sock",
      remote_client_socket_path: "",
    });
  });

  test("protects read-only and default profiles from destructive controls", () => {
    expect(
      connectionProfileCapabilities(
        connection({ read_only: true, is_default: true }),
      ),
    ).toMatchObject({ canEdit: false, canRemove: false, canSetDefault: false });
    expect(
      connectionProfileCapabilities(connection({ is_default: true })),
    ).toMatchObject({ canEdit: true, canRemove: false, canSetDefault: false });
    expect(
      connectionProfileCapabilities(connection({ state: "disconnected" })),
    ).toMatchObject({ canConnect: true, canDisconnect: false });
    expect(
      connectionProfileCapabilities(connection({ state: "reconnecting" })),
    ).toMatchObject({
      canConnect: false,
      canDisconnect: true,
      canReconnect: false,
    });
  });

  test("switches immediately and never switches back after async connect", async () => {
    const calls: string[] = [];
    let resolveConnect!: () => void;
    const connect = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    const action = selectConnectionProfile({
      connection: connection({ state: "disconnected" }),
      select: (id) => {
        calls.push(`select:${id}`);
        return true;
      },
      call: async (method, params) => {
        calls.push(`${method}:${params.id}`);
        await connect;
      },
      refresh: async () => {
        calls.push("refresh");
      },
    });
    calls.push("select:beta");
    resolveConnect();
    await action;
    expect(calls).toEqual([
      "select:alpha",
      "connections.connect:alpha",
      "select:beta",
      "refresh",
    ]);
  });

  test("reconnect sequences disconnect before connect", async () => {
    const calls: string[] = [];
    await reconnectConnectionProfile({
      connectionId: "alpha",
      call: async (method, params) => {
        calls.push(`${method}:${params.id}`);
      },
    });
    expect(calls).toEqual([
      "connections.disconnect:alpha",
      "connections.connect:alpha",
    ]);
  });

  test("presents backend errors without fabricating details", () => {
    expect(connectionErrorDetail(new Error("socket unavailable"))).toBe(
      "socket unavailable",
    );
    expect(connectionErrorDetail(null)).toBe("Connection operation failed");
  });
});
