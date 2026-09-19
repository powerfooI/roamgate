import "./styles/tokens.css";
import "./styles/base.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { bridge, type HerdrEventMsg } from "./api";
import { ConfigMenu } from "./components/ConfigMenu";
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
  const codes: Record<string, number> = { Tab: 9, Escape: 27, ArrowRight: 39 };
  for (const type of ["keyDown", "keyUp"])
    await input("Input.dispatchKeyEvent", {
      type,
      key: value,
      windowsVirtualKeyCode: codes[value],
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
  const dialog = document.querySelector<HTMLElement>(".configuration-modal")!;
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
  await key(button("Terminal incremental transport"), "Escape");
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
