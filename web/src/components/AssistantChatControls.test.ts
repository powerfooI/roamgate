import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { AssistantSnapshot } from "../../../shared/assistant";

// Radix/cmdk must load after DOM globals, without the hook spies in other tests.
if (process.env.ROAMGATE_CHAT_CONTROLS_DOM_TEST !== "1") {
  test("Ranger quick settings in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CHAT_CONTROLS_DOM_TEST: "1" },
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

function snapshot(): AssistantSnapshot {
  return {
    chat_selection: true,
    instance_id: "bridge-one",
    revision: 1,
    config: {
      provider: "alpha",
      model: "shared-model",
      credential_source: "assistant",
      allowed_workspaces: [],
    },
    providers: [
      {
        id: "alpha",
        label: "Alpha Cloud",
        methods: ["api_key"],
        configured: true,
      },
      {
        id: "beta",
        label: "Beta Cloud",
        methods: ["api_key"],
        configured: true,
      },
      { id: "offline", label: "Offline Cloud", methods: [], configured: false },
    ],
    models: [
      {
        provider: "alpha",
        id: "shared-model",
        label: "Shared Model",
        thinking_levels: ["low", "medium", "high"],
        default_thinking_level: "medium",
      },
      {
        provider: "beta",
        id: "shared-model",
        label: "Shared Model",
        thinking_levels: ["low", "high", "max"],
        default_thinking_level: "low",
      },
      { provider: "alpha", id: "basic", label: "Basic Model" },
      { provider: "offline", id: "hidden", label: "Unavailable Model" },
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
  const { act, createElement, Fragment } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { AssistantChatControls } = await import("./AssistantChatControls");
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    expect(document.querySelector(".themed-select-content") === null).toBe(
      true,
    );
  });
  afterAll(async () => browser.happyDOM.close());

  async function mount(initial = snapshot(), mobile = false) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const changes: Record<string, unknown>[] = [];
    let selectedCloses = 0;
    let unmounted = false;
    const render = async (next = initial, disabled = false, show = true) => {
      await act(async () =>
        root.render(
          createElement(
            Fragment,
            null,
            createElement("textarea", {
              "aria-label": "Message",
              defaultValue: "Draft remains here",
            }),
            show
              ? createElement(AssistantChatControls, {
                  key: `${next.instance_id}:${next.session_id ?? ""}`,
                  snapshot: next,
                  mobile,
                  disabled,
                  onChange: (params) => changes.push(params),
                  onSelectedClose: () => {
                    selectedCloses += 1;
                    container
                      .querySelector("textarea")
                      ?.focus({ preventScroll: true });
                  },
                })
              : null,
          ),
        ),
      );
    };
    const unmount = async () => {
      if (unmounted) return;
      unmounted = true;
      await act(async () => root.unmount());
      container.remove();
      await browser.happyDOM.whenAsyncComplete();
    };
    cleanups.push(unmount);
    await render();
    const button = (label: string) => {
      const found = container.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
      );
      if (!found) throw new Error(`Missing ${label} button`);
      return found;
    };
    return {
      container,
      changes,
      render,
      button,
      unmount,
      selectedCloses: () => selectedCloses,
    };
  }
  const click = async (node: HTMLElement) => {
    await act(async () => node.click());
  };
  const items = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[cmdk-item]"));
  const option = (value: string) => {
    const found = items().find((item) => item.dataset.value === value);
    if (!found) throw new Error(`Missing option ${value}`);
    return found;
  };
  const selectModel = async (
    fixture: Awaited<ReturnType<typeof mount>>,
    provider: string,
    id: string,
  ) => {
    await click(fixture.button("Chat model"));
    await click(option(JSON.stringify([provider, id])));
    await act(async () => browser.happyDOM.whenAsyncComplete());
  };
  const selectEffort = async (
    fixture: Awaited<ReturnType<typeof mount>>,
    effort: string,
  ) => {
    await click(fixture.button("Thinking effort"));
    await click(option(effort));
    await act(async () => browser.happyDOM.whenAsyncComplete());
  };
  const search = async (value: string) => {
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search models"]',
    )!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
  };

  test("provider-qualified duplicate models dispatch a guarded change and wait for the server snapshot", async () => {
    const initial = snapshot();
    const fixture = await mount(initial);
    expect(fixture.button("Thinking effort").textContent).toContain(
      "Default (Medium)",
    );
    await click(fixture.button("Chat model"));
    const duplicates = items().filter((item) =>
      item.textContent?.includes("Shared Model"),
    );
    expect(duplicates).toHaveLength(2);
    expect(duplicates.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Alpha Cloud"),
      expect.stringContaining("Beta Cloud"),
    ]);
    expect(
      items().some((item) => item.textContent?.includes("Unavailable Model")),
    ).toBe(false);
    await click(option(JSON.stringify(["beta", "shared-model"])));
    expect(fixture.changes).toEqual([
      {
        provider: "beta",
        model: "shared-model",
        thinking_level: null,
        expected: {
          instance_id: "bridge-one",
          provider: "alpha",
          model: "shared-model",
          credential_source: "assistant",
        },
      },
    ]);
    expect(fixture.button("Chat model").title).toContain("alpha");
    expect(fixture.button("Thinking effort").textContent).toContain(
      "Default (Medium)",
    );
    const confirmed = {
      ...initial,
      revision: 2,
      config: { ...initial.config, provider: "beta" },
    };
    await fixture.render(confirmed);
    expect(fixture.button("Chat model").title).toContain("beta");
    expect(fixture.button("Thinking effort").textContent).toContain(
      "Default (Low)",
    );
    await selectModel(fixture, "beta", "shared-model");
    expect(fixture.changes).toHaveLength(1);
  });

  test("explicit effort and Default send exact guarded values without optimistic labels", async () => {
    const initial = snapshot();
    const fixture = await mount(initial);
    await selectEffort(fixture, "high");
    expect(fixture.changes[0]).toEqual({
      provider: "alpha",
      model: "shared-model",
      thinking_level: "high",
      expected: {
        instance_id: "bridge-one",
        provider: "alpha",
        model: "shared-model",
        credential_source: "assistant",
      },
    });
    expect(fixture.button("Thinking effort").textContent).toContain(
      "Default (Medium)",
    );
    const confirmed: AssistantSnapshot = {
      ...initial,
      revision: 2,
      config: { ...initial.config, thinking_level: "high" },
    };
    await fixture.render(confirmed);
    expect(fixture.button("Thinking effort").textContent).toContain("High");
    await selectEffort(fixture, "high");
    expect(fixture.changes).toHaveLength(1);
    await selectEffort(fixture, "default");
    expect(fixture.changes[1]).toEqual({
      provider: "alpha",
      model: "shared-model",
      thinking_level: null,
      expected: {
        instance_id: "bridge-one",
        provider: "alpha",
        model: "shared-model",
        credential_source: "assistant",
        thinking_level: "high",
      },
    });
    expect(fixture.button("Thinking effort").textContent).toContain("High");
  });

  test("model switching preserves a supported explicit effort and resets unsupported effort", async () => {
    const initial = snapshot();
    initial.config.thinking_level = "high";
    const fixture = await mount(initial);
    await selectModel(fixture, "beta", "shared-model");
    expect(fixture.changes[0]?.thinking_level).toBe("high");
    expect(fixture.changes[0]?.expected).toEqual({
      instance_id: "bridge-one",
      provider: "alpha",
      model: "shared-model",
      credential_source: "assistant",
      thinking_level: "high",
    });
    await selectModel(fixture, "alpha", "basic");
    expect(fixture.changes[1]?.thinking_level).toBeNull();
    const confirmed = {
      ...initial,
      config: { ...initial.config, model: "basic", thinking_level: undefined },
    };
    await fixture.render(confirmed);
    expect(fixture.button("Thinking effort").disabled).toBe(true);
    expect(fixture.button("Thinking effort").title).toContain(
      "no adjustable thinking",
    );
  });

  test("a stale saved effort can reset to Default when the refreshed model only supports Off", async () => {
    const initial = snapshot();
    initial.config.thinking_level = "high";
    initial.models[0] = {
      provider: "alpha",
      id: "shared-model",
      label: "Shared Model",
      thinking_levels: ["off"],
      default_thinking_level: "off",
    };
    const fixture = await mount(initial);
    expect(fixture.button("Thinking effort").disabled).toBe(false);
    expect(fixture.button("Thinking effort").textContent).toContain(
      "Unavailable (High)",
    );
    await click(fixture.button("Thinking effort"));
    expect(items().map((item) => item.dataset.value)).toEqual([
      "default",
      "off",
    ]);
    await click(option("default"));
    expect(fixture.changes).toEqual([
      {
        provider: "alpha",
        model: "shared-model",
        thinking_level: null,
        expected: {
          instance_id: "bridge-one",
          provider: "alpha",
          model: "shared-model",
          credential_source: "assistant",
          thinking_level: "high",
        },
      },
    ]);
    await fixture.render({
      ...initial,
      revision: 2,
      config: { ...initial.config, thinking_level: undefined },
    });
    expect(fixture.button("Thinking effort").disabled).toBe(true);
    expect(fixture.button("Thinking effort").textContent).toContain("Off");
  });

  test("search resolves long custom IDs and provider names, including an empty result", async () => {
    const initial = snapshot();
    const id = `custom/vendor:model-${"context-".repeat(25)}latest`;
    initial.models.push({ provider: "beta", id, label: "Custom Reasoner" });
    const fixture = await mount(initial, true);
    await click(fixture.button("Chat model"));
    expect(
      document.querySelector(".assistant-chat-select.is-mobile") !== null,
    ).toBe(true);
    await search("nothing matches this model");
    expect(items()).toHaveLength(0);
    expect(document.querySelector("[cmdk-empty]")?.textContent).toBe(
      "No models found",
    );
    await search("Beta Cloud");
    expect(items()).toHaveLength(2);
    expect(
      items().every((item) => item.textContent?.includes("Beta Cloud")),
    ).toBe(true);
    await search(id);
    expect(items()).toHaveLength(1);
    expect(items()[0]?.textContent).toContain("Custom Reasoner");
    await click(option(JSON.stringify(["beta", id])));
    expect(fixture.changes[0]?.model).toBe(id);
    expect(fixture.changes[0]?.provider).toBe("beta");
  });

  test("streaming allows next-message changes and preserves the composer node, draft, selection and focus", async () => {
    const initial = snapshot();
    initial.running = true;
    const fixture = await mount(initial);
    const textarea = fixture.container.querySelector("textarea")!;
    textarea.focus();
    textarea.setSelectionRange(3, 8, "backward");
    expect(
      fixture.container.querySelector('[role="status"]')?.textContent,
    ).toBe("Next message");
    expect(fixture.button("Chat model").disabled).toBe(false);
    expect(fixture.button("Thinking effort").disabled).toBe(false);
    await selectEffort(fixture, "high");
    expect(fixture.changes).toHaveLength(1);
    expect(fixture.selectedCloses()).toBe(1);
    expect(document.activeElement === textarea).toBe(true);
    await fixture.render({
      ...initial,
      revision: 2,
      config: { ...initial.config, thinking_level: "high" },
    });
    expect(fixture.container.querySelector("textarea") === textarea).toBe(true);
    expect(textarea.value).toBe("Draft remains here");
    expect([
      textarea.selectionStart,
      textarea.selectionEnd,
      textarea.selectionDirection,
    ]).toEqual([3, 8, "backward"]);
    expect(document.activeElement === textarea).toBe(true);
  });

  test("disabled connection or in-flight states close menus and require a fresh open after recovery", async () => {
    const initial = snapshot();
    const fixture = await mount(initial);
    for (const label of ["Chat model", "Thinking effort"]) {
      await click(fixture.button(label));
      expect(document.querySelector(".themed-select-content") !== null).toBe(
        true,
      );
      await fixture.render(initial, true);
      expect(document.querySelector(".themed-select-content") === null).toBe(
        true,
      );
      expect(fixture.button(label).disabled).toBe(true);
      await click(fixture.button(label));
      expect(fixture.changes).toHaveLength(0);
      await fixture.render(initial, false);
      expect(document.querySelector(".themed-select-content") === null).toBe(
        true,
      );
    }
    expect(fixture.selectedCloses()).toBe(0);
    await selectEffort(fixture, "high");
    const failed = { ...initial, error: "Provider rejected this selection" };
    await fixture.render(failed);
    expect(fixture.button("Thinking effort").textContent).toContain(
      "Default (Medium)",
    );
    expect(fixture.button("Thinking effort").disabled).toBe(false);
    await selectEffort(fixture, "high");
    expect(fixture.changes).toHaveLength(2);
  });

  test("older snapshots, empty catalogs and missing current models have safe disabled controls", async () => {
    const initial = snapshot();
    const fixture = await mount({ ...initial, chat_selection: undefined });
    expect(fixture.button("Chat model").disabled).toBe(true);
    expect(fixture.button("Thinking effort").disabled).toBe(true);
    await fixture.render({ ...initial, models: [] });
    expect(fixture.button("Chat model").disabled).toBe(true);
    expect(fixture.button("Thinking effort").disabled).toBe(true);
    expect(fixture.button("Chat model").title).toBe(
      "Connect a provider in Ranger settings",
    );
    await fixture.render({
      ...initial,
      config: { ...initial.config, model: "retired-model" },
    });
    expect(fixture.button("Chat model").textContent).toContain(
      "retired-model (unavailable)",
    );
    expect(fixture.button("Chat model").disabled).toBe(false);
    expect(fixture.button("Thinking effort").disabled).toBe(true);
    await selectModel(fixture, "alpha", "shared-model");
    expect(fixture.changes[0]?.expected).toEqual({
      instance_id: "bridge-one",
      provider: "alpha",
      model: "retired-model",
      credential_source: "assistant",
    });
  });

  test("navigation and server replacement remove portal menus without leaking selection callbacks", async () => {
    const initial = snapshot();
    const fixture = await mount(initial);
    await click(fixture.button("Chat model"));
    await act(async () => window.dispatchEvent(new Event("popstate")));
    expect(document.querySelector(".themed-select-content") === null).toBe(
      true,
    );
    await click(fixture.button("Thinking effort"));
    await fixture.render({ ...initial, instance_id: "bridge-two" });
    expect(document.querySelector(".themed-select-content") === null).toBe(
      true,
    );
    await click(fixture.button("Chat model"));
    await fixture.render(initial, false, false);
    expect(document.querySelector(".themed-select-content") === null).toBe(
      true,
    );
    await fixture.render(initial);
    await click(fixture.button("Thinking effort"));
    await fixture.unmount();
    await act(async () => window.dispatchEvent(new Event("popstate")));
    expect(document.querySelector(".themed-select-content") === null).toBe(
      true,
    );
    expect(fixture.selectedCloses()).toBe(0);
    expect(fixture.changes).toHaveLength(0);
  });
}
