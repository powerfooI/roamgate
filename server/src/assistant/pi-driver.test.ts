import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantDriver, createPiDriver } from "./pi-driver";
import { actionTools, type WorkspaceToolResult, workspaceTools } from "./tools";

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
  const activeTools: string[][] = [];
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
        createAgentSession: async (
          options: import("@earendil-works/pi-coding-agent").CreateAgentSessionOptions,
        ) => {
          const result = await pi.createAgentSession(options);
          activeTools.push(result.session.getActiveToolNames());
          expect(options.noTools).toBe("builtin");
          expect(options.settingsManager?.getSettings()).toMatchObject({
            cacheWarming: "off",
            enableAnalytics: false,
            enableInstallTelemetry: false,
          });
          return result;
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
    expect(
      saved.some(
        (entry) =>
          !!entry &&
          typeof entry === "object" &&
          "message" in entry &&
          (entry.message as { role?: string }).role === "toolResult",
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
      expect(JSON.stringify(request.system)).not.toContain(
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
    expect(activeTools).toEqual([
      [
        "workspace_status",
        "workspace_history",
        "workspace_diff",
        "workspace_terminal",
      ],
      [
        "workspace_status",
        "workspace_history",
        "workspace_diff",
        "workspace_terminal",
      ],
    ]);
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
    const results = saved.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || !("message" in entry))
        return [];
      const message = entry.message as { role?: string; details?: unknown };
      return message.role === "toolResult" ? [message] : [];
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
    expect(JSON.stringify(requests[0]?.system)).toContain(
      "only after the user clicks Confirm",
    );
    expect(JSON.stringify(requests[0]?.system)).toContain(
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
