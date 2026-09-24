import { describe, expect, test } from "bun:test";
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { registerTerminalLinkProvider } from "./terminalLinkProvider";
import { TerminalFileResolutionCache } from "./terminalFileLinks";
import {
  getShortcutSnapshot,
  selectShortcutPreset,
} from "./shortcutPreferences";

function fixture(rows: string[], cols: number, wrapped: number[] = []) {
  let provider!: ILinkProvider;
  const lines = rows.map((text, index) => ({
    text,
    isWrapped: wrapped.includes(index + 1),
    get length() {
      return cols;
    },
    getCell(x: number) {
      if (x >= cols) return undefined;
      return { getChars: () => this.text[x] ?? "", getWidth: () => 1 };
    },
  }));
  const buffer = { getLine: (y: number) => lines[y] };
  const term = {
    cols,
    buffer: { active: buffer },
    registerLinkProvider(value: ILinkProvider) {
      provider = value;
      return { dispose() {} };
    },
  } as unknown as Terminal;
  const requests: string[][] = [];
  const previewed: string[] = [];
  const existing = new Set<string>();
  const cache = new TerminalFileResolutionCache(
    async (_scope, _workspace, paths) => {
      requests.push(paths);
      return paths
        .filter((path) => existing.has(path))
        .map((path) => ({ candidate: path, path }));
    },
  );
  const resolve = (paths: string[]) =>
    cache.resolve("test", "workspace", paths);
  const links = (row: number) =>
    new Promise<ILink[]>((done) =>
      provider.provideLinks(row, (found) => done(found ?? [])),
    );
  return {
    term,
    lines,
    requests,
    existing,
    resolve,
    previewed,
    links,
    provide: (row: number, callback: (links: ILink[] | undefined) => void) =>
      provider.provideLinks(row, callback),
  };
}

