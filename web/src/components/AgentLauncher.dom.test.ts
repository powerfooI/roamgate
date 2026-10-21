import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

if (process.env.ROAMGATE_AGENT_LAUNCHER_DOM_TEST !== "1") {
  test("agent launcher interactions in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_AGENT_LAUNCHER_DOM_TEST: "1" },
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
    "localStorage",
    "HTMLElement",
    "HTMLInputElement",
    "Element",
    "Node",
    "NodeFilter",
    "Event",
    "CustomEvent",
    "MutationObserver",
    "ResizeObserver",
    "KeyboardEvent",
    "MouseEvent",
    "PointerEvent",
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
  const connection = await import("../useConnectionClient");
  const storeModule = await import("../store");
  const { AgentLauncher } = await import("./AgentLauncher");
  const integrations = {
    integrations: [
      {
        target: "pi",
        label: "Pi",
        command: "pi",
        available: true,
        state: "not_installed",
      },
      {
        target: "claude",
        label: "Claude",
        command: "claude",
        available: true,
        state: "current",
      },
      {
        target: "codex",
        label: "Codex",
        command: "codex",
        available: false,
        state: "current",
      },
      {
        target: "future",
        label: "Future",
        command: "future",
        available: true,
        state: "not_installed",
      },
    ],
  };
  let root: Root | null = null;
  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    spies.splice(0).forEach((spy) => spy.mockRestore());
    document.body.replaceChildren();
    localStorage.clear();
    await browser.happyDOM.whenAsyncComplete();
  });
  afterAll(async () => browser.happyDOM.close());

  async function mount(detect = mock(async () => integrations)) {
    const select = mock((command: string) => command);
    const call = mock(async (method: string) => {
      if (method === "integration.list") return detect();
      throw new Error(`Unexpected RPC: ${method}`);
    });
    const client = {
      connectionId: "test",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
      call,
    };
    spies.push(
      spyOn(connection, "useConnectionClient").mockReturnValue(client),
    );
    const createTab = spyOn(storeModule.store, "createTab").mockResolvedValue(
      {},
    );
    spies.push({
      mockRestore: () => {
        expect(createTab).not.toHaveBeenCalled();
        expect(
          call.mock.calls.every(([method]) =>
            ["integration.list"].includes(method),
          ),
        ).toBe(true);
        createTab.mockRestore();
      },
    });
    const onOpen = mock(() => {});
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = async (
      paneId = "pane",
      disabled = false,
      visible = true,
      terminalId = "terminal",
      tabId = "tab",
    ) =>
      act(async () =>
        root!.render(
          h(AgentLauncher, {
            workspaceId: "workspace",
            paneId,
            tabId,
            terminalId,
            disabled,
            visible,
            onOpen,
            onSelectCommand: select,
          }),
        ),
      );
    await render();
    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    await act(async () => trigger.click());
    return {
      client,
      select,
      call,
      render,
      onOpen,
      trigger,
    };
  }

  function button(label: string) {
    return document.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    )!;
  }

  test("lists all known agents and selecting Pi dispatches its command", async () => {
    const { select, onOpen, trigger } = await mount();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(button("Pi")).not.toBeNull();
    expect(button("Codex")).not.toBeNull();
    expect(button("Future")).not.toBeNull();
    expect(document.querySelector(".agent-launcher-panel p")).toBeNull();
    await act(async () => button("Pi").click());
    expect(select).toHaveBeenCalledWith("pi");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  test.each(["Claude", "Future"])(
    "%s dispatches without permission selection",
    async (label) => {
      const { select } = await mount();
      await act(async () => button(label).click());
      expect(select).toHaveBeenCalledWith(label.toLowerCase());
      expect(document.body.textContent).not.toContain("permissions");
    },
  );

  async function editCommand(value: string) {
    const input = document.querySelector<HTMLInputElement>(
      ".agent-launcher-editor input",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function editorButton(label: string) {
    return Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".agent-launcher-editor button",
      ),
    ).find((item) => item.textContent === label)!;
  }

  test("commands can be saved, reopened, selected, cancelled and reset without selecting while editing", async () => {
    const { select, trigger } = await mount();
    await act(async () => button("Edit Claude command").click());
    expect(
      document.querySelector<HTMLInputElement>(".agent-launcher-editor input")!
        .value,
    ).toBe("claude");
    const command = '"/opt/my agent" --model "custom model"';
    await editCommand(command);
    await act(async () => editorButton("Save").click());
    expect(select).not.toHaveBeenCalled();
    await act(async () => button("Edit Claude command").click());
    expect(
      document.querySelector<HTMLInputElement>(".agent-launcher-editor input")!
        .value,
    ).toBe(command);
    await editCommand("discard this edit");
    await act(async () => editorButton("Cancel").click());
    await act(async () => button("Claude").click());
    expect(select).toHaveBeenLastCalledWith(command);
    await act(async () => trigger.click());
    await act(async () => button("Edit Claude command").click());
    await act(async () => editorButton("Reset").click());
    expect(select).toHaveBeenCalledTimes(1);
    await act(async () => button("Claude").click());
    expect(select).toHaveBeenLastCalledWith("claude");
  });

  test("a failed save keeps the editor and reports the storage error", async () => {
    const { select } = await mount();
    const { roamgateLocalStorage } = await import("../browserStorage");
    spies.push(
      spyOn(roamgateLocalStorage, "setItem").mockImplementation(() => {
        throw new Error("Storage full");
      }),
    );
    await act(async () => button("Edit Pi command").click());
    await editCommand("pi --model custom");
    await act(async () => editorButton("Save").click());
    expect(document.body.textContent).toContain(
      "Could not save command: Storage full",
    );
    expect(document.querySelector(".agent-launcher-editor")).not.toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  test("undetected agents remain editable and use a saved custom executable", async () => {
    const { select, trigger } = await mount();
    await act(async () => button("Edit Codex command").click());
    await editCommand('"/opt/custom tools/codex" --model custom');
    await act(async () => editorButton("Save").click());
    await act(async () => button("Codex").click());
    expect(select).toHaveBeenCalledWith(
      '"/opt/custom tools/codex" --model custom',
    );
    await act(async () => trigger.click());
    await act(async () => button("Edit Codex command").click());
    await act(async () => editorButton("Reset").click());
    expect(button("Edit Codex command")).not.toBeNull();
    await act(async () => button("Codex").click());
    expect(select).toHaveBeenLastCalledWith("codex --no-daemon");
  });

  test("detection failure can be retried without launching anything", async () => {
    const call = mock(async () => integrations);
    call.mockRejectedValueOnce(new Error("Detection unavailable"));
    const { select } = await mount(call);
    expect(document.body.textContent).toContain("Detection unavailable");
    const retry = Array.from(document.querySelectorAll("button")).find(
      (item) => item.textContent === "Retry detection",
    )!;
    await act(async () => retry.click());
    expect(button("Pi")).not.toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  test("empty detection reports no agents", async () => {
    const { select } = await mount(mock(async () => ({ integrations: [] })));
    expect(document.body.textContent).toContain(
      "No agents found on this server",
    );
    expect(select).not.toHaveBeenCalled();
  });

  test("a rejected draft leaves the panel open and reports the error", async () => {
    const { select, trigger } = await mount();
    select.mockImplementationOnce(() => {
      throw new Error("Clear Message first.");
    });
    await act(async () => button("Pi").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Clear Message first.",
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  test("retired connections cannot dispatch", async () => {
    const { client, select } = await mount();
    client.isCurrent = () => false;
    await act(async () => button("Claude").click());
    expect(select).not.toHaveBeenCalled();
  });

  test.each(["pane", "terminal", "runtime"])(
    "%s replacement discards command edits",
    async (kind) => {
      const { client, select, render } = await mount();
      await act(async () => button("Edit Claude command").click());
      await editCommand("unsaved command");
      if (kind === "runtime") {
        client.serverRuntimeGeneration++;
        await render();
      } else if (kind === "pane") await render("replacement");
      else await render("pane", false, true, "replacement");
      expect(document.querySelector(".agent-launcher-editor")).toBeNull();
      expect(localStorage.length).toBe(0);
      expect(select).not.toHaveBeenCalled();
    },
  );

  test.each([
    "pane",
    "pane-aba",
    "runtime",
    "terminal",
    "hidden",
    "disabled",
    "connection",
  ])("late detection is discarded after %s changes", async (change) => {
    let finish!: (value: typeof integrations) => void;
    const detect = mock(
      () =>
        new Promise<typeof integrations>((resolve) => {
          finish = resolve;
        }),
    );
    const { client, select, render } = await mount(detect);
    if (change === "pane" || change === "pane-aba") {
      await render("replacement");
      if (change === "pane-aba") await render();
    } else if (change === "runtime") {
      client.serverRuntimeGeneration++;
      await render();
    } else if (change === "terminal")
      await render("pane", false, true, "replacement");
    else if (change === "hidden") await render("pane", false, false);
    else if (change === "disabled") await render("pane", true);
    else client.isCurrent = () => false;
    await act(async () => finish(integrations));
    expect(button("Pi")).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  test("late detection after unmount never dispatches a launch", async () => {
    let finish!: (value: typeof integrations) => void;
    const detect = mock(
      () =>
        new Promise<typeof integrations>((resolve) => {
          finish = resolve;
        }),
    );
    const { select } = await mount(detect);
    await act(async () => root!.unmount());
    root = null;
    await act(async () => finish(integrations));
    expect(select).not.toHaveBeenCalled();
    expect(button("Pi")).toBeNull();
  });

  test("Escape dismisses the panel and late detection from a retired connection is ignored", async () => {
    let finish!: (value: typeof integrations) => void;
    const call = mock(
      () =>
        new Promise<typeof integrations>((resolve) => {
          finish = resolve;
        }),
    );
    const { client, trigger } = await mount(call);
    expect(document.body.textContent).toContain("Detecting installed agents");
    client.isCurrent = () => false;
    await act(async () => finish(integrations));
    expect(button("Pi")).toBeNull();
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
}
