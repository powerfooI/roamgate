import type { ServerWebSocket } from "bun";
import {
  CONNECTION_CHANGED_DURING_REQUEST,
  serializeConnectionEnvelope,
} from "../connections/protocol";
import type { SshForwards } from "./ssh-forward";
import {
  forwardToWire,
  LISTENING_PORTS_COMMAND,
  ownedListeningPorts,
  parseListeningPorts,
  validateForwardPort,
} from "./ssh-forward";
import { sshCommandArgv } from "./ssh-command";
import { shQuote } from "../utils/process-utils";

/** A scan slower than this lists nothing rather than holding the menu. */
export const FORWARD_SCAN_TIMEOUT_MS = 10_000;
/** A host listening on hundreds of ports gets its lowest ones offered. */
export const MAX_FORWARD_CANDIDATES = 64;

/**
 * Opens and closes on-demand port forwards for one connection's SSH
 * transport. Forwarding is only offered where the browser and the Roamgate
 * server share a machine: a forward binds on whichever host runs `ssh`, so
 * anywhere else the port is either unreachable from the browser or exposed
 * beyond it. Connections without an SSH transport are refused outright rather
 * than silently doing nothing.
 */
export function createForwardRpcHandler(args: {
  connectionId?: string;
  connectionGeneration?: number;
  sshHost: () => string | undefined;
  runProcess: (
    argv: string[],
    input?: string,
    options?: { timeoutMs?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  forwards: SshForwards;
  safeSend: (
    ws: ServerWebSocket<unknown>,
    payload: string,
    context?: string,
  ) => boolean;
  markRpcError: (
    ws: ServerWebSocket<unknown>,
    id: string | null | undefined,
    detail?: string,
  ) => void;
}) {
  const serialize = (message: Record<string, unknown>) =>
    args.connectionId
      ? serializeConnectionEnvelope(
          args.connectionId,
          message,
          args.connectionGeneration,
        )
      : JSON.stringify(message);
  // One scan per direction at a time: opening the list repeatedly joins the
  // scan in flight instead of starting another ssh each time.
  const scans = new Map<string, Promise<string>>();
  const scan = (direction: "local" | "remote", destination: string) => {
    let pending = scans.get(direction);
    if (!pending) {
      // A scan that fails (no scanner on the host, ssh refused, too slow)
      // is an empty list, not an error: candidates are a convenience, and
      // the other direction's list must still render.
      pending = args
        .runProcess(
          direction === "local"
            ? // The remote login shell may be fish or csh, which parse
              // redirections and || differently: run the chain under sh.
              sshCommandArgv(
                destination,
                `sh -c ${shQuote(LISTENING_PORTS_COMMAND)}`,
              )
            : ["sh", "-c", LISTENING_PORTS_COMMAND],
          undefined,
          { timeoutMs: FORWARD_SCAN_TIMEOUT_MS },
        )
        .then(
          (result) => result.stdout,
          () => "",
        )
        .finally(() => scans.delete(direction));
      scans.set(direction, pending);
    }
    return pending;
  };

  return async function handleForwardRpc(
    ws: ServerWebSocket<unknown>,
    id: string | null | undefined,
    method: string,
    params: Record<string, unknown>,
    requestIsCurrent: () => boolean,
  ) {
    const fail = (detail: string) => {
      args.markRpcError(ws, id, detail);
      args.safeSend(ws, serialize({ id, error: { message: detail } }), method);
    };
    const reply = (result: Record<string, unknown>) =>
      requestIsCurrent()
        ? args.safeSend(ws, serialize({ id, result }), method)
        : fail(CONNECTION_CHANGED_DURING_REQUEST);

    try {
      if (method === "forward.list") {
        return reply({ forwards: args.forwards.list().map(forwardToWire) });
      }
      if (method === "forward.close") {
        const forwardId = String(params.id ?? "");
        if (!forwardId) return fail("forward.close requires id");
        return reply({ closed: args.forwards.close(forwardId) });
      }
      const destination = args.sshHost();
      if (!destination) {
        return fail(
          "This connection is local; port forwarding applies to SSH connections",
        );
      }
      if (method === "forward.open") {
        const port = validateForwardPort(params.remote_port ?? params.port);
        const direction = params.direction === "remote" ? "remote" : "local";
        const label =
          typeof params.label === "string" && params.label.trim()
            ? params.label.trim().slice(0, 64)
            : undefined;
        // The runtime may already be disposed, its forwards closed: a forward
        // opened now would outlive it with nobody left to close it.
        if (!requestIsCurrent()) return fail(CONNECTION_CHANGED_DURING_REQUEST);
        const record = args.forwards.open({
          connectionId: args.connectionId ?? "",
          destination,
          port,
          direction,
          label,
        });
        // Reported open only once it carries traffic: a local port that
        // accepts connections, or the far host's confirmation of a remote one.
        const settled = await args.forwards.waitUntilOpen(record.id);
        // Disposed while ssh was starting: dispose has already swept this
        // connection's forwards, so this one is ours to close.
        if (!requestIsCurrent()) {
          args.forwards.closeAttempt(record);
          return fail(CONNECTION_CHANGED_DURING_REQUEST);
        }
        if (!settled) return fail("The forward was closed before it opened");
        if (settled.state === "failed") {
          return fail(settled.error ?? "The forward could not be opened");
        }
        return reply({ forward: forwardToWire(settled) });
      }
      if (method === "forward.candidates") {
        // Asked for, never polled: one round trip when someone opens the
        // ports list, rather than a standing cost on every connection.
        const direction = params.direction === "remote" ? "remote" : "local";
        // A local forward needs to know what the far host is listening on; a
        // remote forward needs to know what this one is, which is the same
        // question asked of a different machine.
        // No Windows case: a Windows server has no SSH connections at all
        // (assertSshTunnelPlatformSupported), so it never gets this far, and
        // a missing sh would only make the scan fail, which lists nothing.
        const stdout = await scan(direction, destination);
        const forwarded = new Set(
          args.forwards
            .list()
            .filter(
              (entry) =>
                entry.state !== "failed" && entry.direction === direction,
            )
            .map((entry) =>
              direction === "local" ? entry.remotePort : entry.localPort,
            ),
        );
        return reply({
          candidates: ownedListeningPorts(parseListeningPorts(stdout))
            .filter(
              (entry) =>
                !forwarded.has(entry.port) &&
                // Never offered, and refused by open() if asked anyway.
                !(
                  direction === "remote" && args.forwards.isReserved(entry.port)
                ),
            )
            .slice(0, MAX_FORWARD_CANDIDATES),
        });
      }
      return fail(`unknown forward method: ${method}`);
    } catch (e) {
      return fail((e as Error).message);
    }
  };
}
