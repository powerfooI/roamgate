import { expect, test } from "bun:test";
import { handleInstanceSettings } from "./instance-settings";

function put(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://roamgate.example/api/instance-settings", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-roamgate-settings": "1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("instance settings reject cross-site and simple browser writes", async () => {
  const rejectedHeaders: Record<string, string>[] = [
    { "x-roamgate-settings": "" },
    { "sec-fetch-site": "cross-site" },
    { "content-type": "text/plain" },
  ];
  for (const headers of rejectedHeaders) {
    const response = await handleInstanceSettings(
      put({ title_suffix: "Work" }, headers),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  for (const method of ["POST", "DELETE", "OPTIONS", "HEAD"]) {
    const response = await handleInstanceSettings(
      new Request("https://roamgate.example/api/instance-settings", { method }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, PUT");
  }
});

test("invalid or oversized settings never reach persistence", async () => {
  for (const body of [
    null,
    [],
    {},
    { title_suffix: false },
    { title_suffix: "x".repeat(33) },
    { title_suffix: "x\u0000" },
  ]) {
    const response = await handleInstanceSettings(put(body));
    expect(response.status).toBe(400);
    expect(typeof (await response.json()).error).toBe("string");
  }
  const malformed = await handleInstanceSettings(
    new Request("https://roamgate.example/api/instance-settings", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-roamgate-settings": "1",
      },
      body: "{",
    }),
  );
  expect(malformed.status).toBe(400);
  let cancelled = false;
  const oversized = await handleInstanceSettings(
    new Request("https://roamgate.example/api/instance-settings", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-roamgate-settings": "1",
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4097));
        },
        cancel() {
          cancelled = true;
        },
      }),
    }),
  );
  expect(oversized.status).toBe(413);
  expect(cancelled).toBe(true);
});
