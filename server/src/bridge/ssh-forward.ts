import { SSH_NONINTERACTIVE_ARGS, validateSshDestination } from "./ssh-command";
import {
  classifySshTunnelFailure,
  readBoundedStderr,
  type SshTunnelError,
} from "./ssh-tunnel";
import { type Logger, silentLogger } from "../utils/logger";

/**
 * On-demand `-L` forwards for a connection's SSH transport, one supervised
 * process each.
 *
 * Deliberately not added to the Herdr tunnel's own `-L` list: ssh cannot gain
 * a forward without being restarted, and restarting that tunnel drops the
 * connection every browser is using. A separate process per forward also
 * means a refused port takes only itself down.
 *
 * Forwards bind loopback only. A forwarded port carries no authentication of
 * its own, whatever is on the far end answers anyone who connects, so the
 * only safe listener is one no other machine can reach. This is also why the
 * feature is limited to running Roamgate on the machine you browse from: a
 * forward bound anywhere else is either useless or exposed.
 */
export const FORWARD_BIND_HOST = "127.0.0.1";

export type SshForwardState = "starting" | "open" | "failed" | "closed";

/**
 * Which way the tunnel runs.
 *
 * `local` (ssh -L) puts a remote service on a local port: the browser reaches
 * something running on the far host. `remote` (ssh -R) is the mirror, a
 * service on this machine appears on the far host, so processes there, agents
 * included, can reach it.
 *
 * The trust story is not symmetric. A local forward exposes the far host's
 * service to this machine alone; a remote forward exposes ours to everything
 * on the far host. Both ask for loopback, which is the only reason the
 * second is reasonable at all; see sshForwardArgv for where the far host can
 * override that.
 */
export type SshForwardDirection = "local" | "remote";

export type SshForwardRecord = {
  id: string;
  connectionId: string;
  direction: SshForwardDirection;
  remotePort: number;
  localPort: number;
  label?: string;
  state: SshForwardState;
  error?: string;
  /** Which open() started this record's process; internal, not on the wire. */
  attempt?: number;
};

export type ForwardProcess = {
  exited: Promise<number>;
  stderr?: Promise<string>;
  kill: (signal?: number) => void;
  /** Live stderr text as it arrives, for readiness lines `ssh -v` prints. */
  onStderr?: (listener: (text: string) => void) => void;
};

/**
 * How long a forward may take to become usable: ssh's own ConnectTimeout plus
 * authentication and the forward request. Past this it is killed and reported
 * failed rather than left "starting" forever.
 */
export const FORWARD_READY_TIMEOUT_MS = 20_000;
const FORWARD_READY_POLL_MS = 100;

/**
 * Whether `ssh -v` has said the far host accepted our `-R` listener. OpenSSH
 * logs "remote forward success for: listen [host:]PORT, connect ..." at
 * debug1 once the server confirms the bind; nothing else on stderr does.
 */
export function remoteForwardSucceeded(stderr: string, port: number): boolean {
  for (const match of stderr.matchAll(
    /remote forward success for: listen (?:\S*:)?(\d+),/g,
  )) {
    if (Number(match[1]) === port) return true;
  }
  return false;
}

export function sshForwardArgv(
  destination: string,
  localPort: number,
  remotePort: number,
  direction: SshForwardDirection = "local",
): string[] {
  return [
    "ssh",
    ...SSH_NONINTERACTIVE_ARGS,
    "-o",
    "ExitOnForwardFailure=yes",
    "-N",
    // -v is how a remote forward reports success: the far host's
    // confirmation is only logged at debug1 (see remoteForwardSucceeded).
    ...(direction === "remote" ? ["-v"] : []),
    ...(direction === "local"
      ? [
          "-L",
          // The far side resolves "localhost" on the remote, which is where a
          // dev server printing http://localhost:PORT is actually bound.
          `${FORWARD_BIND_HOST}:${localPort}:localhost:${remotePort}`,
        ]
      : [
          "-R",
          // Asks for the remote's loopback explicitly: sshd honours that under
          // GatewayPorts no (its default) and clientspecified. GatewayPorts
          // yes makes sshd bind every interface whatever the client asks, and
          // the client is not told, so on such a host a remote forward is
          // reachable from its network. The confirmation says so.
          `${FORWARD_BIND_HOST}:${remotePort}:localhost:${localPort}`,
        ]),
    "--",
    validateSshDestination(destination),
  ];
}

