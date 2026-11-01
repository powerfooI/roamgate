import { describe, expect, test } from "bun:test";
import { createTabAutoRenamer } from "./tab-auto-rename";

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
});
