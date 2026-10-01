# Reproducible Product Screenshots

Capture the current Roamgate UI against a real Herdr backend using Northstar,
a fictional six-task board. Its names, code, tasks, and local SVG are public demo
content. Use one coherent task across desktop and mobile: add a status filter,
explain empty results, test it, and review the change.

## Prepare the Case

Install the root dependencies as described in [Contributing](../CONTRIBUTING.md).
From the Roamgate checkout, prepare a standalone Git repository outside it:

```sh
bun run demo:prepare --scene review --dir /tmp/roamgate-demo/northstar
```

The default scene is `review`; the default directory is `roamgate-demo/northstar`
under the OS temporary directory. An explicit `/tmp` path gives short, predictable
paths on macOS and Linux. The project needs Bun and Git, with no extra packages.

| Scene | Initial state | Use |
| --- | --- | --- |
| `base` | Clean baseline on `feat/status-filter` | Give a real agent the task in the project README. |
| `review` | The same baseline plus five modified files | Repeatable Files, Working tree diff, preview, and annotation shots. |

Preparation uses a fixed Git author (`Demo <demo@example.invalid>`) and commit
date, disables inherited Git configuration/templates, and creates no remote.
The review patch is a prepared example implementation; it carries no claim that
an agent produced it. Agent history and live agent status require a real run.

For desktop sidebar shots, prepare three additional directories from the same
public fixture. They are separate Git repositories, not labels for personal
projects:

```sh
bun run demo:prepare --scene base --dir /tmp/roamgate-demo/documentation
bun run demo:prepare --scene base --dir /tmp/roamgate-demo/release-qa
bun run demo:prepare --scene base --dir /tmp/roamgate-demo/ui-preview
```

Run the board and tests from the prepared directory:

```sh
cd /tmp/roamgate-demo/northstar
bun test
bun run dev
```

Open <http://127.0.0.1:4317>. `bun run dev 4318` selects another port. On the
review scene, choose **Done** and search for `navigation` to reach the empty
state; **Clear filters** restores all six tasks and focuses the search input.
Roamgate's static HTML preview shows all six cards with local styles/images;
its script restrictions mean interactive filtering belongs in the live board.

To repeat a scene, stop its running processes and close its Herdr workspace first:

```sh
bun run demo:prepare --scene review --dir /tmp/roamgate-demo/northstar --reset
```

Reset renames the previous directory to a sibling `northstar.saved-*` before
creating the new one. Keep that backup until any edits have been recovered; delete
it manually when finished. Only directories bearing the generated demo marker
can be reset. A failed preparation restores the previous directory when its
original path is free. If another process has replaced that path, the backup is
retained and its location is reported. Ordinary directories, symlink destinations,
and destinations inside this Roamgate checkout are refused.

## Isolate the Capture Environment

Use a dedicated OS account named `demo` or a clean VM for published screenshots.
Install Bun, Git, Herdr, and Roamgate there; copy or clone only the public checkout
and the demo fixture. Keep personal projects, home directories, browser profiles,
shell configuration, SSH configuration, and agent transcripts outside it. Configure
only the credentials needed for a real agent, without printing them in commands
or terminal output. Choose a neutral hostname and a fresh browser profile.

A separate project, named Herdr session, and clean shell environment protect
against accidental reuse. They do not prevent the same OS user from accessing
personal files. Roamgate resolves some agent histories through that user's home
directory and stores GUI settings there; changing `CODEX_HOME` alone does not
isolate those lookups. The OS account or VM is the privacy boundary.

## Start the Real Workspace

The following macOS/Linux commands run from the Roamgate checkout in the capture
account. `demo:herdr` runs the installed Herdr CLI with an allowlisted environment,
a `/bin/sh` non-login shell, neutral prompt, and a dedicated `roamgate-demo`
session under `/tmp/roamgate-demo/config`. Set `ROAMGATE_DEMO_ROOT` to an absolute
path to change that root; all invocations must use the same value.

In the first terminal:

```sh
bun run demo:herdr server
```

In a second terminal:

```sh
bun run demo:herdr workspace create --cwd /tmp/roamgate-demo/documentation --label Documentation
```

Record Documentation's returned `.result.root_pane.pane_id` as
`demo_docs_pane_id`. Create Release QA:

```sh
bun run demo:herdr workspace create --cwd /tmp/roamgate-demo/release-qa --label "Release QA"
```

Record its `.result.workspace.workspace_id` as `demo_qa_workspace_id`, then add
its Tests tab:

```sh
bun run demo:herdr tab create --workspace "$demo_qa_workspace_id" --cwd /tmp/roamgate-demo/release-qa --label Tests --no-focus
```

Record that tab's `.result.root_pane.pane_id` as `demo_qa_pane_id`. Create UI
Preview, then focus Northstar:

```sh
bun run demo:herdr workspace create --cwd /tmp/roamgate-demo/ui-preview --label "UI Preview"
bun run demo:herdr workspace create --cwd /tmp/roamgate-demo/northstar --label Northstar --focus
```

