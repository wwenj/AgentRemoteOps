import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { FileService } from "./file-service.js";
import type { OperationLogger } from "./logging.js";
import { evaluateCommand } from "./policy.js";
import type { ProcessRegistry } from "./process-registry.js";
import type { JobChunk, JobRecord, JobStatus, PermissionMode } from "./types.js";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_QUEUE = 8;

export class PolicyDeniedError extends Error {
  constructor(readonly rule: string) {
    super(`命令被权限策略拒绝：${rule}`);
  }
}

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly queue: string[] = [];
  private activeJobId: string | undefined;
  private cursor = 0;

  constructor(
    private readonly mode: PermissionMode,
    private readonly sessionId: string,
    private readonly files: FileService,
    private readonly processes: ProcessRegistry,
    private readonly logger: OperationLogger,
  ) {}

  async create(command: string, cwd = ".", timeoutMs = 60_000): Promise<JobRecord> {
    const decision = evaluateCommand(this.mode, command);
    if (!decision.allowed) {
      this.logger.event({ action: "job.denied", command, ...(decision.rule ? { rule: decision.rule } : {}), status: "denied" });
      throw new PolicyDeniedError(decision.rule ?? "unknown");
    }
    if (this.queue.length >= MAX_QUEUE) throw new Error("JOB_QUEUE_FULL");
    const resolvedCwd = await this.files.resolveCwd(cwd);
    const job: JobRecord = {
      id: `job_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      command,
      cwd: resolvedCwd,
      timeoutMs: Math.max(1_000, Math.min(timeoutMs, 600_000)),
      status: "queued",
      createdAt: new Date().toISOString(),
      chunks: [],
      outputBytes: 0,
      truncated: false,
      processIds: [],
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.dispatch();
    return job;
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].map((job) => this.publicJob(job));
  }

  get(id: string, afterCursor = 0): JobRecord | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    return { ...this.publicJob(job), chunks: job.chunks.filter((chunk) => chunk.cursor > afterCursor) };
  }

  async cancel(id: string): Promise<JobRecord | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === "queued") {
      const index = this.queue.indexOf(id);
      if (index >= 0) this.queue.splice(index, 1);
      job.status = "cancelled";
      job.completedAt = new Date().toISOString();
      return this.publicJob(job);
    }
    if (job.status === "running") {
      job.status = "cancelled";
      await this.processes.terminatePids(job.processIds);
      job.completedAt = new Date().toISOString();
    }
    return this.publicJob(job);
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.queue]) await this.cancel(id);
    if (this.activeJobId) await this.cancel(this.activeJobId);
  }

  private dispatch(): void {
    if (this.activeJobId) return;
    const id = this.queue.shift();
    if (!id) return;
    const job = this.jobs.get(id);
    if (!job) return this.dispatch();
    this.activeJobId = id;
    void this.run(job).finally(() => {
      this.activeJobId = undefined;
      this.dispatch();
    });
  }

  private async run(job: JobRecord): Promise<void> {
    const decision = evaluateCommand(this.mode, job.command);
    job.status = "running";
    job.startedAt = new Date().toISOString();
    const started = Date.now();
    this.logger.event({ action: "job.start", command: job.command, jobId: job.id, status: "started" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      job.status = "timed_out";
      void this.processes.terminatePids(job.processIds);
    }, job.timeoutMs);
    timer.unref();
    try {
      const children = this.mode === "readonly"
        ? this.spawnPipeline(decision.pipeline!, job)
        : [this.spawnShell(job)];
      job.processIds = children.map((child) => child.pid!).filter(Boolean);
      const results = await Promise.all(children.map((child) => this.waitForExit(child)));
      const last = results.at(-1)!;
      job.exitCode = last.code;
      job.signal = last.signal;
      if ((job.status as JobStatus) === "cancelled" || timedOut) return;
      job.status = last.code === 0 ? "succeeded" : "failed";
    } catch (error) {
      if ((job.status as JobStatus) !== "cancelled" && !timedOut) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      clearTimeout(timer);
      job.completedAt = new Date().toISOString();
      this.logger.event({
        action: "job.done",
        command: job.command,
        jobId: job.id,
        status: job.status,
        ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
        durationMs: Date.now() - started,
        bytes: job.outputBytes,
      });
    }
  }

  private spawnShell(job: JobRecord): ChildProcess {
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-lc", job.command], {
      cwd: job.cwd,
      detached: true,
      env: this.commandEnv(job.id),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.registerChild(child, job);
    child.stdout?.on("data", (data: Buffer) => this.append(job, "stdout", data));
    child.stderr?.on("data", (data: Buffer) => this.append(job, "stderr", data));
    return child;
  }

  private spawnPipeline(pipeline: Array<{ binary: string; args: string[] }>, job: JobRecord): ChildProcess[] {
    const children: ChildProcess[] = [];
    for (let index = 0; index < pipeline.length; index += 1) {
      const spec = pipeline[index]!;
      const child = spawn(spec.binary, this.readonlyArgs(spec.binary, spec.args), {
        cwd: job.cwd,
        detached: true,
        env: this.commandEnv(job.id),
        stdio: [index === 0 ? "ignore" : "pipe", "pipe", "pipe"],
      });
      this.registerChild(child, job);
      child.stderr?.on("data", (data: Buffer) => this.append(job, "stderr", data));
      if (index > 0) children[index - 1]!.stdout?.pipe(child.stdin!);
      children.push(child);
    }
    children.at(-1)?.stdout?.on("data", (data: Buffer) => this.append(job, "stdout", data));
    return children;
  }

  private readonlyArgs(binary: string, args: string[]): string[] {
    const name = binary.split("/").at(-1);
    if (name === "git") {
      const [subcommand, ...rest] = args;
      return [
        "-c", "core.pager=cat",
        "-c", "diff.external=",
        "--no-pager",
        ...(subcommand ? [subcommand] : []),
        ...(subcommand === "diff" ? ["--no-ext-diff", "--no-textconv"] : []),
        ...rest,
      ];
    }
    if (name === "systemctl" || name === "journalctl") return ["--no-pager", ...args];
    return args;
  }

  private registerChild(child: ChildProcess, job: JobRecord): void {
    this.processes.register(child, job.id);
    if (child.pid) job.processIds.push(child.pid);
  }

  private commandEnv(jobId: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      AGENT_REMOTEOPS_SESSION_ID: this.sessionId,
      AGENT_REMOTEOPS_JOB_ID: jobId,
      PAGER: "cat",
      SYSTEMD_PAGER: "cat",
      GIT_PAGER: "cat",
      ...(this.mode === "readonly" ? { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" } : {}),
    };
  }

  private append(job: JobRecord, stream: JobChunk["stream"], data: Buffer): void {
    if (job.outputBytes >= MAX_OUTPUT_BYTES) {
      job.truncated = true;
      return;
    }
    const remaining = MAX_OUTPUT_BYTES - job.outputBytes;
    const slice = data.subarray(0, remaining);
    job.outputBytes += slice.length;
    if (slice.length < data.length) job.truncated = true;
    job.chunks.push({ cursor: ++this.cursor, stream, data: slice.toString("utf8") });
  }

  private waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  }

  private publicJob(job: JobRecord): JobRecord {
    return { ...job, chunks: [...job.chunks], processIds: [...job.processIds] };
  }
}
