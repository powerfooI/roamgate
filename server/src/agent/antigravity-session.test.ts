import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeAntigravitySessionPath,
  findAntigravitySessionById,
  findAntigravitySessionForCwd,
  readAntigravitySessionRecords,
} from "./antigravity-session";
import { resolveAgentSession } from "./session-resolver";
import { projectAgentTrajectory } from "./session-trajectory";

const tempRoots: string[] = [];
const originalHome = process.env.ANTIGRAVITY_HOME;
const originalConvDir = process.env.ANTIGRAVITY_CONVERSATIONS_DIR;

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
  if (originalHome === undefined) delete process.env.ANTIGRAVITY_HOME;
  else process.env.ANTIGRAVITY_HOME = originalHome;
  if (originalConvDir === undefined)
    delete process.env.ANTIGRAVITY_CONVERSATIONS_DIR;
  else process.env.ANTIGRAVITY_CONVERSATIONS_DIR = originalConvDir;
});

function encodeVarint(val: number | bigint): Buffer {
  const bytes: number[] = [];
  let n = BigInt(val);
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function encodeField(
  fieldNum: number,
  wireType: number,
  data: number | bigint | string | Buffer,
): Buffer {
  const tag = (fieldNum << 3) | wireType;
  const tagBuf = encodeVarint(tag);
  if (wireType === 0) {
    return Buffer.concat([tagBuf, encodeVarint(Number(data))]);
  }
  if (wireType === 2) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as string);
    return Buffer.concat([tagBuf, encodeVarint(buf.length), buf]);
  }
  throw new Error(`unsupported wireType ${wireType}`);
}

function makeStepMeta(
  sec: number,
  toolCall?: { id: string; name: string; args: Record<string, unknown> },
): Buffer {
  const secBuf = encodeField(1, 0, sec);
  const timeMsg = encodeField(1, 2, secBuf);
  const parts = [timeMsg];
  if (toolCall) {
    const f1 = encodeField(1, 2, toolCall.id);
    const f2 = encodeField(2, 2, toolCall.name);
    const f3 = encodeField(3, 2, JSON.stringify(toolCall.args));
    parts.push(encodeField(4, 2, Buffer.concat([f1, f2, f3])));
  }
  return Buffer.concat(parts);
}

async function createSyntheticDb(
  root: string,
  sessionId: string,
  cwd: string,
  baseTimeSec = 1726272000,
  options: { model?: string } = {},
): Promise<string> {
  await mkdir(root, { recursive: true });
  const dbPath = join(root, `${sessionId}.db`);
  const db = new Database(dbPath);

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
    `traj-${sessionId}`,
    sessionId,
    4,
    17,
  ]);

  const cwdBuf = encodeField(7, 2, `file://${cwd}`);
  db.run("INSERT INTO trajectory_metadata_blob VALUES (?, ?)", [
    "main",
    cwdBuf,
  ]);

  // Step 0: User input
  const userTextBuf = encodeField(2, 2, "Fix the bug in pult");
  const userMsg = encodeField(19, 2, userTextBuf);
  db.run(
    "INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)",
    [0, 14, makeStepMeta(baseTimeSec), userMsg],
  );

  // Step 1: Tool call
  const toolCall = {
    id: "call_1",
    name: "view_file",
    args: { AbsolutePath: "/dev/pult/README.md" },
  };
  const toolOutMsg = encodeField(
    140,
    2,
    encodeField(2, 2, encodeField(1, 2, "Pult documentation content")),
  );
  db.run(
    "INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)",
    [1, 132, makeStepMeta(baseTimeSec + 5, toolCall), toolOutMsg],
  );

  // Step 2: Assistant planner response
  const respText = encodeField(1, 2, "Bug is fixed!");
  const thoughtText = encodeField(3, 2, "I checked the documentation.");
  const plannerMsg = encodeField(20, 2, Buffer.concat([respText, thoughtText]));
  db.run(
    "INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)",
    [2, 15, makeStepMeta(baseTimeSec + 10), plannerMsg],
  );

  // gen_metadata
  const modelName = encodeField(19, 2, options.model ?? "gemini-3.8-flash");
  const tokIn = encodeField(2, 0, 150);
  const tokOut = encodeField(3, 0, 45);
  const tokCached = encodeField(9, 0, 30);
  const usageBuf = encodeField(4, 2, Buffer.concat([tokIn, tokOut, tokCached]));
  const stepIdxKey = encodeField(1, 2, "last_step_index");
  const stepIdxVal = encodeField(2, 2, "2");
  const stepIdxKv = encodeField(20, 2, Buffer.concat([stepIdxKey, stepIdxVal]));
  const genPayload = encodeField(
    1,
    2,
    Buffer.concat([modelName, usageBuf, stepIdxKv]),
  );
  db.run("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)", [0, genPayload]);

  db.close();
  return dbPath;
}

