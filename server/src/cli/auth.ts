import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { rotateAuthToken } from "../config/auth-token";
import { roamgateEnv } from "../config/environment";
import {
  revokeSessionSecret,
  sessionSecretPath,
} from "../config/session-secret";
import { getLanIPs } from "../config/server-config";
import {
  type CliCommand,
  type CliContext,
  displayPath,
  EXIT_FAILURE,
  EXIT_OK,
  parseCommandArgs,
  printJson,
  UsageError,
  wantsHelp,
} from "./command";
import {
  accessUrls,
  readServiceAccess,
  readServiceSetup,
  restartRunningService,
  runtimeDataRoot,
} from "./service-context";

function authHelp(): string {
  return `Inspect and rotate login credentials of the managed service.

Usage:
  roamgate auth show [--reveal] [--json]
  roamgate auth rotate [--no-restart]
  roamgate auth revoke-sessions [--no-restart]

show             print the login method, token file and PIN state; the token
                 is masked unless --reveal is given
rotate           replace the generated login token, which also signs out every
                 browser, then restart the running service and print new URLs
revoke-sessions  sign out every browser without changing the token or password

Both changes take effect when the server restarts. They restart a running
managed service unless --no-restart is given; restart foreground runs yourself.
Use \`roamgate config set ROAMGATE_PASSWORD=- --restart\` to change a fixed password.
`;
}

function mask(token: string): string {
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function finish(context: CliContext, restart: boolean): number {
  if (!restart) {
    context.log("Restart Roamgate to apply: `roamgate service restart`.");
    return EXIT_OK;
  }
  let code: number | null;
  try {
    code = restartRunningService(context);
  } catch (error) {
    context.error(`roamgate auth: ${(error as Error).message}`);
    return EXIT_FAILURE;
  }
  if (code === null) {
    context.log(
      "The managed service is not running; restart any foreground roamgate process to apply.",
    );
    return EXIT_OK;
  }
  if (code === 0) context.log("Restarted the service.");
  return code;
}

export const authCommand: CliCommand = {
  name: "auth",
  summary: "show or rotate login credentials and sign out browsers",
  actions: ["show", "rotate", "revoke-sessions"],
  flags: ["--reveal", "--json", "--no-restart"],
  help: authHelp,
  async run(args, context) {
    const action = args[0];
    if (wantsHelp(args) || action === undefined) {
      context.log(authHelp());
      return EXIT_OK;
    }
    const rest = args.slice(1);
    const setup = readServiceSetup(context.runtime);
    const secretPath = sessionSecretPath(
      roamgateEnv("SETTINGS_PATH", setup.env),
      runtimeDataRoot(context.runtime),
    );

    if (action === "show") {
      const access = readServiceAccess(setup);
      const { values } = parseCommandArgs(rest, {
        reveal: { type: "boolean" },
        json: { type: "boolean" },
      });
      const token =
        access.token && (values.reveal ? access.token : mask(access.token));
      if (values.json) {
        printJson(context, {
          method: access.auth,
          token_path: access.auth === "token" ? access.tokenPath : undefined,
          token: access.auth === "token" ? (token ?? null) : undefined,
          token_error: access.tokenError,
          pin_enabled: access.pinEnabled,
          session_secret_path: secretPath,
          session_secret_exists: existsSync(secretPath),
        });
        return EXIT_OK;
      }
      if (access.auth === "password") {
        context.log(
          "Login: fixed password (ROAMGATE_PASSWORD in the service config)",
        );
      } else {
        context.log("Login: generated token");
        context.log(
          `Token file: ${displayPath(access.tokenPath, context.runtime)}`,
        );
        context.log(
          `Token: ${
            access.tokenError
              ? `invalid (${access.tokenError}); run \`roamgate auth rotate\``
              : (token ?? "(not created yet)")
          }`,
        );
      }
      context.log(`PIN login: ${access.pinEnabled ? "enabled" : "disabled"}`);
      return EXIT_OK;
    }

    const { values } = parseCommandArgs(rest, {
      "no-restart": { type: "boolean" },
    });
    const restart = values["no-restart"] !== true;

    if (action === "rotate") {
      // A broken token file is reported, not thrown, so rotate can replace it.
      const access = readServiceAccess(setup);
      if (access.auth === "password") {
        context.error(
          "roamgate auth: the service uses a fixed password, not a generated token.",
        );
        context.error(
          "Change it with `roamgate config set ROAMGATE_PASSWORD=- --restart`.",
        );
        return EXIT_FAILURE;
      }
      // The server reads the current location and migrates only when it is absent.
      const tokenPath = join(dirname(setup.paths.config), "auth-token");
      const token = rotateAuthToken(tokenPath);
      context.log(
        `Rotated the login token in ${displayPath(tokenPath, context.runtime)}.`,
      );
      context.log(
        "Every signed-in browser must sign in again with the new URL.",
      );
      if (access.pinEnabled)
        context.log("PIN login stays enabled with the same PIN.");
      const code = finish(context, restart);
      const urls = accessUrls({ ...access, token, tokenPath }, getLanIPs);
      context.log(`Open: ${urls.local}`);
      for (const url of urls.lan) context.log(`LAN: ${url}`);
      return code;
    }

    if (action === "revoke-sessions") {
      const removed = revokeSessionSecret(secretPath);
      context.log(
        removed
          ? "Discarded the session signing secret; every browser must sign in again."
          : "No session signing secret exists yet; there are no sessions to revoke.",
      );
      return removed ? finish(context, restart) : EXIT_OK;
    }

    throw new UsageError(`unknown auth action: ${action}`);
  },
};
