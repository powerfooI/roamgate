import { createHash } from "node:crypto";
import { cropFrame } from "../../server/src/bridge/endpoint-terminal-session";
import { frameToAnsi } from "../../server/src/bridge/frame-to-ansi";
import type { CellData, FrameData } from "../../server/src/bridge/thin-client";

interface Fixture {
  name: string;
  frame: FrameData;
  rect: { x: number; y: number; width: number; height: number };
  revision: number;
}

function cell(symbol: string, extra: Partial<CellData> = {}): CellData {
  return {
    symbol,
    fg: 0,
    bg: 0,
    modifier: 0,
    skip: false,
    hyperlink: null,
    ...extra,
  };
}

// Synthetic, deterministic frames only: never read user terminal contents.
function fixtures(): Fixture[] {
  const result: Fixture[] = [];
  for (const name of ["sparse", "logs", "unicode", "dense", "split"]) {
    const width = name === "dense" || name === "split" ? 160 : 100;
    const height = width === 160 ? 48 : 30;
    for (let tick = 0; tick < 16; tick++) {
      const cells: CellData[] = [];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const phase = name === "sparse" ? 0 : tick;
          const text = `const pane_${y} = render(${phase}); // terminal output `;
          const column = name === "split" ? x % 80 : x;
          const blank = name !== "dense" && column >= 68;
          cells.push(
            cell(blank ? " " : text[(x + phase) % text.length], {
              fg: blank ? 0 : column < 16 ? 0x0200aaff : 0x00000002,
              bg: name === "dense" ? 0x020c1824 : 0,
              modifier: blank ? 0 : column < 16 ? 1 : 0,
              hyperlink: !blank && column >= 20 && column < 30 ? 0 : null,
            }),
          );
        }
      }
      cells[tick % width] = cell(String(tick % 10));
      if (name === "unicode") {
        for (let y = 0; y < height; y++) {
          let x = 0;
          for (const symbol of [
            "中",
            "🙂",
            "👩‍💻",
            "🇨🇳",
            "ｶﾞ",
            "ﾊﾟ",
            "e\u0301",
          ]) {
            cells[y * width + x] = cell(symbol, { fg: 0x02123456 });
            const size = Bun.stringWidth(symbol);
            for (let pad = 1; pad < size; pad++) {
              cells[y * width + x + pad] = cell(" ", { skip: y % 2 === 0 });
            }
            x += size;
          }
        }
      }
      result.push({
        name,
        frame: {
          cells,
          width,
          height,
          cursor: { x: tick, y: height - 1, visible: true, shape: 5 },
          hyperlinks: ["https://example.com/path?q=1&lang=zh"],
        },
        rect:
          name === "split"
            ? { x: 80, y: 24, width: 80, height: 24 }
            : { x: 0, y: 0, width, height },
        revision: tick,
      });
    }
  }
  // Edge cases are validated but not used as throughput workloads.
  for (let i = 0; i < 64; i++) {
    const symbols = ["中", "🙂", "e\u0301", "a", " ", '"', "\\", "\t"];
    result.push({
      name: "edge",
      frame: {
        width: 8,
        height: 2,
        cells: Array.from({ length: 16 }, (_, j) =>
          cell(symbols[(i + j) % symbols.length], {
            fg: [0, 1, 8, 9, 16, 0x0100007b, 0x02123456][j % 7],
            bg: j % 3 === 0 ? 0x02abcdef : 0,
            modifier: (i * 997 + j * 31) & 0xffff,
            skip: (i + j) % 11 === 0,
            hyperlink: [null, 0, 1, 9][j % 4],
          }),
        ),
        cursor:
          i % 4 === 0
            ? null
            : { x: i % 8, y: 1, visible: i % 3 !== 0, shape: 2 },
        hyperlinks: ["https://example.com/中", "file:///tmp/test.txt"],
      },
      rect: { x: i % 3, y: i % 2, width: 1 + (i % 8), height: 2 },
      revision: i,
    });
  }
  return result;
}

// Same hot-path operations as onSurface + terminal-bridge's packaging. No
// socket decode, state machine, compression, transport or browser is timed.
function transform(fixture: Fixture): [string, string] {
  const cropped = cropFrame(fixture.frame, fixture.rect);
  const content = JSON.stringify({
    paneId: "bench-pane",
    revision: fixture.revision,
    rect: fixture.rect,
    scroll: null,
    width: cropped.width,
    height: cropped.height,
    cells: cropped.cells,
    hyperlinks: cropped.hyperlinks,
  });
  const bytes = Buffer.from(frameToAnsi(cropped), "utf8");
  const payload = JSON.stringify({
    terminal: {
      terminal_id: "bench-terminal",
      width: cropped.width,
      height: cropped.height,
      full: true,
      bytes: Buffer.from(bytes).toString("base64"),
    },
  });
  return [content, payload];
}

const [mode, path, scenario, secondsText = "10", warmupText = "3"] =
  Bun.argv.slice(2);
if (mode === "fixtures") {
  await Bun.write(path, JSON.stringify(fixtures()));
} else {
  const all: Fixture[] = await Bun.file(path).json();
  if (mode === "dump") {
    console.log(JSON.stringify(transform(all[Number(scenario)])));
  } else if (mode === "verify") {
    console.log(
      JSON.stringify(
        all.map((fixture) =>
          transform(fixture).map((text) =>
            createHash("sha256").update(text).digest("hex"),
          ),
        ),
      ),
    );
  } else if (mode === "bench") {
    const selected = all.filter((fixture) => fixture.name === scenario);
    if (!selected.length) throw new Error(`Unknown scenario: ${scenario}`);
    const seconds = Number(secondsText);
    const warmup = Number(warmupText);
    if (!(seconds > 0 && seconds <= 120 && warmup >= 0 && warmup <= 60))
      throw new Error("Invalid benchmark duration");
    let sequence = 0;
    let checksum = 0;
    const consume = () => {
      const [content, payload] = transform(
        selected[sequence++ % selected.length],
      );
      // Observe both strings without hashing inside the timed section. Content
      // is UTF-16 in JS, so use payload (ASCII) for cross-runtime byte accounting.
      checksum =
        (checksum + content.charCodeAt(content.length - 1) + payload.length) >>>
        0;
      return payload.length;
    };
    const warmupEnd = performance.now() + warmup * 1000;
    while (performance.now() < warmupEnd) consume();
    sequence = 0;
    checksum = 0;
    const latencies: number[] = [];
    let payloadBytes = 0;
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    const end = start + seconds * 1000;
    while (performance.now() < end) {
      const before = performance.now();
      payloadBytes += consume();
      latencies.push((performance.now() - before) * 1000);
    }
    const elapsed = (performance.now() - start) / 1000;
    const cpu = process.cpuUsage(cpuStart);
    latencies.sort((a, b) => a - b);
    const percentile = (p: number) =>
      latencies[Math.ceil(latencies.length * p) - 1];
    console.log(
      JSON.stringify({
        runtime: "bun",
        scenario,
        frames: sequence,
        seconds: elapsed,
        fps: sequence / elapsed,
        cpu_seconds: (cpu.user + cpu.system) / 1e6,
        cpu_us_per_frame: (cpu.user + cpu.system) / sequence,
        p50_us: percentile(0.5),
        p95_us: percentile(0.95),
        p99_us: percentile(0.99),
        max_us: latencies[latencies.length - 1],
        payload_bytes: payloadBytes,
        checksum,
      }),
    );
  } else {
    throw new Error(
      "Usage: worker fixtures|verify|bench FILE [SCENARIO SECONDS WARMUP]",
    );
  }
}
