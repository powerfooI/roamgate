import { lazyWithReload } from "../lazyWithReload";
import type { ReactNode } from "react";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Focus,
  LogOut,
  Palette,
  Plug,
  RefreshCw,
  SlidersHorizontal,
  Server,
  Settings,
  Wifi,
} from "lucide-react";
import packageJson from "../../package.json";
import { logoutBrowserSession } from "../api";
import { connectionHttpPath } from "../connectionHttp";
import { useLayoutPreferences } from "../layoutPreferences";
import { shortcutLabel, useShortcutPreferences } from "../shortcutPreferences";
import { shallowEqual, store, useStoreSelector } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import type {
  ConfigurationProps,
  ConfigurationTab,
} from "./ConfigurationDialog";
import { ConfigurationLoadingDialog } from "./ConfigurationLoadingDialog";
import { HerdrSetupCard } from "./HerdrSetupCard";
import { MobileSheetHandle } from "./MobileSheetHandle";
import "./ConfigMenu.css";

const ConfigurationDialog = lazyWithReload("configuration", () =>
  import("./ConfigurationDialog").then((module) => ({
    default: module.ConfigurationDialog,
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

type ConfigMenuProps = ConfigurationProps & {
  zenMode: boolean;
  onZenModeChange: (zenMode: boolean) => void;
};

export function ConfigMenu({
  zenMode,
  onZenModeChange,
  ...configuration
}: ConfigMenuProps) {
  const s = useStoreSelector(
    (state) => ({
      bridgeStatus: state.bridgeStatus,
      activeConnectionId: state.activeConnectionId,
      defaultConnectionId: state.defaultConnectionId,
      connectionPaused: state.connectionPaused,
      status: state.status,
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
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [configurationTab, setConfigurationTab] =
    useState<ConfigurationTab | null>(null);
  const [connectionDetailsOpen, setConnectionDetailsOpen] = useState(false);
  const [health, setHealth] = useState<{
    socket?: string;
    auth_required?: boolean;
  } | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [herdrInfo, setHerdrInfo] = useState<{
    version: string;
    protocol: number;
  } | null>(null);
  const [herdrUnavailable, setHerdrUnavailable] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = () => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const closeConfiguration = useCallback(() => {
    setConfigurationTab(null);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setHealth(null);
    setHerdrInfo(null);
    setHerdrUnavailable(false);
    fetch("/api/health", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((info) => {
        if (!cancelled) setHealth(info);
      });
    if (connectionClient.isCurrent()) {
      const url = new URL(
        connectionHttpPath(
          connectionClient.connectionId,
          "/herdr-info",
          connectionClient.serverRuntimeGeneration,
        ),
        window.location.origin,
      );
      if (url.origin === window.location.origin)
        fetch(url, { credentials: "same-origin", cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
          .then((info) => {
            if (cancelled || !connectionClient.isCurrent()) return;
            if (info) setHerdrInfo(info);
            else setHerdrUnavailable(true);
          });
    }
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node))
        setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
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
          onClick={() => {
            setExpanded(false);
            setLogoutError("");
            setOpen((value) => !value);
          }}
          aria-label={updateAvailable ? "Menu, update available" : "Menu"}
          aria-controls={open ? CONFIG_MENU_ID : undefined}
          aria-expanded={open}
          aria-haspopup="dialog"
        >
          Menu{updateAvailable ? <span className="menu-update-dot" /> : null}
        </button>
        {open ? (
          <div
            id={CONFIG_MENU_ID}
            className={`config-dropdown mobile-sheet${expanded ? " is-expanded" : ""}`}
            role="dialog"
            aria-label="Application menu"
          >
            <MobileSheetHandle
              label={
                expanded ? "Show fewer menu options" : "Show more menu options"
              }
              expanded={expanded}
              onExpand={() => setExpanded(true)}
              onCollapse={() => setExpanded(false)}
              onClose={closeMenu}
              onClick={() => setExpanded((value) => !value)}
            />
            <div className="config-dropdown-content">
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
                <ConfigMenuItem
                  icon={<Settings size={15} />}
                  label="Configuration"
                  description="Appearance, behavior, connections, and agent integrations"
                  className="config-menu-item-row"
                  onClick={() => {
                    setOpen(false);
                    setConfigurationTab("Appearance");
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
                  disabled={s.updateInstalling}
                  onClick={() => {
                    setOpen(false);
                    void store.updateOrCheck();
                  }}
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
                        : herdrUnavailable
                          ? "Unavailable"
                          : "Loading server information"}
                    </span>
                  </div>
                  <code>
                    {typeof herdrInfo?.protocol === "number"
                      ? `Protocol ${herdrInfo.protocol}`
                      : "-"}
                  </code>
                </div>
                {herdrUnavailable ? (
                  <HerdrSetupCard
                    key={connectionClient.connectionId}
                    enabled={
                      !s.connectionPaused &&
                      s.activeConnectionId === s.defaultConnectionId
                    }
                    compact
                  />
                ) : null}
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
              {health?.auth_required ? (
                <div className="config-section">
                  <ConfigMenuItem
                    icon={<LogOut size={15} />}
                    label={loggingOut ? "Logging out..." : "Log out"}
                    description="End this browser session only"
                    className="config-menu-item-row"
                    disabled={loggingOut}
                    onClick={async () => {
                      setLoggingOut(true);
                      setLogoutError("");
                      try {
                        await logoutBrowserSession();
                      } catch {
                        setLogoutError(
                          "Could not log out. Check your connection and try again.",
                        );
                        setLoggingOut(false);
                      }
                    }}
                  />
                  {logoutError ? (
                    <p className="config-logout-error" role="alert">
                      {logoutError}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {layout.mobile ? (
                <div className="mobile-sheet-more" aria-hidden={!expanded}>
                  <div className="mobile-sheet-more-content">
                    <div className="config-section">
                      <div className="config-title">Quick settings</div>
                      {(
                        [
                          ["Appearance", Palette],
                          ["Behavior", SlidersHorizontal],
                          ["Connection", Server],
                          ["Integrations", Plug],
                        ] as const
                      ).map(([name, Icon]) => (
                        <ConfigMenuItem
                          key={name}
                          icon={<Icon size={15} />}
                          label={name}
                          onClick={() => {
                            setOpen(false);
                            setConfigurationTab(name);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      {configurationTab ? (
        <Suspense
          fallback={<ConfigurationLoadingDialog onClose={closeConfiguration} />}
        >
          <ConfigurationDialog
            {...configuration}
            initialTab={configurationTab}
            onClose={closeConfiguration}
          />
        </Suspense>
      ) : null}
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
  description?: string;
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
        {description ? <span>{description}</span> : null}
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
