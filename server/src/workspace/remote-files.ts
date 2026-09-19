import { IMAGE_MIME_TYPES } from "../../../shared/filePreview";
import { sshCommandArgv } from "../bridge/ssh-command";
import {
  DELETE_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
  LIST_LIMIT,
  LIST_TIMEOUT_MS,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_MAX_BYTES,
  PREVIEW_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
} from "./file-constants";
import { entrySort, relativeExplorerPath } from "./file-paths";
import type {
  FileDeleteResult,
  FileDownloadResult,
  FileExplorerEntry,
  FileListResult,
  FilePreviewResult,
  FileUploadResult,
  RunProcessWithCodeTimeout,
} from "./file-types";
import { runProcessWithInputTimeout } from "./process";
import { decodePreviewBuffer, previewLimitForPath } from "./preview";

export function parseRemoteFileList(
  stdout: string,
  relativePath: string,
): FileListResult {
  let root = "";
  const entries: FileExplorerEntry[] = [];
  let truncated = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [kind, ...rest] = line.split("\t");
    if (kind === "ROOT") {
      root = Buffer.from(rest[0] ?? "", "base64").toString("utf8");
      continue;
    }
    if (kind === "TRUNCATED") {
      truncated = true;
      continue;
    }
    if (kind !== "ENTRY") continue;
    const [type, rawSize, rawMtime, rawName] = rest;
    const name = Buffer.from(rawName ?? "", "base64").toString("utf8");
    if (!name) continue;
    entries.push({
      name,
      path: relativeExplorerPath(relativePath, name),
      type: type === "directory" || type === "symlink" ? type : "file",
      size: Number(rawSize) || 0,
      mtime_ms: (Number(rawMtime) || 0) * 1000,
      hidden: name.startsWith("."),
    });
  }
  entries.sort(entrySort);
  return { root, path: relativePath, entries, truncated };
}

export function parseRemoteFileResolutions(stdout: string) {
  const paths: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [kind, rawPath] = line.split("\t");
    if (kind !== "FILE" || !rawPath) continue;
    const path = Buffer.from(rawPath, "base64").toString("utf8");
    if (path) paths.push(path);
  }
  return paths;
}

