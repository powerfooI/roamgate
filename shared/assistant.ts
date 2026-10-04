export const ASSISTANT_MAX_WORKSPACES = 64;

export type AssistantWorkspaceRef = {
  connection_id: string;
  workspace_id: string;
};

export type AssistantWorkspace = AssistantWorkspaceRef & {
  connection_label: string;
  label: string;
  runtime_generation: number;
};

export type AssistantConfig = {
  provider: string;
  model: string;
  credential_source: "assistant" | "pi";
  allowed_workspaces: AssistantWorkspaceRef[];
};

export type AssistantSource = AssistantWorkspaceRef & {
  id: string;
  title: string;
  kind: "status" | "history" | "diff" | "terminal";
  runtime_generation: number;
  pane_id?: string;
  read_at: string;
};

export type AssistantToolActivity = {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
};

export type AssistantActionKind =
  | "create_workspace"
  | "create_worktree"
  | "create_tab"
  | "split_pane"
  | "start_agent"
  | "send_prompt";

export type AssistantAction = Omit<AssistantWorkspace, "label"> & {
  workspace_label: string;
  id: string;
  kind: AssistantActionKind;
  status:
    | "pending"
    | "executing"
    | "succeeded"
    | "failed"
    | "uncertain"
    | "cancelled";
  created_at: string;
  params: Record<string, string>;
  summary: string;
  detail: string;
};

export type AssistantMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  sent_at: string;
  tools: AssistantToolActivity[];
  sources: AssistantSource[];
  actions?: AssistantAction[];
};

export type AssistantAuthState = {
  id: string;
  provider: string;
  status: "waiting" | "working" | "completed" | "failed";
  message: string;
  url?: string;
  user_code?: string;
  prompt?: {
    id: string;
    type: "text" | "secret" | "select" | "manual_code";
    message: string;
    options?: { id: string; label: string }[];
  };
};

export type AssistantSessionSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
};

export type AssistantSnapshot = {
  instance_id: string;
  revision: number;
  session_id?: string;
  sessions?: AssistantSessionSummary[];
  config: AssistantConfig;
  providers: {
    id: string;
    label: string;
    methods: ("api_key" | "oauth")[];
    configured: boolean;
    credential_method?: "api_key" | "oauth";
  }[];
  models: { provider: string; id: string; label: string }[];
  messages: AssistantMessage[];
  running: boolean;
  error: string | null;
  auth: AssistantAuthState | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string";
}

function workspaceRef(value: unknown): value is AssistantWorkspaceRef {
  return (
    record(value) &&
    text(value.connection_id) &&
    value.connection_id.length > 0 &&
    text(value.workspace_id) &&
    value.workspace_id.length > 0
  );
}

