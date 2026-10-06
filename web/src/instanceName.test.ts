import { describe, expect, jest, mock, test } from "bun:test";
import { Window as BrowserWindow } from "happy-dom";
import type { InstanceSettings } from "../../shared/instanceName";
import {
  applyInstanceName,
  createInstanceNameClient,
  initializeInstanceName,
} from "./instanceName";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function settingsResponse(title_suffix: string) {
  return Response.json({ title_suffix });
}

function createClientHarness(target?: Document) {
  const requests: Array<ReturnType<typeof deferred<Response>>> = [];
  const fetcher = mock<
    (url: string, options: RequestInit) => Promise<Response>
  >(() => {
    const request = deferred<Response>();
    requests.push(request);
    return request.promise;
  });
  const apply = mock((settings: InstanceSettings) => {
    if (target) applyInstanceName(settings, target);
    return settings;
  });
  const client = createInstanceNameClient(fetcher, apply);
  return { client, fetcher, apply, requests };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("instance name client", () => {
  test("loads uncached same-origin settings and applies the normalized response", async () => {
    const { client, fetcher, apply, requests } = createClientHarness();
    const loaded = client.load();

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("/api/instance-settings");
    expect(options).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(options?.body).toBeUndefined();
    expect(options?.signal?.aborted).toBe(false);
    expect(apply).not.toHaveBeenCalled();

    requests[0].resolve(settingsResponse("  Studio\t machine  "));
    await expect(loaded).resolves.toEqual({ title_suffix: "Studio machine" });
    expect(apply.mock.calls).toEqual([
      [
        {
          title_suffix: "Studio machine",
        },
      ],
    ]);
  });

  test("saves normalized text with the settings header and waits for confirmation", async () => {
    const { client, fetcher, apply, requests } = createClientHarness();
    const saved = client.save(" \t Studio\n machine  ");

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("/api/instance-settings");
    expect(options).toMatchObject({
      method: "PUT",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Roamgate-Settings": "1",
      },
      body: JSON.stringify({ title_suffix: "Studio machine" }),
    });
    expect(options?.signal?.aborted).toBe(false);
    expect(apply).not.toHaveBeenCalled();

    requests[0].resolve(settingsResponse("Confirmed"));
    await expect(saved).resolves.toEqual({ title_suffix: "Confirmed" });
    expect(apply.mock.calls).toEqual([[{ title_suffix: "Confirmed" }]]);
  });

  test("an empty normalized suffix resets the name", async () => {
    const { client, fetcher, apply, requests } = createClientHarness();
    const saved = client.save(" \n\t ");
    expect(fetcher.mock.calls[0][1]?.body).toBe('{"title_suffix":""}');
    requests[0].resolve(settingsResponse(""));
    await expect(saved).resolves.toEqual({ title_suffix: "" });
    expect(apply.mock.calls).toEqual([[{ title_suffix: "" }]]);
  });

  test.each(["x".repeat(33), "hidden\u0000name", "hidden\u202ename"])(
    "rejects invalid local suffix %j without a request or title update",
    (suffix) => {
      const { client, fetcher, apply } = createClientHarness();
      expect(() => client.save(suffix)).toThrow();
      expect(fetcher).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
    },
  );

  for (const method of ["load", "save"] as const) {
    describe(method, () => {
      const badResponses = [
        ["a missing object", () => Response.json(null)],
        ["an array", () => Response.json([])],
        ["a missing suffix", () => Response.json({})],
        ["a non-text suffix", () => Response.json({ title_suffix: 1 })],
        ["an oversized suffix", () => settingsResponse("x".repeat(33))],
        ["a control character", () => settingsResponse("bad\u0000name")],
        ["invalid JSON", () => new Response("<html>Sign in</html>")],
      ] as const;

      test.each(badResponses)(
        "does not apply settings from %s",
        async (_label, response) => {
          const { client, apply, requests } = createClientHarness();
          const outcome = client[method]("New name");
          requests[0].resolve(response());
          await expect(outcome).rejects.toThrow();
          expect(apply).not.toHaveBeenCalled();
        },
      );

      test("reports an HTTP JSON error without applying settings", async () => {
        const { client, apply, requests } = createClientHarness();
        const outcome = client[method]("New name");
        requests[0].resolve(
          Response.json({ error: "Sign in again" }, { status: 401 }),
        );
        await expect(outcome).rejects.toThrow("Sign in again");
        expect(apply).not.toHaveBeenCalled();
      });

      test("reports an HTTP fallback for a non-JSON error without applying settings", async () => {
        const { client, apply, requests } = createClientHarness();
        const outcome = client[method]("New name");
        requests[0].resolve(new Response("Unavailable", { status: 503 }));
        await expect(outcome).rejects.toThrow(
          `Unable to ${method} the instance name (HTTP 503).`,
        );
        expect(apply).not.toHaveBeenCalled();
      });

      test("does not apply settings when fetch rejects", async () => {
        const { client, apply, requests } = createClientHarness();
        const outcome = client[method]("New name");
        requests[0].reject(new Error("Offline"));
        await expect(outcome).rejects.toThrow("Offline");
        expect(apply).not.toHaveBeenCalled();
      });
    });
  }

  test("duplicate saves and loads share the pending mutation", async () => {
    const { client, fetcher, apply, requests } = createClientHarness();
    const first = client.save("Office");
    expect(client.save("Other name")).toBe(first);
    expect(client.load()).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    requests[0].resolve(settingsResponse("Office"));
    await expect(first).resolves.toEqual({ title_suffix: "Office" });
    expect(apply.mock.calls).toEqual([[{ title_suffix: "Office" }]]);

    const next = client.save("Home");
    expect(next).not.toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
    requests[1].resolve(settingsResponse("Home"));
    await expect(next).resolves.toEqual({ title_suffix: "Home" });
  });

  test("a failed save leaves the confirmed name intact and permits retry", async () => {
    const { client, fetcher, apply, requests } = createClientHarness();
    const loaded = client.load();
    requests[0].resolve(settingsResponse("Confirmed"));
    await loaded;

    const failed = client.save("Unconfirmed");
    requests[1].reject(new Error("Offline"));
    await expect(failed).rejects.toThrow("Offline");
    expect(apply.mock.calls).toEqual([[{ title_suffix: "Confirmed" }]]);

    const retry = client.save("Retried");
    expect(fetcher).toHaveBeenCalledTimes(3);
    requests[2].resolve(settingsResponse("Retried"));
    await expect(retry).resolves.toEqual({ title_suffix: "Retried" });
    expect(apply).toHaveBeenLastCalledWith({ title_suffix: "Retried" });
  });

  test("a GET settling after a successful save adopts the saved name", async () => {
    const { client, apply, requests } = createClientHarness();
    const loaded = client.load();
    const saved = client.save("Saved");
    requests[1].resolve(settingsResponse("Saved"));
    await saved;
    requests[0].resolve(settingsResponse("Old"));

    await expect(loaded).resolves.toEqual({ title_suffix: "Saved" });
    expect(apply.mock.calls).toEqual([[{ title_suffix: "Saved" }]]);
  });

  test("a superseded GET waits for an unfinished save instead of returning its old name", async () => {
    const { client, apply, requests } = createClientHarness();
    const loaded = client.load();
    const saved = client.save("Saved");
    let loadedSettled = false;
    void loaded.then(() => {
      loadedSettled = true;
    });
    requests[0].resolve(settingsResponse("Old"));
    await flushMicrotasks();
    expect(loadedSettled).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    requests[1].resolve(settingsResponse("Saved"));

    await expect(loaded).resolves.toEqual({ title_suffix: "Saved" });
    await saved;
    expect(apply.mock.calls).toEqual([[{ title_suffix: "Saved" }]]);
  });

  test.each(["success", "HTTP error", "network error", "malformed"] as const)(
    "the latest GET wins when an older GET finishes with %s",
    async (oldOutcome) => {
      const { client, apply, requests } = createClientHarness();
      const older = client.load();
      const newer = client.load();
      requests[1].resolve(settingsResponse("Newest"));
      await newer;
      if (oldOutcome === "network error") {
        requests[0].reject(new Error("Old network failure"));
      } else {
        requests[0].resolve(
          oldOutcome === "HTTP error"
            ? new Response("Old failure", { status: 500 })
            : oldOutcome === "malformed"
              ? Response.json({})
              : settingsResponse("Old"),
        );
      }

      await expect(older).resolves.toEqual({ title_suffix: "Newest" });
      expect(apply.mock.calls).toEqual([[{ title_suffix: "Newest" }]]);
    },
  );

  test("a superseded GET adopts the latest failure rather than applying stale settings", async () => {
    const { client, apply, requests } = createClientHarness();
    const older = client.load();
    const newer = client.load();
    const results = Promise.allSettled([older, newer]);
    const error = new Error("Current request failed");
    requests[1].reject(error);
    requests[0].resolve(settingsResponse("Stale"));

    expect(await results).toEqual([
      { status: "rejected", reason: error },
      { status: "rejected", reason: error },
    ]);
    expect(apply).not.toHaveBeenCalled();
  });

  test.each(["load", "save"] as const)(
    "%s works without AbortSignal.timeout and aborts at its deadline",
    async (method) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        AbortSignal,
        "timeout",
      );
      jest.useFakeTimers();
      try {
        Object.defineProperty(AbortSignal, "timeout", {
          value: undefined,
          writable: true,
          configurable: true,
        });
        const { client, fetcher, apply, requests } = createClientHarness();
        const outcome = client[method]("Office");
        const signal = fetcher.mock.calls[0][1].signal!;
        signal.addEventListener(
          "abort",
          () => requests[0].reject(signal.reason),
          {
            once: true,
          },
        );
        expect(signal.aborted).toBe(false);
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(9_999);
        expect(signal.aborted).toBe(false);
        jest.advanceTimersByTime(1);
        expect(signal.aborted).toBe(true);
        await expect(outcome).rejects.toThrow();
        expect(jest.getTimerCount()).toBe(0);
        expect(apply).not.toHaveBeenCalled();
      } finally {
        if (descriptor) {
          Object.defineProperty(AbortSignal, "timeout", descriptor);
        } else {
          Reflect.deleteProperty(AbortSignal, "timeout");
        }
        jest.useRealTimers();
      }
    },
  );

  test.each(["success", "HTTP error", "network error", "malformed"] as const)(
    "clears the request deadline after %s without aborting a settled request",
    async (outcome) => {
      jest.useFakeTimers();
      try {
        const { client, fetcher, requests } = createClientHarness();
        const loaded = client.load();
        const signal = fetcher.mock.calls[0][1].signal!;
        expect(jest.getTimerCount()).toBe(1);
        if (outcome === "network error") {
          requests[0].reject(new Error("Offline"));
        } else {
          requests[0].resolve(
            outcome === "HTTP error"
              ? new Response("Unavailable", { status: 503 })
              : outcome === "malformed"
                ? new Response("Not JSON")
                : settingsResponse("Office"),
          );
        }
        if (outcome === "success") {
          await expect(loaded).resolves.toEqual({ title_suffix: "Office" });
        } else {
          await expect(loaded).rejects.toThrow();
        }
        expect(jest.getTimerCount()).toBe(0);
        jest.advanceTimersByTime(10_000);
        expect(signal.aborted).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    },
  );
});

