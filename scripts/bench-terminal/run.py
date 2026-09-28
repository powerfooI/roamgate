#!/usr/bin/env python3
"""macOS-only, isolated terminal hot-path comparison. No live Herdr connection."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import statistics
import subprocess
import sys
import tempfile
import time
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SCENARIOS = ["sparse", "logs", "unicode", "dense", "split"]


def run(command, **kwargs):
    kwargs.setdefault("cwd", ROOT)
    return subprocess.run(command, check=True, text=True, **kwargs)


def version(command):
    return run(command, capture_output=True).stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seconds", type=float, default=5)
    parser.add_argument("--warmup", type=float, default=2)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--stress-workers", type=int, default=0,
                        help="Opt-in bounded CPU load; 0 measures normal load only")
    args = parser.parse_args()
    if platform.system() != "Darwin":
        parser.error("This runner uses macOS /usr/bin/time -l RSS accounting")
    if not (0 < args.seconds <= 30 and 0 <= args.warmup <= 10
            and 1 <= args.repeats <= 10 and 0 <= args.stress_workers <= (os.cpu_count() or 1)):
        parser.error("Duration, repetitions or worker count is outside the bounded limits")
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    fixture = out / "fixtures.json"
    manifest = HERE / "Cargo.toml"
    rust = HERE / "target/release/roamgate-terminal-bench"
    # Avoid inheriting unrelated ancestor .cargo mirror configuration. Keep
    # downloads/builds local to the experiment, without editing user settings.
    sdk = version(["xcrun", "--sdk", "macosx", "--show-sdk-path"])
    cargo_env = dict(os.environ, CARGO_HOME=str(HERE / "target/cargo-home"), SDKROOT=sdk)
    run(["cargo", "build", "--release", "--locked", "--manifest-path", str(manifest)],
        cwd=tempfile.gettempdir(), env=cargo_env)
    # A standalone Bun executable, matching production's distribution model.
    bun = out / "bun-terminal-bench"
    run(["bun", "build", "--compile", "--minify", "--sourcemap",
         "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
         str(HERE / "worker.ts"), "--outfile", str(bun)])
    run([str(bun), "fixtures", str(fixture)])
    commands = {"bun": [str(bun)], "rust": [str(rust)]}
    hashes = {}
    for runtime, command in commands.items():
        try:
            hashes[runtime] = json.loads(run(command + ["verify", str(fixture)], capture_output=True).stdout)
        except (ValueError, subprocess.SubprocessError) as error:
            raise RuntimeError(f"{runtime} output verification failed") from error
    (out / "verification.json").write_text(json.dumps(hashes, indent=2))
    if hashes["bun"] != hashes["rust"]:
        raise RuntimeError(f"Output equivalence FAILED; inspect {out / 'verification.json'}")
    print(f"PASS: {len(hashes['bun'])} fixtures, content + payload SHA-256 identical", flush=True)
    metadata = {
        "source_commit": version(["git", "rev-parse", "HEAD"]),
        "git_status": version(["git", "status", "--short"]),
        "platform": platform.platform(),
        "cpu": version(["sysctl", "-n", "machdep.cpu.brand_string"]),
        "logical_cpus": os.cpu_count(),
        "bun": version(["bun", "--version"]),
        "rustc": version(["rustc", "--version"]),
        "cargo": version(["cargo", "--version"]),
        "sdk": sdk,
        "fixture_sha256": hashlib.sha256(fixture.read_bytes()).hexdigest(),
        "settings": {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
        "source_sha256": {
            str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in [HERE / "worker.ts", HERE / "src/main.rs", manifest, HERE / "Cargo.lock",
                      HERE / "run.py", ROOT / "server/src/bridge/frame-to-ansi.ts",
                      ROOT / "server/src/bridge/endpoint-terminal-session.ts"]
        },
    }
    (out / "metadata.json").write_text(json.dumps(metadata, indent=2))
    records = []
    conditions = ["normal"] + (["pressure"] if args.stress_workers else [])
    for condition in conditions:
        stress = []
        try:
            if condition == "pressure":
                # Finite workers plus finally cleanup. No priority changes, live
                # services, filesystem churn, unbounded yes processes or sleeps.
                duration = (args.seconds + args.warmup + 3) * args.repeats * len(SCENARIOS) * 2 + 60
                code = (
                    "import hashlib,time; "
                    f"end=time.monotonic()+{duration}; "
                    "print('ready',flush=True)\n"
                    "while time.monotonic()<end: hashlib.pbkdf2_hmac('sha256',b'bench',b'cpu',20000)"
                )
                for _ in range(args.stress_workers):
                    worker = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
                    stress.append(worker)
                    assert worker.stdout is not None
                    if worker.stdout.readline().strip() != "ready":
                        raise RuntimeError("CPU pressure worker failed to start")
            # Alternate AB/BA by repeat and scenario. Run the two versions
            # sequentially, never let benchmark workers compete with each other.
            for repeat in range(args.repeats):
                for index, scenario in enumerate(SCENARIOS):
                    order = ["bun", "rust"] if (repeat + index) % 2 == 0 else ["rust", "bun"]
                    for runtime in order:
                        if any(p.poll() is not None for p in stress):
                            raise RuntimeError("CPU pressure worker exited before measurement")
                        load = os.getloadavg()
                        started = time.time()
                        result = run(
                            ["/usr/bin/time", "-l"] + commands[runtime]
                            + ["bench", str(fixture), scenario, str(args.seconds), str(args.warmup)],
                            capture_output=True,
                            timeout=args.seconds + args.warmup + 60,
                        )
                        record = json.loads(result.stdout)
                        rss = re.search(r"(\d+)\s+maximum resident set size", result.stderr)
                        if not rss:
                            raise RuntimeError("Missing process RSS measurement")
                        if any(p.poll() is not None for p in stress):
                            raise RuntimeError("CPU pressure ended during measurement")
                        record.update(condition=condition, repeat=repeat, peak_rss_bytes=int(rss[1]),
                                      started_at=started, load_before=load)
                        records.append(record)
                        with (out / "samples.jsonl").open("a") as stream:
                            stream.write(json.dumps(record) + "\n")
                        print(f"{condition} {repeat+1}/{args.repeats} {scenario:7} {runtime:4}: "
                              f"{record['fps']:.0f} fps, p99 {record['p99_us']:.0f} us", flush=True)
        finally:
            for worker in stress:
                if worker.poll() is None:
                    worker.terminate()
            for worker in stress:
                try:
                    worker.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    worker.kill()
                    worker.wait()
                if worker.stdout is not None:
                    worker.stdout.close()
    summary = []
    metrics = ["fps", "cpu_us_per_frame", "p50_us", "p95_us", "p99_us", "max_us", "peak_rss_bytes"]
    for condition in conditions:
        for scenario in SCENARIOS:
            row: dict[str, Any] = {"condition": condition, "scenario": scenario}
            for runtime in commands:
                samples = [r for r in records if r["condition"] == condition
                           and r["scenario"] == scenario and r["runtime"] == runtime]
                row[runtime] = {key: statistics.median(r[key] for r in samples) for key in metrics}
                row[runtime]["fps_min"] = min(r["fps"] for r in samples)
                row[runtime]["fps_max"] = max(r["fps"] for r in samples)
            row["rust_fps_over_bun"] = row["rust"]["fps"] / row["bun"]["fps"]
            row["bun_p99_over_rust"] = row["bun"]["p99_us"] / row["rust"]["p99_us"]
            summary.append(row)
    (out / "summary.json").write_text(json.dumps(summary, indent=2))
    print(f"Results: {out / 'summary.json'}", flush=True)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    main()
