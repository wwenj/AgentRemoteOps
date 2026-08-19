import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { FileService } from "./file-service.js";
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

  async start(): Promise<{ url: string; token: string; expiresAt: Date }> {
    this.logger = new OperationLogger(this.config.auditDir, this.config.id, this.config.auditEnabled);
    this.tempDirectory = await mkdtemp(path.join(tmpdir(), "agent-remoteops-"));
    const tunnelConfig = path.join(this.tempDirectory, "cloudflared.yml");
    await writeFile(tunnelConfig, "", { mode: 0o600 });
    const token = createToken();
    const files = await FileService.create(this.config.workspace, this.config.mode);
    this.jobs = new JobManager(this.config.mode, this.config.id, files, this.processes, this.logger);
    const expiresAt = new Date(Date.now() + this.config.ttlMs);
    try {
      const server = await createServer({
        sessionId: this.config.id,
        workspace: files.workspace,
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
          process.stderr.write(`\ncloudflared unexpectedly exited (${code ?? "signal"}).\n`);
          void this.shutdown("tunnel-exit", 1);
        }
      }, this.abortController.signal);
      expiresAt.setTime(Date.now() + this.config.ttlMs);
      this.ttlTimer = setTimeout(() => void this.shutdown("ttl-expired", 0), this.config.ttlMs);
      this.ttlTimer.unref();
      this.logger.event({ action: "session.start", status: "ready", message: tunnel.url }, { console: false });
      return { url: tunnel.url, token, expiresAt };
    } catch (error) {
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
    this.abortController.abort(new Error(`Session stopping: ${reason}`));
    if (this.ttlTimer) clearTimeout(this.ttlTimer);
    process.stdout.write(`\n${reason === "ttl-expired" ? "Session TTL reached." : "Stopping Agent RemoteOps session..."}\n\n`);
    const closePromise = this.app?.close().catch(() => undefined);
    await this.jobs?.shutdown().catch(() => undefined);
    const terminated = await this.processes.terminateAll(this.config.id).catch(() => 0);
    this.app?.server.closeAllConnections?.();
    await closePromise;
    this.logger?.event({ action: "session.stop", status: reason, message: `${terminated} tracked processes terminated` });
    await this.logger?.close().catch(() => undefined);
    if (this.tempDirectory) await rm(this.tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    process.stdout.write("✓ Jobs and child processes stopped\n✓ Cloudflare Tunnel stopped\n✓ HTTP server stopped\n✓ Runtime files removed\n");
    if (this.logger?.auditPath) process.stdout.write(`✓ Audit log saved: ${this.logger.auditPath}\n`);
    process.stdout.write("\nAgent RemoteOps session closed.\n");
    this.removeSignals();
    process.exitCode = exitCode;
    this.resolveWait();
  }

  private installSignals(): void {
    const handler = (signal: NodeJS.Signals) => {
      this.signalCount += 1;
      if (this.signalCount === 1) void this.shutdown(signal, 0);
      else {
        process.stderr.write("\nForced cleanup requested.\n");
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
