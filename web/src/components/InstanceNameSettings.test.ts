import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

// React's event setup must see this DOM without changing other tests' globals.
if (process.env.ROAMGATE_INSTANCE_NAME_DOM_TEST !== "1") {
  test("instance name controls in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_INSTANCE_NAME_DOM_TEST: "1" },
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
  await registerDomTests();
}

async function registerDomTests() {
  const browser = new Window({ url: "http://localhost" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "Element",
    "Node",
    "Event",
    "KeyboardEvent",
    "MouseEvent",
    "localStorage",
    "sessionStorage",
  ] as const) {
    Object.defineProperty(globalThis, key, {
      value: key === "window" ? browser : browser[key],
      writable: true,
      configurable: true,
    });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const { act, createElement: h, StrictMode } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { InstanceNameSettings } = await import("./InstanceNameSettings");
  const { createInstanceNameClient, instanceNameClient } = await import(
    "../instanceName"
  );
  let root: Root | null = null;
  let container: HTMLDivElement;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    await browser.happyDOM.whenAsyncComplete();
  });
  afterAll(async () => {
    await browser.happyDOM.close();
  });

  function harness() {
    const requests: Array<{
      url: string;
      init: RequestInit;
      resolve: (response: Response) => void;
      reject: (error: Error) => void;
    }> = [];
    const client = createInstanceNameClient(
      (url, init) =>
        new Promise<Response>((resolve, reject) => {
          requests.push({ url, init, resolve, reject });
        }),
    );
    document.head.innerHTML =
      '<title>Roamgate</title><meta name="application-name" content="Roamgate"><meta name="apple-mobile-web-app-title" content="Roamgate">';
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    return {
      client,
      requests,
      mount: async (strict = false) => {
        await act(async () =>
          root?.render(
            strict
              ? h(StrictMode, null, h(InstanceNameSettings, { client }))
              : h(InstanceNameSettings, { client }),
          ),
        );
      },
      respond: async (index: number, suffix: string) => {
        await act(async () => {
          requests[index].resolve(Response.json({ title_suffix: suffix }));
        });
      },
      fail: async (index: number, message: string) => {
        await act(async () => {
          requests[index].reject(new Error(message));
        });
      },
    };
  }

  const input = () => container.querySelector("input")!;
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    )!;
  const edit = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        browser.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const click = async (label: string) => {
    await act(async () => button(label).click());
  };
  const savedName = () =>
    container.querySelector(".instance-name-preview strong")?.textContent;

  test("loads server scope, previews without saving, and applies only a confirmed save", async () => {
    const flow = harness();
    await flow.mount();
    expect(container.textContent).toContain("shared across all devices");
    expect(container.textContent).toContain("Loading instance name...");
    expect(input().disabled).toBe(true);
    expect(button("Save").disabled).toBe(true);
    expect(button("Reset to default").disabled).toBe(true);
    await flow.respond(0, "Home");
    expect(input().value).toBe("Home");
    expect(savedName()).toBe("Roamgate \u00b7 Home");
    expect(button("Save").disabled).toBe(true);

    await edit("  Work   Laptop  ");
    expect(container.querySelector("output")?.textContent).toBe(
      "Roamgate \u00b7 Work Laptop",
    );
    expect(container.textContent).toContain("Preview (not saved)");
    expect(document.title).toBe("Roamgate \u00b7 Home");
    expect(flow.requests).toHaveLength(1);
    await click("Save");
    expect(flow.requests[1].init.method).toBe("PUT");
    expect(JSON.parse(flow.requests[1].init.body as string)).toEqual({
      title_suffix: "Work Laptop",
    });
    expect(input().disabled).toBe(true);
    expect(savedName()).toBe("Roamgate \u00b7 Home");
    expect(container.textContent).not.toContain("Saved for this");
    await flow.respond(1, "Work Laptop");
    expect(input().value).toBe("Work Laptop");
    expect(savedName()).toBe("Roamgate \u00b7 Work Laptop");
    expect(container.querySelector("output")).toBeNull();
    expect(container.textContent).toContain(
      "Saved for this Roamgate instance.",
    );
    expect(document.title).toBe("Roamgate \u00b7 Work Laptop");
    for (const meta of document.querySelectorAll("meta"))
      expect(meta.getAttribute("content")).toBe("Roamgate \u00b7 Work Laptop");
  });

  test("load failure keeps mutations disabled and supports retry", async () => {
    const flow = harness();
    await flow.mount();
    await flow.fail(0, "Server is unavailable");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Server is unavailable",
    );
    expect(input().disabled).toBe(true);
    expect(button("Save").disabled).toBe(true);
    expect(button("Reset to default").disabled).toBe(true);
    await click("Retry");
    expect(container.textContent).toContain("Loading instance name...");
    await flow.respond(1, "Office");
    expect(input().disabled).toBe(false);
    expect(savedName()).toBe("Roamgate \u00b7 Office");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test("save failure preserves the draft and saved title without false success", async () => {
    const flow = harness();
    await flow.mount();
    await flow.respond(0, "Home");
    await edit("Office");
    await click("Save");
    await flow.fail(1, "Could not persist settings");
    expect(input().value).toBe("Office");
    expect(savedName()).toBe("Roamgate \u00b7 Home");
    expect(document.title).toBe("Roamgate \u00b7 Home");
    expect(container.textContent).toContain("Could not persist settings");
    expect(container.textContent).not.toContain("Saved for this");
    await click("Retry");
    await flow.respond(2, "Office");
    expect(document.title).toBe("Roamgate \u00b7 Office");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test("reset persists an empty suffix and a failed reset can be retried", async () => {
    const flow = harness();
    await flow.mount();
    await flow.respond(0, "Office");
    await click("Reset to default");
    expect(JSON.parse(flow.requests[1].init.body as string)).toEqual({
      title_suffix: "",
    });
    expect(container.querySelector("output")?.textContent).toBe("Roamgate");
    await flow.fail(1, "Reset failed");
    expect(savedName()).toBe("Roamgate \u00b7 Office");
    expect(document.title).toBe("Roamgate \u00b7 Office");
    await click("Retry");
    await flow.respond(2, "");
    expect(input().value).toBe("");
    expect(savedName()).toBe("Roamgate");
    expect(document.title).toBe("Roamgate");
    expect(button("Reset to default").disabled).toBe(true);
  });

  test("repeated submissions and reset clicks cannot race an in-flight save", async () => {
    const flow = harness();
    await flow.mount();
    await flow.respond(0, "Home");
    await edit("Work");
    await act(async () => {
      button("Save").click();
      button("Save").click();
      button("Reset to default").click();
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(flow.requests).toHaveLength(2);
    await flow.respond(1, "Work");
    expect(savedName()).toBe("Roamgate \u00b7 Work");
  });

  test("validates Unicode codepoint length and controls while rendering plain text safely", async () => {
    const flow = harness();
    await flow.mount();
    await flow.respond(0, "");
    await edit("\u{1f680}".repeat(32));
    expect(button("Save").disabled).toBe(false);
    await edit("\u{1f680}".repeat(33));
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(button("Save").disabled).toBe(true);
    expect(container.textContent).toContain("32 characters or fewer");
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(flow.requests).toHaveLength(1);
    await edit("Work\u202e");
    expect(button("Save").disabled).toBe(true);
    expect(container.textContent).toContain("control characters");
    await edit('<img src=x onerror="x">');
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("output")?.textContent).toContain("<img");
    expect(button("Save").disabled).toBe(false);
  });

  test("dismissal during save keeps the confirmed outcome available on reopening", async () => {
    const flow = harness();
    await flow.mount();
    await flow.respond(0, "Home");
    await edit("Work");
    await click("Save");
    await act(async () => root?.render(null));
    await flow.mount();
    expect(flow.requests).toHaveLength(2);
    expect(input().disabled).toBe(true);
    await flow.respond(1, "Work");
    expect(input().disabled).toBe(false);
    expect(savedName()).toBe("Roamgate \u00b7 Work");
    expect(document.title).toBe("Roamgate \u00b7 Work");
  });

  test("reopening after an interrupted failed save exposes the error and allows a fresh read", async () => {
    const flow = harness();
    await flow.mount();
    await flow.respond(0, "Home");
    await edit("Work");
    await click("Save");
    await act(async () => root?.render(null));
    await flow.mount();
    await flow.fail(1, "Connection lost");
    expect(container.textContent).toContain("Connection lost");
    expect(button("Save").disabled).toBe(true);
    expect(document.title).toBe("Roamgate \u00b7 Home");
    await click("Retry");
    await flow.respond(2, "Home");
    expect(savedName()).toBe("Roamgate \u00b7 Home");
    expect(input().disabled).toBe(false);
  });

  test("a late Strict Mode load cannot replace a newer saved name or draft", async () => {
    const flow = harness();
    await flow.mount(true);
    expect(flow.requests).toHaveLength(2);
    await flow.respond(1, "Home");
    await edit("Work");
    await click("Save");
    await flow.respond(2, "Work");
    await edit("Next draft");
    await flow.respond(0, "Old name");
    expect(input().value).toBe("Next draft");
    expect(savedName()).toBe("Roamgate \u00b7 Work");
    expect(document.title).toBe("Roamgate \u00b7 Work");
  });

  test("Configuration keeps instance scope separate and discards an unsaved draft on tab dismissal", async () => {
    const { ConfigurationDialog } = await import("./ConfigurationDialog");
    const {
      defaultMobileTerminalShortcutRows,
      defaultMobileTerminalSideShortcuts,
    } = await import("../mobileTerminalShortcuts");
    const load = spyOn(instanceNameClient, "load").mockResolvedValue({
      title_suffix: "Home",
    });
    const save = spyOn(instanceNameClient, "save").mockResolvedValue({
      title_suffix: "Work",
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    let closed = false;
    const noop = () => {};
    try {
      await act(async () =>
        root?.render(
          h(ConfigurationDialog, {
            initialTab: "Instance",
            onClose: () => {
              closed = true;
            },
            theme: "system",
            accentColor: "blue",
            uiScale: 100,
            terminalFontScale: 100,
            terminalFontName: "monospace",
            mobileTerminalShortcuts: defaultMobileTerminalShortcutRows(),
            mobileTerminalSideShortcuts: defaultMobileTerminalSideShortcuts(),
            terminalThemeSelection: {
              dark: "herdr-dark",
              light: "herdr-light",
            },
            customTerminalThemes: [],
            onThemeChange: noop,
            onAccentColorChange: noop,
            onUiScaleChange: noop,
            onTerminalFontScaleChange: noop,
            onTerminalFontNameChange: noop,
            onMobileTerminalShortcutsChange: noop,
            onMobileTerminalSideShortcutsChange: noop,
            onTerminalThemeSelectionChange: noop,
            onCustomTerminalThemesChange: noop,
          }),
        ),
      );
      const panel = container.querySelector<HTMLElement>(
        "#configuration-panel-Instance",
      )!;
      expect(panel.hidden).toBe(false);
      expect(panel.textContent).toContain("Saved on this Roamgate server");
      expect(panel.textContent).not.toContain("Saved in this browser");
      expect(container.querySelector(".modal-actions")?.textContent).toContain(
        "Use Save",
      );
      await edit("Unsaved");
      await click("Appearance");
      expect(container.querySelector(".instance-name-settings")).toBeNull();
      await click("Behavior");
      await act(async () => {
        button("Behavior").dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        );
      });
      expect(button("Instance").getAttribute("aria-selected")).toBe("true");
      expect(input().value).toBe("Home");
      expect(save).not.toHaveBeenCalled();
      await act(async () => {
        input().dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      expect(closed).toBe(true);
    } finally {
      load.mockRestore();
      save.mockRestore();
    }
  });
}