describe("instance name document metadata", () => {
  test("updates the title and both install-name meta tags as plain text, then clears the suffix", async () => {
    const browser = new BrowserWindow();
    try {
      const target = browser.document;
      target.head.innerHTML =
        '<title>Roamgate</title><meta name="apple-mobile-web-app-title" content="Roamgate"><meta name="application-name" content="Roamgate">';
      for (const suffix of [
        "Office",
        "</title><script>x</script>",
        '"><img src=x onerror=alert(1)>',
        "",
      ]) {
        applyInstanceName(
          { title_suffix: suffix },
          target as unknown as Document,
        );
        const expected = suffix ? `Roamgate \u00b7 ${suffix}` : "Roamgate";
        expect(target.title).toBe(expected);
        expect(target.querySelector("title")?.textContent).toBe(expected);
        for (const name of ["apple-mobile-web-app-title", "application-name"]) {
          expect(
            target
              .querySelector(`meta[name="${name}"]`)
              ?.getAttribute("content"),
          ).toBe(expected);
        }
        expect(target.head.children).toHaveLength(3);
        expect(target.querySelector("script, img")).toBeNull();
      }
    } finally {
      await browser.happyDOM.close();
    }
  });

  test("updates the title safely when optional name meta tags are absent", async () => {
    const browser = new BrowserWindow();
    try {
      applyInstanceName(
        { title_suffix: "Office" },
        browser.document as unknown as Document,
      );
      expect(browser.document.title).toBe("Roamgate \u00b7 Office");
    } finally {
      await browser.happyDOM.close();
    }
  });
});

