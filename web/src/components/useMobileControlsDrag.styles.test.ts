import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { build } from "vite";

test("built mobile controls translate only the outer pills or compact stack", async () => {
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
          new URL("../styles/layout/mobile-nav.css", import.meta.url),
        ),
      },
    },
  });
  if (Array.isArray(result) || !("output" in result)) {
    throw new Error("Expected a single stylesheet build");
  }
  const css = result.output.find((file) => file.fileName.endsWith(".css"));
  if (!css || css.type !== "asset") throw new Error("Missing built stylesheet");
  for (const compact of [false, true]) {
    const browser = new JSDOM(`<html data-layout="mobile"><body>
    <div class="app"${compact ? " data-mobile-controls-compact" : ""}><div class="mobile-controls-stack">
      <nav class="mobile-nav"></nav>
      <nav class="mobile-nav mobile-workspace-tools"></nav>
      <div class="mobile-terminal-controls">
        <nav class="mobile-nav mobile-terminal-tools"></nav>
        <button class="mobile-controls-toggle"></button>
      </div>
    </div></div>
  </body></html>`);
    try {
      const { document, getComputedStyle } = browser.window;
      const style = document.createElement("style");
      style.textContent = String(css.source);
      document.head.append(style);
      const stack = document.querySelector(".mobile-controls-stack")!;
      const tools = document.querySelector(".mobile-terminal-tools")!;
      const pills = document.querySelectorAll(
        ".mobile-terminal-controls, .mobile-nav:not(.mobile-terminal-tools)",
      );
      expect(getComputedStyle(tools).getPropertyValue("translate")).toBe(
        "none",
      );
      for (const pill of pills) {
        const translate = getComputedStyle(pill).getPropertyValue("translate");
        if (compact) expect(translate).toBe("none");
        else expect(translate).toContain("--mobile-controls-drag-x");
      }
      const translate = getComputedStyle(stack).getPropertyValue("translate");
      if (compact) expect(translate).toContain("--mobile-controls-drag-x");
      else expect(translate).toBe("none");
    } finally {
      browser.window.close();
    }
  }
});
