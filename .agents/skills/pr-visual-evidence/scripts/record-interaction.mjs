import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [scenarioPath, outputPath] = process.argv.slice(2);
if (!scenarioPath) {
  throw new Error(
    "Usage: record-interaction.mjs SCENARIO.mjs [OUTPUT_PARENT] (from a directory with node_modules/playwright)",
  );
}
const require = createRequire(resolve("package.json"));
const { chromium } = require(resolve("node_modules/playwright"));
const scenario = await import(pathToFileURL(resolve(scenarioPath)).href);
if (
  typeof scenario.setup !== "function" ||
  typeof scenario.run !== "function"
) {
  throw new Error("Scenario must export setup(page) and run(page)");
}
const output = await mkdtemp(
  join(outputPath ? resolve(outputPath) : tmpdir(), "pr-recording-"),
);
process.stderr.write(`Recording directory: ${output}\n`);
const viewport = scenario.viewport ?? { width: 960, height: 540 };
const browser = await chromium.launch({
  headless: process.env.HEADLESS === "1",
});
try {
  const context = await browser.newContext({
    viewport,
    reducedMotion: "no-preference",
    recordVideo: { dir: output, size: viewport },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await scenario.setup(page, { outputDir: output });
  await setTimeout(1000);
  await scenario.run(page, { outputDir: output });
  await setTimeout(1000);
  const video = page.video();
  await context.close();
  await video.saveAs(resolve(output, "raw.webm"));
  await video.delete();
  process.stdout.write(`${resolve(output, "raw.webm")}\n`);
} finally {
  await browser.close();
}
