import { expect, test } from "bun:test";
import { Window } from "happy-dom";

// Store initialization registers singleton listeners; keep them out of other tests.
if (process.env.ROAMGATE_STORE_AUTH_TEST !== "1") {
  test("auth-loss draft cleanup in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_STORE_AUTH_TEST: "1" },
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
  });
} else {
  test.each(["startup", "update-restart"])(
    "%s clears live and saved drafts before a 401 redirect",
    async (entry) => {
      const browser = new Window({ url: "http://localhost" });
      const navigated = Promise.withResolvers<string>();
      let savedAtRedirect: (string | null)[] = [];
      let liveAtRedirect: string | undefined;
      const events = Object.assign(new EventTarget(), {
        location: {
          origin: "http://localhost",
          replace(url: string) {
            liveAtRedirect = drafts.readTerminalComposerDraft(key);
            savedAtRedirect = [
              localStorage.getItem(storageKey),
              sessionStorage.getItem(storageKey),
            ];
            navigated.resolve(url);
          },
        },
      });
      for (const [name, value] of Object.entries({
        window: events,
        localStorage: browser.localStorage,
        sessionStorage: browser.sessionStorage,
        fetch: async () => new Response(null, { status: 401 }),
      }))
        Object.defineProperty(globalThis, name, { configurable: true, value });
      const { store, __storeTesting } = await import("./store");
      const drafts = await import("./terminalComposer");
      const generation = entry === "startup" ? 1 : 2;
      const host = {
        id: "auth-test",
        label: "Test",
        source: "test",
        is_default: true,
        state: "ready" as const,
        generation,
      };
      const pane = { pane_id: "pane", terminal_id: "terminal" };
      drafts.activateTerminalComposerDraftScope(
        host.id,
        generation,
        [pane],
        host,
      );
      const key = drafts.terminalComposerDraftKey(
        host.id,
        generation,
        pane.pane_id,
        pane.terminal_id,
      );
      drafts.writeTerminalComposerDraft(key, "previous user's secret");
      localStorage.setItem("roamgate:theme", "dark");
      const storageKey = Array.from(
        { length: localStorage.length },
        (_, i) => localStorage.key(i)!,
      ).find((key) => key.startsWith("roamgate:terminalComposerDraft:"))!;
      expect(localStorage.getItem(storageKey)).toBe("previous user's secret");
      if (entry === "startup") store.init();
      else await __storeTesting.reloadWhenUpdatedServerIsReady("test-version");
      expect(await navigated.promise).toBe("http://localhost/login");
      expect(liveAtRedirect).toBe("");
      expect(savedAtRedirect).toEqual(["", ""]);
      expect(drafts.readTerminalComposerDraft(key)).toBe("");
      expect(localStorage.getItem(storageKey)).toBe("");
      expect(sessionStorage.getItem(storageKey)).toBe("");
      expect(
        localStorage.getItem("roamgate:terminalComposerLogout"),
      ).toBeTruthy();
      expect(localStorage.getItem("roamgate:theme")).toBe("dark");
      await browser.happyDOM.close();
    },
  );
}
