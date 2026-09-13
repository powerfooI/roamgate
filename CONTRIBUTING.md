# Contributing

## Development Setup

Install Bun 1.4.1 or newer (CI uses 1.4.1), start a local Herdr server, then
install all workspace dependencies from the repository root:

```bash
bun install --frozen-lockfile
```

The root `bun.lock` is the only dependency lockfile. Shared development tools
(TypeScript, Bun types, formatting, and linting) belong in the root manifest;
browser dependencies and Vite belong in `web/package.json`. Keep server-only
runtime dependencies in `server/package.json`. After changing dependencies,
run `bun install` at the root and commit the updated manifest and lockfile.

Run the bridge and frontend in separate terminals:

```bash
bun run dev:server
bun run dev:web
```

## Validation

Before submitting a change, run:

```bash
bun run precommit
```

Individual workspace checks remain available as
`bun run --filter roamgate-web typecheck` and
`bun run --filter roamgate-server typecheck`. The server check builds and embeds
the frontend first, so it also works before any generated assets exist.

Use `bun run build` for changes that affect production assets or server
bundling. Release changes should also validate the relevant
`package:<platform>` command.

## Pages Website and Tutorial

The landing page lives in `site/`. The tutorial has one canonical
source, `docs/TUTORIAL.md`; `scripts/build-pages.ts` renders it into the
`site/tutorial/index.html` template, rewrites shared screenshots and reference
links, and validates local links and fragments throughout the built site.
Do not duplicate the tutorial body in the HTML template.

```bash
bun test scripts/pages-content.test.ts
bun run build:site
```

Serve `.pages-dist/` with a local static HTTP server and open `/tutorial/`.
Also check deployment beneath the `/roamgate/` Pages subpath, narrow-screen
layouts, keyboard navigation, and reading with JavaScript disabled. Generated
`.pages-dist/` files must not be committed.

Pages deployment is manual so a website update cannot advertise an unpublished
installer. Publish a Roamgate release as GitHub Latest first, then dispatch
**Deploy Pages** on `main` from GitHub Actions. The workflow checks the live
`install-roamgate.sh` URL before uploading the site; missing assets, HTTP errors,
and network failures block deployment. A source build alone does not satisfy
this gate. After a repository rename, align the site's installer URL and the
workflow check before dispatching.

## Pull Requests

Keep commits focused and use short imperative commit messages. Describe the
user-visible behavior, verification performed, and compatibility impact.
Include screenshots for interface changes. Avoid committing generated
artifacts from `dist/`, `server/public/`, or compiled binaries.

Pull requests without a release-note category label are labeled automatically:
documentation-only changes become `documentation`, dependency updates become
`dependencies`, fix-oriented titles become `bug`, and other code changes become
`enhancement`. Release preparation PRs receive `skip-changelog`. Add one of the
categories from `.github/release.yml` before merging to override the automatic
choice.

By contributing, you agree that your contribution is licensed under the MIT
License.
