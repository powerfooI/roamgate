import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionHandlers,
  downloadAgentSessionAtif,
  downloadAgentSessionFile,
  readAgentMessageHistory,
  readAgentSessionSummary,
} from "./agent-sessions";
import {
  type AgentSessionFileAccess,
  localAgentSessionFiles,
} from "./session-file-access";
import type { HerdrCall } from "./session-types";

const tempDirectories: string[] = [];
const remotePiSessionPath = "/srv/herdr-gui-test/sessions/pi-session.jsonl";

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function createPiSession() {
  const directory = await mkdtemp(join(tmpdir(), "herdr-gui-pi-session-"));
  tempDirectories.push(directory);
  const path = join(directory, "2026-07-24_pi-session.jsonl");
  const records = [
    {
      type: "session",
      version: 3,
      id: "pi-session",
      timestamp: "2026-07-24T00:00:00.000Z",
      cwd: "/tmp/project",
    },
    {
      type: "message",
      id: "user-1",
      timestamp: "2026-07-24T00:00:01.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "first message" }],
      },
    },
    {
      type: "message",
      id: "assistant-1",
      timestamp: "2026-07-24T00:00:02.000Z",
      message: {
        role: "assistant",
        model: "test-model",
        content: [{ type: "text", text: "response" }],
        usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0 },
      },
    },
    {
      type: "message",
      id: "user-2",
      timestamp: "2026-07-24T00:00:03.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "second message" }],
      },
    },
    {
      type: "message",
      id: "assistant-2",
      timestamp: "2026-07-24T00:00:04.000Z",
      message: {
        role: "assistant",
        model: "test-model",
        content: [{ type: "text", text: "second response" }],
      },
    },
  ];
  await writeFile(
    path,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  return path;
}

function remotePiFiles(text: string): AgentSessionFileAccess {
  const path = remotePiSessionPath;
  const bytes = Buffer.from(text);
  return {
    remote: true,
    async statFile() {
      return {
        path,
        mtimeMs: new Date("2026-07-24T00:00:03.000Z").getTime(),
        size: bytes.length,
      };
    },
    async readText() {
      return text;
    },
    async readPrefix(_path, byteLimit) {
      return bytes.subarray(0, byteLimit);
    },
    async readDownloadBody() {
      return bytes;
    },
    async findPiSessionById() {
      return null;
    },
    async findCodexSessionById() {
      return null;
    },
  };
}

function piAgentCall(path: string): HerdrCall {
  return async (method) => {
    expect(method).toBe("agent.get");
    return {
      agent: {
        agent: "pi",
        workspace_id: "w1",
        tab_id: "t1",
        cwd: "/tmp/project",
        agent_session: {
          source: "herdr:pi",
          agent: "pi",
          kind: "path",
          value: path,
        },
      },
    };
  };
}

