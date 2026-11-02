import { expect, mock, test } from "bun:test";
if (process.env.ROAMGATE_AUTO_RENAME_DOM_TEST !== "1") {
  test("auto-rename settings across connection changes in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_AUTO_RENAME_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code) throw new Error(`${out}\n${error}`);
    expect(code).toBe(0);
  }, 15000);
} else {
  test("waits for readiness and ignores a previous connection's pending save", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost" });
    for (const key of [
      "window",
      "document",
      "navigator",
      "HTMLElement",
      "Element",
      "Node",
      "Event",
      "MouseEvent",
    ] as const)
      Object.defineProperty(globalThis, key, {
        value: key === "window" ? browser : browser[key],
        writable: true,
        configurable: true,
      });
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const requests: Array<{
      connection: string;
      method: string;
      params: unknown;
      resolve: (value: any) => void;
    }> = [];
    let ready = false;
    const first = {
      current: true,
      isCurrent: () => first.current,
      call: (method: string, params: unknown) =>
        new Promise((r) =>
          requests.push({ connection: "first", method, params, resolve: r }),
        ),
    };
    const second = {
      current: true,
      isCurrent: () => second.current,
      call: (method: string, params: unknown) =>
        new Promise((r) =>
          requests.push({ connection: "second", method, params, resolve: r }),
        ),
    };
    let client = first;
    mock.module("../useConnectionClient", () => ({
      useConnectionClient: () => client,
      useConnectionReady: () => ready,
    }));
    const { act, createElement: h } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { AgentAutoRenameSettings } = await import(
      "./AgentAutoRenameSettings"
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = () =>
      act(async () => root.render(h(AgentAutoRenameSettings)));
    const respond = (index: number, enabled: boolean) =>
      act(async () => requests[index].resolve({ enabled }));
    const toggle = () =>
      container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    try {
      await render();
      expect(requests).toHaveLength(0);
      expect(toggle().disabled).toBe(true);
      ready = true;
      await render();
      expect(requests[0].method).toBe("settings.agent_auto_rename.get");
      await respond(0, true);
      expect(toggle().getAttribute("aria-checked")).toBe("true");
      await act(async () => toggle().click());
      expect(requests[1].params).toEqual({ enabled: false });
      expect(toggle().disabled).toBe(true);
      first.current = false;
      client = second;
      await render();
      expect(requests[2].connection).toBe("second");
      await respond(2, false);
      expect(toggle().disabled).toBe(false);
      await act(async () => toggle().click());
      expect(requests[3].params).toEqual({ enabled: true });
      await respond(1, false);
      expect(toggle().disabled).toBe(true);
      expect(toggle().getAttribute("aria-checked")).toBe("false");
      await respond(3, true);
      expect(toggle().disabled).toBe(false);
      expect(toggle().getAttribute("aria-checked")).toBe("true");
    } finally {
      await act(async () => root.unmount());
      await browser.happyDOM.close();
    }
  });
}
