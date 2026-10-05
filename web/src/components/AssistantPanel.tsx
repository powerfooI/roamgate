import {
  ChevronLeft,
  Compass,
  ExternalLink,
  History,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Square,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  Fragment,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ASSISTANT_MAX_WORKSPACES,
  type AssistantAction,
  type AssistantAuthState,
  type AssistantConfig,
  type AssistantMessage,
  type AssistantModelConnection,
  type AssistantSnapshot,
  type AssistantSource,
  type AssistantWorkspace,
  type AssistantWorkspaceRef,
} from "../../../shared/assistant";
import { bridge } from "../api";
import type { RangerTaskNotificationTarget } from "../taskNotifications";
import {
  assistantActionExecuting,
  callAssistant,
  parseAssistantContext,
  refreshAssistant,
  sendAssistant,
  setAssistantDraft,
  useAssistantState,
} from "../assistant";
import { formatUiDateTime } from "../uiLocale";
import { useStoreSelector } from "../store";
import { MarkdownPreview } from "./markdown";
import { ConfirmDialog } from "./ModalDialogs";
import { ThemedSelect } from "./ThemedSelect";
import { AssistantConversationMap } from "./AssistantConversationMap";
import { AssistantTasks, TaskProposalCard } from "./AssistantTasks";
import "./AssistantPanel.css";

function workspaceKey(workspace: AssistantWorkspaceRef) {
  return JSON.stringify([workspace.connection_id, workspace.workspace_id]);
}

function includesWorkspace(
  workspaces: AssistantWorkspaceRef[],
  workspace: AssistantWorkspaceRef,
) {
  return workspaces.some(
    (item) => workspaceKey(item) === workspaceKey(workspace),
  );
}

function toggleWorkspace(
  workspaces: AssistantWorkspaceRef[],
  workspace: AssistantWorkspaceRef,
) {
  return includesWorkspace(workspaces, workspace)
    ? workspaces.filter(
        (item) => workspaceKey(item) !== workspaceKey(workspace),
      )
    : [
        ...workspaces,
        {
          connection_id: workspace.connection_id,
          workspace_id: workspace.workspace_id,
        },
      ];
}

function connectionReady(snapshot: AssistantSnapshot) {
  return (
    !!snapshot.config.provider &&
    !!snapshot.config.model &&
    snapshot.providers.some(
      (provider) =>
        provider.id === snapshot.config.provider && provider.configured,
    ) &&
    snapshot.models.some(
      (model) =>
        model.provider === snapshot.config.provider &&
        model.id === snapshot.config.model,
    )
  );
}

function credentialStatus(provider: AssistantSnapshot["providers"][number]) {
  if (!provider.configured) return "No saved credentials";
  return provider.credential_method === "oauth"
    ? "Saved login (OAuth)"
    : provider.credential_method === "api_key"
      ? "API key saved"
      : "Credentials saved";
}

