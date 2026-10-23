import { expect, test } from "bun:test";
import { act } from "react";
import type { Workspace } from "../types";
import { WorkspaceInspectorIdentity } from "./WorkspaceInspectorIdentity";

if (process.env.ROAMGATE_INSPECTOR_IDENTITY_DOM_TEST !== "1") {
  test("worktree disclosure in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_INSPECTOR_IDENTITY_DOM_TEST: "1" },
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
  test("defaults closed, toggles details, preserves desktop and resets per workspace", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const workspace = {
      workspace_id: "one",
      label: "Example",
      cwd: "/tmp/example",
    } as Workspace;
    const render = (collapsible: boolean, key = "one") =>
      act(async () => {
        root.render(
          <WorkspaceInspectorIdentity
            key={key}
            workspace={workspace}
            collapsible={collapsible}
          />,
        );
      });
    const details = () =>
      container.querySelector<HTMLElement>(
        ".workspace-inspector-identity-details",
      )!;
    const toggle = () => container.querySelector<HTMLButtonElement>("button")!;
    try {
      await render(true);
      expect(details().hidden).toBe(true);
      expect(toggle().getAttribute("aria-expanded")).toBe("false");
      expect(toggle().getAttribute("aria-controls")).toBe(details().id);
      await act(async () => toggle().click());
      expect(details().hidden).toBe(false);
      expect(toggle().getAttribute("aria-expanded")).toBe("true");
      expect(details().textContent).toContain("/tmp/example");
      await act(async () => toggle().click());
      expect(details().hidden).toBe(true);
      await render(false);
      expect(details().hidden).toBe(false);
      expect(container.querySelector("button")).toBeNull();
      await render(true);
      expect(details().hidden).toBe(true);
      await act(async () => toggle().click());
      await render(true, "two");
      expect(details().hidden).toBe(true);
    } finally {
      await act(async () => root.unmount());
      browser.happyDOM.abort();
      for (const [key, original] of originals) {
        if (original) Object.defineProperty(globalThis, key, original);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}
