import { describe, expect, setSystemTime, test } from "bun:test";
import { CONNECTION_CHANGED_DURING_REQUEST } from "../connections/protocol";
import { createCodexSessionLinker } from "./codex-session-link";
import { localAgentSessionFiles } from "./session-file-access";
import type { HerdrCall } from "./session-types";

const id = "00000000-0000-4000-8000-000000000001";

function fixture() {
  const state = {
    pid: 42,
    terminal: "terminal-1",
    agent: "codex",
    session: null as unknown,
    reported: [] as Record<string, unknown>[],
    metadataId: id,
    identity: "1:2",
    missing: false,
    rejectReport: false,
  };
  const call = async (
    method: string,
    params?: Record<string, unknown>,
    _timeoutMs?: number,
    beforeSend?: () => void,
  ) => {
    beforeSend?.();
    if (method === "agent.get") {
      return {
        agent: {
          agent: state.agent,
          terminal_id: state.terminal,
          agent_session: state.session,
        },
      };
    }
    if (method === "pane.process_info") {
      return {
        process_info: {
          foreground_process_group_id: state.pid,
          foreground_processes: [{ pid: state.pid, name: state.agent }],
        },
      };
    }
    if (method === "pane.report_agent_session") {
      state.reported.push(params!);
      if (!state.rejectReport) {
        state.session = { kind: "id", value: params!.agent_session_id };
      }
      return {};
    }
    throw new Error(`Unexpected method: ${method}`);
  };
  const files = {
    ...localAgentSessionFiles,
    async findCodexSessionById() {
      return state.missing
        ? null
        : {
            path: "/home/user/.codex/sessions/rollout.jsonl",
            mtimeMs: 1000,
            identity: state.identity,
          };
    },
    async readPrefix() {
      return Buffer.from(
        JSON.stringify({
          type: "session_meta",
          payload: { id: state.metadataId, cwd: "/same/repo" },
        }) + "\n",
      );
    },
  };
  return { state, linker: createCodexSessionLinker(call, files), call, files };
}

describe("Codex session linking", () => {
  test("previews without mutation, then links the explicitly confirmed ID", async () => {
    const { state, linker } = fixture();
    const preview = await linker.preview({ pane_id: "p1", session_id: id });
    expect(preview.cwd).toBe("/same/repo");
    expect(state.reported).toHaveLength(0);
    await linker.link({ pane_id: "p1", token: preview.token });
    expect(state.reported).toEqual([
      {
        pane_id: "p1",
        source: "herdr:codex",
        agent: "codex",
        agent_session_id: id,
      },
    ]);
    await expect(
      linker.link({ pane_id: "p1", token: preview.token }),
    ).rejects.toThrow("expired");
  });

  test("does not guess a session from the pane's directory", async () => {
    const { state, linker } = fixture();
    await expect(
      linker.preview({ pane_id: "p1", session_id: "../other" }),
    ).rejects.toThrow("complete");
    state.missing = true;
    await expect(
      linker.preview({ pane_id: "p1", session_id: id }),
    ).rejects.toThrow("No transcript");
    state.missing = false;
    state.metadataId = "different-session";
    await expect(
      linker.preview({ pane_id: "p1", session_id: id }),
    ).rejects.toThrow("does not match");
    expect(state.reported).toHaveLength(0);
  });

  test.each(["transcript", "snapshot", "dispatch"])(
    "does not link a retired runtime while waiting for %s",
    async (stage) => {
      const { state, call, files } = fixture();
      const waiting = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let linking = false;
      let current = true;
      const pause = async () => {
        if (!linking) return;
        waiting.resolve();
        await resume.promise;
      };
      const guardedCall: HerdrCall = async (...args) => {
        if (
          (stage === "snapshot" && args[0] === "pane.process_info") ||
          (stage === "dispatch" && args[0] === "pane.report_agent_session")
        )
          await pause();
        return call(...args);
      };
      const linker = createCodexSessionLinker(guardedCall, {
        ...files,
        async findCodexSessionById() {
          if (stage === "transcript") await pause();
          return files.findCodexSessionById();
        },
      });
      const preview = await linker.preview({ pane_id: "p1", session_id: id });
      linking = true;
      const result = linker.link(
        { pane_id: "p1", token: preview.token },
        () => current,
      );
      await waiting.promise;
      current = false;
      resume.resolve();
      await expect(result).rejects.toThrow(CONNECTION_CHANGED_DURING_REQUEST);
      expect(state.reported).toHaveLength(0);
      expect(state.session).toBeNull();
    },
  );

  for (const change of [
    (state: ReturnType<typeof fixture>["state"]) => {
      state.pid++;
    },
    (state: ReturnType<typeof fixture>["state"]) => {
      state.terminal = "replacement";
    },
    (state: ReturnType<typeof fixture>["state"]) => {
      state.agent = "bash";
    },
    (state: ReturnType<typeof fixture>["state"]) => {
      state.session = { kind: "id", value: "another" };
    },
    (state: ReturnType<typeof fixture>["state"]) => {
      state.identity = "2:3";
    },
  ]) {
    test("rejects a confirmation after its pane or file changed", async () => {
      const { state, linker } = fixture();
      const preview = await linker.preview({ pane_id: "p1", session_id: id });
      change(state);
      await expect(
        linker.link({ pane_id: "p1", token: preview.token }),
      ).rejects.toThrow();
      expect(state.reported).toHaveLength(0);
    });
  }

  test("tokens cannot cross panes or connections and a new preview supersedes the old one", async () => {
    const { linker } = fixture();
    const preview = await linker.preview({ pane_id: "p1", session_id: id });
    await expect(
      linker.link({ pane_id: "p2", token: preview.token }),
    ).rejects.toThrow("expired");
    await expect(
      fixture().linker.link({ pane_id: "p1", token: preview.token }),
    ).rejects.toThrow("expired");
    await linker.preview({ pane_id: "p1", session_id: id });
    await expect(
      linker.link({ pane_id: "p1", token: preview.token }),
    ).rejects.toThrow("expired");
  });

  test("reports failure if Herdr does not retain the link", async () => {
    const { state, linker } = fixture();
    const preview = await linker.preview({ pane_id: "p1", session_id: id });
    state.rejectReport = true;
    await expect(
      linker.link({ pane_id: "p1", token: preview.token }),
    ).rejects.toThrow("did not retain");
  });

  test("expires unused confirmation tokens", async () => {
    const { state, linker } = fixture();
    const preview = await linker.preview({ pane_id: "p1", session_id: id });
    try {
      setSystemTime(new Date(Date.now() + 6 * 60_000));
      await expect(
        linker.link({ pane_id: "p1", token: preview.token }),
      ).rejects.toThrow("expired");
      expect(state.reported).toHaveLength(0);
    } finally {
      setSystemTime();
    }
  });
});
