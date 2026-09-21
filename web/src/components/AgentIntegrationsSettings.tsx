import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Info, RefreshCw, Trash2 } from "lucide-react";
import { AgentIcon } from "./AgentIcon";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import {
  connectionClientScopeKey,
  useConnectionClient,
} from "../useConnectionClient";
import { focusIfUnchanged } from "./dialogFocus";
import "./AgentIntegrationsSettings.css";

export type AgentIntegration = {
  target: string;
  label: string;
  command: string;
  available: boolean;
  state: "not_installed" | "current" | "outdated";
  installed_version?: number;
  available_version?: number;
};

export function parseAgentIntegrations(result: unknown): AgentIntegration[] {
  const items = (result as { integrations?: unknown } | null)?.integrations;
  const targets = new Set<string>();
  if (
    !Array.isArray(items) ||
    !items.every((item) => {
      if (
        !item ||
        typeof item.target !== "string" ||
        !item.target.trim() ||
        targets.has(item.target) ||
        typeof item.label !== "string" ||
        !item.label.trim() ||
        typeof item.command !== "string" ||
        typeof item.available !== "boolean" ||
        !["not_installed", "current", "outdated"].includes(item.state) ||
        [item.installed_version, item.available_version].some(
          (version) =>
            version !== undefined &&
            (!Number.isSafeInteger(version) || version < 0),
        )
      )
        return false;
      targets.add(item.target);
      return true;
    })
  )
    throw new Error("Invalid integration list received from Herdr.");
  return items;
}

type IntegrationChangeOutcome = { messages: string[]; error: string | null };

// A submitted RPC outlives its settings view. Keep its outcome until a view
// on the same connection lease displays it, even if it settles while unmounted.
const pendingChanges = new Map<string, Promise<IntegrationChangeOutcome>>();

const stateLabels = {
  not_installed: "Ready to install",
  current: "Up to date",
  outdated: "Update available",
};

const INTEGRATION_DESCRIPTION =
  "Changes apply to the Herdr server user's configuration, shared across its sessions. " +
  "Integrations do not install agent applications. Start a new agent session after installation if reporting has not started. " +
  "Versions refer to Herdr integration scripts, not agent applications. Missing API versions are supplemented by `herdr integration status` on the selected server's machine when the CLI matches the running Herdr version and integration state. " +
  "The bridge or SSH account must use the same agent configuration as the Herdr server. Unavailable version information stays unknown. " +
  "Available versions are bundled with that server, not checked online.";