function createManifestBrowser() {
  const browser = new BrowserWindow({ url: "https://roamgate.example/app/" });
  browser.document.head.innerHTML =
    '<title>Roamgate</title><link id="app-manifest" rel="manifest alternate" href="./manifest.webmanifest?channel=stable#install" crossorigin="use-credentials" type="application/manifest+json" data-instance="stable"><link rel="icon" href="/icon.png">';
  return browser;
}

describe("instance name manifest refresh", () => {
  test("a changed confirmed save reconnects one manifest link with every attribute and its exact URL preserved", async () => {
    const browser = createManifestBrowser();
    try {
      const target = browser.document;
      const original = target.querySelector('link[rel~="manifest"]')!;
      const nextSibling = original.nextElementSibling;
      const addedLinks: unknown[] = [];
      const removedLinks: unknown[] = [];
      const observer = new browser.MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.nodeName === "LINK") addedLinks.push(node);
          }
          for (const node of record.removedNodes) {
            if (node.nodeName === "LINK") removedLinks.push(node);
          }
        }
      });
      observer.observe(target.head, { childList: true });
      const { client, apply, requests } = createClientHarness(
        target as unknown as Document,
      );
      const saved = client.save("Office");
      expect(target.querySelector('link[rel~="manifest"]')).toBe(original);
      expect(original.isConnected).toBe(true);
      requests[0].resolve(settingsResponse("Office"));
      await saved;
      await browser.happyDOM.whenAsyncComplete();

      const reconnected = target.querySelector('link[rel~="manifest"]')!;
      expect(reconnected).not.toBe(original);
      expect(reconnected.isConnected).toBe(true);
      expect(original.isConnected).toBe(false);
      expect(reconnected.outerHTML).toBe(original.outerHTML);
      expect(reconnected.getAttribute("href")).toBe(
        "./manifest.webmanifest?channel=stable#install",
      );
      expect(reconnected.getAttribute("crossorigin")).toBe("use-credentials");
      expect(reconnected.getAttribute("data-instance")).toBe("stable");
      expect(reconnected.nextElementSibling).toBe(nextSibling);
      expect(target.querySelectorAll('link[rel~="manifest"]')).toHaveLength(1);
      expect(addedLinks).toEqual([reconnected]);
      expect(removedLinks).toEqual([original]);
      expect(apply.mock.calls).toEqual([[{ title_suffix: "Office" }]]);
      observer.disconnect();
    } finally {
      await browser.happyDOM.close();
    }
  });

  test("a repeated same-name refresh keeps the existing manifest link connected", async () => {
    const browser = createManifestBrowser();
    try {
      const target = browser.document;
      const { client, requests } = createClientHarness(
        target as unknown as Document,
      );
      const loaded = client.load();
      requests[0].resolve(settingsResponse("Office"));
      await loaded;
      const manifest = target.querySelector('link[rel~="manifest"]');
      const refreshed = client.load();
      requests[1].resolve(settingsResponse("Office"));
      await refreshed;

      expect(target.querySelector('link[rel~="manifest"]')).toBe(manifest);
      expect(manifest?.isConnected).toBe(true);
      expect(target.title).toBe("Roamgate \u00b7 Office");
    } finally {
      await browser.happyDOM.close();
    }
  });

  test("a failed save leaves the original manifest link and title intact", async () => {
    const browser = createManifestBrowser();
    try {
      const target = browser.document;
      const original = target.querySelector('link[rel~="manifest"]');
      const { client, apply, requests } = createClientHarness(
        target as unknown as Document,
      );
      const saved = client.save("Unconfirmed");
      requests[0].resolve(new Response("Unavailable", { status: 503 }));
      await expect(saved).rejects.toThrow("HTTP 503");

      expect(target.querySelector('link[rel~="manifest"]')).toBe(original);
      expect(original?.isConnected).toBe(true);
      expect(target.title).toBe("Roamgate");
      expect(apply).not.toHaveBeenCalled();
    } finally {
      await browser.happyDOM.close();
    }
  });

  test("a stale GET cannot revert the title or reconnect the manifest after a confirmed save", async () => {
    const browser = createManifestBrowser();
    try {
      const target = browser.document;
      const original = target.querySelector('link[rel~="manifest"]');
      const { client, apply, requests } = createClientHarness(
        target as unknown as Document,
      );
      const loaded = client.load();
      const saved = client.save("Saved");
      requests[1].resolve(settingsResponse("Saved"));
      await saved;
      const confirmed = target.querySelector('link[rel~="manifest"]');
      expect(confirmed).not.toBe(original);
      requests[0].resolve(settingsResponse("Stale"));
      await expect(loaded).resolves.toEqual({ title_suffix: "Saved" });

      expect(target.querySelector('link[rel~="manifest"]')).toBe(confirmed);
      expect(confirmed?.isConnected).toBe(true);
      expect(target.title).toBe("Roamgate \u00b7 Saved");
      expect(apply.mock.calls).toEqual([[{ title_suffix: "Saved" }]]);
    } finally {
      await browser.happyDOM.close();
    }
  });
});

