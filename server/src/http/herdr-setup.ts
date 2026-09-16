import type { ServerConfig } from "../config/server-config";
import type { ConnectionProfile } from "../connections/profiles";
import {
  resolveHerdrReleaseTarget,
  VERIFIED_HERDR_VERSION,
} from "../herdr/release";
import {
  assertManagedSetupAllowed,
  detectHerdrSetup,
  type HerdrBootstrapDeps,
  type HerdrSetupGuard,
  type HerdrSetupResult,
  type HerdrSetupState,
  setupHerdr,
} from "../herdr/bootstrap";

const HERDR_SETUP_CONFIRMATION_HEADER = "x-roamgate-herdr-setup";

export function herdrSetupGuardForProfile(
  config: Pick<
    ServerConfig,
    | "sshHost"
    | "session"
    | "socketPath"
    | "clientSocketPath"
    | "hasExplicitSocketPath"
    | "hasExplicitClientSocketPath"
  >,
  profile: ConnectionProfile | undefined,
): HerdrSetupGuard {
  if (!profile) throw new Error("Default connection profile is unavailable.");
  return {
    sshHost: profile.type === "ssh" ? profile.ssh_destination : config.sshHost,
    session: config.session,
    hasExplicitSocketPath:
      config.hasExplicitSocketPath ||
      (profile.type === "local" &&
        profile.control_socket_path !== config.socketPath),
    hasExplicitClientSocketPath:
      config.hasExplicitClientSocketPath ||
      (profile.type === "local" &&
        profile.client_socket_path !== config.clientSocketPath),
  };
}

function herdrJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

function statePayload(state: HerdrSetupState): Record<string, unknown> {
  if (state.state === "running") {
    return {
      state: state.state,
      version: state.version,
      protocol: state.protocol,
    };
  }
  if (state.state === "installed") {
    return { state: state.state, binary_path: state.binaryPath };
  }
  return { state: state.state };
}

function resultPayload(result: HerdrSetupResult): Record<string, unknown> {
  return {
    ok: true,
    outcome: result.outcome,
    version: result.version,
    protocol: result.protocol,
    ...(result.outcome === "already-running"
      ? {}
      : { binary_path: result.binaryPath }),
  };
}

export function createHerdrSetupHandlers({
  ping,
  guard,
  bootstrap = {},
}: {
  ping: () => Promise<{ version: string; protocol: number }>;
  guard: () => HerdrSetupGuard;
  bootstrap?: Omit<HerdrBootstrapDeps, "guard" | "ping">;
}) {
  let setupInProgress = false;

  async function handleHerdrStatus(): Promise<Response> {
    try {
      const target = guard();
      let canSetup = true;
      try {
        assertManagedSetupAllowed(target);
      } catch {
        canSetup = false;
      }
      const state = await detectHerdrSetup({
        ...bootstrap,
        guard: target,
        ping,
      });
      const hasRelease =
        resolveHerdrReleaseTarget(
          bootstrap.platform ?? process.platform,
          bootstrap.arch ?? process.arch,
        ) !== null;
      return herdrJson({
        ...statePayload(state),
        can_setup: canSetup && (state.state !== "missing" || hasRelease),
        verified_version: VERIFIED_HERDR_VERSION,
      });
    } catch (error) {
      return herdrJson({ error: (error as Error).message }, { status: 500 });
    }
  }

  async function handleHerdrSetup(req: Request): Promise<Response> {
    if (req.headers.get(HERDR_SETUP_CONFIRMATION_HEADER) !== "1") {
      return herdrJson(
        { error: "Herdr setup confirmation header is required." },
        { status: 403 },
      );
    }
    if (setupInProgress) {
      return herdrJson(
        { error: "A Herdr setup is already in progress." },
        { status: 409 },
      );
    }
    setupInProgress = true;
    try {
      const result = await setupHerdr({ ...bootstrap, guard: guard(), ping });
      return herdrJson(resultPayload(result));
    } catch (error) {
      return herdrJson({ error: (error as Error).message }, { status: 500 });
    } finally {
      setupInProgress = false;
    }
  }

  return { handleHerdrStatus, handleHerdrSetup };
}
