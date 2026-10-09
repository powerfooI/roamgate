import { describe, expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { type HTMLButtonElement, Window } from "happy-dom";
import { LOGIN_HTML, renderLoginPage } from "./login-page";

function loginPage(pinEnabled = true) {
  const window = new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  });
  const document = window.document;
  document.write(renderLoginPage(pinEnabled));
  const calls: { url: string; init: RequestInit }[] = [];
  const responses: (() => Promise<Response>)[] = [];
  const location = {
    hash: "#roamgate-task=example-target",
    replacements: [] as string[],
    replace(value: string) {
      this.replacements.push(value);
    },
  };
  const context = createContext({
    document,
    location,
    fetch: (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error("Unexpected login request");
      return next();
    },
  });
  const scripts = document.querySelectorAll("script:not([src])");
  expect(scripts.length).toBe(1);
  runInContext(scripts[0]!.textContent, context);
  return {
    document,
    location,
    calls,
    responses,
    input: document.querySelector("input")!,
    submitButton: document.querySelector<HTMLButtonElement>("#btn")!,
    reveal: document.querySelector<HTMLButtonElement>("#reveal")!,
    method: document.querySelector<HTMLButtonElement>("#method"),
    error: document.querySelector("#err")!,
    label: document.querySelector("label")!,
    submit: (): Promise<void> =>
      runInContext("form.onsubmit({preventDefault(){}})", context),
    forceSwitch: () => runInContext("method.onclick()", context),
    forceReveal: () => runInContext("reveal.onclick()", context),
  };
}

function respond(page: ReturnType<typeof loginPage>, status: number) {
  page.responses.push(async () => new Response(null, { status }));
}

