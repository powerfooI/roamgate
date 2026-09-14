<!-- markdownlint-disable MD033 -->
<!-- Explicit anchors keep section links usable in both GitHub and Pages. -->

# From your first terminal to a workspace that travels

**Start Roamgate on the Herdr host and open its URL:** follow [chapter 1](#start).
Not installed? Use the [installation guide](./DEPLOYMENT.md#install-a-release).

Practice one task: **ask an agent to improve a README, review the changes, then
check from your phone.** No Git, SSH, or networking knowledge is needed to start.

> With both tools installed: chapter 1 takes about 5 minutes; chapters 1-3 about
> 25 minutes. Allow 15-25 more for remote access, excluding installation,
> approvals, and troubleshooting. Stop at any completion check.
>
> **This static Pages tutorial does not run Herdr or keep terminals alive.**
> You still need the Roamgate process.

## 1. Start here: see your own work locally

<a id="start"></a>

### Three names, three jobs

The browser reaches your agent through two services:

```text
Your browser / installed PWA
          |
          | HTTP + WebSocket
          v
Roamgate (command: roamgate)
          |
          | Herdr control and terminal-render sockets
          v
Herdr server -> workspace -> tab -> pane -> shell / agent
```

**Herdr owns terminals; Roamgate supplies the browser UI; agents remain CLIs.**
Roamgate neither provides models nor installs/signs in to Codex, Claude, Pi, or
other tools. Closing the browser leaves terminals running, but host sleep,
shutdown, or process exit can stop work.

The commands below use source-build identities. Published 0.7.0 still uses legacy
service/plugin names; read the [migration guide](./DEPLOYMENT.md#transition-from-herdr-studio--herdr-gui)
before changing an existing installation.

### Open your first workspace: about 5 minutes

1. Start Herdr with a trusted project open. See [herdr.dev](https://herdr.dev)
   for setup; Roamgate does not start it.
2. [Install Roamgate](./DEPLOYMENT.md#install-a-release). Standalone needs no Bun;
   Windows uses the matching x64/ARM64 archive and `roamgate.exe`. Alternatively,
   follow the [plugin setup](./DEPLOYMENT.md#herdr-plugin).
3. Start it on that computer:

   **Standalone:** leave this process running:

   ```bash
   roamgate
   ```

   **Plugin:** use its [startup action](./DEPLOYMENT.md#herdr-plugin) and obtain
   the login URL from the panel/command log. The plugin does not add `roamgate`
   to `PATH`; skip the standalone command.

4. Open the printed URL (including any token) on **the same computer**. Standalone
   defaults to `http://127.0.0.1:8787`. Select a workspace and idle shell pane;
   run `pwd` (`Get-Location` in PowerShell).

**You are done when:** terminal input shows your project directory. Get this
working before configuring remote access.

> **Check the listener:** standalone defaults to loopback and bypasses login
> even with a password configured. A new `roamgate service install` uses
> `0.0.0.0:8787` with a token; the plugin uses this service too.

![Desktop workspace with project navigation on the left, live terminals in the center, and changed files on the right](./images/roamgate-desktop-changes.png)

*Find the project and active pane. Screenshot menu positions can differ by release.*

### Learn this one hierarchy

| Object | What it is | Example in this exercise |
| --- | --- | --- |
| Workspace | A working environment, usually associated with a project directory | Your project repository |
| Tab | A layout within a workspace | A documentation tab |
| Pane | One terminal region within a tab | An agent on the left, tests on the right |
| Worktree | Another real checkout directory of the same Git repository | An isolated documentation branch |

**Splitting panes does not isolate files.** Terminals in the same directory
modify the same checkout; use chapter 3 for parallel changes.

## 2. Everyday work: verify what the agent changed

<a id="daily"></a>

### 2.1 Find the terminal you want to control

Open the command menu to search workspaces, files, tabs, panes, and agents;
enter `README.md` to open a project-relative path. Defaults differ by platform:
use [Keyboard Shortcuts](../FEATURES.md#keyboard-shortcuts) or interface menus.

1. Select your practice project and create a tab from its menu.
2. Split right from the pane actions menu (`Cmd+D` on macOS).
3. Start an installed, signed-in agent CLI on the left; keep a shell on the right.
4. Open the recent pane switcher (`Ctrl+Tab` on macOS). Release its opening
   modifier to switch or press `Esc` to cancel.

**You are done when:** you can switch panes and know where typing will go.

> Browsers may reserve `Cmd+T`, `Cmd+W`, or `Cmd+D`; use menus or the shortcut
> editor. PWAs are often more reliable. Do not substitute Ctrl for every Cmd.

### 2.2 Give the agent a small, reviewable task

Use a repository you may modify. Paste, review, and manually submit this prompt;
model usage may incur charges.

```text
Read this project's README and add a short first-run example.
Check the project's actual commands first; do not invent flags.
Modify only the README. Do not install dependencies, commit, or push.
When finished, explain what changed and what you have not actually verified.
```

Watch Herdr's recognized status: `working` suggests activity, `blocked` needs
attention, and `done`/`idle` suggest when to return. **Status is not verification:**
`done` does not mean tests passed. Available states depend on agent integration.

Open Agent History to find the explanation. Session Inspector offers Timeline,
ATIF (a normalized trajectory), and raw transcript; original export preserves
the source record. Use the [shortcut reference](../FEATURES.md#keyboard-shortcuts)
for History, Files, and Changes on your platform.

**You are done when:** you found the explanation, not just the last terminal line.

> Inspection supports Codex, Claude, Kimi, Grok Build, Pi, and Antigravity CLI with readable records.
> Follow missing-metadata integration hints. SSH reads Herdr-reported paths and
> Pi ID lookups remotely; other local ID/directory fallbacks may miss remote
> transcripts. See [session inspection](../FEATURES.md#agent-awareness-and-session-inspection).

### 2.3 Read the file, then the diff

1. Open **File Explorer** from the interface menu and find `README.md`.
2. Switch between **Raw / Rendered** to check both the source and formatting.
   Previews also support images, Mermaid diagrams in Markdown, and standalone
   Mermaid files.
3. Open **Diff Viewer** from the interface menu. Select the working-tree scope and
   inspect the README's added and removed lines.
4. Use `Cmd/Ctrl+F` in the diff to find the command the agent added. Confirm
   that it actually exists in the project's configuration.

**You are done when:** you can identify the new lines and verify the run command.

![File Explorer previewing a README with raw and rendered views](./images/roamgate-desktop-files.png)

*File-tree search covers loaded files, not repository-wide full-text search.*

Right-click/long-press for file actions, drag to upload, or download a file or
`.tar.gz` directory. `Cmd/Ctrl+Click` on terminal paths opens previews.
**Uploads, deletions, and SSH file operations affect real target-host files.**

### 2.4 Send precise feedback back to the agent

1. Click/drag diff line numbers and comment, for example: "Use the dev command
   in package.json." Source annotation gutters and rendered Markdown selections
   also accept comments.
2. Check files, ranges, and quotes in the review panel; reorder as needed.
3. Choose the agent pane and pre-fill its input with compiled feedback.
4. Review the full message in that pane and press Enter yourself.

**You are done when:** the agent receives located, contextual feedback.
**Pre-filling does not submit.**

Drafts stay in this browser/checkout, not GitHub PRs or other devices. Failed
re-anchoring marks a comment stale but retains its original quote.

![Diff Viewer with a comment on selected changed lines](./images/roamgate-desktop-annotations.png)

### 2.5 Do not rush into bulk actions

Diff Viewer separates staged, unstaged, untracked, and conflicted files.
Context actions stage/unstage matching changes; **More Git actions** affects
multiple files.

**This exercise needs no commit.** To commit, first run `git status` in the
shell and follow the project's checks/commit process. Staging is not committing;
committing is not pushing.

> **Discard Unstaged loses unstaged changes; Delete Untracked deletes files.**
> Confirmation is not a backup. When uncertain, cancel and preserve files.

## 3. Parallel work and mobile access

<a id="workflow"></a>

### 3.1 When do you need a worktree?

For simultaneous tasks that edit files, use separate worktrees: each has its
own checkout directory and branch.

1. Confirm that the repository has a fetchable `origin/main`, and inspect
   `paseo.json` if it exists. If you do not trust its commands, disable hooks
   for this repository through **Worktree hooks** before proceeding.
2. Open **Worktree Lifecycle** from the workspace context menu, or search for
   `worktree lifecycle` in the command menu.
3. Create and open a documentation worktree. Roamgate starts it from the latest
   fetched `origin/main`, without carrying over the source workspace's
   uncommitted changes.
4. In the new worktree's terminal, run `pwd` and `git status`. Confirm the
   directory and branch before starting the agent.

**You are done when:** tasks have separate checkouts and independently reviewable
changes. Group/collapse/pin preferences stay in this browser.

> `paseo.json` setup/opened/teardown/removed hooks are enabled by default and run
> repository code, remotely in SSH mode. Before removal, save/commit wanted
> results, end tasks, and read the confirmation. Hook failure can block removal;
> see [hook boundaries](../FEATURES.md#paseo-worktree-hooks).

Leave **Automatic branch updates** off for this exercise. When enabled, they
fetch/merge `origin/main` every 10 minutes by default, never push, skip dirty or
detached checkouts, and abort conflicts. They run only while the workspace is open
in this connection. See [update controls](../FEATURES.md#automatic-branch-updates).

### 3.2 Continue from your phone

First complete chapter 4's [Tailscale + Serve](#tailscale) setup and access checks.
Use its HTTPS URL: `127.0.0.1` on a phone means the phone, not the work computer.

1. Open Roamgate in the mobile browser and select your practice project and
   agent pane. Authenticate first if your deployment requires login.
2. Use the floating terminal panel for arrow keys, Ctrl, and other actions
   that are awkward on a touch keyboard. Customize its two shortcut rows
   as needed.
3. Open Changes to review the README diff. Mobile uses a unified diff layout;
   long-press a file to open its actions menu.
4. Adjust **Menu > Appearance > Text size** (80%-150%), then use the relevant
   platform entry below to install the PWA.

| Browser / device | Installation entry |
| --- | --- |
| iPhone / iPad Safari | Share > Add to Home Screen |
| macOS Safari 17+ | File > Add to Dock |
| Chrome / Edge | Browser menu > Install app |

**You are done when:** the home-screen icon opens your project. Install the stable
Roamgate service URL, not this tutorial's Pages URL.

![Mobile terminal with touch shortcut controls](./images/roamgate-mobile-terminal.png)

**PWA is not offline access or background keep-alive.** Host sleep, stopped
Roamgate, or a disconnected VPN interrupts access. Completion notifications can
return to a pane, but browser permissions and OS restrictions make them unsuitable
as reliable alerts.

### 3.3 Multiple browsers are not separate permission roles

Browsers share Herdr events, not all fonts, drafts, pins, or shortcuts.
Connection controls can pause your browser or others.

**Profiles are shared; each browser selects its displayed connection.** Editing
a profile affects others' connection lists. There is no per-person read-only
role: do not share a workspace URL like a document link.

## 4. Remote access: choose the right connection

<a id="networking"></a>

**Choose Tailscale + Serve for everyday phone/computer access.** Use SSH if you
already have SSH access and only need another computer. Reserve Tailcat for
temporary experiments between computers you control.

| Your goal | Recommended route | What you need |
| --- | --- | --- |
| Use Roamgate on the computer running Herdr | Local Roamgate | No extra networking tool |
| Reach the workspace from your phone away from home | Tailscale + Serve | Host and phone in the same tailnet |
| Manage remote Herdr through local Roamgate | SSH profile / `--ssh-host` | Local Linux/macOS, Herdr already running remotely |
| Connect two computers temporarily without a tailnet | Tailcat port forwarding | Tailcat on both ends and a securely exchanged address |

These external tools are **not built-in integrations**. No router forwarding,
exit node, or subnet routing is needed. Verify the chosen route on your own
network before relying on it.

### 4.1 Separate the two network hops

```text
Hop A: Browser -> Roamgate
       Tailscale Serve / SSH TCP forwarding / Tailcat port forwarding

Hop B: Roamgate -> Herdr
       Local sockets / a Roamgate SSH profile
```

Tailscale/Tailcat solve **hop A** (browser to Roamgate); `--ssh-host` solves
**hop B** (Roamgate to Herdr). Start with the hop you need.

#### Safety checks before connecting

1. Admit only fully trusted devices/people: UI access is terminal/file authority
   as the Roamgate user.
2. **Loopback (`127.0.0.1`, `localhost`, `::1`) bypasses login even with
   `ROAMGATE_PASSWORD`.** A forwarding tunnel/proxy becomes the entire remote
   access boundary, with no extra Roamgate password gate.
3. Use HTTPS or a trusted encrypted tunnel; restrict listeners and access policy.
   Passwords provide no TLS, rate limiting, multi-user authorization, or sandbox.
4. Never publish passwords, token URLs, or Tailcat addresses in screenshots,
   issues, chats, or configs.

Read [SECURITY.md](../SECURITY.md). These are private-access examples. If you need
an additional application login, use an independently authenticated proxy instead.
Do not bind `0.0.0.0` just to force login: that expands network exposure.

<a id="tailscale"></a>

### 4.2 Tailscale + Serve: the recommended everyday option

**Tailscale** links authorized devices in a private **tailnet**, using WireGuard
with direct connections or relays. **Serve** gives local HTTP a tailnet-only HTTPS
address.

```text
Phone browser (connected to Tailscale)
          |
          | HTTPS, restricted by tailnet access policy
          v
Tailscale Serve on the work computer
          |
          | HTTP, local loopback only
          v
127.0.0.1:8787 -> Roamgate -> local Herdr
```

#### Prepare both devices: about 5-10 minutes

1. Install [Tailscale](https://tailscale.com/download) on the host and visiting
   device. Sign into the same tailnet; confirm both are online in its admin console.
2. Run `tailscale status` on the host. For a missing macOS CLI, follow the
   [macOS instructions](https://tailscale.com/docs/install/mac), not a second
   client installation to fix PATH.
3. [Restrict access](https://tailscale.com/docs/features/access-control) to intended
   users/devices on the Roamgate node's HTTPS port 443. Check broad existing rules.
   Tailnet membership is not least privilege: **verify scope before enabling Serve**.

#### Start Roamgate with a local-only listener

On **the Herdr host**, ensure port 8787 is free. If a plugin/user service already
runs Roamgate, follow the existing-service instructions below; do not duplicate it.

```bash
roamgate --host 127.0.0.1 --port 8787
```

On Windows, use `roamgate.exe` (`./roamgate.exe` from its PowerShell directory).
Leave the process running.

> **No Roamgate login page:** Tailscale identity/access rules admit remote devices
> directly. HTTPS protects transport. Local processes can also access loopback.
> Continue only if you accept this boundary.

**Existing service:** edit `~/.config/roamgate/roamgate.env` (Unix) or
`%APPDATA%\roamgate\roamgate.env` (Windows). Preserve other settings; set
`HOST=127.0.0.1` and `PORT=8787`. **This removes the token/password gate:** Tailscale
policy must replace it. Protect this potentially secret file; never commit it.
Restart for your installation:

**Standalone installation:**

```bash
roamgate service restart
```

**Plugin installation:**

```bash
herdr plugin action invoke roamgate.restart
```

Plugin actions are asynchronous: confirm restart in its panel/log.
See [service configuration and logs](./DEPLOYMENT.md#run-as-a-user-service).

#### Connect from another terminal on the same work computer

1. Check for existing Serve configuration you need to preserve:

   ```bash
   tailscale serve status
   ```

2. Confirm HTTPS port 443 at `/` is free. If occupied, use official documentation
   to plan another port/node; do not overwrite another service.

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:8787
   ```

   Approve the first-run HTTPS certificate consent link as an authorized admin.
   Hostnames appear in public certificate transparency logs: avoid sensitive names.

3. On your Tailscale-connected phone, open the printed address, shaped like
   `https://machine-name.tailnet-name.ts.net`. **Use the printed HTTPS hostname,
   not a bare IP address or localhost on your phone.**
4. Run `pwd` in an idle shell pane to verify terminal interaction. Test that a
   tailnet device excluded by your access rules cannot connect; if you have
   no suitable test device, at least verify the denial using policy tests.
   With Tailscale disconnected and no other access path, the HTTPS endpoint
   should also be unreachable.

**You are done when:** cellular access works with Tailscale, and excluded devices
cannot connect. Incognito is not an admission test; device identity stays the same.

> **Serve is private; Funnel is public. Do not substitute `funnel`.** Serve identity
> headers add no Roamgate per-person/read-only roles. Use domain root `/`; arbitrary
> subpaths such as `/studio/` are not assured.

#### Stop sharing, or make it a regular setup

Before closing this endpoint, check that other mounts will not be affected:

```bash
tailscale serve --bg --https=443 off
tailscale serve status
```

`tailscale serve reset` clears the device's entire Serve configuration, including
other services. **`--bg` persists Serve, not Roamgate, and does not prevent sleep.**
After verification, configure a [Roamgate user service](./DEPLOYMENT.md#run-as-a-user-service)
if needed, keeping loopback and strict Tailscale policy.

<a id="ssh"></a>

### 4.3 SSH: connect to Herdr, or forward the web interface

#### Option A: local Roamgate, remote Herdr

Use local Roamgate with remote code/agents. **Roamgate must run on Linux/macOS**
for SSH socket forwarding; Windows supports native local profiles only.

1. Verify connectivity with system SSH, confirm the host fingerprint, and check
   authentication and the already-running remote Herdr server. Put custom
   ports, jump hosts, and keys in local `~/.ssh/config`; for example, configure
   the destination as the alias `workbox`.
2. In local Roamgate, add an SSH profile through the connection selector beside
   the title. Set Destination to `workbox`, leaving the control and render
   socket paths empty for automatic resolution.
3. Test and connect using the selector. Open the remote project and run `pwd`
   in its terminal to confirm the directory.

Or start a local bridge on a free port:

```bash
roamgate --ssh-host workbox --host 127.0.0.1
```

**You are done when:** the local browser controls the remote terminal/files.
Image uploads, Git, file operations, and hooks run on that remote host.

Explicit `--socket-path` / `--client-socket-path` or environment equivalents
override tunnel paths; stale settings can select the wrong target. Profiles
store no passwords/keys; OpenSSH owns host verification/authentication. See
[connections](./DEPLOYMENT.md#multiple-and-remote-herdr-connections).

#### Option B: Roamgate already runs remotely; forward its web port

Both services stay remote; system SSH forwards the web port (not `--ssh-host`).
Remote Roamgate must use loopback: login is bypassed, so SSH authentication controls
remote admission. Visiting-computer processes can also use the forwarded port.
This option works with Windows OpenSSH too.

On the visiting computer, replace `workbox` with your SSH alias:

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18787:127.0.0.1:8787 workbox
```

Open `http://127.0.0.1:18787` there, not on your phone. HTTP stays on loopback at
each end; SSH encrypts the link. `-N` runs no remote command; `18787` is local,
`8787` remote. **Press Ctrl+C in this terminal when finished.**

<a id="tailcat"></a>

### 4.4 Tailcat: a temporary link between trusted computers

**Tailcat is a separate Tailscale-team tool**, not Tailscale. It uses WireGuard,
NAT traversal, and DERP without a tailnet/account, but offers no long-term device
directory or access-policy management. Its client maps remote ports to localhost;
privately exchange the server's address.

> **Experimental:** no upstream CLI/API/wire stability promises or relay
> availability/throughput SLA. Its threat model primarily covers your own devices.
> This project has not verified this example end-to-end on two machines. Check
> both versions and `tailcat --help`, `tailcat serve --help`, and
> `tailcat forward --help` for `serve`, `forward`, and `--key=new` support.
> Update through official instructions; do not guess flags.

#### Prepare both ends

Install supported versions on both computers from the
[official repository](https://github.com/tailscale/tailcat#install): macOS supports
`brew install tailcat`; other systems need the matching release architecture.
The experimental web demo is not a general Roamgate proxy, and phones are not
assumed to support these CLIs. Use Tailscale for regular mobile access.

#### Connect only the Roamgate port

1. Run Roamgate on the work computer at `127.0.0.1:8787` and verify its local
   page. **This listener has no Roamgate login gate. The experiment relies
   entirely on Tailcat admission; leaking the address leaks access to the
   workspace.** Use only two computers you control, not a demo for other people.
2. In another terminal on the work computer, start a temporary single-port
   service:

   ```bash
   tailcat serve --key=new 8787
   ```

   `--key=new` forces an ephemeral key, avoiding reuse of a previously shared
   address when a saved key named `default` already exists. Confirm that the
   output says it is using a new address.

3. Send the complete printed `tc...` address through a trusted private channel
   to the visiting computer. Run this there, **replacing
   `tcREPLACE_WITH_PRIVATE_ADDRESS` first**:

   ```bash
   tailcat forward tcREPLACE_WITH_PRIVATE_ADDRESS 18787:8787
   ```

   Upstream's `forward` binds to `127.0.0.1` by default. Verify that in its
   output; do not add `--bind=0.0.0.0`.

4. On the visiting computer, open `http://127.0.0.1:18787` and run `pwd` in an
   idle shell pane to verify interaction.
5. When finished, press Ctrl+C in both Tailcat terminals. Confirm the visiting
   computer's address no longer works. Once the ephemeral server exits, the
   old address no longer corresponds to a running service.

```text
Visiting browser -> 127.0.0.1:18787 -> tailcat forward
                                          |
                                 WireGuard encryption
                                 (direct or via DERP)
                                          |
Work host: Herdr <- Roamgate :8787 <- tailcat serve
```

**You are done when:** the trusted computer has access without a public listener,
and access stops when both forwarding processes exit.

**Protect the Tailcat address as a credential:** default addresses include a
pre-shared key, not just a hostname. Keep default protections; avoid weakening
compatibility options. Do not expand to `serve all`, exit-node mode,
authentication-free SSH, or writable-directory sharing.

#### Which one should you choose?

| Consideration | Tailscale + Serve | Tailcat |
| --- | --- | --- |
| Best fit | Regular private access across your devices | A short-lived connection between your computers |
| Who gets access | Tailnet identity and policy; no Roamgate login gate in this example | The connection address and optional client restrictions; no Roamgate login gate in this example |
| Browser entry | A private HTTPS hostname | Localhost exposed by the client CLI |
| Ongoing responsibility | Maintain device sign-ins, policies, and services | Protect the temporary address, check versions, and stop processes |

Neither tool guarantees a direct connection on every network. A DERP relay
does not mean encryption is disabled, but performance may differ from your LAN.

## 5. Troubleshoot the hop that failed

<a id="troubleshooting"></a>

### A page will not open: check in order, about 3 minutes

1. On the **Roamgate host**, probe its HTTP service:

   ```bash
   curl -fsS http://127.0.0.1:8787/healthz
   ```

   Use `curl.exe` in Windows PowerShell. This is a service probe, not proof
   that every Herdr feature works. For a refused connection, check the Roamgate
   process, port, and service status before changing the VPN.

2. Open Roamgate locally on its host, authenticating first for a non-loopback
   deployment. If the page appears but the terminal does not, check that
   Herdr is running, the selected profile, control and render socket paths,
   and connection errors in the logs.
3. Once local access works, check hop A. For Tailscale, use `tailscale status`
   and `tailscale serve status`. For SSH, confirm the forwarding terminal is
   still running. For Tailcat, check both processes and that the address
   belongs to this server run.
4. If the page loads but typing produces no output, check that the browser
   connection is not paused, the right pane is selected, and the proxy
   supports WebSocket upgrades and long-lived connections. Retry locally to
   distinguish proxy trouble from Herdr rendering trouble.

**You are done when:** you identified the failing service, Herdr connection, or
access path and changed only that part.

### Five common symptoms

| Symptom | Check this first |
| --- | --- |
| Localhost on the phone does not open the computer's workspace | Localhost points to the phone. Use Serve's printed HTTPS URL. |
| Roamgate opens directly despite a configured password | Loopback listeners skip built-in authentication. For non-loopback listeners, use a fresh incognito window to rule out an existing cookie. |
| `Address already in use` | A plugin or user service may already occupy 8787. Do not start a duplicate bridge. |
| SSH connects, but session history is empty | Check remote transcript readability and the metadata/fallback limitations in chapter 2. |
| Image paste, clipboard access, or PWA installation is restricted | Check the HTTPS secure context, browser permissions, and platform support. Prefer the Serve HTTPS address. |

See [deployment](./DEPLOYMENT.md) for token recovery, restarts, and debug logs.
Do not disable authentication permanently or open the entire firewall. For help,
share redacted logs, OS/Roamgate versions, and the failing step.

### Your first round is complete

Check before finishing:

- [ ] I know which workspace, tab, and pane will receive my input.
- [ ] I reviewed the actual diff and know that an agent's "done" is not verification.
- [ ] I know which host receives file and Git operations.
- [ ] For remote access, I checked the effective authentication boundary, listener address, allowed users, and how to stop sharing.

**Next time you open Roamgate, take one small action: find an agent waiting for
you and inspect one part of its diff.**

### References and maintenance

Third-party commands follow official sources. For fast-changing Tailcat, check
your installed version's help.

#### Product references

- [Features and shortcuts](../FEATURES.md): complete capabilities, limitations,
  and action reference.
- [Installation and deployment](./DEPLOYMENT.md): the canonical reference for
  binaries, plugins, profiles, services, and configuration.
- [Security model](../SECURITY.md): permissions, authentication, and trust
  boundaries.
- [Architecture](./ARCHITECTURE.md): read this when you want to understand the
  bridge, events, and connection isolation.

#### Official networking references

- [Tailscale Serve concepts and requirements](https://tailscale.com/docs/features/tailscale-serve)
  and [CLI configuration and shutdown](https://tailscale.com/docs/reference/tailscale-cli/serve).
- [Tailscale access controls](https://tailscale.com/docs/features/access-control)
  and [HTTPS certificates and public names](https://tailscale.com/docs/how-to/set-up-https-certificates).
- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel): why
  this is not the private endpoint recommended here.
- [Tailcat README](https://github.com/tailscale/tailcat#readme): installation,
  port forwarding, keys, and stability.
- [Tailcat security model](https://github.com/tailscale/tailcat/blob/main/SECURITY.md):
  read the current limitations before experimenting.

The Pages build renders this canonical Markdown; do not duplicate its body in HTML.
Review affected chapters when installation flags, feature limits, or upstream
networking commands change.
