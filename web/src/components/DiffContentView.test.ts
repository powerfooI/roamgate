import { describe, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ConnectionClient } from "../api";
import { store } from "../store";
import type { GitDiffEntry, GitDiffFile } from "../types";
import { IMAGE_MIME_TYPES } from "../../../shared/filePreview";
import {
  expandDiffEntryOnActivate,
  diffSectionCollapsed,
  nearestDiffEntryKeys,
  visibleDiffEntryKey,
  MAX_NEARBY_DIFF_FILES,
  readDiffCollapseState,
  writeDiffCollapseState,
  clearDiffContentResourceState,
} from "./diffContentState";
import {
  diffContentEntries,
  diffRenderableFile,
  diffHunkTargets,
  diffSearchGroups,
  nextDiffHunkIndex,
  isImageDiff,
  highlightedPatch,
  DiffContentView,
} from "./DiffContentView";

const entries: GitDiffEntry[] = [
  { path: "src/one.ts", kind: "unstaged", status: "M" },
  { path: "src/two.ts", kind: "unstaged", status: "M" },
  { path: "asset.png", kind: "unstaged", status: "M" },
];

function diffFile(path: string, diff: string): GitDiffFile {
  return {
    workspace_id: "workspace",
    root: "/tmp/workspace",
    path,
    kind: "unstaged",
    diff,
    truncated: false,
  };
}

