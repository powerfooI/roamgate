import {
  type ManagedConnectionProfile,
  type SyntheticLocalProfile,
  testConnectionProfile,
} from "../connections/profile-service";
import {
  CONNECTION_PROFILE_FILE_VERSION,
  type ConnectionProfile,
  ConnectionProfileStore,
  type PersistedConnectionRegistry,
  validateConnectionProfile,
} from "../connections/profiles";
import { LEGACY_DEFAULT_CONNECTION_ID } from "../connections/types";
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
  connectionRegistryPath,
  type ListenerProbe,
  probeListener,
  readServiceAccess,
  readServiceSetup,
  restartRunningService,
  serviceHerdrSockets,
  serviceStatus,
  type ServiceSetup,
} from "./service-context";

export interface ConnectionsDependencies {
  probe?: ListenerProbe;
  test?: typeof testConnectionProfile;
}

function connectionsHelp(): string {
  return `List, test and edit saved Herdr connection profiles.

Usage:
  roamgate connections list [--json]
  roamgate connections test [<id>...] [--json]
  roamgate connections add <id> --ssh <destination> [ssh options] [common options]
  roamgate connections add <id> --control-socket <path> --client-socket <path>
                                [common options]
  roamgate connections remove <id> [--restart]
  roamgate connections set-default <id> [--restart]

Common add options:
  --label <text>     display name (default: the id)
  --auto-connect     connect when Roamgate starts
  --default          make it the default connection
  --restart          see below

SSH add options:
  --remote-control-socket <path>, --remote-client-socket <path>
                     remote socket paths (default: inferred from the remote home)
  --windows          the SSH host runs Windows
  --herdr-path <path>, --session <name>
                     Windows host executable and Herdr session

The profiles are the same ones the connection selector edits. A running
Roamgate keeps its own copy and would overwrite a change made here, so edits
are refused while it serves; with --restart a running managed service is
restarted to load the change. Only the address in the service config is
checked: stop any other roamgate process that shares this registry, such as
a foreground run on another port, before editing here. SSH tests need a
running remote Herdr and non-interactive SSH authentication.
`;
}

const ADD_OPTIONS = {
  label: { type: "string" },
  ssh: { type: "string" },
  "control-socket": { type: "string" },
  "client-socket": { type: "string" },
  "remote-control-socket": { type: "string" },
  "remote-client-socket": { type: "string" },
  windows: { type: "boolean" },
  "herdr-path": { type: "string" },
  session: { type: "string" },
  "auto-connect": { type: "boolean" },
  default: { type: "boolean" },
  restart: { type: "boolean" },
} as const;

/** Mirrors index.ts: explicit Herdr settings pin the process default. */
function explicitOverride(setup: ServiceSetup): boolean {
  return Boolean(
    setup.env.HERDR_SOCKET_PATH ||
      setup.env.HERDR_CLIENT_SOCKET_PATH ||
      setup.env.HERDR_SSH_HOST ||
      setup.env.HERDR_SESSION,
  );
}

function implicitDefault(
  context: CliContext,
  setup: ServiceSetup,
): SyntheticLocalProfile {
  const sockets = serviceHerdrSockets(context.runtime, setup.env);
  return {
    id: LEGACY_DEFAULT_CONNECTION_ID,
    label: "Default",
    type: "local",
    control_socket_path: sockets.socketPath,
    client_socket_path: sockets.clientSocketPath,
    auto_connect: true,
  };
}

function describe(profile: ManagedConnectionProfile): string {
  if (profile.type === "local") return `local  ${profile.control_socket_path}`;
  const remote =
    profile.remote_platform === "windows"
      ? ` (Windows${profile.remote_session ? `, session ${profile.remote_session}` : ""})`
      : "";
  return `ssh    ${profile.ssh_destination}${remote}`;
}

/** Refuse to write while a Roamgate listener holds its own copy of the registry. */
async function guardRunningServer(
  context: CliContext,
  setup: ServiceSetup,
  restart: boolean,
  probe: ListenerProbe,
): Promise<"write" | "write-and-restart" | number> {
  if (!(await probe(readServiceAccess(setup)))) return "write";
  let active = false;
  try {
    active = serviceStatus(context).active;
  } catch {
    // Unsupported platform: only a foreground process can be serving.
  }
  if (!active) {
    context.error(
      "roamgate connections: a roamgate process is serving and would overwrite this change.",
    );
    context.error(
      "Use the connection selector in the web UI, or stop that process first.",
    );
    return EXIT_FAILURE;
  }
  if (!restart) {
    context.error(
      "roamgate connections: the running service keeps its own copy of the profiles and would overwrite this change.",
    );
    context.error(
      "Use the connection selector in the web UI, or rerun with --restart to restart the service.",
    );
    return EXIT_FAILURE;
  }
  return "write-and-restart";
}