export async function listRemoteFiles({
  host,
  rootPath,
  relativePath,
  showHidden,
  runProcessWithCodeTimeout,
  shQuote,
}: {
  host: string;
  rootPath: string;
  relativePath: string;
  showHidden: boolean;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}) {
  const command = `
set -eu
root=${shQuote(rootPath)}
rel=${shQuote(relativePath)}
show_hidden=${showHidden ? "1" : "0"}
limit=${LIST_LIMIT}
root_real="$(cd "$root" && pwd -P)"
target="$root_real"
if [ -n "$rel" ]; then
  target="$root_real/$rel"
fi
target_real="$(cd "$target" && pwd -P)"
case "$target_real/" in "$root_real"/*|"$root_real/") ;; *) exit 13 ;; esac
printf 'ROOT\\t%s\\n' "$(printf '%s' "$root_real" | base64 | tr -d '\\n')"
count=0
while IFS= read -r -d '' p; do
  name="$(basename "$p")"
  if [ "$show_hidden" != "1" ] && [ "\${name#\\.}" != "$name" ]; then
    continue
  fi
  count=$((count + 1))
  if [ "$count" -gt "$limit" ]; then
    printf 'TRUNCATED\\n'
    break
  fi
  if [ -d "$p" ]; then type=directory; elif [ -L "$p" ]; then type=symlink; else type=file; fi
  size="$(stat -c %s "$p" 2>/dev/null || stat -f %z "$p" 2>/dev/null || printf 0)"
  mtime="$(stat -c %Y "$p" 2>/dev/null || stat -f %m "$p" 2>/dev/null || printf 0)"
  name64="$(printf '%s' "$name" | base64 | tr -d '\\n')"
  printf 'ENTRY\\t%s\\t%s\\t%s\\t%s\\n' "$type" "$size" "$mtime" "$name64"
done < <(find "$target_real" -mindepth 1 -maxdepth 1 -print0)
`;
  const result = await runProcessWithCodeTimeout(
    sshCommandArgv(host, `bash -lc ${shQuote(command)}`),
    LIST_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `file list exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  return parseRemoteFileList(result.stdout, relativePath);
}

export async function resolveRemoteFilePaths({
  host,
  rootPath,
  requestedPaths,
  runProcessWithCodeTimeout,
  shQuote,
}: {
  host: string;
  rootPath: string;
  requestedPaths: string[];
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}) {
  const requests = requestedPaths.map((path) => shQuote(path)).join(" ");
  const command = `
set -eu
root=${shQuote(rootPath)}
root_real="$(cd "$root" && pwd -P)"
root_prefix="\${root_real%/}/"
requests=(${requests})
for request in "\${requests[@]}"; do
  case "$request" in
    /*) target="$request"; requested_absolute=1 ;;
    *) target="$root_real/$request"; requested_absolute=0 ;;
  esac
  target_real="$(realpath "$target" 2>/dev/null)" || continue
  if [ "$requested_absolute" != "1" ]; then
    case "$target_real/" in "$root_prefix"*) ;; *) continue ;; esac
  fi
  [ -f "$target_real" ] || [ -d "$target_real" ] || continue
  printf 'FILE\\t%s\\n' "$(printf '%s' "$request" | base64 | tr -d '\\n')"
done
`;
  const result = await runProcessWithCodeTimeout(
    sshCommandArgv(host, `bash -lc ${shQuote(command)}`),
    PREVIEW_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `file resolve exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  return parseRemoteFileResolutions(result.stdout);
}

export function parseRemoteFilePreview(
  stdout: string,
  requestedPath: string,
): FilePreviewResult {
  const lines = stdout.split(/\r?\n/);
  const meta = lines.shift() ?? "";
  const [kind, rawRoot, rawSize, rawMtime, rawRelative, rawType] =
    meta.split("\t");
  if (kind !== "META") {
    throw new Error(
      (stdout || "invalid file preview response").trim().slice(0, 1000),
    );
  }
  const root = Buffer.from(rawRoot ?? "", "base64").toString("utf8");
  const relativePath = rawRelative
    ? Buffer.from(rawRelative, "base64").toString("utf8")
    : requestedPath.replace(/^\/+/, "");
  if (rawType === "directory") {
    return {
      root,
      path: relativePath,
      type: "directory",
      size: 0,
      mtime_ms: (Number(rawMtime) || 0) * 1000,
      truncated: false,
      text: null,
      binary: false,
    };
  }
  const base64 = lines.join("");
  const raw = Buffer.from(base64, "base64");
  const size = Number(rawSize) || raw.length;
  const previewLimit = previewLimitForPath(relativePath, size);
  const truncated =
    size > previewLimit || raw.length > previewLimit || raw.length < size;
  const bytes = truncated ? raw.subarray(0, previewLimit) : raw;
  const decoded = decodePreviewBuffer(bytes, truncated, relativePath);
  return {
    root,
    path: relativePath,
    size,
    mtime_ms: (Number(rawMtime) || 0) * 1000,
    truncated,
    ...decoded,
  };
}

export async function readRemoteFile({
  host,
  rootPath,
  requestedPath,
  runProcessWithCodeTimeout,
  shQuote,
}: {
  host: string;
  rootPath: string;
  requestedPath: string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}) {
  const command = `
set -eu
root=${shQuote(rootPath)}
request=${shQuote(requestedPath)}
text_limit=${PREVIEW_MAX_BYTES}
image_limit=${PREVIEW_IMAGE_MAX_BYTES}
root_real="$(cd "$root" && pwd -P)"
case "$request" in
  /*) target="$request"; requested_absolute=1 ;;
  *) target="$root_real/$request"; requested_absolute=0 ;;
esac
target_real="$(realpath "$target")"
if [ "$requested_absolute" != "1" ]; then
  case "$target_real/" in "$root_real"/*) ;; *) exit 13 ;; esac
fi
if [ "$requested_absolute" = "1" ]; then
  rel="$target_real"
else
  rel="\${target_real#"$root_real"/}"
fi
if [ -d "$target_real" ]; then
  mtime="$(stat -c %Y "$target_real" 2>/dev/null || stat -f %m "$target_real" 2>/dev/null || printf 0)"
  printf 'META\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$(printf '%s' "$root_real" | base64 | tr -d '\\n')" 0 "$mtime" "$(printf '%s' "$rel" | base64 | tr -d '\\n')" directory
  exit 0
fi
if [ ! -f "$target_real" ]; then
  echo "only regular files can be previewed" >&2
  exit 14
fi
size="$(stat -c %s "$target_real" 2>/dev/null || stat -f %z "$target_real" 2>/dev/null || printf 0)"
mtime="$(stat -c %Y "$target_real" 2>/dev/null || stat -f %m "$target_real" 2>/dev/null || printf 0)"
limit="$text_limit"
case "$(printf '%s' "$rel" | tr '[:upper:]' '[:lower:]')" in
  ${Array.from(IMAGE_MIME_TYPES.keys(), (extension) => `*.${extension}`).join("|")})
    if [ "$size" -le "$image_limit" ]; then limit="$image_limit"; fi
    ;;
esac
printf 'META\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$(printf '%s' "$root_real" | base64 | tr -d '\\n')" "$size" "$mtime" "$(printf '%s' "$rel" | base64 | tr -d '\\n')" file
head -c $((limit + 1)) "$target_real" | base64 | tr -d '\\n'
printf '\\n'
`;
  const result = await runProcessWithCodeTimeout(
    sshCommandArgv(host, `bash -lc ${shQuote(command)}`),
    PREVIEW_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `file read exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  return parseRemoteFilePreview(result.stdout, requestedPath);
}

export function parseRemoteFileDownload(
  stdout: string,
  requestedPath: string,
): FileDownloadResult {
  const lines = stdout.split(/\r?\n/);
  const meta = lines.shift() ?? "";
  const [kind, rawSize, rawRelative, rawName, rawContentType] =
    meta.split("\t");
  if (kind !== "META") {
    throw new Error(
      (stdout || "invalid file download response").trim().slice(0, 1000),
    );
  }
  const path = rawRelative
    ? Buffer.from(rawRelative, "base64").toString("utf8")
    : requestedPath.replace(/^\/+/, "");
  const filename = rawName
    ? Buffer.from(rawName, "base64").toString("utf8")
    : path.split("/").filter(Boolean).pop() || "download";
  const contentType = rawContentType
    ? Buffer.from(rawContentType, "base64").toString("utf8")
    : "application/octet-stream";
  const body = Buffer.from(lines.join(""), "base64");
  return {
    filename,
    path,
    size: Number(rawSize) || body.length,
    body,
    contentType,
  };
}

export async function downloadRemoteFile({
  host,
  rootPath,
  requestedPath,
  runProcessWithCodeTimeout,
  shQuote,
}: {
  host: string;
  rootPath: string;
  requestedPath: string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}) {
  const command = `
set -euo pipefail
root=${shQuote(rootPath)}
request=${shQuote(requestedPath)}
root_real="$(cd "$root" && pwd -P)"
case "$request" in
  /*) target="$request"; requested_absolute=1 ;;
  *) target="$root_real/$request"; requested_absolute=0 ;;
esac
target_real="$(realpath "$target")"
if [ "$requested_absolute" != "1" ]; then
  case "$target_real/" in "$root_real"/*) ;; *) exit 13 ;; esac
fi
if [ ! -f "$target_real" ] && [ ! -d "$target_real" ]; then
  echo "only regular files and directories can be downloaded" >&2
  exit 14
fi
if [ "$requested_absolute" = "1" ]; then
  rel="$target_real"
else
  rel="\${target_real#"$root_real"/}"
fi
name="\${target_real##*/}"
if [ -d "$target_real" ]; then
  parent="$(dirname "$target_real")"
  archive_name="$name.tar.gz"
  content_type="application/gzip"
  printf 'META\\t%s\\t%s\\t%s\\t%s\\n' "0" "$(printf '%s' "$rel" | base64 | tr -d '\\n')" "$(printf '%s' "$archive_name" | base64 | tr -d '\\n')" "$(printf '%s' "$content_type" | base64 | tr -d '\\n')"
  COPYFILE_DISABLE=1 tar -czf - -C "$parent" -- "$name" | base64 | tr -d '\\n'
else
  size="$(stat -c %s "$target_real" 2>/dev/null || stat -f %z "$target_real" 2>/dev/null || printf 0)"
  content_type="application/octet-stream"
  printf 'META\\t%s\\t%s\\t%s\\t%s\\n' "$size" "$(printf '%s' "$rel" | base64 | tr -d '\\n')" "$(printf '%s' "$name" | base64 | tr -d '\\n')" "$(printf '%s' "$content_type" | base64 | tr -d '\\n')"
  base64 "$target_real" | tr -d '\\n'
fi
printf '\\n'
`;
  const result = await runProcessWithCodeTimeout(
    sshCommandArgv(host, `bash -lc ${shQuote(command)}`),
    DOWNLOAD_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `file download exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  return parseRemoteFileDownload(result.stdout, requestedPath);
}

