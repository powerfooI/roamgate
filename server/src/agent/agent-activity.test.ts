import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enrichAgentActivity,
  REMOTE_ACTIVITY_REUSE_MS,
} from "./agent-activity";
import { createAgentSessionResolverContext } from "./session-resolver";
import { createAgentSessionHandlers } from "./agent-sessions";
import {
  type AgentSessionFileAccess,
  localAgentSessionFiles,
} from "./session-file-access";

function agent(pane_id: string, path: string, state_change_seq = 1) {
  return {
    pane_id,
    terminal_id: `terminal-${pane_id}`,
    agent: "codex",
    agent_status: "idle",
    state_change_seq,
    agent_session: { agent: "codex", kind: "path", value: path },
  };
}

function handlers(agents: unknown[], files: AgentSessionFileAccess) {
  return createAgentSessionHandlers({
    files,
    herdrCall: async (method, params) => {
      expect(method).toBe("agent.list"); // No per-pane agent.get requests.
      expect(params).toEqual({ workspace: "example" });
      return { agents, extra: "preserved" };
    },
  });
}

async function list(handler: ReturnType<typeof handlers>) {
  return (await handler.listWithActivity({ workspace: "example" })) as {
    agents: ({
      pane_id?: string;
      last_activity_at?: number;
      [key: string]: unknown;
    } | null)[];
    extra: string;
  };
}

const noTranscriptReads = {
  async readText(): Promise<string> {
    throw new Error("Activity must not read transcripts");
  },
  async readPrefix(): Promise<Uint8Array> {
    throw new Error("Activity must not read transcripts");
  },
};

describe("agent activity timestamps", () => {
  test("stats current files across refreshes and fresh bridge instances despite sequence churn", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-activity-"));
    try {
      const old = join(root, "old.jsonl");
      const recent = join(root, "recent.jsonl");
      await writeFile(old, "old transcript");
      await writeFile(recent, "recent transcript");
      await utimes(old, 1000, 1000);
      await utimes(recent, 2000, 2000);
      const snapshot = [agent("old", old, 482), agent("recent", recent, 474)];
      const files = { ...localAgentSessionFiles, ...noTranscriptReads };
      const bridge = handlers(snapshot, files);
      expect(
        (await list(bridge)).agents.map((a) => a?.last_activity_at),
      ).toEqual([1000000, 2000000]);
      snapshot[0]!.state_change_seq = 900;
      expect(
        (await list(handlers(snapshot, files))).agents[0]?.last_activity_at,
      ).toBe(1000000);
      await utimes(recent, 3000, 3000);
      expect((await list(bridge)).agents[1]?.last_activity_at).toBe(3000000);
      await rm(recent);
      expect((await list(bridge)).agents[1]).not.toHaveProperty(
        "last_activity_at",
      );
      expect(snapshot[0]).not.toHaveProperty("last_activity_at");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps missing, failed, and unsupported sessions without fabricated activity", async () => {
    const snapshot = [
      agent("good", "/good"),
      agent("missing", "/missing"),
      agent("denied", "/denied"),
      { ...agent("unsupported", "/unsupported"), agent: "unknown" },
      { ...agent("no-session", "/unused"), agent_session: null },
      null,
    ];
    const files = {
      ...localAgentSessionFiles,
      ...noTranscriptReads,
      async statFile(path: string) {
        if (path === "/denied") throw new Error("Permission denied");
        if (path === "/good") return { path, mtimeMs: 1234 };
        return null;
      },
    };
    const result = await list(handlers(snapshot, files));
    expect(result.extra).toBe("preserved");
    expect(result.agents).toEqual([
      { ...snapshot[0], last_activity_at: 1234 },
      ...snapshot.slice(1),
    ]);
  });

  test("uses connection-specific file access and never resolves remote IDs against local sessions", async () => {
    const snapshot = [
      agent("path", "/remote/session"),
      {
        ...agent("id", "/unused"),
        agent_session: { kind: "id", value: "local-id" },
      },
    ];
    const paths: string[] = [];
    const files = (mtimeMs: number): AgentSessionFileAccess => ({
      ...localAgentSessionFiles,
      remote: true,
      ...noTranscriptReads,
      async statFile(path) {
        paths.push(path);
        return { path, mtimeMs };
      },
    });
    expect((await list(handlers(snapshot, files(100)))).agents).toEqual([
      { ...snapshot[0], last_activity_at: 100 },
      snapshot[1],
    ]);
    expect(
      (await list(handlers(snapshot, files(200)))).agents[0]?.last_activity_at,
    ).toBe(200);
    expect(paths).toEqual(["/remote/session", "/remote/session"]);
  });

  test("over SSH, reuses an agent's activity time while its state stays", async () => {
    const paths: string[] = [];
    let mtimeMs = 100;
    const files: AgentSessionFileAccess = {
      ...localAgentSessionFiles,
      remote: true,
      ...noTranscriptReads,
      async statFile(path) {
        paths.push(path);
        return { path, mtimeMs };
      },
    };
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      let snapshot = [agent("path", "/remote/session")];
      const handler = createAgentSessionHandlers({
        files,
        herdrCall: async () => ({ agents: snapshot }),
      });
      const time = async () =>
        (await list(handler)).agents[0]?.last_activity_at;
      expect(await time()).toBe(100);
      mtimeMs = 200;
      expect(await time()).toBe(100);
      expect(paths).toHaveLength(1);
      // Its agent changed state: stat again.
      snapshot = [agent("path", "/remote/session", 2)];
      expect(await time()).toBe(200);
      expect(paths).toHaveLength(2);
      mtimeMs = 300;
      now += REMOTE_ACTIVITY_REUSE_MS;
      expect(await time()).toBe(300);
      expect(paths).toHaveLength(3);
    } finally {
      Date.now = realNow;
    }
  });

  test("bounds concurrent stats while preserving the source ordering", async () => {
    let active = 0;
    let peak = 0;
    const snapshot = Array.from({ length: 12 }, (_, i) =>
      agent(`p${i}`, `/p${i}`),
    );
    const files = {
      ...localAgentSessionFiles,
      async statFile(path: string) {
        peak = Math.max(peak, ++active);
        await Bun.sleep(1);
        active--;
        return { path, mtimeMs: 1000 };
      },
    };
    const result = await list(handlers(snapshot, files));
    expect(peak).toBeLessThanOrEqual(4);
    expect(result.agents.map((a) => a?.pane_id)).toEqual(
      snapshot.map((a) => a?.pane_id),
    );
  });
});

test("slow activity lookups return all agents promptly and stop scheduling work", async () => {
  const snapshot = Array.from({ length: 10 }, (_, i) =>
    agent(`p${i}`, `/p${i}`),
  );
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const files = {
    ...localAgentSessionFiles,
    async statFile(path: string) {
      calls++;
      await gate;
      return { path, mtimeMs: 1234 };
    },
  };
  try {
    const result = await enrichAgentActivity(
      { agents: snapshot },
      files,
      createAgentSessionResolverContext(),
      1,
    );
    expect(result).toEqual({ agents: snapshot });
    expect(calls).toBe(4);
    release();
    await Bun.sleep(1);
    expect(calls).toBe(4);
    expect(result).toEqual({ agents: snapshot });
  } finally {
    release();
  }
});