describe("Antigravity sessions", () => {
  test("finds the newest Antigravity session for the exact working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-agy-test-"));
    tempRoots.push(root);
    const cwd = "/workspace/repo";
    await createSyntheticDb(root, "older-session", cwd, 1726270000);
    await createSyntheticDb(root, "newer-session", cwd, 1726280000, {
      model: "gemini-3.8-flash",
    });
    await createSyntheticDb(
      root,
      "other-session",
      "/workspace/other",
      1726290000,
    );

    const found = await findAntigravitySessionForCwd(cwd, root);

    expect(found?.session.sessionId).toBe("newer-session");
    expect(found?.session.modelName).toBe("gemini-3.8-flash");
    expect(found?.file.path).toEndWith("newer-session.db");
  });

  test("resolves a known session id with exact name and prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-agy-test-"));
    tempRoots.push(root);
    await createSyntheticDb(
      root,
      "3f74fcbe-9742-499a-9697-b6a0ef3e2dc2",
      "/workspace/repo",
    );

    const exact = await findAntigravitySessionById(
      "3f74fcbe-9742-499a-9697-b6a0ef3e2dc2",
      "",
      root,
    );
    expect(exact?.session.sessionId).toBe(
      "3f74fcbe-9742-499a-9697-b6a0ef3e2dc2",
    );
    expect(exact?.session.cwd).toBe("/workspace/repo");

    const withExt = await findAntigravitySessionById(
      "3f74fcbe-9742-499a-9697-b6a0ef3e2dc2.db",
      "",
      root,
    );
    expect(withExt?.session.sessionId).toBe(
      "3f74fcbe-9742-499a-9697-b6a0ef3e2dc2",
    );

    const prefix = await findAntigravitySessionById("3f74fcbe", "", root);
    expect(prefix?.session.sessionId).toBe(
      "3f74fcbe-9742-499a-9697-b6a0ef3e2dc2",
    );

    expect(
      await findAntigravitySessionById("../3f74fcbe", "", root),
    ).toBeNull();
  });

  test("describes session path correctly and reads metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-agy-test-"));
    tempRoots.push(root);
    const dbPath = await createSyntheticDb(
      root,
      "session-desc-1",
      "/workspace/my-project",
      1726272000,
      { model: "gemini-3.8-flash" },
    );

    const desc = await describeAntigravitySessionPath(dbPath);
    expect(desc).not.toBeNull();
    expect(desc?.session.sessionId).toBe("session-desc-1");
    expect(desc?.session.cwd).toBe("/workspace/my-project");
    expect(desc?.session.modelName).toBe("gemini-3.8-flash");
    expect(desc?.session.agentVersion).toBe("antigravity-cli");
    expect(desc?.session.createdAtMs).toBe(1726272000 * 1000);
    expect(desc?.session.updatedAtMs).toBe((1726272000 + 10) * 1000);
  });

  test("reads and normalizes session records from database", async () => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-agy-test-"));
    tempRoots.push(root);
    const dbPath = await createSyntheticDb(
      root,
      "session-records-1",
      "/workspace/records",
      1726272000,
    );

    const records = await readAntigravitySessionRecords(dbPath);
    expect(records.length).toBe(4);

    expect(records[0]).toMatchObject({
      type: "user",
      content: "Fix the bug in pult",
    });

    expect(records[1]).toMatchObject({
      type: "assistant",
      tool_calls: [
        {
          id: "call_1",
          name: "view_file",
          arguments: { AbsolutePath: "/dev/pult/README.md" },
        },
      ],
    });

    expect(records[2]).toMatchObject({
      type: "tool_result",
      tool_call_id: "call_1",
      tool_name: "view_file",
      content: "Pult documentation content",
    });

    expect(records[3]).toMatchObject({
      type: "assistant",
      content: "Bug is fixed!",
      reasoning: "I checked the documentation.",
      usage: {
        input_tokens: 150,
        output_tokens: 45,
        cached_input_tokens: 30,
      },
    });
  });

  test("resolves Antigravity session via resolveAgentSession", async () => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-agy-test-"));
    tempRoots.push(root);
    process.env.ANTIGRAVITY_CONVERSATIONS_DIR = root;

    const sessionId = "session-herdr-resolved";
    await createSyntheticDb(root, sessionId, "/workspace/test-repo");

    const resolved = await resolveAgentSession(
      { pane_id: "p1", agent: "agy" },
      async () => ({
        agent: {
          agent: "agy",
          cwd: "/workspace/test-repo",
          agent_session: {
            source: "herdr:antigravity_cli",
            agent: "agy",
            kind: "id",
            value: sessionId,
          },
        },
      }),
    );

    expect(resolved.status).toBe("ok");
    expect(resolved.agent).toBe("agy");
    expect(resolved.session?.value).toBe(sessionId);
    expect(resolved.file?.path).toEndWith(`${sessionId}.db`);
  });

  test("resolves Antigravity session via cwd fallback when agent_session is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-agy-test-"));
    tempRoots.push(root);
    process.env.ANTIGRAVITY_CONVERSATIONS_DIR = root;

    const sessionId = "session-fallback-cwd";
    await createSyntheticDb(root, sessionId, "/workspace/fallback-dir");

    const resolved = await resolveAgentSession(
      { pane_id: "p2", agent: "antigravity" },
      async () => ({
        agent: {
          agent: "antigravity",
          cwd: "/workspace/fallback-dir",
        },
      }),
    );

    expect(resolved.status).toBe("ok");
    expect(resolved.agent).toBe("agy");
    expect(resolved.session?.value).toBe(sessionId);
  });

  test("returns missing_session with integration command when session cannot be resolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-agy-test-"));
    tempRoots.push(root);
    process.env.ANTIGRAVITY_CONVERSATIONS_DIR = root;

    const resolved = await resolveAgentSession(
      { pane_id: "p3", agent: "agy" },
      async () => ({
        agent: {
          agent: "agy",
          cwd: "",
        },
      }),
    );

    expect(resolved.status).toBe("missing_session");
    expect(resolved.command).toBe("herdr integration install antigravity-cli");
  });

  test("extracts nested tool result protobuf and ensures content has no control characters", async () => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-agy-test-"));
    tempRoots.push(root);
    const dbPath = join(root, "nested-tool-result.db");
    const db = new Database(dbPath);

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
      "traj-nested",
      "nested-tool-result",
      4,
      17,
    ]);

    const toolCall = {
      id: "call_nested",
      name: "run_command",
      args: { CommandLine: "ls" },
    };

    // Construct nested field 2 protobuf containing:
    // - field 1 (wireType 2): actual text output with tabs, newlines, and some control bytes
    // - field 6 (wireType 2): binary step metadata
    const textWithControlBytes =
      "File Path: /dev/pult\nLine 1\tTabbed\x00\x08\x0b\x0c\x1f\ufffdClean";
    const sf1Text = encodeField(1, 2, textWithControlBytes);
    const sf6Meta = encodeField(
      6,
      2,
      Buffer.from([0x08, 0x01, 0x12, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]),
    );
    const nestedProto = Buffer.concat([sf1Text, sf6Meta]);

    // Field 140 has field 2 = nestedProto
    const f140Msg = encodeField(140, 2, encodeField(2, 2, nestedProto));

    db.run(
      "INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)",
      [0, 132, makeStepMeta(1726272000, toolCall), f140Msg],
    );
    db.close();

    const records = await readAntigravitySessionRecords(dbPath);
    expect(records.length).toBe(2);
    const tr = records.find((r) => r.type === "tool_result");
    expect(tr).toBeDefined();
    expect(tr?.type).toBe("tool_result");

    const content = (tr as { content?: string }).content;
    expect(content).toBe("File Path: /dev/pult\nLine 1\tTabbedClean");

    // Strictly assert no control characters (U+0000 - U+001F except \t, \n, \r) and no U+FFFD
    const junkRegex = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/;
    expect(junkRegex.test(content || "")).toBe(false);
  });

  test("fails soft with empty history on unknown tables or future schema bump", async () => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-agy-test-"));
    tempRoots.push(root);
    const dbPath = join(root, "unknown-schema-session.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE schema_v99_future (id text, unknown_payload blob)");
    db.run("INSERT INTO schema_v99_future VALUES (?, ?)", [
      "fut-1",
      Buffer.from([0x01, 0x02, 0x03]),
    ]);
    db.close();

    const desc = await describeAntigravitySessionPath(dbPath);
    expect(desc).not.toBeNull();
    expect(desc?.session.sessionId).toBe("unknown-schema-session");

    const records = await readAntigravitySessionRecords(dbPath);
    expect(records).toEqual([]);

    if (desc) {
      const trajectory = projectAgentTrajectory("agy", desc.file, records);
      expect(trajectory.schema_version).toBe("ATIF-v1.7");
      expect(trajectory.agent.name).toBe("antigravity-cli");
      expect(trajectory.steps).toEqual([]);
    }
  });

  test("fails soft with empty records when steps table schema is altered", async () => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-agy-test-"));
    tempRoots.push(root);
    const dbPath = join(root, "altered-steps-session.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE steps (step_id text, different_structure text)");
    db.run("INSERT INTO steps VALUES (?, ?)", ["1", "not-expected-columns"]);
    db.close();

    const records = await readAntigravitySessionRecords(dbPath);
    expect(records).toEqual([]);
  });

  test("fails soft on individual malformed step rows while recovering valid ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-agy-test-"));
    tempRoots.push(root);
    const dbPath = join(root, "partial-malformed.db");
    const db = new Database(dbPath);

    db.run(
      "CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))",
    );

    // Row 0: valid user input (step_type 14)
    const userPrompt = "Hello from valid step";
    const userMsg = encodeField(19, 2, encodeField(2, 2, userPrompt));
    db.run(
      "INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)",
      [0, 14, makeStepMeta(1726272000), userMsg],
    );

    // Row 1: malformed row with corrupt metadata and payload that could trigger type errors
    db.run(
      "INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)",
      [1, 15, Buffer.from([0xff, 0xff, 0xff]), Buffer.from([0xff, 0xff, 0xff])],
    );
    db.close();

    const records = await readAntigravitySessionRecords(dbPath);
    expect(records.length).toBe(1);
    expect(records[0].type).toBe("user");
    expect((records[0] as { content?: string }).content).toBe(userPrompt);
  });

  test("fails soft with empty records when file is corrupt or not an sqlite database", async () => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-agy-test-"));
    tempRoots.push(root);
    const corruptPath = join(root, "not-a-db.db");
    await writeFile(corruptPath, "this is not an sqlite database at all");

    const records = await readAntigravitySessionRecords(corruptPath);
    expect(records).toEqual([]);
  });
});
