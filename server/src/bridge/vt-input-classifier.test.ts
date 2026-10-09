import { describe, expect, test } from "bun:test";
import { BinReader } from "./bincode";
import {
  KEY,
  MOUSE_KIND,
  MOD_ALT,
  MOD_CONTROL,
  MOD_SHIFT,
  type PaneInputEvent,
  VtInputClassifier,
  encodePaneInput,
} from "./vt-input-classifier";

function feed(input: string | number[]): PaneInputEvent[] {
  const c = new VtInputClassifier();
  return c.feed(
    typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input),
  );
}

describe("VtInputClassifier", () => {
  test("printable text becomes one TextCommit", () => {
    expect(feed("hello 世界")).toEqual([{ type: "text", text: "hello 世界" }]);
  });

  test("enter, backspace, tab, escape keys", () => {
    expect(feed("\r")).toEqual([
      {
        type: "key",
        code: KEY.Enter,
        char: undefined,
        fn: undefined,
        modifiers: 0,
        generatedText: undefined,
      },
    ]);
    expect(feed([0x7f])).toEqual([
      {
        type: "key",
        code: KEY.Backspace,
        char: undefined,
        fn: undefined,
        modifiers: 0,
        generatedText: undefined,
      },
    ]);
    expect(feed("\t")).toEqual([
      {
        type: "key",
        code: KEY.Tab,
        char: undefined,
        fn: undefined,
        modifiers: 0,
        generatedText: undefined,
      },
    ]);
    const c = new VtInputClassifier();
    expect(c.feed(Buffer.from([0x1b]))).toEqual([]);
    expect(c.flush()).toEqual([
      {
        type: "key",
        code: KEY.Esc,
        char: undefined,
        fn: undefined,
        modifiers: 0,
        generatedText: undefined,
      },
    ]);
  });

  test("preserves Ctrl+J and modified Enter variants", () => {
    expect(feed("\n")).toEqual([
      {
        type: "key",
        code: KEY.Char,
        char: 0x6a,
        fn: undefined,
        modifiers: MOD_CONTROL,
        generatedText: undefined,
      },
    ]);
    expect(feed("\x1b[13;2u")).toEqual([
      {
        type: "key",
        code: KEY.Enter,
        char: undefined,
        fn: undefined,
        modifiers: MOD_SHIFT,
        generatedText: undefined,
      },
    ]);
    expect(feed("\x1b[13;3u")).toEqual([
      {
        type: "key",
        code: KEY.Enter,
        char: undefined,
        fn: undefined,
        modifiers: MOD_ALT,
        generatedText: undefined,
      },
    ]);
  });

  test("preserves Ctrl+/ separately from the ambiguous legacy Ctrl+_ byte", () => {
    const slash = {
      type: "key",
      code: KEY.Char,
      char: 47,
      modifiers: MOD_CONTROL,
    };
    expect(feed("\x1b[47;5u")).toMatchObject([slash]);
    expect(feed([0x1f])).toMatchObject([
      { type: "key", code: KEY.Char, char: 95, modifiers: MOD_CONTROL },
    ]);
    const sequence = Buffer.from("\x1b[47;5u");
    for (let split = 1; split < sequence.length; split++) {
      const classifier = new VtInputClassifier();
      expect(classifier.feed(sequence.subarray(0, split))).toEqual([]);
      expect(classifier.feed(sequence.subarray(split))).toMatchObject([slash]);
    }
  });

  test("does not interpret unsupported or malformed CSI-u sequences", () => {
    for (const sequence of [
      "57358;5u",
      "0;5u",
      "128;5u",
      "47;0u",
      "47;17u",
      "47;5;1u",
      "47;5:2u",
      "47:48;5u",
    ]) {
      expect(feed(`\x1b[${sequence}`)).toEqual([]);
    }
    expect(feed("\x1b[200~\x1b[47;5u\x1b[201~")).toEqual([
      { type: "paste", text: "\x1b[47;5u" },
    ]);
  });

  test("ctrl+letter maps to Char with CONTROL", () => {
    expect(feed([0x03])).toEqual([
      {
        type: "key",
        code: KEY.Char,
        char: 0x63,
        fn: undefined,
        modifiers: MOD_CONTROL,
        generatedText: undefined,
      },
    ]);
  });

  test("arrows and modified arrows", () => {
    expect(feed("\x1b[A")).toEqual([
      {
        type: "key",
        code: KEY.Up,
        char: undefined,
        fn: undefined,
        modifiers: 0,
        generatedText: undefined,
      },
    ]);
    expect(feed("\x1b[1;5D")).toEqual([
      {
        type: "key",
        code: KEY.Left,
        char: undefined,
        fn: undefined,
        modifiers: MOD_CONTROL,
        generatedText: undefined,
      },
    ]);
    expect(feed("\x1b[1;2C")).toEqual([
      {
        type: "key",
        code: KEY.Right,
        char: undefined,
        fn: undefined,
        modifiers: MOD_SHIFT,
        generatedText: undefined,
      },
    ]);
  });

  test("preserves every modified CSI key family emitted by xterm", () => {
    for (const [sequence, expected] of [
      ["\x1b[1;2A", { code: KEY.Up, modifiers: MOD_SHIFT }],
      ["\x1b[1;3H", { code: KEY.Home, modifiers: MOD_ALT }],
      ["\x1b[1;5F", { code: KEY.End, modifiers: MOD_CONTROL }],
      ["\x1b[3;2~", { code: KEY.Delete, modifiers: MOD_SHIFT }],
      ["\x1b[5;5~", { code: KEY.PageUp, modifiers: MOD_CONTROL }],
      ["\x1b[1;2P", { code: KEY.F, fn: 1, modifiers: MOD_SHIFT }],
      ["\x1b[1;3S", { code: KEY.F, fn: 4, modifiers: MOD_ALT }],
      ["\x1b[15;2~", { code: KEY.F, fn: 5, modifiers: MOD_SHIFT }],
      ["\x1b[24;3~", { code: KEY.F, fn: 12, modifiers: MOD_ALT }],
    ] as const) {
      expect(feed(sequence)).toHaveLength(1);
      expect(feed(sequence)[0]).toMatchObject({
        type: "key",
        ...expected,
      });
    }
  });

  test("tilde keys: delete, home, end, page up/down", () => {
    const codeAt = (input: string) => {
      const e = feed(input)[0];
      return e.type === "key" ? e.code : null;
    };
    expect(codeAt("\x1b[3~")).toBe(KEY.Delete);
    expect(codeAt("\x1b[1~")).toBe(KEY.Home);
    expect(codeAt("\x1b[4~")).toBe(KEY.End);
    expect(codeAt("\x1b[5~")).toBe(KEY.PageUp);
    expect(codeAt("\x1b[6~")).toBe(KEY.PageDown);
  });

  test("function keys via SS3 and tilde", () => {
    expect(feed("\x1bOP")[0]).toMatchObject({ code: KEY.F, fn: 1 });
    expect(feed("\x1bOQ")[0]).toMatchObject({ code: KEY.F, fn: 2 });
    expect(feed("\x1b[15~")[0]).toMatchObject({ code: KEY.F, fn: 5 });
    expect(feed("\x1b[24~")[0]).toMatchObject({ code: KEY.F, fn: 12 });
  });

  test("alt+char", () => {
    expect(feed("\x1bx")).toEqual([
      {
        type: "key",
        code: KEY.Char,
        char: 0x78,
        fn: undefined,
        modifiers: MOD_ALT,
        generatedText: undefined,
      },
    ]);
  });

  test("alt-prefixed control bytes remain one modified key", () => {
    expect(feed("\x1b\x7f")).toEqual([
      {
        type: "key",
        code: KEY.Backspace,
        char: undefined,
        fn: undefined,
        modifiers: MOD_ALT,
        generatedText: undefined,
      },
    ]);
    expect(feed("\x1b\x03")).toEqual([
      {
        type: "key",
        code: KEY.Char,
        char: 0x63,
        fn: undefined,
        modifiers: MOD_CONTROL | MOD_ALT,
        generatedText: undefined,
      },
    ]);
  });

  test("bracketed paste becomes one Paste event", () => {
    expect(feed("\x1b[200~pasted\r\ntext\x1b[201~")).toEqual([
      { type: "paste", text: "pasted\r\ntext" },
    ]);
  });

  test("mixed text and keys keep order", () => {
    const events = feed("ab\x1b[Acd");
    expect(events.map((e) => e.type)).toEqual(["text", "key", "text"]);
    expect(events[0]).toMatchObject({ text: "ab" });
    expect(events[2]).toMatchObject({ text: "cd" });
  });

  test("split sequences wait for completion", () => {
    const c = new VtInputClassifier();
    expect(c.feed(Buffer.from("\x1b["))).toEqual([]);
    expect(c.feed(Buffer.from("3~"))).toEqual([
      {
        type: "key",
        code: KEY.Delete,
        char: undefined,
        fn: undefined,
        modifiers: 0,
        generatedText: undefined,
      },
    ]);
  });

  test("split UTF-8 chars wait for completion", () => {
    const c = new VtInputClassifier();
    const bytes = Buffer.from("世", "utf8");
    expect(c.feed(bytes.subarray(0, 1))).toEqual([]);
    expect(c.feed(bytes.subarray(1))).toEqual([{ type: "text", text: "世" }]);
  });

  test("double ESC yields Esc then reprocesses", () => {
    const events = feed("\x1b\x1b[A");
    expect(events.map((e) => (e.type === "key" ? e.code : e.type))).toEqual([
      KEY.Esc,
      KEY.Up,
    ]);
  });
});

