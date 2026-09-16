# Roamgate

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./site/assets/roamgate-lockup-on-charcoal.png" />
    <img src="./site/assets/roamgate-lockup-charcoal.png" alt="Roamgate logo" width="400" />
  </picture>
</p>

A **browser client** for [Herdr](https://herdr.dev). Control terminals, inspect
agent sessions, and review files and diffs on desktop or mobile.
**Requires a running Herdr server.**

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

> **Moving from Herdr Studio / herdr-gui?** Automatic upgrades are not supported.
> Follow the [migration guide](./docs/DEPLOYMENT.md#transition-from-herdr-studio--herdr-gui)
> to install Roamgate manually.

## Quick start

1. Install and start [Herdr](https://herdr.dev), or let Roamgate install and
   start it later with `roamgate herdr setup`.
2. On Linux or macOS, install Roamgate:

   ```bash
   # Empty selects latest; use X.Y.Z (no v prefix) to pin a Roamgate version.
   curl -fsSL \
     https://github.com/powerfooI/roamgate/releases/latest/download/install-roamgate.sh \
     | ROAMGATE_VERSION= sh
   ```

   On Windows, download the matching x64 or ARM64 archive from the
   [latest release](https://github.com/powerfooI/roamgate/releases/latest).
3. On Linux/macOS, add `~/.local/bin` to `PATH` and run `roamgate`.
   On Windows, extract the archive and run `roamgate.exe`. Open the printed URL.

See [deployment](./docs/DEPLOYMENT.md) for checksums, configuration, updates,
and services, or [historical installation](./docs/DEPLOYMENT.md#install-historical-herdr-studio)
for `herdr-gui` 0.6.2.

## Install as a PWA

**PWA installation is recommended for daily use:** a separate app window without
browser tabs or the address bar. Open and authenticate with Roamgate, then install:

- **iPhone/iPad Safari:** Share -> Add to Home Screen.
- **macOS Safari 17+:** File -> Add to Dock.
- **Chrome/Edge:** browser menu -> Install app.

The process must stay running and reachable. **PWA mode is not offline access.**

## Documentation

- [Website](https://roamgate.dev/) and
  [hands-on tutorial](https://roamgate.dev/tutorial/)
  ([Markdown](./docs/TUTORIAL.md)): local work, mobile, and private remote access.
- [Features and shortcuts](./FEATURES.md)
- [Deployment](./docs/DEPLOYMENT.md): installation, configuration, services, builds.
- [Architecture](./docs/ARCHITECTURE.md): system contracts.
- [Security](./SECURITY.md) and [contributing](./CONTRIBUTING.md).

## Development

Use Bun 1.4.1 or newer and a running Herdr server:

```bash
bun install --frozen-lockfile
# Run in separate terminals:
bun run dev:server
bun run dev:web
```

Open <http://localhost:5173>. See [CONTRIBUTING.md](./CONTRIBUTING.md) for checks
and pull requests.

## Security

Roamgate controls terminals and modifies real files. Keep the default loopback
binding; read [SECURITY.md](./SECURITY.md) before allowing another device access.

## License

Code: [MIT](./LICENSE). Bundled fonts and brand assets retain their original
terms; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
