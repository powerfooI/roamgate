import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

if (process.env.ROAMGATE_USER_TEXT_DOM_TEST !== "1") {
  test("user message text in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_USER_TEXT_DOM_TEST: "1" },
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
  await registerTests();
}

async function registerTests() {
  const browser = new Window({ url: "http://localhost" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "MouseEvent",
    "DOMParser",
    "NodeFilter",
  ] as const) {
    Object.defineProperty(globalThis, key, {
      value: key === "window" ? browser : browser[key],
      writable: true,
      configurable: true,
    });
  }
  Object.assign(globalThis, {
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { act, createElement: h } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { UserMessageText } = await import("./AgentHistoryChat");

  let root: Root | null = null;
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
  });
  afterAll(async () => browser.happyDOM.close());

  async function render(text: string) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(h(UserMessageText, { text })));
    return container;
  }

  test("a code fence renders as code", async () => {
    const shown = await render(
      "Why does this fail?\n```ts\nconst a: number = `x`;\n```\nand `b` too",
    );
    const code = shown.querySelector("pre code");
    expect(code?.textContent).toContain("const a: number = `x`;");
    expect(shown.textContent).not.toContain("```");
    expect(
      [...shown.querySelectorAll("code")].some((c) => c.textContent === "b"),
    ).toBe(true);
    expect(shown.querySelector(".agent-history-chat-markdown")).not.toBeNull();
  });

  test("plain text stays as typed: one paragraph, newlines and all", async () => {
    const text = "fix server/src/my_module.ts\nthen  run 2 * 3 * 4";
    const shown = await render(text);
    expect(shown.innerHTML).toBe(`<p>${text}</p>`);
  });

  test("no raw HTML gets through", async () => {
    const shown = await render(
      "- one\n- <img src=x onerror=alert(1)><script>alert(2)</script>",
    );
    expect(shown.querySelector("li")).not.toBeNull();
    expect(shown.querySelector("img[onerror], script")).toBeNull();
  });
}
