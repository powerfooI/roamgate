import type { EntryRecord } from "@earendil-works/pi-durable";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  LEGACY_AZURE_PROVIDER,
  registerLegacyAzureProvider,
} from "./pi-azure-compat";
import { type AssistantDriver, createPiDriver } from "./pi-driver";

const legacy = LEGACY_AZURE_PROVIDER;
const model = "gpt-4.1";

function sse(events: Record<string, unknown>[]) {
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function reply(tool = false) {
  const item = tool
    ? {
        id: "fc_original",
        type: "function_call",
        call_id: "call_original",
        name: "workspace_status",
        arguments: "{}",
      }
    : {
        id: "msg_original",
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Azure answer", annotations: [] },
        ],
      };
  return new Response(
    sse([
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "response_original",
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        },
      },
    ]),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function records(directory: string, entries: unknown[]) {
  const id = (entries[0] as { id: string }).id;
  const database = new DatabaseSync(
    join(directory, "durable", id, "execution.sqlite"),
    {
      readOnly: true,
    },
  );
  try {
    return database
      .prepare("SELECT record FROM entries ORDER BY id")
      .all()
      .map((row) => JSON.parse(String(row.record)) as EntryRecord);
  } finally {
    database.close();
  }
}

async function fixture(response: (index: number) => Response = () => reply()) {
  const directory = mkdtempSync(join(tmpdir(), "roamgate-azure-"));
  const authPath = join(directory, "auth.json");
  const sharedAuthPath = join(directory, "pi-auth.json");
  const modelsPath = join(directory, "models.json");
  const requests: {
    url: string;
    key: string | null;
    label: string | null;
    input: unknown[];
  }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { input: unknown[] };
      requests.push({
        url: request.url,
        key: request.headers.get("api-key"),
        label: request.headers.get("x-roamgate-test"),
        input: body.input,
      });
      return response(requests.length);
    },
  });
  const auth = {
    [legacy]: { type: "api_key", key: "legacy-key" },
    azure: { type: "api_key", key: "current-key" },
  };
  writeFileSync(authPath, JSON.stringify(auth));
  writeFileSync(
    sharedAuthPath,
    JSON.stringify({
      [legacy]: { type: "api_key", key: "shared-legacy-key" },
      azure: { type: "api_key", key: "shared-current-key" },
    }),
  );
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        [legacy]: {
          baseUrl: new URL("legacy/", server.url).href,
          modelOverrides: {
            [model]: {
              name: "Original Azure model",
              headers: { "x-roamgate-test": "legacy" },
            },
          },
        },
        azure: {
          baseUrl: new URL("current/", server.url).href,
          modelOverrides: {
            [model]: {
              name: "Current Azure model",
              headers: { "x-roamgate-test": "current" },
            },
          },
        },
      },
    }),
  );
  const pi = await import("@earendil-works/pi-coding-agent");
  const drivers: AssistantDriver[] = [];
  const createDriver = (dataDirectory = directory) => {
    const driver = createPiDriver(
      dataDirectory,
      async () =>
        ({
          ...pi,
          getAgentDir: () => directory,
          ModelRuntime: {
            create: (
              options: import("@earendil-works/pi-coding-agent").CreateModelRuntimeOptions,
            ) =>
              pi.ModelRuntime.create({
                ...options,
                authPath: options.authPath ?? sharedAuthPath,
              }),
          },
        }) as unknown as typeof pi,
      directory,
    );
    drivers.push(driver);
    return driver;
  };
  const input = (
    changes: Partial<Parameters<AssistantDriver["run"]>[0]> = {},
  ): Parameters<AssistantDriver["run"]>[0] => ({
    config: {
      provider: legacy,
      model,
      credential_source: "assistant",
      allowed_workspaces: [],
    },
    text: "Check workspace status",
    entries: [],
    requestId: "legacy-request",
    signal: new AbortController().signal,
    read: async () => ({ text: "Verified status" }),
    delta: () => {},
    message: () => {},
    tool: () => {},
    error: () => {
      throw new Error("Azure request failed");
    },
    ...changes,
  });
  return {
    directory,
    authPath,
    sharedAuthPath,
    modelsPath,
    requests,
    createDriver,
    input,
    pi,
    async cleanup() {
      for (const driver of drivers) await driver.dispose();
      server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("legacy Azure registration suppresses only eager refresh and restores its own descriptor", async () => {
  const f = await fixture();
  try {
    const runtime = await f.pi.ModelRuntime.create({
      authPath: f.authPath,
      modelsPath: f.modelsPath,
      refreshOnCreate: false,
    });
    const refresh = runtime.refresh;
    let calls = 0;
    Object.defineProperty(runtime, "refresh", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: async (options: Parameters<typeof refresh>[0]) => {
        calls++;
        return refresh.call(runtime, options);
      },
    });
    const before = Object.getOwnPropertyDescriptor(runtime, "refresh");
    await registerLegacyAzureProvider(runtime);
    expect(calls).toBe(0);
    expect(Object.getOwnPropertyDescriptor(runtime, "refresh")).toEqual(before);
    expect(runtime.getError()).toBeUndefined();
    expect(runtime.getModel(legacy, model)?.provider).toBe(legacy);
    await runtime.refresh({ allowNetwork: false, providers: [legacy] });
    expect(calls).toBe(1);
    expect(
      runtime.getAvailableSnapshot().some((entry) => entry.provider === legacy),
    ).toBe(true);
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test("legacy Azure registration restores inherited refresh when registration fails", async () => {
  const f = await fixture();
  try {
    const runtime = await f.pi.ModelRuntime.create({
      authPath: f.authPath,
      modelsPath: null,
      refreshOnCreate: false,
    });
    const refresh = runtime.refresh;
    runtime.registerNativeProvider = () => {
      throw new Error("registration failed");
    };
    await expect(registerLegacyAzureProvider(runtime)).rejects.toThrow(
      "registration failed",
    );
    expect(Object.hasOwn(runtime, "refresh")).toBe(false);
    expect(runtime.refresh).toBe(refresh);
  } finally {
    await f.cleanup();
  }
});

test("legacy Azure login never borrows or replaces the current Azure credential", async () => {
  const f = await fixture();
  try {
    const current = { azure: { type: "api_key", key: "current-key" } };
    writeFileSync(f.authPath, JSON.stringify(current));
    const shared = readFileSync(f.sharedAuthPath, "utf8");
    const models = readFileSync(f.modelsPath, "utf8");
    const driver = f.createDriver();
    const before = await driver.catalog("assistant");
    expect(
      before.providers.find((provider) => provider.id === legacy)?.configured,
    ).toBe(false);
    expect(
      before.providers.find((provider) => provider.id === "azure")?.configured,
    ).toBe(true);
    expect(before.models.some((entry) => entry.provider === legacy)).toBe(
      false,
    );
    await driver.login(legacy, "api_key", {
      credential_source: "assistant",
      signal: new AbortController().signal,
      prompt: async () => "replacement-legacy-key",
      notify: () => {},
    });
    expect(JSON.parse(readFileSync(f.authPath, "utf8"))).toEqual({
      ...current,
      [legacy]: { type: "api_key", key: "replacement-legacy-key" },
    });
    expect(readFileSync(f.sharedAuthPath, "utf8")).toBe(shared);
    expect(readFileSync(f.modelsPath, "utf8")).toBe(models);
    expect(
      (await driver.catalog("assistant")).models.some(
        (entry) => entry.provider === legacy,
      ),
    ).toBe(true);
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test("legacy Azure catalog preserves both IDs and custom providers without commands or file migration", async () => {
  const f = await fixture();
  const sentinel = join(f.directory, "executed");
  try {
    const models = JSON.parse(readFileSync(f.modelsPath, "utf8"));
    models.providers.local = {
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-completions",
      apiKey: `!touch '${sentinel}'`,
      models: [{ id: "custom", reasoning: false }],
    };
    models.providers[legacy].apiKey = `!touch '${sentinel}'`;
    writeFileSync(f.modelsPath, JSON.stringify(models));
    const auth = JSON.parse(readFileSync(f.authPath, "utf8"));
    auth.anthropic = { type: "api_key", key: `!touch '${sentinel}'` };
    writeFileSync(f.authPath, JSON.stringify(auth));
    const originals = [f.authPath, f.sharedAuthPath, f.modelsPath].map((path) =>
      readFileSync(path, "utf8"),
    );
    const driver = f.createDriver();
    for (const source of ["assistant", "pi"] as const) {
      const catalog = await driver.catalog(source);
      expect(
        catalog.providers.find((provider) => provider.id === legacy),
      ).toMatchObject({ configured: true, credential_method: "api_key" });
      expect(
        catalog.models.find(
          (entry) => entry.provider === legacy && entry.id === model,
        ),
      ).toMatchObject({ label: "Original Azure model" });
      expect(
        catalog.models.find(
          (entry) => entry.provider === "azure" && entry.id === model,
        ),
      ).toMatchObject({ label: "Current Azure model" });
      expect(
        catalog.models.find(
          (entry) => entry.provider === "local" && entry.id === "custom",
        )?.custom,
      ).toEqual({
        base_url: "http://127.0.0.1:1/v1",
        api: "openai-completions",
        reasoning: false,
      });
      expect(
        catalog.providers.find((provider) => provider.id === legacy)?.custom,
      ).toBeUndefined();
      expect(JSON.stringify(catalog)).not.toContain("legacy-key");
      expect(JSON.stringify(catalog)).not.toContain("!touch");
      expect(await driver.catalog(source)).toEqual(catalog);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(existsSync(sentinel)).toBe(false);
    expect(
      [f.authPath, f.sharedAuthPath, f.modelsPath].map((path) =>
        readFileSync(path, "utf8"),
      ),
    ).toEqual(originals);
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test.each(["assistant", "pi"] as const)(
  "legacy Azure %s credentials resume task storage and preserve tool item IDs",
  async (source) => {
    const f = await fixture((index) => reply(index === 1));
    const taskDirectory = join(f.directory, "task-run");
    let reads = 0;
    try {
      const originals = [f.authPath, f.sharedAuthPath, f.modelsPath].map(
        (path) => readFileSync(path, "utf8"),
      );
      const input = f.input({
        config: {
          provider: legacy,
          model,
          credential_source: source,
          allowed_workspaces: [],
        },
        read: async () => {
          reads++;
          return { text: "Verified status" };
        },
      });
      const first = f.createDriver(taskDirectory);
      const entries = await first.run(input);
      await first.dispose();
      const messages = records(taskDirectory, entries).flatMap(
        (entry) => entry.model ?? [],
      );
      expect(
        messages
          .filter((message) => message.role === "assistant")
          .every((message) => message.provider === legacy),
      ).toBe(true);
      expect(reads).toBe(1);
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1]?.input).toContainEqual(
        expect.objectContaining({
          type: "function_call",
          id: "fc_original",
          call_id: "call_original",
        }),
      );
      expect(f.requests[1]?.input).toContainEqual(
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_original",
        }),
      );
      const second = f.createDriver(taskDirectory);
      const restored: string[] = [];
      await second.run({
        ...input,
        entries,
        recover: true,
        replace: (text) => restored.push(text),
      });
      expect(restored.at(-1)).toBe("Azure answer");
      expect(f.requests).toHaveLength(2);
      await second.run({ ...input, entries, requestId: "next-question" });
      expect(f.requests).toHaveLength(3);
      expect(reads).toBe(1);
      expect(f.requests[2]?.input).toContainEqual(
        expect.objectContaining({
          type: "function_call",
          id: "fc_original",
          call_id: "call_original",
        }),
      );
      for (const request of f.requests) {
        expect(request.url).toContain("/legacy/");
        expect(request.key).toBe(
          source === "assistant" ? "legacy-key" : "shared-legacy-key",
        );
        expect(request.label).toBe("legacy");
      }
      await f
        .createDriver(join(f.directory, "new-azure-run"))
        .run({ ...input, config: { ...input.config, provider: "azure" } });
      expect(f.requests.at(-1)).toMatchObject({
        key: source === "assistant" ? "current-key" : "shared-current-key",
        label: "current",
      });
      expect(f.requests.at(-1)?.url).toContain("/current/");
      expect(existsSync(join(taskDirectory, "auth.json"))).toBe(false);
      expect(
        [f.authPath, f.sharedAuthPath, f.modelsPath].map((path) =>
          readFileSync(path, "utf8"),
        ),
      ).toEqual(originals);
    } finally {
      await f.cleanup();
    }
  },
);

test("legacy Azure interrupted durable run resumes with its unchanged provider reference", async () => {
  const partial = Promise.withResolvers<void>();
  const f = await fixture((index) =>
    index === 1
      ? new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  sse([
                    {
                      type: "response.output_item.added",
                      output_index: 0,
                      item: {
                        id: "msg_partial",
                        type: "message",
                        role: "assistant",
                        content: [],
                      },
                    },
                    {
                      type: "response.output_text.delta",
                      output_index: 0,
                      delta: "Partial before pause",
                    },
                  ]),
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      : reply(),
  );
  let entries: unknown[] = [];
  try {
    const first = f.createDriver();
    const pending = first.run(
      f.input({
        checkpoint: (value) => {
          entries = value;
        },
        replace: (text) => {
          if (text.includes("Partial before pause")) partial.resolve();
        },
      }),
    );
    await partial.promise;
    await first.dispose();
    expect(await pending).toEqual(entries);
    const restored: string[] = [];
    await f.createDriver().run(
      f.input({
        entries,
        recover: true,
        replace: (text) => restored.push(text),
      }),
    );
    expect(restored.at(-1)).toBe("Azure answer");
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[1]?.input)).not.toContain(
      "Partial before pause",
    );
    expect(
      records(f.directory, entries).filter((entry) => entry.kind === "pi.user"),
    ).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});
