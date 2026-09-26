import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ConnectionClient } from "./api";
import { uploadTerminalImage } from "./terminalImageUpload";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const client = {
  connectionId: "conn-a",
  generation: 1,
  serverRuntimeGeneration: 3,
  call: async () => undefined,
  isCurrent: () => true,
  acceptsServerGeneration: () => true,
} satisfies ConnectionClient;
const image = new File(["image"], "image.png", { type: "image/png" });

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "https://studio.example" } },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
});

describe("terminal image upload responses", () => {
  test("returns a validated path", async () => {
    globalThis.fetch = (async () =>
      Response.json({ path: "/tmp/image.png" })) as unknown as typeof fetch;

    await expect(uploadTerminalImage(client, image)).resolves.toBe(
      "/tmp/image.png",
    );
  });

  test("prefers the server's shell-safe text over the raw path", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        path: "C:\\Users\\John Doe\\Temp\\image.png",
        text: "'C:/Users/John Doe/Temp/image.png'",
      })) as unknown as typeof fetch;

    await expect(uploadTerminalImage(client, image)).resolves.toBe(
      "'C:/Users/John Doe/Temp/image.png'",
    );
  });

  test("rejects malformed JSON instead of silently continuing", async () => {
    globalThis.fetch = (async () =>
      new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(uploadTerminalImage(client, image)).rejects.toThrow();
  });

  test("surfaces non-JSON HTTP error bodies", async () => {
    globalThis.fetch = (async () =>
      new Response("proxy authentication required", {
        status: 407,
        statusText: "Proxy Authentication Required",
      })) as unknown as typeof fetch;

    await expect(uploadTerminalImage(client, image)).rejects.toThrow(
      "proxy authentication required",
    );
  });

  test("uses structured errors from failed JSON responses", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { error: "image is too large" },
        { status: 413, statusText: "Payload Too Large" },
      )) as unknown as typeof fetch;

    await expect(uploadTerminalImage(client, image)).rejects.toThrow(
      "image is too large",
    );
  });

  test("rejects successful responses without a path", async () => {
    globalThis.fetch = (async () =>
      Response.json({})) as unknown as typeof fetch;

    await expect(uploadTerminalImage(client, image)).rejects.toThrow(
      "image upload response did not include a path",
    );
  });
});
