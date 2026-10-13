export type RemotePlatform = "windows" | undefined;

export function unixOnlyMessage(operation: string) {
  return `${operation} requires a Unix SSH host and is unavailable on Windows.`;
}

/** Carries only the operation name, so callers may show it verbatim. */
export class UnsupportedPlatformError extends Error {
  constructor(operation: string) {
    super(unixOnlyMessage(operation));
  }
}

export function assertUnixHost(
  runtime: { remotePlatform?: RemotePlatform },
  operation: string,
) {
  if (runtime.remotePlatform === "windows")
    throw new UnsupportedPlatformError(operation);
}

/**
 * Replaces every helper in a group that runs Unix shell commands over SSH with
 * one that throws on Windows hosts, so a caller that skips its own guard still
 * cannot reach a PowerShell host.
 */
export function unixOnlyHandlers<T extends object>(
  remotePlatform: RemotePlatform,
  operation: string,
  handlers: T,
): T {
  if (remotePlatform !== "windows") return handlers;
  return Object.fromEntries(
    Object.entries(handlers).map(([name, value]) => [
      name,
      typeof value === "function"
        ? () => {
            throw new UnsupportedPlatformError(operation);
          }
        : value,
    ]),
  ) as T;
}
