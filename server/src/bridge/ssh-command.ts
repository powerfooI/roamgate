const SSH_DESTINATION_MAX_LENGTH = 320;
const SSH_USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const SSH_HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

export const SSH_NONINTERACTIVE_ARGS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "PermitLocalCommand=no",
  "-o",
  "RequestTTY=no",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  "-o",
  "ControlPersist=no",
  "-o",
  "ConnectTimeout=8",
  "-o",
  "ConnectionAttempts=1",
  // ConnectTimeout only covers the TCP connect and key exchange. Keepalives
  // end a session that stalls afterwards (network change, sleeping peer)
  // instead of leaving the process, and whatever awaits it, hung forever.
  "-o",
  "ServerAliveInterval=10",
  "-o",
  "ServerAliveCountMax=3",
] as const;

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
    throw new Error("ssh_destination must be an OpenSSH alias or user@host");
  }
  const parts = value.split("@");
  if (parts.length > 2) {
    throw new Error("ssh_destination must be an OpenSSH alias or user@host");
  }
  const host = parts.length === 2 ? parts[1] : parts[0];
  const user = parts.length === 2 ? parts[0] : undefined;
  if (
    !SSH_HOST_PATTERN.test(host) ||
    (user !== undefined && !SSH_USER_PATTERN.test(user))
  ) {
    throw new Error("ssh_destination must be an OpenSSH alias or user@host");
  }
  return value;
}

export function sshCommandArgv(
  destination: string,
  command: string,
  trustedArgs: readonly string[] = [],
): string[] {
  return [
    "ssh",
    ...SSH_NONINTERACTIVE_ARGS,
    ...trustedArgs,
    "--",
    validateSshDestination(destination),
    command,
  ];
}

export function sshTunnelArgv(
  destination: string,
  forwards: ReadonlyArray<{ local: string; remote: string }>,
): string[] {
  const argv = [
    "ssh",
    ...SSH_NONINTERACTIVE_ARGS,
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "StreamLocalBindUnlink=yes",
    "-o",
    "StreamLocalBindMask=0177",
    "-N",
  ];
  for (const forward of forwards) {
    argv.push("-L", `${forward.local}:${forward.remote}`);
  }
  argv.push("--", validateSshDestination(destination));
  return argv;
}