function profileFromFlags(
  id: string,
  values: Record<string, string | boolean | undefined>,
): ConnectionProfile {
  const label = (values.label as string | undefined) ?? id;
  const autoConnect = values["auto-connect"] === true;
  const ssh = values.ssh as string | undefined;
  const sshOnly = [
    "remote-control-socket",
    "remote-client-socket",
    "windows",
    "herdr-path",
    "session",
  ];
  if (ssh === undefined) {
    const used = sshOnly.find((key) => values[key] !== undefined);
    if (used) throw new UsageError(`--${used} requires --ssh`);
    if (!values["control-socket"] || !values["client-socket"])
      throw new UsageError(
        "add needs --ssh <destination>, or both --control-socket and --client-socket",
      );
    return validateConnectionProfile({
      id,
      label,
      type: "local",
      control_socket_path: values["control-socket"],
      client_socket_path: values["client-socket"],
      auto_connect: autoConnect,
    });
  }
  if (values["control-socket"] || values["client-socket"])
    throw new UsageError("local socket options cannot be combined with --ssh");
  const windows = values.windows === true;
  return validateConnectionProfile({
    id,
    label,
    type: "ssh",
    ssh_destination: ssh,
    remote_control_socket_path:
      (values["remote-control-socket"] as string | undefined) ?? "",
    remote_client_socket_path:
      (values["remote-client-socket"] as string | undefined) ?? "",
    auto_connect: autoConnect,
    ...(windows ? { remote_platform: "windows" } : {}),
    ...(values["herdr-path"] !== undefined
      ? { remote_herdr_path: values["herdr-path"] }
      : {}),
    ...(values.session !== undefined ? { remote_session: values.session } : {}),
  });
}

