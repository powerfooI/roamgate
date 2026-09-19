import { readFile, readdir, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const publicRoot = fileURLToPath(new URL("../server/public/", import.meta.url));
const maxFileCount = 160;
const maxTotalBytes = 12 * 1024 * 1024;
const maxInitialJsBytes = 660 * 1024;
const maxInitialJsGzipBytes = 200 * 1024;
const maxInitialCssBytes = 196 * 1024;

/** Follow eager imports only, from app entries or explicitly selected features. */
export function initialAssetFiles(
  manifest,
  entries = Object.keys(manifest).filter((key) => manifest[key].isEntry),
) {
  if (!entries.length) throw new Error("Vite manifest has no entry points");
  const visited = new Set();
  const files = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Missing Vite manifest chunk: ${key}`);
    visited.add(key);
    files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const dependency of chunk.imports ?? []) visit(dependency);
  }
  for (const entry of entries) visit(entry);
  return [...files];
}

export function assertLazyGrammarAssets(manifest) {
  const grammarFiles = new Set(
    Object.entries(manifest)
      .filter(
        ([key, chunk]) =>
          chunk.name?.startsWith("syntax-") ||
          (key.includes("@shikijs") && key.includes("langs")),
      )
      .map(([, chunk]) => chunk.file),
  );
  for (const name of ["ConfigurationDialog", "WorkspaceInspectorHost"]) {
    const entries = Object.keys(manifest).filter(
      (key) => manifest[key].name === name,
    );
    if (!entries.length) throw new Error(`Missing Vite feature chunk: ${name}`);
    for (const file of initialAssetFiles(manifest, entries)) {
      if (grammarFiles.has(file)) {
        throw new Error(`${name} eagerly loads syntax grammar asset: ${file}`);
      }
    }
  }
}

async function collectAssetStats(root) {
  const directories = [root];
  let fileCount = 0;
  let totalBytes = 0;

  while (directories.length) {
    const directory = directories.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }
      const metadata = await stat(path);
      fileCount += 1;
      totalBytes += metadata.size;
    }
  }

  return { fileCount, totalBytes };
}

async function checkAssets() {
  const { fileCount, totalBytes } = await collectAssetStats(publicRoot);
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(`${publicRoot}/.vite/manifest.json`, "utf8"),
    );
  } catch (cause) {
    throw new Error(
      "Cannot read the Vite manifest; run the frontend build first",
      { cause },
    );
  }
  assertLazyGrammarAssets(manifest);
  let jsBytes = 0;
  let jsGzipBytes = 0;
  let cssBytes = 0;
  for (const file of initialAssetFiles(manifest)) {
    const content = await readFile(`${publicRoot}/${file}`);
    if (file.endsWith(".js")) {
      jsBytes += content.length;
      jsGzipBytes += gzipSync(content).length;
    } else if (file.endsWith(".css")) {
      cssBytes += content.length;
    }
  }
  const checks = [
    ["files", fileCount, maxFileCount, 1, "files"],
    ["total", totalBytes, maxTotalBytes, 1024 * 1024, "MiB"],
    ["initial JS", jsBytes, maxInitialJsBytes, 1024, "KiB"],
    ["initial JS gzip", jsGzipBytes, maxInitialJsGzipBytes, 1024, "KiB"],
    ["initial CSS", cssBytes, maxInitialCssBytes, 1024, "KiB"],
  ];
  for (const [name, actual, max, unit, suffix] of checks) {
    const exceeded = actual > max;
    const message = `web asset ${name}: ${(actual / unit).toFixed(1)}/${max / unit} ${suffix}${exceeded ? " (budget exceeded)" : ""}\n`;
    (exceeded ? process.stderr : process.stdout).write(message);
    if (exceeded) process.exitCode = 1;
  }
}

if (import.meta.main) await checkAssets();
