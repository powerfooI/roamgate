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
    const fetchImages = (id: string) => {
      asked.push(id);
      return new Promise<HistoryImage[]>((resolve) =>
        replies.set(id, () =>
          resolve([
            { media_type: "image/png", bytes: 2, hash: `h${id}`, data: "aGk=" },
          ]),
        ),
      );
    };
    let shown: ReadonlyMap<string, readonly string[]> = new Map();
    function Probe({ entries }: { entries: HistoryEntry[] }) {
      shown = useAttachedImages(entries, fetchImages, "scope");
      return null;
    }
    const root = createRoot(document.createElement("div"));
    const render = (entries: HistoryEntry[]) =>
      React.act(async () => root.render(<Probe entries={entries} />));
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

    // Leaving releases the rest, and a reply after that makes nothing.
    await React.act(async () => root.unmount());
    expect(live.size).toBe(0);
    await answer(32);
    expect(made).toBe(30);
  });
}
