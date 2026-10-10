import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import {
  ASSISTANT_THINKING_LEVELS,
  type AssistantSnapshot,
  type AssistantModelConnection,
  type AssistantThinkingLevel,
} from "../../../shared/assistant";
import { thinkingLabels } from "../assistantModels";

// Radix/cmdk need DOM globals before loading, isolated from other hook spies.
if (process.env.ROAMGATE_MODEL_FORM_DOM_TEST !== "1") {
  test("custom model thinking setup in an isolated DOM runtime", async () => {
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
        thinking_levels: ["off", "medium", "xhigh"],
        default_thinking_level: "medium",
      },
      {
        provider: "custom",
        id: "plain",
        label: "Plain",
        custom: { ...custom, reasoning: false },
        thinking_levels: ["off"],
        default_thinking_level: "off",
      },
      {
        provider: "custom",
        id: "undeclared",
        label: "Undeclared",
        custom,
      },
      {
        provider: "custom",
        id: "legacy",
        label: "Legacy reasoner",
        custom: { ...custom, reasoning: true },
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

  async function mount(initial = snapshot(), openCustom = true) {
    const clientState: ReturnType<typeof assistant.useAssistantState> = {
      snapshot: initial,
      loading: false,
      error: null,
      connectionStatus: "connected",
      supported: true,
      draft: "",
      draftMentions: [],
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
        } else if (action === "configure_model") {
          const input = params as AssistantModelConnection;
          const custom = { base_url: input.base_url, api: input.api };
          const current = clientState.snapshot!;
          current.providers = [
            ...current.providers.filter((item) => item.id !== input.provider),
            {
              id: input.provider,
              label: input.provider,
              configured: true,
              methods: ["api_key"],
              custom,
            },
          ];
          for (const id of input.models ?? [input.model]) {
            const previous = current.models.find(
              (item) => item.provider === input.provider && item.id === id,
            );
            current.models = [
              ...current.models.filter(
                (item) => item.provider !== input.provider || item.id !== id,
              ),
              {
                ...previous,
                provider: input.provider,
                id,
                label: previous?.label ?? id,
                custom: { ...previous?.custom, ...custom },
                ...(input.thinking_levels
                  ? { thinking_levels: input.thinking_levels }
                  : {}),
              },
            ];
          }
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
    const thinkingInput = (level: AssistantThinkingLevel) =>
      input(`Support ${thinkingLabels[level]} thinking`) as HTMLInputElement;
    const selectedLevels = () =>
      ASSISTANT_THINKING_LEVELS.filter((level) => thinkingInput(level).checked);
    const toggle = async (level: AssistantThinkingLevel) =>
      act(async () => thinkingInput(level).click());
    const submit = async () =>
      act(async () =>
        container
          .querySelector('[aria-label="Custom model connection"]')!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          ),
      );
    const lastInput = () => call.mock.calls[call.mock.calls.length - 1]?.[1];
    const overview = async () => {
      const back = container.querySelector<HTMLButtonElement>(
        '[aria-label="Back to Ranger settings"]',
      );
      if (back) await act(async () => back.click());
    };
    const custom = async () => {
      await overview();
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Edit custom models"], [aria-label="Add custom models"]',
          )!
          .click(),
      );
    };
    await render();
    if (!container.querySelector(".assistant-panel-settings"))
      await act(async () => button("Ranger settings").click());
    if (openCustom) await custom();
    return {
      container,
      clientState,
      call,
      render,
      button,
      input,
      fill,
      select,
      selectedLevels,
      toggle,
      submit,
      lastInput,
      overview,
      custom,
    };
  }

  test("new models offer every thinking level and default to Off", async () => {
    const fixture = await mount(snapshot(""));
    const levels = fixture.container.querySelector(
      'fieldset[aria-label="Supported thinking efforts"]',
    )!;
    expect(levels.querySelectorAll('input[type="checkbox"]').length).toBe(
      ASSISTANT_THINKING_LEVELS.length,
    );
    expect(fixture.selectedLevels()).toEqual(["off"]);
    expect(
      fixture.container.querySelector("form.assistant-custom-model"),
    ).not.toBeNull();
    expect(fixture.container.querySelector("details")).toBeNull();
    expect(fixture.container.textContent).toContain("Add custom models");
    await fixture.fill("Custom provider ID", "new-provider");
    await fixture.fill("Custom API base URL", "https://new.example.com/v1");
    await fixture.fill("Custom model IDs", "arbitrary-model");
    await fixture.fill("Custom API key", "synthetic-key");
    await fixture.submit();
    expect(fixture.call).toHaveBeenLastCalledWith("configure_model", {
      provider: "new-provider",
      model: "arbitrary-model",
      base_url: "https://new.example.com/v1",
      api: "openai-completions",
      api_key: "synthetic-key",
      credential_source: "assistant",
    });
  });

  test.each([
    ["legacy", ["off", "minimal", "low", "medium", "high"]],
    ["plain", ["off"]],
    ["undeclared", ["off"]],
  ] as const)(
    "%s models use their saved capability as a fallback",
    async (model, levels) => {
      const fixture = await mount(snapshot(model));
      expect(fixture.selectedLevels()).toEqual([...levels]);
      await fixture.submit();
      expect(fixture.lastInput()).not.toHaveProperty("thinking_levels");
      expect(fixture.lastInput()).not.toHaveProperty("reasoning");
    },
  );

  test("unchanged single and mixed batch edits preserve imported thinking settings", async () => {
    const fixture = await mount();
    expect(fixture.selectedLevels()).toEqual(["off", "medium", "xhigh"]);
    expect(fixture.input("Custom API key").required).toBe(false);
    expect(
      fixture.container.querySelector("form.assistant-custom-model"),
    ).not.toBeNull();
    expect(fixture.container.querySelector("details")).toBeNull();
    expect(fixture.container.textContent).toContain("Edit custom models");
    for (const label of [
      "Custom provider ID",
      "Custom API base URL",
      "Custom API key",
    ])
      expect(fixture.input(label)).not.toBeNull();
    await fixture.fill("Custom API base URL", "https://updated.example.com/v1");
    await fixture.submit();
    expect(fixture.lastInput()).not.toHaveProperty("thinking_levels");
    expect(fixture.lastInput()).not.toHaveProperty("reasoning");
    expect(fixture.lastInput()).not.toHaveProperty("api_key");
    await fixture.custom();
    await fixture.fill(
      "Custom model IDs",
      "reasoner, plain\nunknown, reasoner",
    );
    await fixture.submit();
    expect(fixture.lastInput()).toMatchObject({
      model: "reasoner",
      models: ["reasoner", "plain", "unknown"],
      base_url: "https://updated.example.com/v1",
    });
    expect(fixture.lastInput()).not.toHaveProperty("thinking_levels");
    expect(fixture.lastInput()).not.toHaveProperty("reasoning");
    await fixture.custom();
    await fixture.fill(
      "Custom model IDs",
      "reasoner, plain\nunknown, reasoner",
    );
    await fixture.toggle("max");
    await fixture.toggle("minimal");
    await fixture.submit();
    expect(fixture.lastInput()).toMatchObject({
      model: "reasoner",
      models: ["reasoner", "plain", "unknown"],
      thinking_levels: ["off", "minimal", "max"],
    });
    expect(fixture.lastInput()).not.toHaveProperty("reasoning");
  });

  test("a model with one thinking level shows its effective default while disabled", async () => {
    const initial = snapshot();
    initial.chat_selection = true;
    initial.models[0]!.thinking_levels = ["high"];
    initial.models[0]!.default_thinking_level = "high";
    const fixture = await mount(initial, false);
    const effort = fixture.button("Default thinking effort");
    expect(effort.disabled).toBe(true);
    expect(effort.textContent).toContain("Default (High)");
  });

  test("users can choose the full range in canonical order", async () => {
    const fixture = await mount(snapshot("undeclared"));
    for (const level of [...ASSISTANT_THINKING_LEVELS].reverse()) {
      if (level !== "off") await fixture.toggle(level);
    }
    await fixture.submit();
    expect(fixture.lastInput()).toMatchObject({
      thinking_levels: [...ASSISTANT_THINKING_LEVELS],
    });
  });

  test("at least one thinking level is required even for a synthetic submit", async () => {
    const fixture = await mount(snapshot("undeclared"));
    await fixture.toggle("off");
    expect(fixture.button("Save custom models").disabled).toBe(true);
    const calls = fixture.call.mock.calls.length;
    await fixture.submit();
    expect(fixture.call.mock.calls.length).toBe(calls);
    await fixture.toggle("high");
    expect(fixture.button("Save custom models").disabled).toBe(false);
    await fixture.submit();
    expect(fixture.lastInput()).toMatchObject({ thinking_levels: ["high"] });
  });

  test("a failed save keeps choices and a successful save clears their dirty state", async () => {
    const fixture = await mount(snapshot("undeclared"));
    await fixture.toggle("high");
    fixture.call.mockRejectedValueOnce(new Error("Save failed"));
    await fixture.submit();
    expect(
      fixture.container.querySelector(".assistant-error")?.textContent,
    ).toContain("Save failed");
    expect(fixture.selectedLevels()).toEqual(["off", "high"]);
    await fixture.submit();
    expect(fixture.call).toHaveBeenLastCalledWith("configure_model", {
      provider: "custom",
      model: "undeclared",
      base_url: "https://example.com/v1",
      api: "openai-completions",
      thinking_levels: ["off", "high"],
      credential_source: "assistant",
    });
    expect(fixture.lastInput()).not.toHaveProperty("api_key");
    expect(
      fixture.container.querySelector(".assistant-custom-model"),
    ).toBeNull();
    await fixture.custom();
    await fixture.submit();
    expect(fixture.lastInput()).not.toHaveProperty("thinking_levels");
    expect(fixture.lastInput()).not.toHaveProperty("reasoning");
  });

  test("model, provider, credential source and refreshed levels reset unsaved choices", async () => {
    const fixture = await mount();
    await fixture.toggle("max");
    await fixture.overview();
    await fixture.select("Ranger model", "plain");
    await fixture.custom();
    expect(fixture.input("Custom model IDs").value).toBe("plain");
    expect(fixture.selectedLevels()).toEqual(["off"]);
    await fixture.submit();
    expect(fixture.lastInput()).not.toHaveProperty("thinking_levels");
    await fixture.custom();
    await fixture.toggle("high");
    await fixture.overview();
    await fixture.select("Ranger model", "reasoner");
    await fixture.custom();
    expect(fixture.selectedLevels()).toEqual(["off", "medium", "xhigh"]);
    await fixture.toggle("max");
    fixture.clientState.snapshot!.models.find(
      (model) => model.id === "reasoner",
    )!.thinking_levels = ["off", "low"];
    await fixture.render();
    expect(fixture.selectedLevels()).toEqual(["off", "low"]);
    await fixture.toggle("max");
    await fixture.overview();
    await fixture.select("Model provider", "other");
    expect(
      fixture.container.querySelector('[aria-label="Edit custom models"]'),
    ).toBeNull();
    await act(async () => fixture.button("Add custom models").click());
    expect(fixture.input("Custom model IDs").value).toBe("");
    expect(fixture.selectedLevels()).toEqual(["off"]);
    await fixture.toggle("high");
    await fixture.overview();
    await act(async () => fixture.button("Shared Pi credentials").click());
    await act(async () => fixture.button("Add custom models").click());
    expect(fixture.selectedLevels()).toEqual(["off"]);
  });

  test("settings keep model and workspace access on one page with a single save", async () => {
    const fixture = await mount(snapshot(), false);
    expect(fixture.container.querySelector("details")).toBeNull();
    expect(
      fixture.container.querySelector(".assistant-custom-model"),
    ).toBeNull();
    for (const label of [
      "Credential source",
      "Model provider",
      "Ranger model",
      "Edit custom models",
      "Add custom models",
      "High-permission mode",
      "Refresh Ranger workspaces",
    ])
      expect(
        fixture.container.querySelector(`[aria-label="${label}"]`),
      ).not.toBeNull();
    expect(fixture.container.querySelector(".assistant-workspaces")).not.toBe(
      null,
    );
    expect(
      fixture.container.querySelectorAll(".assistant-settings-primary"),
    ).toHaveLength(1);
    expect(fixture.button("Model provider").textContent).toContain(
      "Custom provider",
    );
    expect(
      fixture.container.querySelector(".assistant-provider-status")
        ?.textContent,
    ).toContain("Credentials saved");
    expect(
      fixture.container.querySelector(".assistant-custom-models")?.textContent,
    ).toContain("Custom provider · example.com");
    const status = fixture.container.querySelector(
      ".assistant-settings-save [role=status]",
    )!;
    expect(status.textContent).toBe("");
    await fixture.select("Ranger model", "plain");
    expect(status.textContent).toBe("Unsaved changes");
    await fixture.select("Model provider", "other");
    expect(fixture.button("Ranger model").textContent).toContain(
      "No models available",
    );
    expect(fixture.clientState.snapshot!.config.provider).toBe("custom");
  });

  test("adding models to a selected custom endpoint starts with no IDs", async () => {
    const fixture = await mount(snapshot(), false);
    await act(async () => fixture.button("Add custom models").click());
    expect(
      fixture.container.querySelector(".assistant-settings-heading h3")
        ?.textContent,
    ).toBe("Add custom models");
    expect(fixture.input("Custom model IDs").value).toBe("");
    expect(document.activeElement).toBe(fixture.input("Custom model IDs"));
    expect(fixture.input("Custom provider ID").value).toBe("custom");
    expect(fixture.input("Custom API base URL").value).toBe(
      "https://example.com/v1",
    );
    expect(fixture.input("Custom API key").required).toBe(false);
    expect(fixture.selectedLevels()).toEqual(["off"]);
    await fixture.fill("Custom model IDs", "fresh-a\nfresh-b");
    await fixture.toggle("low");
    await fixture.toggle("high");
    await fixture.submit();
    expect(fixture.call).toHaveBeenLastCalledWith("configure_model", {
      provider: "custom",
      model: "fresh-a",
      models: ["fresh-a", "fresh-b"],
      base_url: "https://example.com/v1",
      api: "openai-completions",
      thinking_levels: ["off", "low", "high"],
      credential_source: "assistant",
    });
    expect(
      fixture.container.querySelector(".assistant-custom-model"),
    ).toBeNull();
    expect(document.activeElement).toBe(fixture.button("Add custom models"));
    expect(fixture.button("Ranger model").textContent).toContain("fresh-a");
    expect(
      fixture.container.querySelector(".assistant-settings-save [role=status]")
        ?.textContent,
    ).toBe("Unsaved changes");
  });

  test("a running task moves custom editor focus to its heading when inputs are disabled", async () => {
    const initial = snapshot();
    const at = "2026-10-10T00:00:00Z";
    initial.tasks = [
      {
        id: "running-task",
        title: "Running task",
        prompt: "Read workspace status",
        scope: [],
        workspaces: [],
        schedule: { type: "interval", minutes: 60 },
        status: "active",
        created_at: at,
        updated_at: at,
        next_run_at: null,
        model: { provider: "custom", id: "reasoner" },
        current_run: {
          id: "current-run",
          task_id: "running-task",
          status: "running",
          scheduled_at: at,
          started_at: at,
          error: null,
        },
      },
    ];
    const fixture = await mount(initial);
    expect(
      fixture.input("Custom model IDs").closest<HTMLFieldSetElement>("fieldset")
        ?.disabled,
    ).toBe(true);
    const heading = fixture.container.querySelector(
      ".assistant-settings-heading h3",
    )!;
    expect(heading.textContent).toBe("Edit custom models");
    expect(document.activeElement).toBe(heading);
    expect(fixture.button("Save custom models").disabled).toBe(true);
    expect(fixture.button("Cancel custom model changes").disabled).toBe(false);
    expect(fixture.call).not.toHaveBeenCalled();
  });

  test("pending provider login stays usable while settings controls are locked", async () => {
    const initial = snapshot();
    initial.providers.push({
      id: "new-provider",
      label: "New provider",
      methods: ["oauth"],
      configured: false,
    });
    initial.auth = {
      id: "pending-login",
      provider: "custom",
      status: "waiting",
      message: "Enter the provider API key.",
      prompt: { id: "api-key", type: "secret", message: "API key" },
    };
    const fixture = await mount(initial, false);
    const login = fixture.container.querySelector<HTMLElement>(
      '[aria-label="Model login"]',
    )!;
    expect(login).not.toBeNull();
    expect(login.closest("fieldset[disabled]")).toBeNull();
    expect(login.querySelector<HTMLInputElement>("input")?.disabled).toBe(
      false,
    );
    expect(fixture.button("Cancel login").disabled).toBe(false);
    for (const label of ["Ranger connection", "Model provider", "Ranger model"])
      expect(
        fixture.button(label).closest<HTMLFieldSetElement>("fieldset")
          ?.disabled,
      ).toBe(true);
    expect(fixture.button("Edit custom models").disabled).toBe(true);
    expect(fixture.button("Add custom models").disabled).toBe(true);
    expect(fixture.button("Save settings").disabled).toBe(true);
    expect(fixture.clientState.snapshot!.auth?.id).toBe("pending-login");
    expect(fixture.call).not.toHaveBeenCalled();
    await act(async () => fixture.button("Ranger settings").click());
    await act(async () => fixture.button("Ranger settings").click());
    expect(
      fixture.container.querySelector('[aria-label="Model login"]'),
    ).not.toBeNull();
  });

  test("opening and leaving the custom model editor preserves unsaved model defaults", async () => {
    const fixture = await mount(snapshot(), false);
    await fixture.select("Ranger model", "plain");
    const calls = fixture.call.mock.calls.length;
    await act(async () => fixture.button("Add custom models").click());
    await fixture.overview();
    expect(fixture.button("Ranger model").textContent).toContain("Plain");
    expect(document.activeElement).toBe(fixture.button("Add custom models"));
    expect(fixture.clientState.snapshot!.config.model).toBe("reasoner");
    expect(fixture.call.mock.calls.length).toBe(calls);
  });

  test("cancel and Escape discard custom edits and restore the overview trigger", async () => {
    const fixture = await mount();
    await fixture.fill("Custom model IDs", "unsaved-id");
    await fixture.fill("Custom API key", "unsaved-key");
    await fixture.toggle("max");
    expect(
      fixture.container.querySelector('[aria-label="Save settings"]'),
    ).toBeNull();
    expect(
      Array.from(fixture.container.querySelectorAll("button")).some(
        (item) => item.textContent?.trim() === "Save settings",
      ),
    ).toBe(false);
    const calls = fixture.call.mock.calls.length;
    await act(async () =>
      fixture.button("Cancel custom model changes").click(),
    );
    expect(fixture.call.mock.calls.length).toBe(calls);
    expect(
      fixture.container.querySelector(".assistant-custom-model"),
    ).toBeNull();
    expect(document.activeElement).toBe(fixture.button("Edit custom models"));
    await fixture.custom();
    expect(fixture.input("Custom model IDs").value).toBe("reasoner");
    expect(fixture.input("Custom API key").value).toBe("");
    expect(fixture.selectedLevels()).toEqual(["off", "medium", "xhigh"]);
    await fixture.fill("Custom model IDs", "discard-on-escape");
    await act(async () =>
      fixture.input("Custom model IDs").dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(
      fixture.container.querySelector(".assistant-custom-model"),
    ).toBeNull();
    expect(document.activeElement).toBe(fixture.button("Edit custom models"));
    await fixture.custom();
    expect(fixture.input("Custom model IDs").value).toBe("reasoner");
    expect(fixture.call.mock.calls.length).toBe(calls);
  });
}
