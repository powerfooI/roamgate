import { afterEach, describe, expect, test } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import { EXIT_FAILURE, EXIT_OK } from "./command";
import { createPushCommand } from "./push";
import { createTestCli, type TestCli } from "./test-context";

let cli: TestCli;
afterEach(() => cli?.cleanup());

function device(endpoint: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    subscription: {
      endpoint,
      keys: {
        p256dh: ecdh.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    },
    preferences: { completed: true, blocked: false },
  };
}

function writeRegistry(testCli: TestCli, devices: unknown[]) {
  const path = join(testCli.home, ".config", "roamgate", "web-push.json");
  writeFileSync(
    path,
    JSON.stringify({ version: 1, ...webpush.generateVAPIDKeys(), devices }),
    { mode: 0o600 },
  );
  return path;
}

describe("roamgate push test", () => {
  test("sends one test message per device and reports expired ones", async () => {
    cli = createTestCli();
    cli.writeConfig("");
    const path = writeRegistry(cli, [
      device("https://fcm.googleapis.com/fcm/send/one"),
      device("https://web.push.apple.com/two"),
    ]);
    const before = readFileSync(path, "utf8");
    const payloads: unknown[] = [];
    const command = createPushCommand({
      send: async (subscription, payload) => {
        payloads.push(JSON.parse(String(payload)));
        if (subscription.endpoint.includes("apple"))
          throw Object.assign(new Error("gone"), { statusCode: 410 });
        return { statusCode: 201, body: "", headers: {} };
      },
    });
    expect(await command.run(["test"], cli.context)).toBe(EXIT_FAILURE);
    expect(cli.output).toEqual([
      "ok    device 1 (fcm.googleapis.com)",
      "fail  device 2 (web.push.apple.com): subscription expired; re-enable notifications on that device",
    ]);
    expect(payloads[0]).toEqual({
      title: "Roamgate test notification",
      body: "Web Push delivery to this device works.",
      tag: "roamgate-test",
      target: null,
    });
    // The server owns the registry; the CLI never rewrites it.
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("explains disabled push and empty registries", async () => {
    cli = createTestCli();
    cli.writeConfig("ROAMGATE_WEB_PUSH_SUBJECT=\n");
    const send = async () => ({ statusCode: 201, body: "", headers: {} });
    expect(await createPushCommand({ send }).run(["test"], cli.context)).toBe(
      EXIT_FAILURE,
    );
    expect(cli.errors[0]).toContain("disabled");
    cli.writeConfig("");
    expect(await createPushCommand({ send }).run(["test"], cli.context)).toBe(
      EXIT_FAILURE,
    );
    expect(cli.errors[1]).toContain("no push registry");
    writeRegistry(cli, []);
    expect(await createPushCommand({ send }).run(["test"], cli.context)).toBe(
      EXIT_FAILURE,
    );
    expect(cli.errors[2]).toContain("no devices are enrolled");
  });

  test("succeeds when every provider accepts", async () => {
    cli = createTestCli();
    cli.writeConfig("");
    writeRegistry(cli, [device("https://fcm.googleapis.com/fcm/send/one")]);
    const command = createPushCommand({
      send: async () => ({ statusCode: 201, body: "", headers: {} }),
    });
    expect(await command.run(["test"], cli.context)).toBe(EXIT_OK);
  });
});