Record Northstar's returned `.result.tab.tab_id` and `.result.root_pane.pane_id`
as `demo_tab_id` and `demo_pane_id` in this terminal. Rename and split the real
panes:

```sh
bun run demo:herdr tab rename "$demo_tab_id" Implementation
bun run demo:herdr pane rename "$demo_pane_id" Implementation
bun run demo:herdr pane split --pane "$demo_pane_id" --direction down --ratio 0.65 --cwd /tmp/roamgate-demo/northstar --no-focus
```

Record the split's `.result.pane.pane_id` as `demo_checks_id`, then:

```sh
bun run demo:herdr pane rename "$demo_checks_id" Checks
bun run demo:herdr pane run "$demo_checks_id" "bun test"
```

For the desktop overview, install Pi normally in the capture account and use its
official Herdr integration. Keep Pi's standard package entry point so Herdr can
identify the real process. Use a dedicated writable profile for the integration
and all three interactive sessions:

```sh
XDG_CONFIG_HOME=/tmp/roamgate-demo/config \
  PI_CODING_AGENT_DIR=/tmp/roamgate-demo/pi-agent \
  herdr --session roamgate-demo integration install pi
bun run demo:herdr pane run "$demo_pane_id" "PI_CODING_AGENT_DIR=/tmp/roamgate-demo/pi-agent PI_OFFLINE=1 PI_TELEMETRY=0 pi"
bun run demo:herdr pane run "$demo_docs_pane_id" "PI_CODING_AGENT_DIR=/tmp/roamgate-demo/pi-agent PI_OFFLINE=1 PI_TELEMETRY=0 pi"
bun run demo:herdr pane run "$demo_qa_pane_id" "PI_CODING_AGENT_DIR=/tmp/roamgate-demo/pi-agent PI_OFFLINE=1 PI_TELEMETRY=0 pi"
```

The native install command preserves `PI_CODING_AGENT_DIR`, which the
`demo:herdr` wrapper's allowlist does not forward. Keep the Pi processes running,
with the genuine Pi TUI in Implementation and real test output in Checks. Wait
for Herdr to report `agent=pi` and session source `herdr:pi`; these idle sessions
are waiting for input without submitting a model prompt or calling a model.
They do not claim to have produced the review patch, completed a task, or created
task history. Done/history shots require a matching real completed turn as
described below. Show the sidebar in **Nested** mode and expand the demo workspaces.

In the current Implementation pane, enter `/new`, then
`!git --no-pager diff --stat`, pressing Enter after each. Pi remains active:
`/new` starts a clean session, and its Bash mode runs the genuine Git command
without a model request. The review fixture shows five changed files, 102
insertions, and five deletions. Keep this Pi TUI and command output above Checks,
whose real `bun test` run reports four passing tests and no failures. This output
describes the prepared patch; it does not attribute the patch to Pi.

For an optional shell overview, show the Task section and `git --no-pager diff
--stat` in Implementation after exiting Pi. For a narrow mobile terminal, run
`git status --short && bun test --dots` in Checks; the dots reporter keeps the
genuine test summary compact. Run commands again after switching viewport sizes
so terminal output uses the current geometry. Keep only one capture client
attached while doing this.

Build Roamgate's web assets and start its actual bridge in another terminal:

```sh
bun run build:web
bun server/src/index.ts --host 127.0.0.1 --port 8799 \
  --socket-path /tmp/roamgate-demo/config/herdr/sessions/roamgate-demo/herdr.sock \
  --client-socket-path /tmp/roamgate-demo/config/herdr/sessions/roamgate-demo/herdr-client.sock
```

Open <http://127.0.0.1:8799>. This loopback configuration does not require a
login. If capturing an authenticated non-loopback setup, use its login URL
privately and remove the authentication token from the URL before capturing.
Both socket paths must match a custom `ROAMGATE_DEMO_ROOT`.
The wrapper's Herdr session directory is selected by its `XDG_CONFIG_HOME`;
passing a different socket environment variable to a named Herdr session is
insufficient to change that directory.

For a fresh topology, stop the demo bridge and server, then delete only the
stopped demo session before starting again:

```sh
bun run demo:herdr server stop
bun run demo:herdr session delete roamgate-demo --json
```

Agent transcripts live in the capture account's agent directories. Preserve a
useful real session before clearing or rebuilding that account/VM.

## Run the Agent Scene

Prepare `base` in the isolated environment. Start one supported agent in the
Implementation pane with its genuine Herdr integration and give it this prompt:

> Read the Task section in README.md. Add All, To do, In progress, and Done
> status filters to Northstar. Combine status with title search. Show an
> accessible empty result with a Clear filters button. Preserve the static HTML
> preview, add focused tests, and run them. Leave the changes uncommitted.

Use the resulting real changes, test output, and transcript together for the
agent/history shots. Keep the accepted session for later captures using the
agent's supported resume workflow. Re-running a model can change its wording and
implementation; the fixed `review` scene is for deterministic file/diff shots.
Do not combine an unrelated transcript with the prepared patch as if it caused
the displayed changes.

