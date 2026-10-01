import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

if (process.env.ROAMGATE_DOWNLOAD_DOM_TEST !== "1") {
  test("file downloads respect layout in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_DOWNLOAD_DOM_TEST: "1" },
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
  await registerDownloadTests();
}

async function registerDownloadTests() {
  const browser = new Window({ url: "http://localhost" });
  let standalone = false;
  const opened = mock(() => null);
  const shared = mock<Navigator["share"]>(async () => {});
  const canShare = mock(() => true);
  const fetched = mock(
    async () =>
      new Response("content", {
        headers: {
          "content-disposition": 'attachment; filename="server.txt"',
          "content-type": "text/plain",
        },
      }),
  );
  const anchored = mock((link: { href: string; download: string }) => link);
  browser.open = opened;
  browser.matchMedia = (() => ({
    matches: standalone,
  })) as unknown as typeof browser.matchMedia;
  browser.HTMLAnchorElement.prototype.click = function () {
    anchored({ href: this.href, download: this.download });
  };
  Object.defineProperties(browser.navigator, {
    canShare: { value: canShare },
    share: { value: shared },
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    Event: browser.Event,
    fetch: fetched,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const { downloadFileFromUrl, MAX_SHARE_FILE_BYTES } = await import(
    "./downloadFile"
  );
  const { initializeLayoutPreferences, updateLayoutPreferences } = await import(
    "./layoutPreferences"
  );
  initializeLayoutPreferences();
  const download = () =>
    downloadFileFromUrl({
      url: "http://localhost/api/file",
      filename: "fallback.txt",
    });
  beforeEach(() => {
    browser.location.href = "http://localhost";
    browser.happyDOM.setWindowSize({ width: 1024, height: 768 });
    standalone = false;
    Object.defineProperties(browser.navigator, {
      userAgent: {
        value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
        configurable: true,
      },
      maxTouchPoints: { value: 5, configurable: true },
    });
    opened.mockClear();
    shared.mockReset();
    shared.mockImplementation(async () => {});
    canShare.mockClear();
    fetched.mockReset();
    fetched.mockImplementation(
      async () =>
        new Response("content", {
          headers: {
            "content-disposition": 'attachment; filename="server.txt"',
            "content-type": "text/plain",
          },
        }),
    );
    anchored.mockClear();
    updateLayoutPreferences({ mode: "mobile", mobileBreakpoint: 768 });
  });
  afterAll(async () => {
    await browser.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  for (const installed of [false, true]) {
    for (const device of ["iOS", "macOS"] as const) {
      test(`desktop ${device}, standalone=${installed}: direct download even with file sharing`, async () => {
        standalone = installed;
        if (device === "macOS")
          Object.defineProperties(browser.navigator, {
            userAgent: {
              value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
            },
            maxTouchPoints: { value: 0 },
          });
        // The explicit desktop preference wins even on a narrow, touch device.
        browser.happyDOM.setWindowSize({ width: 390, height: 844 });
        updateLayoutPreferences({ mode: "desktop" });
        expect(await download()).toBe("anchored");
        expect(anchored).toHaveBeenCalledWith({
          href: "http://localhost/api/file",
          download: "fallback.txt",
        });
        expect(canShare).not.toHaveBeenCalled();
        expect(shared).not.toHaveBeenCalled();
        expect(fetched).not.toHaveBeenCalled();
        expect(opened).not.toHaveBeenCalled();
        expect(document.querySelector("a")).toBeNull();
      });
    }
  }

  test("URL override and auto layout use the existing configurable layout resolver", async () => {
    updateLayoutPreferences({ mode: "mobile" });
    browser.history.replaceState(null, "", "?layout=desktop");
    browser.dispatchEvent(new browser.Event("popstate"));
    expect(await download()).toBe("anchored");
    updateLayoutPreferences({ mode: "auto", mobileBreakpoint: 1200 });
    expect(await download()).toBe("shared");
    updateLayoutPreferences({ mobileBreakpoint: 600 });
    expect(await download()).toBe("anchored");
  });

  test("mobile iOS keeps native sharing and the server's filename", async () => {
    expect(await download()).toBe("shared");
    expect(fetched).toHaveBeenCalledWith("http://localhost/api/file", {
      credentials: "same-origin",
    });
    const data = shared.mock.calls[0][0]!;
    expect(data.title).toBe("server.txt");
    expect(data.files?.[0].name).toBe("server.txt");
    expect(await data.files?.[0].text()).toBe("content");
    expect(opened).not.toHaveBeenCalled();
    expect(anchored).not.toHaveBeenCalled();
  });

  test("dismissing the mobile share sheet does not download or open anything else", async () => {
    shared.mockRejectedValueOnce(new DOMException("Cancelled", "AbortError"));
    expect(await download()).toBe("shared");
    expect(opened).not.toHaveBeenCalled();
    expect(anchored).not.toHaveBeenCalled();
  });

  test("mobile share failure keeps the new-context fallback", async () => {
    shared.mockRejectedValueOnce(new Error("Share unavailable"));
    expect(await download()).toBe("opened");
    expect(opened).toHaveBeenCalledWith(
      "http://localhost/api/file",
      "_blank",
      "noopener",
    );
    expect(anchored).not.toHaveBeenCalled();
  });

  test("large mobile downloads bypass the share sheet", async () => {
    fetched.mockResolvedValueOnce(
      new Response("content", {
        headers: { "content-length": String(MAX_SHARE_FILE_BYTES + 1) },
      }),
    );
    expect(await download()).toBe("opened");
    expect(shared).not.toHaveBeenCalled();
    expect(opened).toHaveBeenCalledTimes(1);
  });

  test("mobile without Web Share and non-iOS mobile keep their existing fallbacks", async () => {
    canShare.mockReturnValueOnce(false);
    expect(await download()).toBe("opened");
    Object.defineProperty(browser.navigator, "userAgent", {
      value: "Mozilla/5.0 (Linux; Android 14)",
    });
    expect(await download()).toBe("anchored");
    standalone = true;
    expect(await download()).toBe("opened");
    expect(shared).not.toHaveBeenCalled();
  });
}
