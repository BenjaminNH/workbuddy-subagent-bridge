export type BackendKind = "acp" | "cli";

export type TaskStatus =
  | "created"
  | "running"
  | "awaiting_review"
  | "changes_requested"
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain";

export type PermissionMode =
  | "plan"
  | "default"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions"
  | "fullAccess"
  | "delegate";

export interface TaskRecord {
  taskId: string;
  sessionId?: string;
  backend: BackendKind;
  cwd: string;
  modelId?: string;
  permissionMode: PermissionMode;
  status: TaskStatus;
  acceptanceCriteria?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  pendingPermissions?: PermissionRequestRecord[];
  submitted: boolean;
}

export interface PermissionRequestRecord {
  requestId: string;
  method: string;
  params: unknown;
  createdAt: string;
}

export interface ModelInfo {
  modelId: string;
  name: string;
  description?: string | null;
  credits?: string;
  maxInputTokens?: number;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  source?: string;
  fetchedAt?: string;
}

export interface SessionStartInput {
  cwd: string;
  prompt: string;
  modelId?: string;
  permissionMode?: PermissionMode;
  acceptanceCriteria?: string;
  backend?: "auto" | BackendKind;
  waitForCompletion?: boolean;
}

export interface SessionMessageInput {
  taskId: string;
  message: string;
}

export interface SessionResult {
  task: TaskRecord;
  text: string;
  updates: unknown[];
}
