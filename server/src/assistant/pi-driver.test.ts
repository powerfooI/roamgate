import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type AssistantDriver, createPiDriver } from "./pi-driver";
import { actionTools, type WorkspaceToolResult, workspaceTools } from "./tools";

function durableEntries(directory: string, entries: unknown[]) {
  const pointer = entries[0] as { id: string };
  const sqlite = join(directory, "durable", pointer.id, "execution.sqlite");
  const database = new DatabaseSync(sqlite, { readOnly: true });
  try {
    return database
      .prepare("SELECT record FROM entries ORDER BY id")
      .all()
      .map(
        (row) =>
          JSON.parse(
            String(row.record),
          ) as import("@earendil-works/pi-durable").EntryRecord,
      );
  } finally {
    database.close();
  }
}

function events(values: Record<string, unknown>[]) {
  return values
    .map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
    .join("");
}

function start(index: number) {
  return {
    type: "message_start",
    message: {
      id: `message-${index}`,
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  };
}

function text(value: string) {
  return [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: value },
    },
    { type: "content_block_stop", index: 0 },
  ];
}

function finish(reason: string) {
  return [
    {
      type: "message_delta",
      delta: { stop_reason: reason, stop_sequence: null },
      usage: { output_tokens: 10 },
    },
    { type: "message_stop" },
  ];
}

function toolUse(
  name: string,
  id: string,
  input: Record<string, unknown>,
  index: number,
) {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    },
    {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { type: "content_block_stop", index },
  ];
}

