import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import type { WriteStream } from "node:fs";
import type { AuditEvent } from "./types.js";
import { redactSensitive } from "./utils.js";

const labels: Record<string, string> = {
  "session.start": "SESSION",
  "session.stop": "SESSION",
  "auth.failed": "AUTH",
  "job.start": "EXEC",
  "job.done": "EXEC",
  "job.denied": "DENIED",
  "fs.read": "FS.READ",
  "fs.write": "FS.WRITE",
  "fs.list": "FS.LIST",
  "fs.stat": "FS.STAT",
  "http.request": "HTTP",
};

export class OperationLogger {
  readonly auditPath?: string;
  private readonly stream?: WriteStream;

  constructor(auditDir: string, sessionId: string, enabled: boolean) {
    if (enabled) {
      mkdirSync(auditDir, { recursive: true, mode: 0o700 });
      this.auditPath = path.join(auditDir, `${sessionId}.jsonl`);
      this.stream = createWriteStream(this.auditPath, { flags: "a", mode: 0o600 });
    }
  }

  event(event: AuditEvent, options: { console?: boolean } = {}): void {
    const normalized: AuditEvent = {
      ...event,
      time: event.time ?? new Date().toISOString(),
      ...(event.command ? { command: redactSensitive(event.command) } : {}),
      ...(event.message ? { message: redactSensitive(event.message) } : {}),
    };
    const time = new Date(normalized.time!).toLocaleTimeString("zh-CN", { hour12: false });
    const label = (labels[normalized.action] ?? normalized.action.toUpperCase()).padEnd(8);
    const subject = normalized.command ?? normalized.path ?? normalized.message ?? "";
    const details = [
      normalized.jobId ? `job=${normalized.jobId}` : "",
      normalized.status ? `status=${normalized.status}` : "",
      normalized.rule ? `rule=${normalized.rule}` : "",
      normalized.exitCode !== undefined ? `exit=${normalized.exitCode ?? "signal"}` : "",
      normalized.durationMs !== undefined ? `duration=${normalized.durationMs}ms` : "",
      normalized.bytes !== undefined ? `bytes=${normalized.bytes}` : "",
      normalized.clientIp ? `ip=${normalized.clientIp}` : "",
    ].filter(Boolean).join(" ");
    if (options.console !== false) {
      process.stdout.write(`${time}  ${label} ${subject}${details ? `  ${details}` : ""}\n`);
    }
    this.stream?.write(`${JSON.stringify(normalized)}\n`);
  }

  async close(): Promise<void> {
    if (!this.stream || this.stream.closed) return;
    await new Promise<void>((resolve, reject) => {
      this.stream!.once("error", reject);
      this.stream!.end(resolve);
    });
  }
}
