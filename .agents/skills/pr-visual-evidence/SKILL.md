---

name: pr-visual-evidence
description: "Create requested PR visual evidence for Roamgate: a leading screenshot and scripted video for animation, transitions, or multi-step interactions. Use when the user requests PR screenshots, before/after, video evidence, or visual guidance. UI changes alone do not require capture or upload."
---

# Roamgate PR visual evidence

Adapted for this repository from
[ghdiff's pr-visual-evidence](https://github.com/GalvinGao/ghdiff/tree/main/.agents/skills/pr-visual-evidence).

Use this repository-local skill when PR visual evidence is requested, including
an explicit invocation of this skill. Follow
[the repository PR rules](../../../AGENTS.md#commit--pull-request-guidelines):
ordinary UI work does not require screenshots. A local capture request does not
itself request a PR edit or upload.

## Choose the evidence

Read the diff and identify the visible behavior to prove. A backend, CI, docs,
or tooling change that renders identically needs no image. For visible changes,
choose the smallest relevant case:

| Roamgate change                                                          | Evidence                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Layout, theme, copy, file preview or diff rendering                      | Focused screenshot; labeled before/after when comparison helps.                                   |
| Dialog, menu, inspector resize, terminal composer or multi-step workflow | Screenshot of the result plus a scripted video of the interaction.                                |
| Terminal streaming, connection recovery, agent history or Ranger state   | Real Herdr-backed state; preserve relevant loading and reconnect behavior.                        |
| Mobile layout or keyboard behavior                                       | Narrow viewport capture; real device verification for platform keyboard, IME, and touch behavior. |

Keep evidence on the PR's current revision. Record the commit, any uncommitted
changes, route, browser, viewport, and scenario with the local artifacts. Do not
fabricate terminal output, agent messages, task runs, or successful connections.

## Capture

Use [CAPTURE.md](CAPTURE.md) for the Bun/Vite/Herdr setup, privacy isolation,
readiness checks, and revision comparisons. Capture the real UI and keep enough
context to understand the change. Match the viewport, demo data, language, and
theme between compared states. A before/after is one labeled image.

For requested evidence involving animation, transitions, or a multi-step
interaction, also record a video unless the user requests stills only.
Show only the relevant actions, with exactly 1 second idle
before the first action and exactly 1 second idle after the last action's
visible result has settled. Preserve the complete motion. Run the interaction in
one small automation script, not separate agent-driven browser calls: tool and
reasoning latency must never become pauses in the video. Follow
[VIDEO.md](VIDEO.md) for scripted recording, frame-accurate padding, and
verification. Browser recordings supplement the
[required validation](../../../CONTRIBUTING.md#validation); report the actual
checks run and include `bun run build:web` for frontend changes.

## Attach

When the task includes publishing evidence, inspect the target PR's current
body and preserve its summary, verification, issue links, and existing evidence.
Keep the screenshot on line one, then the video and a short scenario caption.
Identify fixtures and platform limitations in the caption where relevant.

Use `gh` with `--attach` support (upstream requires 2.99.0 or newer); check
`gh pr create --help` and `gh pr edit --help` for image and video support.
Reference the shot as a **Markdown image** on line one of the
body and pass the same path to `--attach`; gh rewrites the reference to the
uploaded URL. An HTML `<img>` is not rewritten and the file gets appended to the
end instead.

```bash
# Use the capture_work directory created in CAPTURE.md.
# Save the screenshot as pr-shot.png and the PR prose as pr-prose.md there.
printf '![Roamgate: describe the visible change](%s)\n\n' "$capture_work/pr-shot.png" > "$capture_work/pr-body.md"
cat "$capture_work/pr-prose.md" >> "$capture_work/pr-body.md"
gh pr create --base main --head "$head_branch" --title "$pr_title" \
  --body-file "$capture_work/pr-body.md" --attach "$capture_work/pr-shot.png"
```

Keep capture files and PR drafts in a unique directory per run. After verifying
the uploaded attachments, remove only that run's directory when its local
evidence is no longer needed.

Set `head_branch` and `pr_title` from the actual task. For video, follow
[VIDEO.md](VIDEO.md#attach). Do not create a PR merely to exercise this skill.

Existing PR, when replacing its previous leading evidence image (the helper
replaces any first-line Markdown image or single-line HTML image):

```bash
.agents/skills/pr-visual-evidence/scripts/pr-attach-image.sh \
  --pr "$pr_number" --image "$capture_work/pr-shot.png" \
  --alt "Roamgate: describe the visible change"
```

If the first image is unrelated or spans multiple HTML lines, edit a copy of
the full body instead of using the helper. Fetch the body after upload; confirm
the leading image uses a GitHub attachment URL, open the image/video, and check
that the remaining prose is intact. Do not report success from the exit code
alone. A partial upload can return a failure after creating or editing the PR;
inspect the printed PR URL and body before retrying to avoid duplicate PRs.

## Before handing back

- For a published result, link the PR and verify its attachments. Otherwise,
  return local artifact paths and state what has not been uploaded.
- Watch the exported video and verify its one-second idle boundaries and actions.
- Report validation actually performed and any missing device/backend coverage.
- Keep captures, raw recordings, and temporary pages outside the repository;
  do not commit evidence just for PR review or change app dependencies for it.
- Stop only servers started for this capture. Retain local evidence until
  reviewed or verified online, then remove only this run's temporary directory.