// These exercise the actual provider registered with xterm, including async
// resolution and the one-based, inclusive ranges used for mouse activation.
describe("terminal link provider", () => {
  test("suppresses a late filesystem reply after a newer row lookup", async () => {
    const f = fixture(["docs/a.md", "docs/b.md"], 30);
    const completions: ((value: Map<string, string>) => void)[] = [];
    registerTerminalLinkProvider(
      f.term,
      () => {},
      () => new Promise((done) => completions.push(done)),
    );
    let oldReplies = 0;
    f.provide(1, () => oldReplies++);
    const b = f.links(2);
    completions[1]!(new Map([["docs/b.md", "/tmp/b.md"]]));
    expect((await b)[0]?.text).toBe("docs/b.md");
    completions[0]!(new Map([["docs/a.md", "/tmp/a.md"]]));
    await Promise.resolve();
    await Promise.resolve();
    expect(oldReplies).toBe(0);
  });

  test("treats a soft-wrapped absolute file as one link from either row", async () => {
    const f = fixture(["See /tmp/long/gu", "ide.md and text"], 16, [2]);
    registerTerminalLinkProvider(f.term, (path) => f.previewed.push(path));
    for (const row of [1, 2]) {
      const links = await f.links(row);
      expect(links.map((link) => link.text)).toEqual(["/tmp/long/guide.md"]);
      expect(links[0]!.range).toEqual({
        start: { x: 5, y: 1 },
        end: { x: 6, y: 2 },
      });
    }
  });

  test("resolves an entire relative path across three soft-wrapped rows", async () => {
    const f = fixture(
      "docs/very-long-folder/guide.md:42 ".match(/.{1,12}/g)!,
      12,
      [2, 3],
    );
    f.existing.add("docs/very-long-folder/guide.md");
    registerTerminalLinkProvider(f.term, () => {}, f.resolve);
    expect((await f.links(2)).map((link) => link.text)).toEqual([
      "docs/very-long-folder/guide.md",
    ]);
    expect(f.requests).toEqual([["docs/very-long-folder/guide.md"]]);
  });

  test("does not join explicit newlines in a terminal stream", async () => {
    const f = fixture(["/tmp/a.md", "/tmp/b.md"], 9);
    registerTerminalLinkProvider(f.term, () => {});
    expect((await f.links(1)).map((link) => link.text)).toEqual(["/tmp/a.md"]);
    expect((await f.links(2)).map((link) => link.text)).toEqual(["/tmp/b.md"]);
  });

  test("joins an edge-contiguous path in an endpoint repaint only after file resolution", async () => {
    const f = fixture(["See /tmp/long/gu", "ide.md          "], 16);
    f.existing.add("/tmp/long/guide.md");
    registerTerminalLinkProvider(
      f.term,
      () => {},
      f.resolve,
      () => true,
    );
    for (const row of [1, 2]) {
      const links = await f.links(row);
      expect(links.map((link) => link.text)).toEqual(["/tmp/long/guide.md"]);
      expect(links[0]!.range).toEqual({
        start: { x: 5, y: 1 },
        end: { x: 6, y: 2 },
      });
    }
    expect(f.requests.flat()).toContain("/tmp/long/guide.md");
  });

  test("keeps unrelated endpoint rows separate when the combined path does not exist", async () => {
    const f = fixture(["/tmp/a.md", "/tmp/b.md"], 9);
    f.existing.add("/tmp/a.md");
    f.existing.add("/tmp/b.md");
    registerTerminalLinkProvider(
      f.term,
      () => {},
      f.resolve,
      () => true,
    );
    expect((await f.links(1)).map((link) => link.text)).toEqual(["/tmp/a.md"]);
    expect((await f.links(2)).map((link) => link.text)).toEqual(["/tmp/b.md"]);
  });

  test("keeps padded independent rows separate unless a combined file exists", async () => {
    const f = fixture(["docs/a.md", "next/file.md"], 16);
    f.existing.add("docs/a.md");
    f.existing.add("next/file.md");
    registerTerminalLinkProvider(
      f.term,
      () => {},
      f.resolve,
      () => true,
    );
    expect((await f.links(1)).map((link) => link.text)).toEqual(["docs/a.md"]);
    expect((await f.links(2)).map((link) => link.text)).toEqual([
      "next/file.md",
    ]);
  });

  test.each(["standalone", "joined"])(
    "resolves all candidate batches and prefers the complete %s path",
    async (kind) => {
      const rows = Array.from({ length: 17 }, (_, i) => `docs/file${i}.md`);
      const f = fixture(rows, 40);
      for (const path of rows) f.existing.add(path);
      const joined = rows[7]! + rows[8]!;
      if (kind === "joined") f.existing.add(joined);
      registerTerminalLinkProvider(
        f.term,
        () => {},
        f.resolve,
        () => true,
      );
      expect((await f.links(9)).map((link) => link.text)).toEqual([
        kind === "joined" ? joined : rows[8]!,
      ]);
      expect(f.requests.map((paths) => paths.length)).toEqual([32, 32, 17]);
      expect(f.requests.flat()).toContain(rows[8]!);
    },
  );

  test("deduplicates repeated path candidates before resolution", async () => {
    const f = fixture(Array(17).fill("docs/file.md"), 40);
    f.existing.add("docs/file.md");
    const batches: string[][] = [];
    registerTerminalLinkProvider(
      f.term,
      () => {},
      (paths) => {
        batches.push(paths);
        return f.resolve(paths);
      },
      () => true,
    );
    expect((await f.links(9)).map((link) => link.text)).toEqual([
      "docs/file.md",
    ]);
    expect(batches.map((paths) => paths.length)).toEqual([17]);
  });

  test.each(["buffer changes", "lookup fails"])(
    "discards batch results when the last batch %s",
    async (reason) => {
      const rows = Array.from({ length: 17 }, (_, i) => `docs/file${i}.md`);
      const f = fixture(rows, 40);
      f.existing.add(rows.join(""));
      f.existing.add(rows[8]!);
      let calls = 0;
      registerTerminalLinkProvider(
        f.term,
        () => {},
        async (paths) => {
          if (++calls === 3) {
            if (reason === "lookup fails") throw new Error("resolution failed");
            f.lines[8]!.text = "docs/replaced.md";
          }
          return f.resolve(paths);
        },
        () => true,
      );
      expect(await f.links(9)).toEqual([]);
      expect(calls).toBe(3);
    },
  );

  test.each(["mac", "windows", "linux"])(
    "joins the indented Codex example and activates the complete file (%s)",
    async (preset) => {
      const path =
        ".dev/vllm-v41-compat/evidence/restore-instrumented-native3/README.md";
      const first =
        "  Restore still needs a fix. Full diagnosis and traces (.dev/vllm-v41-compat/evidence/restore-instrumented-native3/";
      const f = fixture([first, "  README.md)."], first.length + 3);
      f.existing.add(path);
      registerTerminalLinkProvider(
        f.term,
        (value) => f.previewed.push(value),
        f.resolve,
        () => true,
      );
      for (const row of [1, 2]) {
        const links = await f.links(row);
        expect(links.map((link) => link.text)).toEqual([path]);
        expect(links[0]!.range).toEqual({
          start: { x: first.indexOf(".dev/") + 1, y: 1 },
          end: { x: 11, y: 2 },
        });
        const event = {
          preventDefault() {},
          ctrlKey: preset !== "mac",
          metaKey: preset === "mac",
          shiftKey: false,
          altKey: false,
        } as MouseEvent;
        const previous = getShortcutSnapshot().preferences.active;
        try {
          selectShortcutPreset(preset);
          links[0]!.activate(event, links[0]!.text);
        } finally {
          selectShortcutPreset(previous);
        }
      }
      expect(f.previewed).toEqual([path, path]);
    },
  );

  test("finds a continued path even with adjacent prose on both sides", async () => {
    const f = fixture(
      [
        "some previous text",
        "  docs/long-folder/",
        "  README.md",
        "more following text",
      ],
      24,
    );
    f.existing.add("docs/long-folder/README.md");
    registerTerminalLinkProvider(
      f.term,
      () => {},
      f.resolve,
      () => true,
    );
    for (const row of [2, 3]) {
      expect((await f.links(row)).map((link) => link.text)).toEqual([
        "docs/long-folder/README.md",
      ]);
    }
  });

  test("does not bridge a blank line or turn an unresolved guessed path into a link", async () => {
    const f = fixture(["  docs/long-folder/", "", "  README.md"], 24);
    f.existing.add("docs/long-folder/README.md");
    registerTerminalLinkProvider(
      f.term,
      () => {},
      f.resolve,
      () => true,
    );
    expect(await f.links(1)).toEqual([]);
    f.lines[1]!.text = "  missing.md";
    expect(await f.links(1)).toEqual([]);
  });

  test("recognizes wrapped HTTP links without treating the continuation as a file", async () => {
    const f = fixture(["https://example.", "com/docs/a.md   "], 16, [2]);
    registerTerminalLinkProvider(f.term, () => {}, f.resolve);
    const links = await f.links(2);
    expect(links.map((link) => link.text)).toEqual([
      "https://example.com/docs/a.md",
    ]);
    expect(links[0]!.range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: 13, y: 2 },
    });
    expect(f.requests).toEqual([]);
  });

  test("keeps a file on the next endpoint row independent of an HTTP URL", async () => {
    const f = fixture(["https://example.com", "docs/guide.md"], 30);
    f.existing.add("docs/guide.md");
    registerTerminalLinkProvider(
      f.term,
      () => {},
      f.resolve,
      () => true,
    );
    expect((await f.links(1)).map((link) => link.text)).toEqual([
      "https://example.com",
    ]);
    expect((await f.links(2)).map((link) => link.text)).toEqual([
      "docs/guide.md",
    ]);
  });

  test("keeps explicit spaces in a soft-wrapped line as path boundaries", async () => {
    const f = fixture(["docs/foo ", "bar.md"], 9, [2]);
    f.existing.add("docs/foobar.md");
    registerTerminalLinkProvider(f.term, () => {}, f.resolve);
    expect(await f.links(1)).toEqual([]);
    expect(await f.links(2)).toEqual([]);
  });

  test("rejects async results when another row in the path changes", async () => {
    const f = fixture(["docs/long-path/g", "uide.md         "], 16, [2]);
    let complete!: (value: Map<string, string>) => void;
    registerTerminalLinkProvider(
      f.term,
      () => {},
      () =>
        new Promise((done) => {
          complete = done;
        }),
    );
    const result = f.links(1);
    f.lines[1]!.text = "one.md";
    complete(new Map([["docs/long-path/guide.md", "docs/long-path/guide.md"]]));
    expect(await result).toEqual([]);
  });

  test("rejects async results when wrapping changes without changing the text", async () => {
    const f = fixture(["docs/long-path/g", "uide.md         "], 16, [2]);
    let complete!: (value: Map<string, string>) => void;
    registerTerminalLinkProvider(
      f.term,
      () => {},
      () =>
        new Promise((done) => {
          complete = done;
        }),
    );
    const result = f.links(1);
    f.lines[1]!.isWrapped = false;
    complete(new Map([["docs/long-path/guide.md", "docs/long-path/guide.md"]]));
    expect(await result).toEqual([]);
  });
});

