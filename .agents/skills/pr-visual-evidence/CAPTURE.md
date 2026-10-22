# Capturing the screenshot

Capture the real Roamgate route against a real Herdr backend. Use reproducible
demo data, crop to the subject, and caption each panel. Keep development evidence
separate from the full-size README/homepage assets in
[the product screenshot workflow](../../../docs/SCREENSHOTS.md).

## Prepare the capture

From the checkout being demonstrated:

```bash
repo_root=$(git rev-parse --show-toplevel)
capture_work=$(mktemp -d "${TMPDIR:-/tmp}/pr-evidence.XXXXXX")
git rev-parse HEAD > "$capture_work/revision.txt"
git status --short > "$capture_work/worktree.txt"
```

Keep the scenario, screenshots, video, and PR drafts in that directory. Use a
fresh browser context and public demo workspaces. For shareable captures,
follow the existing
[capture isolation guidance](../../../docs/SCREENSHOTS.md#isolate-the-capture-environment)
and `bun run demo:herdr` setup. A separate Herdr session or `XDG_STATE_HOME`
alone does not isolate this OS user's personal history and credentials.

## Real app and backend

Follow [Development Setup](../../../CONTRIBUTING.md#development-setup) and
[Manual browser checks](../../../CONTRIBUTING.md#manual-browser-checks). From the
repository root, with dependencies installed and a local Herdr server running:

```bash
# Run in separate terminals:
bun run dev:server
bun run dev:web
```

Open `http://localhost:5173`; Vite proxies the bridge on `127.0.0.1:8788`.
Check terminal output for actual origins and port conflicts. Development mode
allows loopback without login; never expose that listener to the network.
The Vite proxy target is fixed: changing the frontend port does not isolate the
bridge. If `8788` is occupied, identify its owner; do not kill an unrelated
server or accidentally record another checkout's backend.

For parallel revision comparisons, build each checkout with `bun run build:web`
and serve its generated assets directly from its own bridge on a free loopback
port. Use `NODE_ENV=production bun server/src/index.ts --host 127.0.0.1 --port <free-port>` with the
explicit demo `--socket-path` and `--client-socket-path` from
[Start the Real Workspace](../../../docs/SCREENSHOTS.md#start-the-real-workspace).
Log in normally and remove any token from the URL before recording. For login,
authentication, CSP, or PWA behavior, use this production-mode path instead of
the development bypass; never change auth or security settings just for capture.

This repository has no Storybook or Playwright dependency. Use the available
browser tools to inspect and capture the real UI. Do not add a component harness
or change project dependencies just to take a screenshot.

## Frame and verify

Start with a desktop viewport that keeps the relevant shell and result legible;
use a narrow viewport for mobile changes. State the actual dimensions and theme.
Wait for fonts, terminal content, connection readiness, and the changed controls;
avoid capturing skeletons unless the loading state is the subject. Use semantic
locators after inspecting the page. Keep dialogs, backdrops, and portaled menus
inside the frame.

For terminal workflows, use a disposable demo pane and harmless commands. For
agent history or Ranger, use an actual demo run and identify it. Do not use a
fake transcript or an empty/disconnected screen to stand in for working state.
Device emulation establishes layout only; keyboard/IME, Safari, notifications,
and touch claims require the relevant real browser or device. Report gaps using
the [manual checklist](../../../CONTRIBUTING.md#manual-browser-checks).

Inspect each capture at full size before upload. Check for private paths,
hostnames, URLs, workspace names, authors, prompts, and transcripts. Remove token
URLs and recapture; never place credentials in scenario files or PR prose.

## Before/after

Capture the actual base and changed revisions, then compose two labeled panels
into one image. Use the same demo data, viewport, and color scheme for both
states, and crop away unrelated content. Keep composition files in the run's
temporary directory, outside production assets. Preserve enough context to make
clear what changed. Use an element screenshot when the target bounds are enough;
use the viewport when a dialog, backdrop, or portaled control is the subject.
Resolve the base from the target PR. Keep its checkout separate from the working
changes; never reset or stash the user's checkout to obtain a baseline. Record
both revisions. Avoid simultaneous terminal capture clients: viewport resizing
can alter the shared terminal. Reproduce the same demo state sequentially or use
separate demo sessions. If a baseline cannot be reproduced, supply an explicitly
labeled after-only shot instead of reconstructing the old UI in HTML.

See [VIDEO.md](VIDEO.md) for scripted motion capture and exact idle boundaries.
