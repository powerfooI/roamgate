import "./styles/tokens.css";
import "./styles/base.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { bridge, type HerdrEventMsg } from "./api";
import { ConfigMenu } from "./components/ConfigMenu";
import type { AgentIntegration } from "./components/AgentIntegrationsSettings";
import { GlobalTooltip } from "./components/GlobalTooltip";
import { __storeTesting, store } from "./store";

const failures: string[] = [];
const check = (condition: boolean, message: string) => {
  if (!condition) failures.push(message);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 80 && !predicate(); i++) await settle();
  if (!predicate()) throw new Error("Timed out waiting for configuration");
};
const button = (label: string) => {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (element) =>
      element.getClientRects().length &&
      (element.getAttribute("aria-label") === label ||
        document.getElementById(element.getAttribute("aria-labelledby") ?? "")
          ?.textContent === label ||
        element.textContent === label ||
        element.querySelector("strong")?.textContent === label),
  );
  if (!found) throw new Error(`Missing visible button: ${label}`);
  return found;
};
const click = (label: string) => {
  const element = button(label);
  element.focus();
  flushSync(() => element.click());
};
Object.assign(window, { configurationTest: { click } });
const fetchResult = window.fetch.bind(window);
const input = async (method: string, params: Record<string, unknown>) => {
  const response = await fetchResult("/input", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  if (!response.ok) throw new Error("Trusted browser input failed");
};
const key = async (element: Element, value: string, shiftKey = false) => {
  (element as HTMLElement).focus();
  const codes: Record<string, number> = {
    Tab: 9,
    Enter: 13,
    Escape: 27,
    ArrowRight: 39,
  };
  for (const type of ["keyDown", "keyUp"])
    await input("Input.dispatchKeyEvent", {
      type,
      key: value,
      windowsVirtualKeyCode: codes[value],
      text: type === "keyDown" && value === "Enter" ? "\r" : undefined,
      modifiers: shiftKey ? 8 : 0,
    });
  await settle();
};
Object.defineProperty(window, "fetch", {
  configurable: true,
  value: async () => Response.json({ version: "0.9.1", protocol: 22 }),
});
let active = "alpha";
let generation = 1;
const settings: Record<string, boolean> = { alpha: true, beta: false };
const listeners = new Set<(event: HerdrEventMsg) => void>();
const calls: Array<{ id: string; method: string; params: any }> = [];
let pendingRead: Promise<{ surface_codecs: boolean }> | null = null;
let failSave = false;
let failRead = false;
const integrations: Record<string, AgentIntegration[]> = Object.fromEntries(
  ["alpha", "beta"].map((id) => [
    id,
    [
      {
        target: "antigravity_cli",
        label: "Antigravity CLI",
        command: "agy",
        available: true,
        state: "not_installed",
      },
      {
        target: "pi",
        label: "Pi",
        command: "pi",
        available: true,
        state: "outdated",
        installed_version: 7,
        available_version: 9,
      },
      {
        target: "claude",
        label: "Claude Code",
        command: "claude",
        available: false,
        state: "current",
      },
      {
        target: "future_agent",
        label: "Future Agent",
        command: "future",
        available: false,
        state: "not_installed",
      },
    ],
  ]),
);
let integrationRead: Promise<unknown> | null = null;
let integrationChange: Promise<unknown> | null = null;
let integrationLoadFailure = false;
let integrationSaveFailure = false;
let malformedIntegrations = false;
let confirmChange = true;
const confirmations: string[] = [];
window.confirm = (message) => {
  confirmations.push(String(message));
  return confirmChange;
};
bridge.onEvent = (listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
bridge.connection = (id) => {
  const connectionId = id ?? active;
  const lease = generation;
  return {
    connectionId,
    generation: lease,
    serverRuntimeGeneration: lease,
    isCurrent: () => active === connectionId && lease === generation,
    acceptsServerGeneration: (value) => value === lease,
    call: async (method, params) => {
      calls.push({ id: connectionId, method, params });
      if (method === "settings.terminal_transport.get") {
        if (failRead) throw new Error("Load failed");
        return pendingRead ?? { surface_codecs: settings[connectionId] };
      }
      if (method === "settings.terminal_transport.update") {
        if (failSave) throw new Error("Save failed");
        settings[connectionId] = params!.surface_codecs as boolean;
        return { surface_codecs: settings[connectionId] };
      }
      if (method === "integration.list") {
        if (integrationLoadFailure)
          throw new Error("unknown method: integration.list");
        if (malformedIntegrations)
          return { integrations: [{ state: "surprise" }] };
        return (
          integrationRead ?? {
            type: "integration_list",
            integrations: structuredClone(integrations[connectionId]),
          }
        );
      }
      if (
        method === "integration.install" ||
        method === "integration.uninstall"
      ) {
        if (integrationSaveFailure)
          throw new Error("Configuration is not writable");
        if (integrationChange) return integrationChange;
        const item = integrations[connectionId].find(
          (item) => item.target === params?.target,
        )!;
        item.state =
          method === "integration.install" ? "current" : "not_installed";
        if (method === "integration.install") {
          if (item.available_version !== undefined)
            item.installed_version = item.available_version;
        } else {
          delete item.installed_version;
        }
        return {
          type: method.replace(".", "_"),
          target: item.target,
          details: { messages: [`Updated ${item.label} configuration`] },
        };
      }
      if (method === "settings.workspace_auto_sync.list")
        return { configs: [] };
      return {};
    },
  };
};
function Harness() {
  const [theme, setTheme] = useState<"light" | "dark" | "system">("dark");
  const [scale, setScale] = useState(100);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.zoom = String(scale / 100);
  document.documentElement.style.setProperty("--ui-scale", String(scale / 100));
  return (
    <ConfigMenu
      theme={theme}
      accentColor="blue"
      uiScale={scale}
      zenMode={false}
      mobileTerminalShortcuts={[[], []]}
      mobileTerminalSideShortcuts={[]}
      terminalThemeSelection={{ dark: "default", light: "default" }}
      customTerminalThemes={[]}
      onThemeChange={setTheme}
      onAccentColorChange={() => {}}
      onUiScaleChange={setScale}
      onZenModeChange={() => {}}
      onMobileTerminalShortcutsChange={() => {}}
      onMobileTerminalSideShortcutsChange={() => {}}
      onTerminalThemeSelectionChange={() => {}}
      onCustomTerminalThemesChange={() => {}}
    />
  );
}
let render = () => {};
const selectConnection = (id: string) => {
  active = id;
  generation++;
  flushSync(() =>
    __storeTesting.replaceState({
      ...store.get(),
      activeConnectionId: id,
      connectionGeneration: generation,
    }),
  );
  flushSync(render);
};
async function run() {
  document.documentElement.dataset.layout =
    innerWidth <= 600 ? "mobile" : "desktop";
  __storeTesting.replaceState({
    ...store.get(),
    activeConnectionId: active,
    connectionGeneration: generation,
    status: "connected",
    connections: [
      {
        id: "alpha",
        label: "Local test",
        source: "local",
        is_default: true,
        state: "ready",
        generation: 1,
      },
      {
        id: "beta",
        label: "Remote test",
        source: "ssh",
        ssh_destination: "user@example.test",
        is_default: false,
        state: "ready",
        generation: 1,
      },
    ],
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  render = () =>
    root.render(
      <>
        <Harness />
        <GlobalTooltip />
      </>,
    );
  flushSync(render);
  click("Menu");
  check(
    !document.querySelector(
      "#roamgate-config-menu [aria-label='Task notifications']",
    ),
    "preferences still live in Menu",
  );
  click("Configuration");
  // Lazy mounting exposes the DOM before the dialog's focus effect runs.
  // Wait for focus before dispatching keys, or that effect can steal it back.
  await waitFor(
    () =>
      !!document
        .querySelector(".configuration-modal")
        ?.contains(document.activeElement),
  );
  let dialog = document.querySelector<HTMLElement>(".configuration-modal")!;
  check(
    dialog.contains(document.activeElement),
    "Configuration did not receive focus",
  );
  button("Appearance").focus();
  await key(button("Appearance"), "ArrowRight");
  check(
    button("Behavior").getAttribute("aria-selected") === "true",
    "arrow key did not select Behavior",
  );
  check(
    document.activeElement === button("Behavior"),
    "tab keyboard navigation lost focus",
  );
  click("Appearance");
  for (const theme of ["dark", "light"]) {
    click(`Use ${theme} theme`);
    for (const tab of document.querySelectorAll<HTMLElement>(
      ".configuration-tabs [aria-selected='false']",
    )) {
      const style = getComputedStyle(tab);
      check(
        parseFloat(style.borderTopWidth) > 0 &&
          style.borderTopStyle !== "none" &&
          style.borderTopColor !== "transparent" &&
          style.borderTopColor !== "rgba(0, 0, 0, 0)",
        `${theme}: inactive tab has no visible border`,
      );
    }
  }
  check(
    document.documentElement.dataset.theme === "light",
    "theme preference stopped working",
  );
  for (let i = 0; i < (innerWidth <= 320 ? 10 : 5); i++)
    click("Increase text size");
  await settle();
  const rect = dialog.getBoundingClientRect();
  check(
    rect.left >= 0 &&
      rect.right <= innerWidth + 1 &&
      rect.bottom <= innerHeight + 1 &&
      rect.top >= 0,
    "scaled configuration exceeds viewport",
  );
  check(
    dialog.scrollWidth <= dialog.clientWidth + 1,
    "configuration overflows horizontally",
  );
  button("Done").focus();
  await key(button("Done"), "Tab");
  check(
    document.activeElement === button("Close Configuration"),
    "Tab escaped Configuration",
  );
  await key(button("Close Configuration"), "Tab", true);
  check(
    document.activeElement === button("Done"),
    "Shift+Tab escaped Configuration",
  );
  click("Layout");
  await waitFor(
    () => !!document.querySelector("[aria-label='Layout Preferences']"),
  );
  check(
    dialog.getClientRects().length === 0,
    "parent dialog remains visible behind nested settings",
  );
  await key(document.activeElement!, "Escape");
  await waitFor(() => dialog.getClientRects().length > 0);
  check(
    document.activeElement === button("Layout"),
    "returning from Layout lost the trigger focus",
  );
  click("Connection");
  await waitFor(
    () =>
      button("Terminal incremental transport").getAttribute("aria-disabled") ===
      "false",
  );
  check(
    button("Terminal incremental transport").getAttribute("aria-checked") ===
      "true",
    "default codec preference missing",
  );
  check(
    document.getElementById("terminal-transport-description")!.getClientRects()
      .length === 0,
    "transport description takes up dialog space",
  );
  const help = button("About terminal incremental transport");
  const helpBounds = help.getBoundingClientRect();
  await input("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: helpBounds.left + helpBounds.width / 2,
    y: helpBounds.top + helpBounds.height / 2,
  });
  await waitFor(() => !!document.querySelector("[role='tooltip']"));
  check(
    document
      .querySelector("[role='tooltip']")!
      .textContent!.includes("shared by all viewers"),
    "hover tooltip lost the shared-setting warning",
  );
  const checkTooltipBounds = () => {
    const bounds = document
      .querySelector<HTMLElement>("[role='tooltip']")!
      .getBoundingClientRect();
    check(
      bounds.left >= 0 &&
        bounds.right <= innerWidth &&
        bounds.top >= 0 &&
        bounds.bottom <= innerHeight,
      "tooltip exceeds the true scaled viewport",
    );
  };
  checkTooltipBounds();
  await input("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
  await waitFor(() => !document.querySelector("[role='tooltip']"));
  await key(button("Terminal incremental transport"), "Tab", true);
  check(
    document.activeElement === help,
    "keyboard cannot reach transport help",
  );
  await waitFor(() => !!document.querySelector("[role='tooltip']"));
  checkTooltipBounds();
  click("About terminal incremental transport");
  await waitFor(() => !!document.querySelector(".configuration-help-content"));
  await settle();
  const helpContent = document.querySelector<HTMLElement>(
    ".configuration-help-content",
  )!;
  const helpRect = helpContent.getBoundingClientRect();
  check(
    helpRect.left >= 0 &&
      helpRect.right <= innerWidth + 1 &&
      helpRect.top >= 0 &&
      helpRect.bottom <= innerHeight + 1,
    "help popover exceeds the scaled viewport",
  );
  check(
    helpContent.contains(
      document.elementFromPoint(
        helpRect.left + helpRect.width / 2,
        helpRect.top + helpRect.height / 2,
      ),
    ),
    "help popover is hidden behind Configuration",
  );
  await key(helpContent, "Escape");
  await waitFor(() => !document.querySelector(".configuration-help-content"));
  await settle();
  check(
    dialog.isConnected && document.activeElement === help,
    "closing help closed Configuration or lost focus",
  );
  click("Terminal incremental transport");
  await waitFor(
    () =>
      button("Terminal incremental transport").getAttribute("aria-checked") ===
      "false",
  );
  check(
    settings.alpha === false && calls[calls.length - 1]?.id === "alpha",
    "setting was not saved for the selected connection",
  );
  check(
    dialog.contains(document.activeElement),
    "saving moved focus out of Configuration",
  );
  click("Done");
  await settle();
  check(
    document.activeElement === button("Menu"),
    "closing Configuration did not restore Menu focus",
  );
  click("Menu");
  click("Configuration");
  await waitFor(() => !!document.querySelector(".configuration-modal"));
  dialog = document.querySelector<HTMLElement>(".configuration-modal")!;
  click("Connection");
  await waitFor(
    () =>
      button("Terminal incremental transport").getAttribute("aria-disabled") ===
      "false",
  );
  check(
    button("Terminal incremental transport").getAttribute("aria-checked") ===
      "false",
    "reopening discarded the saved preference",
  );
  failSave = true;
  click("Terminal incremental transport");
  await waitFor(() => !!document.querySelector("[role='alert']"));
  check(
    settings.alpha === false &&
      button("Terminal incremental transport").getAttribute("aria-checked") ===
        "false",
    "failed save silently changed the preference",
  );
  failSave = false;
  const retryStart = calls.length;
  click("Retry");
  await waitFor(
    () =>
      button("Terminal incremental transport").getAttribute("aria-checked") ===
      "true",
  );
  check(
    calls
      .slice(retryStart)
      .some(
        (call) =>
          call.method === "settings.terminal_transport.update" &&
          call.params?.surface_codecs === true,
      ),
    "Retry did not resubmit the failed save value",
  );
  settings.alpha = false;
  for (const listener of listeners)
    listener({
      event: "settings.terminal_transport.updated",
      connection_id: "alpha",
      connection_generation: generation,
      data: { surface_codecs: false },
    });
  await waitFor(
    () =>
      button("Terminal incremental transport").getAttribute("aria-checked") ===
      "false",
  );
  check(
    !document.querySelector("[role='alert']"),
    "successful save left a stale error",
  );
  const updatesBeforeLoadFailure = calls.filter(
    (call) => call.method === "settings.terminal_transport.update",
  ).length;
  click("Appearance");
  failRead = true;
  click("Connection");
  await waitFor(() => !!document.querySelector("[role='alert']"));
  failRead = false;
  click("Retry");
  await waitFor(
    () =>
      button("Terminal incremental transport").getAttribute("aria-disabled") ===
      "false",
  );
  check(
    calls.filter((call) => call.method === "settings.terminal_transport.update")
      .length === updatesBeforeLoadFailure,
    "load Retry unexpectedly wrote settings",
  );
  let resolveRead!: (value: { surface_codecs: boolean }) => void;
  pendingRead = new Promise((resolve) => {
    resolveRead = resolve;
  });
  click("Appearance");
  click("Connection");
  await settle();
  check(
    button("Terminal incremental transport").getAttribute("aria-disabled") ===
      "true",
    "unknown setting is interactive",
  );
  pendingRead = null;
  selectConnection("beta");
  await waitFor(
    () =>
      button("Terminal incremental transport").getAttribute("aria-disabled") ===
      "false",
  );
  resolveRead({ surface_codecs: true });
  await settle();
  check(
    button("Terminal incremental transport").getAttribute("aria-checked") ===
      "false",
    "late response crossed the connection boundary",
  );
  click("Terminal incremental transport");
  await waitFor(
    () =>
      button("Terminal incremental transport").getAttribute("aria-checked") ===
      "true",
  );
  check(
    settings.beta === true && settings.alpha === false,
    "update crossed the connection boundary",
  );
  check(
    !calls.some((call) => call.method.startsWith("integration.")),
    "integrations were fetched before opening their tab",
  );
  click("Integrations");
  await waitFor(
    () => document.querySelectorAll(".agent-integrations-list li").length === 4,
  );
  check(
    document
      .querySelector(".agent-integrations-settings")!
      .textContent!.includes("user@example.test"),
    "integration scope omitted the SSH destination",
  );
  check(
    dialog.scrollWidth <= dialog.clientWidth + 1,
    "integrations overflow the scaled viewport",
  );
  const mutationCount = () =>
    calls.filter(
      (call) =>
        call.method === "integration.install" ||
        call.method === "integration.uninstall",
    ).length;
  const beforeCancel = mutationCount();
  const firstIntegration = document.querySelector(
    ".agent-integrations-list li",
  )!;
  check(
    firstIntegration.textContent!.includes("Pi") &&
      firstIntegration.textContent!.includes("v7") &&
      firstIntegration.textContent!.includes("v9"),
    "upgrade row is not prioritized or is missing installed/available versions",
  );
  check(
    document
      .querySelector(".agent-integrations-settings")!
      .textContent!.includes("Version unavailable"),
    "missing version metadata was fabricated",
  );
  const otherAgents = document.querySelector<HTMLDetailsElement>(
    ".agent-integrations-unavailable",
  )!;
  check(!otherAgents.open, "undetected agents are not collapsed by default");
  await key(otherAgents.querySelector("summary")!, "Enter");
  check(otherAgents.open, "other agents cannot be expanded with the keyboard");
  click("Install Future Agent integration");
  check(mutationCount() === beforeCancel, "missing agent was installable");
  confirmChange = false;
  click("Install Antigravity CLI integration");
  click("Uninstall Claude Code integration");
  check(
    mutationCount() === beforeCancel,
    "cancelled integration change was submitted",
  );
  check(
    confirmations[confirmations.length - 1].includes(
      "Remote test (user@example.test)",
    ) &&
      confirmations[confirmations.length - 1].includes(
        "server user's agent configuration",
      ),
    "confirmation omitted the target and shared configuration warning",
  );
  confirmChange = true;
  click("Install Antigravity CLI integration");
  await waitFor(
    () =>
      !!document.querySelector(
        '[aria-label="Uninstall Antigravity CLI integration"]',
      ),
  );
  check(
    calls.some(
      (call) =>
        call.id === "beta" &&
        call.method === "integration.install" &&
        call.params.target === "antigravity_cli",
    ),
    "install did not preserve the server target or selected connection",
  );
  await waitFor(
    () =>
      button("Refresh integrations").getAttribute("aria-disabled") === "false",
  );
  check(
    document
      .querySelector('[role="status"].agent-integrations-status')!
      .textContent!.includes("Updated Antigravity CLI configuration"),
    "installation messages were not shown",
  );
  click("Update Pi integration");
  await waitFor(
    () => !document.querySelector('[aria-label="Update Pi integration"]'),
  );
  const piRow = document
    .querySelector('[aria-label="Uninstall Pi integration"]')!
    .closest("li")!;
  check(
    piRow.textContent!.includes("v9") && !piRow.textContent!.includes("v7"),
    "successful update did not refresh the installed version",
  );
  await waitFor(
    () =>
      button("Refresh integrations").getAttribute("aria-disabled") === "false",
  );
  click("Uninstall Claude Code integration");
  await waitFor(
    () =>
      !!document.querySelector(
        '[aria-label="Install Claude Code integration"]',
      ),
  );
  check(
    integrations.beta.find((item) => item.target === "claude")!.state ===
      "not_installed",
    "uninstall failed when the agent executable was absent",
  );
  await waitFor(
    () =>
      button("Refresh integrations").getAttribute("aria-disabled") === "false",
  );
  integrationSaveFailure = true;
  click("Uninstall Pi integration");
  await waitFor(() => !!document.querySelector('[role="alert"]'));
  check(
    document
      .querySelector('[role="alert"]')!
      .textContent!.includes("Configuration is not writable"),
    "integration mutation error was hidden",
  );
  integrationSaveFailure = false;
  const failedMutationCount = mutationCount();
  click("Refresh integrations");
  await waitFor(
    () => document.querySelectorAll(".agent-integrations-list li").length === 4,
  );
  check(
    mutationCount() === failedMutationCount,
    "refresh repeated a failed mutation",
  );
  integrationLoadFailure = true;
  click("Refresh integrations");
  await waitFor(() => !!document.querySelector('[role="alert"]'));
  check(
    document.querySelectorAll(".agent-integrations-list li").length === 0 &&
      document
        .querySelector('[role="alert"]')!
        .textContent!.includes("update Herdr"),
    "unsupported server retained actionable stale integrations",
  );
  integrationLoadFailure = false;
  malformedIntegrations = true;
  click("Refresh integrations");
  await waitFor(
    () =>
      !!document
        .querySelector('[role="alert"]')
        ?.textContent?.includes("Invalid integration list"),
  );
  malformedIntegrations = false;
  click("Refresh integrations");
  await waitFor(
    () => document.querySelectorAll(".agent-integrations-list li").length === 4,
  );

  const integrationLists = (id = active) =>
    calls.filter((call) => call.id === id && call.method === "integration.list")
      .length;
  let resolveIntegrations!: (value: unknown) => void;
  integrationRead = new Promise((resolve) => {
    resolveIntegrations = resolve;
  });
  const betaListsBeforeRefresh = integrationLists("beta");
  click("Refresh integrations");
  await waitFor(() => integrationLists("beta") === betaListsBeforeRefresh + 1);
  integrationRead = null;
  selectConnection("alpha");
  await waitFor(
    () => document.querySelectorAll(".agent-integrations-list li").length === 4,
  );
  resolveIntegrations({
    integrations: [{ ...integrations.beta[0], label: "Stale integration" }],
  });
  await settle();
  check(
    !dialog.textContent!.includes("Stale integration"),
    "late integration list crossed connections",
  );

  const antigravity = integrations.alpha.find(
    (item) => item.target === "antigravity_cli",
  )!;
  const successfulChange = Promise.withResolvers<unknown>();
  integrationChange = successfulChange.promise;
  const beforeTabRemount = mutationCount();
  click("Install Antigravity CLI integration");
  const listsBeforeTabRemount = integrationLists();
  click("Appearance");
  click("Integrations");
  await settle();
  check(
    button("Refresh integrations").getAttribute("aria-disabled") === "true" &&
      integrationLists() === listsBeforeTabRemount,
    "tab remount read stale status instead of awaiting its in-flight mutation",
  );
  flushSync(() =>
    document
      .querySelector<HTMLButtonElement>(
        '[aria-label="Install Antigravity CLI integration"]',
      )
      ?.click(),
  );
  check(
    mutationCount() === beforeTabRemount + 1,
    "tab remount allowed a duplicate mutation",
  );
  integrationChange = null;
  antigravity.state = "current";
  successfulChange.resolve({
    target: antigravity.target,
    details: { messages: ["Install completed after tab remount"] },
  });
  await waitFor(
    () =>
      button("Refresh integrations").getAttribute("aria-disabled") === "false",
  );
  check(
    !!document.querySelector(
      '[aria-label="Uninstall Antigravity CLI integration"]',
    ) &&
      dialog.textContent!.includes("Install completed after tab remount") &&
      integrationLists() === listsBeforeTabRemount + 1,
    "replacement tab failed to receive the completed mutation and fresh status",
  );

  const failedChange = Promise.withResolvers<unknown>();
  integrationChange = failedChange.promise;
  const beforeDialogRemount = mutationCount();
  click("Uninstall Antigravity CLI integration");
  const listsBeforeDialogRemount = integrationLists();
  click("Done");
  await waitFor(() => !document.querySelector(".configuration-modal"));
  click("Menu");
  click("Configuration");
  await waitFor(() => !!document.querySelector(".configuration-modal"));
  dialog = document.querySelector<HTMLElement>(".configuration-modal")!;
  click("Integrations");
  await settle();
  check(
    button("Refresh integrations").getAttribute("aria-disabled") === "true" &&
      integrationLists() === listsBeforeDialogRemount,
    "reopened Configuration did not await its in-flight mutation",
  );
  flushSync(() =>
    document
      .querySelector<HTMLButtonElement>(
        '[aria-label="Uninstall Antigravity CLI integration"]',
      )
      ?.click(),
  );
  check(
    mutationCount() === beforeDialogRemount + 1,
    "dialog remount allowed a duplicate mutation",
  );
  integrationChange = null;
  failedChange.reject(new Error("Mutation failed after dialog remount"));
  await waitFor(
    () =>
      button("Refresh integrations").getAttribute("aria-disabled") === "false",
  );
  check(
    !!document.querySelector(
      '[aria-label="Uninstall Antigravity CLI integration"]',
    ) &&
      !!document
        .querySelector('[role="alert"]')
        ?.textContent?.includes("Mutation failed after dialog remount") &&
      integrationLists() === listsBeforeDialogRemount + 1,
    "reopened Configuration lost the failed mutation or did not reload status",
  );
  click("Refresh integrations");
  await waitFor(
    () =>
      button("Refresh integrations").getAttribute("aria-disabled") === "false",
  );
  check(
    mutationCount() === beforeDialogRemount + 1 &&
      !document.querySelector('[role="alert"]'),
    "refresh repeated the failed mutation or retained its error",
  );
  click("Uninstall Antigravity CLI integration");
  await waitFor(
    () =>
      button("Refresh integrations").getAttribute("aria-disabled") === "false",
  );
  check(
    integrations.alpha.find((item) => item.target === "antigravity_cli")!
      .state === "not_installed",
    "failed operation left the connection locked",
  );

  const hiddenChange = Promise.withResolvers<unknown>();
  integrationChange = hiddenChange.promise;
  click("Install Antigravity CLI integration");
  click("Appearance");
  integrationChange = null;
  antigravity.state = "current";
  hiddenChange.resolve({
    target: antigravity.target,
    details: { messages: ["Completed while unmounted"] },
  });
  await settle();
  click("Integrations");
  await waitFor(
    () =>
      button("Refresh integrations").getAttribute("aria-disabled") === "false",
  );
  check(
    !!document.querySelector(
      '[aria-label="Uninstall Antigravity CLI integration"]',
    ) && dialog.textContent!.includes("Completed while unmounted"),
    "unmounted completion lost its outcome or left status stale",
  );
  click("Uninstall Antigravity CLI integration");
  await waitFor(
    () =>
      button("Refresh integrations").getAttribute("aria-disabled") === "false",
  );

  for (const closeDialog of [false, true]) {
    const hiddenFailure = Promise.withResolvers<unknown>();
    integrationChange = hiddenFailure.promise;
    click("Install Antigravity CLI integration");
    const writes = mutationCount();
    click(closeDialog ? "Done" : "Appearance");
    integrationChange = null;
    hiddenFailure.reject(new Error("Mutation failed while unmounted"));
    await settle();
    if (closeDialog) {
      click("Menu");
      click("Configuration");
      await waitFor(() => !!document.querySelector(".configuration-modal"));
      dialog = document.querySelector<HTMLElement>(".configuration-modal")!;
    }
    // A failed status refresh must not discard the mutation failure either.
    integrationLoadFailure = closeDialog;
    click("Integrations");
    await waitFor(
      () =>
        button("Refresh integrations").getAttribute("aria-disabled") ===
        "false",
    );
    check(
      !!document
        .querySelector('[role="alert"]')
        ?.textContent?.includes("Mutation failed while unmounted") &&
        mutationCount() === writes,
      "settled failure was lost when reopening integrations",
    );
    integrationLoadFailure = false;
    click("Refresh integrations");
    await waitFor(
      () =>
        button("Refresh integrations").getAttribute("aria-disabled") ===
        "false",
    );
    check(
      !document.querySelector('[role="alert"]') && mutationCount() === writes,
      "consumed failure was replayed or refresh repeated the mutation",
    );
  }

  let resolveChange!: (value: unknown) => void;
  integrationChange = new Promise((resolve) => {
    resolveChange = resolve;
  });
  const beforePending = mutationCount();
  click("Install Antigravity CLI integration");
  click("Install Antigravity CLI integration");
  check(
    mutationCount() === beforePending + 1,
    "duplicate integration mutation was sent",
  );
  const alphaLists = calls.filter(
    (call) => call.id === "alpha" && call.method === "integration.list",
  ).length;
  integrationChange = null;
  // Replace the runtime for the same connection ID while a write is in flight.
  selectConnection("alpha");
  await waitFor(
    () =>
      button("Refresh integrations").getAttribute("aria-disabled") === "false",
  );
  resolveChange({ messages: ["Stale mutation result"] });
  await settle();
  check(
    !dialog.textContent!.includes("Stale mutation result") &&
      calls.filter(
        (call) => call.id === "alpha" && call.method === "integration.list",
      ).length ===
        alphaLists + 1,
    "late mutation affected the replacement connection runtime",
  );
  const otherConnectionChange = Promise.withResolvers<unknown>();
  integrationChange = otherConnectionChange.promise;
  click("Install Antigravity CLI integration");
  const beforeConnectionSwitch = mutationCount();
  integrationChange = null;
  selectConnection("beta");
  await waitFor(
    () =>
      button("Refresh integrations").getAttribute("aria-disabled") === "false",
  );
  click("Uninstall Pi integration");
  await waitFor(
    () =>
      button("Refresh integrations").getAttribute("aria-disabled") === "false",
  );
  check(
    mutationCount() === beforeConnectionSwitch + 1,
    "another connection's pending mutation blocked the selected connection",
  );
  otherConnectionChange.resolve({
    target: "antigravity_cli",
    details: { messages: ["Retired alpha operation"] },
  });
  await settle();
  check(
    !dialog.textContent!.includes("Retired alpha operation"),
    "retired connection operation leaked into the current view",
  );
  check(
    dialog.scrollWidth <= dialog.clientWidth + 1,
    "integration messages overflow the viewport",
  );
  await key(button("Refresh integrations"), "Escape");
  await settle();
  check(
    !document.querySelector(".configuration-modal") &&
      document.activeElement === button("Menu"),
    "Escape did not close and restore focus",
  );
  root.unmount();
}
run()
  .catch((error) => failures.push(String(error?.stack ?? error)))
  .finally(() =>
    fetchResult("/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(failures),
    }),
  );
