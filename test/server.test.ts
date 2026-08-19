import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileService } from "../src/file-service.js";
import { JobManager } from "../src/job-manager.js";
import { OperationLogger } from "../src/logging.js";
import { ProcessRegistry } from "../src/process-registry.js";
import { createServer } from "../src/server.js";
import { tokenDigest } from "../src/utils.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function fixture(mode: "readonly" | "readwrite" = "readonly") {
  const root = await mkdtemp(path.join(tmpdir(), "agent-remoteops-server-"));
  await writeFile(path.join(root, "test.txt"), "hello");
  const files = await FileService.create(root, mode);
  const processes = new ProcessRegistry();
  const logger = new OperationLogger(root, "server-test", false);
  const jobs = new JobManager(mode, "server-test", files, processes, logger);
  const token = "arops_test_token";
  const server = await createServer({
    sessionId: "server-test",
    workspace: root,
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
    await rm(root, { recursive: true, force: true });
  });
  return { ...server, token };
}

function auth(token: string, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${token}`, ...extra };
}

describe("HTTP server", () => {
  it("exposes only health without authentication", async () => {
    const context = await fixture();
    expect((await context.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await context.app.inject({ method: "GET", url: "/v1/session" })).statusCode).toBe(401);
    const session = await context.app.inject({ method: "GET", url: "/v1/session", headers: auth(context.token) });
    expect(session.statusCode).toBe(200);
    expect(session.json().mode).toBe("readonly");
  });

  it("reads files and rejects readonly writes", async () => {
    const context = await fixture();
    const read = await context.app.inject({
      method: "POST", url: "/v1/fs/read", headers: auth(context.token), payload: { path: "test.txt" },
    });
    expect(Buffer.from(read.json().content, "base64").toString()).toBe("hello");
    const write = await context.app.inject({
      method: "POST", url: "/v1/fs/write",
      headers: auth(context.token, { "idempotency-key": "write-test-key" }),
      payload: { path: "test.txt", content: Buffer.from("x").toString("base64"), encoding: "base64" },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe("CAPABILITY_DENIED");
  });

  it("creates and polls a command Job", async () => {
    const context = await fixture();
    const created = await context.app.inject({
      method: "POST", url: "/v1/jobs",
      headers: auth(context.token, { "idempotency-key": "command-test-key" }),
      payload: { command: "cat test.txt" },
    });
    expect(created.statusCode).toBe(202);
    const id = created.json().jobId as string;
    let result;
    for (let index = 0; index < 50; index += 1) {
      result = await context.app.inject({ method: "GET", url: `/v1/jobs/${id}`, headers: auth(context.token) });
      if (result.json().status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(result!.json().status).toBe("succeeded");
    expect(result!.json().chunks[0].data).toContain("hello");
  });
});
