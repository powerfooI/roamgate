export type HerdrCall = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

export type AgentHistoryParams = {
  pane_id?: string;
  workspace_id?: string;
  tab_id?: string;
  agent?: string;
};

export type AgentSessionInfo = {
  source: string;
  agent: string;
  kind: "id" | "path";
  value: string;
};

export type AgentMessageHistoryEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  sent_at: string;
};

export type TokenUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  // Counted-once prompt usage where the provider convention is known.
  prompt_tokens?: number | null;
  // Explicit null means unknown; clients must not reconstruct a total.
  total_tokens?: number | null;
};

export type AtifMetrics = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  extra?: Record<string, unknown>;
};

export type AtifToolCall = {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, unknown>;
  extra?: Record<string, unknown>;
};

export type AtifObservationResult = {
  source_call_id?: string;
  content?: string;
  extra?: Record<string, unknown>;
};

export type AtifStep = {
  step_id: number;
  timestamp?: string;
  source: "system" | "user" | "agent";
  message: string;
  reasoning_content?: string;
  tool_calls?: AtifToolCall[];
  observation?: { results: AtifObservationResult[] };
  metrics?: AtifMetrics;
  extra?: Record<string, unknown>;
};

export type AtifTrajectory = {
  schema_version: "ATIF-v1.7";
  session_id?: string;
  trajectory_id?: string;
  agent: { name: string; version: string; model_name?: string };
  steps: AtifStep[];
  final_metrics?: {
    total_prompt_tokens?: number;
    total_completion_tokens?: number;
    total_cached_tokens?: number;
    total_steps: number;
    extra?: Record<string, unknown>;
  };
  extra?: Record<string, unknown>;
};

export type SessionFile = {
  path: string;
  mtimeMs: number;
  size?: number;
  identity?: string;
  changeToken?: string;
  sessionId?: string;
  createdAtMs?: number;
  modelName?: string;
  agentVersion?: string;
};

export type AgentSessionResolved = {
  version: 1;
  agent: string;
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  status: "missing_session" | "missing_file" | "ok";
  detail: string;
  command?: string;
  updated_at: string;
  path: string;
  session: AgentSessionInfo | null;
  file: SessionFile | null;
};