export function validateForwardPort(value: unknown): number {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${String(value)}`);
  }
  return port;
}

/**
 * Prefers the remote's own number so the address a user reads in terminal
 * output is the address they type, and falls back upwards when it is taken:
 * the mapping is then reported rather than hidden, since the URL changes.
 */
export function chooseLocalPort(
  preferred: number,
  isFree: (port: number) => boolean,
  span = 64,
): number {
  if (isFree(preferred)) return preferred;
  for (let offset = 1; offset <= span; offset++) {
    const candidate = preferred + offset;
    if (candidate <= 65535 && isFree(candidate)) return candidate;
  }
  throw new Error(
    `No free local port near ${preferred}; close a forward and retry`,
  );
}

/** The bridge protocol is snake_case on the wire; internals are not. */
export type ForwardWire = {
  id: string;
  connection_id: string;
  direction: SshForwardDirection;
  remote_port: number;
  local_port: number;
  label?: string;
  state: SshForwardState;
  error?: string;
};

export function forwardToWire(record: SshForwardRecord): ForwardWire {
  return {
    id: record.id,
    connection_id: record.connectionId,
    direction: record.direction,
    remote_port: record.remotePort,
    local_port: record.localPort,
    ...(record.label ? { label: record.label } : {}),
    state: record.state,
    ...(record.error ? { error: record.error } : {}),
  };
}

export function forwardId(
  connectionId: string,
  remotePort: number,
  direction: SshForwardDirection = "local",
): string {
  return `${connectionId}:${direction}:${remotePort}`;
}

export type SshForwards = ReturnType<typeof createSshForwards>;

/**
 * Live forwards the server keeps at once, across connections: each is an ssh
 * process and a bound port, and nothing else limits how many a page asks for.
 */
export const MAX_LIVE_FORWARDS = 32;

/** The Vite dev server's port (web/vite.config.ts), which proxies to the
 * bridge without authentication in development. */
export const VITE_DEV_PORT = 5173;

/**
 * Ports a remote forward must never expose: Roamgate's own listener, which
 * in development on loopback skips authentication, and in development the
 * Vite server proxying to it. Exposing either hands the far host a session
 * on this machine.
 */
export function roamgateOwnPorts(
  listeningPort: number,
  development: boolean,
): number[] {
  return development ? [listeningPort, VITE_DEV_PORT] : [listeningPort];
}

export function createSshForwards(args: {
  logger?: Logger;
  spawn?: (argv: string[]) => ForwardProcess;
  isPortFree?: (port: number) => boolean;
  /** Whether something accepts connections on a local port. */
  probePort?: (port: number) => Promise<boolean>;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Local ports a remote forward refuses to expose (roamgateOwnPorts). */
  reservedPorts?: () => Iterable<number>;
}) {
  const logger = args.logger ?? silentLogger;
  const spawn =
    args.spawn ??
    ((argv: string[]): ForwardProcess => {
      const proc = Bun.spawn(argv, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, LC_ALL: "C" },
      });
      // One branch keeps the bounded tail for failure messages, the other
      // feeds readiness watchers as text arrives.
      const [tail, live] = proc.stderr.tee();
      const stderrListeners = new Set<(text: string) => void>();
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of live) {
          const text = decoder.decode(chunk, { stream: true });
          for (const listener of stderrListeners) listener(text);
        }
      })().catch(() => {});
      return {
        exited: proc.exited,
        stderr: readBoundedStderr(tail),
        kill: (signal) => proc.kill(signal),
        onStderr: (listener) => stderrListeners.add(listener),
      };
    });
  const isPortFree = args.isPortFree ?? defaultPortIsFree;
  const probePort = args.probePort ?? defaultProbePort;
  const readyTimeoutMs = args.readyTimeoutMs ?? FORWARD_READY_TIMEOUT_MS;
  const pollIntervalMs = args.pollIntervalMs ?? FORWARD_READY_POLL_MS;
  const records = new Map<string, SshForwardRecord>();
  const processes = new Map<string, ForwardProcess>();
  /** Settles once the exit handler has classified a process's exit. */
  const exitsHandled = new Map<ForwardProcess, Promise<void>>();
  /** Resolved when `ssh -v` reports a remote forward's bind accepted. */
  const remoteReady = new Map<ForwardProcess, Promise<void>>();
  /** One readiness wait per process, shared by every request for it. */
  const readiness = new Map<
    ForwardProcess,
    Promise<SshForwardRecord | undefined>
  >();
  let attempts = 0;
  const listeners = new Set<(forwards: SshForwardRecord[]) => void>();

  const publish = () => {
    const snapshot = list();
    for (const listener of listeners) listener(snapshot);
  };

  function isReserved(port: number): boolean {
    for (const reserved of args.reservedPorts?.() ?? []) {
      if (reserved === port) return true;
    }
    return false;
  }

  function list(): SshForwardRecord[] {
    return [...records.values()].map((record) => ({ ...record }));
  }

  function open(request: {
    connectionId: string;
    destination: string;
    /** The port on whichever host owns the service: the far host for a local
     * forward, this one for a remote forward. */
    port: number;
    direction?: SshForwardDirection;
    label?: string;
  }): SshForwardRecord {
    const direction = request.direction ?? "local";
    const port = validateForwardPort(request.port);
    if (direction === "remote" && isReserved(port)) {
      throw new Error(
        `Port ${port} is Roamgate's own and cannot be exposed to the remote`,
      );
    }
    const id = forwardId(request.connectionId, port, direction);
    const existing = records.get(id);
    if (existing && existing.state !== "failed" && existing.state !== "closed")
      return { ...existing };

    const live = [...records.values()].filter(
      (record) => record.state === "starting" || record.state === "open",
    );
    if (live.length >= MAX_LIVE_FORWARDS) {
      throw new Error(
        `Already forwarding ${MAX_LIVE_FORWARDS} ports; stop one and retry`,
      );
    }
    const taken = new Set(
      live
        .filter((record) => record.direction === "local")
        .map((record) => record.localPort),
    );
    // Only a local forward binds here, so only it can be moved to a free
    // port. A remote forward asks the far host for one, and whether that
    // succeeds is ssh's answer to give: ExitOnForwardFailure turns a taken
    // port into an immediate exit carrying its own reason.
    const localPort =
      direction === "local"
        ? chooseLocalPort(
            port,
            (candidate) => !taken.has(candidate) && isPortFree(candidate),
          )
        : port;
    const record: SshForwardRecord = {
      id,
      connectionId: request.connectionId,
      direction,
      remotePort: port,
      localPort,
      label: request.label,
      state: "starting",
      attempt: ++attempts,
    };
    records.set(id, record);

    const argv = sshForwardArgv(
      request.destination,
      localPort,
      record.remotePort,
      direction,
    );
    logger.debug("opening ssh forward", {
      id,
      direction,
      localPort,
      remotePort: record.remotePort,
    });
    let proc: ForwardProcess;
    try {
      proc = spawn(argv);
    } catch (error) {
      const failed = {
        ...record,
        state: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
      };
      records.set(id, failed);
      publish();
      return { ...failed };
    }
    processes.set(id, proc);
    if (direction === "remote") {
      remoteReady.set(
        proc,
        new Promise<void>((resolve) => {
          let seen = "";
          proc.onStderr?.((text) => {
            // Keep a window, not the whole -v log: the line may straddle
            // two chunks, but it is far shorter than this.
            seen = (seen + text).slice(-4096);
            if (remoteForwardSucceeded(seen, port)) resolve();
          });
        }),
      );
    }
    // ExitOnForwardFailure means a refused bind exits with ssh's reason;
    // waitUntilOpen decides when a live process is actually forwarding.
    const exitHandled = proc.exited.then(async (code) => {
      if (processes.get(id) !== proc) return;
      processes.delete(id);
      const current = records.get(id);
      if (!current || current.state === "closed") return;
      const failure: SshTunnelError = classifySshTunnelFailure(
        code,
        (await proc.stderr?.catch(() => "")) ?? "",
      );
      records.set(id, { ...current, state: "failed", error: failure.message });
      logger.warn("ssh forward exited", { id, code, error: failure.message });
      publish();
    });
    exitsHandled.set(proc, exitHandled);
    void exitHandled.finally(() => {
      exitsHandled.delete(proc);
      remoteReady.delete(proc);
    });
    publish();
    return { ...record };
  }

  const snapshot = (id: string) => {
    const current = records.get(id);
    return current ? { ...current } : undefined;
  };

  /**
   * Resolves once a starting forward can carry traffic, or with it failed.
   *
   * `ssh -N` prints nothing when a forward is up, and surviving a fixed delay
   * proves nothing: authentication alone can take seconds. A local forward
   * is ready when its port accepts a connection; a remote forward when `-v`
   * logs the far host's confirmation. A process that exits fails with ssh's
   * reason, and one that does neither by the deadline is killed and failed.
   */
  function waitUntilOpen(id: string): Promise<SshForwardRecord | undefined> {
    const current = records.get(id);
    if (!current || current.state !== "starting")
      return Promise.resolve(snapshot(id));
    const proc = processes.get(id);
    if (!proc) return Promise.resolve(snapshot(id));
    let pending = readiness.get(proc);
    if (!pending) {
      pending = settle(id, current, proc).finally(() => readiness.delete(proc));
      readiness.set(proc, pending);
    }
    return pending;
  }

  async function settle(
    id: string,
    record: SshForwardRecord,
    proc: ForwardProcess,
  ): Promise<SshForwardRecord | undefined> {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pollLocal = async () => {
      while (!stopped) {
        if (await probePort(record.localPort)) return "ready" as const;
        if (stopped) break;
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
      return "stopped" as const;
    };
    const ready =
      record.direction === "remote"
        ? (remoteReady.get(proc) ?? new Promise<never>(() => {})).then(
            () => "ready" as const,
          )
        : pollLocal();
    const exited = (exitsHandled.get(proc) ?? proc.exited).then(
      () => "exited" as const,
    );
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), readyTimeoutMs);
    });
    try {
      const outcome = await Promise.race([ready, exited, deadline]);
      // Closed or replaced while waiting: nothing of ours to settle, and a
      // forward opened since is not this request's answer.
      if (processes.get(id) !== proc) {
        const current = snapshot(id);
        return current?.attempt === record.attempt ? current : undefined;
      }
      if (outcome === "ready") markOpen(id);
      else if (outcome === "timeout") {
        processes.delete(id);
        proc.kill();
        const current = records.get(id);
        if (current) {
          records.set(id, {
            ...current,
            state: "failed",
            error: `The forward was not ready after ${Math.round(readyTimeoutMs / 1000)} s`,
          });
          logger.warn("ssh forward timed out", { id });
          publish();
        }
      }
      return snapshot(id);
    } finally {
      stopped = true;
      clearTimeout(timer);
    }
  }

  /** A forward is only reported open once it has survived its own startup. */
  function markOpen(id: string) {
    const current = records.get(id);
    if (!current || current.state !== "starting") return;
    records.set(id, { ...current, state: "open" });
    publish();
  }

  function close(id: string): boolean {
    const proc = processes.get(id);
    processes.delete(id);
    proc?.kill();
    const current = records.get(id);
    if (!current) return false;
    records.delete(id);
    publish();
    return true;
  }

  /**
   * Closes a forward only if it is still the one a given open() started: a
   * request that went stale must not take down a forward opened since.
   */
  function closeAttempt(record: SshForwardRecord): boolean {
    const current = records.get(record.id);
    if (!current || current.attempt !== record.attempt) return false;
    return close(record.id);
  }

  /**
   * The connection's runtime went away (a reconnect or a removal): its ssh
   * processes are stopped, but the forwards stay listed as failed so the
   * page shows what was lost rather than having them silently vanish.
   * Forwarding the port again replaces the entry; stopping it dismisses it.
   */
  function loseConnection(connectionId: string) {
    let changed = false;
    for (const record of [...records.values()]) {
      if (record.connectionId !== connectionId) continue;
      const proc = processes.get(record.id);
      processes.delete(record.id);
      proc?.kill();
      if (record.state === "failed") continue;
      records.set(record.id, {
        ...record,
        state: "failed",
        error: "Lost with its connection; forward the port again",
      });
      changed = true;
    }
    if (changed) publish();
  }

  function closeAll() {
    for (const record of [...records.values()]) close(record.id);
  }

  function onChange(listener: (forwards: SshForwardRecord[]) => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    list,
    isReserved,
    open,
    waitUntilOpen,
    markOpen,
    close,
    closeAttempt,
    loseConnection,
    closeAll,
    onChange,
  };
}

