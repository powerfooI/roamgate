import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/layout/app.css";
import "./WorktreeLifecycleDialog.css";

// Deliberately exclude lazy inspector/terminal styles: App's shell must lay
// out correctly even while those chunks are still downloading.
const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (!condition) failures.push(message);
}
async function settle() {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

async function run() {
  const fixture = document.createElement("div");
  fixture.innerHTML = `
    <div class="workspace-stage has-inspector">
      <div class="workspace-terminal-surface"></div>
      <div class="workspace-inspector-resizer"></div>
      <div class="workspace-inspector-slot">
        <div class="terminal-loading">Loading Inspector</div>
      </div>
    </div>
    <div class="modal worktree-lifecycle-modal">
      <div class="modal-head lifecycle-head"><h2>Worktrees</h2></div>
    </div>`;
  document.body.append(fixture);
  const stage = fixture.querySelector<HTMLElement>(".workspace-stage")!;
  const surface = fixture.querySelector<HTMLElement>(
    ".workspace-terminal-surface",
  )!;
  const slot = fixture.querySelector<HTMLElement>(".workspace-inspector-slot")!;
  const resizer = fixture.querySelector<HTMLElement>(
    ".workspace-inspector-resizer",
  )!;
  const header = fixture.querySelector<HTMLElement>(".lifecycle-head")!;
  const title = header.querySelector("h2")!;
  try {
    for (const theme of ["dark", "light"]) {
      document.documentElement.dataset.theme = theme;
      for (const layout of ["desktop", "mobile"]) {
        document.documentElement.dataset.layout = layout;
        await settle();
        const label = `${theme} ${layout}`;
        check(
          getComputedStyle(title).fontSize === "16px",
          `${label}: lifecycle title must remain 16px`,
        );
        check(
          getComputedStyle(header).alignItems === "center" &&
            getComputedStyle(header).marginBottom === "16px",
          `${label}: lifecycle header alignment and spacing changed`,
        );
        for (const dock of ["right", "bottom"]) {
          stage.className = `workspace-stage has-inspector inspector-dock-${dock}`;
          slot.style.cssText =
            dock === "right" ? "width:400px" : "height:300px";
          for (const [width, height] of [
            [1100, 700],
            [900, 700],
            [1100, 450],
            [390, 700],
          ]) {
            stage.style.width = `${width}px`;
            stage.style.height = `${height}px`;
            await settle();
            const context = `${label} ${dock} ${width}x${height}`;
            const overlay = width <= 999 || height <= 466;
            check(
              getComputedStyle(slot).position ===
                (overlay ? "absolute" : "relative"),
              `${context}: inspector slot must use the responsive position before its chunk loads`,
            );
            check(
              (getComputedStyle(resizer).display === "none") === overlay,
              `${context}: responsive inspector must hide its resizer`,
            );
            if (overlay) {
              const stageRect = stage.getBoundingClientRect();
              const surfaceRect = surface.getBoundingClientRect();
              check(
                Math.abs(surfaceRect.width - stageRect.width) < 1 &&
                  Math.abs(surfaceRect.height - stageRect.height) < 1,
                `${context}: loading inspector must not shrink the terminal`,
              );
              if (width <= 699 || height <= 466) {
                const slotRect = slot.getBoundingClientRect();
                // Bottom docking retains its 72% cap except in short stages.
                const expectedHeight =
                  dock === "bottom" && height > 466
                    ? stageRect.height * 0.72
                    : stageRect.height;
                check(
                  Math.abs(slotRect.width - stageRect.width) < 1 &&
                    Math.abs(slotRect.height - expectedHeight) < 1,
                  `${context}: small inspector overlay dimensions changed`,
                );
              }
            }
          }
        }
      }
    }
  } finally {
    fixture.remove();
    delete document.documentElement.dataset.layout;
    delete document.documentElement.dataset.theme;
  }
}

run()
  .catch((error) => failures.push(String(error)))
  .finally(() =>
    fetch("/result", { method: "POST", body: JSON.stringify(failures) }),
  );
