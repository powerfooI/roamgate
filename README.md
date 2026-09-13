# Roamgate

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./site/assets/roamgate-lockup-on-charcoal.png" />
    <img src="./site/assets/roamgate-lockup-charcoal.png" alt="Roamgate logo" width="400" />
  </picture>
</p>

An independent, community-built **Web and PWA client** for
[Herdr](https://herdr.dev). Access terminals, inspect agent sessions, and review
files and diffs from desktop or mobile. A running Herdr server is required.

> **Breaking change from Herdr Studio / herdr-gui:** install Roamgate manually.
> Old clients cannot upgrade to Roamgate through their default update channel.
> Existing processes and historical releases are left intact. Read the
> [transition guide](./docs/DEPLOYMENT.md#transition-from-herdr-studio--herdr-gui)
> before switching an existing service. Source builds migrate data and use new
> service/plugin identities; published 0.7.0 still uses the legacy identities.

## Documentation

- [Project website](https://powerfooI.github.io/roamgate/)
- [Hands-on tutorial](https://powerfooI.github.io/roamgate/tutorial/)
  ([Markdown](./docs/TUTORIAL.md)): first steps, review workflows, mobile, and
  private remote access with Tailscale, SSH, or Tailcat.
- [Feature tour and keyboard shortcuts](./FEATURES.md)
- [Installation, configuration, services, and builds](./docs/DEPLOYMENT.md)
- [Architecture and implementation](./docs/ARCHITECTURE.md)
- [Security guidance](./SECURITY.md)
- [Contributing](./CONTRIBUTING.md)

## Screenshots

### Desktop

[![Desktop workspace with live terminals and image changes][desktop-changes]][desktop-changes]

Workspace terminals with changed files and image previews.

<!-- markdownlint-disable MD033 -->

<table width="100%">
  <thead>
    <tr>
      <th width="50%" align="center">File explorer</th>
      <th width="50%" align="center">Diff annotations</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td width="50%" align="center" valign="top">
        <a href="./docs/images/roamgate-desktop-files.png"><img src="./docs/images/roamgate-desktop-files.png" alt="Desktop file explorer" width="100%" /></a>
      </td>
      <td width="50%" align="center" valign="top">
        <a href="./docs/images/roamgate-desktop-annotations.png"><img src="./docs/images/roamgate-desktop-annotations.png" alt="Desktop diff annotations" width="100%" /></a>
      </td>
    </tr>
  </tbody>
</table>

### Mobile

<table width="100%">
  <thead>
    <tr>
      <th width="33.33%" align="center">Changed files</th>
      <th width="33.33%" align="center">Full terminal control</th>
      <th width="33.33%" align="center">File viewer</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td width="33.33%" align="center" valign="top">
        <a href="./docs/images/roamgate-mobile-changes.png"><img src="./docs/images/roamgate-mobile-changes.png" alt="Mobile changed files viewer" width="100%" /></a>
      </td>
      <td width="33.33%" align="center" valign="top">
        <a href="./docs/images/roamgate-mobile-terminal.png"><img src="./docs/images/roamgate-mobile-terminal.png" alt="Mobile terminal" width="100%" /></a>
      </td>
      <td width="33.33%" align="center" valign="top">
        <a href="./docs/images/roamgate-mobile-files.png"><img src="./docs/images/roamgate-mobile-files.png" alt="Mobile file viewer" width="100%" /></a>
      </td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-enable MD033 -->

Click any screenshot to open the full-resolution image.

[desktop-changes]: ./docs/images/roamgate-desktop-changes.png

## Quick start

Need the existing Herdr Studio release? The legacy installer remains available;
follow [historical installation](./docs/DEPLOYMENT.md#install-historical-herdr-studio)
to install `herdr-gui` 0.6.2 instead of Roamgate.

Herdr must already be installed and running. Install the latest Roamgate
standalone binary with:

```bash
# Leave empty for latest; set ROAMGATE_VERSION=X.Y.Z for a Roamgate version (no v prefix).
curl -fsSL \
  https://github.com/powerfooI/roamgate/releases/latest/download/install-roamgate.sh \
  | ROAMGATE_VERSION= sh
```

Make sure `~/.local/bin` is in `PATH`, then start the application:

```bash
roamgate
```

Open the URL printed by the process. On Windows, download the matching x64 or
ARM64 archive from the
[latest release](https://github.com/powerfooI/roamgate/releases/latest)
instead of running the script. See the
[deployment guide](./docs/DEPLOYMENT.md) for checksum verification,
fixed-version installation, authentication, remote connections, updates, and
user-service setup.

## Install as a PWA

For day-to-day use, install Roamgate as a standalone web app after starting
and authenticating with `roamgate`:

- **iPhone or iPad (Safari):** **Share** -> **Add to Home Screen**.
- **macOS (Safari 17+):** **File** -> **Add to Dock**.
- **Chrome or Edge:** choose **Install app** from the browser menu.

The installed app still requires the `roamgate` process to be running and
reachable; PWA mode does not provide offline access.

## Development

Source builds require [Bun](https://bun.sh) 1.4.1 or newer. Start the bridge and
frontend in separate terminals:

```bash
bun install --frozen-lockfile

bun run dev:server
bun run dev:web
```

Open <http://localhost:5173>. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the
validation commands and pull request guidelines.

## Security

Roamgate can control terminal sessions and modify workspace files. Keep the
default loopback binding unless you understand the trust boundary. Read
[SECURITY.md](./SECURITY.md) before exposing the service to another device.

## License

The project code is available under the [MIT License](./LICENSE). Bundled fonts
and brand assets retain their original terms; see
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
