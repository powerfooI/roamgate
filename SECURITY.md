# Security Policy

## Supported Versions

Security fixes cover the latest release.

## Reporting a Vulnerability

**Do not open a public issue.** Use a private repository security advisory with
versions, reproduction steps, and impact. If unavailable, use the maintainer's
GitHub-profile contact address.

## Trust Model

**UI access grants the Roamgate user's authority:** terminals, repository hooks,
session data, and workspace uploads/deletions. This is privileged administration,
not a sandbox or multi-user permission system.

The default bind is `127.0.0.1`. **Normal runtime requires login**, including
loopback. The only exception is `NODE_ENV=development` with the bind address
exactly `127.0.0.1`, `localhost`, or `::1`: those development listeners bypass
Roamgate authentication, including access through a reverse proxy or tunnel.
`dev:server` enables this local development mode; `start:server` and installed
services do not enable it by default. Do not forward a development listener for
remote access.

When authentication is enabled, set `ROAMGATE_PASSWORD` to a unique password
of 15-1024 Unicode characters; there are no required character combinations.
Configured passwords outside that range stop startup, including existing short
passwords. Without a configured password, an authenticated listener uses a
persistent 256-bit random token and reports its protected file path. Read that
file to log in, or use `--open` to open a token URL automatically. Service
installation and URL tools can also provide token URLs; keep them private.

Password login (`POST /api/login`) and token-URL login share limits by the
connection's source IP: at most 20 attempts per 60-second window, and five
consecutive failures trigger a five-minute cooldown. Successful login clears
the failure count, and failures start counting again after cooldown expires.
Rate-limited attempts return `429` with `Retry-After`. Login JSON bodies are
limited to 16 KiB of actual streamed bytes; oversized bodies return `413`.

IP records expire after five minutes without an attempt and are removed on the
next login attempt. Without new attempts, expired records remain within the
same bounded table. The bridge keeps at
most 4096 active IP records; when full, it returns `429` for new IPs instead of
evicting active cooldowns. This state belongs to one process and resets when
the bridge restarts. Forwarded IP headers are not trusted: clients behind a
reverse proxy or tunnel share its connection-IP limits. Use the proxy's own
limits when per-client enforcement is needed.

**Do not expose Roamgate directly to the public internet.** For remote access:

- Prefer `ROAMGATE_PASSWORD` to `--password`, which exposes
  secrets in process arguments.
- Use [native HTTPS](docs/DEPLOYMENT.md#native-https), an HTTPS proxy, or a trusted
  VPN; restrict access with a firewall/reverse proxy.
- Treat worktree hooks as executable code.

The bridge checks neither browser Origin nor request Host. Any request reaching
it and passing required authentication has full authority. Secure the outer
access path: native TLS encrypts transport but supplies no multi-user
authorization or sandboxing. Without TLS configuration, the listener
uses unencrypted HTTP.

**Menu > Log out** removes this browser's authentication cookie, disconnects its
active tabs, and returns to login. It does not stop terminals, change the server
password/token, or log out other browsers. Cookies are stateless signed
credentials: logout removes the browser's copy, but does not revoke a copied
cookie before its expiry. Rotate the server credential if it or a session cookie
has been compromised.

Updates trust the configured HTTPS release origin (or explicit loopback test
mirror) and its manifest/checksums. Checksums detect corruption and bind the
archive, **not independently verify publisher identity**. Custom mirrors are
trusted executable-code infrastructure.

`HERDR_GUI_*` aliases `ROAMGATE_*`; explicit new values win, even empty ones.
Auth-token migration preserves the old secret. Protect both copies and backups;
see [migration and rotation](./docs/DEPLOYMENT.md#transition-from-herdr-studio--herdr-gui).
Update requests require normal listener authentication plus `x-roamgate-update: 1`.
Legacy `x-herdr-gui-update: 1` is accepted; the new header wins if both appear.
Neither header replaces login.

Web Push subscription mutations require listener authentication, JSON, and
`x-roamgate-push: 1`; cross-site browser requests are rejected. Push endpoints
are restricted to supported browser-provider HTTPS hosts and are never followed
through redirects. Treat the private push registry as credentials. Revoking a
login password or logging out does not revoke device subscriptions: disable Web Push or remove
subscriptions separately. Notification payloads can expose agent names and
routing IDs on lock screens. See [Web Push configuration](docs/DEPLOYMENT.md#web-push-notifications).
