# Reproducible Product Screenshots

Capture the real Roamgate UI against a real Herdr backend using the public
[Northstar demo](https://github.com/powerfooI/northstar-demo), a fictional task
board. Every shot tells one story: add a status filter, test it, and review it.

## Isolate the Capture Environment

Use a dedicated OS account (for example `demo`) or a clean VM with only Bun,
Git, Herdr, Roamgate, and the public repositories. Keep personal projects,
browser profiles, shell/SSH config, and agent transcripts out of it, and use a
neutral hostname and a fresh browser profile. The OS account is the privacy
boundary: Roamgate reads agent history and settings from the user's home
directory, so a separate Herdr session alone is not enough.

Only include the PR status card if `gh` is already authenticated in that
environment and PR #1 is open with passing checks; do not copy private
credentials just for the card. Set an absolute `XDG_STATE_HOME` outside every
demo checkout.

## Prepare the Case

Install root dependencies ([Contributing](../CONTRIBUTING.md)), then clone the
demo into a new, empty directory:

```sh
mkdir -p /tmp/roamgate-demo
git clone --branch main https://github.com/powerfooI/northstar-demo.git /tmp/roamgate-demo/northstar
```

| Scene | Initial state | Use |
| --- | --- | --- |
| Baseline | Clean `main` clone | Give a real agent the task from the README. |
| Review | `main` plus the example implementation as unstaged changes | Files, diff, preview, annotation, and PR shots. |

For the review scene, run this **only in the fresh clone**:

```sh
git -C /tmp/roamgate-demo/northstar switch --track -c codex/status-filter origin/codex/status-filter
git -C /tmp/roamgate-demo/northstar reset --mixed origin/main
git -C /tmp/roamgate-demo/northstar diff origin/main --stat
```

The diff touches `app.ts`, `index.html`, `styles.css`, `tasks.test.ts`, and
`tasks.ts` from [PR #1](https://github.com/powerfooI/northstar-demo/pull/1).
That PR is a prepared example; never present it as an agent's work. Record both
remote commit SHAs with the originals.

For sidebar shots, add three more clones:

```sh
git clone --branch main https://github.com/powerfooI/northstar-demo.git /tmp/roamgate-demo/documentation
git clone --branch main https://github.com/powerfooI/northstar-demo.git /tmp/roamgate-demo/release-qa
git clone --branch main https://github.com/powerfooI/northstar-demo.git /tmp/roamgate-demo/ui-preview
```

`bun test` and `bun run dev` in the Northstar clone run the tests and the board
at <http://127.0.0.1:4317>. To repeat a scene, use a new destination directory
instead of resetting an existing checkout.

## Start the Real Workspace

`bun run demo:herdr` runs Herdr with a clean environment and a dedicated
`roamgate-demo` session under `/tmp/roamgate-demo/config` (override with an
absolute `ROAMGATE_DEMO_ROOT`, the same in every terminal).

Start the server in one terminal:

```sh
bun run demo:herdr server
```

In a second terminal, create the workspaces. Note the IDs each command returns:

```sh
bun run demo:herdr workspace create --cwd /tmp/roamgate-demo/documentation --label Documentation
# demo_docs_pane_id = .result.root_pane.pane_id
bun run demo:herdr workspace create --cwd /tmp/roamgate-demo/release-qa --label "Release QA"
# demo_qa_workspace_id = .result.workspace.workspace_id
bun run demo:herdr tab create --workspace "$demo_qa_workspace_id" --cwd /tmp/roamgate-demo/release-qa --label Tests --no-focus
# demo_qa_pane_id = .result.root_pane.pane_id
bun run demo:herdr workspace create --cwd /tmp/roamgate-demo/ui-preview --label "UI Preview"
bun run demo:herdr workspace create --cwd /tmp/roamgate-demo/northstar --label Northstar --focus
# demo_tab_id = .result.tab.tab_id, demo_pane_id = .result.root_pane.pane_id
bun run demo:herdr tab rename "$demo_tab_id" Implementation
bun run demo:herdr pane rename "$demo_pane_id" Implementation
bun run demo:herdr pane split --pane "$demo_pane_id" --direction down --ratio 0.65 --cwd /tmp/roamgate-demo/northstar --no-focus
# demo_checks_id = .result.pane.pane_id
bun run demo:herdr pane rename "$demo_checks_id" Checks
bun run demo:herdr pane run "$demo_checks_id" "bun test"
```

For the desktop overview, install Pi in the capture account with its Herdr
integration and run idle Pi sessions (no model calls) in three panes:

```sh
XDG_CONFIG_HOME=/tmp/roamgate-demo/config \
  PI_CODING_AGENT_DIR=/tmp/roamgate-demo/pi-agent \
  herdr --session roamgate-demo integration install pi
bun run demo:herdr pane run "$demo_pane_id" "PI_CODING_AGENT_DIR=/tmp/roamgate-demo/pi-agent PI_OFFLINE=1 PI_TELEMETRY=0 pi"
bun run demo:herdr pane run "$demo_docs_pane_id" "PI_CODING_AGENT_DIR=/tmp/roamgate-demo/pi-agent PI_OFFLINE=1 PI_TELEMETRY=0 pi"
bun run demo:herdr pane run "$demo_qa_pane_id" "PI_CODING_AGENT_DIR=/tmp/roamgate-demo/pi-agent PI_OFFLINE=1 PI_TELEMETRY=0 pi"
```

Wait until Herdr reports `agent=pi`. In the Implementation pane, enter `/new`,
then `!git --no-pager diff origin/main --stat` to show the real diff summary
above the passing tests in Checks. For mobile, run
`git status --short && bun test --dots` in Checks. Rerun commands after changing
viewport size, and keep only one capture client attached.

Build and start the bridge:

```sh
bun run build:web
mkdir -p /tmp/roamgate-demo/runtime-state
XDG_STATE_HOME=/tmp/roamgate-demo/runtime-state bun server/src/index.ts --host 127.0.0.1 --port 8799 \
  --socket-path /tmp/roamgate-demo/config/herdr/sessions/roamgate-demo/herdr.sock \
  --client-socket-path /tmp/roamgate-demo/config/herdr/sessions/roamgate-demo/herdr-client.sock
```

Open <http://127.0.0.1:8799>, log in, and remove any token from the URL before
capturing. To start over, stop the bridge and run:

```sh
bun run demo:herdr server stop
bun run demo:herdr session delete roamgate-demo --json
```

## Run the Agent Scene

Agent, history, working-status, and **Last step** shots need a real agent run.
In a fresh `main` clone, start a supported agent in Implementation and give it:

> Read README.md. Add All, To do, In progress, and Done
> status filters to Northstar. Combine status with title search. Show an
> accessible empty result with a Clear filters button. Preserve the static HTML
> preview, add focused tests, and run them. Leave the changes uncommitted.

Use that run's own changes, test output, and transcript together; never pair an
unrelated transcript with PR #1's code. Keep the session for later captures.

## Shot List and Capture Rules

Dark theme, default accent, English UI, 100% browser zoom. Desktop viewport
1600 x 1000 and mobile 390 x 844, both at DPR 2, so originals are 3200 x 2000 and
780 x 1688 PNGs. In Chrome DevTools' device toolbar, pick **Responsive**, set the
size and DPR 2, and use **More options > Capture screenshot** (viewport, not full
page). Verify it is a real PNG of the right size with no browser chrome. JPEGs,
converted, or upscaled images are not acceptable.

For the annotation shot, add `Keep the status filter combined with title search.
Clearing both filters should restore all six tasks.` on new line 27 of
`tasks.ts`, pin the review panel, and leave the comment as a draft.

| Asset stem | Layout and selection | Ready condition |
| --- | --- | --- |
| `roamgate-desktop-changes` | Nested sidebar; Pi in Implementation above Checks; Inspector right (~55%); Working tree, `tasks.ts` | 3+ workspaces and 2+ agent rows visible; Pi running; five files loaded; tests finished. |
| `roamgate-desktop-files` | Nested sidebar; expanded Inspector; Files, `index.html` Preview scrolled to Release checklist | Styles loaded; heading, filters, and all six cards visible. |
| `roamgate-desktop-annotations` | Nested sidebar; `tasks.ts` unified diff with the draft | Correct line and full comment visible. |
| `roamgate-desktop-history` | Agent History, all types enabled | The real task and its test tool call visible. |
| `roamgate-desktop-ranger` | Ranger pinned beside Northstar | A real answer with sources, using only demo workspaces. |
| `roamgate-mobile-changes` | Mobile Changes, Working tree, `tasks.ts` | Key changed function readable. |
| `roamgate-mobile-terminal` | Mobile Checks pane with Composer and shortcuts | Real Git status and test summary visible. |
| `roamgate-mobile-files` | Mobile Files, `index.html` Preview | Heading, filters, and first card readable. |
| `roamgate-mobile-ranger` | Mobile Ranger chat | The same real conversation with input and model controls. |

For Ranger, connect a model in the capture environment, allow only the demo
workspaces, and ask it to summarize Northstar's uncommitted changes and test
output. Never fabricate messages, tool results, or task runs.

Wait for content to settle rather than sleeping a fixed time. Do not crop,
upscale, or sharpen; recapture instead.

Before publishing, check full size and README size for crisp text, and inspect
paths, hostnames, URLs, prompts, authors, and transcripts for anything private.
Keep originals outside the repo; compress losslessly without resizing (use
TinyPNG only with explicit permission, and do not call it lossless). Save
approved PNGs to `docs/images/` with `width="3200" height="2000"` (desktop) or
`width="780" height="1688"` (mobile) on `img` tags, then run `bun run build:site`.

## Computer-to-Phone Animation

The README uses `docs/images/roamgate-handoff.gif`; the homepage uses
`roamgate-handoff.mp4` with a `roamgate-handoff.webp` poster. Render a 13-second
English sequence at 1920 x 1200 and 15 fps from the original desktop Changes,
mobile Changes, and mobile Terminal captures, composited into device frames. It
illustrates a handoff; it is not a live recording. Export the GIF with a shared
palette, the MP4 as H.264, and the poster as lossless WebP, then check the full
loop at native and README sizes before replacing all three files.
