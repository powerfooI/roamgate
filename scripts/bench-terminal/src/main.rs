use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fmt::Write, hint::black_box, time::Instant};
use unicode_width::UnicodeWidthStr;

#[derive(Deserialize, Serialize)]
struct Cell {
    symbol: String,
    fg: u32,
    bg: u32,
    modifier: u32,
    skip: bool,
    hyperlink: Option<usize>,
}

#[derive(Clone, Deserialize)]
struct Cursor {
    x: usize,
    y: usize,
    visible: bool,
    shape: u8,
}

#[derive(Deserialize)]
struct Frame {
    cells: Vec<Cell>,
    width: usize,
    height: usize,
    cursor: Option<Cursor>,
    hyperlinks: Vec<String>,
}

#[derive(Deserialize, Serialize)]
struct Rect {
    x: usize,
    y: usize,
    width: usize,
    height: usize,
}

#[derive(Deserialize)]
struct Fixture {
    name: String,
    frame: Frame,
    rect: Rect,
    revision: u64,
}

struct Cropped<'a> {
    cells: Vec<&'a Cell>,
    width: usize,
    height: usize,
    cursor: Option<Cursor>,
    hyperlinks: &'a [String],
}

// Borrow cells, just as production cropFrame copies object references.
fn crop_frame(f: &Fixture) -> Cropped<'_> {
    let width = f.rect.width.min(f.frame.width.saturating_sub(f.rect.x));
    let height = f.rect.height.min(f.frame.height.saturating_sub(f.rect.y));
    let mut cells = Vec::with_capacity(width * height);
    for y in 0..height {
        for x in 0..width {
            cells.push(&f.frame.cells[(f.rect.y + y) * f.frame.width + f.rect.x + x]);
        }
    }
    let cursor = f.frame.cursor.as_ref().and_then(|c| {
        let x = c.x.checked_sub(f.rect.x)?;
        let y = c.y.checked_sub(f.rect.y)?;
        (x < width && y < height).then(|| Cursor { x, y, ..c.clone() })
    });
    Cropped {
        cells,
        width,
        height,
        cursor,
        hyperlinks: &f.frame.hyperlinks,
    }
}

fn sgr_color(packed: u32, foreground: bool) -> String {
    let kind = packed >> 24;
    let value = packed & 0x00ff_ffff;
    if kind == 0 {
        return match value {
            0 => if foreground { "39" } else { "49" }.into(),
            1..=8 => ((if foreground { 30 } else { 40 }) + value - 1).to_string(),
            _ => ((if foreground { 90 } else { 100 }) + value - 9).to_string(),
        };
    }
    let base = if foreground { 38 } else { 48 };
    if kind == 1 {
        format!("{base};5;{}", value & 0xff)
    } else {
        format!(
            "{base};2;{};{};{}",
            (value >> 16) & 0xff,
            (value >> 8) & 0xff,
            value & 0xff
        )
    }
}

fn sgr_style(cell: &Cell) -> String {
    let mut codes: Vec<String> = Vec::new();
    let m = cell.modifier;
    for (mask, code) in [(1, "1"), (2, "2"), (4, "3")] {
        if m & mask != 0 {
            codes.push(code.into());
        }
    }
    if m & 8 != 0 {
        let style = (m & 0xf000) >> 12;
        codes.push(if (1..=5).contains(&style) {
            format!("4:{style}")
        } else {
            "4".into()
        });
    }
    for (mask, code) in [(0x30, "5"), (0x40, "7"), (0x80, "8"), (0x100, "9")] {
        if m & mask != 0 {
            codes.push(code.into());
        }
    }
    codes.push(sgr_color(cell.fg, true));
    codes.push(sgr_color(cell.bg, false));
    format!("\x1b[{}m", codes.join(";"))
}

fn default_blank(c: &Cell) -> bool {
    c.symbol == " " && c.fg == 0 && c.bg == 0 && c.modifier == 0 && c.hyperlink.is_none()
}

