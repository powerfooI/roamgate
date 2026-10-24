import { expect, test } from "bun:test";

const nav = await Bun.file(
  new URL("../styles/layout/mobile-nav.css", import.meta.url),
).text();
const terminal = await Bun.file(
  new URL("./TerminalView.css", import.meta.url),
).text();
const composer = await Bun.file(
  new URL("./TerminalComposer.css", import.meta.url),
).text();

function rule(css: string, selector: string, occurrence = 0) {
  let start = css.indexOf(`${selector} {`);
  while (occurrence-- > 0 && start >= 0)
    start = css.indexOf(`${selector} {`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start) + 1);
}

const control = "max(44px, calc(44px / var(--ui-scale, 1)))";
const sizedControl = `var(--mobile-control-size, ${control})`;
const message = "max(48px, calc(48px / var(--ui-scale, 1)))";

// These are CSS contract tests, not painted-layout tests. Device acceptance
// still checks actual rects/overlap, keyboard geometry and multiline focus.
test("Direct, Chat, Tabs and More use 44px controls with inverse zoom compensation", () => {
  const buttons = rule(nav, ".mobile-appbar button");
  expect(buttons).toContain("width: var(--mobile-control-size);");
  expect(buttons).toContain("height: var(--mobile-control-size);");
  expect(rule(nav, ".mobile-bottom-bar")).toContain(
    `--mobile-control-size: ${control};`,
  );
  expect(buttons).toContain("flex: 0 0 auto;");
  const direct = rule(terminal, ".terminal-mobile-input-bar button");
  expect(direct.replace(/\s/g, "")).toContain(
    `min-width: ${sizedControl};`.replace(/\s/g, ""),
  );
  expect(direct.replace(/\s/g, "")).toContain(
    `min-height: ${sizedControl};`.replace(/\s/g, ""),
  );
  expect(direct).toContain("flex: 0 0 auto;");
  expect(direct).toContain("padding: 0;");

  // CSS zoom scales the entire shell; inverse compensation is only needed
  // below 100%. Check all supported percentage steps, including the extremes.
  for (let percent = 80; percent <= 150; percent++) {
    const scale = percent / 100;
    const buttonPixels = Math.max(44, 44 / scale) * scale;
    expect(buttonPixels).toBeGreaterThanOrEqual(44 - 1e-10);
    expect(Math.max(48, 48 / scale) * scale).toBeGreaterThan(buttonPixels);
  }
});

test("footer controls share quiet borderless styling without losing selected or keyboard states", () => {
  const direct = rule(terminal, ".terminal-mobile-input-bar button");
  const navigation = rule(nav, ".mobile-appbar button");
  for (const button of [direct, navigation]) {
    expect(button).toContain("border: 0;");
    expect(button).toContain("background: transparent;");
    expect(button).toContain("border-radius: 22px;");
    expect(button).toContain("color: var(--text-strong);");
  }
  // Only Message retains the original input bubble, not Direct.
  expect(
    rule(terminal, ".terminal-mobile-input-bar .terminal-mobile-message"),
  ).toContain(
    "background: color-mix(in srgb, var(--text-strong) 8%, var(--terminal-bg));",
  );
  expect(terminal).not.toContain(
    '.terminal-mobile-direct[aria-pressed="true"]',
  );
  expect(nav).toContain(
    '.terminal-mobile-direct[aria-pressed="true"],\n  .mobile-appbar button[aria-pressed="true"],\n  .mobile-appbar button[aria-expanded="true"]',
  );
  const selected = rule(nav, '.mobile-appbar button[aria-expanded="true"]');
  expect(selected).toContain("background: var(--accent-soft);");
  expect(selected).not.toContain("border");
  expect(nav).toContain(
    ".terminal-mobile-direct:focus-visible,\n  .mobile-appbar button:focus-visible",
  );
  const focus = rule(nav, ".mobile-appbar button:focus-visible");
  expect(focus).toContain("outline: 2px solid var(--accent);");
  expect(focus).toContain("outline-offset: 2px;");
  expect(rule(nav, ".mobile-appbar button:focus-visible", 1)).toContain(
    "outline-color: Highlight;",
  );
  expect(nav).toContain("@media (forced-colors: active)");
  const highContrast = rule(
    nav,
    '.mobile-appbar button[aria-expanded="true"]',
    1,
  );
  expect(highContrast).toContain("forced-color-adjust: none;");
  expect(highContrast).toContain("background: Highlight;");
  expect(highContrast).toContain("color: HighlightText;");
  expect(rule(nav, ".mobile-appbar button:disabled")).toContain("opacity:");
  expect(
    rule(terminal, ".terminal-mobile-input-bar button:disabled"),
  ).toContain("opacity:");
});