async function durableFixture(reply: (index: number) => Response) {
  const directory = mkdtempSync(join(tmpdir(), "roamgate-durable-"));
  writeFileSync(
    join(directory, "auth.json"),
    JSON.stringify({
      anthropic: { type: "api_key", key: "synthetic-local-key" },
    }),
  );
  const requests: { messages: unknown[]; tools: { name: string }[] }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as (typeof requests)[number]);
      return reply(requests.length);
    },
  });
  const pi = await import("@earendil-works/pi-coding-agent");
  const drivers: AssistantDriver[] = [];
  const createDriver = (dataDirectory = directory) => {
    const driver = createPiDriver(
      dataDirectory,
      async () =>
        ({
          ...pi,
          ModelRuntime: {
            create: async (
              options: import("@earendil-works/pi-coding-agent").CreateModelRuntimeOptions,
            ) => {
              const runtime = await pi.ModelRuntime.create(options);
              const model = runtime
                .getModels("anthropic")
                .find((model) => model.api === "anthropic-messages")!;
              runtime.getModel = () => ({ ...model, baseUrl: server.url.href });
              return runtime;
            },
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
      provider: "anthropic",
      model: "test",
      credential_source: "assistant",
      allowed_workspaces: [],
    },
    entries: [],
    text: "Inspect the authorized workspace.",
    requestId: "request-1",
    signal: new AbortController().signal,
    read: async () => ({ text: "Running" }),
    delta: () => {},
    message: () => {},
    tool: () => {},
    error: () => {},
    ...changes,
  });
  return {
    directory,
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

function modelReply(index: number, values: Record<string, unknown>[]) {
  return new Response(events([start(index), ...values]), {
    headers: { "content-type": "text/event-stream" },
  });
}

function hangingReply(index: number) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            events([
              start(index),
              {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "Partial before pause" },
              },
            ]),
          ),
        );
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("task tools use shared credentials with isolated durable storage and never replay a recorded proposal", async () => {
  const proposed = {
    title: "Daily status",
    prompt: "Summarize the workspace status.",
    scope: [{ connection_id: "local", workspace_id: "workspace" }],
    schedule: { type: "daily", time: "09:00", timezone: "Asia/Shanghai" },
  };
  const f = await durableFixture((index) =>
    modelReply(
      index,
      index === 1
        ? [
            ...toolUse("list_ranger_tasks", "list-tasks", {}, 0),
            ...finish("tool_use"),
          ]
        : index === 2
          ? [
              ...toolUse("propose_ranger_task", "propose-task", proposed, 0),
              ...finish("tool_use"),
            ]
          : [
              ...text("Task preview is awaiting confirmation."),
              ...finish("end_turn"),
            ],
    ),
  );
  let creates = 0;
  let lists = 0;
  const dataDirectory = join(f.directory, "task-run");
  try {
    const task: NonNullable<
      Parameters<AssistantDriver["run"]>[0]["task"]
    > = async (kind, params) => {
      if (kind === "list") {
        lists++;
        return { text: '{"now":"2026-10-04T00:00:00Z","tasks":[]}' };
      }
      expect(params).toEqual(proposed);
      creates++;
      return { text: '{"id":"pending-task","status":"pending"}' };
    };
    const first = f.createDriver(dataDirectory);
    const entries = await first.run(f.input({ task }));
    await first.dispose();
    const second = f.createDriver(dataDirectory);
    await second.run(f.input({ entries, task, recover: true }));
    expect(creates).toBe(1);
    expect(lists).toBe(1);
    expect(f.requests).toHaveLength(3);
    expect(f.requests[0]!.tools.map((tool) => tool.name)).toEqual([
      ...workspaceTools.map((tool) => tool.name),
      "list_ranger_tasks",
      "propose_ranger_task",
    ]);
    expect(existsSync(join(dataDirectory, "auth.json"))).toBe(false);
    expect(
      durableEntries(dataDirectory, entries).some((entry) =>
        entry.model?.some((message) => message.role === "toolResult"),
      ),
    ).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("durable completion checkpoints before admission, deduplicates a restarted request and restores its answer and sources", async () => {
  let checkpoints = 0;
  const f = await durableFixture((index) => {
    expect(checkpoints).toBeGreaterThan(0);
    return modelReply(
      index,
      index === 1
        ? [
            ...text("Inspecting."),
            ...toolUse("workspace_status", "read-status", {}, 1),
            ...finish("tool_use"),
          ]
        : [...text("Verified workspace status."), ...finish("end_turn")],
    );
  });
  const source = {
    id: "source-1",
    kind: "status" as const,
    title: "Status",
    connection_id: "local",
    workspace_id: "workspace",
    runtime_generation: 1,
    read_at: "2026-10-04T00:00:00.000Z",
  };
  let reads = 0;
  let pointer: unknown[] = [];
  try {
    const first = f.createDriver();
    const saved = await first.run(
      f.input({
        checkpoint: (entries) => {
          checkpoints++;
          pointer = entries;
        },
        read: async () => {
          reads++;
          return { text: "Running", sources: [source] };
        },
      }),
    );
    expect(saved).toEqual(pointer);
    expect(checkpoints).toBe(1);
    await first.dispose();
    const restored: string[] = [];
    const sources: unknown[] = [];
    const statuses: string[] = [];
    const second = f.createDriver();
    const replayed = await second.run(
      f.input({
        entries: saved,
        recover: true,
        text: "This must not replace the original submission.",
        replace: (text) => restored.push(text),
        sources: (value) => sources.push(...value),
        tool: (_id, _name, status) => statuses.push(status),
        read: async () => {
          throw new Error("A completed read must not run again");
        },
      }),
    );
    expect(replayed).toEqual(saved);
    expect(f.requests).toHaveLength(2);
    expect(reads).toBe(1);
    expect(restored.at(-1)).toBe("Inspecting.\n\nVerified workspace status.");
    expect(sources).toEqual([source]);
    expect(statuses).toEqual(["completed"]);
    const entries = durableEntries(f.directory, saved);
    expect(entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain("synthetic-local-key");
    const path = join(f.directory, "durable", (saved[0] as { id: string }).id);
    if (process.platform !== "win32") {
      expect(lstatSync(path).mode & 0o777).toBe(0o700);
      for (const file of readdirSync(path))
        expect(lstatSync(join(path, file)).mode & 0o777).toBe(0o600);
    }
  } finally {
    await f.cleanup();
  }
}, 3000);

test("compaction preserves the complete submission answer, sources and tools on recovery without including later turns", async () => {
  const f = await durableFixture((index) =>
    modelReply(
      index,
      index === 1
        ? [
            ...text("Earlier verified finding"),
            ...toolUse("workspace_status", "earlier-read", {}, 1),
            ...finish("tool_use"),
          ]
        : [...text("Later finding"), ...finish("end_turn")],
    ),
  );
  const source = {
    id: "earlier-source",
    kind: "status" as const,
    title: "Earlier status",
    connection_id: "local",
    workspace_id: "workspace",
    runtime_generation: 1,
    read_at: "2026-10-04T00:00:00.000Z",
  };
  try {
    const first = f.createDriver();
    const saved = await first.run(
      f.input({ read: async () => ({ text: "Verified", sources: [source] }) }),
    );
    await first.dispose();
    const durable = await import("@earendil-works/pi-durable");
    const { BACKGROUND_CONTEXT } = await import(
      "@earendil-works/chord/context"
    );
    const { openPrivateDurableStorage } = await import("./durable-storage");
    const owned = await openPrivateDurableStorage(
      f.directory,
      (saved[0] as { id: string }).id,
      BACKGROUND_CONTEXT,
      true,
    );
    const harness = await durable.Harness.open(
      owned.storage,
      {
        registry: durable.createRegistry(),
        models: await f.pi.ModelRuntime.create({
          authPath: join(f.directory, "auth.json"),
          modelsPath: null,
          allowModelNetwork: false,
          refreshOnCreate: false,
        }),
      },
      BACKGROUND_CONTEXT,
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT);
      const answer = durableEntries(f.directory, saved).findLast(
        (entry) => entry.kind === durable.AssistantEntry.kind,
      )!;
      await root.commit(
        (tx) =>
          tx.appendEntry(durable.CompactionEntry, root.id, {
            head: answer.id,
            model: [
              {
                role: "user",
                content: "Earlier context summary",
                timestamp: 0,
              },
            ],
            data: { reason: "threshold" },
          }),
        BACKGROUND_CONTEXT,
      );
      const active = await root.context(BACKGROUND_CONTEXT);
      expect(
        active.entries.some(
          (entry) => entry.kind === durable.ToolResultEntry.kind,
        ),
      ).toBe(false);
      expect(JSON.stringify(active.messages)).not.toContain(
        "Earlier verified finding",
      );
      // A later turn can advance the durable tail before an earlier completed
      // request is recovered. Its answer must remain bound to its own receipt.
      await root.commit(
        (tx) =>
          tx.appendEntry(root.id, {
            kind: durable.UserEntry.kind,
            model: [
              {
                role: "user",
                content: "Unrelated later question",
                timestamp: 1,
              },
            ],
          }),
        BACKGROUND_CONTEXT,
      );
      await root.commit(
        (tx) =>
          tx.appendEntry(root.id, {
            kind: durable.AssistantEntry.kind,
            model: answer.model?.map((message) =>
              message.role === "assistant"
                ? {
                    ...message,
                    content: [{ type: "text", text: "Unrelated later answer" }],
                  }
                : message,
            ),
          }),
        BACKGROUND_CONTEXT,
      );
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await owned.storage.close(BACKGROUND_CONTEXT);
      await owned.release();
    }
    const answers: string[] = [];
    const sources: unknown[] = [];
    const statuses: string[] = [];
    await f.createDriver().run(
      f.input({
        entries: saved,
        recover: true,
        replace: (value) => answers.push(value),
        sources: (value) => sources.push(...value),
        tool: (_id, _name, status) => statuses.push(status),
        read: async () => {
          throw new Error("Completed reads must not replay");
        },
      }),
    );
    expect(answers.at(-1)).toBe("Earlier verified finding\n\nLater finding");
    expect(sources).toEqual([source]);
    expect(statuses).toEqual(["completed"]);
    expect(f.requests).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
}, 3000);

test("SQLite pauses a committed partial without aborting the durable submission and recovery replaces it", async () => {
  const f = await durableFixture((index) =>
    index === 1
      ? hangingReply(index)
      : modelReply(index, [
          ...text("Recovered complete answer."),
          ...finish("end_turn"),
        ]),
  );
  const partial = Promise.withResolvers<void>();
  let pointer: unknown[] = [];
  try {
    const first = f.createDriver();
    const pending = first.run(
      f.input({
        checkpoint: (entries) => {
          pointer = entries;
        },
        replace: (text) => {
          if (text.includes("Partial before pause")) partial.resolve();
        },
      }),
    );
    await partial.promise;
    await first.dispose();
    expect(await pending).toEqual(pointer);
    const replay: string[] = [];
    const second = f.createDriver();
    await second.run(
      f.input({
        entries: pointer,
        recover: true,
        replace: (text) => replay.push(text),
      }),
    );
    expect(f.requests).toHaveLength(2);
    expect(replay.at(-1)).toBe("Recovered complete answer.");
    expect(replay.at(-1)).not.toContain("Partial before pause");
    expect(
      durableEntries(f.directory, pointer).filter(
        (entry) => entry.kind === "pi.user",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(f.requests[1]?.messages)).not.toContain(
      "Partial before pause",
    );
    const directory = join(
      f.directory,
      "durable",
      (pointer[0] as { id: string }).id,
    );
    expect(existsSync(join(directory, "execution.sqlite"))).toBe(true);
    expect(existsSync(join(directory, "main.jsonl"))).toBe(false);
  } finally {
    await f.cleanup();
  }
}, 3000);

test.each(["read", "proposal"] as const)(
  "interrupted %s tools follow their declared replay policy",
  async (kind) => {
    const name = kind === "read" ? "workspace_status" : "propose_agent_prompt";
    const params =
      kind === "read"
        ? {}
        : {
            connection_id: "local",
            workspace_id: "workspace",
            pane_id: "pane",
            prompt: "Review",
          };
    const f = await durableFixture((index) =>
      modelReply(
        index,
        index === 1
          ? [...toolUse(name, "tool-1", params, 0), ...finish("tool_use")]
          : [...text("Recovery inspected."), ...finish("end_turn")],
      ),
    );
    const began = Promise.withResolvers<void>();
    let calls = 0;
    let pointer: unknown[] = [];
    const callback = async (
      _kind: unknown,
      _params: unknown,
      signal?: AbortSignal,
    ) => {
      calls++;
      if (calls === 1) {
        began.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("paused")), {
            once: true,
          });
        });
      }
      return { text: "Read completed after recovery" };
    };
    try {
      const first = f.createDriver();
      const pending = first.run(
        f.input({
          checkpoint: (entries) => {
            pointer = entries;
          },
          read: callback,
          propose: callback,
        }),
      );
      await began.promise;
      await first.dispose();
      await pending;
      const second = f.createDriver();
      const states: string[] = [];
      await second.run(
        f.input({
          entries: pointer,
          recover: true,
          read: callback,
          propose: callback,
          tool: (_id, _name, status) => states.push(status),
        }),
      );
      expect(calls).toBe(kind === "read" ? 2 : 1);
      expect(states.at(-1)).toBe(kind === "read" ? "completed" : "failed");
      expect(f.requests).toHaveLength(2);
      const results = durableEntries(f.directory, pointer)
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === "toolResult");
      expect(results).toHaveLength(1);
      expect(results[0]?.role === "toolResult" && results[0].isError).toBe(
        kind === "proposal",
      );
      expect(
        durableEntries(f.directory, pointer).filter(
          (entry) => entry.kind === "pi.user",
        ),
      ).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  },
  3000,
);

test("nonempty contexts without a durable pointer are rejected before a model request or checkpoint", async () => {
  const f = await durableFixture((index) =>
    modelReply(index, [...text("Unexpected request"), ...finish("end_turn")]),
  );
  try {
    const driver = f.createDriver();
    let checkpoints = 0;
    for (const entries of [
      [
        {
          type: "message",
          message: { role: "user", content: "Old context", timestamp: 0 },
        },
      ],
      [{ type: "custom", data: "Unsupported history" }],
    ]) {
      await expect(
        driver.run(
          f.input({
            entries,
            checkpoint: () => {
              checkpoints++;
            },
          }),
        ),
      ).rejects.toThrow("Invalid durable context");
    }
    expect(checkpoints).toBe(0);
    expect(f.requests).toHaveLength(0);
    expect(existsSync(join(f.directory, "durable"))).toBe(false);
  } finally {
    await f.cleanup();
  }
}, 3000);

test("durable storage refuses missing pointers, symlinks and a second live owner", async () => {
  const f = await durableFixture((index) =>
    modelReply(index, [...text("Saved"), ...finish("end_turn")]),
  );
  const { BACKGROUND_CONTEXT, withAbortSignal } = await import(
    "@earendil-works/chord/context"
  );
  const { openPrivateDurableStorage } = await import("./durable-storage");
  try {
    const driver = f.createDriver();
    await expect(
      driver.run(
        f.input({ entries: [{ type: "ranger-durable", id: "../escape" }] }),
      ),
    ).rejects.toThrow();
    const saved = await driver.run(f.input());
    const id = (saved[0] as { id: string }).id;
    const sqlite = join(f.directory, "durable", id, "execution.sqlite");
    const contents = JSON.stringify(durableEntries(f.directory, saved));
    const owner = await openPrivateDurableStorage(
      f.directory,
      id,
      BACKGROUND_CONTEXT,
      true,
    );
    const controller = new AbortController();
    const blocked = openPrivateDurableStorage(
      f.directory,
      id,
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
      true,
    );
    controller.abort();
    await expect(blocked).rejects.toThrow();
    expect(existsSync(join(f.directory, "durable", `${id}.lock`))).toBe(true);
    await owner.storage.close(BACKGROUND_CONTEXT);
    await owner.release();
    rmSync(sqlite);
    await expect(
      driver.run(f.input({ entries: saved, recover: true })),
    ).rejects.toThrow();
    writeFileSync(join(f.directory, "sentinel"), "Do not follow");
    symlinkSync(join(f.directory, "sentinel"), sqlite);
    await expect(
      driver.run(f.input({ entries: saved, recover: true })),
    ).rejects.toThrow();
    expect(readFileSync(join(f.directory, "sentinel"), "utf8")).toBe(
      "Do not follow",
    );
    expect(f.requests).toHaveLength(1);
    expect(contents).toContain("Saved");
  } finally {
    await f.cleanup();
  }
}, 3000);

test.each(["SDK loading", "runtime creation"])(
  "Pi runtime initialization can retry after failed %s without dropping other credentials",
  async (failure) => {
    const directory = mkdtempSync(join(tmpdir(), "roamgate-pi-retry-"));
    const pi = await import("@earendil-works/pi-coding-agent");
    const started = Promise.withResolvers<void>();
    const initialization = Promise.withResolvers<never>();
    let loads = 0;
    let creations = 0;
    const driver = createPiDriver(directory, async () => {
      if (++loads === 1 && failure === "SDK loading") {
        started.resolve();
        await initialization.promise;
      }
      return {
        ...pi,
        ModelRuntime: {
          create: async (
            options: import("@earendil-works/pi-coding-agent").CreateModelRuntimeOptions,
          ) => {
            if (++creations === 1 && failure === "runtime creation") {
              started.resolve();
              await initialization.promise;
            }
            return pi.ModelRuntime.create({
              ...options,
              authPath: options.authPath ?? join(directory, "pi-auth.json"),
            });
          },
        },
      } as unknown as typeof pi;
    });
    try {
      const pending = Promise.allSettled([
        driver.catalog("assistant"),
        driver.catalog("assistant"),
      ]);
      await started.promise;
      expect(loads).toBe(1);
      const otherSource = await driver.catalog("pi");
      const error = new Error("Temporary initialization failure");
      initialization.reject(error);
      expect(await pending).toEqual([
        { status: "rejected", reason: error },
        { status: "rejected", reason: error },
      ]);
      // The failed request is not retried until a caller explicitly tries again.
      expect(loads).toBe(2);
      const recovered = await driver.catalog("assistant");
      expect(recovered.providers.length).toBeGreaterThan(0);
      expect(await driver.catalog("assistant")).toEqual(recovered);
      expect(await driver.catalog("pi")).toEqual(otherSource);
      expect(loads).toBe(3);
      expect(creations).toBe(failure === "SDK loading" ? 2 : 3);
    } finally {
      await driver.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("Pi login saves to the selected credential store without changing other providers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "roamgate-pi-login-"));
  const rangerAuth = join(directory, "auth.json");
  const piAuth = join(directory, "pi-auth.json");
  const sentinel = join(directory, "executed");
  const existing = {
    openai: { type: "api_key", key: `!touch '${sentinel}'` },
  };
  writeFileSync(rangerAuth, JSON.stringify(existing));
  writeFileSync(piAuth, JSON.stringify(existing));
  const pi = await import("@earendil-works/pi-coding-agent");
  const authPaths: (string | undefined)[] = [];
  const driver = createPiDriver(
    directory,
    async () =>
      ({
        ...pi,
        ModelRuntime: {
          create: async (
            options: import("@earendil-works/pi-coding-agent").CreateModelRuntimeOptions,
          ) => {
            authPaths.push(options.authPath);
            // Isolate Pi's default account store from the user's real credentials.
            return pi.ModelRuntime.create({
              ...options,
              authPath: options.authPath ?? piAuth,
            });
          },
        },
      }) as unknown as typeof pi,
  );
  try {
    for (const source of ["assistant", "pi"] as const) {
      const path = source === "assistant" ? rangerAuth : piAuth;
      const key = `synthetic-${source}-key`;
      const prompts: string[] = [];
      await driver.login("anthropic", "api_key", {
        credential_source: source,
        signal: new AbortController().signal,
        prompt: async (prompt) => {
          prompts.push(prompt.type);
          return key;
        },
        notify: () => {},
      });
      expect(prompts).toEqual(["secret"]);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        ...existing,
        anthropic: { type: "api_key", key },
      });
      const catalog = await driver.catalog(source);
      expect(
        catalog.providers.find((provider) => provider.id === "anthropic")
          ?.credential_method,
      ).toBe("api_key");
      expect(JSON.stringify(catalog)).not.toContain(key);
      if (source === "assistant")
        expect(JSON.parse(readFileSync(piAuth, "utf8"))).toEqual(existing);
      const before = readFileSync(path, "utf8");
      await expect(
        driver.login("anthropic", "api_key", {
          credential_source: source,
          signal: AbortSignal.abort(),
          prompt: async () => {
            throw new Error("Cancelled login must not request a key");
          },
          notify: () => {},
        }),
      ).rejects.toThrow();
      expect(readFileSync(path, "utf8")).toBe(before);
    }
    expect(authPaths).toEqual([rangerAuth, undefined]);
    expect(() => readFileSync(sentinel)).toThrow();
    expect(JSON.parse(readFileSync(rangerAuth, "utf8")).anthropic.key).toBe(
      "synthetic-assistant-key",
    );
  } finally {
    await driver.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the real Pi SDK streams, executes only a workspace tool, resumes, and aborts a local model request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "roamgate-pi-loop-"));
  writeFileSync(
    join(directory, "auth.json"),
    JSON.stringify({
      anthropic: { type: "api_key", key: "synthetic-local-test-key" },
    }),
  );
  writeFileSync(
    join(directory, "AGENTS.md"),
    "Unexpected project instructions must never be loaded.",
  );
  const requests: {
    tools: { name: string; defer_loading?: boolean }[];
    messages: unknown[];
    system: unknown;
  }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as (typeof requests)[number]);
      const index = requests.length;
      if (index > 2) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  events([
                    start(index),
                    {
                      type: "content_block_start",
                      index: 0,
                      content_block: { type: "text", text: "" },
                    },
                    {
                      type: "content_block_delta",
                      index: 0,
                      delta: { type: "text_delta", text: "Waiting" },
                    },
                  ]),
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const values =
        index === 1
          ? [
              start(index),
              ...text("Inspecting status."),
              ...toolUse("workspace_status", "read-status", {}, 1),
              ...finish("tool_use"),
            ]
          : [
              start(index),
              ...text("Workspace is running."),
              ...finish("end_turn"),
            ];
      return new Response(events(values), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const pi = await import("@earendil-works/pi-coding-agent");
  let selectedModel = "";
  const driver = createPiDriver(
    directory,
    async () =>
      ({
        ...pi,
        ModelRuntime: {
          create: async (
            options: import("@earendil-works/pi-coding-agent").CreateModelRuntimeOptions,
          ) => {
            const runtime = await pi.ModelRuntime.create(options);
            const model = runtime
              .getModels("anthropic")
              .find((entry) => entry.api === "anthropic-messages")!;
            selectedModel = model.id;
            runtime.getModel = () => ({ ...model, baseUrl: server.url.href });
            return runtime;
          },
        },
      }) as unknown as typeof pi,
  );
  const deltas: string[] = [];
  const messages: string[] = [];
  const tools: string[] = [];
  const result: WorkspaceToolResult = {
    text: "Workspace is running.",
    sources: [
      {
        id: "status-source",
        kind: "status",
        title: "Workspace status",
        connection_id: "local",
        workspace_id: "workspace",
        runtime_generation: 1,
        read_at: "2026-10-03T00:00:00.000Z",
      },
    ],
  };
  let reads = 0;
  let errors = 0;
  const input: Parameters<AssistantDriver["run"]>[0] = {
    config: {
      provider: "anthropic",
      model: "test",
      credential_source: "assistant",
      allowed_workspaces: [],
    },
    entries: [],
    text: "Read workspace status.",
    signal: new AbortController().signal,
    read: async (kind, params) => {
      reads++;
      expect(kind).toBe("status");
      expect(params).toEqual({});
      return result;
    },
    delta: (delta) => deltas.push(delta),
    message: (message) => messages.push(message),
    tool: (_id, _name, status) => tools.push(status),
    error: () => {
      errors++;
    },
  };
  try {
    const saved = await driver.run(input);
    expect(selectedModel).not.toBe("");
    expect(requests).toHaveLength(2);
    expect(reads).toBe(1);
    expect(errors).toBe(0);
    expect(deltas.join("")).toBe("Inspecting status.Workspace is running.");
    expect(messages).toEqual(["Inspecting status.", "Workspace is running."]);
    expect(tools).toEqual(["running", "completed"]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ type: "ranger-durable" });
    expect(
      durableEntries(directory, saved).some(
        (entry) => entry.model?.[0]?.role === "toolResult",
      ),
    ).toBe(true);
    for (const request of requests) {
      // Pi adds an Anthropic cache scaffold which is deferred and never callable.
      const scaffold = request.tools.find(
        (tool) => tool.name === "__pi_deferred_placeholder__",
      );
      if (scaffold) expect(scaffold.defer_loading).toBe(true);
      expect(
        request.tools
          .filter((tool) => tool !== scaffold)
          .map((tool) => tool.name),
      ).toEqual([
        "workspace_status",
        "workspace_history",
        "workspace_diff",
        "workspace_terminal",
      ]);
      expect(JSON.stringify(request)).not.toContain("synthetic-local-test-key");
      expect(JSON.stringify(request)).not.toContain(
        "Unexpected project instructions",
      );
    }
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      JSON.stringify(
        `${result.text}\n\nSources: ${JSON.stringify(result.sources)}`,
      ).slice(1, -1),
    );
    let ready!: () => void;
    const streaming = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const stopped = driver.run({
      ...input,
      entries: saved,
      delta: (delta) => {
        if (delta === "Waiting") ready();
      },
    });
    await streaming;
    await driver.stop();
    await stopped;
    expect(requests).toHaveLength(3);
  } finally {
    await driver.dispose();
    server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}, 3000);