describe("optional PIN login page", () => {
  test("disabled PIN preserves password-only markup, validation and endpoint", async () => {
    expect(renderLoginPage(false)).toBe(LOGIN_HTML);
    expect(LOGIN_HTML).not.toContain("/api/login/pin");
    const page = loginPage(false);
    expect(page.method).toBeNull();
    expect(page.label.outerHTML).toBe(
      '<label for="pw">Password or token</label>',
    );
    expect(page.input.type).toBe("password");
    expect(page.input.name).toBe("password");
    expect(page.input.required).toBe(true);
    for (const name of ["inputmode", "pattern", "minlength", "maxlength"]) {
      expect(page.input.hasAttribute(name)).toBe(false);
    }
    page.input.value = "password or token, longer than twelve";
    respond(page, 200);
    await page.submit();
    expect(page.calls).toEqual([
      {
        url: "/api/login",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: page.input.value }),
        },
      },
    ]);
  });

  test("enabled PIN starts masked with numeric keyboard and accessible constraints", () => {
    const page = loginPage();
    expect(page.label.textContent).toBe("PIN");
    expect(page.label.getAttribute("for")).toBe(page.input.id);
    expect(page.input.name).toBe("pin");
    expect(page.input.type).toBe("password");
    expect(page.input.getAttribute("inputmode")).toBe("numeric");
    expect(page.input.pattern).toBe("[0-9]{6,12}");
    expect(page.input.minLength).toBe(6);
    expect(page.input.maxLength).toBe(12);
    expect(page.input.required).toBe(true);
    expect(page.input.autocomplete).toBe("current-password");
    expect(page.input.value).toBe("");
    expect(page.input.getAttribute("aria-describedby")).toBe("err");
    expect(page.error.getAttribute("role")).toBe("alert");
    expect(page.method!.type).toBe("button");
    expect(page.method!.getAttribute("aria-controls")).toBe(page.input.id);
    expect(page.method!.textContent).toBe("Use password or token instead");
    expect(page.reveal.getAttribute("aria-label")).toBe("Show PIN");
    page.reveal.click();
    expect(page.input.type).toBe("text");
    expect(page.input.getAttribute("inputmode")).toBe("numeric");
    expect(page.reveal.getAttribute("aria-label")).toBe("Hide PIN");
    expect(page.reveal.getAttribute("aria-pressed")).toBe("true");
  });

  test.each([
    "",
    "12345",
    "1234567890123",
    "12345a",
    "123.45",
    "123 456",
    " 123456",
    "+123456",
    "\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16",
    "\u0661\u0662\u0663\u0664\u0665\u0666",
  ])("rejects invalid PIN %j before fetch", async (pin) => {
    const page = loginPage();
    page.input.value = pin;
    await page.submit();
    expect(page.calls).toHaveLength(0);
    expect(page.error.textContent).toBe("Enter a PIN with 6-12 digits (0-9).");
    expect(page.input.getAttribute("aria-invalid")).toBe("true");
    expect(page.document.activeElement).toBe(page.input);
    expect(page.submitButton.disabled).toBe(false);
    expect(page.method!.disabled).toBe(false);
  });

  test.each(["000001", "123456789012"])(
    "posts PIN %s exactly and preserves launch fragments",
    async (pin) => {
      const page = loginPage();
      page.input.value = pin;
      respond(page, 200);
      await page.submit();
      expect(page.calls).toEqual([
        {
          url: "/api/login/pin",
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pin }),
          },
        },
      ]);
      expect(page.location.replacements).toEqual([
        "/#roamgate-task=example-target",
      ]);
      await page.submit();
      page.forceSwitch();
      expect(page.calls).toHaveLength(1);
      expect(page.input.name).toBe("pin");
      expect(page.method!.disabled).toBe(true);
    },
  );

  test("switching repeatedly clears secrets, errors and reveal state and restores each mode", async () => {
    const page = loginPage();
    page.input.value = "123";
    await page.submit();
    page.reveal.click();
    page.method!.click();
    expect(page.input.value).toBe("");
    expect(page.input.type).toBe("password");
    expect(page.input.name).toBe("password");
    expect(page.input.placeholder).toBe("Password or token");
    expect(page.input.getAttribute("inputmode")).toBe("text");
    expect(page.input.required).toBe(true);
    for (const name of ["pattern", "minlength", "maxlength", "aria-invalid"]) {
      expect(page.input.hasAttribute(name)).toBe(false);
    }
    expect(page.error.textContent).toBe("");
    expect(page.reveal.textContent).toBe("Show");
    expect(page.reveal.getAttribute("aria-label")).toBe("Show password");
    expect(page.reveal.getAttribute("aria-pressed")).toBe("false");
    expect(page.label.textContent).toBe("Password or token");
    expect(page.method!.textContent).toBe("Use PIN instead");
    expect(page.document.activeElement).toBe(page.input);
    page.input.value = "a long arbitrary password with spaces & symbols!";
    page.reveal.click();
    respond(page, 401);
    await page.submit();
    expect(page.error.textContent).toBe("Wrong password or token. Try again.");
    page.input.value = "new recovery password";
    page.reveal.click();
    page.method!.click();
    expect(page.input.value).toBe("");
    expect(page.input.type).toBe("password");
    expect(page.input.name).toBe("pin");
    expect(page.input.pattern).toBe("[0-9]{6,12}");
    expect(page.input.minLength).toBe(6);
    expect(page.input.maxLength).toBe(12);
    expect(page.input.getAttribute("inputmode")).toBe("numeric");
    expect(page.error.textContent).toBe("");
    expect(page.input.hasAttribute("aria-invalid")).toBe(false);
    expect(page.reveal.getAttribute("aria-label")).toBe("Show PIN");
    expect(page.reveal.getAttribute("aria-pressed")).toBe("false");
    expect(page.label.textContent).toBe("PIN");
  });

  test.each(["credentials", "throttle", "server", "network"])(
    "recovers from %s failures, blocks duplicate submissions and offers a clean recovery switch",
    async (failure) => {
      const page = loginPage();
      const pending = Promise.withResolvers<Response>();
      page.responses.push(() => pending.promise);
      page.input.value = "123456";
      const submission = page.submit();
      expect(page.submitButton.disabled).toBe(true);
      expect(page.submitButton.textContent).toBe("Logging in...");
      expect(page.method!.disabled).toBe(true);
      expect(page.reveal.disabled).toBe(true);
      expect(page.input.readOnly).toBe(true);
      await page.submit();
      page.method!.click();
      page.forceSwitch();
      page.forceReveal();
      expect(page.input.type).toBe("password");
      expect(page.input.name).toBe("pin");
      expect(page.calls).toHaveLength(1);
      if (failure === "network") pending.reject(new Error("offline"));
      else {
        pending.resolve(
          new Response(null, {
            status:
              failure === "credentials"
                ? 401
                : failure === "throttle"
                  ? 429
                  : 503,
            headers: { "retry-after": "300" },
          }),
        );
      }
      await submission;
      expect(page.submitButton.disabled).toBe(false);
      expect(page.submitButton.textContent).toBe("Log in");
      expect(page.method!.disabled).toBe(false);
      expect(page.reveal.disabled).toBe(false);
      expect(page.input.readOnly).toBe(false);
      expect(page.location.replacements).toEqual([]);
      expect(page.error.textContent).toContain(
        failure === "credentials"
          ? "Wrong PIN"
          : failure === "throttle"
            ? "Try again in 300 seconds"
            : failure === "server"
              ? "Unable to log in"
              : "Cannot reach the server",
      );
      expect(page.input.value).toBe(failure === "credentials" ? "" : "123456");
      if (failure === "credentials") {
        expect(page.input.getAttribute("aria-invalid")).toBe("true");
        expect(page.document.activeElement).toBe(page.input);
      }
      if (failure === "throttle" || failure === "credentials") {
        expect(page.error.textContent).toContain("use your password or token");
      }
      page.method!.click();
      expect(page.error.textContent).toBe("");
      expect(page.input.value).toBe("");
      expect(page.input.hasAttribute("aria-invalid")).toBe(false);
      const password =
        " exact recovery token: with spaces <&> " + "a".repeat(100);
      page.input.value = password;
      expect(page.input.checkValidity()).toBe(true);
      respond(page, 200);
      await page.submit();
      expect(page.calls[1]).toEqual({
        url: "/api/login",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password }),
        },
      });
      expect(page.location.replacements).toEqual([
        "/#roamgate-task=example-target",
      ]);
    },
  );

  test("recovery mode still requires a nonempty password or token", async () => {
    const page = loginPage();
    page.method!.click();
    await page.submit();
    expect(page.calls).toHaveLength(0);
    expect(page.error.textContent).toBe("Enter your password or token.");
    expect(page.input.getAttribute("aria-invalid")).toBe("true");
    expect(page.document.activeElement).toBe(page.input);
  });

  test.each(["server", "network"])(
    "a %s failure permits a same-mode retry with no stale error",
    async (failure) => {
      const page = loginPage();
      page.input.value = "123456";
      page.responses.push(async () => {
        if (failure === "network") throw new Error("offline");
        return new Response(null, { status: 500 });
      });
      await page.submit();
      expect(page.error.textContent).not.toBe("");
      const pending = Promise.withResolvers<Response>();
      page.responses.push(() => pending.promise);
      const retry = page.submit();
      expect(page.error.textContent).toBe("");
      expect(page.method!.disabled).toBe(true);
      await page.submit();
      expect(page.calls).toHaveLength(2);
      pending.resolve(new Response(null, { status: 200 }));
      await retry;
      expect(page.location.replacements).toHaveLength(1);
    },
  );

  test.each(["", "nonsense", "-100", "Infinity", "0"])(
    "uses a safe Retry-After fallback for %j",
    async (retryAfter) => {
      const page = loginPage();
      page.input.value = "123456";
      page.responses.push(
        async () =>
          new Response(null, {
            status: 429,
            headers: { "retry-after": retryAfter },
          }),
      );
      await page.submit();
      expect(page.error.textContent).toContain("Try again in 60 seconds");
      expect(page.error.textContent).toContain("use your password or token");
    },
  );

  test("wrong PIN retry clears the error and can succeed without switching modes", async () => {
    const page = loginPage();
    page.input.value = "123456";
    page.reveal.click();
    respond(page, 401);
    await page.submit();
    expect(page.input.type).toBe("password");
    expect(page.input.value).toBe("");
    expect(page.reveal.getAttribute("aria-pressed")).toBe("false");
    page.input.value = "000000";
    respond(page, 200);
    await page.submit();
    expect(page.error.textContent).toBe("");
    expect(page.input.hasAttribute("aria-invalid")).toBe(false);
    expect(page.calls.map((call) => call.url)).toEqual([
      "/api/login/pin",
      "/api/login/pin",
    ]);
    expect(page.location.replacements).toHaveLength(1);
  });
});
