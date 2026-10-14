import {
  browserUrlFor,
  getLanIPs,
  withLoginToken,
} from "../config/server-config";
import {
  type CliCommand,
  displayPath,
  EXIT_FAILURE,
  EXIT_OK,
  parseCommandArgs,
  printJson,
  UsageError,
  wantsHelp,
} from "./command";
import { renderTerminalQr } from "./qr";
import {
  accessUrls,
  readServiceAccess,
  readServiceSetup,
} from "./service-context";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function urlHelp(): string {
  return `Print the login URLs of the managed Roamgate service.

Usage:
  roamgate url [--qr] [--address <host>] [--json]

Options:
  --qr               also print a QR code to open the URL on a phone
  --address <host>   use this host name or IP in the URL, for example a VPN
                     or Tailscale name, instead of the detected addresses
  --json             print machine-readable output

URLs come from the service environment file and include the generated login
token unless the service uses a fixed password. The QR code contains that
token: anyone who scans it can sign in, so do not share screenshots of it.
`;
}

export const urlCommand: CliCommand = {
  name: "url",
  summary: "print login URLs, optionally as a QR code",
  flags: ["--qr", "--address", "--json"],
  help: urlHelp,
  async run(args, context) {
    if (wantsHelp(args)) {
      context.log(urlHelp());
      return EXIT_OK;
    }
    const { values } = parseCommandArgs(args, {
      qr: { type: "boolean" },
      address: { type: "string" },
      json: { type: "boolean" },
    });
    if (values.qr && values.json)
      throw new UsageError("--qr and --json cannot be combined");
    const address = values.address?.trim();
    if (values.address !== undefined && !address)
      throw new UsageError("--address must not be empty");
    if (address && /[\s/?#@]/.test(address))
      throw new UsageError("--address must be a host name or IP address");

    const setup = readServiceSetup(context.runtime);
    const access = readServiceAccess(setup);
    const urls = accessUrls(access, getLanIPs);
    const custom = address
      ? withLoginToken(
          browserUrlFor(address, access.port, access.tls),
          access.auth === "token" ? access.token : undefined,
        )
      : undefined;
    const missingToken = access.auth === "token" && !access.token;

    if (values.json) {
      printJson(context, {
        config_path: setup.configPath,
        config_exists: setup.configExists,
        auth: access.auth,
        token_available: access.auth === "token" ? !missingToken : undefined,
        local: urls.local,
        lan: urls.lan,
        ...(custom ? { address: custom } : {}),
      });
      return EXIT_OK;
    }

    if (!setup.configExists) {
      context.error(
        `No service environment at ${displayPath(setup.configPath, context.runtime)}; showing defaults.`,
      );
    }
    if (access.tokenError) {
      context.error(
        `The login token file is invalid (${access.tokenError}); run \`roamgate auth rotate\`.`,
      );
    } else if (missingToken) {
      context.error(
        "No login token yet: it is created by `roamgate service install` or the first server start.",
      );
    }
    if (custom) context.log(`Address: ${custom}`);
    context.log(`Local:   ${urls.local}`);
    for (const url of urls.lan) context.log(`LAN:     ${url}`);
    if (!values.qr) return EXIT_OK;

    const target = custom ?? urls.lan[0] ?? urls.local;
    const targetHost = new URL(target).hostname;
    if (!custom && LOOPBACK_HOSTS.has(targetHost)) {
      context.error(
        "The service only listens on this machine, so another device cannot open this URL.",
      );
      context.error(
        "Use --address with a reachable name, or `roamgate config set HOST=0.0.0.0 --restart`.",
      );
      return EXIT_FAILURE;
    }
    context.log("");
    context.log(renderTerminalQr(target));
    context.log(`QR code opens: ${new URL(target).origin}`);
    if (access.auth === "token" && access.token) {
      context.log(
        "This code contains your login token. Anyone who scans it can sign in.",
      );
    }
    return EXIT_OK;
  },
};
