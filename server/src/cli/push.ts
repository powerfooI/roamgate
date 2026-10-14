import { existsSync } from "node:fs";
import {
  readPushRegistry,
  sendPushRequest,
  webPushPath,
  webPushSubject,
} from "../notifications/web-push";
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
import { readServiceSetup, runtimeDataRoot } from "./service-context";

export interface PushDependencies {
  send?: typeof sendPushRequest;
}

function pushHelp(): string {
  return `Check Web Push delivery to enrolled devices.

Usage:
  roamgate push test [--json]

Sends one test notification to every device enrolled for task notifications,
using the service's VAPID keys, and reports each push provider's answer. The
registry is only read: expired subscriptions are reported, and the server
removes them on its next delivery. A device must still allow notifications
for the alert to appear.
`;
}

export function createPushCommand(
  dependencies: PushDependencies = {},
): CliCommand {
  const send = dependencies.send ?? sendPushRequest;
  return {
    name: "push",
    summary: "send a test Web Push notification to enrolled devices",
    actions: ["test"],
    flags: ["--json"],
    help: pushHelp,
    async run(args, context) {
      const action = args[0];
      if (wantsHelp(args) || action === undefined) {
        context.log(pushHelp());
        return EXIT_OK;
      }
      if (action !== "test")
        throw new UsageError(`unknown push action: ${action}`);
      const { values } = parseCommandArgs(args.slice(1), {
        json: { type: "boolean" },
      });
      const setup = readServiceSetup(context.runtime);
      const subject = webPushSubject(setup.env);
      if (!subject) {
        context.error(
          "roamgate push: Web Push is disabled because ROAMGATE_WEB_PUSH_SUBJECT is empty.",
        );
        return EXIT_FAILURE;
      }
      const path = webPushPath(setup.env, runtimeDataRoot(context.runtime));
      if (!existsSync(path)) {
        context.error(
          `roamgate push: no push registry at ${displayPath(path, context.runtime)}; enable Task notifications in a browser first.`,
        );
        return EXIT_FAILURE;
      }
      const registry = readPushRegistry(path);
      if (registry.devices.length === 0) {
        context.error(
          "roamgate push: no devices are enrolled; enable Task notifications in a browser first.",
        );
        return EXIT_FAILURE;
      }
      const payload = JSON.stringify({
        title: "Roamgate test notification",
        body: "Web Push delivery to this device works.",
        tag: "roamgate-test",
        target: null,
      });
      const results = await Promise.all(
        registry.devices.map(async (device) => {
          const provider = new URL(device.subscription.endpoint).hostname;
          try {
            await send(device.subscription, payload, {
              TTL: 300,
              urgency: "high",
              timeout: 10_000,
              vapidDetails: {
                subject,
                publicKey: registry.publicKey,
                privateKey: registry.privateKey,
              },
            });
            return { provider, ok: true as const };
          } catch (error) {
            const status = (error as { statusCode?: number } | null)
              ?.statusCode;
            return {
              provider,
              ok: false as const,
              status,
              error:
                status === 404 || status === 410
                  ? "subscription expired; re-enable notifications on that device"
                  : status
                    ? `provider answered HTTP ${status}`
                    : (error as Error).message,
            };
          }
        }),
      );
      if (values.json) printJson(context, { devices: results });
      else {
        results.forEach((result, index) => {
          context.log(
            result.ok
              ? `ok    device ${index + 1} (${result.provider})`
              : `fail  device ${index + 1} (${result.provider}): ${result.error}`,
          );
        });
      }
      return results.every((result) => result.ok) ? EXIT_OK : EXIT_FAILURE;
    },
  };
}
