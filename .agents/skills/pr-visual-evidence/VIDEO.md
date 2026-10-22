# Scripted video evidence

Use the real route and backend on the PR's current branch, prepared as described
in [CAPTURE.md](CAPTURE.md). Keep the viewport focused on the changed controls
and their visible results.

## Record

Create a unique workspace for each capture with `mktemp -d`. Keep the scenario,
frames, clips, and PR body files inside it; never use shared fixed paths under
`/tmp`. Retain evidence until it has been reviewed or attached, then remove only
that run's directory.

Write a small scenario module with `setup(page)` and `run(page)` exports.
Inspect the page to choose selectors before recording. In `setup`, navigate,
arrange the initial state, and wait for fonts, images, and controls to be ready.
In `run`, execute only the relevant clicks, typing, hovering, or dragging, using
semantic locators and assertions on the resulting states.

Run the whole scenario in one process. Use short, deliberate pauses only when
needed to see the actual transition; never step through the recording with
separate agent tool calls. Keep real animation speed, preserve loading states
that are part of the change, and wait for the last action's visible result to
settle. Do not hide a slow application by speeding up video. If a run contains
unrelated actions or accidental waits, fix the script and record again.

The runner loads Playwright from its working directory. Roamgate does not have
that dependency. Use an existing isolated capture environment with Node,
Playwright, and Chromium, or prepare one in the run's temporary directory as
below. Video finishing also needs Python 3 and `ffmpeg`. Keep these capture
dependencies out of the repository manifests and lockfile. Start from the
repository root, using `capture_work` from [CAPTURE.md](CAPTURE.md):

```bash
printf '{"private":true}\n' > "$capture_work/package.json"
(
  cd "$capture_work" || exit 1
  bun add --dev playwright
  bun x playwright install chromium
)
# Write the scenario module to "$capture_work/scenario.mjs" before running it.
raw_video=$(
  cd "$capture_work" || exit 1
  node "$repo_root/.agents/skills/pr-visual-evidence/scripts/record-interaction.mjs" \
    "$capture_work/scenario.mjs" "$capture_work"
)
recording_dir=$(dirname "$raw_video")
```

The runner creates a random child directory on every invocation, even when
concurrent recordings share the same parent. The optional parent must already
exist; omitting it uses the system temp directory. On success, stdout contains
only the raw video path; send scenario logs to stderr. Both scenario functions
receive `{ outputDir }` as a second argument; use it for any screenshots or
other files created by the scenario. The runner reports the directory on stderr
before capture so failed recordings can also be inspected and cleaned up.

The scenario may export `viewport` (defaults to 960 × 540). Keep normal motion
enabled. The runner uses a visible browser by default; set `HEADLESS=1` for
automated environments. A hidden app pane can freeze animation. The raw
recording includes setup and safety margins; those are removed from the final
video. Keep the scenario with the local evidence so it can be rerun, and
identify the branch/commit and fixture or route in the handoff.

Set `viewport` explicitly when the default crops Roamgate's shell or when
demonstrating mobile layout. Keep the app's theme stable throughout the run.
Put readiness assertions in `setup`; in `run`, wait for terminal output, menu
visibility, or the other observable result of each action. For streaming or
reconnect changes, retain the relevant wait in the final clip. The runner's
one-second pauses are recording margins, not proof that the app has settled.

## Finish with exact idle boundaries

Normalize to 30 fps and inspect frames around the first action and the final
settled result:

```bash
ffmpeg -i "$raw_video" -vf fps=30 "$recording_dir/frame-%06d.png"
```

Frame indices for the helper are zero-based (PNG `frame-000001.png` is index 0).
Choose `--start-frame` as the **last still frame immediately before the first
relevant action** and `--end-frame` as the **first fully settled frame after the
last action's visible result**. Include pointer movement when it is part of the
interaction. Do not cut the transition tail. Do not include existing idle frames
inside these boundaries: the helper holds each boundary frame for exactly 30
frames, giving exactly 1 second idle on each side at 30 fps.

```bash
python3 "$repo_root/.agents/skills/pr-visual-evidence/scripts/finish-video.py" \
  "$raw_video" "$recording_dir/evidence.mp4" \
  --start-frame 90 --end-frame 210
```

The numbers above are placeholders; derive them from the actual recording. The
helper cannot infer which action is relevant or whether the final animation has
settled. It removes setup and teardown, preserves the middle at normal speed,
and encodes a silent H.264 MP4. Verify missing/incorrect boundaries by
inspecting frames; a one-second sleep in a script does not establish a
one-second boundary in the encoded video.

Watch the final MP4, including the start and end. Confirm all relevant actions
are visible, no unrelated activity remains, the final state is readable, and
both idle intervals are exactly 30 frames. Boundary stills plus 29 cloned frames
on each side avoid an extra idle frame.

## Attach

When publication is requested, keep the screenshot on line one. Place the video
immediately below it with a short scenario caption. Current `gh` versions with
video attachment support can upload the MP4 directly:

```bash
gh pr view "$pr_number" --json body --jq .body > "$capture_work/pr-body.md"
# Edit that file: keep the screenshot and existing prose, insert the video
# reference near the top, using the same path passed to --attach below:
# ![Interaction video](/absolute/path/to/evidence.mp4)
gh pr edit "$pr_number" --body-file "$capture_work/pr-body.md" \
  --attach "$recording_dir/evidence.mp4"
```

Keep the video image reference alone in its own paragraph, with blank lines
around it. `gh` rewrites that standalone embed to a bare attachment URL so
GitHub renders a player. An ordinary Markdown link stays a text link.

For a new PR, put both references in the body and pass both `--attach` flags to
the single creation command. Do not pass video to `pr-attach-image.sh`, which
manages the leading screenshot. Fetch the updated body, verify attachment URLs
replaced local paths, and open the uploaded video to check playback. On a partial
failure, inspect the PR before retrying. If video upload is unavailable, return
the local MP4 and explicitly report the missing attachment. Keep raw recordings,
frames, and scenarios outside the repository; stop only capture-owned servers.