function generation(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function action(value: unknown): value is AssistantAction {
  return (
    record(value) &&
    workspaceRef({
      connection_id: value.connection_id,
      workspace_id: value.workspace_id,
    }) &&
    text(value.id) &&
    !!value.id &&
    [
      "create_workspace",
      "create_worktree",
      "create_tab",
      "split_pane",
      "start_agent",
      "send_prompt",
    ].includes(String(value.kind)) &&
    [
      "pending",
      "executing",
      "succeeded",
      "failed",
      "uncertain",
      "cancelled",
    ].includes(String(value.status)) &&
    generation(value.runtime_generation) &&
    text(value.connection_label) &&
    text(value.workspace_label) &&
    text(value.created_at) &&
    text(value.summary) &&
    text(value.detail) &&
    record(value.params) &&
    Object.keys(value.params).length <= 8 &&
    Object.values(value.params).every(
      (entry) => text(entry) && entry.length <= 20_000,
    )
  );
}

export function isAssistantSnapshot(
  value: unknown,
): value is AssistantSnapshot {
  if (!record(value) || !record(value.config)) return false;
  const config = value.config;
  if (
    !text(value.instance_id) ||
    !value.instance_id ||
    !generation(value.revision) ||
    (value.session_id === undefined) !== (value.sessions === undefined) ||
    (value.session_id !== undefined &&
      (!text(value.session_id) ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(
          value.session_id,
        ))) ||
    (value.sessions !== undefined &&
      (!Array.isArray(value.sessions) ||
        !value.sessions.every(
          (session) =>
            record(session) &&
            text(session.id) &&
            /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(session.id) &&
            text(session.title) &&
            session.title.length > 0 &&
            session.title.length <= 80 &&
            text(session.created_at) &&
            Number.isFinite(Date.parse(session.created_at)) &&
            text(session.updated_at) &&
            Number.isFinite(Date.parse(session.updated_at)) &&
            generation(session.message_count) &&
            session.message_count <= 80,
        ) ||
        new Set(value.sessions.map((session) => session.id)).size !==
          value.sessions.length ||
        (value.session_id !== undefined &&
          !value.sessions.some(
            (session) => session.id === value.session_id,
          )))) ||
    typeof value.running !== "boolean" ||
    (value.error !== null && !text(value.error)) ||
    !text(config.provider) ||
    !text(config.model) ||
    !["assistant", "pi"].includes(String(config.credential_source)) ||
    !Array.isArray(config.allowed_workspaces) ||
    !config.allowed_workspaces.every(workspaceRef) ||
    !Array.isArray(value.providers) ||
    !value.providers.every(
      (provider) =>
        record(provider) &&
        text(provider.id) &&
        text(provider.label) &&
        typeof provider.configured === "boolean" &&
        (provider.credential_method === undefined ||
          provider.credential_method === "api_key" ||
          provider.credential_method === "oauth") &&
        Array.isArray(provider.methods) &&
        provider.methods.every(
          (method) => method === "api_key" || method === "oauth",
        ),
    ) ||
    !Array.isArray(value.models) ||
    !value.models.every(
      (model) =>
        record(model) &&
        text(model.provider) &&
        text(model.id) &&
        text(model.label),
    ) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(
      (message) =>
        record(message) &&
        text(message.id) &&
        (message.role === "user" || message.role === "assistant") &&
        text(message.text) &&
        text(message.sent_at) &&
        (message.actions === undefined ||
          (Array.isArray(message.actions) &&
            message.actions.length <= 8 &&
            message.actions.every(action))) &&
        Array.isArray(message.tools) &&
        message.tools.every(
          (tool) =>
            record(tool) &&
            text(tool.id) &&
            text(tool.name) &&
            ["running", "completed", "failed"].includes(String(tool.status)),
        ) &&
        Array.isArray(message.sources) &&
        message.sources.every(
          (source) =>
            record(source) &&
            text(source.connection_id) &&
            source.connection_id.length > 0 &&
            text(source.workspace_id) &&
            source.workspace_id.length > 0 &&
            text(source.id) &&
            text(source.title) &&
            ["status", "history", "diff", "terminal"].includes(
              String(source.kind),
            ) &&
            generation(source.runtime_generation) &&
            (source.pane_id === undefined || text(source.pane_id)) &&
            text(source.read_at),
        ),
    )
  )
    return false;
  if (value.auth === null) return true;
  const auth = value.auth;
  if (
    !record(auth) ||
    !text(auth.id) ||
    !text(auth.provider) ||
    !["waiting", "working", "completed", "failed"].includes(
      String(auth.status),
    ) ||
    !text(auth.message) ||
    (auth.url !== undefined && !text(auth.url)) ||
    (auth.user_code !== undefined && !text(auth.user_code))
  )
    return false;
  if (auth.prompt === undefined) return true;
  const prompt = auth.prompt;
  return (
    record(prompt) &&
    text(prompt.id) &&
    text(prompt.message) &&
    ["text", "secret", "select", "manual_code"].includes(String(prompt.type)) &&
    (prompt.options === undefined ||
      (Array.isArray(prompt.options) &&
        prompt.options.every(
          (option) => record(option) && text(option.id) && text(option.label),
        )))
  );
}