describe("Pi agent sessions", () => {
  test("reads user and assistant history from an integration-reported session", async () => {
    const path = await createPiSession();
    const history = await readAgentMessageHistory(
      { pane_id: "p1", agent: "pi" },
      piAgentCall(path),
    );

    expect(history.status).toBe("ok");
    expect(history.path).toBe(path);
    expect(history.messages).toMatchObject([
      {
        role: "user",
        text: "first message",
        sent_at: "2026-07-24T00:00:01.000Z",
      },
      {
        role: "assistant",
        text: "response",
        sent_at: "2026-07-24T00:00:02.000Z",
      },
      {
        role: "user",
        text: "second message",
        sent_at: "2026-07-24T00:00:03.000Z",
      },
      {
        role: "assistant",
        text: "second response",
        sent_at: "2026-07-24T00:00:04.000Z",
      },
    ]);
  });
  test("returns persisted OMP skill prompts and execution messages in history and summaries", async () => {
    const path = remotePiSessionPath;
    const records = [
      { type: "session", version: 3, id: "omp-session", cwd: "/tmp/project" },
      {
        type: "custom_message",
        id: "skill-1",
        timestamp: "2026-07-24T00:00:00.000Z",
        customType: "skill-prompt",
        attribution: "user",
        display: true,
        content: "<skill>Expanded instructions</skill>",
        details: {
          name: "review",
          args: "this change",
          prompt: "/skill:review this change",
        },
      },
      {
        type: "message",
        id: "execution-1",
        timestamp: "2026-07-24T00:00:01.000Z",
        message: {
          role: "bashExecution",
          command: "false",
          output: "failure-output",
          exitCode: 1,
          cancelled: false,
          timestamp: 1,
        },
      },
    ];
    const handlers = createAgentSessionHandlers({
      herdrCall: async () => ({
        agent: {
          agent: "omp",
          workspace_id: "w1",
          tab_id: "t1",
          cwd: "/tmp/project",
          agent_session: {
            source: "herdr:omp",
            agent: "omp",
            kind: "path",
            value: path,
          },
        },
      }),
      files: remotePiFiles(
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      ),
    });
    const history = await handlers.readHistory({
      pane_id: "p1",
      agent: "omp",
      history_version: 2,
    });

    if (!("mode" in history) || history.mode !== "snapshot")
      throw new Error("Expected history snapshot");
    expect(history.entries).toHaveLength(2);
    expect(history.entries[0]).toMatchObject({
      role: "user",
      kind: "message",
      text: "/skill:review this change",
    });
    expect(history.entries[1]).toMatchObject({
      role: "tool",
      kind: "tool_result",
      tool_name: "bash",
      is_error: true,
      text: "",
    });
    const entry = await handlers.readEntry({
      pane_id: "p1",
      agent: "omp",
      entry_id: history.entries[1]!.id,
    });
    expect(entry.text).toBe(
      "Ran `false`\n\nOutput:\nfailure-output\n\nCommand exited with code 1",
    );
    const summary = await handlers.readSummary({
      pane_id: "p1",
      agent: "omp",
      include_trajectory: true,
    });
    expect(summary.stats.turns).toBe(1);
    expect(summary.trajectory?.steps[0]).toMatchObject({
      source: "user",
      message: "/skill:review this change",
    });
  });

  test("includes Pi statistics and ATIF in Session Inspect", async () => {
    const path = await createPiSession();
    const summary = await readAgentSessionSummary(
      {
        pane_id: "p1",
        agent: "pi",
        include_trajectory: true,
      },
      piAgentCall(path),
    );

    expect(summary.stats).toMatchObject({
      turns: 2,
      records: 5,
      token_usage: {
        input_tokens: 4,
        cached_input_tokens: 1,
        output_tokens: 2,
      },
    });
    expect(summary.trajectory).toMatchObject({
      session_id: "pi-session",
      agent: { name: "pi", model_name: "test-model" },
    });
  });

  test("shows the official integration command when Pi has no session", async () => {
    const result = await readAgentMessageHistory(
      { pane_id: "p1", agent: "pi" },
      async () => ({ agent: { agent: "pi" } }),
    );

    expect(result.status).toBe("missing_session");
    expect(result.command).toBe("herdr integration install pi");
  });

  test("binds Herdr and file access inside each runtime handler bundle", async () => {
    const record = (id: string, text: string) =>
      [
        {
          type: "session",
          version: 3,
          id,
          timestamp: "2026-07-24T00:00:00.000Z",
        },
        {
          type: "message",
          id: `${id}-user`,
          timestamp: "2026-07-24T00:00:01.000Z",
          message: { role: "user", content: [{ type: "text", text }] },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n");
    const first = createAgentSessionHandlers({
      herdrCall: piAgentCall(remotePiSessionPath),
      files: remotePiFiles(`${record("first-session", "first runtime")}\n`),
    });
    const second = createAgentSessionHandlers({
      herdrCall: piAgentCall(remotePiSessionPath),
      files: remotePiFiles(`${record("second-session", "second runtime")}\n`),
    });

    const [firstHistory, secondHistory] = await Promise.all([
      first.readHistory({ pane_id: "p1", agent: "pi" }),
      second.readHistory({ pane_id: "p1", agent: "pi" }),
    ]);

    if (!("messages" in firstHistory) || !("messages" in secondHistory))
      throw new Error("Expected legacy history");
    expect(firstHistory.messages[0]?.text).toBe("first runtime");
    expect(secondHistory.messages[0]?.text).toBe("second runtime");
  });

  test("reads and exports an SSH-reported Pi session", async () => {
    const text = [
      {
        type: "session",
        version: 3,
        id: "remote-pi-session",
        timestamp: "2026-07-24T00:00:00.000Z",
      },
      {
        type: "message",
        id: "user-remote",
        timestamp: "2026-07-24T00:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "remote message" }],
        },
      },
      {
        type: "message",
        id: "assistant-remote",
        timestamp: "2026-07-24T00:00:02.000Z",
        message: {
          role: "assistant",
          model: "remote-model",
          content: [{ type: "text", text: "remote response" }],
          usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0 },
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
    const path = remotePiSessionPath;
    const files = remotePiFiles(`${text}\n`);
    const call = piAgentCall(path);

    const summary = await readAgentSessionSummary(
      {
        pane_id: "p1",
        agent: "pi",
        include_text: true,
        include_trajectory: true,
      },
      call,
      files,
    );
    expect(summary).toMatchObject({
      status: "ok",
      path,
      stats: { turns: 1, records: 3 },
      truncated: false,
      trajectory: {
        session_id: "remote-pi-session",
        agent: { name: "pi", model_name: "remote-model" },
      },
    });
    expect(summary.text).toContain("remote message");

    const raw = await downloadAgentSessionFile(
      { pane_id: "p1", agent: "pi" },
      call,
      files,
    );
    expect(raw.status).toBe(200);
    expect(await raw.text()).toContain("remote response");

    const atif = await downloadAgentSessionAtif(
      { pane_id: "p1", agent: "pi" },
      call,
      files,
    );
    expect(atif.status).toBe(200);
    expect(await atif.json()).toMatchObject({
      schema_version: "ATIF-v1.7",
      session_id: "remote-pi-session",
    });
  });

  test("reads and exports an Antigravity sqlite session", async () => {
    const { Database } = await import("bun:sqlite");
    const directory = await mkdtemp(join(tmpdir(), "herdr-gui-agy-session-"));
    tempDirectories.push(directory);
    const sessionId = "test-agy-uuid";
    const path = join(directory, `${sessionId}.db`);
    const db = new Database(path);
    db.run(
      "CREATE TABLE trajectory_meta (trajectory_id text, cascade_id text, trajectory_type integer, source integer, PRIMARY KEY (trajectory_id))",
    );
    db.run(
      "CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))",
    );
    db.run(
      "CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))",
    );
    db.run(
      'CREATE TABLE trajectory_metadata_blob (id text DEFAULT "main", data blob, PRIMARY KEY (id))',
    );
    db.run("INSERT INTO trajectory_meta VALUES (?, ?, ?, ?)", [
      "traj-1",
      sessionId,
      4,
      17,
    ]);

    // User message (step_type 14)
    const userTextBuf = Buffer.from("\x12\x0ehello from agy");
    const userMsg = Buffer.concat([
      Buffer.from([0x9a, 0x01, userTextBuf.length]),
      userTextBuf,
    ]);
    db.run(
      "INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)",
      [0, 14, Buffer.from("\x0a\x06\x08\x80\xa4\xeb\xb5\x06"), userMsg],
    );

    // Assistant response (step_type 15)
    const respText = Buffer.from("\x0a\x0fagy response ok");
    const plannerMsg = Buffer.concat([
      Buffer.from([0xa2, 0x01, respText.length]),
      respText,
    ]);
    db.run(
      "INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)",
      [1, 15, Buffer.from("\x0a\x06\x08\x85\xa4\xeb\xb5\x06"), plannerMsg],
    );
    db.close();

    const call: HerdrCall = async () => ({
      agent: {
        agent: "agy",
        workspace_id: "w1",
        tab_id: "t1",
        cwd: "/tmp/project",
        agent_session: {
          source: "herdr:antigravity_cli",
          agent: "agy",
          kind: "path",
          value: path,
        },
      },
    });

    const history = await readAgentMessageHistory(
      { pane_id: "p1", agent: "agy" },
      call,
    );
    expect(history.status).toBe("ok");
    expect(history.messages.map((m) => m.text)).toEqual([
      "hello from agy",
      "agy response ok",
    ]);

    const summary = await readAgentSessionSummary(
      {
        pane_id: "p1",
        agent: "agy",
        include_text: true,
        include_trajectory: true,
      },
      call,
    );
    expect(summary.status).toBe("ok");
    expect(summary.stats.turns).toBe(1);
    expect(summary.text).toContain("hello from agy");

    const raw = await downloadAgentSessionFile(
      { pane_id: "p1", agent: "agy" },
      call,
    );
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("application/vnd.sqlite3");

    const atif = await downloadAgentSessionAtif(
      { pane_id: "p1", agent: "agy" },
      call,
    );
    expect(atif.status).toBe(200);
    const atifJson = (await atif.json()) as {
      schema_version: string;
      session_id: string;
      agent: { name: string };
    };
    expect(atifJson).toMatchObject({
      schema_version: "ATIF-v1.7",
      session_id: sessionId,
      agent: { name: "antigravity-cli" },
    });
  });
});

describe("Claude session commands", () => {
  test("agent_commands.get lists the session's skills from its transcript", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "roamgate-claude-commands-"),
    );
    tempDirectories.push(directory);
    const path = join(directory, "session.jsonl");
    await writeFile(
      path,
      `${[
        { type: "user", message: { role: "user", content: "hello" } },
        {
          type: "attachment",
          attachment: {
            type: "skill_listing",
            names: ["commit"],
            content: "- commit: Write a commit message",
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );
    const herdrCall: HerdrCall = async () => ({
      agent: {
        agent: "claude",
        workspace_id: "w1",
        tab_id: "t1",
        cwd: directory,
        agent_session: { agent: "claude", kind: "path", value: path },
      },
    });
    const handlers = createAgentSessionHandlers({
      herdrCall,
      files: localAgentSessionFiles,
    });
    expect(await handlers.readCommands({ pane_id: "p1" })).toEqual({
      commands: [{ name: "commit", description: "Write a commit message" }],
    });
  });
});

describe("Claude session title", () => {
  test("agent_session.get carries the /rename name, else Claude's title", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roamgate-claude-title-"));
    tempDirectories.push(directory);
    const path = join(directory, "session.jsonl");
    const write = (records: Record<string, unknown>[]) =>
      writeFile(
        path,
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );
    const herdrCall: HerdrCall = async () => ({
      agent: {
        agent: "claude",
        workspace_id: "w1",
        tab_id: "t1",
        cwd: directory,
        agent_session: { agent: "claude", kind: "path", value: path },
      },
    });
    const user = { type: "user", message: { role: "user", content: "hi" } };
    await write([user, { type: "ai-title", aiTitle: "Fix the login form" }]);
    const first = createAgentSessionHandlers({
      herdrCall,
      files: localAgentSessionFiles,
    });
    expect((await first.readSummary({ pane_id: "p1" })).title).toBe(
      "Fix the login form",
    );
    await write([
      user,
      { type: "ai-title", aiTitle: "Fix the login form" },
      { type: "custom-title", customTitle: "login" },
    ]);
    const second = createAgentSessionHandlers({
      herdrCall,
      files: localAgentSessionFiles,
    });
    expect((await second.readSummary({ pane_id: "p1" })).title).toBe("login");
  });
});

describe("Claude session artifacts", () => {
  test("agent_artifacts.get lists the pages the session published", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "roamgate-claude-artifacts-"),
    );
    tempDirectories.push(directory);
    const path = join(directory, "session.jsonl");
    const call = (id: string, input: Record<string, unknown>) => ({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id, name: "Artifact", input }],
      },
    });
    const result = (id: string, text: string) => ({
      type: "user",
      timestamp: "2026-10-30T10:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: text }],
      },
    });
    await writeFile(
      path,
      `${[
        call("t1", { file_path: "/tmp/report/index.html", title: "Report" }),
        result(
          "t1",
          "Created a new Artifact at https://claude.ai/artifact/abc-1",
        ),
        call("t2", { file_path: "/tmp/evil.html" }),
        result("t2", "Created a new Artifact at javascript:alert(1)"),
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );
    const handlers = createAgentSessionHandlers({
      herdrCall: async () => ({
        agent: {
          agent: "claude",
          workspace_id: "w1",
          tab_id: "t1",
          cwd: directory,
          agent_session: { agent: "claude", kind: "path", value: path },
        },
      }),
      files: localAgentSessionFiles,
    });
    expect(await handlers.readArtifacts({ pane_id: "p1" })).toEqual({
      artifacts: [
        {
          url: "https://claude.ai/artifact/abc-1",
          title: "Report",
          published_at: "2026-10-30T10:00:00.000Z",
        },
      ],
    });
  });
});