// Direct full-repaint port of frameToAnsi; deliberately no diffing, caches,
// run optimization or parallelism. Retain its per-cell string style keys.
fn frame_to_ansi(f: &Cropped<'_>) -> String {
    let mut out = String::from("\x1b[0m\x1b[H\x1b[2J\x1b[?7l");
    for y in 0..f.height {
        if y > 0 {
            write!(out, "\x1b[{};1H", y + 1).unwrap();
        }
        let start = y * f.width;
        let mut end = f.width;
        while end > 0 && default_blank(f.cells[start + end - 1]) {
            end -= 1;
        }
        let mut last_style: Option<String> = None;
        let mut link_open = false;
        let mut x = 0;
        while x < end {
            let cell = f.cells[start + x];
            if cell.skip {
                x += 1;
                continue;
            }
            let mut width = UnicodeWidthStr::width(cell.symbol.as_str());
            // Bun counts halfwidth voiced/semi-voiced marks as one column;
            // unicode-width 0.2 treats them as zero-width Grapheme_Extend.
            // ponytail: corpus compatibility, not a complete Bun width port.
            if cell.symbol.len() > 1 {
                width += cell
                    .symbol
                    .chars()
                    .filter(|c| matches!(c, '\u{ff9e}' | '\u{ff9f}'))
                    .count();
            }
            if x + width > f.width {
                break;
            }
            let key = format!(
                "{},{},{},{}",
                cell.fg,
                cell.bg,
                cell.modifier,
                cell.hyperlink.map(|i| i.to_string()).unwrap_or_default()
            );
            if last_style.as_ref() != Some(&key) {
                if link_open {
                    out.push_str("\x1b]8;;\x1b\\");
                    link_open = false;
                }
                out.push_str("\x1b[0m");
                out.push_str(&sgr_style(cell));
                if let Some(uri) = cell.hyperlink.and_then(|i| f.hyperlinks.get(i)) {
                    write!(out, "\x1b]8;;{uri}\x1b\\").unwrap();
                    link_open = true;
                }
                last_style = Some(key);
            }
            out.push_str(&cell.symbol);
            let padding = width.saturating_sub(1);
            x += padding;
            if padding > 0 && x + 1 < end {
                write!(out, "\x1b[{}G", x + 2).unwrap();
            }
            x += 1;
        }
        if link_open {
            out.push_str("\x1b]8;;\x1b\\");
        }
    }
    out.push_str("\x1b[?7h");
    if let Some(c) = f
        .cursor
        .as_ref()
        .filter(|c| c.visible && c.x < f.width && c.y < f.height)
    {
        write!(
            out,
            "\x1b[0m\x1b[{};{}H\x1b[{} q\x1b[?25h",
            c.y + 1,
            c.x + 1,
            c.shape
        )
        .unwrap();
    } else {
        out.push_str("\x1b[?25l");
    }
    out
}

// Struct field order matches JSON.stringify; serde_json::Value would sort keys.
#[derive(Serialize)]
struct Content<'a> {
    #[serde(rename = "paneId")]
    pane_id: &'static str,
    revision: u64,
    rect: &'a Rect,
    scroll: Option<()>,
    width: usize,
    height: usize,
    cells: &'a [&'a Cell],
    hyperlinks: &'a [String],
}

#[derive(Serialize)]
struct Terminal {
    terminal_id: &'static str,
    width: usize,
    height: usize,
    full: bool,
    bytes: String,
}
#[derive(Serialize)]
struct Payload {
    terminal: Terminal,
}

