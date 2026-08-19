export type PermissionMode = "readonly" | "readwrite" | "full";

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface SessionConfig {
  id: string;
  workspace: string;
  mode: PermissionMode;
  ttlMs: number;
  auditEnabled: boolean;
  auditDir: string;
}

export interface JobChunk {
  cursor: number;
  stream: "stdout" | "stderr";
  data: string;
}

export interface JobRecord {
  id: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  deniedRule?: string;
  chunks: JobChunk[];
  outputBytes: number;
  truncated: boolean;
  processIds: number[];
}

export interface AuditEvent {
  time?: string;
  requestId?: string;
  action: string;
  status?: string;
  clientIp?: string;
  command?: string;
  path?: string;
  jobId?: string;
  rule?: string;
  exitCode?: number | null;
  durationMs?: number;
  bytes?: number;
  message?: string;
}
