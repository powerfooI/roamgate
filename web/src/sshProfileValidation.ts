const SSH_DESTINATION_MAX_LENGTH = 320;
const SSH_USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const SSH_HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const REMOTE_SOCKET_SEGMENT_PATTERN = /^[A-Za-z0-9._~+@%=-]+$/;

export function validateWindowsSshOptions(value: {
  remote_platform?: unknown;
  remote_herdr_path?: unknown;
  remote_session?: unknown;
  remote_control_socket_path?: unknown;
  remote_client_socket_path?: unknown;
}): void {
  const windows = value.remote_platform === "windows";
  if (value.remote_platform !== undefined && !windows)
    throw new Error("Invalid remote host OS.");
  if (
    !windows &&
    (value.remote_herdr_path !== undefined ||
      value.remote_session !== undefined)
  )
    throw new Error("Windows SSH options require a Windows host.");
  if (
    windows &&
    (value.remote_control_socket_path || value.remote_client_socket_path)
  )
    throw new Error("Windows SSH does not use remote socket paths.");
  if (
    value.remote_herdr_path !== undefined &&
    (typeof value.remote_herdr_path !== "string" ||
      value.remote_herdr_path.length > 1024 ||
      !/^[A-Za-z]:[\\/][^\u0000-\u001f\u007f-\u009f]+\.exe$/i.test(
        value.remote_herdr_path,
      ) ||
      value.remote_herdr_path.split(/[\\/]/).includes(".."))
  )
    throw new Error("Herdr path must be an absolute Windows executable path.");
  if (
    value.remote_session !== undefined &&
    (typeof value.remote_session !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.remote_session))
  )
    throw new Error(
      "Session must use 1-64 letters, numbers, underscores, or hyphens and start with a letter or number.",
    );
}

export function validateSshDestination(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > SSH_DESTINATION_MAX_LENGTH ||
    !/^[\x21-\x7e]+$/.test(value) ||
    value.startsWith("-") ||
    /[\s/=:,]/.test(value) ||
    value.includes("://")
  ) {
    throw new Error(
      "SSH destination must be an OpenSSH alias or user@host. Use an OpenSSH config alias for custom ports.",
    );
  }
  const parts = value.split("@");
  if (parts.length > 2) {
    throw new Error(
      "SSH destination must be an OpenSSH alias or user@host. Use an OpenSSH config alias for custom ports.",
    );
  }
  const host = parts.length === 2 ? parts[1] : parts[0];
  const user = parts.length === 2 ? parts[0] : undefined;
  if (
    !SSH_HOST_PATTERN.test(host) ||
    (user !== undefined && !SSH_USER_PATTERN.test(user))
  ) {
    throw new Error(
      "SSH destination must be an OpenSSH alias or user@host. Use an OpenSSH config alias for custom ports.",
    );
  }
  return value;
}

export function validateRemoteSocketPath(
  value: unknown,
  field: string,
): string {
  // An empty path asks the bridge to infer the default Herdr socket location
  // under the remote home directory at connect time.
  if (value === "") return "";
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    new TextEncoder().encode(value).length > 100 ||
    !value.startsWith("/") ||
    !/^[\x21-\x7e]+$/.test(value) ||
    /[:\\\s]/.test(value)
  ) {
    throw new Error(`${field} path must be a short absolute POSIX path.`);
  }
  const segments = value.split("/").slice(1);
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !REMOTE_SOCKET_SEGMENT_PATTERN.test(segment),
    )
  ) {
    throw new Error(`${field} path must be a short absolute POSIX path.`);
  }
  return value;
}
