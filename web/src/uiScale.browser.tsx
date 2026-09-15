import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/vendor.css";
import "./components/TerminalView.css";
import { terminalFontOptions } from "./appearance";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "./components/ui/command";

const failures: string[] = [];
const check = (condition: boolean, message: string) => {
  if (!condition) failures.push(message);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

async function run() {
  const header = document.createElement("div");
  header.style.cssText = "display:flex;justify-content:flex-end;padding:16px";
  header.style.position = "relative";
  header.style.zIndex = "120";
  document.body.append(header);
  const root = createRoot(header);
  const renderMenu = (open: boolean) =>
    flushSync(() =>
      root.render(
        <Popover open={open}>
          <PopoverTrigger asChild>
            <button>Actions</button>
          </PopoverTrigger>
          <PopoverContent className="command-popover" align="end">
            <Command>
              <CommandInput />
              <CommandList>
                {Array.from({ length: 30 }, (_, i) => (
                  <CommandItem key={i}>Action {i}</CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>,
      ),
    );
  const container = document.createElement("div");
  container.className = "terminal-view";
  container.style.cssText =
    "position:relative;margin:16px;width:800px;height:420px";
  document.body.append(container);
  const term = new Terminal({
    cols: 60,
    rows: 20,
    ...terminalFontOptions(false, 100),
  });
  term.open(container);
  const write = (data: string) =>
    new Promise<void>((resolve) => term.write(data, resolve));
  await write(
    Array.from({ length: 20 }, () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(2),
    ).join("\r\n"),
  );
  const input: string[] = [];
  term.onData((data) => input.push(data));
  try {
    for (const compact of [false, true]) {
      for (const scale of [100, 125, 150, 80, 115, 100]) {
        document.documentElement.style.zoom = String(scale / 100);
        document.documentElement.style.setProperty(
          "--ui-scale",
          String(scale / 100),
        );
        term.options = terminalFontOptions(compact, scale);
        renderMenu(true);
        await settle();
        const menu = document
          .querySelector(".command-popover")!
          .getBoundingClientRect();
        const trigger = header.querySelector("button")!.getBoundingClientRect();
        const label = `${compact ? "compact" : "desktop"} ${scale}%`;
        check(
          menu.left >= -1 && menu.right <= innerWidth + 1,
          `${label}: menu overflowed horizontally`,
        );
        check(
          menu.top >= -1 && menu.bottom <= innerHeight + 1,
          `${label}: menu overflowed vertically`,
        );
        check(
          Math.abs(menu.top - trigger.bottom - 8) < 2,
          `${label}: menu lost its trigger anchor`,
        );
        const menuElement = document.querySelector(".command-popover")!;
        check(
          menuElement.contains(
            document.elementFromPoint(menu.left + 10, menu.top + 2),
          ),
          `${label}: topbar obscured the menu`,
        );
        renderMenu(false);
        await settle();
        const screen = container.querySelector(".xterm-screen")!;
        const rect = screen.getBoundingClientRect();
        const cellWidth = rect.width / term.cols;
        const cellHeight = rect.height / term.rows;
        const mouse = (
          target: EventTarget,
          type: string,
          x: number,
          y: number,
          buttons: number,
        ) =>
          target.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              button: 0,
              detail: 1,
              buttons,
              clientX: rect.left + x * cellWidth,
              clientY: rect.top + y * cellHeight,
            }),
          );
        mouse(screen, "mousedown", 10.1, 6.5, 1);
        mouse(document, "mousemove", 20.1, 6.5, 1);
        mouse(document, "mouseup", 20.1, 6.5, 0);
        check(
          JSON.stringify(term.getSelectionPosition()) ===
            JSON.stringify({ start: { x: 10, y: 6 }, end: { x: 20, y: 6 } }),
          `${label}: selection missed the rendered cells`,
        );
        check(
          term.getSelection() === "KLMNOPQRST",
          `${label}: copied the wrong text`,
        );
        term.clearSelection();
        await write("\x1b[?1000h\x1b[?1006h");
        input.length = 0;
        mouse(screen, "mousedown", 12.5, 6.5, 1);
        mouse(document, "mouseup", 12.5, 6.5, 0);
        check(
          input.includes("\x1b[<0;13;7M"),
          `${label}: app click missed the rendered cell: ${JSON.stringify(input)}`,
        );
        await write("\x1b[?1000l\x1b[?1006l");
      }
    }
  } finally {
    term.dispose();
    root.unmount();
    header.remove();
    container.remove();
    document.documentElement.style.zoom = "";
    document.documentElement.style.removeProperty("--ui-scale");
  }
}

run()
  .catch((error: unknown) => failures.push(String(error)))
  .finally(() =>
    fetch("/result", { method: "POST", body: JSON.stringify(failures) }),
  );