export function AssistantMessageActivity({
  message,
  running,
  onOpenSource,
}: {
  message: Pick<AssistantMessage, "tools" | "sources">;
  running: boolean;
  onOpenSource: (source: AssistantSource) => void;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (details.current) details.current.open = running;
  }, [running]);
  return (
    <details className="assistant-tools" ref={details}>
      <summary>
        {running && message.tools.some((tool) => tool.status === "running")
          ? "Reading workspace context"
          : "Work performed"}{" "}
        ({message.tools.length + message.sources.length})
      </summary>
      {message.tools.length ? (
        <ul>
          {message.tools.map((tool) => (
            <li key={tool.id}>
              <span>{tool.name}</span>
              <span className={`assistant-tool-state is-${tool.status}`}>
                {tool.status}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {message.sources.length ? (
        <div className="assistant-sources" aria-label="Sources">
          {message.sources.map((source) => (
            <button
              type="button"
              key={source.id}
              onClick={() => onOpenSource(source)}
            >
              <span>
                <ExternalLink size={12} /> {source.title}
              </span>
              <small>Read {formatUiDateTime(source.read_at)}</small>
            </button>
          ))}
        </div>
      ) : null}
    </details>
  );
}

function AssistantModelForm({
  config,
  provider,
  providers,
  selectedModel,
  tasksRunning,
  onSave,
}: {
  config: AssistantConfig;
  provider: AssistantSnapshot["providers"][number] | undefined;
  providers: AssistantSnapshot["providers"];
  selectedModel: AssistantSnapshot["models"][number] | undefined;
  tasksRunning: boolean;
  onSave(input: AssistantModelConnection): Promise<boolean>;
}) {
  const custom = selectedModel?.custom ?? provider?.custom;
  const [providerId, setProviderId] = useState(
    custom ? (provider?.id ?? "") : "",
  );
  const [model, setModel] = useState(custom ? config.model : "");
  const [baseUrl, setBaseUrl] = useState(custom?.base_url ?? "");
  const [api, setApi] = useState(custom?.api ?? "openai-completions");
  const [apiKey, setApiKey] = useState("");
  const keySaved = providers.some(
    (item) => item.id === providerId.trim() && item.configured,
  );
  return (
    <details className="assistant-custom-model">
      <summary>
        {custom ? "Edit custom model" : "Configure custom model"}
      </summary>
      <form
        aria-label="Custom model connection"
        onSubmit={async (event) => {
          event.preventDefault();
          if (tasksRunning) return;
          if (
            await onSave({
              provider: providerId.trim(),
              model: model.trim(),
              base_url: baseUrl.trim(),
              api,
              ...(apiKey ? { api_key: apiKey } : {}),
              credential_source: config.credential_source,
            })
          )
            setApiKey("");
        }}
      >
        <label className="form-field">
          <span>Provider ID</span>
          <input
            aria-label="Custom provider ID"
            required
            maxLength={64}
            pattern="[a-zA-Z0-9][a-zA-Z0-9_.:-]*"
            autoComplete="off"
            spellCheck={false}
            placeholder="my-provider"
            value={providerId}
            onChange={(event) => setProviderId(event.currentTarget.value)}
          />
        </label>
        <label className="form-field">
          <span>API format</span>
          <ThemedSelect
            aria-label="Custom API format"
            value={api}
            options={[
              { value: "openai-completions", label: "OpenAI Chat Completions" },
              { value: "openai-responses", label: "OpenAI Responses" },
              { value: "anthropic-messages", label: "Anthropic Messages" },
            ]}
            onChange={(value) => setApi(value as typeof api)}
          />
        </label>
        <label className="form-field">
          <span>API base URL</span>
          <input
            type="url"
            aria-label="Custom API base URL"
            required
            maxLength={2000}
            autoComplete="off"
            spellCheck={false}
            placeholder="https://api.example.com/v1"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.currentTarget.value)}
          />
        </label>
        <label className="form-field">
          <span>Model ID</span>
          <input
            aria-label="Custom model ID"
            required
            maxLength={500}
            autoComplete="off"
            spellCheck={false}
            placeholder="your-model-id"
            value={model}
            onChange={(event) => setModel(event.currentTarget.value)}
          />
        </label>
        <label className="form-field">
          <span>API key</span>
          <input
            type="password"
            aria-label="Custom API key"
            required={!keySaved}
            maxLength={10000}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={
              keySaved ? "Leave blank to keep the saved key" : "API key"
            }
            value={apiKey}
            onChange={(event) => setApiKey(event.currentTarget.value)}
          />
        </label>
        <p className="assistant-hint">
          {config.credential_source === "pi"
            ? "Saved to Pi on the bridge host and shared with Pi."
            : "Saved for Ranger on the bridge host."}{" "}
          For a local server without authentication, enter a dummy key.
        </p>
        {tasksRunning ? (
          <p className="assistant-hint">
            Stop running tasks before changing a model connection.
          </p>
        ) : null}
        <button type="submit" disabled={tasksRunning}>
          Save custom model
        </button>
      </form>
    </details>
  );
}

const actionNames: Record<AssistantAction["kind"], string> = {
  create_workspace: "Create workspace",
  create_worktree: "Create worktree",
  create_tab: "Create tab",
  split_pane: "Split pane",
  start_agent: "Start agent",
  send_prompt: "Send prompt",
};

const actionStatuses: Record<AssistantAction["status"], string> = {
  pending: "Needs confirmation",
  executing: "Executing",
  succeeded: "Succeeded",
  failed: "Failed",
  uncertain: "Outcome uncertain",
  cancelled: "Cancelled",
};

const actionFields = new Map([
  ["cwd", "Working directory"],
  ["label", "Workspace label"],
  ["branch", "Branch"],
  ["pane_id", "Target pane"],
  ["tab_id", "Source tab"],
  ["terminal_id", "Source terminal"],
  ["direction", "Split direction"],
  ["agent", "Agent"],
  ["name", "Agent name"],
  ["prompt", "Prompt"],
  ["base", "Base branch"],
  ["setup_hook", "Setup command"],
  ["setup_hook_enabled", "Run setup command"],
]);

export function ActionCard({
  action,
  busy,
  running,
  run,
}: {
  action: AssistantAction;
  busy: boolean;
  running: boolean;
  run: (action: string, params?: Record<string, unknown>) => Promise<boolean>;
}) {
  const name = actionNames[action.kind];
  const isPrompt = action.kind === "send_prompt";
  const isAgentAction = isPrompt || action.kind === "start_agent";
  const acceptedPrompt =
    isPrompt &&
    action.status === "uncertain" &&
    action.detail ===
      "Herdr accepted the prompt. Delivery and the agent's response have not been independently verified. Do not resend automatically.";
  const details = (
    <dl
      className="assistant-action-details"
      aria-label={`${name} details`}
      tabIndex={0}
    >
      <dt>Connection</dt>
      <dd>
        {action.connection_label}
        <small>{action.connection_id}</small>
      </dd>
      <dt>Workspace</dt>
      <dd>
        {action.workspace_label}
        <small>{action.workspace_id}</small>
      </dd>
      {!isAgentAction ? (
        <>
          <dt>Proposed</dt>
          <dd>
            <time dateTime={action.created_at}>
              {formatUiDateTime(action.created_at)}
            </time>
          </dd>
        </>
      ) : null}
      {Object.entries(action.params)
        .filter(
          ([key]) =>
            !(isPrompt && key === "prompt") &&
            (key !== "terminal_id" ||
              action.kind === "create_tab" ||
              action.kind === "split_pane"),
        )
        .map(([key, value]) => (
          <Fragment key={key}>
            <dt>
              {key === "cwd" && action.kind === "create_worktree"
                ? "Source repository"
                : key === "pane_id" &&
                    (action.kind === "create_tab" ||
                      action.kind === "split_pane")
                  ? "Source pane"
                  : (actionFields.get(key) ?? key)}
            </dt>
            <dd>
              <pre>
                {key === "setup_hook_enabled" &&
                (value === "true" || value === "false")
                  ? value === "true"
                    ? "Enabled"
                    : "Disabled"
                  : key === "direction" && action.kind === "split_pane"
                    ? value === "right"
                      ? "Right"
                      : value === "down"
                        ? "Down"
                        : value
                    : value}
              </pre>
            </dd>
          </Fragment>
        ))}
    </dl>
  );
  return (
    <div
      className={`assistant-action-card is-${action.status}${isAgentAction ? " is-agent-action" : ""}${isPrompt ? " is-prompt" : ""}`}
      role="group"
      aria-label={`${name} proposal`}
      tabIndex={-1}
    >
      <div className="assistant-action-head">
        <strong>{name}</strong>
        <span role="status">
          {isPrompt && action.status === "uncertain"
            ? "Unverified"
            : actionStatuses[action.status]}
        </span>
      </div>
      {isAgentAction ? (
        <>
          <div className="assistant-action-target assistant-prompt-target">
            <strong>{action.workspace_label}</strong>
            <span>{action.connection_label}</span>
            <code>{action.params.pane_id}</code>
            {action.params.agent ? <code>{action.params.agent}</code> : null}
          </div>
          {!isPrompt && action.params.name ? (
            <div className="assistant-action-agent-name">
              Name <code>{action.params.name}</code>
            </div>
          ) : null}
          {action.status === "pending" ? (
            <p className="assistant-action-note assistant-prompt-note">
              {isPrompt
                ? "Review before sending. The agent may change files."
                : "Start this agent with no custom command or arguments."}
            </p>
          ) : null}
          {isPrompt ? (
            <details
              className="assistant-prompt-content"
              open={
                action.status === "pending" || action.status === "executing"
              }
            >
              <summary>
                Prompt
                <span>{action.params.prompt?.length ?? 0} characters</span>
              </summary>
              <pre aria-label="Exact prompt" tabIndex={0}>
                {action.params.prompt}
              </pre>
            </details>
          ) : null}
          <details className="assistant-action-meta">
            <summary>
              Details
              <time dateTime={action.created_at}>
                {formatUiDateTime(action.created_at)}
              </time>
            </summary>
            {details}
            {!isPrompt ? <p>{action.summary}</p> : null}
            {acceptedPrompt ? <p>{action.detail}</p> : null}
          </details>
        </>
      ) : (
        <>
          <p>{action.summary}</p>
          {details}
        </>
      )}
      {action.detail ? (
        <p
          role="status"
          className={
            isAgentAction
              ? "assistant-action-note assistant-prompt-note"
              : undefined
          }
        >
          {acceptedPrompt
            ? "Accepted by Herdr; delivery unverified. Check the agent before resending."
            : action.detail}
        </p>
      ) : null}
      {action.status === "pending" ? (
        <div className="assistant-action-buttons">
          <button
            type="button"
            disabled={busy || running}
            onClick={(event) => {
              if (busy || running) return;
              event.currentTarget
                .closest<HTMLElement>(".assistant-action-card")
                ?.focus({ preventScroll: true });
              void run("action.confirm", { action_id: action.id });
            }}
          >
            Confirm action
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy || running}
            onClick={(event) => {
              if (busy || running) return;
              event.currentTarget
                .closest<HTMLElement>(".assistant-action-card")
                ?.focus({ preventScroll: true });
              void run("action.cancel", { action_id: action.id });
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function assistantAuthUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function AuthCard({
  auth,
  label,
  busy,
  run,
}: {
  auth: AssistantAuthState;
  label: string;
  busy: boolean;
  run: (action: string, params?: Record<string, unknown>) => Promise<boolean>;
}) {
  const [value, setValue] = useState(auth.prompt?.options?.[0]?.id ?? "");
  const url = assistantAuthUrl(auth.url);
  const pending = auth.status === "waiting" || auth.status === "working";
  return (
    <div className="assistant-auth-card" aria-label="Model login">
      <strong>
        {auth.status === "completed"
          ? `${label} connected`
          : `Connect ${label}`}
      </strong>
      <p role="status">{auth.message}</p>
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer">
          Open sign-in page <ExternalLink size={13} />
        </a>
      ) : null}
      {auth.user_code ? (
        <div className="assistant-device-code">
          <span>Enter this code on the sign-in page</span>
          <code>{auth.user_code}</code>
        </div>
      ) : null}
      {auth.prompt && pending ? (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy || !value.trim()) return;
            const submitted = value;
            setValue("");
            await run("auth.respond", {
              auth_id: auth.id,
              prompt_id: auth.prompt!.id,
              value: submitted,
            });
          }}
        >
          <label className="form-field">
            <span>{auth.prompt.message}</span>
            {auth.prompt.type === "select" ? (
              <ThemedSelect
                value={value}
                options={(auth.prompt.options ?? []).map((option) => ({
                  value: option.id,
                  label: option.label,
                }))}
                aria-label={auth.prompt.message}
                onChange={setValue}
              />
            ) : (
              <input
                autoFocus
                type={
                  auth.prompt.type === "secret" ||
                  auth.prompt.type === "manual_code"
                    ? "password"
                    : "text"
                }
                value={value}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => setValue(event.currentTarget.value)}
              />
            )}
          </label>
          <button type="submit" disabled={busy || !value.trim()}>
            Continue
          </button>
        </form>
      ) : null}
      {pending ? (
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => void run("auth.cancel", { auth_id: auth.id })}
        >
          Cancel login
        </button>
      ) : null}
      {auth.status === "failed" ? (
        <span className="assistant-hint">
          Use a connection button to retry.
        </span>
      ) : null}
    </div>
  );
}

