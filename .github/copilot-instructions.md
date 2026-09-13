# Copilot Instructions

## Project overview

Roamgate is an independent community Web and PWA client for Herdr. It has two parts:

- `server/src`: Bun-powered local bridge server (HTTP + WebSocket) that talks
  to the local Herdr socket.
- `web/src`: React + Vite frontend dashboard. Reusable UI lives in
  `web/src/components`, assets in `web/src/assets`, global styling in
  `web/src/styles.css`.
- `scripts/`: release and packaging helpers.

Generated build output lives in `server/public`,
`server/src/public-files.gen.ts`, `server/roamgate*`, legacy `server/herdr-gui*`,
and `dist/`. These are
build artifacts; they must not be edited or committed.

## Review priorities

When reviewing pull requests, focus on:

- Correctness of the Bun bridge: HTTP/WebSocket message handling, socket
  lifecycle, reconnection and error paths, and cleanup of listeners, timers,
  and subprocesses.
- React state management: prefer the existing store and bridge helpers in
  `web/src` over new abstractions; watch for missing effect cleanup and stale
  closures over socket state.
- Security: the server runs locally by default but can bind to a non-loopback
  address; it also executes local processes. Flag any path traversal,
  unvalidated message payloads, or injection-prone command construction.
- Cross-platform behavior: releases target linux-x64, linux-arm64,
  darwin-x64, darwin-arm64, windows-x64, and windows-arm64; avoid OS-specific
  assumptions in shared code.

## Style and conventions

- Use TypeScript for application code; use React function components; keep components
  small and focused under `web/src/components`.
- Formatting is enforced by the root `biome.json` (2-space indent, LF, double
  quotes, semicolons, trailing commas). Do not suggest style changes that
  conflict with it.
- Keep edits ASCII unless the file already contains non-ASCII text.
- Use the existing CSS class naming style; no CSS-in-JS or new styling
  systems.

## Verification

Install all workspace dependencies once with `bun install --frozen-lockfile`
from the repo root. The root `bun.lock` is authoritative.

Changes are expected to pass, from the repo root:

- `bun run format:check`
- `bun run lint`
- `bun run test`
- `bun run typecheck`
- For frontend-facing changes: `bun run build:web`

Call out missing verification when a PR touches these areas without it.
