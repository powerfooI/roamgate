import {
  annotationDraftStorageKey,
  readReviewAnnotations,
  writeReviewAnnotations,
  type ReviewAnnotation,
} from "./annotations";
import { defaultShortcutBindings } from "./shortcutBindings";
import { describe, expect, test } from "bun:test";
import type { Workspace } from "./types";
import {
  checkoutKeyForWorkspace,
  inspectorMaximumSize,
  inspectorNavigationRatioAtPosition,
  isWorkspaceInspectorShortcut as resolveShortcut,
  INSPECTOR_SEPARATOR_SIZE,
  readInspectorPreferences,
  readResourceFileSelection,
  relativePathWithinCheckout,
  resourceOwnerKey,
  resourceScopeForWorkspace,
  resourceStateKey,
  resolveWorkspaceForScope,
  sameResourceOwner,
  writeInspectorNavigationRatio,
  writeInspectorPreferences,
  writeResourceFileSelection,
  type WorkspaceInspectorState,
} from "./workspaceResource";

const isWorkspaceInspectorShortcut = (
  event: Parameters<typeof resolveShortcut>[0],
) => resolveShortcut(event, defaultShortcutBindings("mac"));

function workspace(
  workspaceId: string,
  checkoutPath?: string,
  settingsKey?: string,
): Workspace {
  return {
    workspace_id: workspaceId,
    number: 1,
    label: workspaceId,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    agent_status: "unknown",
    ...(checkoutPath
      ? {
          worktree: {
            repo_key: "repo-key",
            repo_name: "repo",
            repo_root: "/repo",
            checkout_path: checkoutPath,
            is_linked_worktree: checkoutPath !== "/repo",
            gui_settings_key: settingsKey ?? "local:repo-key",
          },
        }
      : {}),
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

describe("workspace inspector shortcuts", () => {
  const event = (overrides: Partial<KeyboardEvent> = {}) => ({
    key: "B",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: true,
    repeat: false,
    ...overrides,
  });

  test("recognizes Cmd+Shift+B without colliding with sidebar or Ctrl shortcuts", () => {
    expect(isWorkspaceInspectorShortcut(event())).toBe(true);
    expect(isWorkspaceInspectorShortcut(event({ shiftKey: false }))).toBe(
      false,
    );
    expect(
      isWorkspaceInspectorShortcut(
        event({ metaKey: false, ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(false);
    expect(isWorkspaceInspectorShortcut(event({ repeat: true }))).toBe(false);
  });
});

describe("workspace inspector geometry", () => {
  test("caps peer-layout resizing while preserving a compact terminal", () => {
    expect(inspectorMaximumSize("right", 800, 700, true)).toBeCloseTo(440);
    expect(inspectorMaximumSize("right", 500, 700, true)).toBe(253);
    expect(inspectorMaximumSize("bottom", 800, 700, true)).toBe(350);
    expect(inspectorMaximumSize("bottom", 800, 200, true)).toBe(73);
  });
  test("preserves terminal minimums at the dock boundary", () => {
    const inspector = inspectorMaximumSize("right", 1000, 800);
    expect(inspector).toBe(513);
    expect(1000 - inspector - INSPECTOR_SEPARATOR_SIZE).toBe(480);
    expect(inspectorMaximumSize("bottom", 1000, 600)).toBe(353);
  });

  test("clamps the expanded navigation splitter around both pane minimums", () => {
    expect(inspectorNavigationRatioAtPosition(100, 1000)).toBe(0.24);
    expect(inspectorNavigationRatioAtPosition(400, 1000)).toBe(0.4);
    expect(inspectorNavigationRatioAtPosition(900, 1000)).toBe(0.692);
  });
});

describe("workspace resource scope", () => {
  test("isolates main and sibling worktrees even with the same repository settings key", () => {
    const storage = memoryStorage();
    const main = resourceScopeForWorkspace("local", workspace("main", "/repo"));
    const auth = resourceScopeForWorkspace(
      "local",
      workspace("auth", "/repo/.worktrees/auth"),
    );
    const docs = resourceScopeForWorkspace(
      "local",
      workspace("docs", "/repo/.worktrees/docs"),
    );
    expect(new Set([main, auth, docs].map(resourceStateKey)).size).toBe(3);
    expect(
      new Set([main, auth, docs].map(annotationDraftStorageKey)).size,
    ).toBe(3);
    writeResourceFileSelection(storage, auth, "auth-only.md");
    expect(readResourceFileSelection(storage, main)).toBeUndefined();
    expect(readResourceFileSelection(storage, docs)).toBeUndefined();
    writeResourceFileSelection(storage, main, "README.md");
    writeResourceFileSelection(storage, docs, "docs-only.md");
    expect(readResourceFileSelection(storage, auth)).toBe("auth-only.md");
    expect(readResourceFileSelection(storage, main)).toBe("README.md");
    expect(readResourceFileSelection(storage, docs)).toBe("docs-only.md");
    writeResourceFileSelection(storage, auth, null);
    expect(readResourceFileSelection(storage, main)).toBe("README.md");
    expect(readResourceFileSelection(storage, docs)).toBe("docs-only.md");
    writeInspectorPreferences(storage, {
      scope: auth,
      open: true,
      view: "changes",
      dock: "bottom",
      size: 410,
      expanded: false,
    });
    expect(readInspectorPreferences(storage, main)).toMatchObject({
      view: "files",
      dock: "right",
    });
    expect(readInspectorPreferences(storage, docs)).toMatchObject({
      view: "files",
      dock: "right",
    });
  });

  test("does not rebind a closed worktree to a sibling or a reused workspace id", () => {
    const original = workspace("auth", "/repo/.worktrees/auth");
    const scope = resourceScopeForWorkspace("local", original);
    const main = workspace("main", "/repo");
    const reused = workspace("auth", "/repo/.worktrees/docs");
    expect(resolveWorkspaceForScope(scope, [main, reused])).toBeUndefined();
    const reopened = workspace("reopened", "/repo/.worktrees/auth/");
    expect(resolveWorkspaceForScope(scope, [main, reused, reopened])).toBe(
      reopened,
    );
  });

  test("preserves endpoint identity while normalizing checkout separators", () => {
    const first = workspace("first", "C:\\repo\\wt\\", " local:repo-key ");
    const second = workspace("second", "C:/repo/wt/", "local:repo-key");
    expect(
      sameResourceOwner(
        resourceScopeForWorkspace("local", first),
        resourceScopeForWorkspace("local", second),
      ),
    ).toBe(true);
  });

  test("falls back stably for missing settings keys without aliasing enriched identity", () => {
    const first = workspace("first", "/repo/");
    first.worktree!.gui_settings_key = undefined;
    first.worktree!.repo_key = " repo-key ";
    const reopened = workspace("reopened", "/repo", "   ");
    expect(checkoutKeyForWorkspace(first)).toBe(
      JSON.stringify(["repo-key", "/repo"]),
    );
    expect(checkoutKeyForWorkspace(reopened)).toBe(
      checkoutKeyForWorkspace(first),
    );
    const storage = memoryStorage();
    const unknown = resourceScopeForWorkspace("ssh-profile", first);
    writeResourceFileSelection(storage, unknown, "unknown-endpoint.md");
    reopened.worktree!.gui_settings_key =
      "connection:ssh-profile:ssh:host-a:repo-key";
    const enriched = resourceScopeForWorkspace("ssh-profile", reopened);
    expect(sameResourceOwner(unknown, enriched)).toBe(false);
    expect(readResourceFileSelection(storage, enriched)).toBeUndefined();
    expect(readResourceFileSelection(storage, unknown)).toBe(
      "unknown-endpoint.md",
    );
  });

  test("uses workspace scope when worktree or required checkout identity is missing", () => {
    expect(resourceScopeForWorkspace("local", workspace("plain"))).toEqual({
      kind: "workspace",
      connectionId: "local",
      workspaceId: "plain",
    });
    const emptyPath = workspace("empty-path", "   ");
    expect(checkoutKeyForWorkspace(emptyPath)).toBeNull();
    const emptyRepo = workspace("empty-repo", "/repo", "   ");
    emptyRepo.worktree!.repo_key = "   ";
    expect(checkoutKeyForWorkspace(emptyRepo)).toBeNull();
  });

  test("isolates persisted state across a repointed SSH profile and restores it after reconnect", () => {
    const storage = memoryStorage();
    const hostWorkspace = (id: string, host: string, path = "/repo") =>
      workspace(id, path, `connection:ssh-profile:ssh:${host}:repo-key`);
    const hostA = hostWorkspace("w1", "host-a");
    // Profile replacement can reuse both the profile and runtime workspace IDs.
    const hostB = hostWorkspace("w1", "host-b");
    const scopeA = resourceScopeForWorkspace("ssh-profile", hostA);
    const scopeB = resourceScopeForWorkspace("ssh-profile", hostB);
    const draft: ReviewAnnotation = {
      id: "host-a-draft",
      source: "file",
      anchor: "line",
      path: "README.md",
      line: 1,
      quote: "host A only",
      comment: "Review on host A",
      createdAt: 1,
    };
    writeResourceFileSelection(storage, scopeA, "host-a.md");
    writeInspectorPreferences(storage, {
      scope: scopeA,
      open: true,
      view: "changes",
      dock: "bottom",
      size: 410,
      expanded: false,
    });
    writeInspectorNavigationRatio(storage, scopeA, "files", 0.56);
    expect(
      writeReviewAnnotations(storage, annotationDraftStorageKey(scopeA), [
        draft,
      ]),
    ).toBe(true);

    const sibling = resourceScopeForWorkspace(
      "ssh-profile",
      hostWorkspace("linked", "host-a", "/repo/.worktrees/auth"),
    );
    for (const isolated of [scopeB, sibling]) {
      expect(readResourceFileSelection(storage, isolated)).toBeUndefined();
      expect(readInspectorPreferences(storage, isolated)).toMatchObject({
        view: "files",
        dock: "right",
        filesNavigationRatio: 0.4,
      });
      expect(
        readReviewAnnotations(storage, annotationDraftStorageKey(isolated)),
      ).toEqual([]);
      expect(sameResourceOwner(scopeA, isolated)).toBe(false);
      expect(resourceStateKey(scopeA)).not.toBe(resourceStateKey(isolated));
    }
    expect(resolveWorkspaceForScope(scopeA, [hostB])).toBeUndefined();
    writeResourceFileSelection(storage, scopeB, "host-b.md");
    writeInspectorNavigationRatio(storage, scopeB, "files", 0.65);
    writeReviewAnnotations(storage, annotationDraftStorageKey(scopeB), [
      { ...draft, id: "host-b-draft", comment: "Review on host B" },
    ]);

    // Reconstruct scopes as after reconnect/restart; runtime workspace IDs may change.
    for (const id of ["w1", "restarted-workspace"]) {
      const reopened = hostWorkspace(id, "host-a", "/repo/");
      const restored = resourceScopeForWorkspace("ssh-profile", reopened);
      expect(sameResourceOwner(scopeA, restored)).toBe(true);
      expect(resolveWorkspaceForScope(scopeA, [hostB, reopened])).toBe(
        reopened,
      );
      expect(readResourceFileSelection(storage, restored)).toBe("host-a.md");
      expect(readInspectorPreferences(storage, restored)).toMatchObject({
        view: "changes",
        dock: "bottom",
        bottomSize: 410,
        filesNavigationRatio: 0.56,
      });
      expect(
        readReviewAnnotations(storage, annotationDraftStorageKey(restored)),
      ).toEqual([draft]);
    }
    expect(readResourceFileSelection(storage, scopeB)).toBe("host-b.md");
    expect(readInspectorPreferences(storage, scopeB).filesNavigationRatio).toBe(
      0.65,
    );
    expect(
      readReviewAnnotations(storage, annotationDraftStorageKey(scopeB))[0]
        ?.comment,
    ).toBe("Review on host B");
  });

  test("encodes repository and checkout paths without delimiter collisions", () => {
    const first = workspace("first", "/wt");
    first.worktree!.repo_key = "repo:x";
    first.worktree!.gui_settings_key = "local:repo:x";
    const second = workspace("second", "x:/wt");
    second.worktree!.repo_key = "repo";
    second.worktree!.gui_settings_key = "local:repo";
    expect(checkoutKeyForWorkspace(first)).not.toBe(
      checkoutKeyForWorkspace(second),
    );
  });

  test("does not restore ambiguous legacy repository-wide state", () => {
    const storage = memoryStorage();
    const scope = resourceScopeForWorkspace(
      "legacy-default",
      workspace("auth", "/repo/.worktrees/auth"),
    );
    storage.setItem(
      "workspaceInspectorFile:checkout:local:repo-key",
      "sibling-only.md",
    );
    storage.setItem(
      "workspaceInspector:checkout:local:repo-key",
      JSON.stringify({ dock: "bottom", view: "changes" }),
    );
    expect(readResourceFileSelection(storage, scope)).toBeUndefined();
    expect(readInspectorPreferences(storage, scope)).toMatchObject({
      dock: "right",
      view: "files",
    });
    expect(
      storage.getItem("workspaceInspectorFile:checkout:local:repo-key"),
    ).toBe("sibling-only.md");
  });

  test("uses stable checkout identity instead of a runtime workspace id", () => {
    const first = workspace("w1", "/repo/.worktrees/auth/", "auth-settings");
    const reopened = workspace("w2", "/repo/.worktrees/auth", "auth-settings");
    const main = workspace("main", "/repo");

    expect(checkoutKeyForWorkspace(first)).toBe(
      JSON.stringify(["auth-settings", "/repo/.worktrees/auth"]),
    );
    expect(checkoutKeyForWorkspace(main)).toBe(
      JSON.stringify(["local:repo-key", "/repo"]),
    );

    const firstScope = resourceScopeForWorkspace("local", first);
    const reopenedScope = resourceScopeForWorkspace("local", reopened);
    expect(resourceOwnerKey(firstScope)).toBe(
      `checkout:${JSON.stringify(["auth-settings", "/repo/.worktrees/auth"])}`,
    );
    expect(sameResourceOwner(firstScope, reopenedScope)).toBe(true);
    expect(resolveWorkspaceForScope(firstScope, [reopened])).toBe(reopened);
  });

  test("keeps identical checkout paths isolated by repository and connection", () => {
    const left = resourceScopeForWorkspace(
      "left",
      workspace("w1", "/worktree"),
    );
    const rightConnection = resourceScopeForWorkspace(
      "right",
      workspace("w2", "/worktree"),
    );
    const rightRepoWorkspace = workspace("w3", "/worktree");
    if (rightRepoWorkspace.worktree) {
      rightRepoWorkspace.worktree.repo_key = "other";
      rightRepoWorkspace.worktree.gui_settings_key = "local:other";
    }
    const rightRepo = resourceScopeForWorkspace("left", rightRepoWorkspace);

    expect(sameResourceOwner(left, rightConnection)).toBe(false);
    expect(sameResourceOwner(left, rightRepo)).toBe(false);
    expect(resourceStateKey(left)).not.toBe(resourceStateKey(rightConnection));
    expect(resourceStateKey(left)).not.toBe(resourceStateKey(rightRepo));
  });

  test("accepts an agent cwd only when it is inside the checkout", () => {
    expect(relativePathWithinCheckout("/repo/wt", "/repo/wt/src/auth")).toBe(
      "src/auth",
    );
    expect(relativePathWithinCheckout("/repo/wt/", "/repo/wt")).toBe("");
    expect(relativePathWithinCheckout("/repo/wt", "/repo/wt-other/src")).toBe(
      undefined,
    );
    expect(relativePathWithinCheckout("/repo/wt", "/tmp/outside")).toBe(
      undefined,
    );
  });

  test("restores maximized state without losing dock sizes or either list width", () => {
    const storage = memoryStorage();
    const scope = resourceScopeForWorkspace("local", workspace("w1"));
    const state: WorkspaceInspectorState = {
      scope,
      open: true,
      view: "files",
      dock: "right",
      size: 610,
      expanded: false,
    };
    writeInspectorPreferences(storage, state);
    writeInspectorNavigationRatio(storage, scope, "files", 0.55);
    writeInspectorPreferences(storage, { ...state, expanded: true });
    writeInspectorNavigationRatio(storage, scope, "files", 0.27, true);
    writeInspectorNavigationRatio(storage, scope, "changes", 0.3, true);
    writeInspectorPreferences(storage, {
      ...state,
      open: false,
      expanded: true,
    });
    expect(readInspectorPreferences(storage, scope)).toMatchObject({
      expanded: true,
      rightSize: 610,
      filesNavigationRatio: 0.55,
      expandedNavigationRatios: { files: 0.27, changes: 0.3 },
    });
    writeInspectorPreferences(storage, { ...state, dock: "bottom", size: 380 });
    expect(readInspectorPreferences(storage, scope)).toMatchObject({
      expanded: false,
      rightSize: 610,
      bottomSize: 380,
      expandedNavigationRatios: { files: 0.27, changes: 0.3 },
    });
    const other = resourceScopeForWorkspace("remote", workspace("w1"));
    expect(readInspectorPreferences(storage, other)).toMatchObject({
      expanded: false,
      expandedNavigationRatios: {},
    });
  });

  test("old preferences use an independent, narrow default for expanded lists", () => {
    const storage = {
      getItem: () => JSON.stringify({ filesNavigationRatio: 0.4 }),
    };
    const scope = resourceScopeForWorkspace("local", workspace("w1"));
    expect(readInspectorPreferences(storage, scope)).toMatchObject({
      expanded: false,
      filesNavigationRatio: 0.4,
      expandedNavigationRatios: {},
    });
    for (const width of [1000, 1400, 1800]) {
      expect(
        inspectorNavigationRatioAtPosition(300, width) * width,
      ).toBeCloseTo(300);
    }
    expect(
      readInspectorPreferences(
        {
          getItem: () =>
            JSON.stringify({
              expanded: "true",
              expandedNavigationRatios: { files: "bad", changes: 99 },
            }),
        },
        scope,
      ),
    ).toMatchObject({
      expanded: false,
      expandedNavigationRatios: { changes: 0.75 },
    });
  });

  test("persists dock and size independently for each checkout", () => {
    const storage = memoryStorage();
    const scope = resourceScopeForWorkspace(
      "local",
      workspace("w1", "/repo/.worktrees/auth", "auth"),
    );
    const state: WorkspaceInspectorState = {
      scope,
      open: true,
      view: "changes",
      dock: "bottom",
      size: 410,
      expanded: false,
    };

    writeInspectorPreferences(storage, state);
    expect(readInspectorPreferences(storage, scope)).toEqual({
      view: "changes",
      dock: "bottom",
      expanded: false,
      expandedNavigationRatios: {},
      rightSize: 520,
      bottomSize: 410,
      filesNavigationRatio: 0.4,
      changesNavigationRatio: 0.4,
    });

    writeInspectorPreferences(storage, { ...state, size: 150 });
    writeInspectorPreferences(storage, { ...state, dock: "right", size: 400 });
    expect(readInspectorPreferences(storage, scope).bottomSize).toBe(150);
    writeInspectorPreferences(storage, { ...state, size: 73 });
    expect(readInspectorPreferences(storage, scope).bottomSize).toBe(73);
    expect(
      readInspectorPreferences(memoryStorage(), scope, { bottomSize: 0 })
        .bottomSize,
    ).toBe(360);

    writeInspectorNavigationRatio(storage, scope, "files", 0.56);
    expect(readInspectorPreferences(storage, scope).filesNavigationRatio).toBe(
      0.56,
    );

    writeInspectorPreferences(storage, { ...state, view: "history" });
    expect(readInspectorPreferences(storage, scope)).toMatchObject({
      view: "history",
      filesNavigationRatio: 0.56,
      changesNavigationRatio: 0.4,
    });
  });
});
