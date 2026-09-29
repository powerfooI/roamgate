import {
  lstat,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DOWNLOAD_TIMEOUT_MS, LIST_LIMIT } from "./file-constants";
import {
  assertInsideRoot,
  entrySort,
  relativeExplorerPath,
  relativePreviewPath,
} from "./file-paths";
import type {
  FileDeleteResult,
  FileDownloadResult,
  FileExplorerEntry,
  FileListResult,
  FilePreviewResult,
  FileUploadResult,
} from "./file-types";
import { runBinaryProcessWithTimeout } from "./process";
import { decodePreviewBuffer, previewLimitForPath } from "./preview";
import { fileDownloadRange, type FileDownloadOptions } from "./file-download";

export async function listLocalFiles(
  rootPath: string,
  relativePath: string,
  showHidden: boolean,
  followDirectoryLinks = false,
): Promise<FileListResult> {
  const rootReal = await realpath(rootPath);
  const targetReal = await realpath(resolve(rootReal, relativePath));
  assertInsideRoot(rootReal, targetReal);
  const dirents = await readdir(targetReal, { withFileTypes: true });
  const entries: FileExplorerEntry[] = [];
  for (const dirent of dirents) {
    if (!showHidden && dirent.name.startsWith(".")) continue;
    const entryPath = join(targetReal, dirent.name);
    const info = await stat(entryPath).catch(() => null);
    const type =
      dirent.isDirectory() || (followDirectoryLinks && info?.isDirectory())
        ? "directory"
        : dirent.isSymbolicLink()
          ? "symlink"
          : "file";
    entries.push({
      name: dirent.name,
      path: relativeExplorerPath(relativePath, dirent.name),
      type,
      size: info?.size ?? 0,
      mtime_ms: info ? info.mtimeMs : 0,
      hidden: dirent.name.startsWith("."),
    });
  }
  entries.sort(entrySort);
  return {
    root: rootReal,
    path: relativePath,
    entries: entries.slice(0, LIST_LIMIT),
    truncated: entries.length > LIST_LIMIT,
  };
}

export async function resolveLocalFilePaths(
  rootPath: string,
  requestedPaths: string[],
) {
  const rootReal = await realpath(rootPath);
  const resolved = await Promise.all(
    requestedPaths.map(async (requestedPath) => {
      try {
        const requestedAbsolute = isAbsolute(requestedPath);
        const targetReal = await realpath(
          requestedAbsolute ? requestedPath : resolve(rootReal, requestedPath),
        );
        if (!requestedAbsolute) assertInsideRoot(rootReal, targetReal);
        const info = await stat(targetReal);
        return info.isFile() || info.isDirectory() ? requestedPath : null;
      } catch {
        return null;
      }
    }),
  );
  return resolved.filter((path): path is string => !!path);
}

export async function readLocalFile(
  rootPath: string,
  requestedPath: string,
): Promise<FilePreviewResult> {
  const rootReal = await realpath(rootPath);
  const requestedAbsolute = isAbsolute(requestedPath);
  const targetReal = await realpath(
    requestedAbsolute ? requestedPath : resolve(rootReal, requestedPath),
  );
  if (!requestedAbsolute) assertInsideRoot(rootReal, targetReal);
  const info = await stat(targetReal);
  const displayPath = requestedAbsolute
    ? targetReal
    : relativePreviewPath(rootReal, targetReal);
  if (info.isDirectory()) {
    return {
      root: rootReal,
      path: displayPath,
      type: "directory",
      size: 0,
      mtime_ms: info.mtimeMs,
      truncated: false,
      text: null,
      binary: false,
    };
  }
  if (!info.isFile()) {
    throw new Error("only regular files can be previewed");
  }
  const previewLimit = previewLimitForPath(displayPath, info.size);
  const raw = Buffer.from(
    await Bun.file(targetReal)
      .slice(0, previewLimit + 1)
      .arrayBuffer(),
  );
  const truncated = info.size > previewLimit || raw.length > previewLimit;
  const bytes = truncated ? raw.subarray(0, previewLimit) : raw;
  const decoded = decodePreviewBuffer(bytes, truncated, displayPath);
  return {
    root: rootReal,
    path: displayPath,
    size: info.size,
    mtime_ms: info.mtimeMs,
    truncated,
    ...decoded,
  };
}

export async function downloadLocalFile(
  rootPath: string,
  requestedPath: string,
  options: FileDownloadOptions = {},
): Promise<FileDownloadResult> {
  const rootReal = await realpath(rootPath);
  const requestedAbsolute = isAbsolute(requestedPath);
  const targetReal = await realpath(
    requestedAbsolute ? requestedPath : resolve(rootReal, requestedPath),
  );
  if (!requestedAbsolute) assertInsideRoot(rootReal, targetReal);
  const info = await stat(targetReal);
  const displayPath = requestedAbsolute
    ? targetReal
    : relativePreviewPath(rootReal, targetReal);
  if (info.isDirectory()) {
    const archiveName = `${basename(targetReal) || "download"}.tar.gz`;
    const result = await runBinaryProcessWithTimeout(
      [
        "tar",
        "-czf",
        "-",
        "-C",
        dirname(targetReal),
        "--",
        basename(targetReal),
      ],
      DOWNLOAD_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      throw new Error(
        (result.stderr || `tar exited ${result.code}`).trim().slice(0, 1000),
      );
    }
    return {
      filename: archiveName,
      path: displayPath,
      size: result.stdout.length,
      body: result.stdout,
      contentType: "application/gzip",
    };
  }
  if (!info.isFile()) {
    throw new Error("only regular files and directories can be downloaded");
  }
  const range = fileDownloadRange(displayPath, info.size, options);
  const start = range?.start ?? 0;
  const end = range ? range.end + 1 : info.size;
  return {
    acceptRanges: true,
    ...(range
      ? { contentRange: `bytes ${start}-${end - 1}/${info.size}` }
      : {}),
    filename: basename(targetReal) || "download",
    path: displayPath,
    size: end - start,
    body: Bun.file(targetReal).slice(start, end),
    contentType: "application/octet-stream",
  };
}

export async function uploadLocalFile(
  rootPath: string,
  directory: string,
  filename: string,
  body: Buffer,
): Promise<FileUploadResult> {
  const rootReal = await realpath(rootPath);
  const directoryReal = await realpath(resolve(rootReal, directory));
  assertInsideRoot(rootReal, directoryReal);
  const info = await stat(directoryReal);
  if (!info.isDirectory()) throw new Error("upload target is not a directory");
  const targetPath = resolve(directoryReal, filename);
  const existed = await lstat(targetPath)
    .then((target) => {
      if (target.isDirectory() || target.isSymbolicLink()) {
        throw new Error("cannot overwrite a directory or symlink");
      }
      return true;
    })
    .catch((e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    });
  await writeFile(targetPath, body);
  return {
    path: relativePreviewPath(rootReal, targetPath),
    size: body.length,
    overwritten: existed,
  };
}

export async function deleteLocalFile(
  rootPath: string,
  requestedPath: string,
): Promise<FileDeleteResult> {
  const rootReal = await realpath(rootPath);
  const targetPath = resolve(rootReal, requestedPath);
  const parentReal = await realpath(dirname(targetPath));
  assertInsideRoot(rootReal, parentReal);
  const info = await lstat(targetPath);
  await rm(targetPath, {
    recursive: info.isDirectory(),
    force: false,
  });
  return {
    path: relativePreviewPath(rootReal, targetPath),
    type: info.isDirectory()
      ? "directory"
      : info.isSymbolicLink()
        ? "symlink"
        : "file",
  };
}
