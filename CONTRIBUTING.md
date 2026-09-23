# Contributing

## Development Setup

Use Bun 1.4.1+ (CI: 1.4.1), Node ^20.19.0 or >=22.12.0 for Vite 7,
and a running local Herdr server:

```bash
bun install --frozen-lockfile
bun run install-hooks
# Run in separate terminals:
bun run dev:server
bun run dev:web
```

Open <http://localhost:5173>. Vite proxies `/api`, `/ws`, and `/login` to the dev
bridge at `127.0.0.1:8788`; installed services and `start:server` default to 8787.

Keep the only lockfile (`bun.lock`) and shared tooling at root; runtime
dependencies belong in their web/server workspace. After changes, run root
`bun install` and commit manifests/lockfile.

## Validation

**Fresh checkout:** run `bun run typecheck` once to generate web assets needed by
process tests. Then use focused checks while iterating:

| Check | Command / limits |
| --- | --- |
| Format | `bun run format <paths...>` or `format:check`; omit paths for the whole repo. |
| Types | `bun run typecheck:quick` checks scripts/web/server without rebuilding assets or checking production bundles. |
| Lint | `bun run lint` runs Oxlint without a cache. Rule/scope regression checks: `bun test scripts/lint.test.ts`. |
| Tests | `bun test <path>`, `bun run test` (serial), or `bun run test:quick` (four workers). Both full-suite commands include unit and server integration tests. |
| Submission | `bun run precommit`: formatting, lint, full typechecks, and `test:quick`. |

Oxlint's explicit rules live in `.oxlintrc.json`; formatting stays in Biome.
Existing `eslint-disable` comments are supported, including unused-directive
warnings. Declare globals in the config rather than inline `/* global */`
comments. Duplicate parameters remain checked by `no-redeclare` or the parser;
legacy octal literals in non-module JavaScript have no dedicated lint check.

The installed `.githooks/pre-commit` runs the full gate: let it run when committing
rather than repeating it manually on the same revision. Without the hook, run
`bun run precommit` before committing. Further edits require revalidation; never
bypass the gate.

PR CI runs format/lint/types, site build, and the complete `test:quick` suite.
Automated tests do not launch Chrome or WebKit. Browser-specific focus, layout,
input, accessibility, and security enforcement require manual validation against
a real backend for affected changes:

- Check dialog focus/keyboard navigation, scaled layout, and HTML preview
  iframe/direct-navigation isolation, including workspace assets and CSP.

- On iOS Safari and Android Chrome, check keyboard opening/dismissal, IME,
  selection/copy while output streams, and short-landscape/scaled menu bounds.
  Check mixed mouse/touch input on actual hybrid hardware.
- Exercise connection recovery and profile controls, notification permission and
  delivery with the page closed, and settings/integration changes on the server.
- Check desktop focus after app switching, OS clipboard/rectangular selection,
  and responsiveness during sustained terminal output and real network latency.

Record device/browser and results in the PR. Passing unit and server integration
tests does not establish browser behavior or real-user-experience acceptance.

Workspace types: `bun run --filter roamgate-web typecheck` or
`bun run --filter roamgate-server typecheck` (builds web assets first).
Frontend changes also need `bun run build:web`; bundling needs `bun run build`.
Releases must package/inspect every supported archive/checksum; see
[builds](docs/DEPLOYMENT.md#build-a-standalone-executable) and
[release policy](AGENTS.md#release-notes).

## Style Organization

| Path under `web/src/` | Responsibility |
| --- | --- |
| `styles/tokens.css` | Theme variables (`:root`, `data-theme`, `data-accent`) |
| `styles/base.css` | Resets/shared primitives: modals, forms, badges, statuses, panels, loading |
| `styles/vendor.css` | Shared syntax/diff overrides; consumer-specific overrides stay with components |
| `styles/layout/*.css` | App-shell regions, imported once by `App.tsx` |
| `components/<Name>.css` | Component-owned styles, imported/deleted with the component; same for `components/ui/` |

Prefix classes with the component name; keep media queries beside their rules,
not in a separate mobile stylesheet. Shell/Suspense fallback styles must load
before lazy content. Independently loaded features need explicit shared imports
or global base styles; never depend on another feature having opened. Shared
co-located CSS is valid when static imports cover every rendering path.

## Pages Website and Tutorial

Edit `site/` for the landing page; **only `docs/TUTORIAL.md`** for tutorial text.
`scripts/build-pages.ts` renders the tutorial template, rewrites references, and
checks links/fragments in `.pages-dist/`:

```bash
bun test scripts/pages-content.test.ts scripts/pages-workflow.test.ts
bun run build:site
```

Serve `.pages-dist/` to check `/tutorial/`, narrow layouts, keyboard navigation,
and JavaScript-disabled reading. Canonical/social/sitemap URLs use
<https://roamgate.dev/>. Never commit generated output.

**Deploy Pages** runs on `main` pushes or manual retry. Upload requires a published
Roamgate release as GitHub Latest; the installer probe blocks missing assets,
HTTP/network failures, and source-only builds. After repo renames, align the
site installer URL and workflow probe.

## Pull Requests

Use focused imperative commits. PRs describe behavior, verification, and
compatibility impact. Screenshots are not required for UI changes; capture or
upload them only when explicitly requested. Do not commit screenshots solely for
PR review. Keep generated assets/binaries out of Git.

Unlabeled PRs receive `documentation`, `dependencies`, `bug` (fix titles), or
`enhancement`; release preparation uses `skip-changelog`. Override with a
`.github/release.yml` category before merging. Contributions are MIT-licensed.