export function AssistantPanel({
  open,
  floating,
  mobile,
  requestedTask,
  onRequestedTaskHandled,
  onClose,
  onToggleFloating,
  onOpenSource,
}: {
  open: boolean;
  floating: boolean;
  mobile: boolean;
  requestedTask?: RangerTaskNotificationTarget | null;
  onRequestedTaskHandled?: () => void;
  onClose: () => void;
  onToggleFloating: () => void;
  onOpenSource: (source: AssistantSource) => void;
}) {
  const state = useAssistantState();
  const snapshot = state.snapshot;
  const connectionSignature = useStoreSelector((snapshot) =>
    snapshot.connections
      .map(({ id, state, generation }) =>
        JSON.stringify([id, state, generation]),
      )
      .sort()
      .join(","),
  );
  // Start with setup when needed, then respect the user's chosen panel.
  const [settingsOpen, setSettingsOpen] = useState<boolean | null>(null);
  const [config, setConfig] = useState<AssistantConfig | null>(null);
  const [workspaces, setWorkspaces] = useState<AssistantWorkspace[]>([]);
  const [contextErrors, setContextErrors] = useState<string[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const [scope, setScope] = useState<AssistantWorkspaceRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [view, setView] = useState<"chat" | "tasks">("chat");
  const [confirmApproval, setConfirmApproval] = useState(false);
  const [panelWidth, setPanelWidth] = useState(380);
  const [maximumWidth, setMaximumWidth] = useState(380);
  useEffect(() => {
    if (!requestedTask) return;
    setSettingsOpen(false);
    setHistoryOpen(false);
    setView("tasks");
  }, [requestedTask]);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const followingOutput = useRef(true);
  const composing = useRef(false);
  const pendingAction = useRef(false);
  const contextSequence = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const resizeStart = useRef<{
    pointerId: number;
    x: number;
    width: number;
    scale: number;
  } | null>(null);
  const width = Math.min(panelWidth, maximumWidth);
  const resizePanel = (next: number) =>
    setPanelWidth(Math.min(maximumWidth, Math.max(300, next)));
  useEffect(() => {
    const surfaces = panelRef.current?.parentElement;
    if (!open || !surfaces) return;
    const update = () => {
      const annotations = surfaces.querySelector<HTMLElement>(
        ":scope > .annotation-panel:not(.is-floating)",
      );
      setMaximumWidth(
        Math.max(
          380,
          surfaces.clientWidth -
            (annotations?.offsetWidth ?? 0) -
            (annotations ? 16 : 8) -
            240,
        ),
      );
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(surfaces);
    const stage = surfaces.querySelector(".workspace-stage");
    if (stage) observer.observe(stage);
    return () => observer.disconnect();
  }, [open, floating, mobile, maximized]);
  const savedConfig = snapshot
    ? JSON.stringify({
        provider: snapshot.config.provider,
        model: snapshot.config.model,
        credential_source: snapshot.config.credential_source,
        allowed_workspaces: snapshot.config.allowed_workspaces,
      })
    : "";
  const connected = state.connectionStatus === "connected";
  const ready = !!snapshot && connectionReady(snapshot);
  const showSettings = settingsOpen ?? (!!snapshot && !ready);
  const authPending =
    snapshot?.auth?.status === "waiting" ||
    snapshot?.auth?.status === "working";
  const executing = assistantActionExecuting(snapshot);
  const operationBusy = busy || executing;
  const completedActions = (snapshot?.messages ?? [])
    .flatMap((message) => message.actions ?? [])
    .filter((action) => !["pending", "executing"].includes(action.status))
    .map((action) => `${action.id}:${action.status}`)
    .join(",");
  const scopeAvailable = scope.filter(
    (workspace) =>
      !!snapshot &&
      includesWorkspace(snapshot.config.allowed_workspaces, workspace),
  );

  useEffect(() => {
    if (!savedConfig) return;
    setConfig(JSON.parse(savedConfig) as AssistantConfig);
  }, [savedConfig]);

  const loadContext = async () => {
    if (!connected || !state.supported) return;
    const sequence = ++contextSequence.current;
    setContextLoading(true);
    setContextErrors([]);
    try {
      const result = parseAssistantContext(
        await bridge.call("bridge.assistant.context"),
      );
      if (sequence !== contextSequence.current) return;
      setWorkspaces(result.workspaces);
      setContextErrors(result.errors);
    } catch (cause) {
      if (sequence === contextSequence.current)
        setContextErrors([
          cause instanceof Error ? cause.message : String(cause),
        ]);
    } finally {
      if (sequence === contextSequence.current) setContextLoading(false);
    }
  };

  useEffect(() => {
    const sequence = contextSequence;
    if (open && connected && state.supported) void loadContext();
    return () => {
      sequence.current++;
    };
    // Refresh when hosts change or actions finish, keeping unsaved config intact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connected, state.supported, completedActions, connectionSignature]);

  useEffect(() => {
    if (executing || snapshot?.running) {
      setConfirmNew(false);
      setConfirmApproval(false);
    }
  }, [executing, snapshot?.running]);

  useEffect(() => {
    followingOutput.current = true;
    setHistoryOpen(false);
    setConfirmNew(false);
    if (listRef.current)
      listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [snapshot?.session_id]);

  useEffect(() => {
    if (!open) return;
    if (followingOutput.current && listRef.current)
      listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [open, snapshot?.messages, showSettings]);

  useEffect(() => {
    if (open && !showSettings && view === "chat" && !historyOpen)
      inputRef.current?.focus({ preventScroll: true });
  }, [open, showSettings, view, historyOpen]);

  const run = async (action: string, params: Record<string, unknown> = {}) => {
    if (
      pendingAction.current ||
      (executing &&
        action !== "stop" &&
        action !== "configure_approval" &&
        !action.startsWith("task.")) ||
      ((action === "action.confirm" || action === "action.cancel") &&
        snapshot?.running) ||
      ((action === "new_session" || action === "select_session") &&
        (!connected || snapshot?.running || authPending))
    )
      return false;
    pendingAction.current = true;
    setBusy(true);
    setError(null);
    try {
      await callAssistant(action, params);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      pendingAction.current = false;
      setBusy(false);
    }
  };

  const submit = async () => {
    if (
      pendingAction.current ||
      !connected ||
      !ready ||
      authPending ||
      snapshot?.running ||
      executing ||
      !state.draft.trim() ||
      !scopeAvailable.length ||
      composing.current
    )
      return;
    pendingAction.current = true;
    setBusy(true);
    setError(null);
    followingOutput.current = true;
    try {
      await sendAssistant(state.draft, scopeAvailable);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pendingAction.current = false;
      setBusy(false);
    }
  };

  if (!open) return null;

  const displayedError = error || state.error || snapshot?.error;
  const historySupported = !!snapshot?.session_id && !!snapshot.sessions;
  const sessions = [...(snapshot?.sessions ?? [])].sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at),
  );
  const currentSession = sessions.find(
    (session) => session.id === snapshot?.session_id,
  );
  const historyBlocked =
    operationBusy || !!snapshot?.running || !connected || !!authPending;
  const provider = snapshot?.providers.find(
    (item) => item.id === config?.provider,
  );
  const providerQuery = providerSearch.trim().toLowerCase();
  const matchingProviders = (snapshot?.providers ?? []).filter((item) =>
    `${item.label} ${item.id}`.toLowerCase().includes(providerQuery),
  );
  const savedProviderCount = (snapshot?.providers ?? []).filter(
    (item) => item.configured,
  ).length;
  const savedProviders = matchingProviders.filter((item) => item.configured);
  const otherProviders = matchingProviders
    .filter((item) => !item.configured)
    .sort((a, b) => a.label.localeCompare(b.label));
  const providerChoice = (item: AssistantSnapshot["providers"][number]) => (
    <button
      type="button"
      key={item.id}
      className="assistant-provider-choice"
      aria-label={`Select provider ${item.label}`}
      aria-pressed={config?.provider === item.id}
      onClick={() => {
        if (config && item.id !== config.provider)
          setConfig({ ...config, provider: item.id, model: "" });
      }}
    >
      <strong>{item.label}</strong>
      <span>{credentialStatus(item)}</span>
    </button>
  );
  const modelOptions = (snapshot?.models ?? [])
    .filter((model) => model.provider === config?.provider)
    .map((model) => ({ value: model.id, label: model.label }));
  const selectedModel = snapshot?.models.find(
    (model) =>
      model.provider === config?.provider && model.id === config?.model,
  );
  const permittedWorkspaces = workspaces.filter(
    (workspace) =>
      !!snapshot &&
      includesWorkspace(snapshot.config.allowed_workspaces, workspace),
  );
  const allAllowedWorkspaces = Array.from(
    new Map(
      [...(config?.allowed_workspaces ?? []), ...workspaces].map(
        (workspace) => [
          workspaceKey(workspace),
          {
            connection_id: workspace.connection_id,
            workspace_id: workspace.workspace_id,
          },
        ],
      ),
    ).values(),
  );

  return (
    <aside
      ref={panelRef}
      className={`assistant-panel ${floating ? "is-floating" : ""} ${mobile ? "is-mobile" : maximized ? "is-maximized" : ""}`}
      style={{ "--assistant-panel-width": `${width}px` } as CSSProperties}
      aria-label="Ranger"
      onKeyDown={(event) => {
        // Global workspace shortcuts must not consume typing inside the panel.
        event.stopPropagation();
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing &&
          !confirmNew &&
          !confirmApproval
        ) {
          event.preventDefault();
          if (maximized && !mobile) setMaximized(false);
          else onClose();
        }
      }}
    >
      {!floating && !mobile && !maximized ? (
        <div
          className="assistant-panel-resizer"
          role="separator"
          aria-label="Resize Ranger"
          aria-orientation="vertical"
          aria-valuemin={300}
          aria-valuemax={Math.round(maximumWidth)}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          title="Drag to resize Ranger; double-click to reset"
          onPointerDown={(event) => {
            if (event.button !== 0 || !panelRef.current) return;
            event.preventDefault();
            const panel = panelRef.current;
            resizeStart.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              width: panel.offsetWidth,
              scale:
                panel.getBoundingClientRect().width / panel.offsetWidth || 1,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const start = resizeStart.current;
            if (
              !start ||
              start.pointerId !== event.pointerId ||
              !event.currentTarget.hasPointerCapture(event.pointerId)
            )
              return;
            resizePanel(start.width + (start.x - event.clientX) / start.scale);
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
            resizeStart.current = null;
          }}
          onPointerCancel={() => {
            resizeStart.current = null;
          }}
          onLostPointerCapture={() => {
            resizeStart.current = null;
          }}
          onDoubleClick={() => setPanelWidth(380)}
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowLeft"
                ? width + 24
                : event.key === "ArrowRight"
                  ? width - 24
                  : event.key === "Home"
                    ? 300
                    : event.key === "End"
                      ? maximumWidth
                      : null;
            if (next === null) return;
            event.preventDefault();
            resizePanel(next);
          }}
        />
      ) : null}
      <header className="assistant-panel-head">
        <Compass size={19} aria-hidden="true" />
        <div>
          <div className="assistant-panel-title">
            <strong>Ranger</strong>
            <span className="assistant-panel-experimental">Experimental</span>
          </div>
          <span role="status">
            {!connected
              ? "Reconnecting"
              : executing
                ? "Executing action"
                : snapshot?.running
                  ? "Working"
                  : "Workspace management assistant"}
            {snapshot?.config.approval_mode === "auto"
              ? " / High permission"
              : ""}
          </span>
        </div>
        {!mobile && !maximized ? (
          <button
            type="button"
            className="assistant-icon-button"
            title={floating ? "Fixed layout" : "Floating layout"}
            aria-label={floating ? "Pin Ranger" : "Float Ranger"}
            aria-pressed={!floating}
            onClick={() => {
              setMaximized(false);
              onToggleFloating();
            }}
          >
            {floating ? <Pin size={16} /> : <PinOff size={16} />}
          </button>
        ) : null}
        {!mobile ? (
          <button
            type="button"
            className="assistant-icon-button"
            title={maximized ? "Restore window" : "Maximize window"}
            aria-label={maximized ? "Restore Ranger" : "Maximize Ranger"}
            aria-pressed={maximized}
            onClick={() => setMaximized((current) => !current)}
          >
            {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        ) : null}
        <button
          type="button"
          className="assistant-icon-button"
          aria-label="Ranger settings"
          title="Model connection and workspace permissions"
          aria-pressed={showSettings}
          onClick={() => setSettingsOpen(!showSettings)}
        >
          <Settings size={16} />
        </button>
        <button
          type="button"
          className="assistant-icon-button"
          aria-label="Close Ranger"
          title="Close"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>

      <nav className="assistant-primary-nav" aria-label="Ranger views">
        {(["chat", "tasks"] as const).map((item) => (
          <button
            type="button"
            key={item}
            className="ghost"
            aria-pressed={!showSettings && view === item}
            onClick={() => {
              setView(item);
              setSettingsOpen(false);
            }}
          >
            {item === "chat" ? "Chat" : "Tasks"}
          </button>
        ))}
      </nav>

      {displayedError ? (
        <div className="assistant-error" role="alert">
          <span>{displayedError}</span>
          <button
            type="button"
            className="ghost"
            disabled={!connected || state.loading}
            onClick={() => {
              setError(null);
              void refreshAssistant().catch(() => {});
            }}
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      ) : null}
      {!snapshot ? (
        <div className="assistant-panel-empty">
          {state.loading ? (
            <LoaderCircle className="assistant-spinner" size={24} />
          ) : (
            <Compass size={24} aria-hidden="true" />
          )}
          <strong>
            {state.loading
              ? "Loading Ranger"
              : !connected
                ? "Waiting for the bridge"
                : !state.supported
                  ? "Update Roamgate to use Ranger"
                  : "Could not load Ranger"}
          </strong>
          <span>
            Ranger runs on the Roamgate bridge and stays available across
            workspaces.
          </span>
        </div>
      ) : showSettings && config ? (
        <div className="assistant-panel-settings">
          <div className="assistant-section-heading">
            <h3>Model connection</h3>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setView("chat");
                setSettingsOpen(false);
              }}
            >
              <ChevronLeft size={14} /> Chat
            </button>
          </div>
          <p className="assistant-hint">
            Credentials belong to the bridge account. They are shared across
            workspaces.
          </p>
          <fieldset
            disabled={
              operationBusy || snapshot.running || !connected || !!authPending
            }
          >
            <div className="form-field">
              <span>Credentials</span>
              <div
                className="assistant-credential-source"
                role="group"
                aria-label="Credential source"
              >
                {(
                  [
                    {
                      value: "assistant",
                      label: "Ranger connection",
                      description:
                        "Save Ranger logins, API keys and custom models separately from Pi.",
                    },
                    {
                      value: "pi",
                      label: "Shared Pi credentials",
                      description:
                        "Use Pi's saved logins, API keys and custom models. Changes are also saved to Pi.",
                    },
                  ] as const
                ).map((item) => (
                  <button
                    type="button"
                    key={item.value}
                    aria-label={item.label}
                    aria-describedby={`ranger-credential-${item.value}-description`}
                    aria-pressed={config.credential_source === item.value}
                    onClick={async () => {
                      if (
                        item.value === config.credential_source ||
                        pendingAction.current
                      )
                        return;
                      await run("configure", {
                        config: {
                          ...config,
                          credential_source: item.value,
                          provider: "",
                          model: "",
                        },
                      });
                    }}
                  >
                    <span>{item.label}</span>
                    <small id={`ranger-credential-${item.value}-description`}>
                      {item.description}
                    </small>
                  </button>
                ))}
              </div>
            </div>
            <AssistantModelForm
              key={JSON.stringify([
                config.credential_source,
                provider?.id,
                config.model,
                provider?.custom,
                selectedModel?.custom,
              ])}
              config={config}
              provider={provider}
              providers={snapshot.providers}
              selectedModel={selectedModel}
              tasksRunning={
                snapshot.tasks?.some(
                  (task) => task.current_run?.status === "running",
                ) ?? false
              }
              onSave={async (input) => {
                if (!(await run("configure_model", input))) return false;
                setConfig({
                  ...config,
                  provider: input.provider,
                  model: input.model,
                });
                setProviderSearch("");
                return true;
              }}
            />
            <div
              className="assistant-providers"
              role="group"
              aria-label="Model provider"
            >
              <div className="assistant-section-heading">
                <strong>Provider</strong>
                <label className="assistant-provider-search">
                  <Search size={13} aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="Search providers"
                    placeholder="Search providers..."
                    autoComplete="off"
                    spellCheck={false}
                    value={providerSearch}
                    onChange={(event) =>
                      setProviderSearch(event.currentTarget.value)
                    }
                  />
                </label>
                <button
                  type="button"
                  className="ghost"
                  aria-label="Refresh Ranger credentials"
                  disabled={
                    state.loading ||
                    operationBusy ||
                    snapshot.running ||
                    !connected ||
                    !!authPending
                  }
                  onClick={() => {
                    setError(null);
                    void refreshAssistant().catch(() => {});
                  }}
                >
                  <RefreshCw size={12} /> Refresh
                </button>
              </div>
              <p className="assistant-hint">
                {savedProviderCount} saved. Select a provider below. Credentials
                are checked when used.
              </p>
              {!matchingProviders.length ? (
                <p className="assistant-hint" role="status">
                  No providers match your search.
                </p>
              ) : null}
              {savedProviders.length ? (
                <div className="assistant-provider-list">
                  {savedProviders.map(providerChoice)}
                </div>
              ) : null}
              {otherProviders.length ? (
                <details
                  className="assistant-other-providers"
                  open={
                    !!providerQuery ||
                    !savedProviders.length ||
                    (!!provider && !provider.configured)
                  }
                >
                  <summary>Connect another provider</summary>
                  <div className="assistant-provider-list">
                    {otherProviders.map(providerChoice)}
                  </div>
                </details>
              ) : null}
              {provider && !matchingProviders.includes(provider) ? (
                <p className="assistant-hint">
                  Selected provider: {provider.label}
                </p>
              ) : null}
            </div>
            {provider ? (
              <div className="assistant-connection-actions">
                {provider.methods.map((method) => (
                  <button
                    type="button"
                    key={method}
                    onClick={() =>
                      void run("auth.start", { provider: provider.id, method })
                    }
                    aria-label={`${method === "oauth" ? "Sign in to" : "Enter API key for"} ${provider.label}`}
                  >
                    {method === "oauth"
                      ? `${provider.configured ? "Sign in again to" : "Sign in to"} ${provider.label}`
                      : `${provider.configured ? "Update" : "Enter"} API key`}
                  </button>
                ))}
              </div>
            ) : null}
            {provider?.methods.length ? (
              <p className="assistant-hint">
                {config.credential_source === "pi"
                  ? "Login is saved to Pi on the bridge host and shared with Pi."
                  : "Login is saved for Ranger on the bridge host."}
              </p>
            ) : null}
            <label className="form-field">
              <span>Default model</span>
              <ThemedSelect
                value={config.model}
                options={modelOptions}
                aria-label="Ranger model"
                disabled={!provider?.configured || !modelOptions.length}
                placeholder={
                  !provider
                    ? "Choose a provider first"
                    : !provider.configured
                      ? "Connect a provider first"
                      : !modelOptions.length
                        ? "No models available"
                        : "Choose a model"
                }
                onChange={(value) => setConfig({ ...config, model: value })}
              />
            </label>
          </fieldset>
          {snapshot.auth &&
          (authPending || snapshot.auth.provider === config.provider) ? (
            <AuthCard
              key={`${snapshot.auth.id}:${snapshot.auth.prompt?.id ?? ""}`}
              auth={snapshot.auth}
              label={
                snapshot.providers.find(
                  (item) => item.id === snapshot.auth?.provider,
                )?.label ?? snapshot.auth.provider
              }
              busy={operationBusy || !connected}
              run={run}
            />
          ) : null}
          <div className="assistant-section-heading">
            <h3>High-permission mode</h3>
            <span className="assistant-hint">
              {snapshot.config.approval_mode === "auto" ? "Enabled" : "Off"}
            </span>
          </div>
          <p className="assistant-hint">
            Execute supported operations and create schedules without individual
            confirmations, within authorized workspaces. Newly created or edited
            tasks keep this mode. Turning it off requires confirmation for
            subsequent operations; dispatched operations may finish.
          </p>
          <button
            type="button"
            aria-pressed={snapshot.config.approval_mode === "auto"}
            disabled={
              busy ||
              !connected ||
              !!authPending ||
              (snapshot.config.approval_mode !== "auto" &&
                (executing || snapshot.running))
            }
            onClick={() => {
              if (snapshot.config.approval_mode === "auto")
                void run("configure_approval", { approval_mode: "manual" });
              else setConfirmApproval(true);
            }}
          >
            {snapshot.config.approval_mode === "auto"
              ? "Disable high-permission mode"
              : "Enable high-permission mode"}
          </button>
          <div className="assistant-section-heading">
            <h3>Allowed workspaces</h3>
            <button
              type="button"
              className="assistant-icon-button"
              aria-label="Refresh Ranger workspaces"
              disabled={contextLoading || !connected}
              onClick={() => void loadContext()}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <p className="assistant-hint">
            Select workspaces Ranger may read and manage. Choose the scope of
            each question in the chat. Actions require confirmation unless
            high-permission mode is enabled. Selected status, conversations,
            terminal output, and diffs may be sent to your model provider.
          </p>
          <div className="assistant-workspace-actions">
            <button
              type="button"
              aria-label="Select all available Ranger workspaces"
              disabled={
                contextLoading ||
                operationBusy ||
                snapshot.running ||
                !connected ||
                !workspaces.length ||
                allAllowedWorkspaces.length > ASSISTANT_MAX_WORKSPACES ||
                workspaces.every((workspace) =>
                  includesWorkspace(config.allowed_workspaces, workspace),
                )
              }
              onClick={() =>
                setConfig({
                  ...config,
                  allowed_workspaces: allAllowedWorkspaces,
                })
              }
            >
              Select all
            </button>
            <button
              type="button"
              className="ghost"
              aria-label="Clear allowed Ranger workspaces"
              disabled={
                contextLoading ||
                operationBusy ||
                snapshot.running ||
                !connected ||
                !config.allowed_workspaces.length
              }
              onClick={() => setConfig({ ...config, allowed_workspaces: [] })}
            >
              Clear
            </button>
          </div>
          {allAllowedWorkspaces.length > ASSISTANT_MAX_WORKSPACES ? (
            <p className="assistant-hint">
              {`Select up to ${ASSISTANT_MAX_WORKSPACES} workspaces individually; Select all exceeds this limit.`}
            </p>
          ) : null}
          <fieldset
            className="assistant-workspaces"
            disabled={operationBusy || snapshot.running || !connected}
          >
            {workspaces.map((workspace) => (
              <label
                key={workspaceKey(workspace)}
                className="assistant-workspace-choice"
              >
                <input
                  type="checkbox"
                  checked={includesWorkspace(
                    config.allowed_workspaces,
                    workspace,
                  )}
                  disabled={
                    config.allowed_workspaces.length >=
                      ASSISTANT_MAX_WORKSPACES &&
                    !includesWorkspace(config.allowed_workspaces, workspace)
                  }
                  onChange={() =>
                    setConfig({
                      ...config,
                      allowed_workspaces: toggleWorkspace(
                        config.allowed_workspaces,
                        workspace,
                      ),
                    })
                  }
                />
                <span>
                  {workspace.label}
                  <small>{workspace.connection_label}</small>
                </span>
              </label>
            ))}
            {!workspaces.length ? (
              <span className="assistant-hint">
                {contextLoading
                  ? "Loading workspaces"
                  : "No connected workspaces available"}
              </span>
            ) : null}
            {config.allowed_workspaces
              .filter(
                (workspace) =>
                  !workspaces.some(
                    (item) => workspaceKey(item) === workspaceKey(workspace),
                  ),
              )
              .map((workspace) => (
                <label
                  key={workspaceKey(workspace)}
                  className="assistant-workspace-choice"
                >
                  <input
                    type="checkbox"
                    checked
                    onChange={() =>
                      setConfig({
                        ...config,
                        allowed_workspaces: toggleWorkspace(
                          config.allowed_workspaces,
                          workspace,
                        ),
                      })
                    }
                  />
                  <span>
                    {workspace.workspace_id}
                    <small>Unavailable ({workspace.connection_id})</small>
                  </span>
                </label>
              ))}
          </fieldset>
          {contextErrors.map((message) => (
            <p key={message} className="assistant-hint">
              {message}
            </p>
          ))}
          <button
            type="button"
            disabled={
              operationBusy ||
              snapshot.running ||
              !connected ||
              !!authPending ||
              !config.provider ||
              !config.model
            }
            onClick={async () => {
              if (await run("configure", { config })) {
                setScope(config.allowed_workspaces);
                setSettingsOpen(false);
              }
            }}
          >
            Save connection
          </button>
        </div>
      ) : view === "tasks" ? null : (
        <>
          <div className="assistant-chat-toolbar">
            {historySupported ? (
              <div className="assistant-chat-title">
                <strong>{currentSession?.title ?? "New chat"}</strong>
                <span
                  title={`${snapshot.config.provider} / ${snapshot.config.model}`}
                >
                  {snapshot.config.model}
                </span>
              </div>
            ) : (
              <span
                title={`${snapshot.config.provider} / ${snapshot.config.model}`}
              >
                {snapshot.config.model}
              </span>
            )}
            {historySupported ? (
              <button
                type="button"
                className="ghost"
                aria-label="Ranger chat history"
                aria-expanded={historyOpen}
                aria-controls="ranger-chat-history"
                disabled={historyBlocked}
                onClick={() => {
                  if (!historyBlocked) setHistoryOpen((current) => !current);
                }}
              >
                <History size={13} /> History
              </button>
            ) : null}
            <button
              type="button"
              className="ghost"
              disabled={historyBlocked || !snapshot.messages.length}
              onClick={() => {
                if (!historyBlocked && snapshot.messages.length)
                  setConfirmNew(true);
              }}
            >
              <Plus size={13} /> New chat
            </button>
          </div>
          {!ready || authPending ? (
            <div className="assistant-setup-notice">
              <span>
                {authPending
                  ? "Provider sign-in is in progress. Open model settings to continue."
                  : "Connect a provider and choose a model to send messages."}
              </span>
              <button
                type="button"
                className="ghost"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings size={13} /> Model settings
              </button>
            </div>
          ) : null}
          {historySupported && historyOpen ? (
            <div
              id="ranger-chat-history"
              className="assistant-chat-history"
              role="region"
              aria-label="Saved Ranger chats"
            >
              <div className="assistant-section-heading">
                <strong>History</strong>
                <button
                  type="button"
                  className="ghost"
                  aria-label="Close Ranger chat history"
                  onClick={() => setHistoryOpen(false)}
                >
                  <ChevronLeft size={13} /> Chat
                </button>
              </div>
              {snapshot.messages.some((message) =>
                message.actions?.some((action) => action.status === "pending"),
              ) ? (
                <p>
                  Opening a chat cancels this chat's unconfirmed action
                  previews.
                </p>
              ) : null}
              {sessions.length ? (
                <ul>
                  {sessions.map((session) => (
                    <li key={session.id}>
                      <button
                        type="button"
                        className="ghost"
                        title={session.title}
                        aria-pressed={session.id === snapshot.session_id}
                        disabled={
                          historyBlocked || session.id === snapshot.session_id
                        }
                        onClick={async () => {
                          if (
                            historyBlocked ||
                            session.id === snapshot.session_id
                          )
                            return;
                          if (
                            await run("select_session", {
                              session_id: session.id,
                            })
                          )
                            setHistoryOpen(false);
                        }}
                      >
                        <strong>{session.title}</strong>
                        <span>
                          <time dateTime={session.updated_at}>
                            {formatUiDateTime(session.updated_at)}
                          </time>
                          <span>
                            {session.id === snapshot.session_id
                              ? "Current"
                              : `${session.message_count} messages`}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  No saved chats yet. Your conversations are saved
                  automatically.
                </p>
              )}
            </div>
          ) : null}
          <div className="assistant-conversation">
            <div
              ref={listRef}
              className="assistant-panel-list"
              aria-label="Ranger conversation"
              aria-busy={snapshot.running || executing}
              onScroll={(event) => {
                const list = event.currentTarget;
                followingOutput.current =
                  list.scrollHeight - list.scrollTop - list.clientHeight < 48;
              }}
            >
              {!snapshot.messages.length ? (
                <div className="assistant-panel-empty">
                  <Compass size={24} aria-hidden="true" />
                  <strong>What would you like to work on?</strong>
                  <span>
                    Ask about progress or changes, or ask Ranger to propose
                    workspace and agent actions in the workspaces you select.
                  </span>
                </div>
              ) : (
                snapshot.messages.map((message) => (
                  <section
                    key={message.id}
                    data-message-id={message.id}
                    className={`assistant-message is-${message.role}`}
                    aria-label={`${message.role === "user" ? "You" : "Ranger"} message`}
                  >
                    <div className="assistant-message-head">
                      <strong>
                        {message.role === "user" ? "You" : "Ranger"}
                      </strong>
                      <time dateTime={message.sent_at}>
                        {formatUiDateTime(message.sent_at)}
                      </time>
                    </div>
                    {message.role === "assistant" ? (
                      message.text ? (
                        <MarkdownPreview
                          text={message.text}
                          className="assistant-markdown"
                          breaks
                          imageUrlResolver={() => null}
                        />
                      ) : (
                        <span className="assistant-hint">
                          {snapshot.running &&
                          message ===
                            snapshot.messages[snapshot.messages.length - 1]
                            ? "Working..."
                            : "No response text was received."}
                        </span>
                      )
                    ) : (
                      <p className="assistant-user-text">{message.text}</p>
                    )}
                    {message.role === "assistant" &&
                    message.text.length >= 32_000 ? (
                      <span className="assistant-hint">
                        Response text reached the display limit.
                      </span>
                    ) : null}
                    {message.role === "assistant"
                      ? message.actions?.map((action) => (
                          <ActionCard
                            key={action.id}
                            action={action}
                            busy={operationBusy || !connected}
                            running={snapshot.running}
                            run={run}
                          />
                        ))
                      : null}
                    {message.role === "assistant"
                      ? message.task_proposals?.map((proposal) => (
                          <TaskProposalCard
                            key={proposal.id}
                            proposal={proposal}
                            busy={busy || !connected}
                            run={run}
                          />
                        ))
                      : null}
                    {message.tools.length || message.sources.length ? (
                      <AssistantMessageActivity
                        message={message}
                        running={
                          snapshot.running &&
                          message ===
                            snapshot.messages[snapshot.messages.length - 1]
                        }
                        onOpenSource={onOpenSource}
                      />
                    ) : null}
                  </section>
                ))
              )}
            </div>
            {snapshot.messages.length ? (
              <AssistantConversationMap
                key={snapshot.session_id ?? snapshot.instance_id}
                messages={snapshot.messages}
                listRef={listRef}
                onNavigate={() => {
                  followingOutput.current = false;
                }}
              />
            ) : null}
          </div>
          <form
            className="assistant-panel-footer"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <details className="assistant-scope-picker">
              <summary>
                Reading scope:{" "}
                {scopeAvailable.length
                  ? `${scopeAvailable.length} workspace${scopeAvailable.length === 1 ? "" : "s"}`
                  : "Choose workspaces"}
              </summary>
              <fieldset
                className="assistant-workspaces"
                disabled={operationBusy || snapshot.running || !connected}
              >
                {permittedWorkspaces.map((workspace) => (
                  <label
                    key={workspaceKey(workspace)}
                    className="assistant-workspace-choice"
                  >
                    <input
                      type="checkbox"
                      checked={includesWorkspace(scopeAvailable, workspace)}
                      onChange={() =>
                        setScope(toggleWorkspace(scopeAvailable, workspace))
                      }
                    />
                    <span>
                      {workspace.label}
                      <small>{workspace.connection_label}</small>
                    </span>
                  </label>
                ))}
                {!permittedWorkspaces.length ? (
                  <span className="assistant-hint">
                    Allow workspaces in Ranger settings first.
                  </span>
                ) : null}
              </fieldset>
              <button
                type="button"
                className="ghost"
                onClick={() => setSettingsOpen(true)}
              >
                Manage allowed workspaces
              </button>
            </details>
            <textarea
              ref={inputRef}
              aria-label="Message Ranger"
              placeholder="Ask about your workspaces"
              rows={3}
              maxLength={20_000}
              value={state.draft}
              onChange={(event) => setAssistantDraft(event.currentTarget.value)}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(event) => {
                if (
                  event.key !== "Enter" ||
                  event.shiftKey ||
                  event.nativeEvent.isComposing ||
                  composing.current ||
                  event.keyCode === 229
                )
                  return;
                event.preventDefault();
                if (!event.repeat) void submit();
              }}
            />
            <div className="assistant-compose-actions">
              <span>
                {executing
                  ? "Confirmed action is executing"
                  : snapshot.running
                    ? "Scope stays fixed while working"
                    : "Enter to send, Shift+Enter for a new line"}
              </span>
              {snapshot.running ? (
                <button
                  type="button"
                  title="Stop the model response; confirmed actions continue"
                  disabled={busy || !connected}
                  onClick={() => void run("stop")}
                >
                  <Square size={13} /> Stop
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={
                    operationBusy ||
                    !connected ||
                    !ready ||
                    authPending ||
                    !state.draft.trim() ||
                    !scopeAvailable.length
                  }
                >
                  <Send size={13} /> Send
                </button>
              )}
            </div>
          </form>
        </>
      )}
      {snapshot ? (
        <AssistantTasks
          active={!showSettings && view === "tasks"}
          requestedTask={connected && !state.loading ? requestedTask : null}
          onRequestedTaskHandled={onRequestedTaskHandled}
          snapshot={snapshot}
          connected={connected}
          workspaces={permittedWorkspaces}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSource={onOpenSource}
        />
      ) : null}
      <ConfirmDialog
        open={confirmApproval}
        title="Enable high-permission mode?"
        message="Ranger will execute supported workspace, worktree, tab, pane, agent and prompt operations, and create scheduled tasks, without asking again. These operations may run setup hooks or start agents. Only authorized workspaces and the selected scope are available. This applies to new questions and newly created or edited tasks and stays enabled until you turn it off."
        confirmLabel="Enable high-permission mode"
        onConfirm={() =>
          void run("configure_approval", { approval_mode: "auto" })
        }
        onClose={() => setConfirmApproval(false)}
      />
      <ConfirmDialog
        open={confirmNew}
        title="Start a new Ranger chat?"
        message={
          historySupported
            ? "The current chat will be saved in History. Unconfirmed action previews will be cancelled. Your model connection and workspace permissions stay saved."
            : "The current conversation will be cleared. Unconfirmed action previews will be cancelled. Your model connection and workspace permissions stay saved."
        }
        confirmLabel="New chat"
        onConfirm={() => void run("new_session")}
        onClose={() => setConfirmNew(false)}
      />
    </aside>
  );
}
