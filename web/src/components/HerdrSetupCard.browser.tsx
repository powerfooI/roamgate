import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { HerdrSetupCard } from "./HerdrSetupCard";
import "../styles/tokens.css";
import "../styles/base.css";

const params = new URLSearchParams(location.search);
const preview = params.has("preview");
const nativeFetch = window.fetch.bind(window);
let state = params.get("state") ?? "missing";
let allowed = true;
let statusFailure = false;
let posts = 0;
let confirmed = false;
let completeSetup: ((response: Response) => void) | undefined;
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === "/api/herdr/status") {
    return Promise.resolve(
      Response.json(
        { state, can_setup: allowed, verified_version: "0.9.0" },
        { status: statusFailure ? 503 : 200 },
      ),
    );
  }
  if (url === "/api/herdr/setup") {
    posts++;
    confirmed =
      init?.method === "POST" &&
      new Headers(init.headers).get("x-roamgate-herdr-setup") === "1";
    return new Promise<Response>((resolve) => {
      completeSetup = resolve;
      if (preview && params.get("outcome") === "error") {
        setTimeout(
          () =>
            resolve(
              Response.json(
                {
                  error:
                    "Simulated download failure. No installation was attempted.",
                },
                { status: 502 },
              ),
            ),
          1500,
        );
      }
    });
  }
  return nativeFetch(input, init);
}) as typeof fetch;

const host = document.createElement("main");
host.style.cssText =
  "height:100%;overflow:auto;display:flex;align-items:safe center;justify-content:center;padding:24px";
document.body.append(host);
const root = createRoot(host);
let key = 0;
function render(
  compact = false,
  fallback = "Original connection details",
  enabled = true,
) {
  flushSync(() =>
    root.render(
      <HerdrSetupCard key={key} compact={compact} enabled={enabled}>
        <span data-fallback>{fallback}</span>
      </HerdrSetupCard>,
    ),
  );
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const primary = () =>
  document.querySelector<HTMLButtonElement>(".herdr-setup-primary")!;
function click(button: HTMLButtonElement) {
  flushSync(() => button.click());
}
const failures: string[] = [];
function check(value: unknown, message: string) {
  if (!value) failures.push(message);
}

async function run() {
  render();
  await settle();
  check(
    document.querySelector("h2")?.textContent === "Your workspace starts here",
    "missing: onboarding title",
  );
  check(
    document.body.textContent?.includes("Verified 0.9.0"),
    "missing: verified version",
  );
  check(
    !document.querySelector("[data-fallback]"),
    "raw connection error must not compete with setup",
  );
  check(posts === 0, "mount must not install");
  click(primary());
  check(
    document.querySelector("h2")?.textContent === "Install Herdr 0.9.0?",
    "explicit confirmation title",
  );
  check(
    primary().textContent?.includes("Install & start"),
    "explicit confirmation action",
  );
  check(posts === 0, "review must not send POST");
  render(false, "A different connection error");
  check(
    primary().textContent?.includes("Install & start"),
    "fallback changes must not reset confirmation",
  );
  click(document.querySelector<HTMLButtonElement>(".herdr-setup-cancel")!);
  await settle();
  check(
    document.activeElement === primary(),
    "cancel restores review button focus",
  );
  click(primary());
  primary().dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await settle();
  check(
    primary().textContent?.includes("Set up Herdr"),
    "Escape cancels confirmation",
  );
  click(primary());
  click(primary());
  click(primary());
  await settle();
  check(posts === 1 && confirmed, "single confirmed POST with required header");
  check(primary().disabled, "busy action disabled");
  check(
    document.querySelector(".herdr-setup-progress[role=status]"),
    "busy state announced",
  );
  completeSetup?.(
    Response.json(
      { error: "Download unavailable. Please try again." },
      { status: 502 },
    ),
  );
  await settle();
  check(
    document
      .querySelector("[role=alert]")
      ?.textContent?.includes("Download unavailable"),
    "failure visible",
  );
  check(
    !primary().disabled && primary().textContent?.includes("Try again"),
    "failure can retry",
  );
  click(primary());
  await settle();
  check(posts === 2, "retry sends one request");
  completeSetup?.(Response.json({ ok: false }, { status: 200 }));
  await settle();
  check(
    document.querySelector("[role=alert]"),
    "malformed success is not accepted",
  );

  for (const width of [342, 296]) {
    for (const theme of ["dark", "light"]) {
      document.documentElement.dataset.theme = theme;
      key++;
      render(width === 296);
      host.style.width = `${width}px`;
      host.style.padding = "0";
      await settle();
      click(primary());
      const card = document.querySelector<HTMLElement>(".herdr-setup-card")!;
      check(
        card.scrollWidth <= card.clientWidth,
        `${width}/${theme}: card overflow`,
      );
      check(
        card.getBoundingClientRect().width <= width,
        `${width}/${theme}: width overflow`,
      );
      check(
        primary().getBoundingClientRect().height >= 42,
        `${width}/${theme}: touch target`,
      );
    }
  }
  host.style.width = "";
  state = "installed";
  key++;
  render();
  await settle();
  check(
    primary().textContent?.includes("Start Herdr"),
    "installed: start action",
  );
  check(
    !document.body.textContent?.includes("Verified 0.9.0"),
    "installed: don't mislabel existing binary version",
  );
  click(primary());
  check(
    primary().textContent?.includes("Start service"),
    "installed: explicit service confirmation",
  );

  for (const scenario of [
    "running",
    "blocked",
    "failed-status",
    "other-connection",
  ]) {
    state = scenario === "running" ? "running" : "missing";
    allowed = scenario !== "blocked";
    statusFailure = scenario === "failed-status";
    key++;
    render(
      false,
      "Original connection details",
      scenario !== "other-connection",
    );
    await settle();
    check(
      !document.querySelector(".herdr-setup-card"),
      `${scenario}: no setup action`,
    );
    check(
      document.querySelector("[data-fallback]"),
      `${scenario}: preserve fallback`,
    );
  }
}

if (preview) {
  document.documentElement.dataset.theme = params.get("theme") ?? "dark";
  render(params.has("compact"));
  await settle();
  if (params.has("confirm")) click(primary());
  if (params.has("busy")) {
    click(primary());
    click(primary());
  }
} else {
  try {
    await run();
  } catch (error) {
    failures.push(String(error));
  }
  await nativeFetch("/result", {
    method: "POST",
    body: JSON.stringify(failures),
  });
}
