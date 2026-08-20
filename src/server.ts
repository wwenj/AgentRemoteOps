import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { FileService } from "./file-service.js";
import { FilePolicyError } from "./file-service.js";
import type { JobManager } from "./job-manager.js";
import { PolicyDeniedError } from "./job-manager.js";
import { localize } from "./i18n.js";
import type { OperationLogger } from "./logging.js";
import type { Locale, PermissionMode } from "./types.js";
import { safeTokenEqual } from "./utils.js";

interface ServerOptions {
  sessionId: string;
  locale: Locale;
  workingDirectory: string;
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
  let boundClientId: string | undefined;

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz") return;
    const ip = request.ip;
    const rate = authFailures.get(ip);
    if (rate && rate.resetAt > Date.now() && rate.count >= 10) {
      return reply.code(429).send({ error: { code: "AUTH_RATE_LIMITED", message: localize(options.locale, "认证失败次数过多", "Too many authentication failures") } });
    }
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !safeTokenEqual(token, options.tokenDigest)) {
      const current = rate && rate.resetAt > Date.now() ? rate : { count: 0, resetAt: Date.now() + 60_000 };
      current.count += 1;
      authFailures.set(ip, current);
      options.logger.event({ action: "auth.failed", status: "denied", clientIp: ip });
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: localize(options.locale, "Token 无效", "Invalid Token") } });
    }
    const clientId = requestClientId(request);
    if (!clientId) {
      return reply.code(400).send({ error: { code: "CLIENT_ID_REQUIRED", message: localize(options.locale, "缺少有效的 Client ID", "A valid Client ID is required") } });
    }
    const clientSummary = shortClientId(clientId);
    if (!boundClientId) {
      boundClientId = clientId;
      options.logger.event({
        action: "client.bound",
        status: "accepted",
        clientIp: ip,
        clientId: clientSummary,
        message: localize(options.locale, "首次认证成功，已锁定为本次 Session 唯一 Client ID", "First authentication succeeded; this Client ID is now the only client allowed for the Session"),
      });
      return;
    }
    if (clientId !== boundClientId) {
      options.logger.event({
        action: "client.rejected",
        status: "denied",
        clientIp: ip,
        clientId: clientSummary,
        message: localize(options.locale, `本次 Session 已绑定 Client ID ${shortClientId(boundClientId)}，拒绝其他客户端访问`, `The Session is bound to Client ID ${shortClientId(boundClientId)}; another client was rejected`),
      });
      return reply.code(403).send({
        error: { code: "CLIENT_ID_NOT_ALLOWED", message: localize(options.locale, "本次 Session 已绑定其他客户端，当前 Client ID 不允许访问", "The Session is bound to another client; this Client ID is not allowed") },
      });
    }
  });
  app.addHook("onResponse", async (request, reply) => {
    if (request.url.startsWith("/healthz")) return;
    const quietPolling = reply.statusCode < 400 && request.method === "GET" && /^\/v1\/jobs\/[^/?]+(?:\?|$)/.test(request.url);
    options.logger.event({
      action: "http.request",
      message: `${request.method} ${request.url.split("?")[0]}`,
      status: String(reply.statusCode),
      durationMs: Math.round(reply.elapsedTime),
      clientIp: request.ip,
      ...(requestClientId(request) ? { clientId: shortClientId(requestClientId(request)!) } : {}),
    }, { console: !quietPolling });
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/v1/session", async () => ({
    id: options.sessionId,
    version: "0.2.0",
    locale: options.locale,
    mode: options.mode,
    workingDirectory: options.workingDirectory,
    expiresAt: options.expiresAt.toISOString(),
    capabilities: options.mode === "readonly"
      ? ["fs.stat", "fs.list", "fs.read", "exec.readonly"]
      : ["fs.stat", "fs.list", "fs.read", "fs.write", `exec.${options.mode}`],
  }));

  app.get("/v1/jobs", async () => ({ jobs: options.jobs.list() }));
  app.post("/v1/jobs", async (request, reply) => {
    const body = parseBody(jobBody, request, reply, options.locale);
    if (!body) return;
    const key = idempotencyKey(request, reply, options.locale);
    if (!key) return;
    const existing = idempotency.get(`job:${key}`);
    if (existing) return reply.code(202).send(existing);
    try {
      const job = await options.jobs.create(body.command, body.cwd, body.timeoutMs);
      const result = { jobId: job.id, status: job.status };
      idempotency.set(`job:${key}`, result);
      return reply.code(202).send(result);
    } catch (error) {
      if (error instanceof PolicyDeniedError) return sendError(reply, 403, "POLICY_DENIED", localize(options.locale, `命令被权限策略拒绝：${error.rule}`, `Command denied by permission policy: ${error.rule}`), { rule: error.rule });
      if ((error as Error).message === "JOB_QUEUE_FULL") return sendError(reply, 429, "JOB_QUEUE_FULL", localize(options.locale, "命令队列已满", "The command queue is full"));
      throw error;
    }
  });
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>("/v1/jobs/:id", async (request, reply) => {
    const cursor = Number(request.query.cursor ?? 0);
    const job = options.jobs.get(request.params.id, Number.isFinite(cursor) ? cursor : 0);
    if (!job) return sendError(reply, 404, "JOB_NOT_FOUND", localize(options.locale, "Job 不存在", "Job not found"));
    return job;
  });
  app.post<{ Params: { id: string } }>("/v1/jobs/:id/cancel", async (request, reply) => {
    const job = await options.jobs.cancel(request.params.id);
    if (!job) return sendError(reply, 404, "JOB_NOT_FOUND", localize(options.locale, "Job 不存在", "Job not found"));
    return job;
  });

  app.post("/v1/fs/stat", async (request, reply) => {
    const body = parseBody(pathBody, request, reply, options.locale);
    if (!body) return;
    const result = await options.files.stat(body.path);
    options.logger.event({ action: "fs.stat", path: body.path, status: "success", clientIp: request.ip, clientId: shortClientId(requestClientId(request)!) });
    return result;
  });
  app.post("/v1/fs/list", async (request, reply) => {
    const body = parseBody(pathBody, request, reply, options.locale);
    if (!body) return;
    const entries = await options.files.list(body.path);
    options.logger.event({ action: "fs.list", path: body.path, status: "success", clientIp: request.ip, clientId: shortClientId(requestClientId(request)!) });
    return { entries };
  });
  app.post("/v1/fs/read", async (request, reply) => {
    const body = parseBody(pathBody, request, reply, options.locale);
    if (!body) return;
    const result = await options.files.read(body.path);
    options.logger.event({ action: "fs.read", path: body.path, status: "success", bytes: result.size, clientIp: request.ip, clientId: shortClientId(requestClientId(request)!) });
    return result;
  });
  app.post("/v1/fs/write", async (request, reply) => {
    const body = parseBody(writeBody, request, reply, options.locale);
    if (!body) return;
    const key = idempotencyKey(request, reply, options.locale);
    if (!key) return;
    const existing = idempotency.get(`write:${key}`);
    if (existing) return existing;
    const result = await options.files.write(body.path, body.content, body.ifMatch);
    idempotency.set(`write:${key}`, result);
    options.logger.event({ action: "fs.write", path: body.path, status: "success", bytes: result.size, clientIp: request.ip, clientId: shortClientId(requestClientId(request)!) });
    return result;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof FilePolicyError) {
      const status = error.code === "PRECONDITION_FAILED" ? 412
        : error.code === "FILE_TOO_LARGE" ? 413
          : error.code === "NOT_FILE" || error.code === "INVALID_CWD" ? 400
            : 403;
      const body = request.body as { path?: unknown } | undefined;
      options.logger.event({
        action: "fs.denied",
        message: options.locale === "en" ? error.messageEn : error.message,
        ...(typeof body?.path === "string" ? { path: body.path } : {}),
        status: "denied",
        code: error.code,
        clientIp: request.ip,
        ...(requestClientId(request) ? { clientId: shortClientId(requestClientId(request)!) } : {}),
      });
      return sendError(reply, status, error.code, options.locale === "en" ? error.messageEn : error.message);
    }
    if (request.url.startsWith("/v1/fs/")) {
      const systemCode = (error as NodeJS.ErrnoException).code;
      const status = systemCode === "ENOENT" ? 404 : systemCode === "EACCES" || systemCode === "EPERM" ? 403 : 500;
      const code = systemCode === "ENOENT" ? "FILE_NOT_FOUND"
        : status === 403 ? "FILE_ACCESS_DENIED"
          : "FILE_OPERATION_FAILED";
      const message = systemCode === "ENOENT"
        ? localize(options.locale, "文件或目录不存在", "File or directory not found")
        : status === 403
          ? localize(options.locale, "启动用户无权访问该路径", "The runtime user cannot access this path")
          : localize(options.locale, "文件操作执行失败", "File operation failed");
      const body = request.body as { path?: unknown } | undefined;
      options.logger.event({
        action: status < 500 ? "fs.denied" : "fs.failed",
        message,
        ...(typeof body?.path === "string" ? { path: body.path } : {}),
        status: status < 500 ? "denied" : "infrastructure_error",
        code,
        clientIp: request.ip,
        ...(requestClientId(request) ? { clientId: shortClientId(requestClientId(request)!) } : {}),
      });
      return sendError(reply, status, code, message);
    }
    const fastifyError = error as { validation?: unknown; message: string };
    if (fastifyError.validation) return sendError(reply, 400, "INVALID_REQUEST", localize(options.locale, "请求参数无效", "Invalid request"));
    return sendError(reply, 500, "INTERNAL_ERROR", localize(options.locale, "服务端执行失败", "Server execution failed"));
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error(localize(options.locale, "无法获取 HTTP 监听端口", "Unable to determine the HTTP listening port"));
  return { app, port: address.port };
}

function requestClientId(request: FastifyRequest): string | undefined {
  const value = request.headers["x-agent-remoteops-client-id"];
  if (typeof value !== "string") return undefined;
  return z.string().uuid().safeParse(value).success ? value.toLowerCase() : undefined;
}

function shortClientId(clientId: string): string {
  return clientId.slice(0, 8);
}

function parseBody<T>(schema: z.ZodType<T>, request: FastifyRequest, reply: FastifyReply, locale: Locale): T | undefined {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    void sendError(reply, 400, "INVALID_REQUEST", localize(locale, "请求参数无效", "Invalid request"));
    return undefined;
  }
  return parsed.data;
}

function idempotencyKey(request: FastifyRequest, reply: FastifyReply, locale: Locale): string | undefined {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    void sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", localize(locale, "需要有效的 Idempotency-Key", "A valid Idempotency-Key is required"));
    return undefined;
  }
  return value;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string, details?: unknown): FastifyReply {
  return reply.code(status).send({ error: { code, message, ...(details ? { details } : {}) } });
}