async function defaultProbePort(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: FORWARD_BIND_HOST,
      port,
      socket: { data() {} },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * Free on both loopbacks: the forward binds 127.0.0.1, but the browser opens
 * http://localhost:PORT, which resolves to ::1 first on many systems and
 * would reach whatever already listens there instead of the forward.
 */
export function defaultPortIsFree(port: number): boolean {
  return canBind(FORWARD_BIND_HOST, port, true) && canBind("::1", port, false);
}

function canBind(hostname: string, port: number, required: boolean): boolean {
  try {
    Bun.listen({ hostname, port, socket: { data() {} } }).stop(true);
    return true;
  } catch (error) {
    // Only "in use" means taken on ::1; a host without IPv6 loopback
    // (EADDRNOTAVAIL, EAFNOSUPPORT) has nothing there to collide with.
    return !required && (error as { code?: string }).code !== "EADDRINUSE";
  }
}

export type ListeningPort = {
  port: number;
  /** Process name when the remote reported one; ss only shows it for your
   * own processes unless privileged, so it is often absent. */
  process?: string;
};

/**
 * Ports a remote is listening on, from `ss -ltnH` (or `netstat -ltn`).
 *
 * Loopback-bound listeners are the interesting ones: a service bound to a
 * routable address is already reachable without a tunnel, while one on
 * 127.0.0.1 is exactly what cannot be reached from here. Addresses like
 * 0.0.0.0 and :: listen on loopback too, so they count.
 *
 * This exists because printed URLs only ever name one port: a dev server
 * announces its page and says nothing about the websocket beside it.
 */
export function parseListeningPorts(output: string): ListeningPort[] {
  const byPort = new Map<number, ListeningPort>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^(Netid|Proto|Active|COMMAND)/i.test(trimmed)) continue;
    const columns = trimmed.split(/\s+/);
    // ss -ltnH: State Recv-Q Send-Q Local:Port Peer:Port [users:(...)]
    // netstat -ltn: Proto Recv-Q Send-Q Local:Port Peer:Port State
    // lsof -nP -iTCP -sTCP:LISTEN: COMMAND PID USER FD TYPE DEVICE SIZE/OFF
    //   NODE NAME (LISTEN), where NAME is Local:Port
    const lsof = trimmed.endsWith("(LISTEN)") && columns.includes("TCP");
    const local = columns.find(
      (column, index) => index > 1 && /^\[?[\d.:a-f*]+\]?:\d+$/i.test(column),
    );
    if (!local) continue;
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const host = local.slice(0, local.lastIndexOf(":"));
    if (!listensOnLoopback(host)) continue;
    // lsof only lists a user's own processes unless run as root, so its
    // COMMAND column carries the same "mine" signal as ss -p.
    const process = lsof
      ? columns[0]
      : trimmed.match(/users:\(\("([^"]+)"/)?.[1];
    const existing = byPort.get(port);
    if (!existing) byPort.set(port, process ? { port, process } : { port });
    else if (process && !existing.process) existing.process = process;
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

function listensOnLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    bare === "127.0.0.1" ||
    bare === "::1" ||
    bare === "localhost" ||
    // Wildcards cover loopback as well as every other interface.
    bare === "0.0.0.0" ||
    bare === "*" ||
    bare === "::" ||
    bare.startsWith("127.")
  );
}

