#!/usr/bin/env python3
"""Trim a 30 fps frame interval and hold each boundary for exactly one second."""

import argparse
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--start-frame", type=int, required=True)
    parser.add_argument("--end-frame", type=int, required=True)
    args = parser.parse_args()
    if not args.input.is_file():
        parser.error("input must be an existing video")
    if args.output.exists() or args.output.suffix.lower() != ".mp4":
        parser.error("output must be a new .mp4 path")
    if args.start_frame < 0 or args.end_frame <= args.start_frame:
        parser.error("require 0 <= start-frame < end-frame")

    # Count after the same fps filter used for trimming, including variable-rate inputs.
    probe = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(args.input), "-map", "0:v:0",
         "-vf", "fps=30", "-f", "framemd5", "-"],
        check=True, capture_output=True, text=True,
    )
    count = sum(bool(line) and not line.startswith("#") for line in probe.stdout.splitlines())
    if args.end_frame >= count:
        parser.error(f"end-frame exceeds normalized video ({count} frames)")

    filters = (
        f"fps=30,trim=start_frame={args.start_frame}:end_frame={args.end_frame + 1},"
        "setpts=PTS-STARTPTS,tpad=start=29:stop=29:start_mode=clone:stop_mode=clone,"
        "pad=ceil(iw/2)*2:ceil(ih/2)*2"
    )
    subprocess.run(
        ["ffmpeg", "-v", "error", "-n", "-i", str(args.input), "-map", "0:v:0",
         "-vf", filters, "-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
         "-movflags", "+faststart", str(args.output)],
        check=True,
    )
    frames = args.end_frame - args.start_frame + 1 + 58
    print(f"{args.output}: {frames} frames at 30 fps ({frames / 30:.3f}s); inspect playback")


if __name__ == "__main__":
    main()
