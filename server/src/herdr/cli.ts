import { HerdrClient } from "../bridge/herdr-client";
import { loadServerConfig } from "../config/server-config";
import {
  detectHerdrSetup,
  type HerdrSetupGuard,
  type HerdrSetupResult,
  type HerdrSetupState,
  setupHerdr,
} from "./bootstrap";
import { herdrServiceStatus } from "./service";
import { VERIFIED_HERDR_VERSION } from "./release";

function herdrHelp(): string {
  return `Install and start the local Herdr server.

Usage:
  roamgate herdr setup
  roamgate herdr status

Setup installs the Roamgate-verified Herdr ${VERIFIED_HERDR_VERSION} release
when no herdr binary is found, then installs and starts a user service running
\`herdr server\` (systemd user service on Linux, launchd LaunchAgent on macOS,
per-user Task Scheduler task on Windows). An existing herdr binary is used as
is and never replaced. Status prints the detected state.
`;
}

export interface HerdrCommandDeps {
  loadConfig?: typeof loadServerConfig;
  detect?: () => Promise<HerdrSetupState>;
  setup?: () => Promise<HerdrSetupResult>;
  serviceStatus?: () => { installed: boolean; active: boolean };
  log?: (message: string) => void;
  error?: (message: string) => void;
}

// loadServerConfig parses process.argv strictly, so remove the herdr words
// first. Guarded so tests (and unusual argv layouts) never mutate argv.
function stripHerdrArgv(action: string) {
  if (process.argv[2] === "herdr" && process.argv[3] === action) {
    process.argv.splice(2, 2);
  }
}

/**
 * Handle `roamgate herdr ...`. Returns null when argv is not a herdr command,
 * matching the runServiceCommand convention.
 */
export async function runHerdrCommand(
  args: string[],
  appVersion: string,
  dependencies: HerdrCommandDeps = {},
): Promise<number | null> {
  if (args[0] !== "herdr") return null;
  const log = dependencies.log ?? console.log;
  const error = dependencies.error ?? console.error;
  const action = args[1];
  if (
    args.length === 1 ||
    action === "help" ||
    action === "--help" ||
    action === "-h"
  ) {
    log(herdrHelp());
    return 0;
  }
  if (action !== "setup" && action !== "status") {
    error(`unknown herdr action: ${action}`);
    error("Run `roamgate herdr --help` for usage.");
    return 1;
  }

  try {
    stripHerdrArgv(action);
    const loadConfig = dependencies.loadConfig ?? loadServerConfig;
    const config = loadConfig(appVersion);
    const guard: HerdrSetupGuard = {
      sshHost: config.sshHost,
      session: config.session,
      hasExplicitSocketPath: config.hasExplicitSocketPath,
      hasExplicitClientSocketPath: config.hasExplicitClientSocketPath,
    };
    const ping = () => new HerdrClient(config.socketPath).ping();
    const detect =
      dependencies.detect ?? (() => detectHerdrSetup({ guard, ping }));
    const serviceStatus = dependencies.serviceStatus ?? herdrServiceStatus;

    if (action === "status") {
      const state = await detect();
      if (state.state === "running") {
        log(
          `Herdr is running (version ${state.version}, protocol ${state.protocol}).`,
        );
      } else if (state.state === "installed") {
        log(`Herdr is installed but not running: ${state.binaryPath}`);
        log("Run `roamgate herdr setup` to start it as a user service.");
      } else {
        log("Herdr is not installed.");
        log(
          `Run \`roamgate herdr setup\` to install the verified Herdr ${VERIFIED_HERDR_VERSION} and start it.`,
        );
      }
      const service = serviceStatus();
      log(
        `Managed service: ${
          service.installed
            ? service.active
              ? "installed, active"
              : "installed, inactive"
            : "not installed"
        }`,
      );
      return 0;
    }

    const setup = dependencies.setup ?? (() => setupHerdr({ guard, ping }));
    const result = await setup();
    if (result.outcome === "already-running") {
      log(
        `Herdr is already running (version ${result.version}, protocol ${result.protocol}).`,
      );
    } else {
      log(
        result.outcome === "started"
          ? `Started Herdr ${result.version} as a user service.`
          : `Installed Herdr ${result.version} and started it as a user service.`,
      );
      log(`Binary: ${result.binaryPath}`);
    }
    return 0;
  } catch (cause) {
    error(`roamgate herdr: ${(cause as Error).message}`);
    error("Run `roamgate herdr --help` for usage.");
    return 1;
  }
}