fn transform(f: &Fixture) -> (String, String) {
    let cropped = crop_frame(f);
    let content = serde_json::to_string(&Content {
        pane_id: "bench-pane",
        revision: f.revision,
        rect: &f.rect,
        scroll: None,
        width: cropped.width,
        height: cropped.height,
        cells: &cropped.cells,
        hyperlinks: cropped.hyperlinks,
    })
    .unwrap();
    let ansi = frame_to_ansi(&cropped);
    // Retain the extra byte-buffer copy in terminal-bridge's Buffer.from(bytes).
    let bytes = ansi.as_bytes().to_vec();
    let payload = serde_json::to_string(&Payload {
        terminal: Terminal {
            terminal_id: "bench-terminal",
            width: cropped.width,
            height: cropped.height,
            full: true,
            bytes: STANDARD.encode(bytes),
        },
    })
    .unwrap();
    (content, payload)
}

fn cpu_seconds() -> f64 {
    // RUSAGE_SELF covers all process threads, like process.cpuUsage() in Bun.
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: getrusage initializes the supplied struct on success.
    let usage = unsafe {
        assert_eq!(libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()), 0);
        usage.assume_init()
    };
    (usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) as f64
        + (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) as f64 / 1e6
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let all: Vec<Fixture> = serde_json::from_slice(&std::fs::read(&args[2]).unwrap()).unwrap();
    if args[1] == "dump" {
        println!(
            "{}",
            serde_json::to_string(&transform(&all[args[3].parse::<usize>().unwrap()])).unwrap()
        );
        return;
    }
    if args[1] == "verify" {
        let hashes: Vec<Vec<String>> = all
            .iter()
            .map(|f| {
                let (content, payload) = transform(f);
                [content, payload]
                    .iter()
                    .map(|s| format!("{:x}", Sha256::digest(s.as_bytes())))
                    .collect()
            })
            .collect();
        println!("{}", serde_json::to_string(&hashes).unwrap());
        return;
    }
    assert_eq!(args[1], "bench");
    let selected: Vec<&Fixture> = all.iter().filter(|f| f.name == args[3]).collect();
    assert!(!selected.is_empty());
    let seconds: f64 = args[4].parse().unwrap();
    let warmup: f64 = args[5].parse().unwrap();
    assert!(seconds > 0.0 && seconds <= 120.0 && (0.0..=60.0).contains(&warmup));
    let mut sequence = 0usize;
    let warmup_start = Instant::now();
    while warmup_start.elapsed().as_secs_f64() < warmup {
        black_box(transform(selected[sequence % selected.len()]));
        sequence += 1;
    }
    sequence = 0;
    let mut checksum = 0u32;
    let mut payload_bytes = 0u64;
    let mut latencies: Vec<f64> = Vec::new();
    let cpu_start = cpu_seconds();
    let start = Instant::now();
    while start.elapsed().as_secs_f64() < seconds {
        let before = Instant::now();
        {
            let (content, payload) = black_box(transform(selected[sequence % selected.len()]));
            checksum = checksum
                .wrapping_add(*content.as_bytes().last().unwrap() as u32)
                .wrapping_add(payload.len() as u32);
            payload_bytes += payload.len() as u64;
        } // Include synchronous deallocation; Bun's GC is also inside its run.
        sequence += 1;
        latencies.push(before.elapsed().as_secs_f64() * 1e6);
    }
    let elapsed = start.elapsed().as_secs_f64();
    let cpu = cpu_seconds() - cpu_start;
    latencies.sort_by(|a, b| a.total_cmp(b));
    let percentile = |p: f64| latencies[(latencies.len() as f64 * p).ceil() as usize - 1];
    println!(
        "{}",
        serde_json::json!({
            "runtime": "rust", "scenario": args[3], "frames": sequence,
            "seconds": elapsed, "fps": sequence as f64 / elapsed,
            "cpu_seconds": cpu, "cpu_us_per_frame": cpu * 1e6 / sequence as f64,
            "p50_us": percentile(0.5), "p95_us": percentile(0.95), "p99_us": percentile(0.99),
            "max_us": latencies.last(), "payload_bytes": payload_bytes, "checksum": checksum,
        })
    );
}
