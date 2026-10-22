import type { PointerEvent } from "react";

export function activeTerminalInput(root: ParentNode): HTMLElement | null {
  const shell = root.querySelector<HTMLElement>(
    ".pane-layout-cell.is-active .terminal-shell, .workspace-terminal-surface > .terminal-shell",
  );
  if (!shell) return null;
  const editor = shell.dataset.paneId
    ? Array.from(
        root.querySelectorAll<HTMLElement>(
          '.mobile-bottom-bar .terminal-composer[data-open][data-input-mode="composer"]',
        ),
      ).find((composer) => composer.dataset.paneId === shell.dataset.paneId)
    : undefined;
  return (
    editor?.querySelector<HTMLElement>(".terminal-composer-input") ??
    shell.querySelector<HTMLElement>(
      ".terminal-composer-input:not([hidden])",
    ) ??
    shell.querySelector<HTMLElement>(".terminal-view") ??
    null
  );
}

export function blurActiveInput(event: PointerEvent<HTMLButtonElement>) {
  // A compact-row gesture may be a horizontal pan. Dismiss input only once
  // its native click handler confirms navigation, not at the start of a swipe.
  if (
    event.currentTarget.closest(
      ".app[data-mobile-controls-compact] .mobile-controls-stack",
    )
  )
    return;
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  const button = event.currentTarget;
  window.setTimeout(() => button.blur(), 0);
}
