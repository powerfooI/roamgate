# Repository Guidelines

## Project Structure & Module Organization

This repo contains a Bun-powered bridge and a React/Vite frontend for Herdr.
Frontend code lives in `web/src`, with reusable UI under `web/src/components`,
assets under `web/src/assets`, and styling split between `web/src/styles`
(theme tokens, base primitives, vendor overrides, app-shell layout) and
co-located `web/src/components/*.css` files (see the style organization
guidelines in `CONTRIBUTING.md`).
Server and bridge code lives in `server/src`. Release helpers live in `scripts/`.
Generated build output belongs in `web/dist`, `server/public`,
`server/src/public-files.gen.ts`, `server/roamgate*`, legacy `server/herdr-gui*`,
and `dist/`; these paths
are ignored and should not be committed.

## Build, Test, and Development Commands

Install all Bun workspace dependencies from the repository root with
`bun install --frozen-lockfile` (Bun 1.4.1 or newer). The root `bun.lock` is the
only lockfile; shared TypeScript, Bun types, and lint/format tooling belong in
the root manifest. Keep runtime dependencies in their owning workspace.

- `bun run dev:web`: start the Vite frontend on port 5173.
- `bun run dev:server`: start the Bun bridge with hot reload.
- `bun run build`: build frontend assets and the default standalone server binary.
- `bun run build:linux-x64`: build the Linux x86-64 standalone binary.
- `bun run build:darwin-arm64`: build the macOS Apple Silicon binary.
- `bun run package:linux-x64`: build and emit both versioned and latest `tar.xz`
  archives and checksums in `dist/`.
- `bun run package:linux-arm64`, `package:darwin-x64`,
  `package:darwin-arm64`, `package:windows-x64`, and
  `package:windows-arm64`: package the other supported release targets.
- `bun run format [paths...]`: format the given paths with the pinned root
  Biome config, or all supported files when no paths are given.
- `bun run format:check [paths...]`: check formatting with the same path scope.
- `bun run lint`: lint all TypeScript and React code with a local content cache.
- `bun run test`: run the full Bun suite, including integration and browser tests.
- `bun run test:quick`: run the suite without the Chrome-based browser test
  files for local feedback; this still includes server integration tests.
- `bun run test:browser`: run the Chrome-based browser regressions separately.
- `bun run typecheck`: build/embed web assets and run all TypeScript checks.
- `bun run typecheck:quick`: check types without rebuilding existing web assets.
  See [local validation](CONTRIBUTING.md#validation) for prerequisites and caching.
- `bun run precommit`: run formatting, lint, type checks, and unit tests.

## Coding Style & Naming Conventions

Use TypeScript, React function components, and the existing CSS class naming
style. Format supported files with the root `biome.json`; do not rely on a
global or editor fallback formatter. Prefer small, focused components in
`web/src/components`. Keep manual edits ASCII unless the file already uses
non-ASCII text. Use existing store and bridge helpers before adding new
abstractions.

## Documentation Guidelines

Keep `README.md` concise and English-only. Use it as the project entry point and
link to focused documents instead of embedding detailed operation or
implementation material. Put the feature tour and shortcuts in `FEATURES.md`,
deployment and configuration instructions in `docs/DEPLOYMENT.md`, and system
contracts in `docs/ARCHITECTURE.md`. Permanent docs describe current supported
behavior and contracts, not task status, plans, phases, dated verification logs,
or agent transcripts; keep those details in PRs, external artifacts, or Git
history. Add a focused document only when an enduring topic cannot fit an
existing home. Keep one canonical home per topic and link to it. When finishing
work, consolidate or delete stale status documents and repair their links.

## Testing Guidelines

Tests live beside their modules as `*.test.ts` and use `bun:test`. During local
iteration, run a related file with `bun test <path>` or use `bun run test:quick`.
Process-level tests need generated web assets; on a fresh checkout, run
`bun run typecheck` once after installing dependencies to generate them. Browser
tests require Chrome/Chromium (or `CHROME_BIN`) and skip when it is unavailable.
Use Bun's fake timers for timer deadlines and events for socket readiness rather
than waiting out production timeouts; restore real timers in `finally`.
Run `bun run precommit` before committing; the quick suite does not replace it.
The installed pre-commit hook runs this gate, so do not also run it manually
immediately before committing an unchanged revision. See the iteration workflow
in [local validation](CONTRIBUTING.md#validation).
For frontend-facing work, also run `bun run build:web`. Release work must package
and inspect every supported platform archive and checksum.

## Commit & Pull Request Guidelines

Git history uses concise imperative messages, for example `Use built-in CLI
argument parser` or `Add command palette and release 0.0.3`. Keep commits
focused and mention user-visible behavior in the message when relevant. PR
descriptions should include a short summary and verification commands. For UI
changes, upload screenshots as GitHub attachments and embed them in the PR
description. Do not commit screenshot files to the repository solely for PR
review.

## Release Notes

GitHub Releases is the canonical release history. Notes are generated by GitHub
from merged pull requests using `--generate-notes` and the categories in
`.github/release.yml`; keep PR titles and labels accurate instead of maintaining
a shared release-log file. Preserve migration, security, breaking-change,
data-loss, and platform-compatibility guidance in permanent documentation linked
from the release notes. Leave detailed records in PRs, external artifacts, or
Git history.

Stable releases use separate prepare and publish phases:

1. Run the **Prepare Release** workflow with `X.Y.Z` or
   `patch`/`minor`/`major`. It updates the three `package.json` versions plus
   `herdr-plugin.toml` and opens a normal release PR.
   Review that PR and select **Approve workflows to run** to start CI for the
   bot-created PR. Wait for its checks to pass before merging; the workflow
   never merges or tags on its own.
2. Run the **Publish Release** workflow with the merged `X.Y.Z` version. It
   finds and verifies the matching release commit on `main`, creates the
   annotated `vX.Y.Z` tag there, and starts `.github/workflows/release.yml` on
   that tag, which publishes the GitHub release with generated notes.

For local preparation, `bun run release:prepare <X.Y.Z | patch | minor | major>`
updates the release files without committing, tagging, or pushing. Submit those
changes through a normal PR because direct pushes to `main` are not allowed.
