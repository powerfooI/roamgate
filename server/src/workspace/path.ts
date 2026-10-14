import { access, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { WorkspacePathInfo } from "../../../shared/workspacePath";
import { sshCommandArgv } from "../bridge/ssh-command";
import { powershellCommand } from "../bridge/ssh-windows";
import type { RemotePlatform } from "../connections/unix-only";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";

const DIRECTORY_LIMIT = 50;

async function realDirectoryPath(path: string): Promise<string> {
  // Bun realpath drops the separator from Windows drive roots, changing C:\ into C:.
  if (process.platform === "win32" && /^[a-z]:[/\\]+$/i.test(path)) return path;
  // shortcut: retain symlink spelling for trailing Unix backslashes until Bun realpath preserves them.
  return process.platform !== "win32" && path.endsWith("\\")
    ? path
    : realpath(path);
}

export async function inspectWorkspacePath(
  value: unknown,
  connection: { host?: string; remotePlatform?: RemotePlatform },
  suggestions = true,
): Promise<WorkspacePathInfo> {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new Error("Enter a valid directory path.");
  const input = value.trim();
  const windows = connection.host
    ? connection.remotePlatform === "windows"
    : process.platform === "win32";
  const homePath = (windows ? /^~(?:[/\\]|$)/ : /^~(?:\/|$)/).test(input);
  if (
    !(windows ? /^(?:[a-z]:[/\\]|[/\\]{2})/i.test(input) : isAbsolute(input)) &&
    !homePath
  )
    throw new Error("Use an absolute path or a path starting with ~/.");

  if (connection.host) {
    const command = windows
      ? powershellCommand(`
$ErrorActionPreference = 'Stop'
function Emit($kind, $value) { Write-Output ($kind + "\t" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))) }
$path = '${input.replaceAll("'", "''")}'
if ($path -match '^~([/\\\\]|$)') { $path = $env:USERPROFILE + $path.Substring(1) }
$path = [IO.Path]::GetFullPath($path)
$errorText = ''
if (Test-Path -LiteralPath $path -PathType Container) { $path = (Get-Item -Force -LiteralPath $path).FullName }
elseif (Test-Path -LiteralPath $path) { $errorText = 'Path is not a directory.' }
else { $errorText = 'Directory does not exist.' }
Emit 'PATH' $path
Emit 'ERROR' $errorText
if (${suggestions ? "$true" : "$false"}) {
  $directory = $path
  $prefix = ''
  if ($errorText) { $directory = [IO.Path]::GetDirectoryName($path); $prefix = [IO.Path]::GetFileName($path) }
  Get-ChildItem -Force -Directory -LiteralPath $directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and ($prefix.StartsWith('.') -or -not $_.Name.StartsWith('.')) -and $_.Name -notmatch '[\\x00-\\x1f\\x7f]' } |
    Sort-Object Name | Select-Object -First ${DIRECTORY_LIMIT} | ForEach-Object { Emit 'DIRECTORY' $_.FullName }
}
`)
      : `bash -c ${shQuote(`
set -eu
path=${shQuote(input)}
case "$path" in '~'|'~/'*) path="$HOME\${path#\\~}" ;; esac
error_text=''
if [ -d "$path" ]; then
  if [ -x "$path" ]; then path="$(cd -- "$path" && pwd -P)"; else error_text='Directory is not accessible.'; fi
elif [ -e "$path" ]; then error_text='Path is not a directory.'
else error_text='Directory does not exist.'; fi
emit() { printf '%s\\t%s\\n' "$1" "$(printf '%s' "$2" | base64 | tr -d '\\n')"; }
emit PATH "$path"
emit ERROR "$error_text"
if [ ${suggestions ? "1" : "0"} = 1 ]; then
  directory="$path"
  prefix=''
  if [ -n "$error_text" ]; then directory="$(dirname -- "$path")"; prefix="$(basename -- "$path")"; fi
  count=0
  for child in "$directory"/* "$directory"/.[!.]* "$directory"/..?*; do
    [ -d "$child" ] || continue
    name="\${child##*/}"
    case "$name" in "$prefix"*) ;; *) continue ;; esac
    case "$name" in .*) case "$prefix" in .*) ;; *) continue ;; esac ;; esac
    [[ "$name" =~ [[:cntrl:]] ]] && continue
    emit DIRECTORY "$child"
    count=$((count + 1))
    [ "$count" -lt ${DIRECTORY_LIMIT} ] || break
  done
fi
`)}`;
    const result = await runProcessWithCodeTimeout(
      sshCommandArgv(connection.host, command),
      8000,
    );
    if (result.code !== 0)
      throw new Error("Could not check the directory on the connected host.");
    const info: WorkspacePathInfo = { path: "", error: null, directories: [] };
    for (const line of result.stdout.split(/\r?\n/)) {
      const [kind, encoded = ""] = line.split("\t");
      const text = Buffer.from(encoded, "base64").toString("utf8");
      if (kind === "PATH") info.path = text;
      if (kind === "ERROR") info.error = text || null;
      if (kind === "DIRECTORY") info.directories.push(text);
    }
    if (!info.path)
      throw new Error("Invalid directory response from the connected host.");
    return info;
  }

  const info: WorkspacePathInfo = {
    path: resolve(homePath ? join(homedir(), input.slice(2)) : input),
    error: null,
    directories: [],
  };
  try {
    if (!(await stat(info.path)).isDirectory()) {
      info.error = "Path is not a directory.";
    } else {
      await access(info.path, constants.X_OK);
      info.path = await realDirectoryPath(info.path);
    }
  } catch (error) {
    info.error = ["ENOENT", "ENOTDIR"].includes(
      (error as NodeJS.ErrnoException).code ?? "",
    )
      ? "Directory does not exist."
      : "Directory is not accessible.";
  }
  if (suggestions) {
    const directory = await realDirectoryPath(
      info.error ? dirname(info.path) : info.path,
    ).catch(() => null);
    if (!directory) return info;
    const prefix = info.error ? basename(info.path) : "";
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    const matches = entries
      .filter(
        (entry) =>
          (windows
            ? entry.name.toLowerCase().startsWith(prefix.toLowerCase())
            : entry.name.startsWith(prefix)) &&
          (prefix.startsWith(".") || !entry.name.startsWith(".")) &&
          !/[\x00-\x1f\x7f]/.test(entry.name),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of matches) {
      const path = join(directory, entry.name);
      if (
        entry.isDirectory() ||
        (entry.isSymbolicLink() &&
          (await stat(path).catch(() => null))?.isDirectory())
      )
        info.directories.push(path);
      if (info.directories.length === DIRECTORY_LIMIT) break;
    }
  }
  return info;
}
