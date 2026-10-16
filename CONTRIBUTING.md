# Contributing

## Development Setup

Use Bun 1.4.3+, Node ^20.19.0 or >=22.12.0 (for Vite 8), and a running local
Herdr server:

```bash
bun install --frozen-lockfile
bun run install-hooks
# Run in separate terminals:
bun run dev:server
bun run dev:web
```

Open <http://localhost:5173>. Vite proxies `/api`, `/ws`, and `/login` to the dev
bridge on `127.0.0.1:8788` (services and `start:server` use 8787). `dev:server`
runs in development mode, so loopback needs no login. To test authentication,
run `NODE_ENV=production bun run start:server`. Never forward a development
listener; see [Security](./SECURITY.md#trust-model).

`bun.lock` is the only lockfile. Shared tooling belongs in the root manifest and
runtime dependencies in the `web` or `server` workspace. Commit manifest and
lockfile changes together.

## Validation

On a fresh checkout, run `bun run typecheck` once to generate the web assets that
process-level tests need. Then iterate with focused checks:

| Check | Command |
| --- | --- |
| Format | `bun run format <paths...>` or `bun run format:check` |
| Types | `bun run typecheck:quick` (no asset rebuild) |
| Lint | `bun run lint` (Oxlint; rules in `.oxlintrc.json`) |
| Tests | `bun test <path>`, `bun run test` (serial), or `bun run test:quick` (four workers) |
| Frontend build | `bun run build:web` (required for frontend changes) |

The pre-commit hook runs lint and `bun run typecheck:bun` (Bun's native
`bun check` across the root, web, and server projects). Let it run instead of
repeating it manually; without the hook, run both yourself. Never bypass it. Run
formatting and related tests separately.

PR CI runs format, lint, types, the site build, and the full `test:quick` suite.
Releases run `bun run precommit` and must package and inspect every platform
archive and checksum; see [builds](docs/DEPLOYMENT.md#build-a-standalone-executable)
and the [release policy](AGENTS.md#release-notes).

### Manual browser checks

Automated tests do not launch browsers. For affected UI, check against a real
backend and record the device/browser and results in the PR:

- Dialog focus and keyboard navigation, scaled layouts, and HTML preview
  isolation (CSP, direct navigation).
- iOS Safari and Android Chrome: keyboard open/close, IME, selecting while output
  streams, and landscape/scaled menus.
- Connection recovery, notifications with the page closed, and server-side
  settings changes.
- Two tabs on the same origin: preferences sync without reload, while workspace,
  files, drafts, and focus stay independent.

### Windows SSH end-to-end test

This opt-in test needs a disposable bridge (allowing unauthenticated loopback
WebSockets, such as a dev server) and two Windows profiles connected to dedicated
Herdr 0.9.1+ sessions named `roamgate-ssh-*`, each with a PowerShell pane. Close
browser viewers first. It sends commands, resizes, and reconnects, so **never
point it at real sessions**:

```bash
ROAMGATE_LIVE_WINDOWS_SSH_URL=http://127.0.0.1:8788 \
ROAMGATE_LIVE_WINDOWS_SSH_SESSION=roamgate-ssh-e2e \
ROAMGATE_LIVE_WINDOWS_SSH_OTHER_SESSION=roamgate-ssh-other \
bun test server/src/connections/windows-ssh-live.test.ts
```

## Security Checks and Dependency Updates

- **CodeQL** scans JavaScript/TypeScript and GitHub Actions on PRs, pushes to
  `main`, and weekly. Use `pull_request`, never `pull_request_target`, for
  untrusted code.
- **Dependency Audit** (`bun run audit`) checks `bun.lock` on dependency PRs and
  weekly. High/critical findings fail. Fix findings in a PR; do not suppress them.
- **Dependabot** opens weekly grouped minor/patch PRs; majors are separate.
  Nothing auto-merges.

When reviewing updates:

- Review `@xterm/xterm` and `@xterm/addon-fit` together and check terminal
  rendering, sizing, input, and touch scrolling.
- CodeMirror/Lezer, diff2html/highlight.js, and Radix/cmdk are coupled: check the
  lockfile for duplicate copies and run the highlighting and overlay tests. Use a
  targeted `bun update '<pkg>' --filter roamgate-web` if transitive versions need
  refreshing.
- The root `highlight.js` override keeps diff2html aligned with the directly
  imported grammar; update it together with `web/package.json`.
- Treat major build-tool upgrades as migrations: keep the browser target,
  lazy-loading boundaries, and asset size budgets. A failing check means fix the
  update, not disable the check.

## Style Organization

| Path under `web/src/` | Responsibility |
| --- | --- |
| `styles/tokens.css` | Theme variables (`:root`, `data-theme`, `data-accent`) |
| `styles/base.css` | Resets and shared primitives: modals, forms, badges, panels |
| `styles/vendor.css` | Shared syntax/diff overrides |
| `styles/layout/*.css` | App-shell regions, imported once by `App.tsx` |
| `components/<Name>.css` | Component styles, imported and deleted with the component |

Prefix classes with the component name and keep media queries beside their
rules. Lazily loaded features must import the shared styles they need rather
than rely on another feature having loaded them.

## Pages Website and Tutorial

Edit `site/` for the landing page and **only `docs/TUTORIAL.md`** for tutorial
text. `scripts/build-pages.ts` renders the tutorial and checks links in
`.pages-dist/`:

```bash
bun test scripts/pages-content.test.ts scripts/pages-workflow.test.ts
bun run build:site
```

Serve `.pages-dist/` to check `/tutorial/`, narrow layouts, and keyboard
navigation. Never commit generated output. **Deploy Pages** runs on pushes to
`main` and requires a published Latest release. For product images, follow the
[screenshot workflow](docs/SCREENSHOTS.md).

## Pull Requests

Use focused, imperative commits. PR descriptions cover behavior, verification,
and compatibility impact. Screenshots are not required for UI changes unless
requested; never commit them just for review. Keep generated assets and binaries
out of Git.

Unlabeled PRs are labeled automatically (`documentation`, `dependencies`, `bug`,
or `enhancement`); correct the label before merging if needed. Contributions are
MIT-licensed.
