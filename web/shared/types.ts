export type WorkPhase =
  | "IDLE"
  | "PLANNING"
  | "NEEDS_CONFIRMATION"
  | "RESOLVING"
  | "AWAITING_REVIEW"
  | "EXECUTING"
  | "COMMITTED"
  | "VERIFYING"
  | "VERIFIED"
  | "FAILED";

export type ConnectionState = "unknown" | "connected" | "error";
export type PlanStatus = "READY" | "NEEDS_CONFIRMATION" | "NOT_EXECUTABLE" | "FAILED" | "COMMITTED";
export type EntryKind = "user" | "system" | "tool" | "error";

export interface PlannerInfo {
  id: "deterministic" | "claude" | "deepseek";
  label: string;
  isLlm: boolean;
  model?: string;
}

export interface WorkStatus {
  phase: WorkPhase;
  busy: boolean;
  blender: ConnectionState;
  blenderError?: string;
  planner: PlannerInfo;
  assetId: string | null;
  planId: string | null;
  runId: string | null;
}

export type PreviewView = "overview" | "front" | "right" | "cable";

export interface AssetInfo {
  id: string;
  name: string;
  size: number;
  mtime: number;
  previews: Partial<Record<PreviewView, string>>;
}

export interface TimelineEntry {
  id: string;
  ts: number;
  kind: EntryKind;
  text: string;
  toolName?: string;
  args?: unknown;
  status?: "running" | "ok" | "error";
  result?: string;
  durationMs?: number;
}

export interface PlanError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface Proposal {
  action: string;
  target_query: string;
  confidence: number;
  rationale: string;
  parameters: Record<string, unknown>;
}

export interface Contract {
  contract_version: string;
  scene_ir_version: string;
  run_id: string;
  source_sha256: string;
  instruction: string;
  targets: string[];
  dependencies: string[];
  write_set: string[];
  derived_allowances: Array<Record<string, unknown>>;
  freeze_set: string[];
  constraints: Array<Record<string, unknown>>;
  retry_budget: number;
  export: { enabled: boolean; profile?: string };
}

export interface TypedOperation {
  operation_id: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface PlanRequest {
  source_file: string;
  run_dir: string;
  contract: Contract;
  operations: TypedOperation[];
}

export interface PlanResolution {
  confirmTarget?: string;
  approveLowConfidence?: boolean;
}

export interface PlanReview {
  planId: string;
  sha256: string;
  status: PlanStatus;
  instruction: string;
  assetId: string;
  proposal: Proposal | null;
  planner: Record<string, unknown>;
  sourceSha256: string;
  summarySha256?: string;
  inspection?: { cache_hit: boolean; elapsed_ms: number };
  request?: PlanRequest;
  error?: PlanError;
  resolution?: PlanResolution;
}

export interface SceneInfo {
  url: string;
  version: number;
  at: number;
  kind: "verified";
  runId: string;
}

export interface RunSummary {
  runId: string;
  assetId: string;
  instruction: string;
  status: string;
  createdAt: number;
  hasGlb: boolean;
  verified: boolean;
}

export interface VerificationReport {
  status: "VERIFIED" | "FAILED";
  run_id: string;
  blender_version?: string;
  hashes?: Array<Record<string, unknown>>;
  targets?: { status?: string; checks?: Array<Record<string, unknown>> };
  locality?: { status?: string; unauthorized_changes?: unknown[] };
  export?: { status?: string; checks?: Array<Record<string, unknown>> } | null;
  error?: PlanError;
}

export interface QualityReport {
  status: string;
  run_id: string;
  targets?: { status?: string; checks?: Array<Record<string, unknown>> };
  locality?: { status?: string; unauthorized_changes?: unknown[] };
  export?: { status?: string; checks?: Array<Record<string, unknown>> } | null;
  coverage_notes?: string[];
  manifest?: Record<string, unknown>;
  error?: PlanError;
}

export interface RunDetail extends RunSummary {
  plan: PlanReview | null;
  result: Record<string, unknown> | null;
  quality: QualityReport | null;
  verification: VerificationReport | null;
  scene: SceneInfo | null;
  downloads: Partial<Record<"blend" | "glb" | "quality" | "verification" | "plan", string>>;
}

export interface WorkbenchSnapshot {
  status: WorkStatus;
  assets: AssetInfo[];
  runs: RunSummary[];
  entries: TimelineEntry[];
  plan: PlanReview | null;
  currentRun: RunDetail | null;
  scene: SceneInfo | null;
}

export type ServerEvent =
  | { type: "snapshot"; snapshot: WorkbenchSnapshot }
  | { type: "entry"; entry: TimelineEntry }
  | { type: "patch"; id: string; patch: Partial<TimelineEntry> }
  | { type: "status"; status: WorkStatus }
  | { type: "plan"; plan: PlanReview | null }
  | { type: "run"; run: RunDetail | null }
  | { type: "runs"; runs: RunSummary[] }
  | { type: "scene"; scene: SceneInfo | null }
  | { type: "clear" };

export interface ApiErrorBody {
  error?: PlanError;
}

// ── 自由建模（Studio）模式：Blender 主战场 + GLB 参考镜像 ─────────────────

export type ChatEntryKind = "user" | "assistant" | "thinking" | "tool" | "question" | "system" | "error";

export interface ChatEntry {
  id: string;
  ts: number;
  kind: ChatEntryKind;
  text: string;
  streaming?: boolean;
  toolName?: string;
  args?: unknown;
  status?: "running" | "ok" | "error";
  result?: string;
  options?: string[];
  answer?: string;
  durationMs?: number;
}

export interface ChatQuestion {
  id: string;
  question: string;
  options?: string[];
}

export type ChatConnState = "unknown" | "connecting" | "connected" | "error";

export interface ChatBaseline {
  path: string;
  sha256: string;
  size: number;
  at: number;
}

export interface ChatTurn {
  turnId: string;
  instruction: string;
  startedAt: number;
  baseline: ChatBaseline | null;
  committed: boolean;
}

export interface BlenderInfo {
  version: string;
  file: string | null;
  objects?: number;
  scene?: string | null;
}

export interface ChatStatus {
  /** Blender Bridge 插件（HTTP 9878）的连接状态 */
  bridge: ChatConnState;
  bridgeError?: string;
  blender: ChatConnState;
  blenderError?: string;
  blenderInfo?: BlenderInfo;
  deepseek: boolean;
  model: string;
  busy: boolean;
  pendingQuestion?: ChatQuestion;
  conversationId: string | null;
  conversationBaseline: ChatBaseline | null;
  turn: ChatTurn | null;
}

export interface ChatScene {
  url: string;
  version: number;
  at: number;
}

export interface ChatSnapshot {
  status: ChatStatus;
  entries: ChatEntry[];
  scene: ChatScene | null;
}

export type ChatEvent =
  | { type: "snapshot"; snapshot: ChatSnapshot }
  | { type: "entry"; entry: ChatEntry }
  | { type: "delta"; id: string; text: string }
  | { type: "patch"; id: string; patch: Partial<ChatEntry> }
  | { type: "status"; status: ChatStatus }
  | { type: "scene"; scene: ChatScene | null }
  | { type: "clear" };

export interface ChatTurnSummary {
  turnId: string;
  instruction: string;
  startedAt: number;
  committed: boolean;
  steps: number;
  baselineSha256: string | null;
  journalPath: string | null;
}
