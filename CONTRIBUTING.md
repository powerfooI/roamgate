# Contributing

## Development Setup

Use Bun 1.4.1+ (CI: 1.4.1), Node ^20.19.0 or >=22.12.0 for Vite 8,
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

## Security Checks and Dependency Updates

CodeQL runs the default JavaScript/TypeScript and GitHub Actions query suites on
PRs targeting `main`, pushes to `main`, weekly, and by manual dispatch. It reads
source without building the app or installing dependencies. Only the analysis
job can upload code-scanning results; checkout credentials are not persisted.
Use the `pull_request` event for fork and Dependabot analysis, never
`pull_request_target` with untrusted code. If GitHub's CodeQL default setup is
already enabled, a maintainer must resolve the
[default/advanced setup conflict](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/troubleshoot-sarif-uploads/default-setup-enabled)
before this workflow can upload results.

Dependency Audit runs on dependency/config changes in PRs, weekly on the default
branch, and by manual dispatch. Run the same check locally with `bun run audit`.
It audits the root `bun.lock`, including development dependencies, without
installing packages, executing lifecycle scripts, or changing dependencies.
The JSON log includes all reported severities; high/critical findings and
registry request failures return a failing exit code. Review lower-severity
findings too. Fix findings in a reviewed PR; do not hide them with ignored
advisories or a blanket successful exit. This path-filtered workflow is not an
always-running required check for unrelated PRs.

Dependabot checks the Bun workspace and SHA-pinned GitHub Actions weekly with
small open-PR limits. Minor/patch updates are grouped by package family; major
upgrades remain separate except for the coupled `@xterm/xterm` and
`@xterm/addon-fit` pair. This pair has its own unfiltered group because
Dependabot's minor/patch filters do not match same-core beta increments. Review
all updates to this pair together, including future major upgrades, and check
terminal rendering, sizing, input, and touch scrolling. Other xterm addons keep
the usual minor/patch grouping. Update PRs require normal review and validation;
nothing auto-merges. Bun version updates do not provide Dependabot security
updates, so retain the scheduled audit for newly published advisories against an
unchanged lockfile.

Coupled runtime packages must be reviewed as a resolved graph, not just direct
manifest bumps. CodeMirror/Lezer, diff2html/highlight.js, and Radix/cmdk have
separate minor/patch groups. Groups collect eligible updates; they do not force
transitive upgrades or override exact upstream pins. After a grouped update,
inspect the lockfile for duplicate runtime copies and run the highlighting and
overlay regression tests. Use a targeted `bun update '@lezer/highlight' --filter
roamgate-web` or `bun update '@radix-ui/*' --filter roamgate-web` when compatible
transitive dependencies need refreshing, then review the resulting diff. Do not
refresh unrelated packages or raise asset limits to make an update pass.

Major build-tool upgrades remain individually reviewed migrations. Preserve the
browser target and lazy-loading boundaries, validate worker initialization and
the built asset graph, and keep the existing size/count budgets. A failing CI
check is a signal to repair or review the update, not to disable the check.

The root highlight.js override keeps diff2html's optional, exact-pinned runtime
aligned with the directly imported extra grammar. Update it together with
`web/package.json` and validate the syntax tests; remove the override when
upstream diff2html accepts the supported version. Do not upgrade only the direct
manifest entry while leaving the renderer on its old transitive version.

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

For repeatable product images, use the [screenshot workflow](docs/SCREENSHOTS.md)
with an independent clone of the public
[Northstar demo](https://github.com/powerfooI/northstar-demo).

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
