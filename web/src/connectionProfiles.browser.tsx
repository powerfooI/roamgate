import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { bridge, type ConnectionSummary } from "./api";
import { ConnectionSwitcher } from "./components/ConnectionSwitcher";
import { __storeTesting, store } from "./store";
import "./styles/tokens.css";
import "./styles/base.css";

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (!condition) failures.push(message);
}
async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Connection UI timed out");
    await new Promise(requestAnimationFrame);
  }
}
function button(text: string, root: ParentNode = document) {
  const result = Array.from(root.querySelectorAll("button")).find(
    (element) => element.textContent?.trim() === text,
  );
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
function card(label: string) {
  const result = Array.from(document.querySelectorAll("section")).find(
    (element) => element.querySelector("strong")?.textContent === label,
  );
  if (!result) throw new Error(`Missing connection: ${label}`);
  return result;
}
const click = (element: HTMLElement) => flushSync(() => element.click());
let connections: ConnectionSummary[] = [];
const calls: string[] = [];
function publish() {
  flushSync(() =>
    __storeTesting.applyCatalog(
      connections,
      connections.find((item) => item.is_default)!.id,
    ),
  );
}
bridge.call = async (method, params) => {
  calls.push(method);
  if (method === "connections.set_default") {
    connections = connections.map((item) => ({
      ...item,
      is_default: item.id === params?.id,
    }));
  } else if (method === "connections.remove") {
    connections = connections.filter((item) => item.id !== params?.id);
  } else {
    throw new Error(`Unexpected call: ${method}`);
  }
  publish();
  return { ok: true };
};
store.refreshConnections = async () => true;

async function run() {
  document.documentElement.dataset.layout =
    innerWidth < 600 ? "mobile" : "desktop";
  __storeTesting.replaceState({
    ...store.get(),
    status: "connected",
    activeConnectionId: "local",
  });
  const host = document.createElement("div");
  host.id = "root";
  document.body.append(host);
  const root = createRoot(host);
  for (const theme of ["light", "dark"]) {
    document.documentElement.dataset.theme = theme;
    connections = [
      {
        id: "local",
        label: "Local",
        source: "local-profile",
        type: "local",
        auto_connect: true,
        control_socket_path: "/tmp/local.sock",
        client_socket_path: "/tmp/local-client.sock",
        is_default: true,
        state: "ready",
        generation: 1,
        read_only: false,
      },
      {
        id: "remote",
        label: "Failed SSH",
        source: "ssh-profile",
        type: "ssh",
        ssh_destination: "operator@example.test",
        auto_connect: true,
        remote_control_socket_path: "",
        remote_client_socket_path: "",
        is_default: false,
        state: "error",
        generation: 1,
        read_only: false,
        error: { message: "SSH connection failed" },
      },
      {
        id: "managed",
        label: "Managed",
        source: "legacy-config",
        type: "local",
        auto_connect: false,
        control_socket_path: "/tmp/managed.sock",
        client_socket_path: "/tmp/managed-client.sock",
        is_default: false,
        state: "error",
        generation: 1,
        read_only: true,
      },
    ];
    publish();
    flushSync(() => root.render(<ConnectionSwitcher />));
    click(
      host.querySelector<HTMLButtonElement>(".connection-switcher-trigger")!,
    );
    await waitFor(
      () => !!document.querySelector(".connection-switcher-manage"),
    );
    click(button("Manage connections"));
    await waitFor(() => !!document.querySelector(".connection-manager-modal"));
    check(
      !button("Remove", card("Failed SSH")).disabled,
      `${theme}: failed SSH cannot be removed`,
    );
    check(
      !Array.from(card("Managed").querySelectorAll("button")).some((item) =>
        ["Remove", "Edit", "Set default"].includes(
          item.textContent?.trim() ?? "",
        ),
      ),
      `${theme}: read-only profile exposes mutation controls`,
    );

    // A previously saved default uses the same recovery flow in every state.
    for (const state of ["error", "reconnecting", "ready"] as const) {
      connections = connections.map((item) => ({
        ...item,
        is_default: item.id === "remote",
        state: item.id === "remote" ? state : item.state,
      }));
      publish();
      const remove = button("Remove", card("Failed SSH"));
      const help = document.getElementById(
        remove.getAttribute("aria-describedby") ?? "",
      );
      check(remove.disabled, `${theme}/${state}: default removal is enabled`);
      check(
        help?.textContent?.includes("use Set default on another") === true,
        `${theme}/${state}: default removal has no visible recovery instructions`,
      );
    }
    const modal = document.querySelector<HTMLElement>(
      ".connection-manager-modal",
    )!;
    check(
      modal.scrollWidth <= modal.clientWidth,
      `${theme}: manager overflows horizontally`,
    );
    const setDefault = button("Set default", card("Local"));
    setDefault.focus();
    check(
      document.activeElement === setDefault,
      `${theme}: recovery action cannot receive focus`,
    );
    click(setDefault);
    await waitFor(() => !button("Remove", card("Failed SSH")).disabled);
    click(button("Remove", card("Failed SSH")));
    await waitFor(
      () => !!document.querySelector('[aria-label="Remove Connection"]'),
    );
    click(
      button(
        "Remove",
        document.querySelector('[aria-label="Remove Connection"]')!,
      ),
    );
    await waitFor(() => !document.body.textContent?.includes("Failed SSH"));
    check(
      connections.find((item) => item.is_default)?.id === "local",
      `${theme}: removal lost the default`,
    );
    check(
      calls.slice(-2).join(",") ===
        "connections.set_default,connections.remove",
      `${theme}: incorrect recovery calls`,
    );
    flushSync(() => root.render(null));
  }
  root.unmount();
}
void run()
  .catch((error) =>
    failures.push(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    ),
  )
  .finally(() =>
    fetch("/result", { method: "POST", body: JSON.stringify(failures) }),
  );