describe("SGR cell mouse input", () => {
  test("click, release, drag, motion and all wheel directions use pane-local cells", () => {
    const reports = [
      [0, "M", MOUSE_KIND.Down, 0],
      [0, "m", MOUSE_KIND.Up, 0],
      [1, "M", MOUSE_KIND.Down, 2],
      [2, "m", MOUSE_KIND.Up, 1],
      [32, "M", MOUSE_KIND.Drag, 0],
      [34, "M", MOUSE_KIND.Drag, 1],
      [35, "M", MOUSE_KIND.Moved, undefined],
      [64, "M", MOUSE_KIND.ScrollUp, undefined],
      [65, "M", MOUSE_KIND.ScrollDown, undefined],
      [66, "M", MOUSE_KIND.ScrollLeft, undefined],
      [67, "M", MOUSE_KIND.ScrollRight, undefined],
    ] as const;
    for (const [code, final, kind, button] of reports) {
      expect(feed(`\x1b[<${code};8;3${final}`)).toEqual([
        {
          type: "mouse",
          kind,
          ...(button === undefined ? {} : { button }),
          column: 7,
          row: 2,
          modifiers: 0,
          lines: 1,
        },
      ]);
    }
    expect(feed("\x1b[<28;1;1M")[0]).toMatchObject({
      column: 0,
      row: 0,
      modifiers: MOD_SHIFT | MOD_ALT | MOD_CONTROL,
    });
  });

  test("every split point buffers the report without leaking text; paste stays paste", () => {
    const report = Buffer.from("\x1b[<32;256;12M");
    for (let i = 1; i < report.length; i++) {
      const classifier = new VtInputClassifier();
      expect(classifier.feed(report.subarray(0, i))).toEqual([]);
      // The existing idle timer intentionally flushes a lone ESC as a key.
      if (i > 1) expect(classifier.flush()).toEqual([]);
      expect(classifier.feed(report.subarray(i))).toEqual(
        feed(report.toString()),
      );
    }
    expect(feed(`a${report.toString()}b`).map((event) => event.type)).toEqual([
      "text",
      "mouse",
      "text",
    ]);
    expect(feed(`\x1b[200~${report.toString()}\x1b[201~`)).toEqual([
      { type: "paste", text: report.toString() },
    ]);
  });

  test("rejects malformed fields, unsupported buttons, impossible kinds and out-of-range cells", () => {
    for (const report of [
      "<0;0;1M",
      "<-1;1;1M",
      "<0;-1;1M",
      "<0; 1;1M",
      "<0;1;0M",
      "<0;65537;1M",
      "<0;1;999999999999999999999M",
      "<128;1;1M",
      "<999999999999999999;1;1M",
      "<3;1;1M",
      "<3;1;1m",
      "<64;1;1m",
      "<96;1;1M",
      "<32;1;1m",
      "<0;;1M",
      "<0;1;1;2M",
      "<0:1;1;1M",
      "<0;1;1~",
    ]) {
      expect(feed(`\x1b[${report}ok`)).toEqual([{ type: "text", text: "ok" }]);
    }
    expect(feed("\x1b[<0;1;\x1b[A")).toEqual(feed("\x1b[A"));
    expect(feed("\x1b[<0;65536;65536M")[0]).toMatchObject({
      column: 65535,
      row: 65535,
    });
  });

  test("encodes the frozen generation-1 mouse fields including absent geometry", () => {
    // v0.9.0 protocol/wire.rs: message 13, Mouse 2, Down(Left), Cell,
    // zero-based (1,2), geometry None, modifiers 0, lines 1.
    expect(encodePaneInput("w1:p1", feed("\x1b[<0;2;3M")).toString("hex")).toBe(
      "0d0577313a703101020000000102000001",
    );
    for (const report of ["\x1b[<1;256;3m", "\x1b[<34;2;3M", "\x1b[<80;2;3M"]) {
      const event = feed(report)[0];
      if (event.type !== "mouse") throw new Error("expected mouse");
      const reader = new BinReader(encodePaneInput("other-pane", [event]));
      expect(reader.variant()).toBe(13);
      expect(reader.string()).toBe("other-pane");
      expect(reader.varint()).toBe(1);
      expect(reader.variant()).toBe(2);
      expect(reader.variant()).toBe(event.kind);
      if (event.kind <= MOUSE_KIND.Drag)
        expect(reader.variant()).toBe(event.button!);
      expect(reader.variant()).toBe(0);
      expect(reader.varint()).toBe(event.column);
      expect(reader.varint()).toBe(event.row);
      expect(reader.bool()).toBe(false);
      expect(reader.u8()).toBe(event.modifiers);
      expect(reader.varint()).toBe(1);
    }
  });
});

