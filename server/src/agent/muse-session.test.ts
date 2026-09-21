import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAgentSessionHandlers } from "./agent-sessions";
import { localAgentSessionFiles } from "./session-file-access";
import { findMuseSession } from "./muse-session";
import {
  createAgentSessionResolverContext,
  resolveAgentSession,
} from "./session-resolver";
import { readSessionProjection } from "./session-projection-cache";
import { projectAgentTrajectory } from "./session-trajectory";
import { normalizeAgentName } from "./session-utils";
import { summarizeTokenUsage } from "./token-usage";

const roots: string[] = [];
const originalDataHome = process.env.XDG_DATA_HOME;
const sessionId = "74747474-7474-4747-8747-747474747474";
const timestamp = Date.parse("2026-09-01T00:00:00Z");

afterEach(async () => {
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "roamgate-muse-"));
  roots.push(root);
  return root;
}

// Native envelopes verified with Muse 1.3.0's offline echo provider. Committed
// tool events also match the public Muse 0.2.1 session-migrate native corpus:
// https://github.com/xhluca/session-migrate/tree/c23b1dbd21404f78be3b69d42ff4fb158ff52105/tests/native_corpus/v1/sources/muse
function record(payload_type: string, payload: Record<string, unknown>) {
  return {
    schema_version: 1,
    stream: { kind: "session", id: sessionId },
    recorded_at: timestamp * 1000 + 123456,
    record_type: "event",
    durability: "durable",
    payload_type,
    payload,
  };
}
function run(event: Record<string, unknown>, run_id = "run-1") {
  return record("runtime.session", { kind: "run", run_id, event });
}
function metadata(cwd: string) {
  return record("runtime.session.metadata", {
    kind: "metadata",
    record: {
      workspace_root: cwd,
      model_id: "meta/muse-glimmer-30b",
      build: { semver: "1.3.0" },
    },
  });
}
function configured(provider: string, runId = "run-1") {
  return record("run.model.configured", {
    kind: "run_model",
    record: { provider_id: provider, run_stream: { kind: "run", id: runId } },
  });
}
function conversation(cwd: string) {
  return [
    // Current Muse logs may begin with a permission transaction, not metadata.
    { retained_frame: "session_permission_transaction", children: [] },
    metadata(cwd),
    configured("meta"),
    record("runtime.user_intent.accepted", {
      intent_id: "intent-1",
      model_messages: [{ content: [{ kind: "text", text: "Read README.md" }] }],
      refill_blocks: [{ kind: "text", text: "Read README.md" }],
    }),
    run({ kind: "started", prompt: "Read README.md" }),
    record("runtime.user_intent.materialized", {
      intent_id: "intent-1",
      outcome: { kind: "top_level_turn_started", run_id: "run-1" },
    }),
    run({ kind: "assistant_message_delta", text: "duplicate chunk" }),
    run({ kind: "reasoning_committed", text: "Inspect the file" }),
    run({
      kind: "assistant_tool_calls_committed",
      tool_calls: [
        { call_id: "call-1", name: "read_file", args: '{"path":"README.md"}' },
      ],
    }),
    run({
      kind: "tool_result_batch_committed",
      results: [{ tool_call_id: "call-1", text: "# README" }],
    }),
    run({
      kind: "model_completed",
      model: "meta/muse-glimmer-30b",
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        cached_tokens: 4,
        cache_read_tokens: 4,
        reasoning_tokens: 2,
      },
    }),
    // Task and accounting events are not another main-agent completion.
    record("runtime.session", {
      kind: "task",
      event: { kind: "model_completed", usage: { input_tokens: 900 } },
    }),
    run({ kind: "assistant_message_committed", text: "Read the README." }),
  ];
}
async function writeSession(
  root: string,
  id: string,
  cwd: string,
  time: number,
) {
  const path = join(root, "2026", "09", "01", id, "session.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    conversation(cwd)
      .map((item) => JSON.stringify(item))
      .join("\n") + "\n",
  );
  await utimes(path, new Date(time), new Date(time));
  return path;
}

