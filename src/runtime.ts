import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { FileService } from "./file-service.js";
import { localize } from "./i18n.js";
import { JobManager } from "./job-manager.js";
import { OperationLogger } from "./logging.js";
import { ProcessRegistry } from "./process-registry.js";
import { createServer } from "./server.js";
import { startTunnel } from "./tunnel.js";
import type { SessionConfig } from "./types.js";
import { createToken, tokenDigest } from "./utils.js";

export class AgentRemoteOpsRuntime {
  private readonly processes = new ProcessRegistry();
  private logger?: OperationLogger;
  private jobs?: JobManager;
  private app?: FastifyInstance;
  private tempDirectory?: string;
  private ttlTimer?: NodeJS.Timeout;
  private stopping = false;
  private shutdownPromise?: Promise<void>;
  private resolveWait!: () => void;
  private readonly waitPromise = new Promise<void>((resolve) => { this.resolveWait = resolve; });
  private signalCount = 0;
  private signalHandler: ((signal: NodeJS.Signals) => void) | undefined;
  private readonly abortController = new AbortController();

  constructor(private readonly config: SessionConfig) {}

  async start(onStartupFailure?: () => void): Promise<{ url: string; token: string; expiresAt: Date }> {
    this.logger = new OperationLogger(this.config.auditDir, this.config.id, this.config.auditEnabled, this.config.locale);
    this.tempDirectory = await mkdtemp(path.join(tmpdir(), "agent-remoteops-"));
    const tunnelConfig = path.join(this.tempDirectory, "cloudflared.yml");
    await writeFile(tunnelConfig, "", { mode: 0o600 });
    const token = createToken();
    const files = await FileService.create(this.config.workingDirectory, this.config.mode, this.config.locale);
    this.jobs = new JobManager(this.config.mode, this.config.id, files, this.processes, this.logger);
    const expiresAt = new Date(Date.now() + this.config.ttlMs);
    try {
      const server = await createServer({
        sessionId: this.config.id,
        locale: this.config.locale,
        workingDirectory: files.workingDirectory,
        mode: this.config.mode,
        expiresAt,
        tokenDigest: tokenDigest(token),
        jobs: this.jobs,
        files,
        logger: this.logger,
      });
      this.app = server.app;
      this.installSignals();
      const tunnel = await startTunnel(server.port, this.processes, tunnelConfig, (code) => {
        if (!this.stopping) {
          process.stderr.write(`\n${localize(this.config.locale, `Cloudflare Tunnel 异常退出（${code ?? "信号终止"}）。`, `Cloudflare Tunnel exited unexpectedly (${code ?? "signal"}).`)}\n`);
          void this.shutdown("tunnel-exit", 1);
        }
      }, this.abortController.signal, this.config.locale);
      expiresAt.setTime(Date.now() + this.config.ttlMs);
      this.ttlTimer = setTimeout(() => void this.shutdown("ttl-expired", 0), this.config.ttlMs);
      this.ttlTimer.unref();
      this.logger.event({ action: "session.start", status: "ready", message: tunnel.url }, { console: false });
      return { url: tunnel.url, token, expiresAt };
    } catch (error) {
      onStartupFailure?.();
      await this.shutdown("startup-failed", 1);
      throw error;
    }
  }

  async wait(): Promise<void> {
    await this.waitPromise;
  }

  shutdown(reason: string, exitCode = 0): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown(reason, exitCode);
    return this.shutdownPromise;
  }

  private async performShutdown(reason: string, exitCode: number): Promise<void> {
    this.stopping = true;
    this.abortController.abort(new Error(localize(this.config.locale, `Session 正在停止：${reason}`, `Session stopping: ${reason}`)));
    if (this.ttlTimer) clearTimeout(this.ttlTimer);
    process.stdout.write(`\n${reason === "ttl-expired"
      ? localize(this.config.locale, "Session 有效期已到。", "Session lifetime reached.")
      : localize(this.config.locale, "正在停止 Agent RemoteOps Session……", "Stopping the Agent RemoteOps Session...")}\n\n`);
    const closePromise = this.app?.close().catch(() => undefined);
    await this.jobs?.shutdown().catch(() => undefined);
    const terminated = await this.processes.terminateAll(this.config.id).catch(() => 0);
    this.app?.server.closeAllConnections?.();
    await closePromise;
    this.logger?.event({
      action: "session.stop",
      status: reason,
      message: localize(this.config.locale, `已终止 ${terminated} 个受跟踪进程`, `Terminated ${terminated} tracked processes`),
    });
    await this.logger?.close().catch(() => undefined);
    if (this.tempDirectory) await rm(this.tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    process.stdout.write(`${localize(
      this.config.locale,
      "✓ Job 和子进程已停止\n✓ Cloudflare Tunnel 已停止\n✓ HTTP 服务已停止\n✓ 临时运行文件已清理",
      "✓ Jobs and child processes stopped\n✓ Cloudflare Tunnel stopped\n✓ HTTP service stopped\n✓ Temporary runtime files removed",
    )}\n`);
    if (this.logger?.auditPath) process.stdout.write(`${localize(this.config.locale, "✓ 审计日志已保存", "✓ Audit log saved")}: ${this.logger.auditPath}\n`);
    process.stdout.write(`\n${localize(this.config.locale, "Agent RemoteOps Session 已关闭。", "Agent RemoteOps Session closed.")}\n`);
    this.removeSignals();
    process.exitCode = exitCode;
    this.resolveWait();
  }

  private installSignals(): void {
    const handler = (signal: NodeJS.Signals) => {
      this.signalCount += 1;
      if (this.signalCount === 1) void this.shutdown(signal, 0);
      else {
        process.stderr.write(`\n${localize(this.config.locale, "已请求强制清理。", "Forced cleanup requested.")}\n`);
        void this.processes.terminateAll(this.config.id).finally(() => {
          process.exitCode = 130;
          this.resolveWait();
        });
      }
    };
    this.signalHandler = handler;
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
    process.on("SIGHUP", handler);
  }

  private removeSignals(): void {
    if (!this.signalHandler) return;
    process.off("SIGINT", this.signalHandler);
    process.off("SIGTERM", this.signalHandler);
    process.off("SIGHUP", this.signalHandler);
    this.signalHandler = undefined;
  }
}
