import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { build } from "vite";

test("speech controls follow Copy visibility except that Stop stays visible", async () => {
  const result = await build({
    configFile: fileURLToPath(new URL("../../vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "silent",
    build: {
      write: false,
      emptyOutDir: false,
      manifest: false,
      rolldownOptions: {
        input: fileURLToPath(
          new URL("./AgentHistoryChat.css", import.meta.url),
        ),
      },
    },
  });
  if (Array.isArray(result) || !("output" in result)) {
    throw new Error("Expected a single stylesheet build");
  }
  const css = result.output.find((file) => file.fileName.endsWith(".css"));
  if (!css || css.type !== "asset") throw new Error("Missing built stylesheet");
  for (const mobile of [false, true]) {
    const browser =
      new JSDOM(`<html data-layout="${mobile ? "mobile" : "desktop"}"><body>
      <article class="agent-history-chat-message">
        <div class="agent-history-chat-meta">
          <button class="agent-history-copy" id="copy">Copy</button>
          <button class="agent-history-copy agent-history-speak" id="speak">Speak</button>
          <button class="agent-history-copy agent-history-speak is-speaking" id="stop">Stop</button>
        </div>
      </article>
    </body></html>`);
    try {
      const { document, getComputedStyle } = browser.window;
      const style = document.createElement("style");
      style.textContent = String(css.source);
      document.head.append(style);
      const opacity = (id: string) =>
        getComputedStyle(document.getElementById(id)!).opacity;
      expect(opacity("copy")).toBe(mobile ? "1" : "0");
      expect(opacity("speak")).toBe(mobile ? "1" : "0");
      expect(opacity("stop")).toBe("1");
    } finally {
      browser.window.close();
    }
  }
});
