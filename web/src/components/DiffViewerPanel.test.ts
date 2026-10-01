import { describe, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { bridge, type ConnectionClient } from "../api";
import { store } from "../store";
import type { GitDiffEntry, GitDiffFile } from "../types";
import {
  DiffViewerPanel,
  beginDiffFileSelection,
  buildActiveDiffSelection,
  clearDiffViewerResourceCache,
  diffCacheKey,
  diffRuntimeContextKey,
  diffSelectionStorageKey,
  expandedDirsForEntries,
  expandedDirsForSelection,
  mergeResolvedDiffFile,
  prefetchDiffFilesInBatches,
  prefetchDiffViewerWorkspace,
  type ActiveDiffSelection,
  type DiffViewerPanelHandle,
} from "./DiffViewerPanel";

if (process.env.ROAMGATE_DIFF_PANEL_DOM_TEST !== "1") {
  test("diff panel refresh regressions in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_DIFF_PANEL_DOM_TEST: "1" },
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
  test("refresh retains bounded display while reloading and retires replaced or removed patches", async () => {
    const browser = new Window({ url: "http://localhost" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      localStorage: browser.localStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        writable: true,
        configurable: true,
      });
    }
    const entry = {
      path: "same.ts",
      kind: "unstaged" as const,
      status: "modified",
    };
    const pending: Array<(file: GitDiffFile) => void> = [];
    const rejectPending: Array<(error: Error) => void> = [];
    const requested: Array<{ path: string; automatic: boolean }> = [];
    let summaryEntries: GitDiffEntry[] = [entry];
    let summaryCalls = 0;
    let failSummary = false;
    const client: ConnectionClient = {
      connectionId: "ssh-refresh-dom",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
      call: async (method, params) => {
        if (method === "git.diff_summary") {
          summaryCalls += 1;
          if (failSummary) throw new Error("summary refresh failed");
          return {
            workspace_id: "workspace",
            root: "/repo",
            entries: summaryEntries.map((entry) => ({
              ...entry,
              ...(params?.mode === "branch-main" ? { kind: "branch" } : {}),
            })),
            counts: {
              staged: 0,
              unstaged: 1,
              untracked: 0,
              conflicted: 0,
              branch: 0,
              "last-step": 0,
            },
          };
        }
        if (method !== "git.diff_file")
          throw new Error(`Unexpected call: ${method}`);
        requested.push({
          path: String(params?.path),
          automatic: params?.automatic === true,
        });
        return new Promise<GitDiffFile>((resolve, reject) => {
          pending.push(resolve);
          rejectPending.push(reject);
        });
      },
    };
    let snapshot: ReturnType<typeof store.get> = {
      ...store.get(),
      activeConnectionId: client.connectionId,
      connections: [
        {
          id: client.connectionId,
          label: "SSH",
          source: "test",
          is_default: false,
          state: "ready",
          generation: 1,
          type: "ssh",
        },
      ],
      workspaces: [
        {
          workspace_id: "workspace",
          number: 1,
          label: "Repo",
          focused: true,
          pane_count: 0,
          tab_count: 0,
          agent_status: "",
        },
      ],
    };
    const get = spyOn(store, "get").mockImplementation(() => snapshot);
    const connection = spyOn(bridge, "connection").mockImplementation(
      () => client,
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const ref = createRef<DiffViewerPanelHandle>();
    let selection: ActiveDiffSelection | null = null;
    const file = (diff: string): GitDiffFile => ({
      workspace_id: "workspace",
      root: "/repo",
      path: entry.path,
      kind: entry.kind,
      diff,
      truncated: false,
    });
    const render = () =>
      root.render(
        createElement(DiffViewerPanel, {
          ref,
          workspaceId: "workspace",
          onSelectionChange: (next) => {
            selection = next;
          },
        }),
      );
    const refresh = () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Refresh changes"]')!
        .click();
    const selected = () => selection as ActiveDiffSelection | null;
    const highlightedName = () =>
      container.querySelector(
        '.diff-tree-file[aria-current="true"] .diff-tree-name',
      )?.textContent;
    try {
      await act(async () => render());
      expect(summaryCalls).toBe(1);
      expect(pending).toHaveLength(0);
      await act(async () => ref.current!.selectEntry(entry));
      expect(pending).toHaveLength(1);
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Refresh changes"]')!
          .click(),
      );
      expect(summaryCalls).toBe(2);
      expect(pending).toHaveLength(2);
      await act(async () => pending[0](file("stale")));
      expect((selection as ActiveDiffSelection | null)?.file).toBeNull();
      await act(async () => pending[1](file("fresh")));
      expect((selection as ActiveDiffSelection | null)?.file?.diff).toBe(
        "fresh",
      );

      // Nearby local sections refresh independently of the selected file.
      snapshot = {
        ...snapshot,
        connections: snapshot.connections.map((connection) => ({
          ...connection,
          type: "local",
        })),
      };
      await act(async () => render());
      const nearby = ["nearby.ts", "error.ts", "removed.ts"].map((path) => ({
        ...entry,
        path,
      }));
      summaryEntries = [entry, ...nearby];
      await act(async () => refresh());
      expect(selected()?.files["unstaged:same.ts"]?.diff).toBe("fresh");
      expect(pending).toHaveLength(3);
      await act(async () => pending[2](file("refreshed-selected")));
      const oldFiles = nearby.map((entry) => ({
        ...file(`old:${entry.path}`),
        path: entry.path,
      }));
      await act(async () => ref.current!.loadNearbyEntries(nearby.slice(0, 1)));
      const retiredIndex = requested.length - 1;
      expect(requested[retiredIndex].path).toBe(nearby[0].path);
      expect(selected()?.loadingKeys).toEqual(["unstaged:nearby.ts"]);
      failSummary = true;
      await act(async () => refresh());
      expect(selected()?.error).toBe("summary refresh failed");
      expect(selected()?.loadingKeys).toEqual([]);
      failSummary = false;
      await act(async () => ref.current!.loadNearbyEntries(nearby.slice(0, 1)));
      const retryIndex = requested.length - 1;
      expect(retryIndex).toBeGreaterThan(retiredIndex);
      await act(async () => pending[retiredIndex](oldFiles[0]));
      expect(selected()?.files["unstaged:nearby.ts"]).toBeUndefined();
      expect(selected()?.loadingKeys).toEqual(["unstaged:nearby.ts"]);
      await act(async () => pending[retryIndex](oldFiles[0]));
      expect(selected()?.files["unstaged:nearby.ts"]).toBe(oldFiles[0]);
      expect(selected()?.loadingKeys).toEqual([]);
      await act(async () => ref.current!.loadNearbyEntries(nearby));
      for (const old of oldFiles.slice(1)) {
        const index = requested.findIndex(
          (request) => request.path === old.path,
        );
        expect(index).toBeGreaterThanOrEqual(0);
        await act(async () => pending[index](old));
      }
      summaryEntries = [entry, ...nearby.slice(0, 2)];
      await act(async () => refresh());
      expect(selected()?.files["unstaged:nearby.ts"]).toBe(oldFiles[0]);
      expect(selected()?.files["unstaged:error.ts"]).toBe(oldFiles[1]);
      expect(selected()?.files["unstaged:removed.ts"]).toBeUndefined();
      expect(
        selected()?.entries.some((entry) => entry.path === "removed.ts"),
      ).toBe(false);
      await act(async () => ref.current!.loadNearbyEntries(nearby.slice(0, 2)));
      const selectedReload = requested
        .map((request) => request.path)
        .lastIndexOf("same.ts");
      await act(async () => pending[selectedReload](file("new-selected")));
      const deferredIndex = requested
        .map((request) => request.path)
        .lastIndexOf("nearby.ts");
      expect(requested[deferredIndex].automatic).toBe(true);
      await act(async () =>
        pending[deferredIndex]({
          ...file(""),
          path: "nearby.ts",
          patch_size: 400_000,
          deferred: true,
        }),
      );
      expect(selected()?.files["unstaged:nearby.ts"]?.deferred).toBe(true);
      expect(selected()?.files["unstaged:nearby.ts"]?.diff).toBe("");
      const errorIndex = requested
        .map((request) => request.path)
        .lastIndexOf("error.ts");
      await act(async () =>
        rejectPending[errorIndex](new Error("fresh error")),
      );
      expect(selected()?.files["unstaged:error.ts"]).toBeUndefined();
      expect(selected()?.fileErrors["unstaged:error.ts"]).toBe("fresh error");

      const visible = { ...entry, path: "folder/visible.ts" };
      const stagedVisible = { ...visible, kind: "staged" as const };
      summaryEntries = [entry, visible, stagedVisible];
      await act(async () => refresh());
      await act(async () =>
        pending[
          requested.map((request) => request.path).lastIndexOf(entry.path)
        ](file("highlight-selected")),
      );
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(".diff-tree-folder")!
          .click(),
      );
      expect(container.querySelectorAll(".diff-tree-file")).toHaveLength(1);
      const requestCount = requested.length;
      const selectionRevision = selected()?.selectionRevision;
      await act(async () => ref.current!.highlightEntry(stagedVisible));
      expect(highlightedName()).toBe("visible.ts");
      expect(selected()?.entry).toEqual(entry);
      expect(selected()?.selectionRevision).toBe(selectionRevision);
      expect(requested).toHaveLength(requestCount);
      summaryEntries = [entry, visible];
      await act(async () => refresh());
      expect(highlightedName()).toBe("same.ts");
      await act(async () =>
        pending[
          requested.map((request) => request.path).lastIndexOf(entry.path)
        ](file("highlight-refreshed")),
      );
      await act(async () => ref.current!.highlightEntry(visible));
      expect(highlightedName()).toBe("visible.ts");
      await act(async () =>
        Array.from(
          container.querySelectorAll<HTMLButtonElement>(".diff-tree-file"),
        )
          .find(
            (row) =>
              row.querySelector(".diff-tree-name")?.textContent === entry.path,
          )!
          .click(),
      );
      expect(highlightedName()).toBe("same.ts");

      const early = { ...entry, path: "early.ts" };
      const late = Array.from({ length: 23 }, (_, index) => ({
        ...entry,
        path: `late-${String(index).padStart(2, "0")}.ts`,
      }));
      summaryEntries = [entry, early, ...late];
      await act(async () => refresh());
      await act(async () =>
        pending[
          requested.map((request) => request.path).lastIndexOf("same.ts")
        ](file("bounded-selected")),
      );
      for (let start = 0; start < late.length; start += 12) {
        const batch = late.slice(start, start + 12);
        await act(async () => ref.current!.loadNearbyEntries(batch));
        for (const entry of batch) {
          const index = requested
            .map((request) => request.path)
            .lastIndexOf(entry.path);
          expect(index).toBeGreaterThanOrEqual(0);
          await act(async () =>
            pending[index]({ ...file(`old:${entry.path}`), path: entry.path }),
          );
        }
      }
      expect(Object.keys(selected()?.files ?? {})).toHaveLength(24);
      await act(async () => refresh());
      expect(selected()?.files["unstaged:late-22.ts"]?.diff).toBe(
        "old:late-22.ts",
      );
      await act(async () => ref.current!.loadNearbyEntries([early]));
      const earlyIndex = requested
        .map((request) => request.path)
        .lastIndexOf(early.path);
      await act(async () =>
        pending[earlyIndex]({ ...file("fresh-early"), path: early.path }),
      );
      expect(selected()?.files["unstaged:early.ts"]?.diff).toBe("fresh-early");
      expect(Object.keys(selected()?.files ?? {})).toHaveLength(24);
      await act(async () => ref.current!.highlightEntry(early));
      expect(highlightedName()).toBe("early.ts");
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Against main"]')!
          .click(),
      );
      expect(selected()?.files).toEqual({});
      expect(selected()?.file).toBeNull();
      expect(highlightedName()).toBe("same.ts");
    } finally {
      for (const resolve of pending) resolve(file("cleanup"));
      await act(async () => root.unmount());
      get.mockRestore();
      connection.mockRestore();
      await browser.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}

describe("connection-scoped diff identity", () => {
  test("isolates identical workspace IDs in memory and persistence", () => {
    const alpha = { connectionId: "alpha", generation: 1 };
    const beta = { connectionId: "beta", generation: 1 };
    expect(diffCacheKey(alpha, "same", "working")).not.toBe(
      diffCacheKey(beta, "same", "working"),
    );
    expect(diffCacheKey(alpha, "same", "working")).not.toBe(
      diffCacheKey({ connectionId: "alpha", generation: 2 }, "same", "working"),
    );
    expect(diffSelectionStorageKey("alpha", "same", "working")).not.toBe(
      diffSelectionStorageKey("beta", "same", "working"),
    );
    expect(diffSelectionStorageKey("legacy-default", "same", "working")).toBe(
      "diffViewerSelected:same:working",
    );
    expect(diffCacheKey(alpha, "runtime-a", "working", "checkout:stable")).toBe(
      diffCacheKey(alpha, "runtime-b", "working", "checkout:stable"),
    );
    expect(
      diffRuntimeContextKey(alpha, "runtime-a", "working", "checkout:stable"),
    ).not.toBe(
      diffRuntimeContextKey(alpha, "runtime-b", "working", "checkout:stable"),
    );
  });

  test("expands the selected file ancestors", () => {
    expect(
      Array.from(
        expandedDirsForSelection({
          path: "src/components/App.tsx",
          kind: "unstaged",
          status: "M",
        }),
      ),
    ).toEqual(["", "src", "src/components"]);
    expect(Array.from(expandedDirsForSelection(null))).toEqual([""]);
  });

  test("expands every directory in a refreshed diff tree", () => {
    expect(
      Array.from(
        expandedDirsForEntries([
          {
            path: "src/components/App.tsx",
            kind: "unstaged",
            status: "M",
          },
          {
            path: "server/src/index.ts",
            kind: "staged",
            status: "M",
          },
          {
            path: "README.md",
            kind: "untracked",
            status: "added",
          },
        ]),
      ),
    ).toEqual(["", "src", "src/components", "server", "server/src"]);
  });

  test("honors explicit null selection overrides", () => {
    const entry = {
      path: "stale.ts",
      kind: "unstaged" as const,
      status: "M",
    };
    const file = {
      workspace_id: "workspace",
      root: "/tmp/workspace",
      path: entry.path,
      kind: entry.kind,
      diff: "stale",
      truncated: false,
    };
    const selection = buildActiveDiffSelection(
      {
        summary: null,
        selected: entry,
        files: { "unstaged:stale.ts": file },
        fileErrors: {},
        error: "stale error",
      },
      { entry: null, file: null, error: null },
      null,
      false,
    );

    expect(selection.entry).toBeNull();
    expect(selection.file).toBeNull();
    expect(selection.error).toBeNull();
  });

  test("prefetches files into the requested checkout resource cache", async () => {
    let diffCalls = 0;
    const client: ConnectionClient = {
      connectionId: "scoped-prefetch",
      generation: 4,
      serverRuntimeGeneration: 2,
      isCurrent: () => true,
      acceptsServerGeneration: (value) => value === 2,
      call: async (_method, params) => {
        diffCalls += 1;
        return {
          path: String(params?.path ?? ""),
          diff: "diff --git a/file b/file",
        };
      },
    };
    const entries = [
      { path: "one.ts", kind: "unstaged", status: "M" },
      { path: "two.ts", kind: "unstaged", status: "M" },
    ] as const;

    await prefetchDiffFilesInBatches(client, "workspace-runtime", "working", [
      ...entries,
    ]);
    expect(diffCalls).toBe(2);

    const loaded: string[] = [];
    await prefetchDiffFilesInBatches(
      client,
      "workspace-runtime",
      "working",
      [...entries],
      "checkout:stable",
      (entry) => loaded.push(entry.path),
    );
    expect(diffCalls).toBe(4);
    expect(loaded.sort()).toEqual(["one.ts", "two.ts"]);

    await prefetchDiffFilesInBatches(
      client,
      "workspace-runtime",
      "working",
      [...entries],
      "checkout:stable",
    );
    expect(diffCalls).toBe(4);
  });

  test("does not repopulate a checkout cache after resource cleanup", async () => {
    let calls = 0;
    let resolveRetired!: (value: unknown) => void;
    const client: ConnectionClient = {
      connectionId: "cleared-diff",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: (value) => value === 1,
      call: async () => {
        calls += 1;
        if (calls === 1) {
          return new Promise((resolve) => {
            resolveRetired = resolve;
          });
        }
        return { path: "same.ts", diff: "fresh" };
      },
    };
    const entry = {
      path: "same.ts",
      kind: "unstaged" as const,
      status: "M",
    };

    const retired = prefetchDiffFilesInBatches(
      client,
      "runtime-workspace",
      "working",
      [entry],
      "checkout:stable",
    );
    clearDiffViewerResourceCache(client, "checkout:stable", {
      removeItem: () => undefined,
    });
    resolveRetired({ path: "same.ts", diff: "stale" });
    await retired;

    await prefetchDiffFilesInBatches(
      client,
      "runtime-workspace",
      "working",
      [entry],
      "checkout:stable",
    );
    expect(calls).toBe(2);
  });

  test("keeps the latest selection when an older file request resolves", () => {
    const first = {
      path: "first.ts",
      kind: "unstaged" as const,
      status: "M",
    };
    const second = {
      path: "second.ts",
      kind: "unstaged" as const,
      status: "M",
    };
    const resolved = mergeResolvedDiffFile(
      {
        summary: null,
        selected: second,
        files: {},
        fileErrors: {},
        error: "second is still loading",
      },
      first,
      {
        workspace_id: "workspace",
        root: "/tmp/workspace",
        path: first.path,
        kind: first.kind,
        diff: "diff --git a/first.ts b/first.ts",
        truncated: false,
      },
    );

    expect(resolved.selected).toBe(second);
    expect(resolved.files["unstaged:first.ts"]?.path).toBe("first.ts");
    expect(resolved.error).toBe("second is still loading");
  });

  test("clears a stale file error when retrying its selection", () => {
    const entry = {
      path: "retry.ts",
      kind: "unstaged" as const,
      status: "M",
    };
    const next = beginDiffFileSelection(
      {
        summary: null,
        selected: null,
        files: {},
        fileErrors: { "unstaged:retry.ts": "old failure" },
        error: "old failure",
      },
      entry,
    );

    expect(next.selected).toBe(entry);
    expect(next.fileErrors).toEqual({});
    expect(next.error).toBeNull();
  });

  test("late automatic metadata cannot replace an explicitly loaded patch", () => {
    const entry = { path: "long.ts", kind: "unstaged" as const, status: "M" };
    const file: GitDiffFile = {
      workspace_id: "workspace",
      root: "/repo",
      path: entry.path,
      kind: entry.kind,
      diff: "explicit patch",
      truncated: false,
    };
    const current = {
      summary: null,
      selected: entry,
      files: { "unstaged:long.ts": file },
      fileErrors: {},
      error: null,
    };
    expect(
      mergeResolvedDiffFile(current, entry, {
        ...file,
        diff: "",
        patch_size: 400_000,
        deferred: true,
      }),
    ).toBe(current);
  });

  test("bounds cached patch files by estimated bytes", () => {
    let cache: Parameters<typeof beginDiffFileSelection>[0] = {
      summary: null,
      selected: null,
      files: {},
      fileErrors: {},
      error: null,
    };
    const largeDiff = "x".repeat(1_500_000);
    const entries = Array.from({ length: 4 }, (_, index) => ({
      path: `large-${index}.ts`,
      kind: "unstaged" as const,
      status: "M",
    }));

    for (const entry of entries) {
      cache = beginDiffFileSelection(cache, entry);
      cache = mergeResolvedDiffFile(cache, entry, {
        workspace_id: "workspace",
        root: "/tmp/workspace",
        path: entry.path,
        kind: entry.kind,
        diff: largeDiff,
        truncated: false,
      });
    }

    expect(cache.selected).toBe(entries[entries.length - 1]);
    expect(Object.keys(cache.files).length).toBeLessThanOrEqual(2);
  });

  test("bounds cached patch files for large change sets", async () => {
    let diffCalls = 0;
    const client: ConnectionClient = {
      connectionId: "bounded-diff-cache",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: (value) => value === 1,
      call: async (_method, params) => {
        diffCalls += 1;
        return {
          path: String(params?.path ?? ""),
          diff: "diff --git a/file b/file",
        };
      },
    };
    const entries = Array.from({ length: 30 }, (_, index) => ({
      path: `file-${index}.ts`,
      kind: "unstaged" as const,
      status: "M",
    }));

    await prefetchDiffFilesInBatches(
      client,
      "large-workspace",
      "working",
      entries,
    );
    expect(diffCalls).toBe(30);

    await prefetchDiffFilesInBatches(
      client,
      "large-workspace",
      "working",
      entries.slice(0, 6),
    );
    expect(diffCalls).toBe(36);
  });

  test("evicts least-recently-used cache contexts", async () => {
    let calls = 0;
    const scopedClient: ConnectionClient = {
      connectionId: "bounded-contexts",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: (value) => value === 1,
      call: async (_method, params) => {
        calls += 1;
        return {
          path: String(params?.path ?? ""),
          diff: "diff --git a/file b/file",
        };
      },
    };
    const entry = {
      path: "same.ts",
      kind: "unstaged" as const,
      status: "M",
    };

    for (let index = 0; index < 9; index += 1) {
      await prefetchDiffFilesInBatches(
        scopedClient,
        `workspace-${index}`,
        "working",
        [entry],
      );
    }
    expect(calls).toBe(9);

    await prefetchDiffFilesInBatches(scopedClient, "workspace-0", "working", [
      entry,
    ]);
    expect(calls).toBe(10);
  });

  test("does not cache a diff file that resolves after its lease retires", async () => {
    let current = true;
    let diffCalls = 0;
    let resolveFirstDiff!: (value: unknown) => void;
    let signalFirstDiff!: () => void;
    const firstDiffRequested = new Promise<void>((resolve) => {
      signalFirstDiff = resolve;
    });
    const client: ConnectionClient = {
      connectionId: "stale-diff",
      generation: 7,
      serverRuntimeGeneration: 3,
      isCurrent: () => current,
      acceptsServerGeneration: (value) => value === 3,
      call: async (method) => {
        if (method === "git.diff_summary") {
          return {
            root: "/tmp/repo",
            entries: [{ path: "same.ts", kind: "unstaged", status: "M" }],
          };
        }
        diffCalls += 1;
        if (diffCalls === 1) {
          return new Promise((resolve) => {
            resolveFirstDiff = resolve;
            signalFirstDiff();
          });
        }
        return { path: "same.ts", text: "fresh" };
      },
    };

    const stale = prefetchDiffViewerWorkspace("same", client);
    await firstDiffRequested;
    current = false;
    resolveFirstDiff({ path: "same.ts", text: "stale" });
    await stale;

    current = true;
    await prefetchDiffViewerWorkspace("same", client);
    expect(diffCalls).toBe(2);
  });
});
