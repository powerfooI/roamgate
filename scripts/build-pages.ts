import { cp, copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTutorial, verifySiteReferences } from "./pages-content";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDirectory = join(root, "site");
const outputDirectory = join(root, ".pages-dist");
const assetDirectory = join(outputDirectory, "assets");

const assets = [
  ["docs/images/roamgate-desktop-changes.png", "roamgate-desktop-changes.png"],
  ["docs/images/roamgate-desktop-files.png", "roamgate-desktop-files.png"],
  [
    "docs/images/roamgate-desktop-annotations.png",
    "roamgate-desktop-annotations.png",
  ],
  ["docs/images/roamgate-mobile-changes.png", "roamgate-mobile-changes.png"],
  ["docs/images/roamgate-mobile-files.png", "roamgate-mobile-files.png"],
  ["docs/images/roamgate-mobile-terminal.png", "roamgate-mobile-terminal.png"],
  ["docs/images/roamgate-desktop-ranger.png", "roamgate-desktop-ranger.png"],
  ["docs/images/roamgate-mobile-ranger.png", "roamgate-mobile-ranger.png"],
] as const;

async function ensureFile(path: string): Promise<void> {
  const file = await stat(path);
  if (!file.isFile()) throw new Error(`Expected a file at ${path}`);
}

await rm(outputDirectory, { force: true, recursive: true });
await cp(sourceDirectory, outputDirectory, { recursive: true });
await mkdir(assetDirectory, { recursive: true });

for (const [source, destination] of assets) {
  const sourcePath = join(root, source);
  await ensureFile(sourcePath);
  await copyFile(sourcePath, join(assetDirectory, destination));
}

const tutorial = await renderTutorial(
  await Bun.file(join(root, "docs/TUTORIAL.md")).text(),
);
const tutorialPath = join(outputDirectory, "tutorial/index.html");
const template = await Bun.file(tutorialPath).text();
for (const slot of ["content", "navigation"]) {
  if (!template.includes(`<!-- tutorial:${slot} -->`)) {
    throw new Error(`Missing tutorial template slot: ${slot}`);
  }
}
await writeFile(
  tutorialPath,
  template
    .replace("<!-- tutorial:content -->", () => tutorial.content)
    .replace("<!-- tutorial:navigation -->", () => tutorial.navigation),
);

const build = await Bun.build({
  entrypoints: [
    join(sourceDirectory, "main.js"),
    join(sourceDirectory, "styles.css"),
    join(sourceDirectory, "tutorial.js"),
    join(sourceDirectory, "tutorial.css"),
  ],
  outdir: outputDirectory,
  minify: true,
  target: "browser",
});
if (!build.success) {
  throw new AggregateError(build.logs, "Failed to optimize the Pages site");
}

await writeFile(join(outputDirectory, ".nojekyll"), "");
await verifySiteReferences(outputDirectory);

const size = await Array.fromAsync(
  new Bun.Glob("**/*").scan({ cwd: outputDirectory, onlyFiles: true }),
  async (path) => {
    const file = await stat(join(outputDirectory, path));
    return file.size;
  },
).then((sizes) => sizes.reduce((total, fileSize) => total + fileSize, 0));

process.stdout.write(
  `Built GitHub Pages site in .pages-dist (${assets.length} shared screenshots, ${(size / 1024 / 1024).toFixed(2)} MiB)\n`,
);
