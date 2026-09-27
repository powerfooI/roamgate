import { expect, spyOn, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as storeModule from "../store";
import type { Pane, Tab } from "../types";
import { AgentRow, nestedAgentPaneIds } from "./WorkspaceAgentRows";

function pane(overrides: Partial<Pane> = {}): Pane {
  return {
    pane_id: "w1:p1",
    terminal_id: "term1",
    workspace_id: "w1",
    tab_id: "t1",
    focused: false,
    cwd: "/projects/Alice",
    agent: "claude",
    agent_status: "working",
    revision: 1,
    ...overrides,
  };
}

function tab(label: string, tabId = "t1", workspaceId = "w1"): Tab {
  return {
    tab_id: tabId,
    workspace_id: workspaceId,
    number: 1,
    label,
    focused: false,
    pane_count: 1,
    agent_status: "working",
  };
}

function renderRow(
  target: Pane,
  tabs: Tab[] = [],
  overrides: Partial<Parameters<typeof AgentRow>[0]> = {},
) {
  const state = { ...storeModule.store.get(), tabs };
  const selector = spyOn(storeModule, "useStoreSelector").mockImplementation(
    (select) => select(state),
  );
  try {
    return renderToStaticMarkup(
      createElement(AgentRow, {
        pane: target,
        selected: false,
        showPaneId: false,
        onOpenMenu() {},
        ...overrides,
      }),
    );
  } finally {
    selector.mockRestore();
  }
}

function title(markup: string): string {
  return markup
    .match(
      /class="agent-title-label">(.*?)<\/span>(?:<span class="badge|<\/div>)/,
    )![1]
    .replace(/<[^>]+>/g, "");
}

test("nested rows prioritize tab names and deduplicate the directory", () => {
  expect(title(renderRow(pane(), [tab(" Alice ")]))).toBe("Alice");
  expect(title(renderRow(pane(), [tab("Planning")]))).toBe("Planning · Alice");
  expect(
    title(
      renderRow(pane({ foreground_cwd: "C:\\projects\\Infra\\" }), [
        tab("Planning"),
      ]),
    ),
  ).toBe("Planning · Infra");
  expect(
    title(renderRow(pane(), [tab("Wrong", "t1", "w2"), tab("Alice")])),
  ).toBe("Alice");
});

test.each([undefined, "", "   ", "1", "Tab 12"])(
  "missing/default tab name %s falls back to the directory, then the agent",
  (label) => {
    const tabs = label === undefined ? [] : [tab(label)];
    expect(title(renderRow(pane(), tabs))).toBe("Alice");
    expect(title(renderRow(pane({ cwd: undefined }), tabs))).toBe("claude");
    expect(
      title(renderRow(pane({ cwd: undefined, agent: undefined }), tabs)),
    ).toBe("Agent");
  },
);

test("only agents with actual icons lose their redundant text name", () => {
  for (const agent of [
    "claude",
    "Claude Code.exe",
    "pi-coding-agent",
    "github_copilot",
    "qoderclicn",
  ]) {
    expect(title(renderRow(pane({ agent }), [tab("Alice")]))).toBe("Alice");
  }
  for (const agent of ["custom-agent", "omp", "droid", "hermes"]) {
    expect(title(renderRow(pane({ agent }), [tab("Alice")]))).toBe(
      `Alice · ${agent}`,
    );
    expect(title(renderRow(pane({ agent, cwd: undefined }), []))).toBe(agent);
  }
});

test("pane IDs appear only for same-tab agents or ambiguous workspace titles", () => {
  const first = pane();
  const second = pane({ pane_id: "w1:p2", tab_id: "t2" });
  expect(
    nestedAgentPaneIds([first, second], [tab("Alice"), tab("Infra", "t2")]),
  ).toEqual(new Set());
  expect(nestedAgentPaneIds([first], [])).toEqual(new Set());
  expect(nestedAgentPaneIds([], [])).toEqual(new Set());
  const both = new Set([first.pane_id, second.pane_id]);
  expect(
    nestedAgentPaneIds(
      [first, { ...second, tab_id: "t1", cwd: "/other" }],
      [tab("Alice")],
    ),
  ).toEqual(both);
  expect(
    nestedAgentPaneIds([first, second], [tab("Alice"), tab("Alice", "t2")]),
  ).toEqual(both);
  expect(
    nestedAgentPaneIds([first, second], [tab("Tab 1"), tab("2", "t2")]),
  ).toEqual(both);
  expect(
    nestedAgentPaneIds(
      [first, second],
      [tab("Wrong", "t1", "w2"), tab("Alice", "t2")],
    ),
  ).toEqual(both);
  expect(
    nestedAgentPaneIds([first, { ...second, cwd: "/elsewhere/Alice" }], []),
  ).toEqual(both);
  expect(
    nestedAgentPaneIds(
      [first, { ...second, cwd: "/elsewhere/Bob" }],
      [tab("Planning"), tab("Planning", "t2")],
    ),
  ).toEqual(new Set());
  expect(
    nestedAgentPaneIds([first, { ...second, agent: "custom-agent" }], []),
  ).toEqual(new Set());
  const ids = nestedAgentPaneIds([first, second], []);
  expect(
    title(renderRow(first, [], { showPaneId: ids.has(first.pane_id) })),
  ).toBe("Alice · p1");
  expect(
    title(renderRow(second, [], { showPaneId: ids.has(second.pane_id) })),
  ).toBe("Alice · p2");
});

test("nested details preserve names, pane IDs, full paths, default tabs and status", () => {
  const target = pane({ foreground_cwd: "/active/Alice" });
  const markup = renderRow(target, [tab("Tab 1")]);
  const details =
    "claude pane w1:p1, tab Tab 1, status working, /active/Alice, /projects/Alice";
  expect(markup).toContain(`title="${details}"`);
  expect(markup).toContain(`aria-label="${details}"`);
  expect(markup).toContain("agent-status-icon-dot is-working");
  expect(markup).toContain('agent-row-status">working</span>');
  expect(markup).toContain('role="treeitem"');
  expect(title(markup)).toBe("Alice");
  expect(renderRow(target)).toContain("tab t1");
});

test("standalone Agents rows retain their title, subtitle and details", () => {
  const markup = renderRow(pane(), [tab("Alice")], {
    variant: "standalone",
    workspaceLabel: "Workspace",
    showPaneId: true,
  });
  expect(title(markup)).toBe("Workspace · Alice · p1");
  expect(markup).toContain('class="agent-sub muted">claude · Alice</div>');
  expect(markup).toContain('title="w1:p1 · Alice · /projects/Alice"');
  expect(markup).toContain(
    'aria-label="claude pane, tab Alice, status working"',
  );
  expect(markup).toContain('role="button"');
});