describe("Muse Code session inspection", () => {
  test("discovers the newest exact workspace, excluding subagents and other workspaces", async () => {
    const root = await tempRoot();
    const cwd = join(root, "work");
    await mkdir(cwd);
    const alias = join(root, "work-alias");
    await symlink(cwd, alias, "junction");
    await writeSession(root, "old", cwd, timestamp);
    const newest = await writeSession(root, sessionId, cwd, timestamp + 1000);
    await writeSession(root, "unrelated", `${cwd}/nested`, timestamp + 2000);
    await writeSession(
      root,
      `${sessionId}/subagent/child`,
      cwd,
      timestamp + 3000,
    );

    expect((await findMuseSession({ cwd: alias }, root))?.path).toBe(newest);
    expect((await findMuseSession({ id: "old" }, root))?.path).toContain(
      "/old/",
    );
    expect(await findMuseSession({ cwd: `${cwd}/absent` }, root)).toBeNull();
    expect(await findMuseSession({ id: "../old" }, root)).toBeNull();
    expect(await findMuseSession({}, root)).toBeNull();
  });

  test("caches and coalesces discovery metadata without pinning the selected session", async () => {
    const root = await tempRoot();
    process.env.XDG_DATA_HOME = root;
    const sessions = join(root, "muse", "sessions");
    const target = await writeSession(sessions, "target", "/work", timestamp);
    const other = await writeSession(
      sessions,
      "other",
      "/else",
      timestamp + 1000,
    );
    const call = async () => ({ agent: { agent: "muse", cwd: "/work" } });
    const context = createAgentSessionResolverContext();
    const read = spyOn(localAgentSessionFiles, "readPrefix");
    const resolve = () =>
      resolveAgentSession(
        { pane_id: "p1" },
        call,
        localAgentSessionFiles,
        context,
      );
    try {
      const pair = await Promise.all([resolve(), resolve()]);
      expect(pair.map((result) => result.path)).toEqual([target, target]);
      expect(read).toHaveBeenCalledTimes(2);
      await resolve();
      expect(read).toHaveBeenCalledTimes(2);
      // Another connection must own its own metadata cache.
      await resolveAgentSession(
        { pane_id: "p1" },
        call,
        localAgentSessionFiles,
        createAgentSessionResolverContext(),
      );
      expect(read).toHaveBeenCalledTimes(4);
      const newest = await writeSession(
        sessions,
        "new",
        "/work",
        timestamp + 2000,
      );
      expect((await resolve()).path).toBe(newest);
      expect(read).toHaveBeenCalledTimes(5);
      // Rewritten metadata invalidates the cached path even at the same size/mtime.
      const oldStat = await localAgentSessionFiles.statFile(other);
      await writeSession(sessions, "other", "/work", timestamp + 1000);
      expect(
        (await localAgentSessionFiles.statFile(other))?.changeToken,
      ).not.toBe(oldStat?.changeToken);
      await rm(newest);
      expect((await resolve()).path).toBe(other);
      expect(read).toHaveBeenCalledTimes(6);
      await rm(other);
      expect((await resolve()).path).toBe(target);
      expect(read).toHaveBeenCalledTimes(6);
    } finally {
      read.mockRestore();
    }
  });

  test("preserves native run/tool errors in History and ATIF without leaking across runs", async () => {
    const root = await tempRoot();
    const path = await writeSession(root, sessionId, "/work", timestamp);
    const result = (runId: string) =>
      run(
        {
          kind: "tool_result_batch_committed",
          results: [{ tool_call_id: "call-1", text: "tool failed" }],
        },
        runId,
      );
    await writeFile(
      path,
      [
        ...conversation("/work"),
        record("tool_batch.effect.terminal", {
          run_id: "failed-run",
          kind: "tool_batch_effect",
          record: {
            call_id: "call-1",
            outcome: { kind: "failed", reason: "Missing file" },
          },
        }),
        result("failed-run"),
        result("successful-run"),
        run(
          {
            kind: "terminal",
            terminal: "failed",
            reason: "provider unavailable",
          },
          "failed-run",
        ),
        run({ kind: "terminal", terminal: "failed" }, "no-reason"),
        run({ kind: "terminal", terminal: "completed" }, "successful-run"),
        run({ kind: "terminal", terminal: "cancelled" }, "cancelled-run"),
      ]
        .map((item) => JSON.stringify(item))
        .join("\n"),
    );
    const file = await localAgentSessionFiles.statFile(path);
    const projection = await readSessionProjection(
      "muse",
      file!,
      localAgentSessionFiles,
    );
    const results = projection.entries.filter(
      (entry) => entry.kind === "tool_result",
    );
    expect(results.map((entry) => entry.is_error)).toEqual([
      false,
      true,
      false,
    ]);
    expect(
      projection.entries
        .filter((entry) => entry.kind === "error")
        .map((entry) => entry.text),
    ).toEqual(["provider unavailable", "Muse run failed"]);
    expect(projection.messages.map((message) => message.text)).toEqual([
      "Read README.md",
      "Read the README.",
    ]);
    expect(
      projection.trajectory.steps
        .filter((step) => step.extra?.error_message)
        .map((step) => step.message),
    ).toEqual(["Error: provider unavailable", "Error: Muse run failed"]);
    expect(
      projection.trajectory.steps
        .filter((step) => step.observation)
        .map((step) => step.observation!.results[0].extra?.is_error === true),
    ).toEqual([false, true, false]);
  });

  test("uses XDG_DATA_HOME and foreground cwd; never invents an integration command", async () => {
    const root = await tempRoot();
    process.env.XDG_DATA_HOME = root;
    const path = await writeSession(
      join(root, "muse", "sessions"),
      sessionId,
      "/work/actual",
      timestamp,
    );
    const herdrCall = async () => ({
      agent: {
        agent: "Muse Code",
        cwd: "/work/pane",
        foreground_cwd: "/work/actual",
      },
    });
    const resolved = await resolveAgentSession({ pane_id: "p1" }, herdrCall);
    expect(resolved).toMatchObject({
      status: "ok",
      path,
      agent: "muse",
      session: { source: "muse-local", value: sessionId },
    });
    expect(normalizeAgentName("muse-code")).toBe("muse");

    const byId = await resolveAgentSession({ pane_id: "p1" }, async () => ({
      agent: { agent: "muse", agent_session: { kind: "id", value: sessionId } },
    }));
    expect(byId.path).toBe(path);
    const missing = await resolveAgentSession({ pane_id: "p1" }, async () => ({
      agent: { agent: "muse", cwd: "/absent" },
    }));
    expect(missing.status).toBe("missing_session");
    expect(missing.command).toBeUndefined();
    expect(missing.detail).toContain("--no-session-log");

    const remoteFiles = { ...localAgentSessionFiles, remote: true };
    const remote = await resolveAgentSession(
      { pane_id: "p1" },
      herdrCall,
      remoteFiles,
    );
    expect(remote.status).toBe("missing_session");
    expect(remote.detail).toContain("SSH");
    const remoteId = await resolveAgentSession(
      { pane_id: "p1" },
      async () => ({
        agent: {
          agent: "muse",
          agent_session: { kind: "id", value: sessionId },
        },
      }),
      remoteFiles,
    );
    expect(remoteId.status).toBe("missing_file");
  });

  test.each([false, true])(
    "serves reported paths through the shared handlers (remote: %s)",
    async (remote) => {
      const root = await tempRoot();
      const path = await writeSession(root, sessionId, "/work", timestamp);
      const handlers = createAgentSessionHandlers({
        herdrCall: async () => ({
          agent: {
            agent: "muse-code",
            agent_session: { kind: "path", value: path },
          },
        }),
        files: { ...localAgentSessionFiles, remote },
      });
      const params = { pane_id: "p1" };
      const legacy = await handlers.readHistory(params);
      expect(
        "messages" in legacy && legacy.messages.map((message) => message.text),
      ).toEqual(["Read README.md", "Read the README."]);
      const summary = await handlers.readSummary({
        ...params,
        include_text: true,
        include_trajectory: true,
      });
      expect(summary.stats).toMatchObject({
        turns: 1,
        records: 13,
        token_usage: {
          input_tokens: 20,
          cached_input_tokens: 4,
          output_tokens: 5,
          reasoning_output_tokens: 2,
          total_tokens: 25,
        },
      });
      expect(summary.trajectory).toMatchObject({
        session_id: sessionId,
        trajectory_id: sessionId,
        agent: {
          name: "muse-code",
          version: "1.3.0",
          model_name: "meta/muse-glimmer-30b",
        },
        final_metrics: {
          total_prompt_tokens: 20,
          total_completion_tokens: 5,
          total_cached_tokens: 4,
        },
      });
      expect(summary.trajectory?.steps[0].timestamp).toBe(
        "2026-09-01T00:00:00.123Z",
      );
      expect(
        summary.trajectory?.steps.find((step) => step.reasoning_content)
          ?.reasoning_content,
      ).toBe("Inspect the file");
      expect(summary.text).toContain("runtime.session.metadata");
      const snapshot = await handlers.readHistory({
        ...params,
        history_version: 2,
      });
      if (!("entries" in snapshot)) throw new Error("Expected snapshot");
      expect(snapshot.entries.map((entry) => entry.kind)).toEqual([
        "message",
        "tool_call",
        "tool_result",
        "message",
      ]);
      const tool = snapshot.entries.find(
        (entry) => entry.kind === "tool_result",
      )!;
      expect(tool).toMatchObject({
        tool_name: "read_file",
        source_call_id: "call-1",
        text: "",
      });
      expect(
        await handlers.readEntry({ ...params, entry_id: tool.id }),
      ).toMatchObject({ text: "# README" });
      expect(await (await handlers.downloadFile(params)).text()).toBe(
        summary.text!,
      );
      expect(await (await handlers.downloadAtif(params)).json()).toEqual(
        JSON.parse(JSON.stringify(summary.trajectory)),
      );

      // The shared cache refreshes on append and tolerates unfinished JSONL.
      await writeFile(
        path,
        summary.text +
          JSON.stringify(
            run({ kind: "assistant_message_committed", text: "More detail" }),
          ) +
          '\n{"payload":',
      );
      const delta = await handlers.readHistory({
        ...params,
        history_version: 2,
        cursor: snapshot.cursor,
      });
      if (!("upserts" in delta)) throw new Error("Expected delta");
      expect(delta.upserts.map((entry) => entry.text)).toEqual(["More detail"]);
      expect(delta.removed).toEqual([]);
    },
  );

  test("keeps explicit zero usage consistent in summaries and ATIF", () => {
    const records = [
      configured("echo"),
      run({
        kind: "model_completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          reasoning_tokens: 0,
        },
      }),
    ];
    expect(summarizeTokenUsage(records)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      prompt_tokens: 0,
      total_tokens: 0,
    });
    const trajectory = projectAgentTrajectory(
      "muse",
      { path: "/session.jsonl", mtimeMs: timestamp },
      records,
    );
    expect(trajectory.steps[0].metrics).toMatchObject({
      prompt_tokens: 0,
      completion_tokens: 0,
      cached_tokens: 0,
      extra: { total_tokens: 0 },
    });
    expect(trajectory.final_metrics).toMatchObject({
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      total_cached_tokens: 0,
      extra: { total_tokens: 0 },
    });
  });

  test("counts provider-aware prompts once and keeps unknown cached totals unknown", () => {
    // Muse 1.3 offline MSP view/page confirms 20/25 for Meta/OpenAI and
    // 24/29 for Anthropic with these raw input/output/cache counters.
    const completion = (runId: string) =>
      run(
        {
          kind: "model_completed",
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            cached_tokens: 4,
            cache_read_tokens: 4,
            cache_write_tokens: 3,
            reasoning_tokens: 2,
          },
        },
        runId,
      );
    const file = { path: "/session.jsonl", mtimeMs: timestamp };
    for (const [provider, prompt, total] of [
      ["meta", 20, 25],
      ["openai", 20, 25],
      ["anthropic", 24, 29],
      ["unknown", null, null],
    ] as const) {
      const records = [configured(provider), completion("run-1")];
      expect(summarizeTokenUsage(records)).toMatchObject({
        input_tokens: 20,
        prompt_tokens: prompt,
        total_tokens: total,
        cached_input_tokens: 4,
      });
      const trajectory = projectAgentTrajectory("muse", file, records);
      expect(trajectory.steps[0].metrics?.prompt_tokens).toBe(
        prompt ?? undefined,
      );
      expect(trajectory.final_metrics?.total_prompt_tokens).toBe(
        prompt ?? undefined,
      );
      expect(trajectory.final_metrics?.extra?.total_tokens).toBe(
        total ?? undefined,
      );
      expect(trajectory.final_metrics?.extra?.raw_input_tokens).toBe(20);
    }
    const mixed = [
      configured("meta"),
      configured("anthropic", "other"),
      completion("run-1"),
      completion("other"),
    ];
    expect(summarizeTokenUsage(mixed)).toMatchObject({
      prompt_tokens: 44,
      total_tokens: 54,
    });
    // Missing per-run routing must not inherit another run's cache convention.
    mixed.push(completion("unknown-run"));
    expect(summarizeTokenUsage(mixed)).toMatchObject({
      prompt_tokens: null,
      total_tokens: null,
      input_tokens: 60,
    });
    const unknown = projectAgentTrajectory("muse", file, mixed);
    expect(unknown.final_metrics?.total_prompt_tokens).toBeUndefined();
    expect(unknown.final_metrics?.extra?.total_tokens).toBeUndefined();
  });

  test("keeps repeated prompts, legacy starts, malformed records and absent usage safe", () => {
    const records = [
      ...conversation("/work"),
      run({ kind: "started", prompt: "Read README.md" }, "different-run"),
      run({
        kind: "assistant_tool_calls_committed",
        tool_calls: [null, { id: "call-2", name: "shell", args: "not JSON" }],
      }),
      run({
        kind: "tool_result_batch_committed",
        results: [
          null,
          { tool_call_id: "call-2", text: "failed", is_error: true },
        ],
      }),
      run({
        kind: "model_completed",
        usage: { input_tokens: 2, output_tokens: 1, cache_read_tokens: 1 },
      }),
      record("runtime.session", { kind: "run", event: null }),
      record("runtime.user_intent.accepted", { model_messages: [null] }),
      { payload_type: "runtime.session", payload: null },
      {
        ...run({ kind: "assistant_message_committed", text: "fallback time" }),
        recorded_at: 1e100,
      },
    ];
    const trajectory = projectAgentTrajectory(
      "muse",
      { path: "/session.jsonl", mtimeMs: timestamp },
      records,
    );
    expect(
      trajectory.steps.filter((step) => step.source === "user"),
    ).toHaveLength(2);
    expect(
      trajectory.steps.find(
        (step) => step.tool_calls?.[0].tool_call_id === "call-2",
      )?.tool_calls?.[0].arguments,
    ).toEqual({ value: "not JSON" });
    expect(
      trajectory.steps.find(
        (step) => step.observation?.results[0].source_call_id === "call-2",
      )?.observation?.results[0].extra?.is_error,
    ).toBe(true);
    expect(summarizeTokenUsage(records)).toMatchObject({
      input_tokens: 22,
      output_tokens: 6,
      cached_input_tokens: 5,
      total_tokens: 28,
    });
    expect(summarizeTokenUsage([run({ kind: "model_completed" })])).toBeNull();
    expect(trajectory.steps.at(-1)?.timestamp).toBe(
      new Date(timestamp + records.length - 1).toISOString(),
    );
  });
});