export function parseRemoteFileUpload(stdout: string): FileUploadResult {
  const [kind, rawPath, rawSize, rawOverwritten] = stdout.trim().split("\t");
  if (kind !== "META") {
    throw new Error(
      (stdout || "invalid file upload response").trim().slice(0, 1000),
    );
  }
  return {
    path: rawPath ? Buffer.from(rawPath, "base64").toString("utf8") : "",
    size: Number(rawSize) || 0,
    overwritten: rawOverwritten === "1",
  };
}

export async function uploadRemoteFile({
  host,
  rootPath,
  directory,
  filename,
  body,
  shQuote,
}: {
  host: string;
  rootPath: string;
  directory: string;
  filename: string;
  body: Buffer;
  shQuote: (value: string) => string;
}) {
  const command = `
set -euo pipefail
root=${shQuote(rootPath)}
rel=${shQuote(directory)}
name=${shQuote(filename)}
root_real="$(cd "$root" && pwd -P)"
target_dir="$root_real"
if [ -n "$rel" ]; then
  target_dir="$root_real/$rel"
fi
dir_real="$(cd "$target_dir" && pwd -P)"
case "$dir_real/" in "$root_real"/*|"$root_real/") ;; *) exit 13 ;; esac
if [ ! -d "$dir_real" ]; then
  echo "upload target is not a directory" >&2
  exit 14
fi
target="$dir_real/$name"
overwritten=0
if [ -d "$target" ] || [ -L "$target" ]; then
  echo "cannot overwrite a directory or symlink" >&2
  exit 15
fi
if [ -e "$target" ]; then overwritten=1; fi
base64 -d > "$target"
size="$(stat -c %s "$target" 2>/dev/null || stat -f %z "$target" 2>/dev/null || printf 0)"
rel_path="\${target#"$root_real"/}"
printf 'META\\t%s\\t%s\\t%s\\n' "$(printf '%s' "$rel_path" | base64 | tr -d '\\n')" "$size" "$overwritten"
`;
  const result = await runProcessWithInputTimeout(
    sshCommandArgv(host, `bash -lc ${shQuote(command)}`),
    body.toString("base64"),
    UPLOAD_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `file upload exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  return parseRemoteFileUpload(result.stdout);
}

export function parseRemoteFileDelete(stdout: string): FileDeleteResult {
  const [kind, rawPath, type] = stdout.trim().split("\t");
  if (kind !== "META") {
    throw new Error(
      (stdout || "invalid file delete response").trim().slice(0, 1000),
    );
  }
  return {
    path: rawPath ? Buffer.from(rawPath, "base64").toString("utf8") : "",
    type: type === "directory" || type === "symlink" ? type : "file",
  };
}

export async function deleteRemoteFile({
  host,
  rootPath,
  requestedPath,
  runProcessWithCodeTimeout,
  shQuote,
}: {
  host: string;
  rootPath: string;
  requestedPath: string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}) {
  const command = `
set -euo pipefail
root=${shQuote(rootPath)}
rel=${shQuote(requestedPath)}
root_real="$(cd "$root" && pwd -P)"
target="$root_real/$rel"
parent="$(dirname "$target")"
parent_real="$(cd "$parent" && pwd -P)"
case "$parent_real/" in "$root_real"/*|"$root_real/") ;; *) exit 13 ;; esac
if [ ! -e "$target" ] && [ ! -L "$target" ]; then
  echo "file does not exist" >&2
  exit 14
fi
if [ -d "$target" ] && [ ! -L "$target" ]; then
  type=directory
elif [ -L "$target" ]; then
  type=symlink
else
  type=file
fi
rm -rf -- "$target"
printf 'META\\t%s\\t%s\\n' "$(printf '%s' "$rel" | base64 | tr -d '\\n')" "$type"
`;
  const result = await runProcessWithCodeTimeout(
    sshCommandArgv(host, `bash -lc ${shQuote(command)}`),
    DELETE_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `file delete exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  return parseRemoteFileDelete(result.stdout);
}