describe("endpoint terminal link provider", () => {
  const regions = [
    { row: 1, start_col: 4, end_col: 23 },
    { row: 2, start_col: 0, end_col: 4 },
  ];
  const resolved = { regions, url: "https://example.com/guide" };

  test.each(["resolved", "invalidated"])(
    "suppresses superseded row callbacks when %s",
    async (mode) => {
      const f = fixture(["https://a.example", "https://b.example"], 30);
      const completions: ((value: null) => void)[] = [];
      let state = 1;
      registerTerminalLinkProvider(f.term, undefined, undefined, () => false, {
        state: () => state,
        resolve: () => new Promise((done) => completions.push(done)),
      });
      const replies: string[] = [];
      f.provide(1, () => replies.push("A"));
      const b = f.links(2);
      completions[1]!(null);
      expect((await b)[0]?.text).toBe("https://b.example");
      if (mode === "invalidated") state++;
      completions[0]!(null);
      await Promise.resolve();
      expect(replies).toEqual([]);
    },
  );

  test("resolves a complete parenthesized URL without waiting for an upstream repaint", () => {
    const url = "https://github.com/powerfool/roamgate/pull/252";
    const text = `See PR #252 (${url}): merged.`;
    const f = fixture(["", text], 100);
    Object.assign(f.term.buffer.active, { viewportY: 0 });
    let probes = 0;
    registerTerminalLinkProvider(f.term, undefined, undefined, () => true, {
      state: () => 1,
      resolve: () => {
        probes++;
        return new Promise(() => {});
      },
    });
    let found: ILink[] | undefined;
    f.provide(2, (links) => {
      found = links;
    });
    expect(found?.map((link) => link.text)).toEqual([url]);
    expect(found?.[0]?.range).toEqual({
      start: { x: text.indexOf(url) + 1, y: 2 },
      end: { x: text.indexOf(url) + url.length, y: 2 },
    });
    expect(probes).toBe(0);
  });

  test.each([
    [" https://example.com/Foo_(bar", "baz)"],
    [" https://example.com/Foo?", "q=value"],
  ])(
    "resolves the raw wrapped token before trimming %s",
    async (head, tail) => {
      const f = fixture(["", head, tail], head.length);
      Object.assign(f.term.buffer.active, { viewportY: 0 });
      let probes = 0;
      registerTerminalLinkProvider(f.term, undefined, undefined, () => true, {
        state: () => 1,
        resolve: async () => {
          probes++;
          return {
            url: head.trimStart() + tail,
            regions: [
              { row: 1, start_col: 1, end_col: head.length - 1 },
              { row: 2, start_col: 0, end_col: tail.length - 1 },
            ],
          };
        },
      });
      expect((await f.links(2)).map((link) => link.text)).toEqual([
        head.trimStart() + tail,
      ]);
      expect(probes).toBe(1);
    },
  );

  test("does not publish a trimmed URL whose raw suffix is clipped below the viewport", async () => {
    const text = " https://example.com/Foo_(bar";
    const f = fixture(["", text], text.length);
    Object.assign(f.term.buffer.active, { viewportY: 0 });
    let probes = 0;
    registerTerminalLinkProvider(f.term, undefined, undefined, () => true, {
      state: () => 1,
      resolve: async () => {
        probes++;
        return {
          url: null,
          regions: [{ row: 1, start_col: 1, end_col: text.length - 1 }],
        };
      },
    });
    expect(await f.links(2)).toEqual([]);
    expect(probes).toBe(1);
  });

  test.each(["part/http://x.test", "part/(http://x.test)"])(
    "does not bypass clipped-prefix validation for %s",
    async (text) => {
      const f = fixture([text], 40);
      Object.assign(f.term.buffer.active, { viewportY: 0 });
      let probes = 0;
      registerTerminalLinkProvider(f.term, undefined, undefined, () => true, {
        state: () => 1,
        resolve: async () => {
          probes++;
          return {
            url: null,
            regions: [{ row: 0, start_col: 0, end_col: text.length - 1 }],
          };
        },
      });
      expect(await f.links(1)).toEqual([]);
      expect(probes).toBe(1);
    },
  );

  test.each(["incomplete", "complete"])(
    "probes a standalone indented URL whose semantic target is %s",
    async (kind) => {
      const head = "  https://example.com/part";
      const f = fixture(["", head, "  continuation"], 60);
      Object.assign(f.term.buffer.active, { viewportY: 0 });
      const calls: number[][] = [];
      registerTerminalLinkProvider(f.term, undefined, undefined, () => true, {
        state: () => 1,
        resolve: async (row, col) => {
          calls.push([row, col]);
          return {
            url: kind === "complete" ? head.trimStart() : null,
            regions: [
              { row: 1, start_col: 2, end_col: head.length - 1 },
              ...(kind === "incomplete"
                ? [{ row: 2, start_col: 2, end_col: 13 }]
                : []),
            ],
          };
        },
      });
      expect((await f.links(2)).map((link) => link.text)).toEqual(
        kind === "complete" ? [head.trimStart()] : [],
      );
      expect(calls).toEqual([[1, 2]]);
    },
  );

  test("keeps a wrapped continuation before a complete URL on the same row", async () => {
    const head = "https://example.com/aaaa";
    const tail = "part";
    const local = "http://x.test";
    const f = fixture(["", head, `${tail} ${local}`], head.length);
    Object.assign(f.term.buffer.active, { viewportY: 0 });
    const calls: number[][] = [];
    registerTerminalLinkProvider(f.term, undefined, undefined, () => true, {
      state: () => 1,
      resolve: async (row, col) => {
        calls.push([row, col]);
        return {
          url: head + tail,
          regions: [
            { row: 1, start_col: 0, end_col: head.length - 1 },
            { row: 2, start_col: 0, end_col: tail.length - 1 },
          ],
        };
      },
    });
    expect((await f.links(3)).map((link) => link.text)).toEqual([
      local,
      head + tail,
    ]);
    expect(calls).toEqual([[2, 0]]);
  });

  test.each([0, 7])(
    "keeps the complete upstream link range from either row at viewport %d",
    async (viewportY) => {
      const f = fixture(
        [
          ...Array<string>(viewportY).fill(""),
          "",
          "See https://example.com/",
          "guide",
        ],
        24,
      );
      Object.assign(f.term.buffer.active, { viewportY });
      const calls: number[][] = [];
      registerTerminalLinkProvider(
        f.term,
        () => {},
        undefined,
        () => true,
        {
          state: () => 1,
          resolve: async (row, col) => {
            calls.push([row, col]);
            return col === 0 && row === 1
              ? { regions: [], url: null }
              : resolved;
          },
        },
      );
      for (const row of [2, 3])
        expect(
          (await f.links(viewportY + row)).map((l) => [l.text, l.range]),
        ).toEqual([
          [
            resolved.url,
            {
              start: { x: 5, y: viewportY + 2 },
              end: { x: 5, y: viewportY + 3 },
            },
          ],
        ]);
      expect(calls).toEqual([
        [1, 4],
        [2, 0],
      ]);
    },
  );

  test.each(["unsupported", "failed"])(
    "retains file and safe local URL fallback when %s",
    async (mode) => {
      const f = fixture(
        ["https://example.com", "  docs/long-folder/", "  README.md"],
        30,
      );
      f.existing.add("docs/long-folder/README.md");
      registerTerminalLinkProvider(
        f.term,
        () => {},
        f.resolve,
        () => true,
        {
          state: () => 1,
          resolve: async () => {
            if (mode === "failed") throw new Error("resolver unavailable");
            return null;
          },
        },
      );
      expect((await f.links(1))[0]?.text).toBe("https://example.com");
      expect((await f.links(3))[0]?.text).toBe("docs/long-folder/README.md");
    },
  );

  test("does not fall back to clipped URL fragments inside upstream regions", async () => {
    const f = fixture(["https://example.com/part"], 24);
    registerTerminalLinkProvider(
      f.term,
      () => {},
      undefined,
      () => true,
      {
        state: () => 1,
        resolve: async () => ({
          regions: [{ row: 0, start_col: 0, end_col: 22 }],
          url: null,
        }),
      },
    );
    expect(await f.links(1)).toEqual([]);
  });

  test.each(["frame", "scroll", "resize", "reconnect", "navigation"])(
    "drops asynchronous replies after %s",
    async (change) => {
      const f = fixture(["", "See https://example.com/", "guide"], 24);
      let state: number | null = 1;
      let finish!: (value: typeof resolved) => void;
      registerTerminalLinkProvider(
        f.term,
        () => {},
        undefined,
        () => true,
        {
          state: () => state,
          resolve: () =>
            new Promise((done) => {
              finish = done;
            }),
        },
      );
      const links = f.links(3);
      if (change === "resize") Object.assign(f.term, { cols: 25 });
      else if (change === "scroll")
        Object.assign(f.term.buffer.active, { viewportY: 1 });
      else state = change === "frame" ? 2 : null;
      finish(resolved);
      expect(await links).toEqual([]);
    },
  );

  test("refreshes a stale cached file on hover without enabling its old action", async () => {
    const f = fixture(["/tmp/old.md"], 30);
    let state = 1;
    const refreshed: number[][] = [];
    Object.assign(f.term, {
      rows: 10,
      refresh: (...rows: number[]) => refreshed.push(rows),
    });
    registerTerminalLinkProvider(
      f.term,
      (path) => f.previewed.push(path),
      undefined,
      () => false,
      {
        state: () => state,
        resolve: async () => null,
      },
    );
    const [link] = await f.links(1);
    state++;
    f.lines[0]!.text = "/tmp/new.md";
    const event = { preventDefault() {}, ctrlKey: true } as MouseEvent;
    link!.hover!(event, link!.text);
    link!.activate(event, link!.text);
    await Promise.resolve();
    expect(f.previewed).toEqual([]);
    expect(refreshed).toEqual([[0, 9]]);
    expect((await f.links(1))[0]?.text).toBe("/tmp/new.md");
  });

  test("rechecks file actions at click time and forwards the menu position", async () => {
    const f = fixture(["/tmp/docs/guide.md"], 30);
    let state = 1;
    const opened: unknown[] = [];
    registerTerminalLinkProvider(
      f.term,
      (path, event) => opened.push([path, event]),
      undefined,
      () => false,
      {
        state: () => state,
        resolve: async () => null,
      },
    );
    const previous = getShortcutSnapshot().preferences.active;
    try {
      selectShortcutPreset("windows");
      const event = {
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        clientX: 70,
        clientY: 30,
        preventDefault() {},
      } as MouseEvent;
      const [link] = await f.links(1);
      link!.activate(event, link!.text);
      expect(opened).toEqual([["/tmp/docs/guide.md", event]]);
      state++;
      link!.activate(event, link!.text);
      expect(opened).toHaveLength(1);
    } finally {
      selectShortcutPreset(previous);
    }
  });

  test("activates only the hovered link and keeps its click-time checks", async () => {
    const f = fixture(["/tmp/docs/a.md /tmp/docs/b.md"], 40);
    let state = 1;
    const previewed: string[] = [];
    const provider = registerTerminalLinkProvider(
      f.term,
      (path) => previewed.push(path),
      undefined,
      () => false,
      {
        state: () => state,
        resolve: async () => null,
      },
    );
    const previous = getShortcutSnapshot().preferences.active;
    try {
      selectShortcutPreset("windows");
      const event = {
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault() {},
      } as MouseEvent;
      const [a, b] = await f.links(1);
      expect(provider.activateHovered(event)).toBe(false);
      b!.hover!(event, b!.text);
      expect(provider.activateHovered(event)).toBe(true);
      expect(previewed).toEqual(["/tmp/docs/b.md"]);
      b!.leave!(event, b!.text);
      expect(provider.activateHovered(event)).toBe(false);
      a!.hover!(event, a!.text);
      // Leaving a link that is no longer hovered keeps the current one.
      b!.leave!(event, b!.text);
      expect(provider.activateHovered(event)).toBe(true);
      expect(previewed).toEqual(["/tmp/docs/b.md", "/tmp/docs/a.md"]);
      state++;
      expect(provider.activateHovered(event)).toBe(true);
      expect(previewed).toHaveLength(2);
      provider.dispose();
      expect(provider.activateHovered(event)).toBe(false);
    } finally {
      selectShortcutPreset(previous);
    }
  });
});

