import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { AssistantSnapshot } from "../../../shared/assistant";

// Radix/cmdk need DOM globals before loading, isolated from other hook spies.
if (process.env.ROAMGATE_MODEL_FORM_DOM_TEST !== "1") {
  test("custom model reasoning setup in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_MODEL_FORM_DOM_TEST: "1" },
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

function snapshot(model = "reasoner"): AssistantSnapshot {
  const custom = {
    base_url: "https://example.com/v1",
    api: "openai-completions" as const,
  };
  return {
    instance_id: "bridge",
    revision: 1,
    config: {
      provider: model ? "custom" : "",
      model,
      credential_source: "assistant",
      allowed_workspaces: [],
    },
    providers: [
      {
        id: "custom",
        label: "Custom provider",
        methods: ["api_key"],
        configured: true,
        custom,
      },
      { id: "other", label: "Other", methods: [], configured: true },
    ],
    models: [
      {
        provider: "custom",
        id: "reasoner",
        label: "Reasoner",
        custom: { ...custom, reasoning: true },
      },
      {
        provider: "custom",
        id: "plain",
        label: "Plain",
        custom: { ...custom, reasoning: false },
      },
      {
        provider: "custom",
        id: "undeclared",
        label: "Undeclared",
        custom,
      },
    ],
    messages: [],
    running: false,
    error: null,
    auth: null,
  };
}

async function registerDomTests() {
  const browser = new Window({ url: "http://localhost" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLButtonElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
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
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const assistant = await import("../assistant");
  const { bridge } = await import("../api");
  const { AssistantPanel } = await import("./AssistantPanel");
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    expect(document.querySelector(".themed-select-content")).toBeNull();
  });
  afterAll(async () => browser.happyDOM.close());

  async function mount(initial = snapshot()) {
    const clientState: ReturnType<typeof assistant.useAssistantState> = {
      snapshot: initial,
      loading: false,
      error: null,
      connectionStatus: "connected",
      supported: true,
      draft: "",
    };
    const state = spyOn(assistant, "useAssistantState").mockImplementation(
      () => clientState,
    );
    const call = spyOn(assistant, "callAssistant").mockImplementation(
      async (action, params) => {
        if (action === "configure") {
          clientState.snapshot = {
            ...clientState.snapshot!,
            config: params?.config as AssistantSnapshot["config"],
          };
        }
        return clientState.snapshot!;
      },
    );
    const context = spyOn(bridge, "call").mockResolvedValue({ workspaces: [] });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = async () => {
      await act(async () =>
        root.render(
          createElement(AssistantPanel, {
            open: true,
            floating: true,
            mobile: false,
            onClose() {},
            onToggleFloating() {},
            onOpenSource() {},
          }),
        ),
      );
    };
    cleanups.push(async () => {
      await act(async () => root.unmount());
      container.remove();
      context.mockRestore();
      call.mockRestore();
      state.mockRestore();
      await browser.happyDOM.whenAsyncComplete();
    });
    const button = (label: string) => {
      const found = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find(
        (item) =>
          item.getAttribute("aria-label") === label ||
          item.textContent?.trim() === label,
      );
      if (!found) throw new Error(`Missing button ${label}`);
      return found;
    };
    const input = (label: string) =>
      container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[aria-label="${label}"]`,
      )!;
    const fill = async (label: string, value: string) => {
      await act(async () => {
        const field = input(label);
        Object.getOwnPropertyDescriptor(
          field.tagName === "TEXTAREA"
            ? browser.HTMLTextAreaElement.prototype
            : browser.HTMLInputElement.prototype,
          "value",
        )!.set!.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const select = async (label: string, value: string) => {
      await act(async () => button(label).click());
      const option = Array.from(
        document.querySelectorAll<HTMLElement>("[cmdk-item]"),
      ).find((item) => item.dataset.value === value);
      if (!option) throw new Error(`Missing option ${value}`);
      await act(async () => option.click());
      await act(async () => browser.happyDOM.whenAsyncComplete());
    };
    const submit = async () =>
      act(async () =>
        container
          .querySelector('[aria-label="Custom model connection"]')!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          ),
      );
    const lastInput = () => call.mock.calls[call.mock.calls.length - 1]?.[1];
    await render();
    if (!container.querySelector(".assistant-panel-settings"))
      await act(async () => button("Ranger settings").click());
    return {
      container,
      clientState,
      call,
      render,
      button,
      input,
      fill,
      select,
      submit,
      lastInput,
    };
  }

  test.each([undefined, true, false])(
    "new arbitrary IDs use only explicitly selected reasoning (%s)",
    async (reasoning) => {
      const fixture = await mount(snapshot(""));
      expect(
        fixture.button("Custom reasoning capability").textContent,
      ).toContain("Keep existing / model defaults");
      expect(fixture.container.textContent).toContain(
        "New unknown models default to no reasoning",
      );
      await fixture.fill("Custom provider ID", "new-provider");
      await fixture.fill("Custom API base URL", "https://new.example.com/v1");
      await fixture.fill("Custom model IDs", "arbitrary-model");
      await fixture.fill("Custom API key", "synthetic-key");
      if (reasoning !== undefined)
        await fixture.select(
          "Custom reasoning capability",
          reasoning ? "enabled" : "disabled",
        );
      await fixture.submit();
      expect(fixture.call).toHaveBeenLastCalledWith("configure_model", {
        provider: "new-provider",
        model: "arbitrary-model",
        base_url: "https://new.example.com/v1",
        api: "openai-completions",
        api_key: "synthetic-key",
        ...(reasoning === undefined ? {} : { reasoning }),
        credential_source: "assistant",
      });
      if (reasoning === undefined)
        expect(fixture.lastInput()).not.toHaveProperty("reasoning");
    },
  );

  test("an existing undeclared model can enable reasoning without re-entering its saved key", async () => {
    const fixture = await mount(snapshot("undeclared"));
    expect(fixture.input("Custom API key").required).toBe(false);
    expect(fixture.input("Custom model IDs").value).toBe("undeclared");
    await fixture.select("Custom reasoning capability", "enabled");
    fixture.call.mockRejectedValueOnce(new Error("Save failed"));
    await fixture.submit();
    expect(
      fixture.container.querySelector(".assistant-error")?.textContent,
    ).toContain("Save failed");
    expect(fixture.button("Custom reasoning capability").textContent).toContain(
      "Enable reasoning for all IDs",
    );
    await fixture.submit();
    expect(fixture.call).toHaveBeenLastCalledWith("configure_model", {
      provider: "custom",
      model: "undeclared",
      base_url: "https://example.com/v1",
      api: "openai-completions",
      reasoning: true,
      credential_source: "assistant",
    });
    expect(fixture.lastInput()).not.toHaveProperty("api_key");
    expect(fixture.button("Custom reasoning capability").textContent).toContain(
      "Keep existing / model defaults",
    );
  });

  test("unchanged single and mixed batch edits preserve declarations and explicit choices apply to every ID", async () => {
    const fixture = await mount();
    expect(fixture.button("Custom reasoning capability").textContent).toContain(
      "Keep current (reasoning enabled)",
    );
    await fixture.fill("Custom API base URL", "https://updated.example.com/v1");
    await fixture.submit();
    expect(fixture.lastInput()).not.toHaveProperty("reasoning");
    expect(fixture.lastInput()).not.toHaveProperty("api_key");
    await fixture.fill(
      "Custom model IDs",
      "reasoner, plain\nunknown, reasoner",
    );
    expect(fixture.button("Custom reasoning capability").textContent).toContain(
      "Keep existing / model defaults",
    );
    await fixture.submit();
    expect(fixture.lastInput()).toMatchObject({
      models: ["reasoner", "plain", "unknown"],
      base_url: "https://updated.example.com/v1",
    });
    expect(fixture.lastInput()).not.toHaveProperty("reasoning");
    for (const [choice, reasoning] of [
      ["enabled", true],
      ["disabled", false],
    ] as const) {
      await fixture.select("Custom reasoning capability", choice);
      await fixture.submit();
      expect(fixture.lastInput()).toMatchObject({
        model: "reasoner",
        models: ["reasoner", "plain", "unknown"],
        reasoning,
      });
    }
    await fixture.select("Custom reasoning capability", "enabled");
    await fixture.select("Custom reasoning capability", "preserve");
    await fixture.submit();
    expect(fixture.lastInput()).not.toHaveProperty("reasoning");
  });

  test("model, provider, credential source and refreshed metadata reset unsaved reasoning choices", async () => {
    const fixture = await mount();
    await fixture.select("Custom reasoning capability", "disabled");
    await fixture.select("Ranger model", "plain");
    expect(fixture.input("Custom model IDs").value).toBe("plain");
    expect(fixture.button("Custom reasoning capability").textContent).toContain(
      "Keep current (reasoning disabled)",
    );
    await fixture.submit();
    expect(fixture.lastInput()).not.toHaveProperty("reasoning");
    await fixture.select("Custom reasoning capability", "enabled");
    await fixture.select("Ranger model", "reasoner");
    expect(fixture.button("Custom reasoning capability").textContent).toContain(
      "Keep current (reasoning enabled)",
    );
    await fixture.select("Custom reasoning capability", "disabled");
    const current = fixture.clientState.snapshot!.models[0]!;
    current.custom = { ...current.custom!, reasoning: false };
    await fixture.render();
    expect(fixture.button("Custom reasoning capability").textContent).toContain(
      "Keep current (reasoning disabled)",
    );
    await fixture.select("Custom reasoning capability", "enabled");
    await act(async () => fixture.button("Select provider Other").click());
    expect(fixture.input("Custom model IDs").value).toBe("");
    expect(fixture.button("Custom reasoning capability").textContent).toContain(
      "Keep existing / model defaults",
    );
    await fixture.select("Custom reasoning capability", "enabled");
    await act(async () => fixture.button("Shared Pi credentials").click());
    expect(fixture.button("Custom reasoning capability").textContent).toContain(
      "Keep existing / model defaults",
    );
  });
}
