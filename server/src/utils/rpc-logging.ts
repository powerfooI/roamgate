import type { LogLevel } from "./logger";

// RPC error text for terminal calls made before a terminal is attached. The
// terminal bridge throws this exact message and the classifier below treats
// it as an expected detach race, so both sides share one constant.
export const NO_TERMINAL_ATTACHED_MESSAGE = "no terminal attached";

export function isExpectedRpcError(
  method: string | null,
  detail: string | undefined,
): boolean {
  const message = detail?.toLowerCase() ?? "";
  if (!message) return false;
  if (message.includes("connection changed during request")) return true;
  // Background work shed while the host is busy: it is tried again later.
  if (message.includes("background commands already waiting")) return true;
  if (
    message.includes("connection runtime generation") ||
    message.includes("connection is not ready")
  ) {
    return true;
  }
  if (
    method === "git.diff_summary" &&
    /not (?:inside )?a git repository/.test(message)
  ) {
    return true;
  }
  if (
    method?.startsWith("terminal.") &&
    message === NO_TERMINAL_ATTACHED_MESSAGE
  ) {
    return true;
  }
  return false;
}

export function rpcLogLevel(args: {
  method: string | null;
  status: "ok" | "error";
  detail?: string;
}): LogLevel {
  if (args.status === "ok") return "debug";
  return isExpectedRpcError(args.method, args.detail) ? "debug" : "warn";
}
