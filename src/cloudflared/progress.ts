export type StartupStage =
  | "environment"
  | "binary"
  | "download"
  | "server"
  | "tunnel"
  | "health";

export interface StartupProgress {
  stage: StartupStage;
  message: string;
  attempt?: number;
  maxAttempts?: number;
  currentBytes?: number;
  totalBytes?: number;
}

export type StartupProgressListener = (progress: StartupProgress) => void;
