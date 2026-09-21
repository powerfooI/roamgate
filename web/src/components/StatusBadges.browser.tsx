import { ACCENT_OPTIONS } from "../appearance";
import { agentClass } from "../utils";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/layout/app.css";
import "./WorkspaceAgentRows.css";
import "./WorkspaceTree.css";
import "./AgentHistoryDrawer.css";
import "./AutoSyncRepositoriesDialog.css";

const failures: string[] = [];
const canvas = document.createElement("canvas");
canvas.width = 1;
canvas.height = 33;
const context = canvas.getContext("2d", { willReadFrequently: true })!;

function luminance(pixel: ArrayLike<number>, offset: number) {
  return [0.2126, 0.7152, 0.0722].reduce((sum, weight, channel) => {
    const value = pixel[offset + channel] / 255;
    return (
      sum +
      weight *
        (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    );
  }, 0);
}

function contrast(element: HTMLElement) {
  const ancestors: HTMLElement[] = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement)
    ancestors.unshift(node);
  context.fillStyle = "white";
  context.fillRect(0, 0, 1, 33);
  for (const node of ancestors) {
    const style = getComputedStyle(node);
    context.fillStyle = style.backgroundColor;
    context.fillRect(0, 0, 1, 33);
    if (style.backgroundImage !== "none") {
      // Sample the full range of the shell's two-stop gradients, including endpoints.
      const colors = style.backgroundImage.match(
        /(?:color\(srgb[^)]+\)|rgba?\([^)]+\))/g,
      );
      if (
        !/^linear-gradient\((?:180deg, )?(?:color|rgb)/.test(
          style.backgroundImage,
        ) ||
        colors?.length !== 2
      )
        throw new Error(
          `Unsupported badge background: ${style.backgroundImage}`,
        );
      const gradient = context.createLinearGradient(0, 0.5, 0, 32.5);
      gradient.addColorStop(0, colors[0]);
      gradient.addColorStop(1, colors[1]);
      context.fillStyle = gradient;
      context.fillRect(0, 0, 1, 33);
    }
  }
  const background = context.getImageData(0, 0, 1, 33).data;
  context.fillStyle = getComputedStyle(element).color;
  context.fillRect(0, 0, 1, 33);
  const foreground = context.getImageData(0, 0, 1, 33).data;
  let minimum = Infinity;
  for (let offset = 0; offset < background.length; offset += 4) {
    const a = luminance(background, offset);
    const b = luminance(foreground, offset);
    minimum = Math.min(
      minimum,
      (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
    );
  }
  return minimum;
}

async function run() {
  const motion = document.createElement("style");
  motion.textContent =
    "* { transition: none !important; animation: none !important; }";
  document.head.append(motion);
  // Exercise the real hover declarations and their cascade without moving a mouse.
  for (const sheet of document.styleSheets) {
    for (const rule of sheet.cssRules) {
      if (
        rule instanceof CSSStyleRule &&
        [".pane-jump-item:hover", ".agent-row:hover"].includes(
          rule.selectorText,
        )
      )
        rule.selectorText = rule.selectorText.replace(
          ":hover",
          ":is(:hover, .contrast-hover)",
        );
    }
  }
  const fixture = document.createElement("div");
  fixture.style.margin = "40px";
  fixture.innerHTML = `
    <div class="pane-jump-popover"><div class="pane-jump-list">
      <button class="pane-jump-item"><span class="pane-jump-text"><span class="pane-jump-title-line" data-group="pane"></span></span></button>
    </div></div>
    <div class="panel agents-panel"><div class="agents-list">
      <div class="agent-row is-standalone"><div class="agent-info"><div class="agent-title" data-group="standalone"></div></div></div>
    </div></div>
    <div class="panel tree workspace-tree-panel"><div class="workspace-tree-content">
      <div class="agent-row is-nested"><div class="agent-info"><div class="agent-title" data-group="nested"></div></div></div>
      <div class="tree-row"><span class="git-status" data-group="git"></span></div>
    </div></div>
    <div class="agent-history-drawer is-open"><div class="agent-history-drawer-head" data-group="history"></div></div>
    <div class="modal auto-sync-repositories-modal"><div class="auto-sync-config-content"><div class="auto-sync-config-list">
      <div class="auto-sync-config-item"><div class="auto-sync-config-main"><div class="auto-sync-config-heading" data-group="sync"></div></div></div>
    </div></div></div>`;
  document.body.append(fixture);
  function badge(group: string, status: string, className: string) {
    const element = document.createElement("span");
    element.className = className;
    element.textContent = status;
    element.dataset.badge = `${group} ${status}`;
    fixture.querySelector(`[data-group="${group}"]`)!.append(element);
  }
  for (const status of ["working", "done", "blocked", "idle", "unknown"]) {
    badge("pane", status, `${agentClass(status)} pane-jump-agent-status`);
    for (const group of ["standalone", "nested"])
      badge(group, status, `${agentClass(status)} agent-row-status`);
    badge("history", status, `agent-history-status is-${status}`);
  }
  for (const status of ["branch", "dirty", "ahead", "behind", "error"])
    badge(
      "git",
      status,
      `git-badge git-${status === "error" ? "badge-error" : status}`,
    );
  for (const status of [
    "updated",
    "up_to_date",
    "syncing",
    "skipped",
    "failed",
    "idle",
  ])
    badge("sync", status, `auto-sync-status auto-sync-status-${status}`);
  try {
    for (const theme of ["dark", "light"]) {
      document.documentElement.dataset.theme = theme;
      for (const { value: accent } of ACCENT_OPTIONS) {
        document.documentElement.dataset.accent = accent;
        for (const layout of ["desktop", "mobile"]) {
          document.documentElement.dataset.layout = layout;
          for (const state of [
            "",
            "is-selected",
            "is-current",
            "contrast-hover",
            "is-selected contrast-hover",
            "is-current contrast-hover",
          ]) {
            fixture.querySelector(".pane-jump-item")!.className =
              `pane-jump-item ${state}`;
            fixture.querySelector(".tree-row")!.className =
              `tree-row ${state.includes("is-selected") ? "is-focused" : ""}`;
            for (const kind of ["standalone", "nested"])
              fixture
                .querySelector(`[data-group="${kind}"]`)!
                .closest(
                  ".agent-row",
                )!.className = `agent-row is-${kind} ${state}`;
            for (const element of fixture.querySelectorAll<HTMLElement>(
              "[data-badge]",
            )) {
              const ratio = contrast(element);
              if (ratio < 4.5)
                failures.push(
                  `${theme} ${accent} ${layout} ${state || "normal"}: ${element.dataset.badge} contrast ${ratio.toFixed(2)} < 4.5`,
                );
            }
          }
        }
      }
    }
  } finally {
    fixture.remove();
    motion.remove();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.accent;
    delete document.documentElement.dataset.layout;
  }
}

run()
  .catch((error) => failures.push(String(error)))
  .finally(() =>
    fetch("/result", {
      method: "POST",
      body: JSON.stringify(
        failures.length
          ? [...failures.slice(0, 20), `${failures.length} contrast failures`]
          : [],
      ),
    }),
  );
