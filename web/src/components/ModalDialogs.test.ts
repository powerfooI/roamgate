import { afterAll, afterEach, expect, jest, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import type { ConnectionClient } from "../api";
import type { Workspace, WorktreeList } from "../types";
import type { PullRequestStatus } from "../../../shared/pullRequest";

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
  const { WorktreeOpenDialog } = await import("./WorktreeOpenDialog");
  const { WorktreeLifecycleDialog } = await import("./WorktreeLifecycleDialog");
  const { useWorktreePullRequests } = await import(
    "../useWorktreePullRequests"
  );
  const { bridge } = await import("../api");
  const { __storeTesting, store } = await import("../store");
  const { WorkspaceTree } = await import("./WorkspaceTree");
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

    // Explicit refresh clears even a previously merged result.
    const oldReplies = pending.splice(0);
    await act(async () => render(reviewList, 1));
    expect(container.textContent).toBe("{}");
    expect(calls).toBe(5);
    await act(async () => render(reviewList, 2));
    expect(calls).toBe(5);
    await act(async () =>
      oldReplies.slice(0, -1).forEach((resolve) => resolve(mergedStatus)),
    );
    expect(calls).toBe(5);
    await act(async () => oldReplies[oldReplies.length - 1](mergedStatus));
    expect(container.textContent).toBe("{}");
    expect(calls).toBe(9);

    const previousConnection = pending.splice(0);
    current = false;
    const nextClient = {
      ...reviewClient,
      connectionId: "other",
      generation: 2,
      isCurrent: () => true,
    };
    await act(async () => render(reviewList, 2, nextClient));
    await act(async () =>
      previousConnection.forEach((resolve) => resolve(mergedStatus)),
    );
    expect(container.textContent).toBe("{}");

    const previousRepo = pending.splice(0);
    const nextRepo = {
      ...reviewList,
      source: { ...reviewList.source, repo_key: "other-repo" },
    };
    await act(async () => render(nextRepo, 2, nextClient));
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
        expect(document.body.textContent).toContain("PR/MR: Unavailable");
        expect(document.body.textContent).not.toContain("PR #1: Merged");
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
