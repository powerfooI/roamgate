export function activeTerminalInput(root: ParentNode): HTMLElement | null {
  const shell = root.querySelector<HTMLElement>(
    ".pane-layout-cell.is-active .terminal-shell, .pane-switcher-layout > .terminal-shell, .workspace-terminal-surface > .terminal-shell",
  );
  return (
    shell?.querySelector<HTMLElement>(
      ".terminal-composer-input:not([hidden])",
    ) ??
    shell?.querySelector<HTMLElement>(".terminal-view") ??
    null
  );
}
