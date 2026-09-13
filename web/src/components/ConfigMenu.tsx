import { lazyWithReload } from "../lazyWithReload";
import type { ReactNode } from "react";
import { Suspense, useEffect, useRef, useState } from "react";
import {
  ALargeSmall,
  Bell,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Focus,
  GitBranch,
  Keyboard,
  LayoutDashboard,
  Minus,
  Moon,
  Palette,
  Plus,
  RefreshCw,
  Server,
  SquareTerminal,
  Sun,
  SunMoon,
  Wifi,
} from "lucide-react";
import packageJson from "../../package.json";
import type { Theme } from "../App";
import {
  ACCENT_OPTIONS,
  type AccentColor,
  clampUiScale,
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP,
} from "../appearance";
import { connectionHttpPath } from "../connectionHttp";
import { useLayoutPreferences } from "../layoutPreferences";
import { shortcutLabel, useShortcutPreferences } from "../shortcutPreferences";
import { shallowEqual, store, useStoreSelector } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import {
  mobileTerminalShortcutCount,
  type MobileTerminalShortcutRows,
  type MobileTerminalSideShortcuts,
} from "../mobileTerminalShortcuts";
import {
  type CustomTerminalTheme,
  resolveTerminalThemeDefinition,
  type TerminalThemeSelection,
} from "../terminalThemes";
import { AutoSyncRepositoriesDialog } from "./AutoSyncRepositoriesDialog";
import { MobileTerminalShortcutsDialog } from "./MobileTerminalShortcutsDialog";

const ShortcutLookupDialog = lazyWithReload("keyboard-shortcuts", () =>
  import("./ShortcutLookupDialog").then((module) => ({
    default: module.ShortcutLookupDialog,
  })),
);
const TerminalThemeDialog = lazyWithReload("terminal-theme", () =>
  import("./TerminalThemeDialog").then((module) => ({
    default: module.TerminalThemeDialog,
  })),
);

const MobileLayoutDialog = lazyWithReload("mobile-layout", () =>
  import("./MobileLayoutDialog").then((module) => ({
    default: module.MobileLayoutDialog,
  })),
);

const APP_VERSION = packageJson.version;
const RELEASES_URL = "https://github.com/powerfooI/roamgate/releases";
export const CONFIG_MENU_ID = "roamgate-config-menu";

export function reloadApplicationPage(
  target: Pick<Location, "reload"> = window.location,
) {
  target.reload();
}

type HealthInfo = {
  socket?: string;
};

type HerdrInfo = {
  version: string;
  protocol: number;
};

type ConfigMenuProps = {
  theme: Theme;
  accentColor: AccentColor;
  uiScale: number;
  zenMode: boolean;
  mobileTerminalShortcuts: MobileTerminalShortcutRows;
  mobileTerminalSideShortcuts: MobileTerminalSideShortcuts;
  terminalThemeSelection: TerminalThemeSelection;
  customTerminalThemes: CustomTerminalTheme[];
  onThemeChange: (theme: Theme) => void;
  onAccentColorChange: (accentColor: AccentColor) => void;
  onUiScaleChange: (scale: number) => void;
  onZenModeChange: (zenMode: boolean) => void;
  onMobileTerminalShortcutsChange: (rows: MobileTerminalShortcutRows) => void;
  onMobileTerminalSideShortcutsChange: (
    shortcuts: MobileTerminalSideShortcuts,
  ) => void;
  onTerminalThemeSelectionChange: (selection: TerminalThemeSelection) => void;
  onCustomTerminalThemesChange: (themes: CustomTerminalTheme[]) => void;
};

