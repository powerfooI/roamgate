import { agentClass } from "../utils";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/layout/app.css";
import "../styles/layout/topbar.css";
import "./WorktreeLifecycleDialog.css";
import "./AnnotationPanel.css";
import "./WorkspaceTree.css";
import "../styles/layout/sidebar.css";

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
    <div class="app header-fixture" style="width:390px;height:200px;min-height:0">
      <header class="topbar"><span>Roamgate</span></header>
      <main class="body"></main>
    </div>
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
  const shell = fixture.querySelector<HTMLElement>(".header-fixture")!;
  const topbar = shell.querySelector<HTMLElement>(".topbar")!;
  const content = shell.querySelector<HTMLElement>(".body")!;
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
    const paneItem = document.createElement("button");
    const statusBadge = document.createElement("span");
    const referenceBadge = document.createElement("span");
    paneItem.append(statusBadge);
    fixture.append(paneItem, referenceBadge);
    for (const theme of ["dark", "light"]) {
      document.documentElement.dataset.theme = theme;
      for (const layout of ["desktop", "mobile"]) {
        document.documentElement.dataset.layout = layout;
        for (const state of ["", "is-selected", "is-current"]) {
          paneItem.className = `pane-jump-item ${state}`;
          for (const status of ["working", "done", "blocked", "idle"]) {
            referenceBadge.className = agentClass(status);
            statusBadge.className = `${agentClass(status)} pane-jump-agent-status`;
            statusBadge.textContent = status;
            const actual = getComputedStyle(statusBadge);
            const expected = getComputedStyle(referenceBadge);
            check(
              actual.color === expected.color &&
                actual.backgroundColor === expected.backgroundColor,
              `${theme} ${layout} ${state} ${status}: pane switcher must preserve the shared status badge palette`,
            );
          }
        }
      }
    }
    paneItem.remove();
    referenceBadge.remove();
    const sidebar = document.createElement("aside");
    sidebar.className = "sidebar";
    sidebar.style.height = "300px";
    sidebar.innerHTML = `<div class="sidebar-content">
      <div class="panel tree workspace-tree-panel"><div class="workspace-tree-content">
        <div class="tree-row has-tab-count" tabindex="0">
          <span class="twisty"></span>
          <strong class="ws-label">feature-with-a-long-workspace-name</strong>
          <span class="workspace-tab-count">2</span>
          <span class="git-status" title="Git status">
            <span class="git-badge git-branch">feature-with-a-long-branch-name</span>
            <span class="git-badge git-dirty">Δ5</span>
            <span class="git-badge git-ahead">↑1234</span>
            <span class="git-badge git-behind">↓12</span>
          </span>
        </div>
      </div></div>
    </div>`;
    fixture.append(sidebar);
    const row = sidebar.querySelector<HTMLElement>(".tree-row")!;
    const workspaceName = sidebar.querySelector<HTMLElement>(".ws-label")!;
    const branch = sidebar.querySelector<HTMLElement>(".git-branch")!;
    const git = sidebar.querySelector<HTMLElement>(".git-status")!;
    const treeContent = sidebar.querySelector<HTMLElement>(
      ".workspace-tree-content",
    )!;
    for (const theme of ["dark", "light"]) {
      document.documentElement.dataset.theme = theme;
      for (const layout of ["desktop", "mobile"]) {
        document.documentElement.dataset.layout = layout;
        for (const width of [180, 240, 320]) {
          sidebar.style.width = `${width}px`;
          for (const showBranch of [false, true]) {
            branch.hidden = !showBranch;
            await settle();
            const context = `${theme} ${layout} sidebar ${width}px branch=${showBranch}`;
            const gitRect = git.getBoundingClientRect();
            const viewport = treeContent.getBoundingClientRect();
            const nameRect = workspaceName.getBoundingClientRect();
            check(
              Math.abs(
                gitRect.top +
                  gitRect.height / 2 -
                  nameRect.top -
                  nameRect.height / 2,
              ) < 1 &&
                gitRect.height <= 17 &&
                nameRect.width > 0,
              `${context}: workspace title and Git badges must stay on one compact line`,
            );
            for (const badge of git.querySelectorAll<HTMLElement>(
              ".git-dirty, .git-ahead, .git-behind",
            )) {
              const bounds = badge.getBoundingClientRect();
              check(
                badge.scrollWidth <= badge.clientWidth &&
                  bounds.left >= gitRect.left - 1 &&
                  bounds.right <= gitRect.right + 1 &&
                  bounds.top >= gitRect.top - 1 &&
                  bounds.bottom <= gitRect.bottom + 1 &&
                  bounds.right <= viewport.right + 1 &&
                  bounds.top >= viewport.top - 1 &&
                  bounds.bottom <= viewport.bottom + 1,
                `${context}: ${badge.textContent} must stay fully visible`,
              );
            }
            check(
              treeContent.scrollWidth <= treeContent.clientWidth,
              `${context}: badges must not cause horizontal overflow`,
            );
            row.focus();
            check(
              document.activeElement === row,
              `${context}: workspace remains keyboard-focusable`,
            );
          }
        }
      }
    }
    sidebar.style.width = "240px";
    workspaceName.textContent = "sample-workspace";
    git.querySelector(".git-ahead")!.remove();
    git.querySelector(".git-behind")!.remove();
    await settle();
    check(
      branch.getBoundingClientRect().width >= 30,
      "a branch with a single count must retain readable space",
    );
    sidebar.style.width = "180px";
    await settle();
    check(
      git.getBoundingClientRect().height ===
        branch.getBoundingClientRect().height,
      "a branch and change count must stay on one line in a narrow sidebar",
    );
    sidebar.style.width = "480px";
    for (const branchName of ["feature-with-a-long-branch-name", "main"]) {
      branch.textContent = branchName;
      await settle();
      check(
        Math.abs(
          git.getBoundingClientRect().right -
            git.querySelector(".git-dirty")!.getBoundingClientRect().right,
        ) < 1,
        "Git status must not reserve empty space after its last badge",
      );
    }
    git.remove();
    await settle();
    check(
      row.getBoundingClientRect().height <=
        workspaceName.getBoundingClientRect().height + 8,
      "a workspace without Git metadata must remain a single row",
    );
    sidebar.remove();
    delete document.documentElement.dataset.layout;
    const zen = document.createElement("div");
    zen.className = "app zen";
    zen.innerHTML = `<header class="topbar"></header>
      <button class="zen-island">Exit Zen</button>`;
    fixture.append(zen);
    const zenTopbar = zen.querySelector<HTMLElement>(".topbar")!;
    const island = zen.querySelector<HTMLButtonElement>(".zen-island")!;
    check(
      getComputedStyle(island).position === "fixed" &&
        getComputedStyle(island).top === "0px" &&
        Number(getComputedStyle(island).zIndex) >
          Number(getComputedStyle(zenTopbar).zIndex),
      "zen island must hang flush from the top edge above the revealed topbar",
    );
    island.focus();
    // The reveal animates transform over 150ms; wait it out before measuring.
    await Promise.race([
      new Promise((resolve) =>
        zenTopbar.addEventListener("transitionend", resolve, { once: true }),
      ),
      new Promise((resolve) => setTimeout(resolve, 300)),
    ]);
    check(
      getComputedStyle(zenTopbar).transform === "none",
      "focusing the zen island must reveal the topbar",
    );
    island.blur();
    await settle();
    zen.remove();
    for (const theme of ["dark", "light"]) {
      document.documentElement.dataset.theme = theme;
      for (const layout of ["desktop", "mobile"]) {
        document.documentElement.dataset.layout = layout;
        await settle();
        const label = `${theme} ${layout}`;
        const topbarStyle = getComputedStyle(topbar);
        check(
          topbarStyle.position ===
            (layout === "mobile" ? "sticky" : "relative") &&
            (layout !== "mobile" || topbarStyle.top === "0px"),
          `${label}: mobile topbar must be a top-anchored header for iOS scroll-edge handling`,
        );
        const background = document.createElement("canvas").getContext("2d")!;
        background.fillStyle = topbarStyle.backgroundColor;
        background.fillRect(0, 0, 1, 1);
        check(
          background.getImageData(0, 0, 1, 1).data[3] === 255,
          `${label}: topbar background must remain opaque`,
        );
        check(
          Math.abs(
            topbar.getBoundingClientRect().top -
              shell.getBoundingClientRect().top,
          ) < 1 &&
            content.getBoundingClientRect().top >=
              topbar.getBoundingClientRect().bottom - 1,
          `${label}: topbar must retain its layout space without covering content`,
        );
        shell.classList.add("zen");
        check(
          getComputedStyle(topbar).position === "absolute",
          `${label}: Zen topbar must retain its slide-out positioning`,
        );
        shell.classList.remove("zen");
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
    document.documentElement.dataset.layout = "desktop";
    const peers = document.createElement("div");
    peers.className = "workspace-surfaces has-annotations";
    peers.style.height = "700px";
    fixture.append(peers);
    peers.append(stage);
    const annotations = document.createElement("aside");
    annotations.className = "annotation-panel";
    peers.append(annotations);
    stage.style.cssText = "";
    const disjoint = (a: DOMRect, b: DOMRect) =>
      a.right <= b.left + 1 ||
      b.right <= a.left + 1 ||
      a.bottom <= b.top + 1 ||
      b.bottom <= a.top + 1;
    for (const theme of ["light", "dark"]) {
      document.documentElement.dataset.theme = theme;
      for (const width of [1100, 850]) {
        peers.style.width = `${width}px`;
        for (const dock of ["right", "bottom"]) {
          stage.className = `workspace-stage has-inspector inspector-dock-${dock}`;
          slot.style.cssText =
            dock === "right" ? "width:400px" : "height:300px";
          await settle();
          const terminalRect = surface.getBoundingClientRect();
          const inspectorRect = slot.getBoundingClientRect();
          const annotationRect = annotations.getBoundingClientRect();
          const context = `${theme} ${dock} peers at ${width}px`;
          check(
            getComputedStyle(resizer).display !== "none",
            `${context}: docked Inspector resize control is hidden`,
          );
          check(
            disjoint(terminalRect, annotationRect) &&
              disjoint(inspectorRect, annotationRect) &&
              disjoint(terminalRect, inspectorRect),
            `${context}: docked peers overlap`,
          );
          check(
            terminalRect.width >= 240 &&
              terminalRect.height >= 180 &&
              annotationRect.width >= 300,
            `${context}: peer docking makes terminal or draft unusable`,
          );
          if (width === 1100 && dock === "right") {
            slot.style.width = "360px";
            await settle();
            check(
              slot.getBoundingClientRect().width === 360,
              `${context}: peer docking ignored Inspector resize`,
            );
          }
          check(
            width > 900
              ? annotationRect.left >= stage.getBoundingClientRect().right
              : annotationRect.top >= stage.getBoundingClientRect().bottom,
            `${context}: draft did not adapt to available width`,
          );
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
