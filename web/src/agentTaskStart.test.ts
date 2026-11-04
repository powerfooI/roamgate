import { afterEach, expect, spyOn, test } from "bun:test";
import { agentReady, startAgentTask } from "./agentTaskStart";
import { roamgateLocalStorage } from "./browserStorage";

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

function storage(values: Record<string, string> = {}) {
  spies.push(
    spyOn(roamgateLocalStorage, "getItem").mockImplementation(
      (key) => values[key] ?? null,
    ),
  );
}

const created = {
  type: "tab_created",
  tab: { tab_id: "tab-9" },
  root_pane: { pane_id: "pane-9", terminal_id: "term-9", tab_id: "tab-9" },
};

function fakeClient(agentReplies: unknown[]) {
  const calls: { method: string; params: any }[] = [];
  return {
    calls,
    client: {
      connectionId: "local",
      isCurrent: () => true,
      async call(method: string, params: any = {}) {
        calls.push({ method, params });
        if (method === "agent.get") {
          const next = agentReplies.length > 1 ? agentReplies.shift() : agentReplies[0];
          if (next instanceof Error) throw next;
          return { agent: next };
        }
        return {};
      },
    },
  };
}

test("starts the agent with the launch command, then sends the prompt once (AC58)", async () => {
  storage();
  const { client, calls } = fakeClient([
    new Error("agent_not_found: pane-9"),
    { agent: "claude", agent_status: "working" },
    { agent: "claude", agent_status: "idle", interactive_ready: true },
  ]);
  const workspaces: string[] = [];
  const session = await startAgentTask(
    {
      client,
      createTab: async (workspaceId) => {
        workspaces.push(workspaceId);
        return created;
      },
      wait: async () => undefined,
    },
    { workspaceId: "w1", agent: "claude", agentCommand: "claude", prompt: "Fix SDS-1" },
  );
  expect(workspaces).toEqual(["w1"]);
  expect(session).toEqual({ tab_id: "tab-9", pane_id: "pane-9", terminal_id: "term-9" });
  const inputs = calls
    .filter((call) => call.method === "pane.send_input")
    .map((call) => [call.params.pane_id, call.params.text, call.params.keys]);
  expect(inputs).toEqual([
    ["pane-9", "claude", ["enter"]],
    ["pane-9", "Fix SDS-1", ["enter"]],
  ]);
});

test("uses the user's saved launch command for the agent", async () => {
  storage({
    [`agentLaunchCommand.v1:${JSON.stringify(["local", "claude"])}`]:
      "claude --model opus",
  });
  const { client, calls } = fakeClient([
    { agent: "claude", agent_status: "idle" },
  ]);
  await startAgentTask(
    { client, createTab: async () => created, wait: async () => undefined },
    { workspaceId: "w1", agent: "claude", agentCommand: "claude", prompt: "p" },
  );
  expect(calls.find((call) => call.method === "pane.send_input")?.params.text).toBe(
    "claude --model opus",
  );
});

test("times out without sending the prompt (AC59)", async () => {
  storage();
  let clock = 0;
  const { client, calls } = fakeClient([
    { agent: "claude", agent_status: "working" },
  ]);
  await expect(
    startAgentTask(
      {
        client,
        createTab: async () => created,
        wait: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
      { workspaceId: "w1", agent: "claude", agentCommand: "claude", prompt: "p" },
    ),
  ).rejects.toThrow("did not start within 60 seconds");
  expect(calls.filter((call) => call.method === "pane.send_input")).toHaveLength(1);
});

test("fails when the tab cannot be created", async () => {
  storage();
  const { client } = fakeClient([]);
  await expect(
    startAgentTask(
      { client, createTab: async () => undefined },
      { workspaceId: "w1", agent: "claude", agentCommand: "claude", prompt: "p" },
    ),
  ).rejects.toThrow("could not open a tab");
});

test("agentReady matches Ranger's readiness check", () => {
  expect(agentReady({ agent: "claude", agent_status: "idle" }, "claude")).toBe(true);
  expect(agentReady({ agent: "claude", agent_status: "working" }, "claude")).toBe(false);
  expect(agentReady({ agent: "codex", agent_status: "unknown" }, "codex")).toBe(true);
  expect(agentReady({ agent: "codex", agent_status: "idle" }, "claude")).toBe(false);
  expect(agentReady(undefined, "claude")).toBe(false);
});

test("links the session before sending the prompt (AC58)", async () => {
  storage();
  const { client, calls } = fakeClient([
    { agent: "claude", agent_status: "idle" },
  ]);
  const order: string[] = [];
  await startAgentTask(
    {
      client: {
        ...client,
        async call(method: string, params: any = {}) {
          if (method === "pane.send_input") order.push(`send:${params.text}`);
          return client.call(method, params);
        },
      },
      createTab: async () => created,
      link: async (session) => {
        order.push(`link:${session.pane_id}`);
      },
      wait: async () => undefined,
    },
    { workspaceId: "w1", agent: "claude", agentCommand: "claude", prompt: "p" },
  );
  expect(order).toEqual(["send:claude", "link:pane-9", "send:p"]);
  expect(calls.filter((call) => call.method === "pane.send_input")).toHaveLength(2);
});

test("a failed link never sends the prompt (AC59)", async () => {
  storage();
  const { client, calls } = fakeClient([
    { agent: "claude", agent_status: "idle" },
  ]);
  await expect(
    startAgentTask(
      {
        client,
        createTab: async () => created,
        link: async () => {
          throw new Error("bridge unavailable");
        },
        wait: async () => undefined,
      },
      { workspaceId: "w1", agent: "claude", agentCommand: "claude", prompt: "p" },
    ),
  ).rejects.toThrow("bridge unavailable");
  const inputs = calls
    .filter((call) => call.method === "pane.send_input")
    .map((call) => call.params.text);
  expect(inputs).toEqual(["claude"]);
});
