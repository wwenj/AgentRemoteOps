import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileService } from "../src/file-service.js";
import { JobManager } from "../src/job-manager.js";
import { OperationLogger } from "../src/logging.js";
import { ProcessRegistry } from "../src/process-registry.js";
import { createServer } from "../src/server.js";
import { tokenDigest } from "../src/utils.js";
import type { Locale } from "../src/types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function fixture(mode: "readonly" | "full" = "readonly", locale: Locale = "zh-CN", auditEnabled = false) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-remoteops-server-"));
  await writeFile(path.join(root, "test.txt"), "hello");
  const files = await FileService.create(root, mode);
  const processes = new ProcessRegistry();
  const logger = new OperationLogger(root, "server-test", auditEnabled, locale);
  const jobs = new JobManager(mode, "server-test", files, processes, logger);
  const token = "arops_test_token";
  const server = await createServer({
    sessionId: "server-test",
    locale,
    workingDirectory: root,
    mode,
    expiresAt: new Date(Date.now() + 60_000),
    tokenDigest: tokenDigest(token),
    jobs,
    files,
    logger,
  });
  cleanups.push(async () => {
    await jobs.shutdown();
    await processes.terminateAll("server-test");
    await server.app.close();
    await logger.close();
    await rm(root, { recursive: true, force: true });
  });
  return { ...server, token, root, logger };
}

const clientA = "11111111-1111-4111-8111-111111111111";
const clientB = "22222222-2222-4222-8222-222222222222";

function auth(token: string, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${token}`,
    "x-agent-remoteops-client-id": clientA,
    "x-agent-remoteops-protocol": "2",
    ...extra,
  };
}

describe("HTTP server", () => {
  it("exposes only health without authentication", async () => {
    const context = await fixture();
    expect((await context.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await context.app.inject({ method: "GET", url: "/v2/session" })).statusCode).toBe(426);
    expect((await context.app.inject({ method: "GET", url: "/v2/session", headers: { "x-agent-remoteops-protocol": "2" } })).statusCode).toBe(401);
    const session = await context.app.inject({ method: "GET", url: "/v2/session", headers: auth(context.token) });
    expect(session.statusCode).toBe(200);
    expect(session.json().mode).toBe("readonly");
    expect(session.json().serverVersion).toBe("0.4.0");
    expect(session.json().protocolVersion).toBe(2);
    expect(session.json().workingDirectory).toBeTypeOf("string");
    expect(session.json().workspace).toBeUndefined();
  });

  it("rejects legacy clients before binding a Client ID", async () => {
    const context = await fixture();
    const legacy = await context.app.inject({
      method: "GET",
      url: "/v1/session",
      headers: { authorization: `Bearer ${context.token}`, "x-agent-remoteops-client-id": clientA },
    });
    expect(legacy.statusCode).toBe(426);
    expect(legacy.json().error.code).toBe("PROTOCOL_VERSION_UNSUPPORTED");

    const current = await context.app.inject({
      method: "GET",
      url: "/v2/session",
      headers: auth(context.token, { "x-agent-remoteops-client-id": clientB }),
    });
    expect(current.statusCode).toBe(200);
  });

  it("requires and binds a stable Client ID instead of an IP", async () => {
    const context = await fixture();
    const firstClient = auth(context.token, { "x-forwarded-for": "203.0.113.10" });
    const sameClientNewIp = auth(context.token, { "x-forwarded-for": "203.0.113.11" });
    const otherClient = auth(context.token, { "x-agent-remoteops-client-id": clientB, "x-forwarded-for": "203.0.113.10" });

    expect((await context.app.inject({ method: "GET", url: "/healthz", headers: otherClient })).statusCode).toBe(200);
    expect((await context.app.inject({
      method: "GET",
      url: "/v2/session",
      headers: auth("invalid-token", { "x-forwarded-for": "203.0.113.11" }),
    })).statusCode).toBe(401);
    expect((await context.app.inject({ method: "GET", url: "/v2/session", headers: firstClient })).statusCode).toBe(200);
    expect((await context.app.inject({ method: "GET", url: "/v2/session", headers: sameClientNewIp })).statusCode).toBe(200);

    const rejected = await context.app.inject({ method: "GET", url: "/v2/session", headers: otherClient });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error.code).toBe("CLIENT_ID_NOT_ALLOWED");

    const missing = await context.app.inject({
      method: "GET", url: "/v2/session", headers: { authorization: `Bearer ${context.token}`, "x-agent-remoteops-protocol": "2" },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("CLIENT_ID_REQUIRED");
  });

  it("returns English messages for an English Session", async () => {
    const context = await fixture("readonly", "en");
    const unauthorized = await context.app.inject({ method: "GET", url: "/v2/session", headers: { "x-agent-remoteops-protocol": "2" } });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json().error.message).toBe("Invalid Token");

    const session = await context.app.inject({ method: "GET", url: "/v2/session", headers: auth(context.token) });
    expect(session.json().locale).toBe("en");

    const write = await context.app.inject({
      method: "POST", url: "/v2/fs/write",
      headers: auth(context.token, { "idempotency-key": "english-write-key" }),
      payload: { path: "test.txt", content: Buffer.from("x").toString("base64"), encoding: "base64" },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.message).toBe("File writes are not allowed in readonly mode");
  });

  it("reads files and rejects readonly writes", async () => {
    const context = await fixture();
    const read = await context.app.inject({
      method: "POST", url: "/v2/fs/read", headers: auth(context.token), payload: { path: "test.txt" },
    });
    expect(Buffer.from(read.json().content, "base64").toString()).toBe("hello");
    const write = await context.app.inject({
      method: "POST", url: "/v2/fs/write",
      headers: auth(context.token, { "idempotency-key": "write-test-key" }),
      payload: { path: "test.txt", content: Buffer.from("x").toString("base64"), encoding: "base64" },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe("CAPABILITY_DENIED");

    const missing = await context.app.inject({
      method: "POST", url: "/v2/fs/read", headers: auth(context.token), payload: { path: "/definitely-not-an-agent-remoteops-file" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("FILE_NOT_FOUND");
  });

  it("keeps successful Job polling in audit but suppresses it from terminal output", async () => {
    const context = await fixture("readonly", "zh-CN", true);
    const created = await context.app.inject({
      method: "POST", url: "/v2/jobs",
      headers: auth(context.token, { "idempotency-key": "command-test-key" }),
      payload: { command: "cat test.txt" },
    });
    expect(created.statusCode).toBe(202);
    const id = created.json().jobId as string;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let result;
    for (let index = 0; index < 50; index += 1) {
      result = await context.app.inject({ method: "GET", url: `/v2/jobs/${id}`, headers: auth(context.token) });
      if (result.json().status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(result!.json().status).toBe("succeeded");
    expect(result!.json().chunks[0].data).toContain("hello");
    const terminalOutput = write.mock.calls.map(([value]) => String(value)).join("");
    expect(terminalOutput).not.toContain(`GET /v2/jobs/${id}`);
    write.mockRestore();
    await context.logger.close();
    const audit = await readFile(path.join(context.root, "server-test.jsonl"), "utf8");
    expect(audit).toContain(`GET /v2/jobs/${id}`);
  });
});