describe("encodePaneInput", () => {
  test("encodes Ctrl+/ as a semantic slash press, not Ctrl+_", () => {
    const reader = new BinReader(encodePaneInput("w1:p1", feed("\x1b[47;5u")));
    expect(reader.variant()).toBe(13);
    expect(reader.string()).toBe("w1:p1");
    expect(reader.varint()).toBe(1);
    expect(reader.variant()).toBe(0);
    expect(reader.variant()).toBe(KEY.Char);
    expect(reader.varint()).toBe(47);
    expect(reader.u8()).toBe(MOD_CONTROL);
    expect(reader.variant()).toBe(0); // Press
    expect(reader.varint()).toBe(1);
    for (let field = 0; field < 5; field++) expect(reader.bool()).toBe(false);
  });

  test("encodes the ClientShellPaneInput frame", () => {
    const buf = encodePaneInput("w1:p1", [
      { type: "text", text: "hi" },
      { type: "key", code: KEY.Enter, modifiers: 0 },
      { type: "paste", text: "p" },
      { type: "key", code: KEY.Char, char: 0x63, modifiers: MOD_CONTROL },
      { type: "key", code: KEY.F, fn: 5, modifiers: MOD_SHIFT },
    ]);
    const r = new BinReader(buf);
    expect(r.variant()).toBe(13); // ClientShellPaneInput
    expect(r.string()).toBe("w1:p1");
    expect(r.varint()).toBe(5);

    expect(r.variant()).toBe(1); // TextCommit
    expect(r.string()).toBe("hi");

    expect(r.variant()).toBe(0); // Key
    expect(r.variant()).toBe(KEY.Enter);
    expect(r.u8()).toBe(0); // modifiers
    expect(r.variant()).toBe(0); // Press
    expect(r.varint()).toBe(1); // repeat_count
    expect(r.bool()).toBe(false); // shifted_codepoint
    expect(r.bool()).toBe(false); // generated_text
    expect(r.bool()).toBe(false); // tracks_release
    expect(r.bool()).toBe(false); // physical_key_id
    expect(r.bool()).toBe(false); // windows_record

    expect(r.variant()).toBe(3); // Paste
    expect(r.string()).toBe("p");

    expect(r.variant()).toBe(0); // Key Char
    expect(r.variant()).toBe(KEY.Char);
    expect(r.varint()).toBe(0x63);
    expect(r.u8()).toBe(MOD_CONTROL);
    expect(r.variant()).toBe(0); // Press
    expect(r.varint()).toBe(1);
    expect(r.bool()).toBe(false);
    expect(r.bool()).toBe(false);
    expect(r.bool()).toBe(false);
    expect(r.bool()).toBe(false);
    expect(r.bool()).toBe(false);

    expect(r.variant()).toBe(0); // Key F
    expect(r.variant()).toBe(KEY.F);
    expect(r.varint()).toBe(5);
    expect(r.u8()).toBe(MOD_SHIFT);
  });
});
