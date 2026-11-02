import { expect, test } from "bun:test";
import * as React from "react";
import type { HistoryEntry, HistoryImage } from "./agentHistory";

if (process.env.ROAMGATE_ATTACHED_IMAGES_DOM_TEST !== "1") {
  test("attached images in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_ATTACHED_IMAGES_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 15_000);
} else {
  test("loads the recent messages' images once and releases them", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    const live = new Set<string>();
    let made = 0;
    URL.createObjectURL = () => {
      const url = `blob:${++made}`;
      live.add(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => void live.delete(url);

    const { useAttachedImages } = await import("./useAttachedImages");
    const { createRoot } = await import("react-dom/client");
    const message = (id: number): HistoryEntry => ({
      id: String(id),
      role: "user",
      kind: "message",
      text: "[Image #1]",
      sent_at: "2026-01-01T00:00:00Z",
      images: [{ media_type: "image/png", bytes: 2, hash: `h${id}` }],
    });
    const asked: string[] = [];
    // Replies held until the test gives them.
    const replies = new Map<string, () => void>();
    let responseImages: HistoryImage[] | undefined;
    const fetchImages = (id: string) => {
      asked.push(id);
      return new Promise<HistoryImage[]>((resolve) =>
        replies.set(id, () =>
          resolve(
            responseImages ?? [
              {
                media_type: "image/png",
                bytes: 2,
                hash: `h${id}`,
                data: "aGk=",
              },
            ],
          ),
        ),
      );
    };
    let shown: ReadonlyMap<string, readonly string[]> = new Map();
    const renders: { key: string; count: number }[] = [];
    function Probe({
      entries,
      scopeKey,
    }: {
      entries: HistoryEntry[];
      scopeKey: string;
    }) {
      shown = useAttachedImages(entries, fetchImages, scopeKey);
      renders.push({ key: scopeKey, count: shown.size });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    const render = (entries: HistoryEntry[], scopeKey = "scope") =>
      React.act(async () =>
        root.render(<Probe entries={entries} scopeKey={scopeKey} />),
      );
    const answer = (...ids: number[]) =>
      React.act(async () => {
        for (const id of ids) replies.get(String(id))?.();
      });

    // Of 31 messages with an image, the 30 most recent are asked for, once.
    const all = Array.from({ length: 31 }, (_, index) => message(index + 1));
    await render(all);
    await render([...all]);
    expect(asked).toEqual(all.slice(1).map((entry) => entry.id));
    await answer(...all.slice(1).map((_, index) => index + 2));
    expect(shown.size).toBe(30);
    expect(live.size).toBe(30);

    // A new message pushes the oldest out: its image is released.
    const urlOf2 = shown.get("2")![0]!;
    await render([...all, message(32)]);
    expect(live.has(urlOf2)).toBe(false);
    expect(shown.has("2")).toBe(false);
    expect(live.size).toBe(29);

    // An entry id can be reused in another session: even its first render
    // must not expose images from the previous session.
    const beforeSwitch = renders.length;
    await render([message(31)], "other-session");
    expect(
      renders.slice(beforeSwitch).every((render) => render.count === 0),
    ).toBe(true);
    expect(live.size).toBe(0);
    await answer(31);
    expect(shown.has("31")).toBe(true);
    expect(live.size).toBe(1);

    // A reply from a newer file revision must match the expected image hash.
    responseImages = [
      { media_type: "image/png", bytes: 2, hash: "new-revision", data: "aGk=" },
    ];
    await render([message(33)], "other-session");
    await answer(33);
    expect(shown.size).toBe(0);
    expect(live.size).toBe(0);

    // If decoding a later image fails, release URLs already made for it.
    const pair = {
      ...message(34),
      images: [
        message(34).images![0]!,
        { media_type: "image/png", bytes: 2, hash: "h34b" },
      ],
    };
    responseImages = [
      { media_type: "image/png", bytes: 2, hash: "h34", data: "aGk=" },
      { media_type: "image/png", bytes: 2, hash: "h34b", data: "!" },
    ];
    await render([pair], "other-session");
    await answer(34);
    expect(shown.size).toBe(0);
    expect(live.size).toBe(0);

    // Leaving releases the rest, and a reply after that makes nothing.
    await React.act(async () => root.unmount());
    expect(live.size).toBe(0);
    await answer(32);
    expect(made).toBe(32);
  });
}