if (process.env.ROAMGATE_DIFF_CONTENT_DOM_TEST !== "1") {
  test("continuous scrolling regression in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_DIFF_CONTENT_DOM_TEST: "1" },
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
  test("pending wheel movement survives resize and refresh while idle anchors still compensate", async () => {
    const browser = new Window({ url: "http://localhost" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const resizeObservers = new Set<{
      targets: Set<Element>;
      callback: ResizeObserverCallback;
    }>();
    const intersectionObservers = new Set<TestIntersectionObserver>();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    let now = 1_000;
    class TestResizeObserver {
      targets = new Set<Element>();
      constructor(public callback: ResizeObserverCallback) {
        resizeObservers.add(this);
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        resizeObservers.delete(this);
      }
    }
    class TestIntersectionObserver {
      targets = new Set<Element>();
      constructor(public callback: IntersectionObserverCallback) {
        intersectionObservers.add(this);
      }
      observe(target: Element) {
        this.targets.add(target);
        this.callback(
          [{ target, isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        intersectionObservers.delete(this);
      }
    }
    class TestWorker extends browser.EventTarget {
      postMessage(request: { id: string; type: string }) {
        expect(request.type).toBe("initialize");
        this.dispatchEvent(
          new browser.MessageEvent("message", {
            data: {
              id: request.id,
              type: "success",
              requestType: request.type,
            },
          }),
        );
      }
      terminate() {}
    }
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      Document: browser.Document,
      Event: browser.Event,
      WheelEvent: browser.WheelEvent,
      MutationObserver: browser.MutationObserver,
      ResizeObserver: TestResizeObserver,
      IntersectionObserver: TestIntersectionObserver,
      Worker: TestWorker,
      localStorage: browser.localStorage,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        writable: true,
        configurable: true,
      });
    }
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const client: ConnectionClient = {
      connectionId: "local-scroll-dom",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
      call: async () => {
        throw new Error("Empty patches must not request backend data");
      },
    };
    const snapshot = {
      ...store.get(),
      connections: [
        {
          id: client.connectionId,
          label: "Local",
          source: "test",
          is_default: false,
          state: "ready" as const,
          generation: 1,
          type: "local" as const,
        },
      ],
    };
    const get = spyOn(store, "get").mockImplementation(() => snapshot);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const reviewEntries = entries.slice(0, 2);
    let selected = reviewEntries[1];
    let revision = 1;
    let mobile = false;
    let upperHeight = 1_000;
    let files = Object.fromEntries(
      reviewEntries.map((entry) => [
        `${entry.kind}:${entry.path}`,
        diffFile(entry.path, ""),
      ]),
    );
    const bounds = spyOn(
      browser.HTMLElement.prototype,
      "getBoundingClientRect",
    ).mockImplementation(function (this: HTMLElement) {
      const scrollTop =
        container.querySelector(".pierre-diff-scroll")?.scrollTop ?? 0;
      const key = this.dataset.diffEntryKey;
      if (key)
        return new browser.DOMRect(
          0,
          (key.endsWith(reviewEntries[0].path) ? 0 : upperHeight) - scrollTop,
          800,
          key.endsWith(reviewEntries[0].path) ? upperHeight : 500,
        );
      return new browser.DOMRect(0, 0, 800, 400);
    });
    const scrollIntoView = spyOn(
      browser.HTMLElement.prototype,
      "scrollIntoView",
    ).mockImplementation(function (this: HTMLElement) {
      const scroller = this.closest<HTMLElement>(".pierre-diff-scroll");
      if (scroller) scroller.scrollTop += this.getBoundingClientRect().top;
    });
    const flushFrames = async () => {
      while (frames.size) {
        const pending = [...frames.values()];
        frames.clear();
        await act(async () => {
          for (const frame of pending) frame(now);
        });
      }
    };
    let nearby: GitDiffEntry[] = [];
    const visible: { current: GitDiffEntry | null } = { current: null };
    const render = async () => {
      await act(async () =>
        root.render(
          createElement(DiffContentView, {
            entry: selected,
            file: files[`${selected.kind}:${selected.path}`],
            entries: reviewEntries,
            files,
            loading: false,
            error: null,
            selectionRevision: revision,
            resourceKey: "local-scroll-dom",
            mobile,
            connectionClient: client,
            onNearbyFilesChange: (next) => {
              nearby = next;
            },
            onVisibleFileChange: (next) => {
              visible.current = next;
            },
            onSelectFile: (entry) => {
              selected = entry;
              revision += 1;
            },
          }),
        ),
      );
      await flushFrames();
    };
    const resizeContent = async () => {
      const content = container.querySelector(".pierre-diff-scroll-content")!;
      await act(async () => {
        for (const observer of resizeObservers) {
          if (!observer.targets.has(content)) continue;
          observer.callback(
            [
              {
                target: content,
                borderBoxSize: [{ blockSize: upperHeight + 500 }],
              } as unknown as ResizeObserverEntry,
            ],
            observer as unknown as ResizeObserver,
          );
        }
      });
    };
    const refreshFiles = () => {
      files = { ...files };
      return render();
    };
    try {
      await render();
      const scroller = container.querySelector<HTMLElement>(
        ".pierre-diff-scroll",
      )!;
      expect(scroller.scrollTop).toBe(1_000);
      expect(visible.current).toBe(reviewEntries[1]);
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -500 }));
      scroller.scrollTop = 500;
      scroller.dispatchEvent(new Event("scroll"));
      await flushFrames();
      expect(visible.current).toBe(reviewEntries[0]);
      expect(selected).toBe(reviewEntries[1]);
      expect(revision).toBe(1);
      expect(scroller.scrollTop).toBe(500);
      scroller.scrollTop = 1_000;
      scroller.dispatchEvent(new Event("scroll"));
      await flushFrames();
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 200 }));
      scroller.scrollTop = 1_200;
      scroller.dispatchEvent(new Event("scroll"));

      // Native scrolling can move before its scroll event is delivered.
      now += 10;
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -80 }));
      scroller.scrollTop = 1_120;
      await resizeContent();
      expect(scroller.scrollTop).toBe(1_120);
      // Compensate new content above without discarding the 80px wheel movement.
      upperHeight += 60;
      await refreshFiles();
      expect(scroller.scrollTop).toBe(1_180);

      scroller.dispatchEvent(new Event("scroll"));
      now += 1_000;
      upperHeight += 90;
      await refreshFiles();
      expect(scroller.scrollTop).toBe(1_270);
      upperHeight += 40;
      await resizeContent();
      expect(scroller.scrollTop).toBe(1_310);

      const index = container.querySelector<HTMLSelectElement>(
        '[aria-label="Jump to changed file"]',
      )!;
      for (const entry of reviewEntries) {
        index.value = `${entry.kind}:${entry.path}`;
        index.dispatchEvent(new Event("change", { bubbles: true }));
        await render();
        expect(scroller.scrollTop).toBe(
          entry === reviewEntries[0] ? 0 : upperHeight,
        );
        expect(visible.current).toBe(entry);
      }

      const body = scroller.querySelector(".diff-file-section-body")!;
      expect(body).not.toBeNull();
      expect(nearby).toHaveLength(2);
      await act(async () => {
        for (const observer of intersectionObservers) {
          observer.callback(
            [...observer.targets].map(
              (target) =>
                ({
                  target,
                  isIntersecting: false,
                }) as IntersectionObserverEntry,
            ),
            observer as unknown as IntersectionObserver,
          );
        }
      });
      await flushFrames();
      expect(nearby).toHaveLength(0);
      expect(body.isConnected).toBe(true);
      expect(scroller.querySelector(".diff-file-section-body")).toBe(body);

      const preferenceChange = async (key: string, value: string) => {
        const rawKey = `roamgate:${key}`;
        browser.localStorage.setItem(rawKey, value);
        await act(async () => {
          browser.dispatchEvent(
            new browser.StorageEvent("storage", {
              key: rawKey,
              newValue: value,
              storageArea: browser.localStorage,
            }),
          );
        });
      };
      const buttonPressed = (selector: string) =>
        container.querySelector(selector)?.getAttribute("aria-pressed");
      await preferenceChange("diffViewMode", "unified");
      await preferenceChange("desktopDiffWrap", "false");
      expect(buttonPressed(".diff-view-toggle button:last-child")).toBe("true");
      expect(buttonPressed(".diff-wrap-toggle")).toBe("false");
      expect(selected).toBe(reviewEntries[1]);
      mobile = true;
      await render();
      await preferenceChange("mobileDiffWrap", "true");
      expect(buttonPressed(".diff-wrap-toggle")).toBe("true");
      browser.localStorage.clear();
      await act(async () => {
        const event = new browser.StorageEvent("storage", {
          storageArea: browser.localStorage,
        });
        Object.defineProperty(event, "key", { value: null });
        browser.dispatchEvent(event);
      });
      expect(buttonPressed(".diff-wrap-toggle")).toBe("false");
      mobile = false;
      await render();
      expect(buttonPressed(".diff-view-toggle button:first-child")).toBe(
        "true",
      );
      expect(buttonPressed(".diff-wrap-toggle")).toBe("true");
    } finally {
      await act(async () => root.unmount());
      clearDiffContentResourceState("local-scroll-dom");
      bounds.mockRestore();
      scrollIntoView.mockRestore();
      clock.mockRestore();
      get.mockRestore();
      await browser.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}

