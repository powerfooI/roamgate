import { afterAll, afterEach, expect, jest, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import type { ConnectionClient } from "../api";
import type { Workspace, WorktreeList } from "../types";
import type {
  PullRequestStatus,
  PullRequestSummary,
} from "../../../shared/pullRequest";

if (process.env.ROAMGATE_DIALOG_EFFECT_DOM_TEST !== "1") {
  test("dialog effect regressions in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_DIALOG_EFFECT_DOM_TEST: "1" },
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
  await registerDomTests();
}

async function registerDomTests() {
  const browser = new Window({ url: "http://localhost" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLButtonElement",
    "Element",
    "Node",
    "Event",
    "KeyboardEvent",
    "MouseEvent",
    "localStorage",
    "sessionStorage",
  ] as const) {
    Object.defineProperty(globalThis, key, {
      value: key === "window" ? browser : browser[key],
      writable: true,
      configurable: true,
    });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const {
    act,
    createElement: h,
    Fragment,
    startTransition,
    Suspense,
  } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ConfirmDialog, MessageDialog, TextInputDialog } = await import(
    "./ModalDialogs"
  );
  const { CreateWorkspaceDialog } = await import("./CreateWorkspaceDialog");
  const luckyNames = await import("../luckyName");
  const { WorktreeOpenDialog } = await import("./WorktreeOpenDialog");
  const { WorktreeLifecycleDialog } = await import("./WorktreeLifecycleDialog");
  const { useWorktreePullRequests, useWorkspacePullRequests } = await import(
    "../useWorktreePullRequests"
  );
  const { bridge } = await import("../api");
  const { __storeTesting, store } = await import("../store");
  const { WorkspaceTree } = await import("./WorkspaceTree");
  const { PullRequestCard } = await import("./PullRequestCard");
  const { readPullRequestCache, PULL_REQUEST_CACHE_KEY } = await import(
    "../pullRequestCache"
  );
  const { roamgateLocalStorage } = await import("../browserStorage");
  let listCalls = 0;
  const client: ConnectionClient = {
    connectionId: "dialog-test",
    generation: 1,
    serverRuntimeGeneration: 1,
    isCurrent: () => true,
    acceptsServerGeneration: () => true,
    call: async (method) => {
      expect(method).toBe("worktree.list");
      listCalls += 1;
      return {
        type: "worktree_list",
        source: {
          repo_key: "repo",
          repo_name: "Repo",
          repo_root: "/repo",
          source_checkout_path: "/repo",
        },
        worktrees: [],
      };
    },
  };
  const connection = spyOn(bridge, "connection").mockReturnValue(client);
  let root: Root | null = null;
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    await browser.happyDOM.whenAsyncComplete();
  });
  afterAll(async () => {
    connection.mockRestore();
    await browser.happyDOM.close();
  });

  type Callbacks = {
    open: boolean;
    onClose: () => void;
    onConfirm: () => void;
  };
  const dialogs: Array<{
    name: string;
    render: (props: Callbacks) => ReactElement;
    focus: string;
    enter?: "confirm" | "close";
  }> = [
    {
      name: "text input",
      render: ({ open, onClose }) =>
        h(TextInputDialog, {
          open,
          onClose,
          title: "Rename",
          label: "Name",
          initialValue: "original",
          onSubmit: () => {},
        }),
      focus: "input",
    },
    {
      name: "confirm",
      render: (props) =>
        h(ConfirmDialog, { ...props, title: "Confirm", message: "Continue?" }),
      focus: '[role="dialog"]',
      enter: "confirm",
    },
    {
      name: "message",
      render: ({ open, onClose }) =>
        h(MessageDialog, { open, onClose, title: "Message", message: "Ready" }),
      focus: '[role="alertdialog"]',
      enter: "close",
    },
    {
      name: "create workspace",
      render: ({ open, onClose }) =>
        h(CreateWorkspaceDialog, { open, onClose, initialName: "Workspace" }),
      focus: "input",
    },
    {
      name: "open worktree",
      render: ({ open, onClose }) =>
        h(WorktreeOpenDialog, { open, onClose, workspaceId: "workspace" }),
      focus: "input",
    },
  ];

  for (const kind of ["worktree", "workspace"] as const) {
    test(`${kind} name suggestions preserve edits, discard old replies, and tolerate loading failures`, async () => {
      const pending: Array<{
        resolve: (name: string) => void;
        reject: (error: Error) => void;
      }> = [];
      const generate = () =>
        new Promise<string>((resolve, reject) => {
          pending.push({ resolve, reject });
        });
      const suggestion =
        kind === "workspace"
          ? spyOn(luckyNames, "luckyWorkspaceName").mockImplementation(generate)
          : null;
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      let submitted = 0;
      const create =
        kind === "workspace"
          ? spyOn(store, "createWorkspace").mockResolvedValue({
              type: "workspace_created",
            })
          : null;
      const render = (open: boolean) =>
        root!.render(
          kind === "workspace"
            ? h(CreateWorkspaceDialog, { open, onClose: () => {} })
            : h(TextInputDialog, {
                open,
                title: "New Worktree",
                label: "Branch",
                initialValue: generate,
                onClose: () => {},
                onSubmit: () => {
                  submitted++;
                },
              }),
        );
      const input = () => container.querySelector<HTMLInputElement>("input")!;
      const edit = (value: string) => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLInputElement.prototype,
          "value",
        )!.set!.call(input(), value);
        input().dispatchEvent(new Event("input", { bubbles: true }));
      };
      try {
        await act(async () => render(true));
        expect(input().value).toBe("");
        expect(pending).toHaveLength(1);
        expect(
          container.querySelector<HTMLButtonElement>('[type="submit"]')!
            .disabled,
        ).toBe(true);
        await act(async () =>
          container
            .querySelector("form")!
            .dispatchEvent(
              new Event("submit", { bubbles: true, cancelable: true }),
            ),
        );
        expect(submitted).toBe(0);
        if (create) expect(create).not.toHaveBeenCalled();
        await act(async () => pending.shift()!.resolve("calm-otter"));
        await browser.happyDOM.whenAsyncComplete();
        expect(input().value).toBe("calm-otter");
        expect(input().selectionStart).toBe(0);
        expect(input().selectionEnd).toBe("calm-otter".length);
        if (create) {
          expect(
            container.querySelector<HTMLButtonElement>('[type="submit"]')!
              .disabled,
          ).toBe(false);
          await act(async () =>
            container
              .querySelector("form")!
              .dispatchEvent(
                new Event("submit", { bubbles: true, cancelable: true }),
              ),
          );
          expect(create).toHaveBeenLastCalledWith("calm-otter", undefined);
        }

        await act(async () => render(false));
        await act(async () => render(true));
        await act(async () => edit("my-branch"));
        expect(
          container.querySelector<HTMLButtonElement>('[type="submit"]')!
            .disabled,
        ).toBe(false);
        await act(async () => pending.shift()!.resolve("bright-falcon"));
        expect(input().value).toBe("my-branch");

        await act(async () => render(false));
        await act(async () => render(true));
        await act(async () => render(false));
        await act(async () => render(true));
        await act(async () => pending.shift()!.resolve("old-name"));
        expect(input().value).toBe("");
        expect(
          container.querySelector<HTMLButtonElement>('[type="submit"]')!
            .disabled,
        ).toBe(true);
        await act(async () => edit("temporary"));
        await act(async () => edit(""));
        await act(async () => pending.shift()!.resolve("new-name"));
        expect(input().value).toBe("");
        if (create)
          expect(
            container.querySelector<HTMLButtonElement>('[type="submit"]')!
              .disabled,
          ).toBe(false);

        await act(async () => render(false));
        await act(async () => render(true));
        await act(async () =>
          pending.shift()!.reject(new Error("Chunk unavailable")),
        );
        expect(input().disabled).toBe(false);
        if (create)
          expect(
            container.querySelector<HTMLButtonElement>('[type="submit"]')!
              .disabled,
          ).toBe(false);
        await act(async () => edit("manual-name"));
        expect(input().value).toBe("manual-name");
        if (kind === "worktree") {
          expect(
            container.querySelector<HTMLButtonElement>('[type="submit"]')!
              .disabled,
          ).toBe(false);
          await act(async () =>
            container
              .querySelector("form")!
              .dispatchEvent(
                new Event("submit", { bubbles: true, cancelable: true }),
              ),
          );
          expect(submitted).toBe(1);
        }
      } finally {
        create?.mockRestore();
        suggestion?.mockRestore();
      }
    });
  }

  const reviewList: WorktreeList = {
    type: "worktree_list",
    source: {
      repo_key: "repo",
      repo_name: "Repo",
      repo_root: "/repo",
      source_checkout_path: "/repo",
    },
    worktrees: Array.from({ length: 6 }, (_, index) => ({
      path: `/repo/topic-${index}`,
      branch: `topic-${index}`,
      label: `Topic ${index}`,
      is_bare: false,
      is_detached: false,
      is_prunable: false,
      is_linked_worktree: true,
    })),
  };
  const mergedStatus: PullRequestStatus = {
    state: "ready",
    root: "/repo/topic-0",
    branch: "topic-0",
    remotes: [],
    refreshedAt: "2026-10-01T00:00:00Z",
    provider: "github",
    request: {
      id: "r#1",
      number: 1,
      title: "Merged feature",
      author: "alice",
      source: "topic-0",
      target: "main",
      state: "merged",
      draft: false,
      url: "https://github.com/a/r/pull/1",
    },
  };

  const sidebarWorkspace: Workspace = {
    workspace_id: "review-workspace",
    number: 1,
    label: "topic-0",
    focused: true,
    pane_count: 0,
    tab_count: 0,
    agent_status: "unknown",
    worktree: {
      repo_key: "repo",
      repo_name: "Repo",
      repo_root: "/repo",
      checkout_path: "/repo/topic-0",
      is_linked_worktree: true,
      git_status: {
        branch: "topic-0",
        ahead: 2,
        behind: 0,
        staged: 1,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
        dirty: true,
      },
    },
  };

  test("sidebar preserves workspace names beside PR/MR badges and opens the selected request", async () => {
    const previousState = store.get();
    let status = mergedStatus;
    const call = spyOn(client, "call").mockImplementation(
      async (method, params) => {
        expect(method).toBe("git.pull_request");
        expect(params?.summary).toBe(true);
        return status;
      },
    );
    const open = spyOn(window, "open").mockReturnValue(null);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    let revision = 0;
    const render = async (workspace = sidebarWorkspace) =>
      act(async () => {
        __storeTesting.replaceState({
          ...previousState,
          status: "connected",
          workspaces: [
            {
              ...workspace,
              worktree: {
                ...workspace.worktree!,
                repo_key: `repo-${revision++}`,
              },
            },
          ],
          tabs: [],
          panes: [],
        });
        root!.render(h(WorkspaceTree));
      });
    const openMenu = () =>
      act(async () => {
        container.querySelector(".tree-row")!.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            clientX: 10,
            clientY: 10,
          }),
        );
        await import("./ContextMenu");
      });
    const requestAction = () =>
      Array.from(container.querySelectorAll("button")).find((button) =>
        /Open (PR on GitHub|MR on GitLab)/.test(button.textContent ?? ""),
      );
    try {
      for (const provider of ["github", "gitlab"] as const) {
        for (const [state, draft, label, icon] of [
          ["open", false, "Open", "git-pull-request"],
          ["opened", true, "Draft", "git-pull-request-draft"],
          ["merged", true, "Merged", "git-merge"],
          ["closed", true, "Closed without merge", "git-pull-request-closed"],
        ] as const) {
          const github = provider === "github";
          const url = github
            ? "https://github.com/a/r/pull/1"
            : "https://git.example.com/a/r/-/merge_requests/1";
          status = {
            ...mergedStatus,
            provider,
            request: { ...mergedStatus.request!, state, draft, url },
          };
          await render();
          expect(container.querySelector(".ws-label")?.textContent).toBe(
            "topic-0",
          );
          expect(
            container.querySelector(".ws-label .workspace-review"),
          ).toBeNull();
          const badge = container.querySelector(
            ".tree-row > .workspace-review",
          )!;
          expect(badge.textContent).toBe(github ? "#1" : "!1");
          expect(badge.getAttribute("aria-label")).toContain(label);
          expect(badge.getAttribute("title")).toContain("Merged feature");
          expect(badge.querySelector(`.lucide-${icon}`)).not.toBeNull();
          expect(container.querySelector(".git-branch")).toBeNull();
          expect(container.querySelector(".git-dirty")?.textContent).toBe("Δ1");
          expect(container.querySelector(".git-ahead")?.textContent).toBe("↑2");
          await openMenu();
          expect(requestAction()?.textContent).toBe(
            github ? "Open PR on GitHub" : "Open MR on GitLab",
          );
          await act(async () => requestAction()!.click());
          expect(open).toHaveBeenLastCalledWith(
            url,
            "_blank",
            "noopener,noreferrer",
          );
        }
      }
      await render({
        ...sidebarWorkspace,
        label: "My review",
        worktree: { ...sidebarWorkspace.worktree!, is_linked_worktree: false },
      });
      expect(container.querySelector(".ws-label")?.textContent).toBe(
        "My review",
      );
      expect(
        container.querySelector(".tree-row > .workspace-review")?.textContent,
      ).toBe("!1");
      for (const state of [
        "select_remote",
        "select_match",
        "unsupported",
        "missing_cli",
        "unauthenticated",
        "no_match",
        "detached",
        "error",
      ] as const) {
        status = { ...mergedStatus, state };
        await render();
        expect(container.querySelector(".workspace-review")).toBeNull();
        expect(container.querySelector(".ws-label")?.textContent).toBe(
          "topic-0",
        );
        await openMenu();
        expect(requestAction()).toBeUndefined();
      }
      for (const partial of [
        { request: undefined },
        { provider: undefined },
        { request: { ...mergedStatus.request!, state: "unknown" } },
      ]) {
        status = { ...mergedStatus, ...partial };
        await render({ ...sidebarWorkspace, label: "My review" });
        expect(container.querySelector(".workspace-review")).toBeNull();
        expect(container.querySelector(".git-branch")?.textContent).toBe(
          "topic-0",
        );
      }
    } finally {
      await act(async () => root!.unmount());
      root = null;
      call.mockRestore();
      open.mockRestore();
      __storeTesting.replaceState(previousState);
    }
  });

  test("sidebar reviews poll after completion, ignore ordinary metadata updates, and clear stale associations", async () => {
    let calls = 0;
    let pending: Array<(status: PullRequestStatus) => void> = [];
    const reviewClient = {
      ...client,
      call: async (_method: string, params?: Record<string, unknown>) => {
        expect(params?.latest).toBe(true);
        expect(params?.summary).toBe(true);
        calls++;
        return new Promise<PullRequestStatus>((resolve) =>
          pending.push(resolve),
        );
      },
    };
    function Reviews({
      workspaces,
      client,
    }: {
      workspaces: Workspace[];
      client: ConnectionClient;
    }) {
      return h(
        "pre",
        null,
        JSON.stringify(useWorkspacePullRequests(client, workspaces)),
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = (workspace = sidebarWorkspace, client = reviewClient) =>
      act(async () =>
        root!.render(h(Reviews, { workspaces: [workspace], client })),
      );
    const settle = () =>
      act(async () => {
        const replies = pending;
        pending = [];
        replies.forEach((resolve) => resolve(mergedStatus));
      });
    jest.useFakeTimers();
    try {
      await render();
      expect(calls).toBe(1);
      await act(async () => jest.advanceTimersByTime(120_000));
      expect(calls).toBe(1);
      await settle();
      expect(container.textContent).toContain("merged");
      await render({
        ...sidebarWorkspace,
        label: "Renamed",
        worktree: {
          ...sidebarWorkspace.worktree!,
          git_status: {
            ...sidebarWorkspace.worktree!.git_status!,
            unstaged: 4,
          },
        },
      });
      expect(calls).toBe(1);
      await act(async () => jest.advanceTimersByTime(60_000));
      expect(calls).toBe(2);
      const changedBranch = {
        ...sidebarWorkspace,
        worktree: {
          ...sidebarWorkspace.worktree!,
          git_status: {
            ...sidebarWorkspace.worktree!.git_status!,
            branch: "other",
          },
        },
      };
      await render(changedBranch);
      expect(container.textContent).toBe("{}");
      await settle();
      expect(container.textContent).toBe("{}");
      expect(calls).toBe(3);
      await settle();
      expect(container.textContent).toContain("merged");
      await render({
        ...changedBranch,
        worktree: { ...changedBranch.worktree, repo_key: "other-repo" },
      });
      expect(container.textContent).toBe("{}");
      await render(sidebarWorkspace, { ...reviewClient, generation: 2 });
      await settle();
      expect(container.textContent).toBe("{}");
      await render({ ...sidebarWorkspace, worktree: undefined });
      await settle();
      expect(container.textContent).toBe("{}");
      const lastCalls = calls;
      await act(async () => jest.advanceTimersByTime(120_000));
      expect(calls).toBe(lastCalls);
    } finally {
      await act(async () => root!.unmount());
      root = null;
      jest.useRealTimers();
    }
  });

  test.each(["workspace", "worktree"] as const)(
    "%s reviews recover when the same client becomes ready after reconnect",
    async (kind) => {
      const previousState = store.get();
      let generation = 1;
      let ready = true;
      let calls = 0;
      const replies: Array<(status: PullRequestStatus) => void> = [];
      const reviewClient = (capturedGeneration: number): ConnectionClient => ({
        ...client,
        generation: capturedGeneration,
        isCurrent: () => ready && capturedGeneration === generation,
        call: async (method) => {
          expect(method).toBe("git.pull_request");
          calls++;
          return new Promise((resolve) => replies.push(resolve));
        },
      });
      const workspaces = [sidebarWorkspace];
      const list = { ...reviewList, worktrees: [reviewList.worktrees[0]] };
      function Reviews({ client }: { client: ConnectionClient }) {
        const workspaceReviews = useWorkspacePullRequests(
          client,
          kind === "workspace" ? workspaces : [],
        );
        const worktreeReviews = useWorktreePullRequests(
          client,
          "workspace",
          kind === "worktree" ? list : null,
          0,
        );
        return h(
          "pre",
          null,
          JSON.stringify({
            ...workspaceReviews,
            ...worktreeReviews,
          }),
        );
      }
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      const render = (client: ConnectionClient) =>
        act(async () => root!.render(h(Reviews, { client })));
      const settle = () => act(async () => replies.shift()!(mergedStatus));
      jest.useFakeTimers();
      try {
        __storeTesting.replaceState({
          ...previousState,
          status: "connected",
          connectionPaused: false,
        });
        await render(reviewClient(generation));
        await settle();
        expect(container.textContent).toContain("merged");

        generation++;
        ready = false;
        __storeTesting.markTerminalReattachPending();
        const reconnected = reviewClient(generation);
        await render(reconnected);
        expect(container.textContent).toBe("{}");
        await act(async () => jest.advanceTimersByTime(120_000));
        expect(calls).toBe(1);

        // Catalog recovery publishes a store update without changing the
        // client object, workspace metadata, or target associations.
        await act(async () => {
          ready = true;
          __storeTesting.applyCatalog(
            previousState.connections,
            previousState.defaultConnectionId,
          );
          __storeTesting.rearmTerminalAttachmentsAfterCatalog(true);
        });
        expect(calls).toBe(2);
        await settle();
        expect(container.textContent).toContain("merged");

        await act(async () => jest.advanceTimersByTime(60_000));
        expect(calls).toBe(kind === "workspace" ? 3 : 2);
        if (kind === "workspace") await settle();
      } finally {
        await act(async () => root!.unmount());
        root = null;
        __storeTesting.replaceState(previousState);
        jest.useRealTimers();
      }
    },
  );

  test.each(["workspace", "worktree"] as const)(
    "%s reviews restore persisted summaries, survive reconnect and invalidate definitive misses",
    async (kind) => {
      const previousState = store.get();
      let ready = true;
      let generation = 1;
      let calls = 0;
      let refresh = 0;
      const replies: Array<(status: PullRequestStatus) => void> = [];
      const makeClient = (captured: number): ConnectionClient => ({
        ...client,
        generation: captured,
        isCurrent: () => ready && generation === captured,
        call: async () => {
          calls++;
          return new Promise((resolve) => replies.push(resolve));
        },
      });
      let activeClient = makeClient(generation);
      let workspace = sidebarWorkspace;
      let list = { ...reviewList, worktrees: [reviewList.worktrees[0]] };
      function Reviews({ refresh }: { refresh: number }) {
        const workspaceReviews = useWorkspacePullRequests(
          activeClient,
          kind === "workspace" ? [workspace] : [],
        );
        const worktreeReviews = useWorktreePullRequests(
          activeClient,
          "workspace",
          kind === "worktree" ? list : null,
          refresh,
        );
        return h(
          "pre",
          null,
          JSON.stringify({ ...workspaceReviews, ...worktreeReviews }),
        );
      }
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      let mount = 0;
      const render = () =>
        act(async () => root!.render(h(Reviews, { key: mount, refresh })));
      const settle = (status = mergedStatus) =>
        act(async () => replies.shift()!(status));
      const shown = () =>
        Object.values(
          JSON.parse(container.textContent!) as Record<
            string,
            PullRequestSummary
          >,
        )[0];
      const requestRefresh = async () => {
        if (kind === "workspace")
          await act(async () => jest.advanceTimersByTime(60_000));
        else {
          refresh++;
          await render();
        }
      };
      jest.useFakeTimers();
      try {
        __storeTesting.replaceState({
          ...previousState,
          status: "connected",
          connectionPaused: false,
          connections: [
            {
              id: client.connectionId,
              label: "Test",
              source: "local",
              type: "local",
              control_socket_path: "/tmp/review.sock",
              is_default: true,
              state: "ready",
              generation: 1,
            },
          ],
        });
        await render();
        await settle();
        expect(readPullRequestCache().size).toBe(1);
        mount++;
        await render();
        expect(shown().request?.state).toBe("merged");
        expect(shown().stale?.failedAt).toBeUndefined();
        expect(shown().stale?.message).toContain("Refreshing");

        // Even on the same client, an unmounted consumer cannot replace disk
        // state after its replacement has already refreshed the summary.
        const unmountedReply = replies.shift()!;
        mount++;
        await render();
        await settle();
        await act(async () =>
          unmountedReply({
            ...mergedStatus,
            request: { ...mergedStatus.request!, state: "closed" },
          }),
        );
        expect(
          [...readPullRequestCache().values()][0].status.request?.state,
        ).toBe("merged");
        await requestRefresh();
        const beforeReconnect = calls;

        generation++;
        ready = false;
        activeClient = makeClient(generation);
        __storeTesting.markTerminalReattachPending();
        for (const field of ["branch", "path", "repo"] as const) {
          workspace = {
            ...sidebarWorkspace,
            worktree: {
              ...sidebarWorkspace.worktree!,
              repo_key: field === "repo" ? "other" : "repo",
              checkout_path: field === "path" ? "/other" : "/repo/topic-0",
              git_status: {
                ...sidebarWorkspace.worktree!.git_status!,
                branch: field === "branch" ? "other" : "topic-0",
              },
            },
          };
          list = {
            ...reviewList,
            source: {
              ...reviewList.source,
              repo_key: workspace.worktree!.repo_key,
            },
            worktrees: [
              {
                ...reviewList.worktrees[0],
                path: workspace.worktree!.checkout_path,
                branch: workspace.worktree!.git_status!.branch,
              },
            ],
          };
          mount++;
          await render();
          expect(container.textContent).toBe("{}");
        }
        workspace = sidebarWorkspace;
        list = { ...reviewList, worktrees: [reviewList.worktrees[0]] };
        mount++;
        await render();
        expect(shown().request?.state).toBe("merged");
        expect(shown().stale?.message).toContain("connection");
        expect(calls).toBe(beforeReconnect);
        // An old connection must not overwrite either the screen or disk.
        await settle({
          ...mergedStatus,
          request: { ...mergedStatus.request!, state: "closed" },
        });
        expect(
          [...readPullRequestCache().values()][0].status.request?.state,
        ).toBe("merged");
        await act(async () => {
          ready = true;
          __storeTesting.rearmTerminalAttachmentsAfterCatalog(true);
        });
        expect(calls).toBe(beforeReconnect + 1);
        for (const state of [
          "unauthenticated",
          "missing_cli",
          "unsupported",
          "error",
        ] as const) {
          await settle({
            ...mergedStatus,
            state,
            request: undefined,
            retryable: state === "unsupported" || state === "error",
            message: "Temporarily unavailable",
          });
          expect(shown().request?.state).toBe("merged");
          expect(shown().stale?.failedAt).toBeString();
          expect(readPullRequestCache().size).toBe(1);
          await requestRefresh();
        }
        await settle({
          ...mergedStatus,
          request: { ...mergedStatus.request!, state: "open" },
        });
        expect(shown().request?.state).toBe("open");
        expect(shown().stale).toBeUndefined();
        await requestRefresh();
        await settle({
          ...mergedStatus,
          state: "no_match",
          request: undefined,
        });
        expect(shown().request).toBeUndefined();
        expect(readPullRequestCache().size).toBe(0);
        mount++;
        await render();
        expect(container.textContent).toBe("{}");
      } finally {
        await act(async () => root!.unmount());
        root = null;
        roamgateLocalStorage.removeItem(PULL_REQUEST_CACHE_KEY);
        __storeTesting.replaceState(previousState);
        jest.useRealTimers();
      }
    },
  );

  test.each(["pending", "failed"] as const)(
    "sidebar does not restore another branch when its query is %s and Git status disappears",
    async (phase) => {
      const previousState = store.get();
      const replies: Array<(status: PullRequestStatus) => void> = [];
      const reviewClient: ConnectionClient = {
        ...client,
        call: async () => new Promise((resolve) => replies.push(resolve)),
      };
      function Reviews({ branch, error }: { branch?: string; error?: string }) {
        return h(
          "pre",
          null,
          JSON.stringify(
            useWorkspacePullRequests(reviewClient, [
              {
                ...sidebarWorkspace,
                worktree: {
                  ...sidebarWorkspace.worktree!,
                  git_status: {
                    ...sidebarWorkspace.worktree!.git_status!,
                    branch,
                    error,
                  },
                },
              },
            ]),
          ),
        );
      }
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      let mount = 0;
      const render = (branch?: string, error?: string) =>
        act(async () =>
          root!.render(h(Reviews, { key: mount, branch, error })),
        );
      const settle = (status: PullRequestStatus) =>
        act(async () => replies.shift()!(status));
      try {
        __storeTesting.replaceState({
          ...previousState,
          connections: [
            {
              id: client.connectionId,
              label: "Test",
              source: "local",
              is_default: true,
              state: "ready",
              generation: 1,
            },
          ],
        });
        await render("topic-0");
        await settle(mergedStatus);
        expect(readPullRequestCache().size).toBe(1);
        await render("other");
        expect(container.textContent).toBe("{}");
        if (phase === "failed")
          await settle({
            ...mergedStatus,
            state: "error",
            retryable: true,
            request: undefined,
          });
        await render(undefined, "Git temporarily unavailable");
        expect(container.textContent).not.toContain('"request"');
        // A late reply for B must not be mistaken for a verified current branch.
        if (phase === "pending") await settle(mergedStatus);
        expect(container.textContent).not.toContain('"request"');
        // A fresh mount with no branch information cannot identify disk's A cache.
        mount++;
        await render(undefined, "Git temporarily unavailable");
        expect(container.textContent).toBe("{}");
        await render("other");
        expect(replies).toHaveLength(1);
        await settle({
          ...mergedStatus,
          request: { ...mergedStatus.request!, number: 2, source: "other" },
        });
        await render(undefined, "Git temporarily unavailable");
        expect(container.textContent).toContain('"number":2');
        expect(container.textContent).toContain("Git branch");
      } finally {
        await act(async () => root!.unmount());
        root = null;
        roamgateLocalStorage.removeItem(PULL_REQUEST_CACHE_KEY);
        __storeTesting.replaceState(previousState);
      }
    },
  );

  test.each(["workspace", "worktree"] as const)(
    "%s detached reviews require a new successful lookup after reconnect",
    async (kind) => {
      const previousState = store.get();
      let generation = 1;
      let ready = true;
      const replies: Array<(status: PullRequestStatus) => void> = [];
      const makeClient = (captured: number): ConnectionClient => ({
        ...client,
        generation: captured,
        isCurrent: () => ready && captured === generation,
        call: async () => new Promise((resolve) => replies.push(resolve)),
      });
      const workspace = {
        ...sidebarWorkspace,
        worktree: {
          ...sidebarWorkspace.worktree!,
          git_status: {
            ...sidebarWorkspace.worktree!.git_status!,
            branch: "detached",
          },
        },
      };
      const list = {
        ...reviewList,
        worktrees: [{ ...reviewList.worktrees[0], branch: undefined }],
      };
      function Reviews({ client }: { client: ConnectionClient }) {
        const workspaceReviews = useWorkspacePullRequests(
          client,
          kind === "workspace" ? [workspace] : [],
        );
        const worktreeReviews = useWorktreePullRequests(
          client,
          "workspace",
          kind === "worktree" ? list : null,
          0,
        );
        return h(
          "pre",
          null,
          JSON.stringify({ ...workspaceReviews, ...worktreeReviews }),
        );
      }
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      const render = (client: ConnectionClient) =>
        act(async () => root!.render(h(Reviews, { client })));
      const settle = (status: PullRequestStatus) =>
        act(async () => replies.shift()!(status));
      try {
        __storeTesting.replaceState({
          ...previousState,
          status: "connected",
          connectionPaused: false,
          connections: [
            {
              id: client.connectionId,
              label: "Test",
              source: "local",
              is_default: true,
              state: "ready",
              generation: 1,
            },
          ],
        });
        await render(makeClient(generation));
        await settle({ ...mergedStatus, rebasing: true });
        expect(container.textContent).toContain('"request"');
        expect(readPullRequestCache().size).toBe(0);
        generation++;
        ready = false;
        __storeTesting.markTerminalReattachPending();
        await render(makeClient(generation));
        expect(container.textContent).toBe("{}");
        await act(async () => {
          ready = true;
          __storeTesting.rearmTerminalAttachmentsAfterCatalog(true);
        });
        expect(container.textContent).toBe("{}");
        await settle({
          ...mergedStatus,
          state: "error",
          retryable: true,
          request: undefined,
        });
        expect(container.textContent).not.toContain('"request"');
        generation++;
        await render(makeClient(generation));
        await settle({ ...mergedStatus, rebasing: true });
        expect(container.textContent).toContain('"request"');
      } finally {
        await act(async () => root!.unmount());
        root = null;
        roamgateLocalStorage.removeItem(PULL_REQUEST_CACHE_KEY);
        __storeTesting.replaceState(previousState);
      }
    },
  );

  test.each(["worktree dialog", "inspector"] as const)(
    "%s waits for routing and resumes without remounting",
    async (kind) => {
      const previousState = store.get();
      let ready = false;
      let calls = 0;
      const waitingClient: ConnectionClient = {
        ...client,
        isCurrent: () => ready,
        call: async (method) => {
          calls++;
          expect(ready).toBe(true);
          return method === "worktree.list"
            ? { ...reviewList, worktrees: [reviewList.worktrees[0]] }
            : mergedStatus;
        },
      };
      connection.mockReturnValue(waitingClient);
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      try {
        __storeTesting.replaceState({
          ...previousState,
          status: "connected",
          connectionPaused: false,
          workspaces: [sidebarWorkspace],
        });
        __storeTesting.markTerminalReattachPending();
        await act(async () =>
          root!.render(
            kind === "worktree dialog"
              ? h(WorktreeOpenDialog, {
                  open: true,
                  workspaceId: sidebarWorkspace.workspace_id,
                  onClose: () => {},
                })
              : h(PullRequestCard, {
                  client: waitingClient,
                  workspaceId: sidebarWorkspace.workspace_id,
                  branch: "topic-0",
                }),
          ),
        );
        expect(calls).toBe(0);
        await act(async () => {
          ready = true;
          __storeTesting.rearmTerminalAttachmentsAfterCatalog(true);
        });
        expect(calls).toBe(kind === "worktree dialog" ? 2 : 1);
        expect(container.textContent).toContain(
          kind === "worktree dialog" ? "Merged" : "Merged feature",
        );
        expect(container.querySelector('[aria-busy="true"]')).toBeNull();
      } finally {
        await act(async () => root!.unmount());
        root = null;
        connection.mockReturnValue(client);
        __storeTesting.replaceState(previousState);
      }
    },
  );

  test("sidebar reviews reconcile targets independently and keep the last success across transient failures", async () => {
    const requests: Array<{
      params: Record<string, unknown>;
      resolve: (status: PullRequestStatus) => void;
      reject: (error: Error) => void;
    }> = [];
    const reviewClient = {
      ...client,
      call: async (_method: string, params?: Record<string, unknown>) =>
        new Promise<PullRequestStatus>((resolve, reject) =>
          requests.push({ params: params!, resolve, reject }),
        ),
    };
    const other: Workspace = {
      ...sidebarWorkspace,
      workspace_id: "other-workspace",
      worktree: {
        ...sidebarWorkspace.worktree!,
        checkout_path: "/repo/other",
      },
    };
    const withBranch = (
      workspace: Workspace,
      branch?: string,
      error?: string,
    ) => ({
      ...workspace,
      worktree: {
        ...workspace.worktree!,
        git_status: { ...workspace.worktree!.git_status!, branch, error },
      },
    });
    function Reviews({ workspaces }: { workspaces: Workspace[] }) {
      return h(
        "pre",
        null,
        JSON.stringify(useWorkspacePullRequests(reviewClient, workspaces)),
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = (workspaces: Workspace[]) =>
      act(async () => root!.render(h(Reviews, { workspaces })));
    const shown = () =>
      JSON.parse(container.textContent!) as Record<string, PullRequestSummary>;
    const settle = (
      status: (params: Record<string, unknown>) => PullRequestStatus | Error,
    ) =>
      act(async () => {
        for (const request of requests.splice(0)) {
          const value = status(request.params);
          if (value instanceof Error) request.reject(value);
          else request.resolve(value);
        }
      });
    jest.useFakeTimers();
    try {
      await render([sidebarWorkspace, other]);
      await settle(() => mergedStatus);
      expect(Object.keys(shown())).toEqual([
        "other-workspace",
        "review-workspace",
      ]);

      // A branch change requests only that target and leaves the other alone.
      await render([withBranch(sidebarWorkspace, "next"), other]);
      expect(Object.keys(shown())).toEqual(["other-workspace"]);
      expect(requests.map((request) => request.params.branch)).toEqual([
        "next",
      ]);
      // An obsolete reply for the old branch never reappears.
      await render([sidebarWorkspace, other]);
      await settle(() => ({
        ...mergedStatus,
        request: { ...mergedStatus.request!, state: "open" },
      }));
      expect(shown()["review-workspace"].request?.state).toBe("merged");
      expect(requests.map((request) => request.params.branch)).toEqual([
        "topic-0",
      ]);
      await settle(() => mergedStatus);

      // A transient Git status error keeps the last success marked stale.
      await render([
        withBranch(sidebarWorkspace, undefined, "git failed"),
        other,
      ]);
      expect(Object.keys(shown())).toHaveLength(2);
      expect(shown()["review-workspace"].stale?.message).toContain(
        "Git branch",
      );
      await render([sidebarWorkspace, other]);
      expect(Object.keys(shown())).toHaveLength(2);
      await settle(() => mergedStatus);

      // A poll keeps summaries while pending; failures keep the last success.
      await act(async () => jest.advanceTimersByTime(60_000));
      expect(requests).toHaveLength(2);
      expect(Object.keys(shown())).toHaveLength(2);
      await settle((params) =>
        params.workspace_id === "review-workspace"
          ? new Error("Connection failed")
          : {
              ...mergedStatus,
              state: "error",
              retryable: true,
              message: "Provider unavailable",
              refreshedAt: "2026-10-02T00:00:00Z",
            },
      );
      for (const id of ["review-workspace", "other-workspace"]) {
        expect(shown()[id]).toMatchObject({
          state: "ready",
          refreshedAt: mergedStatus.refreshedAt,
          request: { state: "merged" },
        });
        expect(shown()[id].stale?.failedAt).toBeString();
      }
      expect(shown()["other-workspace"].stale?.message).toBe(
        "Provider unavailable",
      );

      // Authoritative results and recoveries replace the stale fallback.
      await act(async () => jest.advanceTimersByTime(60_000));
      await settle((params) =>
        params.workspace_id === "review-workspace"
          ? { ...mergedStatus, refreshedAt: "2026-10-03T00:00:00Z" }
          : { ...mergedStatus, state: "detached", request: undefined },
      );
      expect(shown()["review-workspace"].stale).toBeUndefined();
      expect(shown()["review-workspace"].refreshedAt).toBe(
        "2026-10-03T00:00:00Z",
      );
      expect(shown()["other-workspace"]).toMatchObject({ state: "detached" });
      await act(async () => jest.advanceTimersByTime(60_000));
      await settle(() => ({
        ...mergedStatus,
        state: "error",
        retryable: true,
        request: undefined,
      }));
      // No success remains for the authoritative result to fall back to.
      expect(shown()["other-workspace"]).toMatchObject({ state: "error" });
      expect(shown()["other-workspace"].request).toBeUndefined();
    } finally {
      await act(async () => root!.unmount());
      root = null;
      jest.useRealTimers();
    }
  });

  test("sidebar polling is not postponed by other targets changing", async () => {
    const requests: Array<{
      params: Record<string, unknown>;
      resolve: (status: PullRequestStatus) => void;
    }> = [];
    const reviewClient = {
      ...client,
      call: async (_method: string, params?: Record<string, unknown>) =>
        new Promise<PullRequestStatus>((resolve) =>
          requests.push({ params: params!, resolve }),
        ),
    };
    const other: Workspace = {
      ...sidebarWorkspace,
      workspace_id: "other-workspace",
      worktree: { ...sidebarWorkspace.worktree!, checkout_path: "/repo/other" },
    };
    function Reviews({ workspaces }: { workspaces: Workspace[] }) {
      return h(
        "pre",
        null,
        JSON.stringify(useWorkspacePullRequests(reviewClient, workspaces)),
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = (branch: string) =>
      act(async () =>
        root!.render(
          h(Reviews, {
            workspaces: [
              sidebarWorkspace,
              {
                ...other,
                worktree: {
                  ...other.worktree!,
                  git_status: { ...other.worktree!.git_status!, branch },
                },
              },
            ],
          }),
        ),
      );
    const settle = () =>
      act(async () =>
        requests.splice(0).forEach(({ resolve }) => resolve(mergedStatus)),
      );
    jest.useFakeTimers();
    try {
      await render("b0");
      await settle();
      // A branch change 30s in requests only that workspace and must not
      // push back the 60s round for both.
      await act(async () => jest.advanceTimersByTime(30_000));
      await render("b1");
      expect(requests.map(({ params }) => params.workspace_id)).toEqual([
        "other-workspace",
      ]);
      await settle();
      await act(async () => jest.advanceTimersByTime(30_000));
      expect(requests.map(({ params }) => params.workspace_id).sort()).toEqual([
        "other-workspace",
        "review-workspace",
      ]);
    } finally {
      await act(async () => root!.unmount());
      root = null;
      jest.useRealTimers();
    }
  });

  test("worktree reviews are requested again when a closed dialog reopens", async () => {
    let calls = 0;
    const replies: Array<(status: PullRequestStatus) => void> = [];
    const reviewClient: ConnectionClient = {
      ...client,
      call: async () => {
        calls += 1;
        return new Promise((resolve) => replies.push(resolve));
      },
    };
    const single = { ...reviewList, worktrees: [reviewList.worktrees[0]] };
    function Reviews({ list }: { list: WorktreeList | null }) {
      return h(
        "pre",
        null,
        JSON.stringify(
          useWorktreePullRequests(reviewClient, "workspace", list, 0),
        ),
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = (list: WorktreeList | null) =>
      act(async () => root!.render(h(Reviews, { list })));
    await render(single);
    await act(async () => replies.shift()!(mergedStatus));
    expect(calls).toBe(1);
    // Dialogs stay mounted and pass no list while closed.
    await render(null);
    expect(container.textContent).toBe("{}");
    await render(single);
    expect(calls).toBe(2);
    // The previous summary stays visible while the new request is pending.
    expect(container.textContent).toContain("merged");
    await act(async () =>
      replies.shift()!({
        ...mergedStatus,
        request: { ...mergedStatus.request!, state: "open" },
      }),
    );
    expect(container.textContent).toContain('"state":"open"');
  });

  test("sidebar badges and the open action survive a failed refresh", async () => {
    const previousState = store.get();
    let fail = false;
    const call = spyOn(client, "call").mockImplementation(async () => {
      if (fail) throw new Error("Connection failed");
      return mergedStatus;
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    jest.useFakeTimers();
    try {
      await act(async () => {
        __storeTesting.replaceState({
          ...previousState,
          status: "connected",
          workspaces: [sidebarWorkspace],
          tabs: [],
          panes: [],
        });
        root!.render(h(WorkspaceTree));
      });
      const badge = () =>
        container.querySelector(".tree-row > .workspace-review");
      expect(badge()?.hasAttribute("data-stale")).toBe(false);
      fail = true;
      await act(async () => jest.advanceTimersByTime(60_000));
      expect(badge()?.textContent).toBe("#1");
      expect(badge()?.hasAttribute("data-stale")).toBe(true);
      expect(badge()?.getAttribute("aria-label")).toContain("refresh failed");
      await act(async () => {
        container.querySelector(".tree-row")!.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            clientX: 10,
            clientY: 10,
          }),
        );
      });
      expect(
        Array.from(container.querySelectorAll("button")).some(
          (button) => button.textContent === "Open PR on GitHub",
        ),
      ).toBe(true);
    } finally {
      await act(async () => root!.unmount());
      root = null;
      jest.useRealTimers();
      call.mockRestore();
      __storeTesting.replaceState(previousState);
    }
  });

  test("inspector manual refresh keeps the shown request and falls back to it on failure", async () => {
    const replies: Array<(status: PullRequestStatus | Error) => void> = [];
    const cardClient: ConnectionClient = {
      ...client,
      call: async () =>
        new Promise((resolve, reject) =>
          replies.push((value) =>
            value instanceof Error ? reject(value) : resolve(value),
          ),
        ),
    };
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const refresh = () =>
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Refresh PR/MR status"]',
      )!;
    const title = () =>
      container.querySelector(".pull-request-card-title")?.textContent;
    await act(async () =>
      root!.render(
        h(PullRequestCard, {
          client: cardClient,
          workspaceId: "workspace",
          branch: "topic-0",
        }),
      ),
    );
    expect(title()).toBe("Checking this branch...");
    await act(async () => replies.shift()!(mergedStatus));
    expect(title()).toBe("Merged feature");
    for (const failure of [
      new Error("Connection failed"),
      ...(["unauthenticated", "missing_cli"] as const).map((state) => ({
        ...mergedStatus,
        state,
        request: undefined,
      })),
      {
        ...mergedStatus,
        state: "error" as const,
        retryable: true,
        message: "Provider unavailable",
        request: undefined,
      },
    ]) {
      await act(async () => refresh().click());
      expect(refresh().disabled).toBe(true);
      expect(title()).toBe("Merged feature");
      expect(container.querySelector(".pull-request-card-link")).not.toBeNull();
      await act(async () => replies.shift()!(failure));
      expect(title()).toBe("Merged feature");
      expect(container.querySelector(".pull-request-card-link")).not.toBeNull();
      expect(
        container.querySelector(".pull-request-card-stale")?.textContent,
      ).toBe("Last known");
      expect(container.textContent).toContain("Last successful refresh");
    }
    expect(container.textContent).toContain("Provider unavailable");
    await act(async () => refresh().click());
    await act(async () =>
      replies.shift()!({
        ...mergedStatus,
        state: "no_match",
        request: undefined,
      }),
    );
    expect(title()).toBe("No linked request");
    expect(container.querySelector(".pull-request-card-stale")).toBeNull();
    // Without a previous success, failures stay explicit errors.
    await act(async () => refresh().click());
    await act(async () => replies.shift()!(new Error("Connection failed")));
    expect(title()).toBe("Status unavailable");
    expect(container.querySelector(".pull-request-card-link")).toBeNull();
  });

  test("worktree reviews bound concurrency, keep ordinary list polling local, and discard obsolete replies", async () => {
    const pending: Array<(value: PullRequestStatus) => void> = [];
    let calls = 0;
    let current = true;
    const reviewClient: ConnectionClient = {
      ...client,
      isCurrent: () => current,
      call: async (method, params, timeout) => {
        expect(method).toBe("git.pull_request");
        expect(params?.summary).toBe(true);
        expect(params?.latest).toBeUndefined();
        expect(timeout).toBe(65_000);
        calls += 1;
        return new Promise((resolve) => pending.push(resolve));
      },
    };
    function Reviews({
      list,
      client,
      refresh,
    }: {
      list: WorktreeList | null;
      client: ConnectionClient;
      refresh: number;
    }) {
      const statuses = useWorktreePullRequests(
        client,
        "workspace",
        list,
        refresh,
      );
      return h("pre", null, JSON.stringify(statuses));
    }
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = (list = reviewList, refresh = 0, client = reviewClient) =>
      root!.render(h(Reviews, { list, refresh, client }));
    await act(async () => render());
    expect(calls).toBe(4);
    await act(async () => pending.shift()!(mergedStatus));
    expect(calls).toBe(5);
    expect(container.textContent).toContain("merged");
    await act(async () =>
      render({
        ...reviewList,
        worktrees: reviewList.worktrees.map((worktree) => ({
          ...worktree,
          label: "Renamed",
          open_workspace_id: "opened",
        })),
      }),
    );
    expect(calls).toBe(5);

    // Explicit refreshes keep unchanged targets visible while pending.
    const shown = () =>
      JSON.parse(container.textContent!) as Record<string, PullRequestSummary>;
    const oldReplies = pending.splice(0);
    await act(async () => render(reviewList, 1));
    expect(shown()["/repo/topic-0"]?.request?.state).toBe("merged");
    expect(calls).toBe(5);
    await act(async () => render(reviewList, 2));
    expect(calls).toBe(5);
    await act(async () =>
      oldReplies.slice(0, -1).forEach((resolve) => resolve(mergedStatus)),
    );
    expect(calls).toBe(5);
    await act(async () => oldReplies[oldReplies.length - 1](mergedStatus));
    // Superseded rounds stop issuing work; topic-5 waits for this round.
    expect(Object.keys(shown())).toHaveLength(5);
    expect(calls).toBe(9);

    // Retryable failures keep the last success; authoritative results win.
    const failedAt = "2026-10-02T00:00:00Z";
    await act(async () => {
      pending.shift()!({
        ...mergedStatus,
        state: "error",
        retryable: true,
        message: "Provider unavailable",
        refreshedAt: failedAt,
        request: undefined,
      });
      pending.shift()!({
        ...mergedStatus,
        state: "error",
        message: "The branch changed during refresh. Refresh again.",
        request: undefined,
      });
      pending.shift()!({
        ...mergedStatus,
        state: "no_match",
        request: undefined,
      });
    });
    expect(shown()["/repo/topic-0"]).toMatchObject({
      state: "ready",
      refreshedAt: mergedStatus.refreshedAt,
      request: { state: "merged" },
      stale: { failedAt, message: "Provider unavailable" },
    });
    expect(shown()["/repo/topic-1"].state).toBe("error");
    expect(shown()["/repo/topic-1"].request).toBeUndefined();
    expect(shown()["/repo/topic-2"].state).toBe("no_match");
    expect(calls).toBe(11);
    await act(async () => render(reviewList, 3));
    await act(async () =>
      pending.splice(0).forEach((resolve) => resolve(mergedStatus)),
    );
    expect(calls).toBe(15);
    // The next success replaces the stale fallback.
    await act(async () =>
      pending.shift()!({
        ...mergedStatus,
        refreshedAt: "2026-10-03T00:00:00Z",
      }),
    );
    expect(shown()["/repo/topic-0"].stale).toBeUndefined();
    expect(shown()["/repo/topic-0"].refreshedAt).toBe("2026-10-03T00:00:00Z");

    const previousConnection = pending.splice(0);
    current = false;
    const nextClient = {
      ...reviewClient,
      connectionId: "other",
      generation: 2,
      isCurrent: () => true,
    };
    await act(async () => render(reviewList, 3, nextClient));
    await act(async () =>
      previousConnection.forEach((resolve) => resolve(mergedStatus)),
    );
    expect(container.textContent).toBe("{}");

    const previousRepo = pending.splice(0);
    const nextRepo = {
      ...reviewList,
      source: { ...reviewList.source, repo_key: "other-repo" },
    };
    await act(async () => render(nextRepo, 3, nextClient));
    await act(async () =>
      previousRepo.forEach((resolve) => resolve(mergedStatus)),
    );
    expect(container.textContent).toBe("{}");

    const previousBranch = pending.splice(0);
    await act(async () =>
      render(
        {
          ...nextRepo,
          worktrees: [{ ...reviewList.worktrees[0], branch: "new-topic" }],
        },
        2,
        nextClient,
      ),
    );
    await act(async () =>
      previousBranch.forEach((resolve) => resolve(mergedStatus)),
    );
    expect(container.textContent).toBe("{}");
    await act(async () =>
      pending.shift()!({
        ...mergedStatus,
        state: "no_match",
        request: undefined,
      }),
    );
    expect(container.textContent).toContain("no_match");
  });

  for (const lifecycle of [false, true]) {
    test(`${lifecycle ? "lifecycle" : "open"} worktree list exposes merge badges and explicitly refreshes them`, async () => {
      let reviews = 0;
      let delayInventory = false;
      let failInventory = false;
      let finishInventory!: (list: WorktreeList) => void;
      const call = spyOn(client, "call").mockImplementation(async (method) => {
        if (method === "worktree.list") {
          if (failInventory) throw new Error("Cannot load inventory");
          if (delayInventory)
            return new Promise((resolve) => {
              finishInventory = resolve;
            });
          return { ...reviewList, worktrees: [reviewList.worktrees[0]] };
        }
        if (method === "git.pull_request") {
          reviews += 1;
          if (reviews > 1) throw new Error("Connection failed");
          return mergedStatus;
        }
        if (method === "settings.worktree_hooks.get") return { enabled: true };
        throw new Error(`Unexpected call: ${method}`);
      });
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      let poll: () => void = () => {};
      const interval = spyOn(window, "setInterval").mockImplementation(((
        callback: TimerHandler,
      ) => {
        poll = callback as () => void;
        return 0;
      }) as typeof window.setInterval);
      try {
        await act(async () =>
          root!.render(
            h(lifecycle ? WorktreeLifecycleDialog : WorktreeOpenDialog, {
              open: true,
              workspaceId: "workspace",
              onClose: () => {},
            }),
          ),
        );
        expect(document.body.textContent).toContain("PR #1: Merged");
        const badge = document.querySelector(".worktree-review summary")!;
        expect(badge.closest("button")).toBeNull();
        expect(badge.parentElement?.tagName).toBe("DETAILS");
        (badge as HTMLElement).focus();
        expect(document.activeElement).toBe(badge);
        expect(
          document
            .querySelector(".worktree-review time")
            ?.getAttribute("datetime"),
        ).toBe(mergedStatus.refreshedAt);
        if (lifecycle) {
          await act(async () => poll());
          expect(reviews).toBe(1);
        }
        const refresh = lifecycle
          ? document.querySelector<HTMLButtonElement>(
              '[aria-label="Refresh lifecycle status"]',
            )!
          : document.querySelector<HTMLButtonElement>(
              ".modal-head button.ghost",
            )!;
        delayInventory = true;
        await act(async () => refresh.click());
        expect(reviews).toBe(1);
        expect(document.body.textContent).not.toContain("PR #1: Merged");
        await act(async () =>
          finishInventory({
            ...reviewList,
            worktrees: [reviewList.worktrees[0]],
          }),
        );
        expect(reviews).toBe(2);
        // A rejected refresh keeps the last success, marked as last known.
        expect(document.body.textContent).toContain(
          "PR #1: Merged (last known)",
        );
        expect(document.body.textContent).toContain("Refresh failed at");
        expect(
          document
            .querySelector(".worktree-review-detail > time")
            ?.getAttribute("datetime"),
        ).toBe(mergedStatus.refreshedAt);
        expect(
          document.querySelector(".worktree-review-badge[data-stale]"),
        ).not.toBeNull();
        failInventory = true;
        await act(async () => refresh.click());
        expect(reviews).toBe(2);
        expect(document.body.textContent).toContain("Cannot load inventory");
        expect(document.body.textContent).not.toContain(
          "Loading repository lifecycle...",
        );
        expect(refresh.disabled).toBe(false);
      } finally {
        await act(async () => root!.unmount());
        root = null;
        interval.mockRestore();
        call.mockRestore();
      }
    });
  }

  test("open worktree dialog clears merged badges immediately when its checkout changes branch", async () => {
    const previousState = store.get();
    const workspace: Workspace = {
      workspace_id: "workspace",
      number: 1,
      label: "Repo",
      focused: true,
      pane_count: 0,
      tab_count: 0,
      agent_status: "unknown",
      worktree: {
        repo_key: "repo",
        repo_name: "Repo",
        repo_root: "/repo",
        checkout_path: "/repo/topic-0",
        is_linked_worktree: true,
        git_status: {
          branch: "topic-0",
          ahead: 0,
          behind: 0,
          staged: 0,
          unstaged: 0,
          untracked: 0,
          conflicted: 0,
          dirty: false,
        },
      },
    };
    const branches: unknown[] = [];
    let finishInventory!: (list: WorktreeList) => void;
    const call = spyOn(client, "call").mockImplementation(
      async (method, params) => {
        if (method === "worktree.list") {
          if (!branches.length)
            return { ...reviewList, worktrees: [reviewList.worktrees[0]] };
          return new Promise((resolve) => {
            finishInventory = resolve;
          });
        }
        expect(method).toBe("git.pull_request");
        branches.push(params?.branch);
        return params?.branch === "topic-0"
          ? mergedStatus
          : {
              ...mergedStatus,
              branch: params?.branch,
              state: params?.branch ? "ready" : "detached",
              request: params?.branch
                ? { ...mergedStatus.request!, state: "open" }
                : undefined,
            };
      },
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = () =>
      root!.render(
        h(WorktreeOpenDialog, {
          open: true,
          workspaceId: "workspace",
          onClose: () => {},
        }),
      );
    try {
      await act(async () => {
        __storeTesting.replaceState({
          ...previousState,
          workspaces: [workspace],
        });
        render();
      });
      expect(container.textContent).toContain("PR #1: Merged");
      for (const branch of ["new-topic", undefined]) {
        await act(async () => {
          __storeTesting.replaceState({
            ...store.get(),
            workspaces: [
              {
                ...workspace,
                worktree: {
                  ...workspace.worktree!,
                  git_status: { ...workspace.worktree!.git_status!, branch },
                },
              },
            ],
          });
          render();
        });
        expect(container.textContent).not.toContain("PR #1: Merged");
        expect(container.textContent).not.toContain("PR #1: Open");
        expect(container.textContent).toContain("Loading worktrees...");
        await act(async () =>
          finishInventory({
            ...reviewList,
            worktrees: [
              { ...reviewList.worktrees[0], branch, is_detached: !branch },
            ],
          }),
        );
        expect(branches[branches.length - 1]).toBe(branch);
        expect(container.textContent).toContain(
          branch ? "PR #1: Open" : "PR: Detached HEAD",
        );
      }
      expect(branches).toEqual(["topic-0", "new-topic", undefined]);
    } finally {
      await act(async () => root!.unmount());
      root = null;
      __storeTesting.replaceState(previousState);
      call.mockRestore();
    }
  });

  test("first workspace creation stays pending across an early topology refresh", async () => {
    const previousState = store.get();
    const suggestion = spyOn(
      luckyNames,
      "luckyWorkspaceName",
    ).mockResolvedValue("calm-otter");
    let finish!: (result: unknown) => void;
    const create = spyOn(store, "createWorkspace").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = () => root!.render(h(WorkspaceTree));
    try {
      __storeTesting.replaceState({
        ...previousState,
        status: "connected",
        navigationMode: "shared",
        workspaces: [],
        panes: [],
        tabs: [],
      });
      await act(async () => render());
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[title="New workspace"]')!
          .click(),
      );
      const form = container.querySelector("form")!;
      const submit = () =>
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      await act(async () => submit());
      expect(
        form.querySelector<HTMLButtonElement>('button[type="submit"]')!
          .disabled,
      ).toBe(true);

      __storeTesting.replaceState({
        ...store.get(),
        workspaces: [
          {
            workspace_id: "first",
            number: 1,
            label: "First",
            focused: true,
            pane_count: 0,
            tab_count: 0,
            agent_status: "unknown",
          },
        ],
      });
      await act(async () => render());
      expect(container.querySelector("form")).toBe(form);
      expect(
        form.querySelector<HTMLButtonElement>('button[type="submit"]')!
          .disabled,
      ).toBe(true);
      await act(async () => submit());
      expect(create).toHaveBeenCalledTimes(1);
      await act(async () => finish({ type: "workspace_created" }));
      expect(
        container.querySelector('[aria-label="Create workspace"]'),
      ).toBeNull();
    } finally {
      suggestion.mockRestore();
      create.mockRestore();
      await act(async () => root!.unmount());
      root = null;
      __storeTesting.replaceState(previousState);
    }
  });

  for (const [directory, label] of [
    ["/parent/project\\", "project\\/"],
    ["C:\\Projects\\Example", "Example/"],
    ["C:\\", "C:/"],
  ]) {
    test(`selecting ${directory} preserves the suggested directory`, async () => {
      const pathCall = spyOn(client, "call").mockImplementation(
        async (_method, params) => ({
          path: params?.path === "/parent" ? "/parent" : directory,
          error: null,
          directories: params?.path === "/parent" ? [directory] : [],
        }),
      );
      const create = spyOn(store, "createWorkspace").mockResolvedValue({
        type: "workspace_created",
      });
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      jest.useFakeTimers();
      try {
        await act(async () =>
          root!.render(
            h(CreateWorkspaceDialog, {
              open: true,
              initialName: "Path test",
              initialCwd: "/parent",
              onClose: () => {},
            }),
          ),
        );
        await act(async () => {
          jest.advanceTimersByTime(200);
        });
        const suggestion = container.querySelector<HTMLButtonElement>(
          '[aria-label="Directory suggestions"] button',
        )!;
        expect(suggestion.textContent).toBe(label);
        await act(async () => suggestion.click());
        expect(
          container.querySelectorAll<HTMLInputElement>("input")[1].value,
        ).toBe(`${directory}/`);
        await act(async () => {
          jest.advanceTimersByTime(200);
        });
        expect(pathCall).toHaveBeenLastCalledWith("workspace.path", {
          path: `${directory}/`,
        });
        await act(async () =>
          container
            .querySelector("form")!
            .dispatchEvent(
              new Event("submit", { bubbles: true, cancelable: true }),
            ),
        );
        expect(create).toHaveBeenLastCalledWith("Path test", directory);
      } finally {
        jest.useRealTimers();
        pathCall.mockRestore();
        create.mockRestore();
      }
    });
  }

  test("workspace paths show expansion, navigate suggestions and keep failed creation open", async () => {
    const calls: string[] = [];
    let fail = true;
    const pathCall = spyOn(client, "call").mockImplementation(
      async (method, params) => {
        expect(method).toBe("workspace.path");
        calls.push(String(params?.path));
        if (params?.path === "~/missing")
          return {
            path: "/home/test/missing",
            error: "Directory does not exist.",
            directories: [],
          };
        if (params?.path === "/home/test/project/")
          return { path: "/home/test/project", error: null, directories: [] };
        return {
          path: "/home/test",
          error: null,
          directories: ["/home/test/project"],
        };
      },
    );
    const create = spyOn(store, "createWorkspace").mockImplementation(
      async () => (fail ? undefined : { type: "workspace_created" }),
    );
    let closed = 0;
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = (initialCwd: string) =>
      root!.render(
        h(CreateWorkspaceDialog, {
          open: true,
          initialName: "Test",
          initialCwd,
          onClose: () => {
            closed += 1;
          },
        }),
      );
    jest.useFakeTimers();
    try {
      await act(async () => render("~/missing"));
      const submit = () =>
        container
          .querySelector("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
      expect(
        container.querySelector<HTMLButtonElement>('button[type="submit"]')!
          .disabled,
      ).toBe(true);
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      expect(container.textContent).toContain("Directory does not exist.");
      await act(async () => submit());
      expect(create).not.toHaveBeenCalled();
      expect(closed).toBe(0);

      await act(async () => render("~/"));
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      expect(container.textContent).toContain("/home/test");
      const suggestion = container.querySelector<HTMLButtonElement>(
        '[aria-label="Directory suggestions"] button',
      )!;
      await act(async () => suggestion.click());
      expect(
        container.querySelectorAll<HTMLInputElement>("input")[1].value,
      ).toBe("/home/test/project/");
      expect(document.activeElement).toBe(
        container.querySelectorAll("input")[1],
      );
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      await act(async () => submit());
      expect(create).toHaveBeenLastCalledWith("Test", "/home/test/project");
      expect(closed).toBe(0);
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      fail = false;
      await act(async () => submit());
      expect(closed).toBe(1);
      expect(calls).toEqual(["~/missing", "~/", "/home/test/project/"]);
    } finally {
      jest.useRealTimers();
      pathCall.mockRestore();
      create.mockRestore();
    }
  });

  test("workspace path checks discard replies for an older input", async () => {
    let resolveOld!: (value: unknown) => void;
    const pathCall = spyOn(client, "call").mockImplementation(
      async (_method, params) => {
        if (params?.path === "~/old")
          return new Promise((resolve) => {
            resolveOld = resolve;
          });
        return { path: "/home/test/new", error: null, directories: [] };
      },
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = (initialCwd: string) =>
      root!.render(
        h(CreateWorkspaceDialog, { open: true, initialCwd, onClose: () => {} }),
      );
    jest.useFakeTimers();
    try {
      await act(async () => render("~/old"));
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      await act(async () => render("~/new"));
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      await act(async () =>
        resolveOld({
          path: "/home/test/old",
          error: "Old error",
          directories: ["/home/test/old/child"],
        }),
      );
      expect(container.textContent).toContain("/home/test/new");
      expect(container.textContent).not.toContain("Old error");
      expect(container.textContent).not.toContain("old/child");
    } finally {
      jest.useRealTimers();
      pathCall.mockRestore();
    }
  });

  for (const dialog of dialogs) {
    test(`${dialog.name} keeps committed keyboard callbacks and cleans up focus/listeners`, async () => {
      const container = document.createElement("div");
      const outside = document.createElement("button");
      document.body.append(container, outside);
      root = createRoot(container);
      const calls: string[] = [];
      const callbacks = (version: string): Callbacks => ({
        open: true,
        onClose: () => calls.push(`${version}:close`),
        onConfirm: () => calls.push(`${version}:confirm`),
      });
      const never = new Promise<never>(() => {});
      function Suspend({ blocked }: { blocked: boolean }) {
        if (blocked) throw never;
        return null;
      }
      const render = (props: Callbacks, blocked = false) =>
        root!.render(
          h(
            Suspense,
            { fallback: h("p", null, "Pending") },
            h(Fragment, null, dialog.render(props), h(Suspend, { blocked })),
          ),
        );
      const key = (target: Element, value: string) =>
        target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: value,
            bubbles: true,
            cancelable: true,
          }),
        );
      const initialCalls = listCalls;
      await act(async () => render(callbacks("old")));
      await browser.happyDOM.whenAsyncComplete();
      const focused = container.querySelector<HTMLElement>(dialog.focus)!;
      expect(document.activeElement === focused).toBe(true);
      outside.focus();
      await act(async () => render(callbacks("current")));
      expect(document.activeElement === outside).toBe(true);

      // A transition renders new callbacks but does not commit its suspended
      // tree. The original DOM and native listener must keep committed props.
      await act(async () => {
        startTransition(() => render(callbacks("uncommitted"), true));
      });
      expect(container.textContent).not.toContain("Pending");
      await act(async () => key(outside, "Escape"));
      expect(calls).toEqual(["current:close"]);
      focused.focus();
      if (dialog.enter) {
        await act(async () => key(focused, "Enter"));
        expect(calls).toEqual(
          dialog.enter === "confirm"
            ? ["current:close", "current:confirm", "current:close"]
            : ["current:close", "current:close"],
        );
        const button = container.querySelector<HTMLButtonElement>(
          ".modal-actions button",
        )!;
        const beforeNativeEnter = calls.length;
        button.focus();
        await act(async () => key(button, "Enter"));
        expect(calls).toHaveLength(beforeNativeEnter);
      }
      const buttons = container.querySelectorAll<HTMLButtonElement>(
        ".modal-actions button",
      );
      await act(async () => buttons[0].click());
      expect(calls[calls.length - 1]).toBe("current:close");
      if (dialog.enter === "confirm") {
        await act(async () => buttons[1].click());
        expect(calls.slice(-2)).toEqual(["current:confirm", "current:close"]);
      }
      if (dialog.name === "open worktree") {
        expect(listCalls - initialCalls).toBe(1);
      }

      await act(async () => render({ ...callbacks("closed"), open: false }));
      expect(container.childElementCount).toBe(0);
      const beforeClose = calls.length;
      await act(async () => key(outside, "Escape"));
      expect(calls).toHaveLength(beforeClose);
      await act(async () => render(callbacks("reopened")));
      await act(async () => root!.unmount());
      root = null;
      outside.focus();
      await browser.happyDOM.whenAsyncComplete();
      expect(document.activeElement === outside).toBe(true);
      await act(async () => key(outside, "Escape"));
      expect(calls).toHaveLength(beforeClose);
    });
  }
}
