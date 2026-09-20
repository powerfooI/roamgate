<!-- markdownlint-disable MD033 -->
<!-- Explicit anchors keep section links usable in both GitHub and Pages. -->

# From your first terminal to a workspace that travels

**Start Roamgate on the Herdr host and open its URL:** begin with [chapter 1](#start).
Practice one task: ask an agent to improve a README, review it, then check from
another device. No Git or networking knowledge is needed to start.

Allow 5 minutes for chapter 1 with both tools installed, 25 minutes for chapters
1–3, and another 15–25 for remote access, excluding installation/troubleshooting.
Stop at any completion check. **This tutorial website does not run Herdr or keep
terminals alive.**

## 1. Start here: see your own work locally

<a id="start"></a>

```text
Browser / PWA -> Roamgate (HTTP + WebSocket) -> Herdr -> shell / agent
```

Herdr owns terminals; Roamgate supplies the browser UI; agents remain CLIs.
Roamgate does not provide models or install/sign in to agents. Closing the
browser leaves terminals running; host sleep, shutdown, or process exit can stop work.

1. Start Herdr with a trusted project open; see [herdr.dev](https://herdr.dev).
   For default local setups, `roamgate herdr setup` can also install/start it
   after [installing Roamgate](./DEPLOYMENT.md#install-a-release).
2. Run `roamgate` on that computer and leave it running (`roamgate.exe` on
   Windows). Plugin users instead use the [startup action](./DEPLOYMENT.md#herdr-plugin)
   and obtain the URL from its panel/log; the plugin does not add the CLI to PATH.
3. Open the printed URL, including any token, **on the same computer**. Select
   a workspace and idle shell; run `pwd` (`Get-Location` in PowerShell).

**You are done when:** terminal input shows your project directory.

Standalone defaults to `127.0.0.1:8787`, which **bypasses login even with a
password**. A new user/plugin service defaults to `0.0.0.0:8787` with a token.
Existing Herdr Studio / Roamgate 0.7.0 installations should follow
[migration guidance](./DEPLOYMENT.md#transition-from-herdr-studio--herdr-gui)
before changing services.

![Desktop workspace with project navigation, terminals, and changed files](./images/roamgate-desktop-changes.png)

| Object | Meaning |
| --- | --- |
| Workspace | Working environment, usually a project directory |
| Tab | A layout within a workspace |
| Pane | One terminal region within a tab |
| Worktree | A separate Git checkout directory and branch |

**Splitting panes does not isolate files.** Use separate worktrees for parallel edits.

## 2. Everyday work: verify what the agent changed

<a id="daily"></a>

### Find a pane and give the agent one task

1. Select your project, create a tab, and split right from its pane menu.
2. Start an installed, signed-in agent on the left; keep a shell on the right.
3. Paste this prompt, review it, and submit manually. Model usage may incur charges.

```text
Read this project's README and add a short first-run example.
Check the project's actual commands first; do not invent flags.
Modify only the README. Do not install dependencies, commit, or push.
When finished, explain what changed and what you have not actually verified.
```

The command menu searches workspaces, paths, tabs, panes, and agents. The recent
pane switcher moves between live panes; release its modifier to switch, Esc to
cancel. See [platform shortcuts](../FEATURES.md#keyboard-shortcuts); browsers
can intercept bindings, so use menus or customize them rather than replacing
all Cmd keys with Ctrl.

**You are done when:** you know which pane receives input and can find the agent's
explanation in **Agent History**. A `done` status is not proof that checks passed.
For missing records, follow [session inspection guidance](../FEATURES.md#agent-awareness-and-session-inspection).

### Review the file and diff

1. Open **File Explorer**, select `README.md`, and compare **Raw / Rendered**.
2. Open **Diff Viewer > Working tree** and read the added/removed lines.
3. Search with `Cmd/Ctrl+F` for the new command; verify it in the project's configuration.

**You are done when:** you can identify the change and verify its command.

![File Explorer previewing a README](./images/roamgate-desktop-files.png)

Tree search covers loaded files, not repository-wide contents. Right-click or
long-press opens file actions; `Cmd/Ctrl+Click` on terminal paths opens previews.
Uploads, deletions, and SSH file operations affect real target-host files.

### Send precise feedback

1. Click/drag diff line numbers and comment, for example: “Use the dev command
   in package.json.” Source gutters and rendered Markdown selections also work.
2. Check the files, ranges, and quotes in **Annotations**, then select the agent
   pane and pre-fill its input.
3. Review the message in that pane and press Enter yourself.

**You are done when:** the agent receives contextual feedback. **Pre-fill does
not submit.** Drafts belong to this browser/checkout, not GitHub or other devices;
stale anchors keep their captured quotes.

![Diff annotations on selected changed lines](./images/roamgate-desktop-annotations.png)

This exercise needs no commit. Before committing, run `git status` and follow
the project's checks. Staging is not committing; committing is not pushing.
**Discard Unstaged loses changes; Delete Untracked deletes files. Confirmation
is not a backup.** Cancel bulk actions if unsure.

## 3. Parallel work and mobile access

<a id="workflow"></a>

### Separate parallel edits with worktrees

1. Verify a fetchable `origin/main`. Review `paseo.json`; disable **Worktree hooks**
   if you do not trust its commands. Hooks are enabled by default and run host code.
2. Open **Worktree Lifecycle** from the workspace/command menu and create a worktree.
   It starts from freshly fetched `origin/main`, without copying source dirty files.
3. Run `pwd` and `git status` there before starting another agent.

**You are done when:** parallel tasks have different checkout directories and branches.
Before removal, save wanted results, end tasks, and review confirmation.
[Failed teardown blocks removal](./DEPLOYMENT.md#worktree-hooks).
Leave [automatic branch updates](../FEATURES.md#automatic-branch-updates) off for
this exercise; when enabled they fetch/merge, never push.

### Continue from your phone

Complete [Tailscale + Serve](#tailscale) first. Use its HTTPS URL; `127.0.0.1`
on a phone points to the phone, not your computer.

1. Open Roamgate on your phone, authenticate if required, and select your project/pane.
2. Use the floating terminal shortcuts for Ctrl/arrows, then open Changes to review
   the unified diff. Long-press opens file actions.
3. Adjust **Configuration > Appearance > Text size** if needed and install the PWA:

| Browser | Install action |
| --- | --- |
| iPhone/iPad Safari | Share > Add to Home Screen |
| macOS Safari 17+ | File > Add to Dock |
| Chrome/Edge | Browser menu > Install app |

**You are done when:** the home-screen icon opens your project. Install the stable
Roamgate service URL, not this tutorial website.

![Mobile terminal with touch shortcuts](./images/roamgate-mobile-terminal.png)

PWA mode is neither offline access nor background keep-alive. Host sleep, stopped
services, or VPN loss interrupts access. [Notifications](./DEPLOYMENT.md#web-push-notifications)
are best-effort, not reliable alerts.

**Multiple browsers are not separate permission roles.** Profiles are shared,
selection is per browser, and preferences/drafts may stay local. Anyone admitted
has terminal/file authority; do not share this URL like a read-only document.

## 4. Remote access: choose the right connection

<a id="networking"></a>

| Goal | Route |
| --- | --- |
| Regular phone/computer access | [Tailscale + Serve](#tailscale) |
| Local Roamgate controlling remote Herdr | [SSH profile](#ssh), Linux/macOS bridge |
| Another computer accessing remote Roamgate | [SSH web-port forwarding](#ssh) |
| Temporary experiment between your computers | [Tailcat](#tailcat) |

These are external tools, not built-in integrations. No router forwarding,
exit node, or subnet routing is needed.

```text
Hop A: Browser -> Roamgate     (Serve / SSH web forwarding / Tailcat)
Hop B: Roamgate -> Herdr       (local sockets / Roamgate SSH profile)
```

### Safety checks

- Admit only fully trusted people/devices. UI access has the Roamgate user's authority.
- **Loopback bypasses login even with a password.** A proxy/tunnel forwarding to
  it becomes the entire remote access boundary. Use an independently authenticated
  proxy if that is insufficient; do not widen the bind just to force login.
- Use trusted HTTPS/encrypted tunnels and restrict listener/access policy.
  Authentication alone adds no TLS, rate limiting, permission roles, or sandbox.
- Keep passwords, token URLs, and Tailcat addresses out of screenshots, issues,
  chats, and committed configuration. Read [Security](../SECURITY.md).

<a id="tailscale"></a>

### Tailscale + Serve: regular private access

Tailscale connects authorized devices over WireGuard; Serve supplies a tailnet-only
HTTPS address forwarding to local Roamgate. Direct connections or DERP relays
remain encrypted.

1. Install [Tailscale](https://tailscale.com/download) on both devices and join the
   same tailnet. Verify `tailscale status`. For a missing macOS CLI, follow the
   [macOS instructions](https://tailscale.com/docs/install/mac), not a second install.
2. [Restrict access](https://tailscale.com/docs/features/access-control) to intended
   users/devices on the host's HTTPS port 443. Review broad rules before enabling Serve.
3. On the Herdr host, start Roamgate on a free loopback port:

   ```bash
   roamgate --host 127.0.0.1 --port 8787
   ```

   If a user/plugin service already runs it, do not duplicate it. Set
   `HOST=127.0.0.1` and `PORT=8787` in its protected
   [environment file](./DEPLOYMENT.md#run-as-a-user-service), preserving other settings,
   then run `roamgate service restart` or the plugin's `roamgate.restart` action.
   Confirm asynchronous plugin restarts in its log. **Loopback removes the
   token/password gate; Tailscale policy must replace it.**

4. Inspect `tailscale serve status`. Only if HTTPS port 443 at `/` is free, run:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:8787
   ```

   Preserve existing mounts; use official docs if another service occupies them.
   Approve HTTPS certificate consent as an authorized admin. Hostnames appear in
   public certificate transparency logs, so avoid sensitive names.
5. On the Tailscale-connected phone, open the **printed HTTPS hostname**, not an
   IP or localhost. Run `pwd` in an idle pane. Verify excluded devices cannot
   connect, using policy tests if no test device exists. With Tailscale off and
   no other access path, the URL should be unreachable.

**You are done when:** cellular access works and excluded devices are denied.
Incognito is not an admission test; device identity is unchanged.

**Serve is private; Funnel is public. Do not substitute `funnel`.** Use domain
root `/`; arbitrary subpaths are not assured. Serve headers do not add user roles.

To stop sharing, first check other mounts will not be affected, then run:

```bash
tailscale serve --bg --https=443 off
tailscale serve status
```

Avoid `tailscale serve reset`: it clears all Serve configuration. `--bg` persists
Serve, not Roamgate, and does not prevent sleep. For daily use, configure a
[Roamgate user service](./DEPLOYMENT.md#run-as-a-user-service) with loopback retained.

<a id="ssh"></a>

### SSH: remote Herdr or remote web interface

**Option A — local Roamgate, remote Herdr:** requires a Linux/macOS bridge;
Windows supports native local profiles, not SSH socket forwarding.

1. Verify system SSH, host fingerprint, authentication, and remote Herdr readiness.
   Put keys, ports, and jump hosts in `~/.ssh/config`, for example alias `workbox`.
2. Add an SSH profile from Roamgate's connection selector: Destination `workbox`,
   socket paths empty for automatic resolution. Test/connect and verify `pwd`.

Alternatively, on a free port:

```bash
roamgate --ssh-host workbox --host 127.0.0.1
```

Files, Git, image uploads, and hooks run remotely. Explicit socket flags/environment
variables override tunnel paths and can select the wrong host. Profiles store no
SSH secrets; see [connection configuration](./DEPLOYMENT.md#multiple-and-remote-herdr-connections).

**Option B — forward remote Roamgate's web port:** both services stay remote;
this works with Windows OpenSSH too. Remote Roamgate uses loopback, so SSH is the
admission boundary. Local processes on the visiting computer also gain access.

On the visiting computer, replace `workbox` with your SSH alias:

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18787:127.0.0.1:8787 workbox
```

Open `http://127.0.0.1:18787` **on that computer**, not your phone. HTTP remains
loopback at both ends; SSH encrypts the link. Press Ctrl+C to stop forwarding.

<a id="tailcat"></a>

### Tailcat: temporary access between trusted computers

Tailcat is a separate Tailscale-team tool using WireGuard/NAT traversal/DERP
without a tailnet/account. It has no durable device directory or access-policy
management. **Experimental: no CLI/wire stability or relay SLA; this example
has not been verified end-to-end on two machines by this project.**

Install matching supported builds from the [official repository](https://github.com/tailscale/tailcat#install)
on both computers (`brew install tailcat` on macOS). Check `tailcat --help`,
`tailcat serve --help`, and `tailcat forward --help` for the flags below. The web
demo is not a general Roamgate proxy; use Tailscale for phones.

1. Run and locally verify Roamgate at `127.0.0.1:8787` on your work computer.
   There is **no Roamgate login gate**; only proceed between computers you control.
2. In another terminal there, start a single-port service:

   ```bash
   tailcat serve --key=new 8787
   ```

   Confirm a new address: `--key=new` avoids reusing a previously shared saved key.
3. Privately send the complete printed `tc...` address to the visiting computer.
   Replace the placeholder and run there:

   ```bash
   tailcat forward tcREPLACE_WITH_PRIVATE_ADDRESS 18787:8787
   ```

   Verify the listener is `127.0.0.1`; never add `--bind=0.0.0.0`.
4. Open `http://127.0.0.1:18787` there and verify terminal input with `pwd`.
5. Press Ctrl+C in both Tailcat terminals and confirm the URL stops working.
   The ephemeral address no longer points to a running service after exit.

**You are done when:** private access works and ends when forwarding stops.
Treat the address as a credential: it includes a pre-shared key, not just a
hostname. Keep default protections; do not expand to `serve all`, exit-node mode,
authentication-free SSH, or writable-directory sharing. Read the current
[Tailcat security model](https://github.com/tailscale/tailcat/blob/main/SECURITY.md).

## 5. Troubleshoot the hop that failed

<a id="troubleshooting"></a>

Check in order (about 3 minutes):

1. On the Roamgate host, run `curl -fsS http://127.0.0.1:8787/healthz`
   (`curl.exe` in PowerShell). If refused, check process/port/service status.
   Health is not proof every Herdr feature works.
2. Open the page locally. If terminals fail, check Herdr, selected profile,
   both socket paths, and connection logs before changing the VPN.
3. Once local access works, check the route: `tailscale status` /
   `tailscale serve status`, the SSH forwarding process, or both Tailcat processes
   and this run's address.
4. If typing fails, check the selected pane, browser pause state, and proxy support
   for WebSocket upgrades/long-lived connections. Retry locally to isolate the proxy.

| Symptom | First check |
| --- | --- |
| Phone localhost cannot reach the computer | Use Serve's printed HTTPS hostname. |
| Password set but no login page | Loopback bypasses login; for non-loopback, use incognito to rule out an existing cookie. |
| Address already in use | Check for an existing plugin/user service; do not duplicate it. |
| SSH history is empty | Check transcript readability and [session lookup limits](../FEATURES.md#agent-awareness-and-session-inspection). |
| Clipboard/PWA restricted | Use trusted, warning-free HTTPS; check browser permissions/support. |

See [Deployment](./DEPLOYMENT.md) for tokens, service restarts, and debug logs.
Do not disable authentication or open the entire firewall. Share only redacted
logs, versions, and the failing step when requesting help.

### Completion check

- [ ] I know which workspace, tab, and pane will receive my input.
- [ ] I reviewed the actual diff and know that an agent's "done" is not verification.
- [ ] I know which host receives file and Git operations.
- [ ] For remote access, I checked the effective authentication boundary, listener address, allowed users, and how to stop sharing.

### References

[Features and shortcuts](../FEATURES.md) · [Deployment](./DEPLOYMENT.md) ·
[Security](../SECURITY.md) · [Architecture](./ARCHITECTURE.md)

Third-party commands follow official sources; check installed help for Tailcat:

- [Serve concepts](https://tailscale.com/docs/features/tailscale-serve) and
  [CLI/shutdown](https://tailscale.com/docs/reference/tailscale-cli/serve).
- [Access controls](https://tailscale.com/docs/features/access-control) and
  [HTTPS/public certificate names](https://tailscale.com/docs/how-to/set-up-https-certificates).
- [Funnel](https://tailscale.com/docs/features/tailscale-funnel): not the private route used here.
- [Tailcat README](https://github.com/tailscale/tailcat#readme) and
  [security model](https://github.com/tailscale/tailcat/blob/main/SECURITY.md).

This Markdown is the canonical tutorial; the Pages build renders it into HTML.
Update affected steps when product behavior or upstream commands change.