describe("expandDiffEntryOnActivate", () => {
  test("marks a collapsed entry as expanded", () => {
    const current = new Map([["unstaged:a.ts", true]]);
    const next = expandDiffEntryOnActivate(current, "unstaged:a.ts");
    expect(next.get("unstaged:a.ts")).toBe(false);
  });

  test("keeps the same map when the entry is already expanded", () => {
    const current = new Map([["unstaged:a.ts", false]]);
    expect(expandDiffEntryOnActivate(current, "unstaged:a.ts")).toBe(current);
  });

  test("preserves other entries and tolerates an empty state", () => {
    const current = new Map([["unstaged:b.ts", true]]);
    const next = expandDiffEntryOnActivate(current, "unstaged:a.ts");
    expect(next.get("unstaged:b.ts")).toBe(true);
    expect(expandDiffEntryOnActivate(undefined, "unstaged:a.ts").size).toBe(1);
  });

  test("keeps generated and large files skipped until an explicit expansion", () => {
    const current = new Map([["unstaged:generated.ts", true]]);
    expect(
      expandDiffEntryOnActivate(current, "unstaged:generated.ts", true),
    ).toBe(current);
    expect(
      expandDiffEntryOnActivate(undefined, "unstaged:generated.ts", true).has(
        "unstaged:generated.ts",
      ),
    ).toBe(false);
    const selected = expandDiffEntryOnActivate(
      current,
      "unstaged:generated.ts",
      true,
      true,
    );
    expect(selected.get("unstaged:generated.ts")).toBe(false);
    expect(current.get("unstaged:generated.ts")).toBe(true);
  });
});

test("deferred metadata remains loadable instead of rendering an empty textual diff", () => {
  const deferred = {
    ...diffFile("src/one.ts", ""),
    deferred: true,
    patch_size: 200 * 1024,
  };
  expect(diffRenderableFile(deferred)).toBeNull();
  const loaded = diffFile("src/one.ts", "@@ -1 +1 @@\n-before\n+after");
  expect(diffRenderableFile(loaded)).toBe(loaded);
  const binary = diffFile("asset.png", "");
  expect(diffRenderableFile(binary)).toBe(binary);
});

