import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type AssistantAction,
  isAssistantMessage,
} from "../../../shared/assistant";
import { ActionCard } from "./AssistantPanel";

test("agent proposals keep exact targets reviewable and delivery outcomes distinct", async () => {
  const browser = new Window({ url: "http://localhost" });
  const prompt =
    "<script>unsafe()</script>\n" + "Full prompt line\n".repeat(200);
  const acceptedDetail =
    "Herdr accepted the prompt. Delivery and the agent's response have not been independently verified. Do not resend automatically.";
  const action: AssistantAction = {
    id: "prompt-review",
    kind: "send_prompt",
    status: "pending",
    connection_id: "local",
    connection_label: "Local",
    workspace_id: "wN",
    workspace_label: "roamgate-dev",
    runtime_generation: 1,
    created_at: "2026-10-03T12:00:00Z",
    params: { pane_id: "wN:pW", agent: "pi", prompt },
    summary: "Send the exact prompt to the selected agent.",
    detail: "",
  };
  const render = (proposal: AssistantAction, busy = false) => {
    browser.document.body.innerHTML = renderToStaticMarkup(
      createElement(ActionCard, {
        action: proposal,
        busy,
        running: false,
        run: async () => true,
      }),
    );
    return browser.document.body;
  };
  try {
    let body = render(action);
    expect(
      body.querySelector(".assistant-prompt-content")?.hasAttribute("open"),
    ).toBe(true);
    expect(body.querySelector('[aria-label="Exact prompt"]')?.textContent).toBe(
      prompt,
    );
    expect(body.querySelector("script")).toBeNull();
    expect(
      body.querySelector(".assistant-prompt-target")?.textContent,
    ).toContain("wN:pW");
    expect(body.querySelector(".assistant-action-meta")?.textContent).toContain(
      "Workspace",
    );
    expect(body.querySelectorAll("button:disabled")).toHaveLength(0);
    expect(
      render(action, true).querySelectorAll("button:disabled"),
    ).toHaveLength(2);

    body = render({ ...action, status: "uncertain", detail: acceptedDetail });
    expect(
      body.querySelector(".assistant-prompt-content")?.hasAttribute("open"),
    ).toBe(false);
    expect(body.querySelector('[aria-label="Exact prompt"]')?.textContent).toBe(
      prompt,
    );
    expect(
      body.querySelector(".assistant-action-head [role=status]")?.textContent,
    ).toBe("Unverified");
    expect(body.querySelector(".assistant-prompt-note")?.textContent).toContain(
      "delivery unverified",
    );
    expect(body.querySelector(".assistant-action-meta")?.textContent).toContain(
      acceptedDetail,
    );
    expect(body.querySelectorAll("button")).toHaveLength(0);

    body = render({
      ...action,
      status: "uncertain",
      detail: "Connection lost before acknowledgement.",
    });
    expect(body.querySelector(".assistant-prompt-note")?.textContent).toBe(
      "Connection lost before acknowledgement.",
    );
    expect(body.textContent).not.toContain("Accepted by Herdr");
    body = render({
      ...action,
      status: "failed",
      detail: "Agent unavailable.",
    });
    expect(
      body
        .querySelector(".assistant-action-card")
        ?.classList.contains("is-failed"),
    ).toBe(true);
    expect(
      body.querySelector(".assistant-action-head [role=status]")?.textContent,
    ).toBe("Failed");
    expect(body.querySelector(".assistant-prompt-note")?.textContent).toBe(
      "Agent unavailable.",
    );
    expect(body.querySelectorAll("button")).toHaveLength(0);

    const startAction: AssistantAction = {
      ...action,
      id: "start-review",
      kind: "start_agent",
      params: {
        pane_id: "wN:pW",
        agent: "pi",
        name: "ranger-0123456789abcdef0123",
      },
      summary: "Start the selected agent without custom command or arguments.",
    };
    body = render(startAction);
    expect(
      body.querySelector(".assistant-action-meta")?.hasAttribute("open"),
    ).toBe(false);
    expect(
      body.querySelector(".assistant-action-target")?.textContent,
    ).toContain("wN:pW");
    expect(
      body.querySelector(".assistant-action-target")?.textContent,
    ).toContain("pi");
    expect(
      body.querySelector(".assistant-action-agent-name")?.textContent,
    ).toContain(startAction.params.name);
    expect(body.querySelector(".assistant-action-meta")?.textContent).toContain(
      startAction.summary,
    );
    expect(body.querySelector(".assistant-action-meta")?.textContent).toContain(
      "Agent name" + startAction.params.name,
    );
    expect(body.querySelector(".assistant-action-meta")?.textContent).toContain(
      "Local" + "local",
    );
    expect(body.querySelector(".assistant-prompt-content")).toBeNull();
    expect(body.querySelectorAll("button")).toHaveLength(2);
    body = render({
      ...startAction,
      status: "succeeded",
      detail: "The agent was verified as interactive in the original terminal.",
    });
    expect(
      body.querySelector(".assistant-action-meta")?.hasAttribute("open"),
    ).toBe(false);
    expect(
      body.querySelector(".assistant-action-agent-name")?.textContent,
    ).toContain(startAction.params.name);
    expect(body.querySelector(".assistant-action-note")?.textContent).toBe(
      "The agent was verified as interactive in the original terminal.",
    );
    expect(body.querySelectorAll("button")).toHaveLength(0);
  } finally {
    await browser.happyDOM.close();
  }
});

test.each(["close_workspace", "close_pane", "close_agent"] as const)(
  "%s cards retain exact close targets, consequences and approval controls",
  async (kind) => {
    const browser = new Window({ url: "http://localhost" });
    const action: AssistantAction = {
      id: `review-${kind}`,
      kind,
      status: "pending",
      connection_id: "local",
      connection_label: "Local",
      workspace_id: "w1",
      workspace_label: "Project",
      runtime_generation: 7,
      created_at: "2026-10-10T10:00:00Z",
      params:
        kind === "close_workspace"
          ? { pane_count: "1", panes: "w1:p1 (pi; terminal term1)" }
          : {
              pane_id: "w1:p1",
              terminal_id: "term1",
              agent: "pi",
              closes_workspace: "true",
            },
      summary:
        "Close the displayed target and terminate its running processes. Unsaved terminal work may be lost. Saved agent history and worktree files will not be deleted.",
      detail: "",
    };
    try {
      expect(
        isAssistantMessage({
          id: "message",
          role: "assistant",
          text: "Review the close action",
          sent_at: action.created_at,
          tools: [],
          sources: [],
          actions: [action],
        }),
      ).toBe(true);
      browser.document.body.innerHTML = renderToStaticMarkup(
        createElement(ActionCard, {
          action,
          busy: false,
          running: false,
          run: async () => true,
        }),
      );
      const body = browser.document.body;
      expect(body.textContent).toContain(action.summary);
      expect(body.textContent).toContain("Needs confirmation");
      expect(body.textContent).toContain("Confirm action");
      expect(body.textContent).toContain("Cancel");
      expect(body.textContent).toContain("Project");
      expect(body.textContent).toContain("w1:p1");
      expect(body.textContent).toContain("term1");
      expect(body.textContent).not.toContain("Start this agent");
      if (kind !== "close_workspace") {
        expect(body.textContent).toContain("Target terminalterm1");
        expect(body.textContent).toContain("Also closes workspaceYes");
      }
    } finally {
      await browser.happyDOM.close();
    }
  },
);