function createRefreshHarness() {
  const requests: Array<ReturnType<typeof deferred<InstanceSettings>>> = [];
  const load = mock(() => {
    const request = deferred<InstanceSettings>();
    requests.push(request);
    return request.promise;
  });
  const client = {
    load,
    save: async (title_suffix: string) => ({ title_suffix }),
  };
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  const browser = Object.assign(new EventTarget(), { document });
  const cleanup = initializeInstanceName(client, browser as unknown as Window);
  return { load, requests, browser, document, cleanup };
}

describe("instance name refresh lifecycle", () => {
  test("loads at startup and coalesces focus and visible events while refreshing", async () => {
    const { load, requests, browser, document, cleanup } =
      createRefreshHarness();
    try {
      expect(load).toHaveBeenCalledTimes(1);
      browser.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      expect(load).toHaveBeenCalledTimes(1);
      requests[0].resolve({ title_suffix: "Startup" });
      await flushMicrotasks();

      browser.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      expect(load).toHaveBeenCalledTimes(2);
      requests[1].resolve({ title_suffix: "Focused" });
      await flushMicrotasks();

      document.visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      browser.dispatchEvent(new Event("focus"));
      expect(load).toHaveBeenCalledTimes(2);
      document.visibilityState = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      expect(load).toHaveBeenCalledTimes(3);
      requests[2].resolve({ title_suffix: "Visible" });
      await flushMicrotasks();
    } finally {
      cleanup();
    }
  });

  test("handles a rejected refresh and permits the next visible refresh", async () => {
    const { load, requests, browser, document, cleanup } =
      createRefreshHarness();
    try {
      requests[0].reject(new Error("Offline"));
      await flushMicrotasks();
      document.dispatchEvent(new Event("visibilitychange"));
      expect(load).toHaveBeenCalledTimes(2);
      requests[1].resolve({ title_suffix: "Recovered" });
      await flushMicrotasks();
      browser.dispatchEvent(new Event("focus"));
      expect(load).toHaveBeenCalledTimes(3);
      requests[2].resolve({ title_suffix: "Focused" });
      await flushMicrotasks();
    } finally {
      cleanup();
    }
  });

  test("cleanup removes both listeners even while a refresh is pending", async () => {
    const { load, requests, browser, document, cleanup } =
      createRefreshHarness();
    cleanup();
    cleanup();
    browser.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(load).toHaveBeenCalledTimes(1);
    requests[0].reject(new Error("Disconnected after cleanup"));
    await flushMicrotasks();
    browser.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(load).toHaveBeenCalledTimes(1);
  });
});
