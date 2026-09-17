import { createECDH, ECDH, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import webpush from "web-push";
import {
  assertSafeDataPath,
  dataRoot,
  publishDataFile,
} from "../config/data-paths";
import { roamgateEnv } from "../config/environment";
import type { TaskEvent } from "./task-events";

export interface PushPreferences {
  completed: boolean;
  blocked: boolean;
}
interface Device {
  subscription: webpush.PushSubscription;
  preferences: PushPreferences;
}
interface Registry {
  version: 1;
  publicKey: string;
  privateKey: string;
  devices: Device[];
}
export interface PushTask extends TaskEvent {
  connectionId: string;
  runtimeGeneration: number;
}
const MAX_DEVICES = 128;
const MAX_BODY_BYTES = 16 * 1024;

/** Only browser push providers are valid outbound destinations, never arbitrary URLs. */
export function validatePushEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096)
    throw new Error("Invalid push endpoint");
  const url = new URL(value);
  const host = url.hostname;
  const allowed =
    host === "fcm.googleapis.com" ||
    host === "updates.push.services.mozilla.com" ||
    host.endsWith(".push.services.mozilla.com") ||
    host === "web.push.apple.com" ||
    host.endsWith(".push.apple.com") ||
    host.endsWith(".notify.windows.com");
  if (
    !allowed ||
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Unsupported push provider");
  return url.href;
}

function keyBytes(value: unknown, length: number): Buffer {
  if (typeof value !== "string" || !/^[\w-]+$/.test(value))
    throw new Error("Invalid push key");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== value)
    throw new Error("Invalid push key");
  return bytes;
}

export function validatePushDevice(value: unknown): Device {
  const input = value as Device | null;
  const subscription = input?.subscription;
  const preferences = input?.preferences;
  if (
    !subscription ||
    typeof preferences?.completed !== "boolean" ||
    typeof preferences.blocked !== "boolean"
  )
    throw new Error("Invalid push preferences");
  const endpoint = validatePushEndpoint(subscription.endpoint);
  const p256dh = keyBytes(subscription.keys?.p256dh, 65);
  if (p256dh[0] !== 4) throw new Error("Invalid push key");
  ECDH.convertKey(p256dh, "prime256v1");
  keyBytes(subscription.keys?.auth, 16);
  return {
    subscription: {
      endpoint,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    },
    preferences: {
      completed: preferences.completed,
      blocked: preferences.blocked,
    },
  };
}

async function readBody(req: Request): Promise<unknown> {
  if (!req.body) throw new Error("Missing request body");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("Request body too large");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}

