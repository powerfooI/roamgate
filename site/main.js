document.documentElement.classList.replace("no-js", "js");

const header = document.querySelector("[data-header]");
const nav = document.querySelector("[data-nav]");
const navToggle = document.querySelector("[data-nav-toggle]");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const updateHeader = () => {
  header?.classList.toggle("is-scrolled", window.scrollY > 18);
};

updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

const closeNavigation = () => {
  nav?.classList.remove("is-open");
  navToggle?.setAttribute("aria-expanded", "false");
};

navToggle?.addEventListener("click", () => {
  const isOpen = nav?.classList.toggle("is-open") ?? false;
  navToggle.setAttribute("aria-expanded", String(isOpen));
});

nav?.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("a")) {
    closeNavigation();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && nav?.classList.contains("is-open")) {
    closeNavigation();
    navToggle?.focus();
  }
});

const revealElements = [...document.querySelectorAll(".reveal")];

if (reducedMotion.matches || !("IntersectionObserver" in window)) {
  for (const element of revealElements) {
    element.classList.add("is-visible");
  }
} else {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        const demo = entry.target.querySelector("[data-handoff-demo]");
        if (demo instanceof HTMLVideoElement) demo.play().catch(() => {});
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8%", threshold: 0.08 },
  );

  for (const element of revealElements) {
    revealObserver.observe(element);
  }
}

const showcaseTabs = [...document.querySelectorAll("[data-showcase-tab]")];
const showcasePanel = document.querySelector("[data-showcase-panel]");
const showcaseWindow = showcasePanel?.querySelector(".showcase-window");
const showcaseImage = document.querySelector("[data-showcase-image]");
const showcaseLink = document.querySelector("[data-showcase-link]");
const showcaseLabel = document.querySelector("[data-showcase-label]");
const showcaseTitle = document.querySelector("[data-showcase-title]");
const showcaseCopy = document.querySelector("[data-showcase-copy]");

const activateShowcaseTab = (tab) => {
  if (!(tab instanceof HTMLButtonElement)) return;

  for (const candidate of showcaseTabs) {
    const selected = candidate === tab;
    candidate.setAttribute("aria-selected", String(selected));
    candidate.setAttribute("tabindex", selected ? "0" : "-1");
  }

  const imageSource = tab.dataset.image;
  const imageAlt = tab.dataset.alt;
  const label = tab.dataset.label;
  const title = tab.dataset.title;
  const copy = tab.dataset.copy;

  showcasePanel?.setAttribute("aria-labelledby", tab.id);
  showcaseWindow?.classList.add("is-swapping");

  window.setTimeout(
    () => {
      if (showcaseImage instanceof HTMLImageElement && imageSource) {
        showcaseImage.src = imageSource;
        showcaseImage.alt = imageAlt ?? "Roamgate product view";
      }
      if (showcaseLink instanceof HTMLAnchorElement && imageSource) {
        showcaseLink.href = imageSource;
      }
      if (showcaseLabel && label) showcaseLabel.textContent = label;
      if (showcaseTitle && title) showcaseTitle.textContent = title;
      if (showcaseCopy && copy) showcaseCopy.textContent = copy;
      showcaseWindow?.classList.remove("is-swapping");
    },
    reducedMotion.matches ? 0 : 140,
  );
};

showcaseTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => activateShowcaseTab(tab));
  tab.addEventListener("keydown", (event) => {
    let nextIndex;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % showcaseTabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + showcaseTabs.length) % showcaseTabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = showcaseTabs.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextTab = showcaseTabs[nextIndex];
    activateShowcaseTab(nextTab);
    if (nextTab instanceof HTMLButtonElement) nextTab.focus();
  });
});

const copyButton = document.querySelector("[data-copy-command]");
const copyLabel = copyButton?.querySelector("span");
const installCommand = document.querySelector("[data-install-command]");
const commandText =
  "curl -fsSL https://github.com/powerfooI/roamgate/releases/latest/download/install-roamgate.sh | sh";

const copyText = async (text) => {
  if (!navigator.clipboard || !window.isSecureContext) {
    throw new Error("Clipboard API unavailable");
  }
  await navigator.clipboard.writeText(text);
};

copyButton?.addEventListener("click", async () => {
  try {
    await copyText(commandText);
    if (copyLabel) copyLabel.textContent = "Copied";
    copyButton.setAttribute("aria-label", "Install command copied");
  } catch {
    if (installCommand instanceof HTMLElement) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(installCommand);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    if (copyLabel) copyLabel.textContent = "Select text";
  }

  window.setTimeout(() => {
    if (copyLabel) copyLabel.textContent = "Copy";
    copyButton.setAttribute("aria-label", "Copy install command");
  }, 1800);
});

if (!reducedMotion.matches && window.matchMedia("(pointer: fine)").matches) {
  for (const element of document.querySelectorAll("[data-spotlight]")) {
    element.addEventListener("pointermove", (event) => {
      const bounds = element.getBoundingClientRect();
      element.style.setProperty(
        "--spotlight-x",
        `${event.clientX - bounds.left}px`,
      );
      element.style.setProperty(
        "--spotlight-y",
        `${event.clientY - bounds.top}px`,
      );
    });
  }
}

const starCount = document.querySelector("[data-star-count]");

fetch("https://api.github.com/repos/powerfooI/roamgate", {
  headers: { Accept: "application/vnd.github+json" },
})
  .then((response) => {
    if (!response.ok) throw new Error("GitHub request failed");
    return response.json();
  })
  .then((repository) => {
    if (!starCount || typeof repository.stargazers_count !== "number") return;
    const formatted = new Intl.NumberFormat("en", {
      notation: repository.stargazers_count >= 1000 ? "compact" : "standard",
      maximumFractionDigits: 1,
    }).format(repository.stargazers_count);
    starCount.textContent = `${formatted} stars`;
  })
  .catch(() => undefined);

const year = document.querySelector("[data-year]");
if (year) year.textContent = String(new Date().getFullYear());