test("collapse-state contexts stay bounded while recently updated reviews survive", () => {
  const keys = Array.from(
    { length: 9 },
    (_, index) => `collapse-cache-test:${index}`,
  );
  try {
    for (const key of keys.slice(0, 8)) writeDiffCollapseState(key, new Map());
    const current = new Map([["unstaged:app.ts", true]]);
    writeDiffCollapseState(keys[0], current);
    writeDiffCollapseState(keys[8], new Map());
    expect(readDiffCollapseState(keys[0])).toBe(current);
    expect(readDiffCollapseState(keys[1])).toBeUndefined();
    expect(readDiffCollapseState(keys[8])).toBeDefined();
  } finally {
    for (const key of keys) clearDiffContentResourceState(key);
  }
});

describe("continuous file sections", () => {
  test("tracks the first visible file including skipped files and distinct change kinds", () => {
    const sections = [
      { key: "unstaged:b.ts", top: 300, bottom: 500 },
      { key: "staged:a.ts", top: 100, bottom: 200 },
      { key: "unstaged:a.ts", top: 200, bottom: 300 },
      { key: "unstaged:generated.ts", top: 500, bottom: 600 },
    ];
    expect(visibleDiffEntryKey(sections, { top: 100, bottom: 400 })).toBe(
      "staged:a.ts",
    );
    expect(visibleDiffEntryKey(sections, { top: 199.9, bottom: 400 })).toBe(
      "unstaged:a.ts",
    );
    expect(visibleDiffEntryKey(sections, { top: 500, bottom: 700 })).toBe(
      "unstaged:generated.ts",
    );
    expect(visibleDiffEntryKey(sections, { top: 700, bottom: 800 })).toBeNull();
  });

  const defaults = {
    continuous: true,
    embedded: false,
    active: false,
    manual: undefined,
    autoCollapsed: false,
  };

  test("keeps ordinary siblings expanded and manual collapses independent", () => {
    expect(diffSectionCollapsed(defaults)).toBe(false);
    expect(diffSectionCollapsed({ ...defaults, active: true })).toBe(false);
    expect(diffSectionCollapsed({ ...defaults, manual: true })).toBe(true);
    expect(
      diffSectionCollapsed({ ...defaults, manual: false, autoCollapsed: true }),
    ).toBe(false);
    expect(diffSectionCollapsed({ ...defaults, autoCollapsed: true })).toBe(
      true,
    );
  });

  test("retains click-to-load SSH sections and embedded file changes", () => {
    expect(diffSectionCollapsed({ ...defaults, continuous: false })).toBe(true);
    expect(
      diffSectionCollapsed({ ...defaults, continuous: false, active: true }),
    ).toBe(false);
    expect(
      diffSectionCollapsed({
        ...defaults,
        embedded: true,
        autoCollapsed: true,
      }),
    ).toBe(false);
  });

  test("bounds nearby loading while making the entire review reachable", () => {
    const sections = Array.from({ length: 100 }, (_, index) => ({
      key: `unstaged:${index}.ts`,
      top: index * 100,
      bottom: (index + 1) * 100,
    }));
    const topKeys = nearestDiffEntryKeys(sections, { top: 0, bottom: 300 });
    const bottomKeys = nearestDiffEntryKeys(sections, {
      top: 9700,
      bottom: 10000,
    });
    expect(topKeys.length).toBe(MAX_NEARBY_DIFF_FILES);
    expect(topKeys[0]).toBe("unstaged:0.ts");
    expect(bottomKeys.length).toBe(MAX_NEARBY_DIFF_FILES);
    expect(bottomKeys).toContain("unstaged:99.ts");
    expect(bottomKeys).not.toContain("unstaged:0.ts");
    expect(
      nearestDiffEntryKeys(
        [
          { key: "staged:one.ts", top: 0, bottom: 100 },
          { key: "unstaged:one.ts", top: 100, bottom: 200 },
        ],
        { top: 0, bottom: 200 },
      ),
    ).toEqual(["staged:one.ts", "unstaged:one.ts"]);
  });
});

