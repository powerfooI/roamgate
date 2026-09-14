# Contributing

## Development Setup

1. Install Bun 1.4.1 or newer (CI uses 1.4.1) and start a local Herdr server.
2. From the repository root, run `bun install --frozen-lockfile`.
3. Run these in separate terminals, then open <http://localhost:5173>:

   ```bash
   bun run dev:server
   bun run dev:web
   ```

Keep `bun.lock` (the only lockfile) and shared tools (TypeScript, Bun types,
formatting/linting) at root; browser/Vite dependencies in `web/package.json`;
server runtime dependencies in `server/package.json`. After dependency changes,
run root `bun install` and commit manifests/lockfile.

## Validation

**Fresh checkout:** install dependencies, then `bun run typecheck` to build/embed
assets required by server typechecks and process tests.

| During iteration | Command / limits |
| --- | --- |
| Types | `bun run typecheck:quick` checks root scripts, web, and server without rebuilding assets or validating production bundles. |
| Lint | `bun run lint` caches unchanged content in `node_modules/.cache/eslint/`. Use `bun run lint --no-cache` for fresh checks after tooling/dependency updates. |
| Related tests | `bun test <path>` or `bun run test:quick` (includes integration tests, excludes three Chrome-based files). |
| Browser regressions | `bun run test:browser`; requires Chrome/Chromium or `CHROME_BIN`, otherwise tests skip. |
| Submission | `bun run precommit` runs formatting, lint, full typechecks, and the full test suite. Quick checks do not replace it. |

Run `bun run install-hooks` once per clone to point Git at the tracked
`.githooks/` directory; its `pre-commit` hook runs `bun run precommit`.

Workspace checks: `bun run --filter roamgate-web typecheck` and
`bun run --filter roamgate-server typecheck` (builds/embeds web assets first).

Frontend changes: `bun run build:web`. Production assets/bundling: `bun run build`.
Releases: package and inspect every supported archive/checksum; see
[build commands](docs/DEPLOYMENT.md#build-a-standalone-executable) and
[release policy](AGENTS.md#release-notes).

## Pages Website and Tutorial

Edit `site/` for the landing page; **only `docs/TUTORIAL.md`** for tutorial text.
`scripts/build-pages.ts` renders into `site/tutorial/index.html`, rewrites
screenshots/references, and checks built-site links/fragments.

```bash
bun test scripts/pages-content.test.ts scripts/pages-workflow.test.ts
bun run build:site
```

Serve `.pages-dist/` locally and check `/tutorial/`, narrow screens, keyboard
navigation, and JavaScript-disabled reading. Production canonical URLs, social
images, and the sitemap use <https://roamgate.dev/>. Do not commit `.pages-dist/`.

**Deploy Pages** runs on pushes to `main` (including merged PRs); manual dispatch
remains available for retries. Both require a published Roamgate release as GitHub
Latest: the live installer probe blocks upload on missing assets, HTTP errors,
or network failures. Source builds do not qualify. After repository renames,
align the site's installer URL and workflow probe.

## Pull Requests

Use focused commits and short imperative messages. PRs describe behavior,
verification, compatibility impact, and UI screenshots. Do not commit generated
assets (`dist/`, `server/public/`) or binaries.

Unlabeled PRs get `documentation` (docs-only), `dependencies` (dependency updates),
`bug` (fix titles), or `enhancement` (other code). Release preparation gets
`skip-changelog`. Override with a `.github/release.yml` category before merging.

Contributions are licensed under MIT.
