import { annotateSshArgv } from "./ssh-metrics";
import { routeSshCommand, sshMasterControlPath } from "./ssh-sessions";

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

/**
 * Builds a host command. While a runtime's master for the destination
 * listens, the command multiplexes over it: `-S` overrides the
 * `ControlPath=none` policy (a later `-o ControlPath=` would not, since the
 * first value wins), and `ControlMaster=no` keeps the command a client that
 * falls back to its own connection if the socket stops answering. Run the
 * result through the process helpers (or holdSshSession) to apply the session
 * limit.
 */
export function sshCommandArgv(
  destination: string,
  command: string,
  trustedArgs: readonly string[] = [],
  /** Caller name for the debug ssh process log. */
  tag?: string,
): string[] {
  return buildSshCommandArgv(destination, command, trustedArgs, tag, false);
}

/**
 * sshCommandArgv for a command with no remote side effects, which the process
 * helpers may rerun once cold when its master dies mid-command.
 */
export function sshReadCommandArgv(
  destination: string,
  command: string,
  trustedArgs: readonly string[] = [],
  /** Caller name for the debug ssh process log. */
  tag?: string,
): string[] {
  return buildSshCommandArgv(destination, command, trustedArgs, tag, true);
}

/**
 * A long-lived stdio bridge (the remote Windows Herdr bridges). It holds its
 * own connection for as long as its socket client stays, so it never
 * multiplexes over a master and does not take one of the destination's
 * session slots.
 */
export function sshBridgeCommandArgv(
  destination: string,
  command: string,
): string[] {
  return [
    "ssh",
    ...SSH_NONINTERACTIVE_ARGS,
    "--",
    validateSshDestination(destination),
    command,
  ];
}

function buildSshCommandArgv(
  destination: string,
  command: string,
  trustedArgs: readonly string[],
  tag: string | undefined,
  retrySafe: boolean,
): string[] {
  const validated = validateSshDestination(destination);
  const policy = [...SSH_NONINTERACTIVE_ARGS, ...trustedArgs, "--", validated];
  const cold = ["ssh", ...policy, command];
  const controlPath = sshMasterControlPath(validated);
  const argv = controlPath
    ? ["ssh", "-S", controlPath, ...policy, command]
    : cold;
  routeSshCommand(argv, {
    destination: validated,
    controlPath,
    cold,
    retrySafe,
  });
  if (tag) {
    // A cold retry is its own process in the log, under the same tag.
    annotateSshArgv(cold, { tag });
    annotateSshArgv(argv, { tag });
  }
  if (controlPath) annotateSshArgv(argv, { master: true });
  return argv;
}

/** A foreground master owning `controlPath` until it is killed. */
export function sshMasterArgv(
  destination: string,
  controlPath: string,
): string[] {
  return [
    "ssh",
    "-M",
    "-S",
    controlPath,
    ...SSH_NONINTERACTIVE_ARGS,
    "-N",
    "--",
    validateSshDestination(destination),
  ];
}

/**
 * Asks the master on `controlPath` to exit, for one left by a crash. The
 * destination only fills the request; `-S` selects the master.
 */
export function sshMasterExitArgv(controlPath: string): string[] {
  return [
    "ssh",
    "-F",
    "/dev/null",
    "-S",
    controlPath,
    "-O",
    "exit",
    "--",
    "roamgate-orphaned-master",
  ];
}

/** Closes the master's control socket to new sessions; running ones go on. */
export function sshMasterStopArgv(
  destination: string,
  controlPath: string,
): string[] {
  return [
    "ssh",
    "-S",
    controlPath,
    ...SSH_NONINTERACTIVE_ARGS,
    "-O",
    "stop",
    "--",
    validateSshDestination(destination),
  ];
}

export function sshMasterCheckArgv(
  destination: string,
  controlPath: string,
): string[] {
  return [
    "ssh",
    "-S",
    controlPath,
    ...SSH_NONINTERACTIVE_ARGS,
    "-O",
    "check",
    "--",
    validateSshDestination(destination),
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
