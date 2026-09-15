import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/vendor.css";
import "./TerminalView.css";
import {
  applyTerminalTheme,
  terminalThemeFor,
  type CustomTerminalTheme,
  type TerminalThemeSelection,
  MAX_CUSTOM_TERMINAL_THEMES,
  parseCustomTerminalThemes,
  serializeCustomTerminalThemes,
  TERMINAL_ANSI_COLOR_KEYS,
} from "../terminalThemes";
import { TerminalThemeDialog } from "./TerminalThemeDialog";

const failures: string[] = [];
const check = (condition: boolean, message: string) => {
  if (!condition) failures.push(message);
};
const settle = () =>
  new Promise((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => setTimeout(resolve, 200)),
    ),
  );
const button = (label: string) => {
  const found = [...document.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === label ||
      element.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const click = (label: string) => flushSync(() => button(label).click());
let customThemes: CustomTerminalTheme[] = [];
let selection: TerminalThemeSelection;
let replaceThemes: (themes: CustomTerminalTheme[]) => void;
let replaceSelection: (selection: TerminalThemeSelection) => void;

function Harness() {
  const [themes, setThemes] = useState<CustomTerminalTheme[]>([]);
  const [selected, setSelected] = useState({
    dark: "herdr-dark",
    light: "herdr-light",
  });
  customThemes = themes;
  selection = selected;
  replaceThemes = setThemes;
  replaceSelection = setSelected;
  return (
    <TerminalThemeDialog
      open
      customThemes={themes}
      selection={selected}
      onCustomThemesChange={setThemes}
      onSelectionChange={setSelected}
      onClose={() => {}}
    />
  );
}

async function run() {
  const rootElement = document.createElement("div");
  document.body.append(rootElement);
  const root = createRoot(rootElement);
  flushSync(() => root.render(<Harness />));
  await settle();
  click("Duplicate Roamgate Dark");
  await settle();
  const input = document.querySelector<HTMLInputElement>(
    ".terminal-theme-name-field input",
  )!;
  input.focus();
  check(document.activeElement === input, "Input was not focused initially");
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  for (const name of ["C", "Co", "Copy"]) {
    setValue.call(input, name);
    flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
    check(
      document.activeElement === input,
      `Name input lost focus during ${name}`,
    );
    await settle();
    check(
      document.activeElement === input,
      `Name input lost focus after ${name}`,
    );
    check(input.value === name, "Name input did not update");
  }

  const modes = document.querySelectorAll(
    ".terminal-theme-variant-field button",
  );
  check(
    modes[0].getAttribute("aria-label") === "Dark mode",
    "Dark mode button has no accessible name",
  );
  check(
    modes[1].getAttribute("aria-label") === "Light mode",
    "Light mode button has no accessible name",
  );

  const termElement = document.createElement("div");
  termElement.className = "terminal-view";
  termElement.style.cssText = "position:relative;width:800px;height:240px";
  document.body.append(termElement);
  const term = new Terminal();
  term.open(termElement);
  const defaults: string[] = [];
  term.onData((data) => {
    const match = /\]4;(\d+);rgb:([\da-f]+)\/([\da-f]+)\/([\da-f]+)/i.exec(
      data,
    );
    if (match)
      defaults[Number(match[1])] = `#${match
        .slice(2)
        .map((part) => part.slice(0, 2))
        .join("")}`;
  });
  await new Promise<void>((resolve) =>
    term.write(
      TERMINAL_ANSI_COLOR_KEYS.map((_, i) => `\x1b]4;${i};?\x07`).join(""),
      resolve,
    ),
  );
  const colors = [
    ...document.querySelectorAll<HTMLInputElement>('input[type="color"]'),
  ].slice(5);
  check(
    defaults.filter(Boolean).length === 16,
    "xterm did not report its default ANSI palette",
  );
  for (const [index, key] of TERMINAL_ANSI_COLOR_KEYS.entries()) {
    check(
      colors[index].value === defaults[index],
      `Duplicate changed default ANSI ${key}`,
    );
  }
  const textarea = termElement.querySelector("textarea")!;
  for (const { mode, theme } of [
    { mode: "light", theme: { background: "#2b3245", foreground: "#ffffff" } },
    { mode: "light", theme: terminalThemeFor("light") },
    { mode: "dark", theme: terminalThemeFor("dark") },
  ]) {
    document.documentElement.dataset.theme = mode;
    applyTerminalTheme(term, theme);
    textarea.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    textarea.dispatchEvent(
      new CompositionEvent("compositionupdate", {
        data: "test",
        bubbles: true,
      }),
    );
    await settle();
    const composition = termElement.querySelector(".composition-view")!;
    const style = getComputedStyle(composition);
    const expected = document.createElement("span");
    expected.style.color = theme.foreground!;
    check(
      composition.classList.contains("active") && style.display !== "none",
      "IME preedit was not activated",
    );
    check(
      style.color === expected.style.color,
      "IME preedit did not use the terminal foreground",
    );
    check(
      style.color !== style.backgroundColor,
      "IME preedit text is invisible against its background",
    );
    textarea.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
  }
  delete document.documentElement.dataset.theme;
  term.dispose();
  termElement.remove();

  click("Cancel");
  await settle();
  const radios = document.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  radios[0].focus();
  flushSync(() =>
    radios[0].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  await settle();
  check(
    document.activeElement === radios[1],
    "Arrow navigation lost focus after selection",
  );
  check(
    selection.dark === "solarized-dark",
    "Arrow navigation did not select the next theme",
  );

  const full = Array.from(
    { length: MAX_CUSTOM_TERMINAL_THEMES },
    (_, index): CustomTerminalTheme => ({
      id: `custom-${index}`,
      name: `Custom ${index}`,
      variant: "dark",
      colors: { background: "#000000", foreground: "#ffffff" },
    }),
  );
  flushSync(() => replaceThemes(full.slice(1)));
  click("Duplicate Roamgate Dark");
  await settle();
  // Another browser tab can fill the final slot while this draft is open.
  flushSync(() => replaceThemes(full));
  check(
    button("Create theme").disabled,
    "Create remained enabled after the last slot was filled",
  );
  check(
    document.querySelector('[role="alert"]') !== null,
    "Missing theme-limit explanation",
  );
  click("Create theme");
  check(
    customThemes.length === MAX_CUSTOM_TERMINAL_THEMES,
    "Save exceeded the theme limit",
  );
  check(
    parseCustomTerminalThemes(serializeCustomTerminalThemes(customThemes))
      .length === customThemes.length,
    "Saving dropped a theme from storage",
  );
  if (document.querySelector(".terminal-theme-editor")) click("Cancel");
  await settle();
  check(
    button("Duplicate Roamgate Dark").disabled,
    "Duplicate remained enabled at the theme limit",
  );
  check(
    button("Duplicate Custom 0").disabled,
    "Custom theme duplication bypassed the limit",
  );
  click("Edit Custom 0");
  await settle();
  check(
    !button("Save theme").disabled,
    "Editing an existing theme was blocked at the limit",
  );
  click("Save theme");
  check(
    customThemes.length === MAX_CUSTOM_TERMINAL_THEMES,
    "Editing changed the theme count",
  );
  check(
    selection.dark === "custom-0",
    "Editing did not select the saved theme",
  );
  click("Delete Custom 0");
  await settle();
  const confirmation = document.querySelector(
    '[role="dialog"][aria-label="Delete theme"]',
  )!;
  check(
    confirmation.contains(document.activeElement),
    "Delete confirmation lost focus",
  );
  flushSync(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  await settle();
  check(
    customThemes.length === MAX_CUSTOM_TERMINAL_THEMES,
    "Escape deleted a theme",
  );
  check(
    document.activeElement?.getAttribute("aria-label") === "Terminal themes",
    "Closing confirmation did not restore dialog focus",
  );
  click("Delete Custom 0");
  await settle();
  click("Delete");
  check(
    selection.dark === "herdr-dark",
    "Deleting the selected theme did not restore the default",
  );
  check(
    !button("Duplicate Roamgate Dark").disabled,
    "Deleting a theme did not free a slot",
  );
  click("Duplicate Roamgate Dark");
  await settle();
  click("Create theme");
  check(
    customThemes.length === MAX_CUSTOM_TERMINAL_THEMES,
    "The free slot could not be reused",
  );
  check(
    parseCustomTerminalThemes(serializeCustomTerminalThemes(customThemes)).some(
      (theme) => theme.id === selection.dark,
    ),
    "The newly selected theme was not persisted",
  );
  const saved = customThemes.find((theme) => theme.id === selection.dark)!;
  click(`Edit ${saved.name}`);
  await settle();
  const editedInput = document.querySelector<HTMLInputElement>(
    ".terminal-theme-name-field input",
  )!;
  setValue.call(editedInput, "Unsaved edit");
  flushSync(() =>
    editedInput.dispatchEvent(new Event("input", { bubbles: true })),
  );
  // Deliver the state produced by deleting the selected theme in another tab.
  flushSync(() => {
    replaceThemes(customThemes.filter((theme) => theme.id !== saved.id));
    replaceSelection({ ...selection, dark: "herdr-dark" });
  });
  const synchronized = JSON.stringify({ customThemes, selection });
  check(
    button("Save theme").disabled,
    "Saving a deleted theme remained enabled",
  );
  click("Save theme");
  check(
    JSON.stringify({ customThemes, selection }) === synchronized,
    "Saving a deleted theme changed synchronized state",
  );
  check(
    editedInput.isConnected && editedInput.value === "Unsaved edit",
    "Deleting the theme discarded its open draft",
  );
  check(
    document
      .querySelector('[role="alert"]')
      ?.textContent?.includes("no longer exists") === true,
    "Missing deleted-theme explanation",
  );
  flushSync(() => replaceThemes([...customThemes, saved]));
  check(
    !button("Save theme").disabled,
    "Restoring the theme did not re-enable saving",
  );
  click("Save theme");
  check(
    customThemes.find((theme) => theme.id === saved.id)?.name ===
      "Unsaved edit",
    "The preserved draft could not be saved",
  );
  flushSync(() => root.unmount());
  rootElement.remove();
}

run()
  .catch((error: unknown) => failures.push(String(error)))
  .finally(() =>
    fetch("/result", { method: "POST", body: JSON.stringify(failures) }),
  );