export function createWebPushService(
  options: {
    subject?: string;
    path?: string;
    send?: typeof webpush.sendNotification;
    warn?: (message: string) => void;
  } = {},
) {
  const subject = options.subject ?? roamgateEnv("WEB_PUSH_SUBJECT");
  const path =
    options.path ??
    roamgateEnv("WEB_PUSH_PATH") ??
    join(dataRoot(), "web-push.json");
  const send: typeof webpush.sendNotification =
    options.send ??
    (async (subscription, payload, settings) => {
      const details = webpush.generateRequestDetails(
        subscription,
        payload ?? undefined,
        settings,
      );
      const response = await fetch(details.endpoint, {
        method: details.method,
        headers: details.headers,
        body: Uint8Array.from(details.body),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      if (!response.ok)
        throw Object.assign(new Error("Push provider rejected delivery"), {
          statusCode: response.status,
        });
      return { statusCode: response.status, body: "", headers: {} };
    });
  const warn = options.warn ?? (() => {});
  // ponytail: one process owns this file; use a transactional store for shared deployments.
  let registry: Registry | null = null;
  let stopped = false;
  const queue: Array<{
    device: Device;
    task: PushTask;
    isCurrent: () => boolean;
  }> = [];
  let active = 0;

  function save(next: Registry) {
    assertSafeDataPath(path);
    const temporary = join(dirname(path), `.web-push-${randomUUID()}.tmp`);
    try {
      publishDataFile(temporary, JSON.stringify(next) + "\n");
      assertSafeDataPath(path);
      renameSync(temporary, path);
      registry = next;
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  if (subject) {
    try {
      const contact = new URL(subject);
      if (
        !(
          contact.protocol === "https:" ||
          (contact.protocol === "mailto:" && contact.pathname.includes("@"))
        )
      )
        throw new Error("Invalid VAPID subject");
      assertSafeDataPath(path);
      if (!existsSync(path))
        publishDataFile(
          path,
          JSON.stringify({
            version: 1,
            ...webpush.generateVAPIDKeys(),
            devices: [],
          }),
        );
      if (statSync(path).size > 1024 * 1024)
        throw new Error("Push registry too large");
      const stored = JSON.parse(readFileSync(path, "utf8")) as Registry;
      if (
        stored.version !== 1 ||
        !Array.isArray(stored.devices) ||
        stored.devices.length > MAX_DEVICES
      )
        throw new Error("Invalid push registry");
      const ecdh = createECDH("prime256v1");
      ecdh.setPrivateKey(keyBytes(stored.privateKey, 32));
      if (ecdh.getPublicKey().toString("base64url") !== stored.publicKey)
        throw new Error("Invalid VAPID key pair");
      registry = { ...stored, devices: stored.devices.map(validatePushDevice) };
      chmodSync(path, 0o600);
    } catch {
      registry = null;
      warn(
        "Web Push unavailable: check the VAPID subject and private registry file; existing data was preserved.",
      );
    }
  }

  function forget(device: Device) {
    if (!registry || !registry.devices.includes(device)) return;
    save({
      ...registry,
      devices: registry.devices.filter((entry) => entry !== device),
    });
  }

  async function deliver(item: (typeof queue)[number]) {
    const { device, task, isCurrent } = item;
    if (
      stopped ||
      !registry?.devices.includes(device) ||
      !isCurrent() ||
      !device.preferences[task.kind]
    )
      return;
    const target = {
      connectionId: task.connectionId,
      runtimeGeneration: task.runtimeGeneration,
      workspaceId: task.workspaceId,
      paneId: task.paneId,
    };
    try {
      await send(
        device.subscription,
        JSON.stringify({
          title:
            task.kind === "blocked"
              ? "Roamgate agent needs input"
              : "Roamgate task completed",
          body: `${task.agent.slice(0, 80)} · ${task.connectionId.slice(0, 80)} · workspace ${task.workspaceId.slice(0, 80)}`,
          tag: JSON.stringify([
            "roamgate-task",
            task.connectionId,
            task.runtimeGeneration,
            task.paneId,
          ]),
          target,
        }),
        {
          TTL: 300,
          urgency: "high",
          timeout: 10_000,
          vapidDetails: {
            subject: subject!,
            publicKey: registry.publicKey,
            privateKey: registry.privateKey,
          },
        },
      );
    } catch (error) {
      const status = (error as { statusCode?: number } | null)?.statusCode;
      if (status === 404 || status === 410) {
        try {
          forget(device);
        } catch {
          warn("Unable to persist expired Web Push subscription removal.");
        }
      } else
        warn(
          "Web Push delivery failed; check outbound connectivity and VAPID configuration.",
        );
    }
  }

  function drain() {
    while (!stopped && active < 4 && queue.length) {
      const item = queue.shift()!;
      active++;
      void deliver(item).finally(() => {
        active--;
        drain();
      });
    }
  }

  return {
    async handle(req: Request): Promise<Response> {
      const headers = { "Cache-Control": "no-store" };
      if (req.method === "GET")
        return Response.json(
          {
            available: Boolean(registry),
            publicKey: registry?.publicKey ?? null,
          },
          { headers },
        );
      if (req.method !== "POST" && req.method !== "DELETE")
        return new Response("Method not allowed", { status: 405, headers });
      // A custom header and JSON require a same-origin request (no CORS grant).
      if (
        req.headers.get("x-roamgate-push") !== "1" ||
        req.headers.get("sec-fetch-site") === "cross-site" ||
        req.headers.get("content-type")?.split(";")[0] !== "application/json"
      )
        return new Response("Forbidden", { status: 403, headers });
      if (!registry)
        return Response.json(
          { error: "Web Push is not configured on this server" },
          { status: 503, headers },
        );
      let input: unknown;
      try {
        input = await readBody(req);
      } catch {
        return Response.json(
          { error: "Invalid push request" },
          { status: 400, headers },
        );
      }
      let device: Device | undefined;
      let endpoint: string;
      try {
        if (req.method === "POST") {
          device = validatePushDevice(input);
          endpoint = device.subscription.endpoint;
        } else
          endpoint = validatePushEndpoint(
            (input as { endpoint?: unknown } | null)?.endpoint,
          );
      } catch {
        return Response.json(
          { error: "Invalid push subscription or preferences" },
          { status: 400, headers },
        );
      }
      const devices = registry.devices.filter(
        (entry) => entry.subscription.endpoint !== endpoint,
      );
      if (device) devices.push(device);
      if (devices.length > MAX_DEVICES)
        return Response.json(
          { error: "Push device limit reached" },
          { status: 409, headers },
        );
      try {
        save({ ...registry, devices });
      } catch {
        return Response.json(
          { error: "Unable to save push subscription" },
          { status: 500, headers },
        );
      }
      return Response.json({ ok: true }, { headers });
    },
    notify(task: PushTask, isCurrent: () => boolean) {
      if (!registry || stopped || !isCurrent()) return;
      for (const device of registry.devices) {
        if (!device.preferences[task.kind]) continue;
        if (queue.length >= 256) {
          warn("Web Push queue is full; notification dropped.");
          break;
        }
        queue.push({ device, task, isCurrent });
      }
      drain();
    },
    stop() {
      stopped = true;
      queue.length = 0;
    },
  };
}
