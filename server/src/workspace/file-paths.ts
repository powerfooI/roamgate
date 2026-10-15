import { isAbsolute, relative, sep } from "node:path";
import type { FileExplorerEntry } from "./file-types";

export function sanitizeExplorerPath(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part.includes("\0"))) {
    throw new Error("invalid file explorer path");
  }
  return parts.join("/");
}

export function sanitizeMutationPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    isAbsolute(value) ||
    (process.platform === "win32" && /^[a-z]:/i.test(value))
  ) {
    throw new Error("file operations require a workspace-relative path");
  }
  if (process.platform === "win32") return sanitizeExplorerPath(value);
  const parts = value.split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part.includes("\0"))) {
    throw new Error("invalid file explorer path");
  }
  return parts.join("/");
}

/** Filesystem browsing requires an explicit absolute directory on the host. */
export function sanitizeFilesystemPath(value: unknown): string {
  const path =
    typeof value === "string" ? value.trim().replace(/\\/g, "/") : "";
  if (
    (!path.startsWith("/") && !/^[a-z]:\//i.test(path)) ||
    path.includes("\0")
  ) {
    throw new Error("filesystem browsing requires an absolute path");
  }
  return path;
}

export function sanitizePreviewPath(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const normalized = raw.replace(/\\/g, "/");
  const absolute = normalized.startsWith("/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part.includes("\0"))) {
    throw new Error("invalid file preview path");
  }
  return absolute ? `/${parts.join("/")}` : parts.join("/");
}

export function sanitizeUploadFilename(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (
    !raw ||
    raw === "." ||
    raw === ".." ||
    raw.includes("/") ||
    raw.includes("\\") ||
    raw.includes("\0")
  ) {
    throw new Error("invalid upload filename");
  }
  return raw;
}

export function entrySort(a: FileExplorerEntry, b: FileExplorerEntry) {
  if (a.type === "directory" && b.type !== "directory") return -1;
  if (a.type !== "directory" && b.type === "directory") return 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export function relativeExplorerPath(parentPath: string, name: string) {
  return parentPath ? `${parentPath}/${name}` : name;
}

export function assertInsideRoot(rootReal: string, targetReal: string) {
  const rel = relative(rootReal, targetReal);
  if (rel && (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))) {
    throw new Error("file explorer path escaped the workspace checkout");
  }
}

export function relativePreviewPath(rootReal: string, targetReal: string) {
  return relative(rootReal, targetReal).split(sep).join("/");
}

function contentDisposition(
  filename: string,
  disposition: "attachment" | "inline",
) {
  const fallback = filename.replace(/[^\x20-\x7e]|["\r\n]/g, "_") || "download";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function downloadContentDisposition(filename: string) {
  return contentDisposition(filename, "attachment");
}

export function inlineContentDisposition(filename: string) {
  return contentDisposition(filename, "inline");
}
