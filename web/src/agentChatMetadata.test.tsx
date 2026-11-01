import { expect, mock, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_CHAT_METADATA_DOM_TEST !== "1") {
  test("chat metadata stays with its connection and pane", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CHAT_METADATA_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 15_000);
} else {
  test("a switch hides the previous commands and artifacts before a reply", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    type Reply = {
      commands?: { name: string; description: string }[];
      artifacts?: { url: string; title: string }[];
    };
    let client = {
      connectionId: "alpha",
      generation: 1,
      isCurrent: () => true,
      call: async (): Promise<Reply> => ({
        commands: [{ name: "alpha-only", description: "Alpha" }],
        artifacts: [
          { url: "https://claude.ai/artifact/alpha", title: "Alpha artifact" },
        ],
      }),
    };
    mock.module("./useConnectionClient", () => ({
      useConnectionClient: () => client,
      connectionClientScopeKey: (c: typeof client, ...parts: unknown[]) =>
        JSON.stringify([c.connectionId, c.generation, ...parts]),
    }));
    const { useAgentCommands } = await import("./claudeCommands");
    const { useAgentArtifacts } = await import("./agentArtifacts");
    const { createRoot } = await import("react-dom/client");
    const pane = {
      pane_id: "p1",
      terminal_id: "t1",
      workspace_id: "w1",
      tab_id: "tab1",
      agent: "claude",
      agent_status: "idle",
      focused: true,
      revision: 1,
    };
    function Probe({ paneId }: { paneId: string }) {
      const current = { ...pane, pane_id: paneId };
      const commands = useAgentCommands(current, true);
      const artifacts = useAgentArtifacts(current, true);
      return (
        <p>
          {commands.map((x) => x.name).join(",")};
          {artifacts.map((x) => x.title).join(",")}
        </p>
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const render = (paneId = "p1") =>
      React.act(async () => root.render(<Probe paneId={paneId} />));
    try {
      await render();
      expect(host.textContent).toContain("alpha-only");
      expect(host.textContent).toContain("Alpha artifact");
      const pending: Array<(reply: Reply) => void> = [];
      client = {
        ...client,
        connectionId: "beta",
        generation: 2,
        call: () => new Promise<Reply>((resolve) => pending.push(resolve)),
      };
      await render();
      expect(host.textContent).not.toContain("alpha-only");
      expect(host.textContent).not.toContain("Alpha artifact");
      expect(host.textContent).toContain("help");
      await render("p2");
      // Replies from the old pane must not populate the new pane.
      await React.act(async () => {
        pending[0]!({ commands: [{ name: "old-pane-only", description: "" }] });
        pending[1]!({
          artifacts: [
            {
              url: "https://claude.ai/artifact/old",
              title: "Old pane artifact",
            },
          ],
        });
      });
      expect(host.textContent).not.toContain("old-pane-only");
      expect(host.textContent).not.toContain("Old pane artifact");
    } finally {
      await React.act(async () => root.unmount());
      await browser.happyDOM.close();
    }
  });
}