/**
 * `-p` is what makes the result usable: an unprivileged user sees the process
 * behind their own sockets and nothing behind root's, which is exactly the
 * line between "a server I started" and "a system daemon". `ss` is Linux
 * only; macOS has no `ss` and its netstat rejects `-ltnp`, but ships lsof,
 * which shows an unprivileged user their own listeners only. netstat is the
 * last resort for a Linux without either. A machine where all three fail
 * yields a failed scan, which callers treat as nothing listening.
 */
export const LISTENING_PORTS_COMMAND =
  "ss -ltnpH 2>/dev/null || lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || netstat -ltnp 2>/dev/null";

/**
 * Narrows a scan to the listeners worth offering.
 *
 * A developer machine listens on a dozen ports it never thinks about, sshd,
 * resolved, CUPS, mDNS, and burying a dev server among them is how VS Code's
 * process-based detection earned its reputation for over-forwarding. Ports
 * whose process the caller can see are the caller's own, so that split does
 * the work without a denylist of well-known ports to maintain.
 *
 * Where nothing is named at all, `ss` without `-p` support, or a netstat that
 * refuses, the split carries no information, so everything is kept rather
 * than reporting an empty machine.
 */
export function ownedListeningPorts(
  ports: readonly ListeningPort[],
): ListeningPort[] {
  const named = ports.filter((entry) => entry.process);
  return named.length > 0 ? named : [...ports];
}
