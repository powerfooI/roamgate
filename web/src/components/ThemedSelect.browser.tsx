import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ArrowDownWideNarrow } from "lucide-react";
import "../styles.css";
import { ThemedSelect } from "./ThemedSelect";

const failures: string[] = [];
const check = (condition: boolean, message: string) => {
  if (!condition) failures.push(message);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

const options = [
  { value: "attention", label: "Attention first" },
  { value: "workspace", label: "Workspace order" },
  { value: "manual", label: "Manual order" },
];

function contentEl() {
  return document.querySelector<HTMLElement>(".themed-select-content");
}

async function closePopover() {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await settle();
}

async function openAndMeasure(trigger: HTMLButtonElement, label: string) {
  trigger.click();
  await settle();
  const content = contentEl();
  check(!!content, `${label}: popover content did not render`);
  if (!content) return;
  const triggerRect = trigger.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  const gap = contentRect.top - triggerRect.bottom;
  check(
    gap >= 0 && gap <= 24,
    `${label}: popover is ${Math.round(gap)}px below the trigger (expected ~8)`,
  );
  const drift = Math.abs(contentRect.right - triggerRect.right);
  check(
    drift <= 16,
    `${label}: popover right edge is ${Math.round(drift)}px from the trigger (align=end)`,
  );
  await closePopover();
}

async function run() {
  // Icon-button trigger in a right-aligned panel header (agents panel case).
  const header = document.createElement("div");
  header.style.cssText = "display:flex;justify-content:flex-end;padding:16px";
  document.body.append(header);
  const headerRoot = createRoot(header);
  flushSync(() =>
    headerRoot.render(
      <ThemedSelect
        className="agent-list-control"
        icon={<ArrowDownWideNarrow size={15} aria-hidden="true" />}
        align="end"
        aria-label="Agent sort order"
        value="attention"
        options={options}
        onChange={() => {}}
      />,
    ),
  );
  await settle();
  const iconTrigger = header.querySelector<HTMLButtonElement>(
    ".themed-select-trigger",
  );
  check(!!iconTrigger, "icon trigger did not render");
  if (iconTrigger) await openAndMeasure(iconTrigger, "agents panel");

  // Same trigger under UI scaling (document zoom + --ui-scale).
  document.documentElement.style.zoom = "1.25";
  document.documentElement.style.setProperty("--ui-scale", "1.25");
  await settle();
  if (iconTrigger) await openAndMeasure(iconTrigger, "agents panel @125%");
  document.documentElement.style.zoom = "";
  document.documentElement.style.removeProperty("--ui-scale");
  await settle();

  // Trigger inside a modal dialog (Layout Preferences / shortcuts case).
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  document.body.append(backdrop);
  const backdropRoot = createRoot(backdrop);
  flushSync(() =>
    backdropRoot.render(
      <div className="modal" style={{ padding: 24 }}>
        <ThemedSelect
          aria-label="Display mode"
          value="auto"
          options={[
            { value: "auto", label: "Automatic" },
            { value: "mobile", label: "Mobile" },
            { value: "desktop", label: "Desktop" },
          ]}
          onChange={() => {}}
        />
      </div>,
    ),
  );
  await settle();
  const dialogTrigger = backdrop.querySelector<HTMLButtonElement>(
    ".themed-select-trigger",
  );
  check(!!dialogTrigger, "dialog trigger did not render");
  if (dialogTrigger) {
    dialogTrigger.click();
    await settle();
    const content = contentEl();
    check(!!content, "dialog: popover content did not render");
    if (content) {
      const rect = content.getBoundingClientRect();
      const topmost = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + Math.min(16, rect.height / 2),
      );
      check(
        !!topmost && content.contains(topmost),
        `dialog: popover is covered by ${topmost ? `.${[...topmost.classList].join(".") || topmost.tagName}` : "nothing"}`,
      );
    }
  }

  await fetch("/result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(failures),
  });
}

run();
