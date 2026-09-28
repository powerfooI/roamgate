# Terminal hot-path benchmark

Compare the current Bun terminal conversion code with a direct, single-threaded
Rust full-repaint port. This is an isolated experiment, not a replacement server
or a benchmark of Herdr's native TUI.

## Run

Requires macOS, Python 3.9+, Bun (the workspace's supported version), Cargo and
Rust 1.78+. Install workspace dependencies with `bun install --frozen-lockfile`.
Rust dependencies are pinned in `Cargo.lock`. The runner uses an isolated Cargo
home and builds outside ancestor Cargo configuration; it never changes global
registry settings.

From the repository root:

```sh
# Normal load only; a fresh output directory is required.
python3 scripts/bench-terminal/run.py \
  --output scripts/bench-terminal/results/normal

# Explicitly opt into CPU contention. This can temporarily slow other apps.
# Choose at most the machine's logical CPU count.
python3 scripts/bench-terminal/run.py \
  --output scripts/bench-terminal/results/comparison --stress-workers 12
```

The default is five repetitions, two seconds of warmup and five seconds of
measurement per process, across five scenarios. That is approximately six
minutes without pressure and twelve minutes with pressure, excluding builds.
`--seconds`, `--warmup` and `--repeats` accept bounded overrides for smoke checks.
Each process reloads the same fixture, warms up, then cycles its 16 frames as fast
as possible. Bun is compiled/minified with the production compile settings;
Rust uses Cargo's release profile. Neither uses workers for the measured code.

Pressure is a fixed number of independent Python PBKDF2 CPU workers, not real
user workload. Workers have a finite lifetime; the runner also terminates and
waits for them in `finally`, including on ordinary interruption or failure.
Benchmark processes run sequentially with alternating Bun/Rust order. Unrelated
applications, scheduler placement and thermal changes remain uncontrolled.

## Measured boundary

Input is a **predecoded, trusted synthetic cell grid**, not captured terminal
contents. No live sockets, private sessions, service restarts or user settings
are involved. Timed work is:

1. Crop a pane (Bun imports production `cropFrame`).
2. Serialize the content-identity fields used by `onSurface`, including cells.
3. Encode a full ANSI repaint (Bun imports production `frameToAnsi`).
4. Copy/encode its bytes into Base64 and serialize a terminal JSON envelope.

The Rust implementation keeps the same traversal, trailing-blank trimming,
string style keys, color/modifier/link handling and full repaint strategy. It
uses borrowed cell references instead of cloning cells, as Bun's crop also
copies references. It is deliberately not Herdr's differential `BlitEncoder`.
Rust strings, serde, Base64 and Unicode width implementation are different
implementations: results compare these concrete stacks, not an abstract
language speed ratio or the best achievable implementation in either language.

The content JSON and final payload must have matching SHA-256 hashes for every
fixture before any timing proceeds. This covers 80 workload frames and 64 small
edge frames (color, modifiers, links, clipping, cursor and Unicode). This checks
byte equivalence for the corpus, not all possible Unicode sequences or protocol
inputs. Rust adds a compatibility adjustment for U+FF9E/U+FF9F, which Bun counts
as one column but unicode-width 0.2 counts as zero. A production port would need
broader Unicode compatibility testing. JSON fixture parsing and verification
hashes are outside the timed loop.

Workloads are sparse edits, scrolling-like logs, multilingual/emoji output, a
dense 160x48 surface, and an 80x24 pane cropped from a 160x48 split surface.
Sparse frames still traverse and repaint the grid in both implementations.

## Results and interpretation

Each fresh output directory contains:

- `metadata.json`: compiler/runtime/host identity, settings and source/fixture hashes.
- `verification.json` and `fixtures.json`: byte-equivalence evidence and exact inputs.
- `samples.jsonl`: one raw record per process, preserved as runs complete.
- `summary.json`: medians across repetitions, throughput range and Rust/Bun ratios.

`fps` is **conversion capacity**, not displayed browser frame rate. Percentiles
are individual synchronous transform service times under a closed-loop load,
not request queuing time or input-to-screen latency. CPU time includes all
process threads during measurement. Hashing is excluded; both implementations
consume outputs to prevent dead-code elimination. The latency array and frame
counter are outside the per-transform timer but inside throughput/CPU timing.

Peak RSS comes from macOS `/usr/bin/time -l`, covers the entire process lifetime,
and includes loading all fixtures, warmup, runtime and the latency array. Faster
runs collect more latency samples. Do not interpret this as production server
memory per connection. Summary percentiles are medians of per-run percentiles,
not a pooled latency distribution. Inspect all repetitions before drawing a
conclusion; no statistical-significance claim is made.

This experiment **excludes** wire/bincode/delta decoding and validation, pane
lookup and session state machines, content comparison/link-token management,
viewer fanout, compression, WebSocket/network behavior, input scheduling, browser
ANSI parsing and drawing. The packaging envelope omits dynamic link/history and
connection metadata. Neither version applies stateful diffing or backpressure.

A favorable Rust result here does not establish a benefit from rewriting the
whole server. That requires a separate matched transport/browser experiment,
including queue age and input-to-presentation latency under representative load.
Store dated measurements in external artifacts or PRs, not this document.
