import { expect, test } from "bun:test";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();
const [
  app,
  shell,
  sidebar,
  nav,
  annotations,
  ranger,
  inspector,
  composer,
  history,
] = await Promise.all([
  read("../App.tsx"),
  read("../styles/layout/app.css"),
  read("../styles/layout/sidebar.css"),
  read("../styles/layout/mobile-nav.css"),
  read("./AnnotationPanel.css"),
  read("./AssistantPanel.css"),
  read("./WorkspaceInspectorHost.css"),
  read("./TerminalComposer.css"),
  read("./AgentHistoryDrawer.css"),
]);

function rule(css: string, selector: string, last = false) {
  const start = last
    ? css.lastIndexOf(`${selector} {`)
    : css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start) + 1);
}

// CSS/DOM ownership contracts, not a browser's painted-layout simulation.
// Device acceptance must additionally measure body.bottom == rail.top and
// page.bottom == body.bottom (within rounding), including at CSS zoom.
test("all phone Inspector views replace the terminal with a full-height page", () => {
  const fullpage = shell.slice(shell.indexOf("  .body:is("));
  for (const view of ["files", "changes", "commits", "history"]) {
    expect(fullpage).toContain(`.mobile-view-${view}`);
  }
  expect(fullpage).toContain(
    ".workspace-terminal-surface {\n      display: none;",
  );
  const slot = rule(
    fullpage,
    ".workspace-stage .workspace-inspector-slot:not(.is-closed)",
  );
  for (const declaration of [
    "position: relative;",
    "inset: auto;",
    "width: 100% !important;",
    "max-width: none;",
    "height: 100% !important;",
    "min-height: 0;",
    "max-height: none;",
    "flex: 1;",
  ])
    expect(slot).toContain(declaration);
  expect(rule(inspector, ".workspace-inspector")).toContain("height: 100%;");
});

test("the global rail consumes flex height once, outside all page surfaces", () => {
  expect(app).toContain(
    "</main>\n      </div>\n      {mobile ? (\n        <MobileBottomBar",
  );
  expect(rule(shell, ".app")).toContain("flex-direction: column;");
  expect(rule(shell, ".body")).toContain("flex: 1;");
  for (const selector of [
    ".body",
    ".main",
    ".workspace-surfaces",
    ".workspace-stage",
  ])
    expect(rule(shell, selector)).toContain("min-height: 0;");
  const rail = rule(nav, ".mobile-bottom-bar");
  expect(rail).toContain("position: relative;");
  expect(rail).toContain("flex: 0 0 auto;");
  expect(rail).toContain("env(safe-area-inset-bottom, 0px)");
  expect(rail).toContain("var(--keyboard-inset-composer-gap, 0px)");
  expect(shell).toContain("--keyboard-inset-content");
  expect(app).toContain("window.innerHeight / geometryScale");
  // Neither a historical measured composer size nor a viewport-fixed page
  // should reserve space inside the already shortened body.
  for (const css of [shell, sidebar, annotations, ranger, inspector])
    expect(css).not.toMatch(/--(?:terminal-)?composer-height/);
});

test("Workspaces and page footers do not reserve the rail or safe area again", () => {
  const mobileSidebar = sidebar.slice(
    sidebar.indexOf(':where(html[data-layout="mobile"])'),
  );
  expect(rule(mobileSidebar, ".sidebar-content")).toContain(
    "padding-bottom: 0;",
  );
  expect(sidebar).not.toContain("58px");
  for (const css of [annotations, ranger, inspector])
    expect(css).not.toContain("safe-area-inset-bottom");
  expect(rule(annotations, ".annotation-panel-footer")).toContain(
    "padding: 10px;",
  );
  expect(rule(ranger, ".assistant-panel-footer.is-mobile")).toContain(
    "padding: 4px 6px;",
  );
  expect(
    rule(ranger, ".assistant-panel.is-mobile .assistant-settings-save"),
  ).toContain("padding-bottom: 10px;");
  expect(rule(history, ".agent-history-drawer.is-embedded", true)).toContain(
    "padding-bottom: 0;",
  );
  expect(rule(annotations, ".annotation-panel-list")).toContain(
    "overflow: auto;",
  );
  expect(rule(ranger, ".assistant-panel-list")).toContain("overflow: auto;");
  expect(composer).toContain("position: relative;");
});

test("phone fullpage overrides follow desktop peer-panel sizing without changing it", () => {
  // A peer annotation draft can activate the 55% desktop Inspector rule
  // even at phone widths. All four routes must override it.
  const peer = shell.indexOf(
    ".has-annotations .workspace-stage:not(.is-inspector-expanded)",
  );
  const mobile = shell.lastIndexOf(':where(html[data-layout="mobile"])');
  const fullpage = shell.indexOf("  .body:is(", mobile);
  expect(peer).toBeGreaterThan(0);
  expect(mobile).toBeGreaterThan(peer);
  expect(fullpage).toBeGreaterThan(mobile);
  expect(shell.slice(peer, mobile)).toContain("max-width: 55%;");
  expect(rule(shell, ".workspace-inspector-slot")).toContain("max-width: 65%;");
  expect(rule(annotations, ".annotation-panel.is-floating")).toContain(
    "position: absolute;",
  );
  // Workspaces, Ranger (including Settings) and Annotations inherit the
  // remaining body height; their lists, not the whole viewport, scroll.
  const phone = shell.slice(mobile, fullpage);
  expect(phone).toContain(
    ".workspace-surfaces.has-annotations > .annotation-panel",
  );
  expect(phone).toContain(
    ".workspace-surfaces.has-assistant > .assistant-panel",
  );
  expect(phone).toContain("height: 100%;");
  expect(phone).toContain(".body.mobile-view-annotations .workspace-stage");
  expect(phone).toContain(".body.mobile-view-assistant .workspace-stage");
  expect(rule(shell, ".body.mobile-view-workspaces .main")).toContain(
    "display: none;",
  );
});