test("the real Pi SDK records pending action proposals and finishes without executing or awaiting confirmation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "roamgate-pi-proposals-"));
  writeFileSync(
    join(directory, "auth.json"),
    JSON.stringify({
      anthropic: { type: "api_key", key: "synthetic-local-test-key" },
    }),
  );
  const target = { connection_id: "local", workspace_id: "workspace" };
  const calls = [
    {
      name: "propose_workspace_create",
      kind: "create_workspace",
      params: { ...target, label: "Workspace", cwd: "/tmp/project" },
    },
    {
      name: "propose_worktree_create",
      kind: "create_worktree",
      params: { ...target, branch: "feature", label: "Worktree" },
    },
    {
      name: "propose_agent_start",
      kind: "start_agent",
      params: { ...target, pane_id: "pane", agent: "pi" },
    },
    {
      name: "propose_agent_prompt",
      kind: "send_prompt",
      params: { ...target, pane_id: "pane", prompt: "Review the change." },
    },
  ] as const;
  const requests: {
    tools: { name: string; defer_loading?: boolean }[];
    messages: unknown[];
    system: unknown;
  }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as (typeof requests)[number]);
      const index = requests.length;
      return new Response(
        events(
          index === 1
            ? [
                start(index),
                ...text("Preparing proposals."),
                ...calls.flatMap((call, callIndex) =>
                  toolUse(
                    call.name,
                    `proposal-${callIndex}`,
                    call.params,
                    callIndex + 1,
                  ),
                ),
                ...finish("tool_use"),
              ]
            : [
                start(index),
                ...text("Four proposals are ready for your confirmation."),
                ...finish("end_turn"),
              ],
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const pi = await import("@earendil-works/pi-coding-agent");
  const driver = createPiDriver(
    directory,
    async () =>
      ({
        ...pi,
        ModelRuntime: {
          create: async (
            options: import("@earendil-works/pi-coding-agent").CreateModelRuntimeOptions,
          ) => {
            const runtime = await pi.ModelRuntime.create(options);
            const model = runtime
              .getModels("anthropic")
              .find((entry) => entry.api === "anthropic-messages")!;
            runtime.getModel = () => ({ ...model, baseUrl: server.url.href });
            return runtime;
          },
        },
      }) as unknown as typeof pi,
  );
  const mutations: string[] = [];
  const proposals: { kind: string; params: unknown; execute(): void }[] = [];
  const messages: string[] = [];
  const activities: { name: string; status: string }[] = [];
  let reads = 0;
  let errors = 0;
  try {
    const saved = await driver.run({
      config: {
        provider: "anthropic",
        model: "test",
        credential_source: "assistant",
        allowed_workspaces: [target],
      },
      entries: [],
      text: "Propose a workspace, a worktree, an agent and a prompt.",
      signal: new AbortController().signal,
      read: async () => {
        reads++;
        throw new Error("The model should only propose actions in this test.");
      },
      propose: async (kind, params, signal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        const expected = calls.find((call) => call.kind === kind)!;
        expect(params).toEqual(expected.params);
        proposals.push({
          kind,
          params,
          execute: () => mutations.push(kind),
        });
        return {
          text: JSON.stringify({
            proposal_id: `pending-${kind}`,
            status: "pending",
            requires_user_confirmation: true,
          }),
        };
      },
      delta: () => {},
      message: (message) => messages.push(message),
      tool: (_id, name, status) => activities.push({ name, status }),
      error: () => {
        errors++;
      },
    });
    expect(requests).toHaveLength(2);
    expect(proposals).toHaveLength(4);
    expect(mutations).toEqual([]);
    expect(reads).toBe(0);
    expect(errors).toBe(0);
    expect(messages.at(-1)).toBe(
      "Four proposals are ready for your confirmation.",
    );
    expect(
      activities
        .filter((activity) => activity.status === "completed")
        .map((activity) => activity.name)
        .sort(),
    ).toEqual(calls.map((call) => call.name).sort());
    const results = durableEntries(directory, saved).flatMap((entry) => {
      const message = entry.model?.[0];
      return message?.role === "toolResult" ? [message] : [];
    });
    expect(results).toHaveLength(4);
    for (const result of results) expect(result.details).toEqual({});
    for (const request of requests) {
      expect(
        request.tools
          .filter((tool) => tool.name !== "__pi_deferred_placeholder__")
          .map((tool) => tool.name),
      ).toEqual([...workspaceTools, ...actionTools].map((tool) => tool.name));
      expect(JSON.stringify(request)).not.toContain("synthetic-local-test-key");
    }
    expect(JSON.stringify(requests[0])).toContain(
      "only after the user clicks Confirm",
    );
    expect(JSON.stringify(requests[0])).toContain(
      "Never claim that a pending proposal was executed or succeeded",
    );
    const modelContext = JSON.stringify(requests[1]?.messages);
    for (const call of calls)
      expect(modelContext).toContain(`pending-${call.kind}`);
    expect(modelContext).toContain("requires_user_confirmation");
  } finally {
    await driver.dispose();
    server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}, 3000);
