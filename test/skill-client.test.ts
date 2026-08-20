import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { FileService } from "../src/file-service.js";
import { JobManager } from "../src/job-manager.js";
import { OperationLogger } from "../src/logging.js";
import { ProcessRegistry } from "../src/process-registry.js";
import { createServer } from "../src/server.js";
import { tokenDigest } from "../src/utils.js";

const cleanups: Array<() => Promise<void>> = [];
const execFileAsync = promisify(execFile);
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("Skill-bundled Python client", () => {
  it("uses Protocol v2 without a locally installed npm CLI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-remoteops-skill-integration-"));
    const runtime = path.join(root, "runtime");
    await writeFile(path.join(root, "test.txt"), "hello from remote\n");
    const files = await FileService.create(root, "readonly");
    const processes = new ProcessRegistry();
    const logger = new OperationLogger(root, "skill-integration", false);
    const jobs = new JobManager("readonly", "skill-integration", files, processes, logger);
    const token = "integration-test-token";
    const expiresAt = new Date(Date.now() + 60_000);
    const server = await createServer({
      sessionId: "skill-integration",
      locale: "zh-CN",
      workingDirectory: root,
      mode: "readonly",
      expiresAt,
      tokenDigest: tokenDigest(token),
      jobs,
      files,
      logger,
    });
    cleanups.push(async () => {
      await jobs.shutdown();
      await processes.terminateAll("skill-integration");
      await server.app.close();
      await logger.close();
      await rm(root, { recursive: true, force: true });
    });

    const stateRoot = path.join(runtime, "agent-remoteops-skill");
    const sessions = path.join(stateRoot, "sessions");
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const state = {
      id: "skill-integration",
      url: `http://127.0.0.1:${server.port}`,
      token,
      client_id: "11111111-1111-4111-8111-111111111111",
      expires_at: expiresAt.toISOString(),
      server_version: "0.3.1",
      protocol_version: 2,
      mode: "readonly",
      working_directory: root,
      locale: "zh-CN",
    };
    await writeFile(path.join(sessions, "skill-integration.json"), `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await writeFile(path.join(stateRoot, "current"), `${JSON.stringify({ id: "skill-integration" })}\n`, { mode: 0o600 });
    const script = path.resolve("skills/agent-remoteops/scripts/remoteops.py");
    const env = { ...process.env, XDG_RUNTIME_DIR: runtime };

    const status = await execFileAsync("python3", [script, "status"], { encoding: "utf8", env });
    expect(JSON.parse(status.stdout)).toMatchObject({ serverVersion: "0.3.1", protocolVersion: 2, mode: "readonly" });

    const execute = await execFileAsync("python3", [script, "exec", "cat test.txt", "--json"], { encoding: "utf8", env });
    expect(JSON.parse(execute.stdout).chunks.map((chunk: { data: string }) => chunk.data).join("")).toContain("hello from remote");
  });

  it("writes, reads, and cancels Jobs in full mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-remoteops-skill-full-"));
    const runtime = path.join(root, "runtime");
    const upload = path.join(root, "upload.txt");
    const download = path.join(root, "download.txt");
    await writeFile(upload, "written through Skill\n");
    const files = await FileService.create(root, "full");
    const processes = new ProcessRegistry();
    const logger = new OperationLogger(root, "skill-full", false);
    const jobs = new JobManager("full", "skill-full", files, processes, logger);
    const token = "integration-full-token";
    const clientId = "22222222-2222-4222-8222-222222222222";
    const expiresAt = new Date(Date.now() + 60_000);
    const server = await createServer({
      sessionId: "skill-full", locale: "zh-CN", workingDirectory: root, mode: "full", expiresAt,
      tokenDigest: tokenDigest(token), jobs, files, logger,
    });
    cleanups.push(async () => {
      await jobs.shutdown();
      await processes.terminateAll("skill-full");
      await server.app.close();
      await logger.close();
      await rm(root, { recursive: true, force: true });
    });

    const stateRoot = path.join(runtime, "agent-remoteops-skill");
    const sessions = path.join(stateRoot, "sessions");
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const url = `http://127.0.0.1:${server.port}`;
    await writeFile(path.join(sessions, "skill-full.json"), `${JSON.stringify({
      id: "skill-full", url, token, client_id: clientId, expires_at: expiresAt.toISOString(),
      server_version: "0.3.1", protocol_version: 2, mode: "full", working_directory: root, locale: "zh-CN",
    })}\n`, { mode: 0o600 });
    await writeFile(path.join(stateRoot, "current"), `${JSON.stringify({ id: "skill-full" })}\n`, { mode: 0o600 });
    const script = path.resolve("skills/agent-remoteops/scripts/remoteops.py");
    const env = { ...process.env, XDG_RUNTIME_DIR: runtime };

    await execFileAsync("python3", [script, "status"], { encoding: "utf8", env });
    const written = await execFileAsync("python3", [script, "write", upload, "remote.txt"], { encoding: "utf8", env });
    expect(JSON.parse(written.stdout)).toMatchObject({ size: 22 });
    await execFileAsync("python3", [script, "read", "remote.txt", "--out", download], { encoding: "utf8", env });
    expect(await readFile(download, "utf8")).toBe("written through Skill\n");

    const created = await fetch(`${url}/v2/jobs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-agent-remoteops-client-id": clientId,
        "x-agent-remoteops-protocol": "2",
        "idempotency-key": "skill-cancel-test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "sleep 30", timeoutMs: 60_000 }),
    });
    const { jobId } = await created.json() as { jobId: string };
    const cancelled = await execFileAsync("python3", [script, "cancel", jobId], { encoding: "utf8", env });
    expect(JSON.parse(cancelled.stdout)).toMatchObject({ id: jobId, status: "cancelled" });
  });
});
