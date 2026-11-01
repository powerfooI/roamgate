import { describe, expect, test } from "bun:test";
import {
  createTabAutoRenamer,
  isGenericTerminalTitle,
} from "./tab-auto-rename";

describe("isGenericTerminalTitle", () => {
  test("identifies shell prompts and shell binaries as generic", () => {
    expect(isGenericTerminalTitle("shayani@home1:~/workspace/snsa")).toBe(true);
    expect(isGenericTerminalTitle("shayani@home2: ~")).toBe(true);
    expect(isGenericTerminalTitle("bash")).toBe(true);
    expect(isGenericTerminalTitle("zsh")).toBe(true);
    expect(isGenericTerminalTitle("agy --dangerously-skip-permissions")).toBe(
      true,
    );
    expect(isGenericTerminalTitle("")).toBe(true);
    expect(isGenericTerminalTitle("   ")).toBe(true);
  });

  test("identifies agent generated titles as non-generic", () => {
    expect(isGenericTerminalTitle("Previsão do tempo em João Pessoa")).toBe(
      false,
    );
    expect(isGenericTerminalTitle("Design system para o SNSA")).toBe(false);
    expect(isGenericTerminalTitle("PR 2814 e feature flag")).toBe(false);
  });
});

describe("createTabAutoRenamer", () => {
  const setup = (
    options: {
      panes?: Array<{
        pane_id: string;
        tab_id: string;
        focused?: boolean;
        agent?: string;
      }>;
      tabs?: Array<{ tab_id: string; label: string; number: number }>;
      agentTitles?: Record<string, string | null>;
      enabled?: boolean;
      debounceMs?: number;
    } = {},
  ) => {
    const tabs = options.tabs ?? [
      { tab_id: "tab-1", label: "Tab 1", number: 1 },
    ];
    const panes = options.panes ?? [
      { pane_id: "pane-1", tab_id: "tab-1", focused: true, agent: "claude" },
    ];
    const agentTitles = options.agentTitles ?? {
      "pane-1": "Refactor Database",
    };
    const calls: Array<{ method: string; params: Record<string, unknown> }> =
      [];

    const mockHerdr = {
      async call(method: string, params: Record<string, unknown> = {}) {
        calls.push({ method, params });
        if (method === "tab.list") return { tabs };
        if (method === "pane.list") return { panes };
        if (method === "tab.rename") {
          const target = tabs.find((t) => t.tab_id === params.tab_id);
          if (target && typeof params.label === "string") {
            target.label = params.label;
          }
          return { ok: true };
        }
        return {};
      },
    };

    const renamer = createTabAutoRenamer({
      herdr: mockHerdr,
      getAgentTitleForPane: async (paneId) => agentTitles[paneId] ?? null,
      isEnabled: async () => options.enabled ?? true,
      debounceMs: options.debounceMs ?? 0,
    });

    return { renamer, calls, tabs, panes, agentTitles };
  };

  test("automatically renames tab when agent session title is available", async () => {
    const { renamer, calls, tabs } = setup();

    await renamer.triggerEvaluation();

    const renameCalls = calls.filter((c) => c.method === "tab.rename");
    expect(renameCalls).toHaveLength(1);
    expect(renameCalls[0].params).toEqual({
      tab_id: "tab-1",
      label: "Refactor Database",
    });
    expect(tabs[0].label).toBe("Refactor Database");
  });

  test("does not overwrite manually renamed tabs", async () => {
    const { renamer, calls, tabs } = setup();

    renamer.markManualRename("tab-1");
    await renamer.triggerEvaluation();

    const renameCalls = calls.filter((c) => c.method === "tab.rename");
    expect(renameCalls).toHaveLength(0);
    expect(tabs[0].label).toBe("Tab 1");
  });

  test("prioritizes focused pane agent title over other panes in split tab", async () => {
    const { renamer, calls, tabs } = setup({
      panes: [
        { pane_id: "pane-1", tab_id: "tab-1", focused: false, agent: "claude" },
        { pane_id: "pane-2", tab_id: "tab-1", focused: true, agent: "hermes" },
      ],
      agentTitles: {
        "pane-1": "Claude Session",
        "pane-2": "Hermes Session",
      },
    });

    await renamer.triggerEvaluation();

    const renameCalls = calls.filter((c) => c.method === "tab.rename");
    expect(renameCalls).toHaveLength(1);
    expect(renameCalls[0].params).toEqual({
      tab_id: "tab-1",
      label: "Hermes Session",
    });
    expect(tabs[0].label).toBe("Hermes Session");
  });

  test("falls back to first agent pane when focused pane has no agent in split tab", async () => {
    const { renamer, calls, tabs } = setup({
      panes: [
        { pane_id: "pane-1", tab_id: "tab-1", focused: true }, // normal shell
        { pane_id: "pane-2", tab_id: "tab-1", focused: false, agent: "claude" },
      ],
      agentTitles: {
        "pane-2": "Claude Background Task",
      },
    });

    await renamer.triggerEvaluation();

    const renameCalls = calls.filter((c) => c.method === "tab.rename");
    expect(renameCalls).toHaveLength(1);
    expect(renameCalls[0].params).toEqual({
      tab_id: "tab-1",
      label: "Claude Background Task",
    });
    expect(tabs[0].label).toBe("Claude Background Task");
  });

  test("does not call tab.rename if title has not changed", async () => {
    const { renamer, calls } = setup({
      tabs: [{ tab_id: "tab-1", label: "Already Named", number: 1 }],
      agentTitles: { "pane-1": "Already Named" },
    });

    await renamer.triggerEvaluation();

    const renameCalls = calls.filter((c) => c.method === "tab.rename");
    expect(renameCalls).toHaveLength(0);
  });

  test("does not rename when disabled via isEnabled setting", async () => {
    const { renamer, calls, tabs } = setup({ enabled: false });

    await renamer.triggerEvaluation();

    const renameCalls = calls.filter((c) => c.method === "tab.rename");
    expect(renameCalls).toHaveLength(0);
    expect(tabs[0].label).toBe("Tab 1");
  });

  test("cleans up state when tab is closed", async () => {
    const { renamer } = setup();

    renamer.markManualRename("tab-1");
    expect(renamer.isManuallyRenamed("tab-1")).toBe(true);

    renamer.handleHerdrEvent({
      event: "tab.closed",
      data: { tab_id: "tab-1" },
    });

    expect(renamer.isManuallyRenamed("tab-1")).toBe(false);
  });

  test("debounces evaluation on pane.agent_detected event", async () => {
    const { renamer, calls, tabs } = setup({ debounceMs: 10 });

    renamer.handleHerdrEvent({
      event: "pane.agent_detected",
      data: { pane_id: "pane-1" },
    });

    // Before debounce timer fires
    expect(calls.filter((c) => c.method === "tab.rename")).toHaveLength(0);

    // Wait for debounce timer
    await new Promise((r) => setTimeout(r, 25));

    const renameCalls = calls.filter((c) => c.method === "tab.rename");
    expect(renameCalls).toHaveLength(1);
    expect(tabs[0].label).toBe("Refactor Database");
  });

  test("triggers evaluation on pane.agent_status_changed event", async () => {
    const { renamer, calls, tabs } = setup({ debounceMs: 10 });

    renamer.handleHerdrEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: "pane-1", agent_status: "idle" },
    });

    await new Promise((r) => setTimeout(r, 25));

    const renameCalls = calls.filter((c) => c.method === "tab.rename");
    expect(renameCalls).toHaveLength(1);
    expect(tabs[0].label).toBe("Refactor Database");
  });

  test("passes candidatePane to getAgentTitleForPane", async () => {
    const panes = [
      {
        pane_id: "p1",
        tab_id: "t1",
        agent: "claude",
        terminal_title_stripped: "Stripped Title",
      },
    ];
    let receivedPane: unknown = null;
    const mockHerdr = {
      async call(method: string) {
        if (method === "tab.list")
          return { tabs: [{ tab_id: "t1", label: "Old" }] };
        if (method === "pane.list") return { panes };
        return {};
      },
    };
    const renamer = createTabAutoRenamer({
      herdr: mockHerdr,
      getAgentTitleForPane: async (_id, pane) => {
        receivedPane = pane;
        return (pane as any)?.terminal_title_stripped ?? null;
      },
      debounceMs: 0,
    });

    await renamer.triggerEvaluation();
    expect(receivedPane).toEqual(panes[0]);
  });
});
