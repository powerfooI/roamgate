import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantSnapshot,
  AssistantWorkspace,
} from "../../../shared/assistant";
import { isAssistantSnapshot } from "../../../shared/assistant";
import type { AssistantContext } from "./context";
import { type AssistantDriver, createPiDriver } from "./pi-driver";
import { createAssistantService } from "./service";

const workspace: AssistantWorkspace = {
  connection_id: "local",
  workspace_id: "ws",
  connection_label: "Local",
  label: "Workspace",
  runtime_generation: 7,
};
const catalog = {
  providers: [
    {
      id: "test",
      label: "Test",
      methods: ["api_key" as const, "oauth" as const],
      configured: true,
    },
  ],
  models: [{ provider: "test", id: "model", label: "Model" }],
};
const configured = {
  provider: "test",
  model: "model",
  credential_source: "assistant",
  allowed_workspaces: [{ connection_id: "local", workspace_id: "ws" }],
};
const temporary: string[] = [];
const services: ReturnType<typeof createAssistantService>[] = [];
function setup(overrides: Partial<AssistantDriver> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "roamgate-assistant-"));
  temporary.push(directory);
  const snapshots: AssistantSnapshot[] = [];
  const reads: {
    scope: AssistantWorkspace[];
    params: Record<string, unknown>;
  }[] = [];
  const context: AssistantContext = {
    catalog: async () => ({ workspaces: [workspace], errors: [] }),
    captureScope: async (scope) => {
      if (scope.some((ref) => ref.workspace_id !== workspace.workspace_id))
        throw new Error("Unknown workspace");
      return [structuredClone(workspace)];
    },
    read: async (_kind, scope, params) => {
      reads.push({ scope, params });
      return {
        text: "Workspace is working",
        sources: [
          {
            ...workspace,
            id: "source-1",
            kind: "status",
            title: "Status",
            read_at: "2026-10-03T00:00:00Z",
          },
        ],
      };
    },
  };
  const driver: AssistantDriver = {
    catalog: async () => structuredClone(catalog),
    login: async () => {},
    run: async (input) => {
      input.delta("Hello");
      input.message("Hello");
      return [{ persisted: true }];
    },
    stop: async () => {},
    dispose: async () => {},
    ...overrides,
  };
  const service = createAssistantService({
    directory,
    context,
    driver,
    publish: (snapshot) => snapshots.push(snapshot),
  });
  services.push(service);
  return { service, directory, snapshots, reads, context, driver };
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("State did not settle");
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("bridge-global assistant", () => {
  test("operation receipts from another workspace or runtime are excluded from model context", async () => {
    const inputs: Parameters<AssistantDriver["run"]>[0][] = [];
    const f = setup({
      run: async (input) => {
        inputs.push(input);
        if (inputs.length === 1)
          await input.propose!("send_prompt", {
            connection_id: "local",
            workspace_id: "ws",
            pane_id: "p1",
            prompt: "PRIVATE_REVIEW_CONTENT",
          });
        return [{ old: "private context" }];
      },
    });
    let generation = 7;
    f.context.captureScope = async (refs) =>
      refs.map((ref) => ({
        ...workspace,
        ...ref,
        runtime_generation: generation,
      }));
    f.context.prepareAction = async () => ({
      preview: {
        connection_id: "local",
        workspace_id: "ws",
        runtime_generation: 7,
        connection_label: "Local",
        workspace_label: "Workspace",
        kind: "send_prompt",
        summary: "Send feedback",
        params: { pane_id: "p1", prompt: "PRIVATE_REVIEW_CONTENT" },
      },
      execute: async () => ({ status: "uncertain", detail: "Accepted" }),
    });
    await f.service.handle("configure", {
      config: {
        ...configured,
        allowed_workspaces: [
          workspace,
          { connection_id: "local", workspace_id: "other" },
        ],
      },
    });
    await f.service.handle("send", {
      request_id: "one",
      text: "Send feedback",
      scope: [workspace],
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    await f.service.handle("send", {
      request_id: "two",
      text: "Other workspace",
      scope: [{ connection_id: "local", workspace_id: "other" }],
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    expect(inputs[1]!.text).not.toContain("PRIVATE_REVIEW_CONTENT");
    expect(inputs[1]!.entries).toEqual([]);
    generation = 8;
    await f.service.handle("send", {
      request_id: "three",
      text: "Replaced runtime",
      scope: [workspace],
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    expect(inputs[2]!.text).not.toContain("PRIVATE_REVIEW_CONTENT");
    expect(inputs[2]!.entries).toEqual([]);
  });

  test("only explicit confirmation writes, persists admission first, and deduplicates concurrent confirmations", async () => {
    let calls = 0;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const f = setup({
      run: async (input) => {
        await input.propose!("create_workspace", {
          connection_id: "local",
          workspace_id: "ws",
          label: "Task",
        });
        input.message("Review the operation preview.");
        return [];
      },
    });
    f.context.prepareAction = async () => ({
      preview: {
        connection_id: "local",
        workspace_id: "ws",
        runtime_generation: 7,
        connection_label: "Local",
        workspace_label: "Workspace",
        kind: "create_workspace",
        summary: "Create Task",
        params: { cwd: "/repo", label: "Task" },
      },
      execute: async () => {
        calls++;
        const saved = JSON.parse(
          readFileSync(join(f.directory, "state.json"), "utf8"),
        );
        expect(saved.messages.at(-1).actions[0].status).toBe("executing");
        await gate;
        return { status: "succeeded", detail: "Workspace creation verified." };
      },
    });
    await f.service.handle("configure", { config: configured });
    await f.service.handle("send", {
      request_id: "proposal",
      text: "Create Task",
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    const proposal = (await f.service.snapshot()).messages.at(-1)!.actions![0];
    expect(calls).toBe(0);
    expect(proposal.status).toBe("pending");
    await expect(
      f.service.handle("action.confirm", {
        action_id: proposal.id,
        params: { cwd: "/elsewhere" },
      }),
    ).rejects.toThrow("only the action identifier");
    await Promise.all([
      f.service.handle("action.confirm", { action_id: proposal.id }),
      f.service.handle("action.confirm", { action_id: proposal.id }),
    ]);
    expect(calls).toBe(1);
    await expect(
      f.service.handle("send", { request_id: "busy", text: "Hello" }),
    ).rejects.toThrow("busy");
    await expect(
      f.service.handle("configure", { config: configured }),
    ).rejects.toThrow("busy");
    await expect(
      f.service.handle("select_session", {
        session_id: (await f.service.snapshot()).session_id,
      }),
    ).rejects.toThrow("busy");
    await f.service.handle("stop", {});
    expect(
      (await f.service.snapshot()).messages.at(-1)!.actions![0].status,
    ).toBe("executing");
    finish();
    await until(
      () =>
        f.snapshots.at(-1)?.messages.at(-1)?.actions?.[0].status ===
        "succeeded",
    );
    await f.service.handle("action.confirm", { action_id: proposal.id });
    expect(calls).toBe(1);
    expect(isAssistantSnapshot(await f.service.snapshot())).toBe(true);
  });

  test("pending previews expire on cancellation, scope changes, new questions and bridge restart", async () => {
    let calls = 0;
    const f = setup({
      run: async (input) => {
        await input.propose!("start_agent", {
          connection_id: "local",
          workspace_id: "ws",
          pane_id: "p1",
          agent: "pi",
        });
        return [];
      },
    });
    f.context.prepareAction = async () => ({
      preview: {
        connection_id: "local",
        workspace_id: "ws",
        runtime_generation: 7,
        connection_label: "Local",
        workspace_label: "Workspace",
        kind: "start_agent",
        summary: "Start Pi",
        params: { pane_id: "p1", agent: "pi" },
      },
      execute: async () => {
        calls++;
        return { status: "succeeded", detail: "Started" };
      },
    });
    await f.service.handle("configure", { config: configured });
    const propose = async (id: string) => {
      await f.service.handle("send", { request_id: id, text: "Start Pi" });
      await until(() => f.snapshots.at(-1)?.running === false);
      return (await f.service.snapshot()).messages.at(-1)!.actions![0];
    };
    const first = await propose("one");
    await f.service.handle("action.cancel", { action_id: first.id });
    await f.service.handle("action.confirm", { action_id: first.id });
    expect(calls).toBe(0);
    const second = await propose("two");
    await propose("three");
    expect(
      (await f.service.snapshot()).messages
        .flatMap((message) => message.actions ?? [])
        .find((action) => action.id === second.id)?.status,
    ).toBe("cancelled");
    await f.service.handle("configure", {
      config: { ...configured, allowed_workspaces: [] },
    });
    expect(
      (await f.service.snapshot()).messages.at(-1)!.actions![0].status,
    ).toBe("cancelled");
    await f.service.handle("configure", { config: configured });
    const last = await propose("four");
    await f.service.dispose();
    const saved = JSON.parse(
      readFileSync(join(f.directory, "state.json"), "utf8"),
    );
    // Also exercise an interrupted receipt without issuing any real operation.
    saved.messages
      .at(-1)
      .actions.push({ ...last, id: "interrupted", status: "executing" });
    writeFileSync(join(f.directory, "state.json"), JSON.stringify(saved));
    const restored = createAssistantService({
      directory: f.directory,
      context: f.context,
      driver: f.driver,
      publish: () => {},
    });
    services.push(restored);
    const actions = (await restored.snapshot()).messages.flatMap(
      (message) => message.actions ?? [],
    );
    expect(actions.find((action) => action.id === last.id)?.status).toBe(
      "cancelled",
    );
    expect(actions.find((action) => action.id === "interrupted")?.status).toBe(
      "uncertain",
    );
    await restored.handle("action.confirm", { action_id: "interrupted" });
    await restored.handle("action.confirm", { action_id: last.id });
    expect(calls).toBe(0);
  });

  test("an unsaved confirmation cannot execute, and invalid action snapshots are rejected", async () => {
    let calls = 0;
    const f = setup({
      run: async (input) => {
        await input.propose!("send_prompt", {
          connection_id: "local",
          workspace_id: "ws",
          pane_id: "p1",
          prompt: "Review this change",
        });
        return [];
      },
    });
    f.context.prepareAction = async () => ({
      preview: {
        connection_id: "local",
        workspace_id: "ws",
        runtime_generation: 7,
        connection_label: "Local",
        workspace_label: "Workspace",
        kind: "send_prompt",
        summary: "Send review feedback",
        params: { pane_id: "p1", prompt: "Review this change" },
      },
      execute: async () => {
        calls++;
        throw new Error("secret=/private/token");
      },
    });
    await f.service.handle("configure", { config: configured });
    await f.service.handle("send", {
      request_id: "one",
      text: "Send feedback",
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    const snapshot = await f.service.snapshot();
    const id = snapshot.messages.at(-1)!.actions![0].id;
    const tampered = structuredClone(snapshot);
    (
      tampered.messages.at(-1)!.actions![0].params as Record<string, unknown>
    ).prompt = { html: "invalid" };
    expect(isAssistantSnapshot(tampered)).toBe(false);
    rmSync(join(f.directory, "state.json"));
    mkdirSync(join(f.directory, "state.json"));
    await expect(
      f.service.handle("action.confirm", { action_id: id }),
    ).rejects.toThrow("Nothing was executed");
    expect(calls).toBe(0);
    rmSync(join(f.directory, "state.json"), { recursive: true });
    await f.service.handle("action.confirm", { action_id: id });
    await until(
      () =>
        f.snapshots.at(-1)?.messages.at(-1)?.actions?.[0].status ===
        "uncertain",
    );
    expect(calls).toBe(1);
    expect(JSON.stringify(await f.service.snapshot())).not.toContain("secret=");
    await f.service.handle("action.confirm", { action_id: id });
    expect(calls).toBe(1);
  });

  test("streams a bounded snapshot, deduplicates browser sends, freezes scope and rejects mutations while running", async () => {
    let calls = 0;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { service, snapshots, reads } = setup({
      run: async (input) => {
        calls++;
        expect(input.config.allowed_workspaces).toEqual(
          configured.allowed_workspaces,
        );
        expect(input.text).toContain('"runtime_generation":7');
        input.tool("read", "workspace_status", "running");
        expect(await input.read("status", {})).toMatchObject({
          text: "Workspace is working",
          sources: [{ id: "source-1", kind: "status" }],
        });
        input.delta("Answer ");
        input.delta("stream");
        await pending;
        input.message("Answer stream");
        input.tool("read", "workspace_status", "completed");
        return [{ finalized: true }];
      },
      stop: async () => {
        finish();
      },
    });
    await service.handle("configure", configured);
    const admitted = await service.handle("bridge.assistant.send", {
      request_id: "same",
      text: "How is it going?",
    });
    expect(admitted.running).toBe(true);
    await service.handle("send", { request_id: "same", text: "duplicate" });
    expect(calls).toBe(1);
    expect(reads[0]?.scope[0]?.runtime_generation).toBe(7);
    await expect(
      service.handle("send", { request_id: "new", text: "other" }),
    ).rejects.toThrow("busy");
    await expect(service.handle("configure", configured)).rejects.toThrow(
      "busy",
    );
    await expect(service.handle("new_session", {})).rejects.toThrow("busy");
    await expect(
      service.handle("select_session", { session_id: admitted.session_id }),
    ).rejects.toThrow("busy");
    const stopped = await service.handle("stop", {});
    expect(stopped.running).toBe(false);
    expect(stopped.messages[1]?.text).toBe("Answer stream");
    expect(stopped.messages[1]?.sources[0]?.id).toBe("source-1");
    expect(snapshots.at(-1)?.running).toBe(false);
  });

  test("persists finalized turns privately and restores deduplication after reconnect/restart", async () => {
    const { service, directory, context, driver, snapshots } = setup();
    await service.handle("configure", configured);
    await service.handle("send", {
      request_id: "persisted",
      text: "Remember this",
    });
    await until(() => snapshots.at(-1)?.running === false);
    const saved = JSON.parse(
      readFileSync(join(directory, "state.json"), "utf8"),
    );
    expect(saved.entries).toEqual([{ persisted: true }]);
    expect(saved.messages[1].text).toBe("Hello");
    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory, "state.json")).mode & 0o777).toBe(0o600);
    }
    await service.dispose();
    const restored = createAssistantService({
      directory,
      context,
      driver,
      publish: () => {},
    });
    services.push(restored);
    const snapshot = await restored.handle("send", {
      request_id: "persisted",
      text: "duplicate after restart",
    });
    expect(snapshot.messages).toHaveLength(2);
    await expect(
      restored.handle("send", {
        request_id: "escape",
        text: "read outside",
        scope: [{ connection_id: "local", workspace_id: "outside" }],
      }),
    ).rejects.toThrow("authorized");
    await restored.handle("new_session", {});
    expect((await restored.snapshot()).messages).toEqual([]);
  });

  test("keeps separate conversations and restores transcript, SDK history and dedup IDs without reverting global configuration", async () => {
    const inputs: Parameters<AssistantDriver["run"]>[0][] = [];
    const f = setup({
      run: async (input) => {
        inputs.push(input);
        input.message(`Answer ${inputs.length}`);
        return [{ turn: inputs.length }];
      },
    });
    await f.service.handle("configure", configured);
    await f.service.handle("send", {
      request_id: "same-request",
      text: "First conversation\nMore details",
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    const first = await f.service.snapshot();
    expect(first.sessions).toEqual([
      expect.objectContaining({
        id: first.session_id,
        title: "First conversation",
        message_count: 2,
      }),
    ]);
    const empty = await f.service.handle("new_session", {});
    expect(empty.session_id).not.toBe(first.session_id);
    expect(empty.messages).toEqual([]);
    expect(empty.sessions).toHaveLength(2);
    await f.service.handle("send", {
      request_id: "same-request",
      text: "Second conversation",
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    const second = await f.service.snapshot();
    await f.service.handle("configure", {
      ...configured,
      credential_source: "pi",
    });
    const selected = await f.service.handle("select_session", {
      session_id: first.session_id,
    });
    expect(selected.messages).toEqual(first.messages);
    expect(selected.config.credential_source).toBe("pi");
    await f.service.handle("send", {
      request_id: "same-request",
      text: "Duplicate",
    });
    expect(inputs).toHaveLength(2);
    await f.service.handle("send", {
      request_id: "continue",
      text: "Continue",
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    expect(inputs[2]?.entries).toEqual([{ turn: 1 }]);
    expect(inputs[2]?.config.credential_source).toBe("pi");
    if (process.platform !== "win32") {
      expect(statSync(join(f.directory, "sessions")).mode & 0o777).toBe(0o700);
      expect(
        statSync(join(f.directory, "sessions", `${first.session_id}.json`))
          .mode & 0o777,
      ).toBe(0o600);
    }
    await f.service.dispose();
    const restored = createAssistantService({
      directory: f.directory,
      context: f.context,
      driver: f.driver,
      publish: () => {},
    });
    services.push(restored);
    const restart = await restored.snapshot();
    expect(restart.session_id).toBe(first.session_id);
    expect(restart.sessions).toHaveLength(2);
    const old = await restored.handle("select_session", {
      session_id: second.session_id,
    });
    expect(old.messages).toEqual(second.messages);
    expect(old.config.credential_source).toBe("pi");
    await restored.handle("send", {
      request_id: "same-request",
      text: "Duplicate after switching and restarting",
    });
    expect(inputs).toHaveLength(3);
    expect(isAssistantSnapshot(await restored.snapshot())).toBe(true);
  });

  test("migrates the existing single chat and avoids accumulating empty conversations", async () => {
    const f = setup();
    await f.service.handle("configure", configured);
    await f.service.handle("send", {
      request_id: "old",
      text: `${"Long title ".repeat(20)}\nPrivate second line`,
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    await f.service.dispose();
    const path = join(f.directory, "state.json");
    const legacy = JSON.parse(readFileSync(path, "utf8"));
    delete legacy.session_id;
    delete legacy.sessions;
    writeFileSync(path, JSON.stringify(legacy));
    const restored = createAssistantService({
      directory: f.directory,
      context: f.context,
      driver: f.driver,
      publish: () => {},
    });
    services.push(restored);
    const original = await restored.snapshot();
    expect(original.messages).toEqual(legacy.messages);
    expect(JSON.parse(readFileSync(path, "utf8")).session_id).toBe(
      original.session_id,
    );
    expect(original.sessions?.[0]?.title).toBe(
      legacy.messages[0].text.split("\n")[0].slice(0, 72),
    );
    const empty = await restored.handle("new_session", {});
    expect(empty.sessions).toHaveLength(2);
    const another = await restored.handle("new_session", {});
    expect(another.sessions).toHaveLength(2);
    expect(
      another.sessions?.find((session) => session.id === another.session_id)
        ?.title,
    ).toBe("New chat");
    expect(
      another.sessions?.some((session) => session.id === empty.session_id),
    ).toBe(false);
    expect(
      (
        await restored.handle("select_session", {
          session_id: original.session_id,
        })
      ).messages,
    ).toEqual(legacy.messages);
    expect((await restored.snapshot()).sessions).toHaveLength(1);
  });

  test("accepts legacy snapshots but rejects malformed session metadata without leaving an unusable service", async () => {
    const f = setup();
    const snapshot = await f.service.snapshot();
    const legacy = { ...snapshot };
    delete legacy.session_id;
    delete legacy.sessions;
    expect(isAssistantSnapshot(legacy)).toBe(true);
    expect(
      isAssistantSnapshot({ ...legacy, session_id: snapshot.session_id }),
    ).toBe(false);
    expect(
      isAssistantSnapshot({ ...legacy, sessions: snapshot.sessions }),
    ).toBe(false);
    expect(
      isAssistantSnapshot({
        ...snapshot,
        sessions: [{ ...snapshot.sessions![0]!, id: "../secret" }],
      }),
    ).toBe(false);
    expect(
      isAssistantSnapshot({
        ...snapshot,
        sessions: [...snapshot.sessions!, ...snapshot.sessions!],
      }),
    ).toBe(false);
    expect(
      isAssistantSnapshot({
        ...snapshot,
        sessions: [{ ...snapshot.sessions![0]!, message_count: -1 }],
      }),
    ).toBe(false);
    await f.service.handle("configure", configured);
    await f.service.dispose();
    const path = join(f.directory, "state.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    for (const malformed of [
      { ...saved, sessions: undefined },
      { ...saved, session_id: undefined },
      null,
      42,
    ]) {
      writeFileSync(path, JSON.stringify(malformed));
      const restored = createAssistantService({
        directory: f.directory,
        context: f.context,
        driver: f.driver,
        publish: () => {},
      });
      services.push(restored);
      const result = await restored.snapshot();
      expect(result.error).toBe(
        "The saved Ranger session could not be loaded.",
      );
      expect(isAssistantSnapshot(result)).toBe(true);
      expect((await restored.handle("new_session", {})).messages).toEqual([]);
      await restored.dispose();
    }
  });

  test("rejects stale browser sends and invalid session selection without reading arbitrary paths or damaging the active chat", async () => {
    const f = setup();
    await f.service.handle("configure", configured);
    await f.service.handle("send", { request_id: "one", text: "Saved" });
    await until(() => f.snapshots.at(-1)?.running === false);
    const saved = await f.service.snapshot();
    const active = await f.service.handle("new_session", {});
    await expect(
      f.service.handle("send", {
        request_id: "one",
        text: "Wrong chat",
        session_id: saved.session_id,
      }),
    ).rejects.toThrow("active Ranger chat changed");
    for (const id of [
      "../state",
      "/tmp/secret",
      "",
      "00000000-0000-0000-0000-000000000000",
    ])
      await expect(
        f.service.handle("select_session", { session_id: id }),
      ).rejects.toThrow();
    await expect(
      f.service.handle("select_session", {
        session_id: saved.session_id,
        path: "state.json",
      }),
    ).rejects.toThrow("only a saved session identifier");
    const path = join(f.directory, "sessions", `${saved.session_id}.json`);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, "secret=/private/provider-token");
    await expect(
      f.service.handle("select_session", { session_id: saved.session_id }),
    ).rejects.toThrow("The saved Ranger chat could not be loaded.");
    expect((await f.service.snapshot()).session_id).toBe(active.session_id);
    expect((await f.service.snapshot()).messages).toEqual([]);
    writeFileSync(path, "a".repeat(3_000_001));
    await expect(
      f.service.handle("select_session", { session_id: saved.session_id }),
    ).rejects.toThrow("The saved Ranger chat could not be loaded.");
    rmSync(path);
    symlinkSync(join(f.directory, "state.json"), path);
    await expect(
      f.service.handle("select_session", { session_id: saved.session_id }),
    ).rejects.toThrow("The saved Ranger chat could not be loaded.");
    rmSync(path);
    writeFileSync(path, original);
    expect(
      (
        await f.service.handle("select_session", {
          session_id: saved.session_id,
        })
      ).messages,
    ).toEqual(saved.messages);
  });

  test("restored conversations retain confirmed outcomes while their pending previews can never execute", async () => {
    let calls = 0;
    const f = setup({
      run: async (input) => {
        await input.propose!("start_agent", {
          connection_id: "local",
          workspace_id: "ws",
          pane_id: "p1",
          agent: "pi",
        });
        return [{ remembered: true }];
      },
    });
    f.context.prepareAction = async () => ({
      preview: {
        connection_id: "local",
        workspace_id: "ws",
        runtime_generation: 7,
        connection_label: "Local",
        workspace_label: "Workspace",
        kind: "start_agent",
        summary: "Start Pi",
        params: { pane_id: "p1", agent: "pi" },
      },
      execute: async () => {
        calls++;
        return { status: "succeeded", detail: "Started" };
      },
    });
    await f.service.handle("configure", configured);
    await f.service.handle("send", { request_id: "confirmed", text: "Start" });
    await until(() => f.snapshots.at(-1)?.running === false);
    const confirmed = (await f.service.snapshot()).messages.at(-1)!
      .actions![0]!;
    await f.service.handle("action.confirm", { action_id: confirmed.id });
    await until(
      () =>
        f.snapshots.at(-1)?.messages.at(-1)?.actions?.[0]?.status ===
        "succeeded",
    );
    await f.service.handle("send", { request_id: "pending", text: "Another" });
    await until(() => f.snapshots.at(-1)?.running === false);
    const old = await f.service.snapshot();
    const pending = old.messages.at(-1)!.actions![0]!;
    await f.service.handle("new_session", {});
    const archived = JSON.parse(
      readFileSync(
        join(f.directory, "sessions", `${old.session_id}.json`),
        "utf8",
      ),
    );
    expect(archived.messages.at(-1).actions[0].status).toBe("cancelled");
    const selected = await f.service.handle("select_session", {
      session_id: old.session_id,
    });
    expect(selected.messages[1]?.actions?.[0]).toEqual({
      ...confirmed,
      status: "succeeded",
      detail: "Started",
    });
    expect(selected.messages.at(-1)?.actions?.[0]?.status).toBe("cancelled");
    await f.service.handle("action.confirm", { action_id: pending.id });
    await f.service.handle("action.confirm", { action_id: confirmed.id });
    expect(calls).toBe(1);
  });

  test("archive and active save failures leave the previous conversation, history and pending confirmation intact", async () => {
    let calls = 0;
    const f = setup({
      run: async (input) => {
        await input.propose!("start_agent", {
          connection_id: "local",
          workspace_id: "ws",
          pane_id: "p1",
          agent: "pi",
        });
        return [{ current: true }];
      },
    });
    f.context.prepareAction = async () => ({
      preview: {
        connection_id: "local",
        workspace_id: "ws",
        runtime_generation: 7,
        connection_label: "Local",
        workspace_label: "Workspace",
        kind: "start_agent",
        summary: "Start Pi",
        params: { pane_id: "p1", agent: "pi" },
      },
      execute: async () => {
        calls++;
        return { status: "succeeded", detail: "Started" };
      },
    });
    await f.service.handle("configure", configured);
    await f.service.handle("send", { request_id: "first", text: "First" });
    await until(() => f.snapshots.at(-1)?.running === false);
    const first = await f.service.snapshot();
    await f.service.handle("new_session", {});
    await f.service.handle("send", { request_id: "second", text: "Second" });
    await until(() => f.snapshots.at(-1)?.running === false);
    const before = await f.service.snapshot();
    const index = join(f.directory, "state.json");
    const indexBefore = readFileSync(index, "utf8");
    const archivePath = join(
      f.directory,
      "sessions",
      `${before.session_id}.json`,
    );
    mkdirSync(archivePath);
    await expect(f.service.handle("new_session", {})).rejects.toThrow(
      "could not be saved",
    );
    expect(readFileSync(index, "utf8")).toBe(indexBefore);
    expect((await f.service.snapshot()).messages).toEqual(before.messages);
    expect((await f.service.snapshot()).sessions).toEqual(before.sessions);
    rmSync(archivePath, { recursive: true });
    renameSync(index, `${index}.backup`);
    mkdirSync(index);
    await expect(
      f.service.handle("select_session", { session_id: first.session_id }),
    ).rejects.toThrow("could not be saved");
    expect((await f.service.snapshot()).session_id).toBe(before.session_id);
    expect((await f.service.snapshot()).messages).toEqual(before.messages);
    expect((await f.service.snapshot()).sessions).toEqual(before.sessions);
    expect(readFileSync(`${index}.backup`, "utf8")).toBe(indexBefore);
    expect(
      JSON.parse(readFileSync(archivePath, "utf8")).messages.at(-1).actions[0]
        .status,
    ).toBe("cancelled");
    rmSync(index, { recursive: true });
    renameSync(`${index}.backup`, index);
    await f.service.handle("send", { request_id: "second", text: "Duplicate" });
    expect((await f.service.snapshot()).messages).toEqual(before.messages);
    await f.service.handle("action.confirm", {
      action_id: before.messages.at(-1)!.actions![0]!.id,
    });
    await until(
      () =>
        f.snapshots.at(-1)?.messages.at(-1)?.actions?.[0]?.status ===
        "succeeded",
    );
    expect(calls).toBe(1);
  });

  test("switching a saved chat keeps workspace scope and runtime safeguards and rejects switching during login", async () => {
    const histories: unknown[][] = [];
    const f = setup({
      run: async (input) => {
        histories.push(input.entries);
        input.message("Done");
        return [{ private_context: true }];
      },
      login: async (_provider, _method, interaction) => {
        await interaction.prompt({ type: "secret", message: "Key" });
      },
    });
    await f.service.handle("configure", configured);
    await f.service.handle("send", { request_id: "first", text: "Read" });
    await until(() => f.snapshots.at(-1)?.running === false);
    const first = await f.service.snapshot();
    await f.service.handle("new_session", {});
    await f.service.handle("auth.start", {
      provider: "test",
      method: "api_key",
    });
    await expect(
      f.service.handle("select_session", { session_id: first.session_id }),
    ).rejects.toThrow("busy");
    await f.service.handle("auth.cancel", {});
    await f.service.handle("configure", {
      ...configured,
      allowed_workspaces: [],
    });
    const selected = await f.service.handle("select_session", {
      session_id: first.session_id,
    });
    expect(selected.config.allowed_workspaces).toEqual([]);
    await expect(
      f.service.handle("send", { request_id: "escape", text: "Continue" }),
    ).rejects.toThrow("authorized");
    await f.service.handle("configure", configured);
    f.context.captureScope = async () => [
      { ...workspace, runtime_generation: 8 },
    ];
    await f.service.handle("send", {
      request_id: "generation",
      text: "New runtime",
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    expect(histories[1]).toEqual([]);
  });

  test("maps async authentication prompts and never broadcasts submitted secrets or provider errors", async () => {
    const secret = "test-secret-with-private-token";
    const { service, snapshots } = setup({
      login: async (_provider, _method, interaction) => {
        const value = await interaction.prompt({
          type: "secret",
          message: "API key",
        });
        expect(value).toBe(secret);
        throw new Error(`Provider failed with ${value}`);
      },
    });
    await service.handle("configure", configured);
    const started = await service.handle("auth.start", {
      provider: "test",
      method: "api_key",
    });
    expect(started.auth?.prompt?.type).toBe("secret");
    await expect(
      service.handle("auth.respond", {
        auth_id: "old",
        prompt_id: "old",
        value: secret,
      }),
    ).rejects.toThrow("no longer active");
    await service.handle("auth.respond", {
      auth_id: started.auth?.id,
      prompt_id: started.auth?.prompt?.id,
      value: secret,
    });
    await until(() => snapshots.at(-1)?.auth?.status === "failed");
    expect(JSON.stringify(snapshots)).not.toContain(secret);
    expect((await service.snapshot()).messages).toEqual([]);
  });

  test("cancels OAuth and reads Pi credentials only after explicitly switching source", async () => {
    const sources: string[] = [];
    const loginSources: string[] = [];
    const { service, snapshots } = setup({
      catalog: async (source) => {
        sources.push(source);
        return structuredClone(catalog);
      },
      login: async (_provider, _method, interaction) => {
        loginSources.push(interaction.credential_source);
        interaction.notify({
          type: "device_code",
          userCode: "ABCD",
          verificationUri: "https://example.com/device",
        });
        await interaction.prompt({
          type: "manual_code",
          message: "Code",
          signal: interaction.signal,
        });
      },
    });
    expect(sources).toEqual([]);
    await service.handle("get", {});
    expect(sources).toEqual(["assistant"]);
    await service.handle("configure", configured);
    const start = await service.handle("auth.start", {
      provider: "test",
      method: "oauth",
    });
    expect(start.auth?.user_code).toBe("ABCD");
    await expect(
      service.handle("configure", {
        ...configured,
        credential_source: "pi",
      }),
    ).rejects.toThrow("busy");
    expect((await service.snapshot()).config.credential_source).toBe(
      "assistant",
    );
    const cancelled = await service.handle("auth.cancel", {
      auth_id: start.auth?.id,
    });
    expect(cancelled.auth?.status).toBe("failed");
    expect(snapshots.at(-1)?.auth?.url).toBeUndefined();
    await service.handle("configure", {
      ...configured,
      credential_source: "pi",
    });
    expect(sources.at(-1)).toBe("pi");
    const piStart = await service.handle("auth.start", {
      provider: "test",
      method: "oauth",
    });
    expect(piStart.auth?.user_code).toBe("ABCD");
    expect(loginSources).toEqual(["assistant", "pi"]);
    await expect(service.handle("configure", configured)).rejects.toThrow(
      "busy",
    );
    await service.handle("auth.cancel", { auth_id: piStart.auth?.id });
    const switched = await service.handle("configure", configured);
    expect(switched.auth).toBeNull();
    expect(switched.config.credential_source).toBe("assistant");
  });

  test("real Pi catalog enumeration does not execute stored credential commands", async () => {
    const directory = mkdtempSync(join(tmpdir(), "roamgate-pi-metadata-"));
    temporary.push(directory);
    const sentinel = join(directory, "executed");
    writeFileSync(
      join(directory, "auth.json"),
      JSON.stringify({
        anthropic: { type: "api_key", key: `!touch '${sentinel}'` },
      }),
    );
    const driver = createPiDriver(directory);
    const result = await driver.catalog("assistant");
    expect(
      result.providers.find((provider) => provider.id === "anthropic")
        ?.configured,
    ).toBe(true);
    expect(
      result.providers.find((provider) => provider.id === "anthropic")
        ?.credential_method,
    ).toBe("api_key");
    expect(() => readFileSync(sentinel)).toThrow();
    writeFileSync(
      join(directory, "auth.json"),
      JSON.stringify({
        openai: { type: "api_key", key: "test-not-a-real-key" },
        "openai-codex": {
          type: "oauth",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: 0,
        },
      }),
    );
    const refreshed = await driver.catalog("assistant");
    expect(
      refreshed.providers.find((provider) => provider.id === "openai")
        ?.configured,
    ).toBe(true);
    expect(
      refreshed.providers.find((provider) => provider.id === "anthropic")
        ?.configured,
    ).toBe(false);
    expect(refreshed.models.some((model) => model.provider === "openai")).toBe(
      true,
    );
    expect(
      refreshed.providers.find((provider) => provider.id === "openai")
        ?.credential_method,
    ).toBe("api_key");
    expect(
      refreshed.providers.find((provider) => provider.id === "openai-codex")
        ?.credential_method,
    ).toBe("oauth");
    expect(
      refreshed.providers.find((provider) => provider.id === "openai-codex")
        ?.configured,
    ).toBe(true);
    expect(
      refreshed.providers.find((provider) => provider.id === "anthropic")
        ?.credential_method,
    ).toBeUndefined();
    expect(JSON.stringify(refreshed)).not.toContain("synthetic-access");
    expect(JSON.stringify(refreshed)).not.toContain("synthetic-refresh");
    await driver.dispose();
  });

  test("validates optional credential metadata while retaining old snapshot compatibility", async () => {
    const { service } = setup();
    const snapshot = await service.snapshot();
    expect(isAssistantSnapshot(snapshot)).toBe(true);
    snapshot.providers[0]!.credential_method = "oauth";
    expect(isAssistantSnapshot(snapshot)).toBe(true);
    expect(
      isAssistantSnapshot({
        ...snapshot,
        providers: [{ ...snapshot.providers[0], credential_method: "expired" }],
      }),
    ).toBe(false);
  });

  test("a changed workspace generation clears historical model context", async () => {
    const histories: unknown[][] = [];
    const { service, context, snapshots } = setup({
      run: async (input) => {
        histories.push(input.entries);
        input.message("Done");
        return [{ last_generation: 7 }];
      },
    });
    await service.handle("configure", configured);
    await service.handle("send", { request_id: "first", text: "Read status" });
    await until(() => snapshots.at(-1)?.running === false);
    await service.handle("send", { request_id: "second", text: "Continue" });
    await until(() => snapshots.at(-1)?.running === false);
    expect(histories[1]).toEqual([{ last_generation: 7 }]);
    context.captureScope = async () => [
      { ...workspace, runtime_generation: 8 },
    ];
    await service.handle("send", {
      request_id: "third",
      text: "Read new runtime",
    });
    await until(() => snapshots.at(-1)?.running === false);
    expect(histories[2]).toEqual([]);
  });

  test("failed admission can retry the same request and save failures roll back mutations", async () => {
    const { service, context, directory, snapshots } = setup();
    await service.handle("configure", configured);
    const capture = context.captureScope;
    context.captureScope = async () => {
      throw new Error("Disconnected");
    };
    await expect(
      service.handle("send", { request_id: "retry", text: "Hello" }),
    ).rejects.toThrow("unavailable");
    context.captureScope = capture;
    await service.handle("send", { request_id: "retry", text: "Hello" });
    await until(() => snapshots.at(-1)?.running === false);
    expect((await service.snapshot()).messages).toHaveLength(2);
    const statePath = join(directory, "state.json");
    rmSync(statePath);
    mkdirSync(statePath);
    await expect(
      service.handle("configure", { ...configured, provider: "", model: "" }),
    ).rejects.toThrow("could not be saved");
    expect((await service.snapshot()).config.provider).toBe("test");
    await expect(service.handle("new_session", {})).rejects.toThrow(
      "could not be saved",
    );
    expect((await service.snapshot()).messages).toHaveLength(2);
  });

  test("keeps the transcript and SDK history within storage and snapshot ceilings", async () => {
    const { service, directory, snapshots } = setup({
      run: async (input) => {
        input.delta("a".repeat(100_000));
        input.message("a".repeat(100_000));
        return [{ too_large: "a".repeat(1_100_000) }];
      },
    });
    await service.handle("configure", configured);
    await service.handle("send", { request_id: "large", text: "Answer" });
    await until(() => snapshots.at(-1)?.running === false);
    const state = await service.snapshot();
    expect(state.messages[1]?.text.length).toBe(32_000);
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(4_000_000);
    expect(
      JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).entries,
    ).toEqual([]);
  });

  test("Pi sessions expose only fixed workspace tools and no discovered resources", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    let captured:
      | import("@earendil-works/pi-coding-agent").CreateAgentSessionOptions
      | undefined;
    let prompts = 0;
    const driver = createPiDriver(
      "/unused-private-assistant-directory",
      async () =>
        ({
          ...pi,
          ModelRuntime: {
            create: async (options: unknown) => {
              expect(options).toMatchObject({
                modelsPath: null,
                refreshOnCreate: false,
                allowModelNetwork: false,
              });
              return { getModel: () => ({ provider: "test", id: "model" }) };
            },
          },
          createAgentSession: async (
            options: import("@earendil-works/pi-coding-agent").CreateAgentSessionOptions,
          ) => {
            captured = options;
            return {
              session: {
                subscribe: () => () => {},
                prompt: async () => {
                  prompts++;
                },
                waitForIdle: async () => {},
                abort: async () => {},
                dispose: () => {},
              },
            };
          },
        }) as unknown as typeof pi,
    );
    const input: Parameters<AssistantDriver["run"]>[0] = {
      config: { ...configured, credential_source: "assistant" },
      entries: [],
      text: "Read status",
      signal: new AbortController().signal,
      read: async () => ({ text: "status" }),
      delta: () => {},
      message: () => {},
      tool: () => {},
      error: () => {},
    };
    await driver.run(input);
    expect(prompts).toBe(1);
    expect(captured?.noTools).toBe("builtin");
    expect(captured?.tools).toEqual([
      "workspace_status",
      "workspace_history",
      "workspace_diff",
      "workspace_terminal",
    ]);
    expect(captured?.resourceLoader?.getAgentsFiles()).toEqual({
      agentsFiles: [],
    });
    expect(captured?.resourceLoader?.getSkills().skills).toEqual([]);
    expect(captured?.resourceLoader?.getExtensions().extensions).toEqual([]);
    const stopped = new AbortController();
    stopped.abort();
    await expect(
      driver.run({ ...input, signal: stopped.signal }),
    ).rejects.toThrow();
    expect(prompts).toBe(1);
    await driver.dispose();
  });
});
