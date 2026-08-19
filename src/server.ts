import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { FileService } from "./file-service.js";
import { FilePolicyError } from "./file-service.js";
import type { JobManager } from "./job-manager.js";
import { PolicyDeniedError } from "./job-manager.js";
import type { OperationLogger } from "./logging.js";
import type { PermissionMode } from "./types.js";
import { safeTokenEqual } from "./utils.js";

interface ServerOptions {
  sessionId: string;
  workspace: string;
  mode: PermissionMode;
  expiresAt: Date;
  tokenDigest: Buffer;
  jobs: JobManager;
  files: FileService;
  logger: OperationLogger;
}

const pathBody = z.object({ path: z.string().max(4096) });
const jobBody = z.object({
  command: z.string().min(1).max(16_384),
  cwd: z.string().max(4096).default("."),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
});
const writeBody = z.object({
  path: z.string().max(4096),
  content: z.string().max(16 * 1024 * 1024),
  encoding: z.literal("base64"),
  ifMatch: z.string().length(64).optional(),
});

export async function createServer(options: ServerOptions): Promise<{ app: FastifyInstance; port: number }> {
  const app = Fastify({
    logger: false,
    trustProxy: "127.0.0.1",
    bodyLimit: 16 * 1024 * 1024,
    requestTimeout: 30_000,
    keepAliveTimeout: 5_000,
  });
  const authFailures = new Map<string, { count: number; resetAt: number }>();
  const idempotency = new Map<string, unknown>();

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz") return;
    const ip = request.ip;
    const rate = authFailures.get(ip);
    if (rate && rate.resetAt > Date.now() && rate.count >= 10) {
      return reply.code(429).send({ error: { code: "AUTH_RATE_LIMITED", message: "认证失败次数过多" } });
    }
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !safeTokenEqual(token, options.tokenDigest)) {
      const current = rate && rate.resetAt > Date.now() ? rate : { count: 0, resetAt: Date.now() + 60_000 };
      current.count += 1;
      authFailures.set(ip, current);
      options.logger.event({ action: "auth.failed", status: "denied", clientIp: ip });
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Token 无效" } });
    }
  });
  app.addHook("onResponse", async (request, reply) => {
    if (request.url.startsWith("/healthz")) return;
    options.logger.event({
      action: "http.request",
      message: `${request.method} ${request.url.split("?")[0]}`,
      status: String(reply.statusCode),
      durationMs: Math.round(reply.elapsedTime),
      clientIp: request.ip,
    });
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/v1/session", async () => ({
    id: options.sessionId,
    version: "0.1.0",
    mode: options.mode,
    workspace: options.workspace,
    expiresAt: options.expiresAt.toISOString(),
    capabilities: options.mode === "readonly"
      ? ["fs.stat", "fs.list", "fs.read", "exec.readonly"]
      : ["fs.stat", "fs.list", "fs.read", "fs.write", `exec.${options.mode}`],
  }));

  app.get("/v1/jobs", async () => ({ jobs: options.jobs.list() }));
  app.post("/v1/jobs", async (request, reply) => {
    const body = parseBody(jobBody, request, reply);
    if (!body) return;
    const key = idempotencyKey(request, reply);
    if (!key) return;
    const existing = idempotency.get(`job:${key}`);
    if (existing) return reply.code(202).send(existing);
    try {
      const job = await options.jobs.create(body.command, body.cwd, body.timeoutMs);
      const result = { jobId: job.id, status: job.status };
      idempotency.set(`job:${key}`, result);
      return reply.code(202).send(result);
    } catch (error) {
      if (error instanceof PolicyDeniedError) return sendError(reply, 403, "POLICY_DENIED", error.message, { rule: error.rule });
      if ((error as Error).message === "JOB_QUEUE_FULL") return sendError(reply, 429, "JOB_QUEUE_FULL", "命令队列已满");
      throw error;
    }
  });
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>("/v1/jobs/:id", async (request, reply) => {
    const cursor = Number(request.query.cursor ?? 0);
    const job = options.jobs.get(request.params.id, Number.isFinite(cursor) ? cursor : 0);
    if (!job) return sendError(reply, 404, "JOB_NOT_FOUND", "Job 不存在");
    return job;
  });
  app.post<{ Params: { id: string } }>("/v1/jobs/:id/cancel", async (request, reply) => {
    const job = await options.jobs.cancel(request.params.id);
    if (!job) return sendError(reply, 404, "JOB_NOT_FOUND", "Job 不存在");
    return job;
  });

  app.post("/v1/fs/stat", async (request, reply) => {
    const body = parseBody(pathBody, request, reply);
    if (!body) return;
    const result = await options.files.stat(body.path);
    options.logger.event({ action: "fs.stat", path: body.path, status: "success", clientIp: request.ip });
    return result;
  });
  app.post("/v1/fs/list", async (request, reply) => {
    const body = parseBody(pathBody, request, reply);
    if (!body) return;
    const entries = await options.files.list(body.path);
    options.logger.event({ action: "fs.list", path: body.path, status: "success", clientIp: request.ip });
    return { entries };
  });
  app.post("/v1/fs/read", async (request, reply) => {
    const body = parseBody(pathBody, request, reply);
    if (!body) return;
    const result = await options.files.read(body.path);
    options.logger.event({ action: "fs.read", path: body.path, status: "success", bytes: result.size, clientIp: request.ip });
    return result;
  });
  app.post("/v1/fs/write", async (request, reply) => {
    const body = parseBody(writeBody, request, reply);
    if (!body) return;
    const key = idempotencyKey(request, reply);
    if (!key) return;
    const existing = idempotency.get(`write:${key}`);
    if (existing) return existing;
    const result = await options.files.write(body.path, body.content, body.ifMatch);
    idempotency.set(`write:${key}`, result);
    options.logger.event({ action: "fs.write", path: body.path, status: "success", bytes: result.size, clientIp: request.ip });
    return result;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof FilePolicyError) {
      const status = error.code === "PRECONDITION_FAILED" ? 412 : error.code === "NOT_FILE" ? 400 : 403;
      return sendError(reply, status, error.code, error.message);
    }
    const fastifyError = error as { validation?: unknown; message: string };
    if (fastifyError.validation) return sendError(reply, 400, "INVALID_REQUEST", fastifyError.message);
    return sendError(reply, 500, "INTERNAL_ERROR", "服务端执行失败");
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("无法获取 HTTP 监听端口");
  return { app, port: address.port };
}

function parseBody<T>(schema: z.ZodType<T>, request: FastifyRequest, reply: FastifyReply): T | undefined {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    void sendError(reply, 400, "INVALID_REQUEST", parsed.error.issues[0]?.message ?? "请求参数无效");
    return undefined;
  }
  return parsed.data;
}

function idempotencyKey(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    void sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "需要有效的 Idempotency-Key");
    return undefined;
  }
  return value;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string, details?: unknown): FastifyReply {
  return reply.code(status).send({ error: { code, message, ...(details ? { details } : {}) } });
}