export function ConfigMenu({
  theme,
  accentColor,
  uiScale,
  zenMode,
  mobileTerminalShortcuts,
  mobileTerminalSideShortcuts,
  terminalThemeSelection,
  customTerminalThemes,
  onThemeChange,
  onAccentColorChange,
  onUiScaleChange,
  onZenModeChange,
  onMobileTerminalShortcutsChange,
  onMobileTerminalSideShortcutsChange,
  onTerminalThemeSelectionChange,
  onCustomTerminalThemesChange,
}: ConfigMenuProps) {
  const s = useStoreSelector(
    (state) => ({
      bridgeStatus: state.bridgeStatus,
      connectionPaused: state.connectionPaused,
      status: state.status,
      taskNotificationPermission: state.taskNotificationPermission,
      taskNotificationsEnabled: state.taskNotificationsEnabled,
      automaticUpdateChecksEnabled: state.automaticUpdateChecksEnabled,
      updateInfo: state.updateInfo,
      updateInstalling: state.updateInstalling,
    }),
    shallowEqual,
  );
  const connectionClient = useConnectionClient();
  const layout = useLayoutPreferences();
  useShortcutPreferences();
  const updateAvailable = !!s.updateInfo?.update_available;
  const canInstallUpdate = updateAvailable && s.updateInfo?.can_auto_update;
  const updateVersion = s.updateInfo?.latest_version;
  const clientCount =
    !s.connectionPaused && s.status === "connected"
      ? s.bridgeStatus?.clients
      : null;
  const taskNotificationValue = taskNotificationStatus(
    s.taskNotificationsEnabled,
    s.taskNotificationPermission,
  );
  const [open, setOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [mobileShortcutsOpen, setMobileShortcutsOpen] = useState(false);
  const [terminalThemesOpen, setTerminalThemesOpen] = useState(false);
  const [mobileLayoutOpen, setMobileLayoutOpen] = useState(false);
  const [autoSyncOpen, setAutoSyncOpen] = useState(false);
  const [connectionDetailsOpen, setConnectionDetailsOpen] = useState(false);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [herdrInfo, setHerdrInfo] = useState<HerdrInfo | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setHealth(null);
    setHerdrInfo(null);

    fetch("/api/health", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((healthInfo) => {
        if (!cancelled) setHealth(healthInfo);
      });

    if (connectionClient.isCurrent()) {
      const herdrInfoUrl = new URL(
        connectionHttpPath(
          connectionClient.connectionId,
          "/herdr-info",
          connectionClient.serverRuntimeGeneration,
        ),
        window.location.origin,
      );
      if (herdrInfoUrl.origin === window.location.origin) {
        fetch(herdrInfoUrl, {
          credentials: "same-origin",
          cache: "no-store",
        })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
          .then((info) => {
            if (!cancelled && connectionClient.isCurrent()) setHerdrInfo(info);
          });
      }
    }

    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      cancelled = true;
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [connectionClient, open]);

  return (
    <>
      <div className="config-menu" ref={ref}>
        <button
          ref={triggerRef}
          className={`topbar-button menu-button ${open ? "is-active" : ""}`}
          onClick={() => setOpen((value) => !value)}
          aria-label={updateAvailable ? "Menu, update available" : "Menu"}
          aria-controls={open ? CONFIG_MENU_ID : undefined}
          aria-expanded={open}
          aria-haspopup="dialog"
        >
          Menu
          {updateAvailable ? <span className="menu-update-dot" /> : null}
        </button>

        {open ? (
          <div
            id={CONFIG_MENU_ID}
            className="config-dropdown"
            role="dialog"
            aria-label="Application menu"
          >
            <div className="config-summary">
              <div>
                <strong>Roamgate</strong>
                <span>Version {APP_VERSION}</span>
              </div>
              <span
                className={`config-connection-summary status-${s.connectionPaused ? "paused" : s.status}`}
              >
                <span className="status-dot" />
                {s.connectionPaused ? "Paused" : s.status}
                {typeof clientCount === "number"
                  ? ` · ${clientCount} client${clientCount === 1 ? "" : "s"}`
                  : ""}
              </span>
            </div>

            <div className="config-section">
              <div className="config-title">Appearance</div>
              <div className="config-preference-row">
                <span className="config-item-icon">
                  {theme === "system" ? (
                    <SunMoon size={15} />
                  ) : theme === "light" ? (
                    <Sun size={15} />
                  ) : (
                    <Moon size={15} />
                  )}
                </span>
                <div className="config-item-copy">
                  <strong>Theme</strong>
                  <span>Application appearance</span>
                </div>
                <div className="config-theme-control" aria-label="Theme">
                  <button
                    type="button"
                    aria-label="Use light theme"
                    aria-pressed={theme === "light"}
                    className={theme === "light" ? "is-active" : ""}
                    onClick={() => onThemeChange("light")}
                  >
                    <Sun size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label="Use dark theme"
                    aria-pressed={theme === "dark"}
                    className={theme === "dark" ? "is-active" : ""}
                    onClick={() => onThemeChange("dark")}
                  >
                    <Moon size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label="Use system theme"
                    aria-pressed={theme === "system"}
                    className={theme === "system" ? "is-active" : ""}
                    onClick={() => onThemeChange("system")}
                  >
                    <SunMoon size={14} />
                  </button>
                </div>
              </div>
              <div className="config-preference-row">
                <span className="config-item-icon">
                  <Palette size={15} />
                </span>
                <div className="config-item-copy">
                  <strong>Accent color</strong>
                  <span>
                    {
                      ACCENT_OPTIONS.find(
                        (option) => option.value === accentColor,
                      )?.label
                    }
                  </span>
                </div>
                <div
                  className="config-accent-control"
                  role="radiogroup"
                  aria-label="Accent color"
                >
                  {ACCENT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      data-accent={option.value}
                      title={option.label}
                      aria-label={option.label}
                      aria-checked={accentColor === option.value}
                      tabIndex={accentColor === option.value ? 0 : -1}
                      className={
                        accentColor === option.value ? "is-active" : ""
                      }
                      onClick={() => onAccentColorChange(option.value)}
                      onKeyDown={(event) => {
                        const direction =
                          event.key === "ArrowRight" ||
                          event.key === "ArrowDown"
                            ? 1
                            : event.key === "ArrowLeft" ||
                                event.key === "ArrowUp"
                              ? -1
                              : 0;
                        if (direction === 0) return;
                        event.preventDefault();
                        const nextIndex =
                          (ACCENT_OPTIONS.indexOf(option) +
                            direction +
                            ACCENT_OPTIONS.length) %
                          ACCENT_OPTIONS.length;
                        const next = ACCENT_OPTIONS[nextIndex];
                        onAccentColorChange(next.value);
                        const buttons =
                          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                            '[role="radio"]',
                          );
                        buttons?.[nextIndex]?.focus();
                      }}
                    />
                  ))}
                </div>
              </div>
              <ConfigMenuItem
                icon={<SquareTerminal size={15} />}
                label="Terminal theme"
                className="config-menu-item-row"
                description={`Dark: ${
                  resolveTerminalThemeDefinition(
                    "dark",
                    terminalThemeSelection,
                    customTerminalThemes,
                  ).name
                } · Light: ${
                  resolveTerminalThemeDefinition(
                    "light",
                    terminalThemeSelection,
                    customTerminalThemes,
                  ).name
                }`}
                onClick={() => {
                  setOpen(false);
                  setTerminalThemesOpen(true);
                }}
              />
              {layout.mobile ? null : (
                <div className="config-preference-row">
                  <span className="config-item-icon">
                    <Focus size={15} />
                  </span>
                  <div className="config-item-copy">
                    <strong>Zen mode</strong>
                    <span>
                      {zenMode ? "Enabled" : "Disabled"} ·{" "}
                      {shortcutLabel("zen.toggle")}
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-label="Zen mode"
                    aria-checked={zenMode}
                    className={"settings-switch" + (zenMode ? " is-on" : "")}
                    onClick={() => {
                      onZenModeChange(!zenMode);
                      setOpen(false);
                    }}
                  >
                    <span />
                  </button>
                </div>
              )}
              <ConfigMenuItem
                icon={<LayoutDashboard size={15} />}
                label="Layout"
                className="config-menu-item-row"
                description="Display mode, mobile breakpoint, and sidebar order"
                onClick={() => {
                  setOpen(false);
                  setMobileLayoutOpen(true);
                }}
              />
              <div className="config-preference-row">
                <span className="config-item-icon">
                  <ALargeSmall size={15} />
                </span>
                <div className="config-item-copy">
                  <strong>Text size</strong>
                  <span>Scale the interface, handy on mobile</span>
                </div>
                <div
                  className="config-scale-control"
                  role="group"
                  aria-label="Text size"
                >
                  <button
                    type="button"
                    aria-label="Decrease text size"
                    disabled={uiScale <= UI_SCALE_MIN}
                    onClick={() =>
                      onUiScaleChange(clampUiScale(uiScale - UI_SCALE_STEP))
                    }
                  >
                    <Minus size={14} />
                  </button>
                  <button
                    type="button"
                    className="config-scale-value"
                    aria-label={`Reset text size, currently ${uiScale}%`}
                    title="Reset to 100%"
                    disabled={uiScale === UI_SCALE_DEFAULT}
                    onClick={() => onUiScaleChange(UI_SCALE_DEFAULT)}
                  >
                    {uiScale}%
                  </button>
                  <button
                    type="button"
                    aria-label="Increase text size"
                    disabled={uiScale >= UI_SCALE_MAX}
                    onClick={() =>
                      onUiScaleChange(clampUiScale(uiScale + UI_SCALE_STEP))
                    }
                  >
                    <Plus size={14} />
                  </button>
                </div>
              </div>
            </div>

            <div className="config-section">
              <div className="config-title">Behavior & automation</div>
              <div className="config-preference-row">
                <span className="config-item-icon">
                  <Download size={15} />
                </span>
                <div className="config-item-copy">
                  <strong>Automatic update checks</strong>
                  <span>
                    {s.automaticUpdateChecksEnabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="Automatic update checks"
                  aria-checked={s.automaticUpdateChecksEnabled}
                  className={
                    "settings-switch" +
                    (s.automaticUpdateChecksEnabled ? " is-on" : "")
                  }
                  onClick={() => {
                    store.setAutomaticUpdateChecksEnabled(
                      !s.automaticUpdateChecksEnabled,
                    );
                  }}
                >
                  <span />
                </button>
              </div>
              <div className="config-preference-row">
                <span className="config-item-icon">
                  <Bell size={15} />
                </span>
                <div className="config-item-copy">
                  <strong>Task notifications</strong>
                  <span>{taskNotificationValue}</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="Task notifications"
                  aria-checked={s.taskNotificationsEnabled}
                  className={
                    "settings-switch" +
                    (s.taskNotificationsEnabled ? " is-on" : "")
                  }
                  onClick={() => {
                    void store.setTaskNotificationsEnabled(
                      !s.taskNotificationsEnabled,
                    );
                  }}
                >
                  <span />
                </button>
              </div>
              <ConfigMenuItem
                icon={<Keyboard size={15} />}
                label="Keyboard shortcuts"
                description="Presets, bindings, and help"
                onClick={() => {
                  setOpen(false);
                  setShortcutsOpen(true);
                }}
              />
              <ConfigMenuItem
                icon={<Keyboard size={15} />}
                label="Mobile terminal shortcuts"
                description={`${mobileTerminalShortcutCount(
                  mobileTerminalShortcuts,
                )} panel · ${mobileTerminalSideShortcuts.filter(Boolean).length} side`}
                onClick={() => {
                  setOpen(false);
                  setMobileShortcutsOpen(true);
                }}
              />
              <ConfigMenuItem
                icon={<GitBranch size={15} />}
                label="Automatic branch updates"
                description="Configure repository sync"
                onClick={() => {
                  setOpen(false);
                  setAutoSyncOpen(true);
                }}
              />
            </div>

            <div className="config-section config-section-tiles-3">
              <div className="config-title">Help & updates</div>
              <ConfigMenuItem
                icon={<ExternalLink size={15} />}
                label="Changelog"
                description="Recent changes on GitHub"
                onClick={() => {
                  setOpen(false);
                  window.open(RELEASES_URL, "_blank", "noopener,noreferrer");
                }}
              />

              <ConfigMenuItem
                icon={<RefreshCw size={15} />}
                label="Reload page"
                description="Refresh the application"
                onClick={() => {
                  setOpen(false);
                  reloadApplicationPage();
                }}
              />
              <ConfigMenuItem
                icon={<Download size={15} />}
                label={
                  canInstallUpdate
                    ? s.updateInstalling
                      ? "Updating..."
                      : `Update to ${updateVersion}`
                    : updateAvailable
                      ? `Version ${updateVersion} available`
                      : "Check for updates"
                }
                description={
                  canInstallUpdate
                    ? "Install and restart"
                    : updateAvailable
                      ? "Automatic install unavailable"
                      : "Check the release server"
                }
                primary={canInstallUpdate}
                onClick={() => {
                  setOpen(false);
                  void store.updateOrCheck();
                }}
                disabled={s.updateInstalling}
              />
            </div>

            <div className="config-section">
              <div className="config-title">Runtime</div>
              <div className="config-runtime-row">
                <span className="config-item-icon">
                  <Server size={15} />
                </span>
                <div className="config-item-copy">
                  <strong>Herdr server</strong>
                  <span>
                    {herdrInfo?.version
                      ? `Version ${herdrInfo.version}`
                      : "Loading server information"}
                  </span>
                </div>
                <code>
                  {typeof herdrInfo?.protocol === "number"
                    ? `Protocol ${herdrInfo.protocol}`
                    : "-"}
                </code>
              </div>
              <button
                type="button"
                className="config-details-toggle"
                aria-expanded={connectionDetailsOpen}
                onClick={() => setConnectionDetailsOpen((value) => !value)}
              >
                <span className="config-item-icon">
                  <Wifi size={15} />
                </span>
                <span>Connection details</span>
                {connectionDetailsOpen ? (
                  <ChevronDown size={15} />
                ) : (
                  <ChevronRight size={15} />
                )}
              </button>
              {connectionDetailsOpen ? (
                <div className="config-details">
                  <ConfigRow label="URL" value={location.origin} />
                  <ConfigRow label="Socket" value={health?.socket ?? "-"} />
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      {shortcutsOpen ? (
        <Suspense fallback={null}>
          <ShortcutLookupDialog open onClose={() => setShortcutsOpen(false)} />
        </Suspense>
      ) : null}
      <MobileTerminalShortcutsDialog
        open={mobileShortcutsOpen}
        rows={mobileTerminalShortcuts}
        sideShortcuts={mobileTerminalSideShortcuts}
        onChange={onMobileTerminalShortcutsChange}
        onSideChange={onMobileTerminalSideShortcutsChange}
        onClose={() => setMobileShortcutsOpen(false)}
      />
      {terminalThemesOpen ? (
        <Suspense fallback={null}>
          <TerminalThemeDialog
            open
            selection={terminalThemeSelection}
            customThemes={customTerminalThemes}
            onSelectionChange={onTerminalThemeSelectionChange}
            onCustomThemesChange={onCustomTerminalThemesChange}
            onClose={() => setTerminalThemesOpen(false)}
          />
        </Suspense>
      ) : null}
      <Suspense fallback={null}>
        {mobileLayoutOpen ? (
          <MobileLayoutDialog
            open={mobileLayoutOpen}
            onClose={() => {
              setMobileLayoutOpen(false);
              window.requestAnimationFrame(() => triggerRef.current?.focus());
            }}
          />
        ) : null}
      </Suspense>
      <AutoSyncRepositoriesDialog
        open={autoSyncOpen}
        onClose={() => setAutoSyncOpen(false)}
      />
    </>
  );
}

function ConfigMenuItem({
  icon,
  label,
  description,
  onClick,
  disabled = false,
  primary = false,
  className,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`config-menu-item${primary ? " is-primary" : ""}${className ? ` ${className}` : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="config-item-icon">{icon}</span>
      <span className="config-item-copy">
        <strong>{label}</strong>
        <span>{description}</span>
      </span>
      <ChevronRight size={15} />
    </button>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="config-row">
      <span>{label}</span>
      <code title={value}>{value}</code>
    </div>
  );
}

function taskNotificationStatus(
  enabled: boolean,
  permission: NotificationPermission | "unsupported",
) {
  if (permission === "unsupported") return "Unsupported";
  if (enabled && permission === "granted") return "On";
  if (permission === "denied") return "Blocked";
  return "Off";
}
