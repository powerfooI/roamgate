import { createRoot } from "react-dom/client";
import { bridge } from "../api";
import { AgentHistoryDrawer } from "./AgentHistoryDrawer";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/vendor.css";

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (!condition) failures.push(message);
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

async function run() {
  const originalConnection = bridge.connection;
  bridge.connection = () => ({
    connectionId: "test",
    generation: 1,
    serverRuntimeGeneration: null,
    isCurrent: () => true,
    acceptsServerGeneration: () => true,
    call: async (method) =>
      method === "agent_session.get"
        ? { status: "ok", stats: { turns: 1, records: 2 } }
        : method === "agent_history.entry"
          ? { text: "Tool output ready" }
          : {
              status: "ok",
              history_version: 2,
              mode: "snapshot",
              window_limit: 200,
              cursor: { epoch: "test", revision: 1 },
              entries: [
                {
                  id: "message-1",
                  role: "assistant",
                  kind: "message",
                  text: "# Example\n\nA message for desktop layout verification.",
                  sent_at: "2026-01-01T00:00:00Z",
                },
                {
                  id: "tool-1",
                  role: "tool",
                  kind: "tool_result",
                  tool_name: "read",
                  text: "",
                  text_bytes: 17,
                  sent_at: "2026-01-01T00:01:00Z",
                },
              ],
            },
  });
  const container = document.createElement("div");
  container.style.cssText = "display:flex;height:600px;width:1000px";
  document.body.append(container);
  const root = createRoot(container);
  const render = (wide: boolean) =>
    root.render(
      <AgentHistoryDrawer
        pane={{
          pane_id: "p",
          terminal_id: "terminal",
          workspace_id: "Example",
          tab_id: "tab",
          focused: true,
          agent: "pi",
          agent_status: "Idle",
          revision: 1,
        }}
        open
        embedded
        wide={wide}
        onOpenChange={() => {}}
      />,
    );
  try {
    render(true);
    for (
      let i = 0;
      i < 100 && !container.querySelector(".agent-history-toolbar-actions");
      i++
    )
      await settle();
    for (const theme of ["dark", "light"]) {
      document.documentElement.dataset.theme = theme;
      for (const width of [1000, 640]) {
        container.style.width = `${width}px`;
        await settle();
        const actions = container.querySelector<HTMLElement>(
          ".agent-history-toolbar-actions",
        );
        check(
          !!actions?.closest(".agent-history-tabs"),
          "Wide actions must be in the top toolbar",
        );
        check(
          !container.querySelector(".agent-history-footer"),
          "Wide view must not have a bottom action bar",
        );
        check(
          actions?.querySelectorAll("button").length === 2,
          "Both session actions must remain available",
        );
        check(
          container.scrollWidth <= width,
          `${theme} ${width}: horizontal overflow`,
        );
        const tabs = container.querySelector<HTMLElement>(
          ".agent-history-tab-list",
        );
        check(
          (tabs?.offsetWidth ?? width) < width / 2,
          "Desktop tabs must not stretch across the panel",
        );
        const entry = container.querySelector<HTMLButtonElement>(
          ".agent-history-card-open",
        );
        check(!!entry, "History fixture must render a selectable message");
        entry?.click();
        await settle();
        const reader = container.querySelector<HTMLElement>(
          ".agent-history-wide-detail .agent-message-modal-content",
        );
        check(
          !!reader && getComputedStyle(reader).borderTopWidth === "0px",
          "Reader must not have a nested card border",
        );
        const readerHeader = container.querySelector<HTMLElement>(
          ".agent-history-wide-detail .agent-message-modal-head",
        );
        check(
          !!readerHeader && getComputedStyle(readerHeader).display === "flex",
          `${theme} ${width}: inline message header must keep its flex layout`,
        );
        const title = readerHeader?.firstElementChild;
        const controls = readerHeader?.lastElementChild;
        if (title && controls) {
          const titleRect = title.getBoundingClientRect();
          const controlsRect = controls.getBoundingClientRect();
          check(
            controlsRect.left >= titleRect.right &&
              controlsRect.top < titleRect.bottom &&
              controlsRect.bottom > titleRect.top,
            `${theme} ${width}: inline message actions must stay beside the title`,
          );
        }
        const action = actions?.querySelector("button");
        action?.focus();
        check(
          document.activeElement === action,
          "Toolbar actions must be keyboard focusable",
        );
      }
    }
    container.style.width = "380px";
    render(false);
    await settle();
    check(
      !container.querySelector(".agent-history-toolbar-actions"),
      "Compact view must not duplicate toolbar actions",
    );
    check(
      container.querySelectorAll(".agent-history-footer button").length === 2,
      "Compact view must keep both bottom actions",
    );
    check(container.scrollWidth <= 380, "Compact layout overflow");
    render(true);
    container.style.width = "1000px";
    await settle();
    check(
      !container.querySelector(".agent-history-footer"),
      "Resizing back to wide must remove footer",
    );
    container
      .querySelector<HTMLButtonElement>(".agent-history-filter.is-tool")!
      .click();
    await settle();
    container
      .querySelector<HTMLElement>('[role="slider"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    await settle();
    check(
      container
        .querySelector(".agent-history-wide-detail")
        ?.textContent?.includes("Tool output ready") === true,
      "Selecting a redacted tool entry must fetch its inline content",
    );
  } finally {
    root.unmount();
    container.remove();
    bridge.connection = originalConnection;
  }
}

run()
  .catch((error) => failures.push(String(error)))
  .finally(() =>
    fetch("/result", { method: "POST", body: JSON.stringify(failures) }),
  );
