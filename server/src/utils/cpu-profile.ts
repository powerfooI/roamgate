import { profile } from "bun:jsc";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Logger } from "./logger";

/** One bounded, opt-in capture; never opens a debugger or a network endpoint. */
export function startCpuProfile(
  options: { directory: string; durationMs: number },
  appVersion: string,
  logger: Logger,
): { stop: () => Promise<void> } {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(options.directory, "roamgate-"));
  let release!: () => void;
  const lifetime = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delay = monitorEventLoopDelay({ resolution: 20 });
  const cpuStart = process.cpuUsage();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  // The bounded callback API stops sampling before exporting. Do not use
  // startSamplingProfiler's exit hook: it crashes on exit in Bun 1.4.2/macOS.
  const capture = profile(() => lifetime, 1_000);
  delay.enable();
  const timer = setTimeout(release, options.durationMs);
  timer.unref();
  const done = capture
    .then((result) => {
      delay.disable();
      const cpu = process.cpuUsage(cpuStart);
      const metrics = {
        appVersion,
        bunVersion: Bun.version,
        startedAt,
        elapsedMs: performance.now() - start,
        cpuMs: { user: cpu.user / 1_000, system: cpu.system / 1_000 },
        rssBytes: process.memoryUsage().rss,
        eventLoopDelayMs: {
          count: delay.count,
          mean: delay.count ? delay.mean / 1e6 : null,
          p50: delay.count ? delay.percentile(50) / 1e6 : null,
          p95: delay.count ? delay.percentile(95) / 1e6 : null,
          p99: delay.count ? delay.percentile(99) / 1e6 : null,
          max: delay.count ? delay.max / 1e6 : null,
        },
      };
      writeFileSync(join(directory, "cpu.json"), JSON.stringify(result), {
        mode: 0o600,
        flag: "wx",
      });
      writeFileSync(
        join(directory, "summary.txt"),
        `${JSON.stringify(metrics, null, 2)}\n${result.functions}\n${result.bytecodes}\n`,
        { mode: 0o600, flag: "wx" },
      );
      logger.info("CPU profile saved", { directory });
    })
    .catch((error) => {
      logger.error("CPU profile failed", { directory, error });
    })
    .finally(() => {
      clearTimeout(timer);
      delay.disable();
    });
  logger.info("CPU profiling enabled", {
    directory,
    seconds: options.durationMs / 1_000,
    note: "sampling adds overhead; capture stops automatically",
  });
  return {
    stop() {
      release();
      return done;
    },
  };
}
