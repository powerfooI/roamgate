import type { ConnectionLifecycleState, ConnectionSummary } from "./api";
import {
  validateRemoteSocketPath,
  validateSshDestination,
  validateWindowsSshOptions,
} from "./sshProfileValidation";

export type LocalConnectionProfileInput = {
  id: string;
  label: string;
  type: "local";
  control_socket_path: string;
  client_socket_path: string;
  auto_connect: boolean;
};

export type SshConnectionProfileInput = {
  id: string;
  label: string;
  type: "ssh";
  ssh_destination: string;
  remote_control_socket_path: string;
  remote_client_socket_path: string;
  auto_connect: boolean;
  remote_platform?: "windows";
  remote_herdr_path?: string;
  remote_session?: string;
};

export type ConnectionProfileInput =
  | LocalConnectionProfileInput
  | SshConnectionProfileInput;

export type ConnectionProfileCapabilities = {
  canEdit: boolean;
  canRemove: boolean;
  canSetDefault: boolean;
  canConnect: boolean;
  canDisconnect: boolean;
  canReconnect: boolean;
};

const CONNECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function connectionLifecycleLabel(
  state: ConnectionLifecycleState,
): string {
  switch (state) {
    case "ready":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "stopping":
      return "Disconnecting";
    case "error":
      return "Error";
    case "disconnected":
      return "Disconnected";
  }
}

export function connectionProfileCapabilities(
  connection: Pick<ConnectionSummary, "is_default" | "read_only" | "state">,
): ConnectionProfileCapabilities {
  const readOnly = connection.read_only === true;
  return {
    canEdit: !readOnly,
    canRemove: !readOnly && !connection.is_default,
    canSetDefault: !readOnly && !connection.is_default,
    canConnect:
      connection.state === "disconnected" || connection.state === "error",
    canDisconnect:
      connection.state === "ready" ||
      connection.state === "connecting" ||
      connection.state === "reconnecting",
    canReconnect: connection.state === "ready",
  };
}

export function connectionTypeLabel(
  connection: Pick<ConnectionSummary, "type">,
): string {
  return connection.type === "ssh" ? "SSH" : "Local";
}

export function suggestConnectionId(
  label: string,
  fallback: "local" | "ssh" = "local",
): string {
  const suggested = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^[^a-z0-9]+|[-._:]+$/g, "")
    .slice(0, 128);
  if (!suggested) return fallback;
  return suggested === "legacy-default" ? `${fallback}-default` : suggested;
}

export function localConnectionProfilePayload(value: {
  id: string;
  label: string;
  controlSocketPath: string;
  clientSocketPath: string;
  autoConnect: boolean;
}): LocalConnectionProfileInput {
  const id = value.id.trim();
  const label = value.label.trim();
  const controlSocketPath = value.controlSocketPath.trim();
  const clientSocketPath = value.clientSocketPath.trim();
  if (
    !CONNECTION_ID_PATTERN.test(id) ||
    id.length > 128 ||
    id === "legacy-default"
  ) {
    throw new Error(
      "ID must start with a letter or number and use only letters, numbers, dot, colon, underscore, or hyphen.",
    );
  }
  if (
    !label ||
    label.length > 80 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(label)
  ) {
    throw new Error("Label must be 1-80 printable characters.");
  }
  for (const [field, path] of [
    ["Control socket", controlSocketPath],
    ["Render socket", clientSocketPath],
  ] as const) {
    const isAbsoluteSocketPath =
      path.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(path) ||
      /^\\\\[.?]\\pipe\\/i.test(path);
    if (
      !isAbsoluteSocketPath ||
      /[\u0000-\u001f\u007f-\u009f]/.test(path) ||
      path.split(/[\\/]/).includes("..") ||
      path.length > 4096
    ) {
      throw new Error(
        `${field} path must be an absolute socket path without parent traversal.`,
      );
    }
  }
  return {
    id,
    label,
    type: "local",
    control_socket_path: controlSocketPath,
    client_socket_path: clientSocketPath,
    auto_connect: value.autoConnect,
  };
}

export function sshConnectionProfilePayload(value: {
  id: string;
  label: string;
  sshDestination: string;
  remoteControlSocketPath: string;
  remoteClientSocketPath: string;
  autoConnect: boolean;
  remotePlatform?: "windows";
  remoteHerdrPath?: string;
  remoteSession?: string;
}): SshConnectionProfileInput {
  const id = value.id.trim();
  const label = value.label.trim();
  const sshDestination = value.sshDestination.trim();
  const remoteControlSocketPath = value.remoteControlSocketPath.trim();
  const remoteClientSocketPath = value.remoteClientSocketPath.trim();
  if (
    !CONNECTION_ID_PATTERN.test(id) ||
    id.length > 128 ||
    id === "legacy-default"
  ) {
    throw new Error(
      "ID must start with a letter or number and use only letters, numbers, dot, colon, underscore, or hyphen.",
    );
  }
  if (
    !label ||
    label.length > 80 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(label)
  ) {
    throw new Error("Label must be 1-80 printable characters.");
  }
  validateSshDestination(sshDestination);
  validateRemoteSocketPath(remoteControlSocketPath, "Remote control socket");
  validateRemoteSocketPath(remoteClientSocketPath, "Remote render socket");
  if (
    remoteControlSocketPath &&
    remoteClientSocketPath &&
    remoteControlSocketPath === remoteClientSocketPath
  ) {
    throw new Error("Remote control and render socket paths must differ.");
  }
  const payload: SshConnectionProfileInput = {
    id,
    label,
    type: "ssh",
    ssh_destination: sshDestination,
    remote_control_socket_path: remoteControlSocketPath,
    remote_client_socket_path: remoteClientSocketPath,
    auto_connect: value.autoConnect,
    ...(value.remotePlatform ? { remote_platform: value.remotePlatform } : {}),
    ...(value.remoteHerdrPath?.trim()
      ? { remote_herdr_path: value.remoteHerdrPath.trim() }
      : {}),
    ...(value.remoteSession?.trim()
      ? { remote_session: value.remoteSession.trim() }
      : {}),
  };
  validateWindowsSshOptions(payload);
  return payload;
}

export async function selectConnectionProfile(args: {
  connection: ConnectionSummary;
  select: (connectionId: string) => boolean;
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  refresh: () => Promise<unknown>;
}): Promise<void> {
  args.select(args.connection.id);
  if (
    args.connection.state !== "disconnected" &&
    args.connection.state !== "error"
  ) {
    return;
  }
  try {
    await args.call("connections.connect", { id: args.connection.id });
  } finally {
    await args.refresh();
  }
}

export async function reconnectConnectionProfile(args: {
  connectionId: string;
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}): Promise<void> {
  await args.call("connections.disconnect", { id: args.connectionId });
  await args.call("connections.connect", { id: args.connectionId });
}

export function connectionErrorDetail(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Connection operation failed";
}
