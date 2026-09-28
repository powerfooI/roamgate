import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCpuProfile } from "./cpu-profile";
import { silentLogger } from "./logger";

// JSC's sampler is process-global. Exercise it in children, never in Bun's
// parallel test runner. These short real captures cannot use virtual timers.
for (const mode of ["timer", "stop", "write-error"]) {
  test(`CPU profile: ${mode}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "roamgate-profile-test-"));
    const source = `
      import { startCpuProfile } from ${JSON.stringify(join(import.meta.dir, "cpu-profile.ts"))};
      import { silentLogger } from ${JSON.stringify(join(import.meta.dir, "logger.ts"))};
      import { readdirSync, rmSync } from "node:fs";
      import { join } from "node:path";
      const directory = ${JSON.stringify(directory)};
      const mode = ${JSON.stringify(mode)};
      let complete;
      const saved = new Promise(resolve => complete = resolve);
      const logger = {
        ...silentLogger,
        info(message) { if (message === "CPU profile saved") complete("saved"); },
        error(message) { complete(message); },
      };
      function profileTestWork() {
        const until = performance.now() + 5;
        while (performance.now() < until) JSON.stringify(Array.from({length: 100}, (_, i) => ({ i })));
      }
      const busy = setInterval(profileTestWork, 1);
      try {
        const capture = startCpuProfile({ directory, durationMs: mode === "timer" ? 100 : 30_000 }, "test", logger);
        if (mode !== "timer") {
          profileTestWork();
          if (mode === "write-error") rmSync(join(directory, readdirSync(directory)[0]), { recursive: true });
          await capture.stop();
        }
        const outcome = await saved;
        await capture.stop(); // idempotent, including after automatic completion
        console.log(outcome);
      } finally {
        clearInterval(busy);
      }
    `;
    const child = Bun.spawn([process.execPath, "--eval", source], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BUN_OPTIONS: "" },
    });
    const deadline = setTimeout(() => child.kill(), 5_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      if (mode === "write-error") {
        expect(stdout.trim()).toBe("CPU profile failed");
      } else {
        expect(stdout.trim()).toBe("saved");
        const folders = readdirSync(directory);
        expect(folders).toHaveLength(1);
        const output = join(directory, folders[0]);
        const profile = JSON.parse(
          readFileSync(join(output, "cpu.json"), "utf8"),
        );
        expect(profile.functions).toContain("Sampling rate:");
        expect(Array.isArray(profile.stackTraces.traces)).toBe(true);
        const summary = readFileSync(join(output, "summary.txt"), "utf8");
        expect(summary).toContain('"appVersion": "test"');
        expect(summary).toContain('"eventLoopDelayMs"');
        if (process.platform !== "win32") {
          expect(statSync(output).mode & 0o777).toBe(0o700);
          expect(statSync(join(output, "cpu.json")).mode & 0o777).toBe(0o600);
          expect(statSync(join(output, "summary.txt")).mode & 0o777).toBe(
            0o600,
          );
        }
      }
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) child.kill();
      await child.exited;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("CPU profile rejects an unusable output directory before sampling", () => {
  const directory = mkdtempSync(join(tmpdir(), "roamgate-profile-test-"));
  try {
    const file = join(directory, "file");
    writeFileSync(file, "occupied");
    expect(() =>
      startCpuProfile(
        { directory: file, durationMs: 100 },
        "test",
        silentLogger,
      ),
    ).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