test("Changes previews every supported binary image without replacing text diffs", () => {
  for (const extension of IMAGE_MIME_TYPES.keys()) {
    const path = `image.${extension.toUpperCase()}`;
    expect(isImageDiff(path, "Binary files a/image and b/image differ")).toBe(
      true,
    );
    expect(isImageDiff(path, "GIT binary patch\nliteral 3")).toBe(true);
    expect(isImageDiff(path, "")).toBe(true);
    expect(isImageDiff(path, "@@ -1 +1 @@\n-<svg/>\n+<svg>...</svg>")).toBe(
      false,
    );
  }
  expect(isImageDiff("document.pdf", "Binary files a and b differ")).toBe(
    false,
  );
  expect(isImageDiff("README.md", "")).toBe(false);
});

test("parsed patches get fresh worker cache keys even when a file changes in place", () => {
  const patch =
    "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-before\n+after\n";
  const first = highlightedPatch(patch, "example.ts");
  const refreshed = highlightedPatch(
    patch.replace("+after", "+newer"),
    "example.ts",
  );
  expect(first.cacheKey).toBeTruthy();
  expect(refreshed.cacheKey).not.toBe(first.cacheKey);
});

test("renames preserve per-side languages without losing same-language overrides", () => {
  for (const [previousPath, path, language] of [
    ["config.json", "config.txt", undefined],
    ["config.json", "config.ts", undefined],
    ["config.txt", "config.json", undefined],
    ["old.json", "new.json", "json"],
    ["Podfile", "Gemfile", "ruby"],
  ] as const) {
    const diff = highlightedPatch(
      `diff --git a/${previousPath} b/${path}\n` +
        `similarity index 90%\nrename from ${previousPath}\nrename to ${path}\n` +
        `--- a/${previousPath}\n+++ b/${path}\n` +
        '@@ -1,3 +1,3 @@\n {\n-  "value": 1\n+  "value": 2\n }\n',
      path,
    );
    expect(diff.prevName).toBe(previousPath);
    expect(diff.name).toBe(path);
    if (language === undefined) expect(diff.lang).toBeUndefined();
    else expect(diff.lang).toBe(language);
  }
});

describe("diffContentEntries", () => {
  test("keeps every summary entry even when only one diff is loaded", () => {
    expect(diffContentEntries(entries, entries[0])).toBe(entries);
  });

  test("falls back to the selected entry before a summary is available", () => {
    expect(diffContentEntries([], entries[0])).toEqual([entries[0]]);
    expect(diffContentEntries([], null)).toEqual([]);
  });
});

describe("diffHunkTargets", () => {
  test("starts navigation at the first or last hunk", () => {
    expect(nextDiffHunkIndex(-1, 1, 3)).toBe(0);
    expect(nextDiffHunkIndex(-1, -1, 3)).toBe(2);
    expect(nextDiffHunkIndex(2, 1, 3)).toBe(0);
    expect(nextDiffHunkIndex(0, -1, 3)).toBe(2);
    expect(nextDiffHunkIndex(0, 1, 0)).toBe(-1);
  });

  test("locates the first changed lines in each patch hunk", () => {
    expect(
      diffHunkTargets(
        [
          "@@ -3,4 +3,5 @@",
          " context",
          "-before",
          "+after",
          "+added",
          "@@ -20,2 +21,0 @@",
          "-removed",
        ].join("\n"),
      ),
    ).toEqual([
      { oldLine: 4, newLine: 4 },
      { oldLine: 20, newLine: null },
    ]);
  });
});

describe("diffSearchGroups", () => {
  test("finds loaded files case-insensitively without double-counting lines", () => {
    const result = diffSearchGroups(
      entries,
      {
        "unstaged:src/one.ts": diffFile(
          "src/one.ts",
          "diff --git a/src/one.ts b/src/one.ts\n+Needle needle\n",
        ),
        "unstaged:src/two.ts": diffFile(
          "src/two.ts",
          "diff --git a/src/two.ts b/src/two.ts\n-needle\n",
        ),
      },
      "needle",
    );

    expect(result).toEqual({
      groups: [{ key: "unstaged:src/one.ts" }, { key: "unstaged:src/two.ts" }],
      count: 2,
    });
  });

  test("ignores unloaded and binary diffs", () => {
    const result = diffSearchGroups(
      entries,
      {
        "unstaged:asset.png": diffFile(
          "asset.png",
          "Binary files contain needle",
        ),
      },
      "needle",
    );

    expect(result).toEqual({ groups: [], count: 0 });
  });
});