describe("terminal touch link lookup", () => {
  test("uses the original cell without retiring a pending hover", async () => {
    const f = fixture(["docs/a.md", "docs/b.md"], 30);
    Object.assign(f.term.buffer.active, { viewportY: 0 });
    const completions: ((value: Map<string, string>) => void)[] = [];
    const provider = registerTerminalLinkProvider(
      f.term,
      () => {},
      () => new Promise((done) => completions.push(done)),
    );
    const hover = f.links(1);
    const touch = provider.resolveTouch(1, 6, () => true);
    completions[1]!(new Map([["docs/b.md", "/tmp/b.md"]]));
    expect(await touch).toEqual({ kind: "file", value: "/tmp/b.md" });
    completions[0]!(new Map([["docs/a.md", "/tmp/a.md"]]));
    expect((await hover)[0]?.text).toBe("docs/a.md");
  });

  test.each([
    "javascript:alert(1)",
    "file://example.com/tmp/docs",
    "https://example.org/hidden",
    "file://localhost/tmp/guide%20one.md",
    null,
  ])(
    "OSC8 target %s overrides URL-looking labels with exactly one cell lookup",
    async (uri) => {
      const f = fixture(["https://label.example"], 40);
      Object.assign(f.term.buffer.active, { viewportY: 0 });
      const cells: number[][] = [];
      const provider = registerTerminalLinkProvider(
        f.term,
        () => {},
        undefined,
        () => false,
        {
          state: () => 1,
          resolve: async (row, col, touch) => {
            expect(touch).toBe(true);
            cells.push([row, col]);
            return { url: null, regions: [], uri };
          },
        },
      );
      expect(await provider.resolveTouch(0, 10, () => true)).toEqual(
        uri === "https://example.org/hidden"
          ? { kind: "url", value: uri }
          : uri === "file://localhost/tmp/guide%20one.md"
            ? { kind: "file", value: "/tmp/guide one.md" }
            : null,
      );
      expect(cells).toEqual([[0, 10]]);
    },
  );

  test("selection edits and failed endpoint reads cannot revive a label target", async () => {
    const f = fixture(["https://label.example"], 40);
    Object.assign(f.term.buffer.active, { viewportY: 0 });
    let finish!: () => void;
    let current = true;
    const provider = registerTerminalLinkProvider(
      f.term,
      undefined,
      undefined,
      () => false,
      {
        state: () => 1,
        resolve: () =>
          new Promise((_resolve, reject) => {
            finish = () => reject(new Error("stale frame"));
          }),
      },
    );
    const pending = provider.resolveTouch(0, 10, () => current);
    current = false;
    finish();
    expect(await pending).toBeNull();
    current = true;
    const failed = provider.resolveTouch(0, 10, () => current);
    finish();
    expect(await failed).toBeNull();
  });
});