export function createConnectionsCommand(
  dependencies: ConnectionsDependencies = {},
): CliCommand {
  const probe = dependencies.probe ?? probeListener;
  const test = dependencies.test ?? testConnectionProfile;
  return {
    name: "connections",
    summary: "list, test and edit Herdr connection profiles",
    actions: ["list", "test", "add", "remove", "set-default"],
    flags: [
      "--json",
      "--ssh",
      "--control-socket",
      "--client-socket",
      "--label",
      "--auto-connect",
      "--default",
      "--restart",
      "--remote-control-socket",
      "--remote-client-socket",
      "--windows",
      "--herdr-path",
      "--session",
    ],
    help: connectionsHelp,
    async run(args, context) {
      const action = args[0];
      if (wantsHelp(args) || action === undefined) {
        context.log(connectionsHelp());
        return EXIT_OK;
      }
      const rest = args.slice(1);
      const setup = readServiceSetup(context.runtime);
      const store = new ConnectionProfileStore({
        path: connectionRegistryPath(context.runtime, setup.env),
      });
      const registry = store.load();
      // Copy: the explicit default is listed but must never reach a save.
      const profiles: ManagedConnectionProfile[] = registry
        ? [...registry.profiles]
        : [implicitDefault(context, setup)];
      const defaultId = explicitOverride(setup)
        ? LEGACY_DEFAULT_CONNECTION_ID
        : (registry?.default_connection_id ?? LEGACY_DEFAULT_CONNECTION_ID);
      if (registry && explicitOverride(setup))
        profiles.unshift(implicitDefault(context, setup));

      if (action === "list") {
        const { values } = parseCommandArgs(rest, {
          json: { type: "boolean" },
        });
        if (values.json) {
          printJson(context, {
            path: store.path,
            default_connection_id: defaultId,
            profiles: profiles.map((profile) => ({
              ...profile,
              default: profile.id === defaultId,
              saved: profile.id !== LEGACY_DEFAULT_CONNECTION_ID,
            })),
          });
          return EXIT_OK;
        }
        context.log(displayPath(store.path, context.runtime));
        if (!registry)
          context.log(
            "No saved profiles; Roamgate uses the default local connection.",
          );
        const width = Math.max(...profiles.map((profile) => profile.id.length));
        for (const profile of profiles) {
          const flags = [
            profile.id === defaultId ? "default" : "",
            profile.auto_connect ? "auto-connect" : "",
            profile.id === LEGACY_DEFAULT_CONNECTION_ID
              ? "from service config"
              : "",
          ].filter(Boolean);
          context.log(
            `${profile.id === defaultId ? "*" : " "} ${profile.id.padEnd(width)}  ${describe(profile)}  ${profile.label}${flags.length ? `  [${flags.join(", ")}]` : ""}`,
          );
        }
        return EXIT_OK;
      }

      if (action === "test") {
        const { values, positionals } = parseCommandArgs(
          rest,
          { json: { type: "boolean" } },
          Number.POSITIVE_INFINITY,
        );
        const selected = positionals.length
          ? positionals.map((id) => {
              const profile = profiles.find((entry) => entry.id === id);
              if (!profile) throw new UsageError(`unknown connection: ${id}`);
              return profile;
            })
          : profiles;
        const results = await Promise.all(
          selected.map(async (profile) => {
            try {
              const result = await test(profile);
              return {
                id: profile.id,
                ok: true,
                version: result.version,
                protocol: result.protocol,
              };
            } catch (error) {
              return {
                id: profile.id,
                ok: false,
                error: (error as Error).message,
              };
            }
          }),
        );
        if (values.json) printJson(context, { results });
        else
          for (const result of results) {
            context.log(
              result.ok
                ? `ok    ${result.id}  Herdr ${result.version ?? "(unknown version)"}, protocol ${result.protocol}`
                : `fail  ${result.id}  ${result.error}`,
            );
          }
        return results.every((result) => result.ok) ? EXIT_OK : EXIT_FAILURE;
      }

      if (action === "add" || action === "remove" || action === "set-default") {
        const { values, positionals } =
          action === "add"
            ? parseCommandArgs(rest, ADD_OPTIONS, 1)
            : parseCommandArgs(rest, { restart: { type: "boolean" } }, 1);
        const id = positionals[0];
        if (!id)
          throw new UsageError(`connections ${action} needs a connection id`);
        const flagValues = values as Record<
          string,
          string | boolean | undefined
        >;

        let next: PersistedConnectionRegistry | null;
        if (action === "add") {
          let profile: ConnectionProfile;
          try {
            profile = profileFromFlags(id, flagValues);
          } catch (error) {
            if (error instanceof UsageError) throw error;
            throw new UsageError((error as Error).message, { cause: error });
          }
          if (profiles.some((entry) => entry.id === id))
            throw new UsageError(`connection already exists: ${id}`);
          if (registry) {
            next = {
              ...registry,
              version: CONNECTION_PROFILE_FILE_VERSION,
              profiles: [...registry.profiles, profile],
            };
          } else if (explicitOverride(setup)) {
            next = {
              version: CONNECTION_PROFILE_FILE_VERSION,
              default_connection_id: profile.id,
              profiles: [profile],
            };
          } else {
            // Like the web UI, keep the implicit local server as a saved profile.
            const implicit = implicitDefault(context, setup);
            const seed: ConnectionProfile = {
              id: id === "local" ? "localhost" : "local",
              label: "Local",
              type: "local",
              control_socket_path: implicit.control_socket_path,
              client_socket_path: implicit.client_socket_path,
              auto_connect: true,
            };
            next = {
              version: CONNECTION_PROFILE_FILE_VERSION,
              default_connection_id: seed.id,
              profiles: [seed, profile],
            };
          }
          if (flagValues.default === true) {
            if (explicitOverride(setup))
              throw new UsageError(
                "explicit Herdr settings in the service config remain the default connection",
              );
            next.default_connection_id = profile.id;
          }
        } else {
          if (
            !registry ||
            id === LEGACY_DEFAULT_CONNECTION_ID ||
            !registry.profiles.some((entry) => entry.id === id)
          )
            throw new UsageError(`no saved connection: ${id}`);
          if (action === "set-default") {
            if (explicitOverride(setup))
              throw new UsageError(
                "explicit Herdr settings in the service config remain the default connection",
              );
            next = {
              ...registry,
              version: CONNECTION_PROFILE_FILE_VERSION,
              default_connection_id: id,
            };
          } else {
            if (
              registry.default_connection_id === id &&
              !explicitOverride(setup)
            )
              throw new UsageError(
                "cannot remove the default connection; choose another default first",
              );
            const remaining = registry.profiles.filter(
              (entry) => entry.id !== id,
            );
            // Without explicit Herdr settings the last profile is always the
            // default, so only an explicit override can clear the registry.
            next = remaining.length
              ? {
                  ...registry,
                  version: CONNECTION_PROFILE_FILE_VERSION,
                  profiles: remaining,
                  default_connection_id:
                    registry.default_connection_id === id
                      ? remaining[0].id
                      : registry.default_connection_id,
                }
              : null;
          }
        }

        const decision = await guardRunningServer(
          context,
          setup,
          flagValues.restart === true,
          probe,
        );
        if (typeof decision === "number") return decision;
        if (next) await store.save(next);
        else await store.clear();
        context.log(
          action === "add"
            ? `Added connection ${id}.`
            : action === "remove"
              ? `Removed connection ${id}.`
              : `Default connection is now ${id}.`,
        );
        if (decision === "write-and-restart") {
          const code = restartRunningService(context);
          if (code === 0) context.log("Restarted the service.");
          return code ?? EXIT_OK;
        }
        return EXIT_OK;
      }

      throw new UsageError(`unknown connections action: ${action}`);
    },
  };
}