export function AgentIntegrationsSettings({
  connectionLabel,
  sshDestination,
}: {
  connectionLabel: string;
  sshDestination?: string;
}) {
  const client = useConnectionClient();
  const scope = connectionClientScopeKey(
    client,
    client.serverRuntimeGeneration,
  );
  const [items, setItems] = useState<AgentIntegration[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const destination = sshDestination
    ? `${connectionLabel} (${sshDestination})`
    : connectionLabel;

  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setError(null);
    const operation = pendingChanges.get(scope);
    let outcome: IntegrationChangeOutcome | undefined;
    try {
      outcome = await operation;
      if (
        !mounted.current ||
        !client.isCurrent() ||
        request !== sequence.current
      )
        return;
      const integrations = parseAgentIntegrations(
        await client.call("integration.list"),
      );
      if (
        mounted.current &&
        client.isCurrent() &&
        request === sequence.current
      ) {
        setItems(integrations);
        if (outcome?.messages) setMessages(outcome.messages);
        if (outcome?.error) setError(outcome.error);
      }
    } catch (e) {
      if (
        mounted.current &&
        client.isCurrent() &&
        request === sequence.current
      ) {
        setItems(null);
        setError(
          [
            outcome?.error,
            `Could not load integrations: ${(e as Error).message}`,
          ]
            .filter(Boolean)
            .join(" "),
        );
      }
    } finally {
      if (
        mounted.current &&
        client.isCurrent() &&
        request === sequence.current
      ) {
        if (outcome) {
          setMessages(outcome.messages);
          if (pendingChanges.get(scope) === operation)
            pendingChanges.delete(scope);
        }
        setLoading(false);
      }
    }
  }, [client, scope]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const change = async (
    item: AgentIntegration,
    action: "install" | "uninstall",
  ) => {
    if (
      pendingChanges.has(scope) ||
      loading ||
      !client.isCurrent() ||
      (action === "install" && !item.available)
    )
      return;
    const verb =
      action === "uninstall"
        ? "Uninstall"
        : item.state === "outdated"
          ? "Update"
          : "Install";
    if (
      !window.confirm(
        `${verb} the ${item.label} integration on ${destination}?\n\n` +
          "This changes the Herdr server user's agent configuration, shared across its sessions. " +
          "It does not install or uninstall the agent application. " +
          "Existing agent sessions may need to be restarted for the change to take effect.",
      ) ||
      !client.isCurrent()
    )
      return;
    const source = document.activeElement;
    const operation: Promise<IntegrationChangeOutcome> = client
      .call(`integration.${action}`, { target: item.target })
      .then((result) => {
        if (
          result?.target !== item.target ||
          !Array.isArray(result?.details?.messages) ||
          !result.details.messages.every(
            (message: unknown) => typeof message === "string",
          )
        )
          throw new Error("Invalid integration result received from Herdr.");
        return {
          messages: [
            `${verb} completed for ${item.label}.`,
            ...result.details.messages,
          ],
          error: null,
        };
      })
      .catch((e: Error) => ({
        messages: [],
        error: `${verb} could not be confirmed: ${e.message} Refresh status before trying again.`,
      }));
    pendingChanges.set(scope, operation);
    void operation.then(() => {
      if (!client.isCurrent() && pendingChanges.get(scope) === operation)
        pendingChanges.delete(scope);
    });
    setBusy(item.target);
    setError(null);
    setMessages([]);
    try {
      const outcome = await operation;
      if (!mounted.current || !client.isCurrent()) return;
      if (pendingChanges.get(scope) === operation) pendingChanges.delete(scope);
      if (outcome.error) {
        setItems(null);
        setError(outcome.error);
      } else {
        setMessages(outcome.messages);
        await load();
      }
    } finally {
      if (mounted.current && client.isCurrent()) {
        setBusy(null);
        window.requestAnimationFrame(() => {
          if (mounted.current && client.isCurrent())
            focusIfUnchanged(refreshButton.current, source);
        });
      }
    }
  };

  const disabled = loading || busy !== null || !client.isCurrent();
  const visible = (items ?? [])
    .filter((item) => item.available || item.state !== "not_installed")
    .sort((a, b) => {
      const rank = { outdated: 0, current: 1, not_installed: 2 };
      return rank[a.state] - rank[b.state];
    });
  const unavailable = (items ?? []).filter(
    (item) => !item.available && item.state === "not_installed",
  );
  const renderList = (list: AgentIntegration[]) => (
    <ul className="agent-integrations-list">
      {list.map((item) => (
        <li key={item.target} data-state={item.state}>
          <AgentIcon agent={item.target} />
          <div className="agent-integrations-copy">
            <strong>{item.label}</strong>
            <div className="agent-integrations-meta">
              {item.state !== "not_installed" ? (
                <span className="agent-integrations-version">
                  <span
                    title={
                      item.installed_version === undefined
                        ? "Version metadata is unavailable from the server API and CLI. Run `herdr integration status` on the server using the bridge or SSH account to inspect it."
                        : "Installed integration version"
                    }
                  >
                    {item.installed_version === undefined
                      ? "Version unavailable"
                      : `v${item.installed_version}`}
                  </span>
                  {item.state === "outdated" &&
                  item.available_version !== undefined ? (
                    <>
                      <ArrowRight size={12} aria-label="update to" />
                      <span title="Available integration version">
                        v{item.available_version}
                      </span>
                    </>
                  ) : null}
                </span>
              ) : null}
              <span
                className="agent-integrations-badge"
                data-state={item.state}
              >
                {!item.available && item.state === "not_installed"
                  ? "Agent not detected"
                  : stateLabels[item.state]}
              </span>
            </div>
            {!item.available && item.state !== "not_installed" ? (
              <span
                className="agent-integrations-missing"
                title={`Command not found: ${item.command}`}
              >
                Agent not on PATH
              </span>
            ) : null}
          </div>
          <div className="agent-integrations-actions">
            {item.state !== "current" ? (
              <button
                type="button"
                className={
                  item.state === "outdated" ? "agent-integrations-update" : ""
                }
                aria-label={`${item.state === "outdated" ? "Update" : "Install"} ${item.label} integration`}
                aria-disabled={disabled || !item.available}
                title={
                  !item.available
                    ? `Command not found: ${item.command}`
                    : undefined
                }
                onClick={() => void change(item, "install")}
              >
                {item.state === "outdated" ? "Update" : "Install"}
              </button>
            ) : null}
            {item.state !== "not_installed" ? (
              <button
                type="button"
                className="agent-integrations-icon-button agent-integrations-uninstall"
                aria-label={`Uninstall ${item.label} integration`}
                title={`Uninstall ${item.label} integration`}
                aria-disabled={disabled}
                onClick={() => void change(item, "uninstall")}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="agent-integrations-settings">
      <div className="agent-integrations-toolbar">
        <div className="agent-integrations-heading">
          <strong>{destination}</strong>
          <span>Agent integrations</span>
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="agent-integrations-icon-button"
              aria-label="About agent integrations"
              title="About agent integrations"
            >
              <Info size={16} aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            className="configuration-help-content"
            aria-label="About agent integrations"
            collisionPadding={12}
          >
            {INTEGRATION_DESCRIPTION}
          </PopoverContent>
        </Popover>
        <button
          ref={refreshButton}
          type="button"
          className="agent-integrations-icon-button"
          aria-label="Refresh integrations"
          title="Refresh integrations"
          aria-disabled={disabled}
          onClick={() => {
            if (!pendingChanges.has(scope) && !disabled) void load();
          }}
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </div>
      <div role="status" className="agent-integrations-status">
        {busy
          ? "Applying integration change..."
          : loading
            ? "Loading integrations..."
            : null}
        {messages.map((message, index) => (
          <div key={index}>{message}</div>
        ))}
      </div>
      {error ? (
        <div className="configuration-error" role="alert">
          <span>
            {error} If this Herdr server does not support integration
            management, update Herdr.
          </span>
        </div>
      ) : null}
      {items?.length === 0 ? (
        <p className="configuration-scope">
          No agent integrations reported by Herdr.
        </p>
      ) : null}
      {visible.length > 0 ? renderList(visible) : null}
      {unavailable.length > 0 ? (
        <details className="agent-integrations-unavailable">
          <summary>
            Other agents <span>{unavailable.length}</span>
          </summary>
          {renderList(unavailable)}
        </details>
      ) : null}
    </div>
  );
}