For a working-agent shot, start an actual follow-up task such as reviewing keyboard
behavior. Capture only after the integration reports the real status. **Last
step** also needs a genuine observed task completion; the prepared Git patch
provides **Working tree**, not an agent-completion snapshot.

## Shot List and Capture Rules

Use dark theme with the default accent, English UI, and 100% browser zoom.
Use a desktop viewport of 1600 x 1000 CSS pixels and mobile viewport of
390 x 844 CSS pixels, both at device pixel ratio (DPR) 2. The PNG originals must
therefore be 3200 x 2000 desktop pixels and 780 x 1688 mobile pixels. Mobile
viewport emulation is suitable for layout screenshots; real mobile interaction
claims require a check on a physical phone. Record viewport, scale, app version,
scene, and browser with the exported originals.

Export through Chrome's native screenshot UI:

1. Open DevTools and toggle the device toolbar. Select **Responsive**.
2. Use **More options > Add device type** to show the device type control.
   Choose **Desktop** for 1600 x 1000 or **Mobile** for 390 x 844, with **DPR 2**
   and browser zoom at 100%. Allow Roamgate and terminal geometry to settle.
3. Choose **More options > Capture screenshot** in the device toolbar. This
   exports a native PNG directly. Save the viewport capture, not a full-page shot.
4. Before accepting it, verify the PNG signature (`89 50 4e 47 0d 0a 1a 0a`) and
   the required 2x pixel dimensions. Check that the image contains exactly the
   product viewport, without browser chrome or empty padding.

Tool-returned JPEG captures and JPEGs converted to PNG are not valid originals.
Changing the file format or upscaling does not recover lost text detail.

For the annotation shot, add `Keep the status filter combined with title search.
Clearing both filters should restore all six tasks.` on new line 27 of `tasks.ts`.
Pin the review panel and keep the comment as a draft.

| Asset stem | Layout and selection | Ready condition |
| --- | --- | --- |
| `roamgate-desktop-changes` | Sidebar visible in Nested mode, genuine Pi TUI in Implementation/Checks split, Inspector right at about 55%; Working tree, `tasks.ts` | Connected; at least three real workspaces and two real Agent rows visible; Pi process registered and running; five review files loaded; real tests finished. |
| `roamgate-desktop-files` | Sidebar visible in Nested mode; expand Inspector; Files; open `index.html` Preview; scroll to Release checklist | At least three real workspaces and two real Agent rows visible; local styles loaded; checklist heading, filters, and all six cards visible. |
| `roamgate-desktop-annotations` | Sidebar visible in Nested mode; `tasks.ts` unified diff and the review draft | At least three real workspaces and two real Agent rows visible; correct line anchor and full comment visible. |
| `roamgate-desktop-history` | Genuine Northstar Agent History, User/Agent/Tool enabled | The matching real task and completed test tool call are visible. |
| `roamgate-mobile-changes` | Mobile; Changes, Working tree, `tasks.ts` | Unified diff loaded; key changed function readable. |
| `roamgate-mobile-terminal` | Mobile; Checks pane; Composer and terminal shortcuts open | Actual Git status and test summary visible; menus dismissed. |
| `roamgate-mobile-files` | Mobile; Files, `index.html` static Preview | Board heading, filters, and first task card readable. |

Wait for connection, fonts, terminal geometry, and requested content to settle;
use these conditions rather than fixed sleeps. Start each shot with the same file,
scroll position, panel widths, and dismissed menus. Capture the product viewport
directly. Keep the interface text and terminal output intact.
If the exported bounds or dimensions differ, correct the browser settings and
recapture. Do not trim product controls, upscale, or sharpen screenshots.

Before publishing, inspect the full-resolution image and a README-sized preview.
Text, code, icons, and terminal output must be crisp and readable at their intended
display sizes. Blur or compression artifacts fail review: recapture a native PNG
at DPR 2 instead of repairing the image.
Check visible paths, account/host names, URLs, prompts, Git authors, browser chrome,
and session metadata against the demo allowlist. Exclude auth URLs, tokens,
personal workspaces, and unrelated history. Scan the source text/transcript as
well as inspecting the image; automated scans cannot prove that an image is safe.
Correct the source scene and recapture when private content appears.

Keep native PNG originals outside the publication assets, such as in a local
archive. Compress publication copies with TinyPNG without resizing; verify their
native dimensions and text/icon clarity at 100% and intended display sizes before
saving the approved PNGs in `docs/images/`. The existing `scripts/build-pages.ts`
copies the six shared README shots into the website.
Generate the hero's 720/1200/2400-pixel AVIF derivatives from the preserved native
3200 x 2000 desktop PNG, not a compressed publication PNG, preserving text clarity
with 4:4:4 encoding and checking each result. Set desktop PNG `img` dimensions to
`width="3200" height="2000"`, mobile dimensions to `width="780" height="1688"`,
and hero `srcset` descriptors to `720w`, `1200w`, and `2400w`.
Capture outputs and review drafts are not required additions to Git; publish
only the selected product assets. Run `bun run build:site` after updating consumed
images and links.