test("navigation slots and centering track control size without shrinking Message", () => {
  const row = rule(terminal, ".terminal-mobile-input-bar", 1);
  expect(row.replace(/\s/g, "")).toContain(
    `padding-right: calc(var(--mobile-navigation-slots, 2) * ${sizedControl} + 4px);`.replace(
      /\s/g,
      "",
    ),
  );
  expect(rule(nav, ".mobile-bottom-bar[data-chat]")).toContain(
    "--mobile-navigation-slots: 3;",
  );
  expect(row).toContain("align-items: center;");
  const editor = rule(
    terminal,
    ".terminal-mobile-input-bar .terminal-mobile-message",
  );
  expect(editor).toContain(`min-width: ${message};`);
  expect(editor).toContain("padding: 12px 8px;");
  expect(rule(composer, ".terminal-composer-input")).toContain(
    `min-height: ${message};`,
  );
  // The empty rail has the same 48px row even without a composer portal.
  expect(rule(nav, ".mobile-bottom-bar")).toContain(message);
  const appbar = rule(nav, ".mobile-appbar");
  expect(appbar.replace(/\s/g, "")).toContain(
    `(${message} - var(--mobile-control-size)) / 2`.replace(/\s/g, ""),
  );
  expect(appbar).toContain("env(safe-area-inset-bottom, 0px)");
  expect(appbar).toContain("env(safe-area-inset-right, 0px)");
});

test("tab counts and attention badges stay inside the narrower button", () => {
  const badge = rule(nav, ".mobile-appbar-count");
  expect(badge).toContain("right: 2px;");
  expect(badge).toContain("max-width: calc(100% - 4px);");
  expect(badge).toContain("overflow: hidden;");
  expect(badge).toContain("text-overflow: ellipsis;");
  expect(rule(nav, ".mobile-appbar-count[data-attention]")).toContain(
    "background: var(--red);",
  );
});

test("Chat fits a 320px phone at every supported scale without reducing touch targets", () => {
  expect(nav).toContain("@media (max-width: 360px)");
  expect(rule(nav, ".mobile-bottom-bar[data-chat]", 1)).toContain(
    "--mobile-control-size: calc(44px / var(--ui-scale, 1));",
  );
  for (let percent = 80; percent <= 150; percent++) {
    const scale = percent / 100;
    const available = 320 - (16 + 8) * scale - 4 * 44;
    expect(available).toBeGreaterThanOrEqual(48 * Math.max(1, scale));
  }
});

test("toolbar close stays right aligned when Direct hides the submit actions", () => {
  expect(rule(composer, ".terminal-composer-close")).toContain(
    "margin-left: auto;",
  );
  const actions = rule(composer, ".terminal-composer-submit-actions");
  expect(actions).toContain("flex: 1 1 auto;");
  expect(actions).toContain("justify-content: flex-end;");
});

test("popup backdrops cover viewport corners without inherited button rounding", () => {
  const backdrop = rule(nav, ".mobile-more-backdrop");
  expect(backdrop).toContain("inset: 0;");
  expect(backdrop).toContain("border-radius: 0;");
});

test("More remains anchored above the Message rail with keyboard and safe-area compensation", () => {
  const menu = rule(nav, "body .app[data-mobile-more] .mobile-controls-stack");
  expect(menu).toContain(message);
  expect(menu).toContain("env(safe-area-inset-bottom, 0px)");
  expect(menu).toContain("var(--keyboard-inset-composer-gap, 0px)");
  expect(menu).toContain(
    "var(--keyboard-inset-content, var(--keyboard-inset-bottom, 0px))",
  );
  expect(menu).toContain("overflow-y: auto;");
  // Focused multiline editing still borrows all navigation slots.
  expect(
    rule(
      nav,
      ".mobile-bottom-bar:has(.terminal-composer[data-expanded]) .mobile-appbar",
    ),
  ).toContain("display: none;");
  expect(
    rule(
      composer,
      ".terminal-composer[data-expanded] > .terminal-mobile-input-bar",
    ),
  ).toContain("padding-right: 0;");
});

test("Composer focus overrides closed bar muted styling and coordinates shortcut capsule and header collapse", async () => {
  const topbar = await Bun.file(
    new URL("../styles/layout/topbar.css", import.meta.url),
  ).text();

  const focusRule = rule(
    composer,
    ".terminal-composer .terminal-composer-input:focus",
  );
  expect(focusRule).toContain(
    "border-color: color-mix(in srgb, var(--accent) 70%, var(--border));",
  );
  expect(focusRule).toContain("color: var(--text-strong);");

  // Upper-right shortcut capsule stays available when Composer shortcuts are
  // closed or covered by the command picker, even when keyboard or Composer is focused.
  expect(terminal).not.toContain(".keyboard-open .terminal-mobile-keys");
  expect(terminal).not.toContain(
    ".app:has(.terminal-composer-input:focus) .terminal-mobile-keys",
  );
  expect(terminal).toContain(".keyboard-open .terminal-mobile-side-shortcuts");
  expect(terminal).toContain(
    ".app:has(.terminal-composer-input:focus) .terminal-mobile-side-shortcuts",
  );

  // Header collapses on .keyboard-open in both Direct and Composer modes.
  expect(topbar).toContain(
    "&.keyboard-open .app:has(.terminal-composer-input:focus) .topbar",
  );
  expect(topbar).toContain(
    "&.keyboard-open .app:has(.terminal-composer-input:focus) .topbar > *",
  );
});
