import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileService } from "../src/file-service.js";
import { JobManager, PolicyDeniedError } from "../src/job-manager.js";
import { OperationLogger } from "../src/logging.js";
import { ProcessRegistry } from "../src/process-registry.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function manager(mode: "readonly" | "full") {
  const root = await mkdtemp(path.join(tmpdir(), "agent-remoteops-jobs-"));
  directories.push(root);
  const files = await FileService.create(root, mode);
  const registry = new ProcessRegistry();
  const logger = new OperationLogger(root, "test", false);
  return { manager: new JobManager(mode, "test", files, registry, logger), root, registry };
}

async function wait(manager: JobManager, id: string) {
  for (let index = 0; index < 100; index += 1) {
    const job = manager.get(id)!;
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("job timeout");
}

describe("JobManager", () => {
  it("executes a readonly pipeline", async () => {
    const context = await manager("readonly");
    await writeFile(path.join(context.root, "data.txt"), "alpha\nbeta\n");
    const created = await context.manager.create("cat data.txt | grep beta");
    const job = await wait(context.manager, created.id);
    expect(job.status).toBe("succeeded");
    expect(job.chunks.map((chunk) => chunk.data).join("")).toContain("beta");
  });

  it("does not crash when a pipeline consumer exits before its producer", async () => {
    const context = await manager("readonly");
    await writeFile(path.join(context.root, "large.txt"), `first\n${"value\n".repeat(400_000)}`);
    const created = await context.manager.create("cat large.txt | head -n 1");
    const job = await wait(context.manager, created.id);
    expect(job.status).toBe("succeeded");
    expect(job.error).toBeUndefined();
    expect(job.chunks.map((chunk) => chunk.data).join("")).toBe("first\n");
  });

  it("executes readonly conditional sequences with Shell-compatible exit semantics", async () => {
    const context = await manager("readonly");
    const created = await context.manager.create("false && echo skipped; true || echo skipped; false || echo recovered; printf done");
    const job = await wait(context.manager, created.id);
    expect(job.status).toBe("succeeded");
    expect(job.exitCode).toBe(0);
    expect(job.chunks.map((chunk) => chunk.data).join("")).toBe("recovered\ndone");
  });

  it("uses the final executed group exit code", async () => {
    const context = await manager("readonly");
    const created = await context.manager.create("true; false");
    const job = await wait(context.manager, created.id);
    expect(job.status).toBe("failed");
    expect(job.exitCode).toBe(1);
    expect(job.error).toBeUndefined();
  });

  it("rejects an unsafe sequence before running any group", async () => {
    const context = await manager("readonly");
    await expect(context.manager.create("echo safe; python3 -c 'print(1)'")).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(context.manager.list()).toHaveLength(0);
  });

  it("runs unrestricted Shell commands in full mode", async () => {
    const context = await manager("full");
    const outside = await mkdtemp(path.join(tmpdir(), "agent-remoteops-outside-"));
    directories.push(outside);
    const target = path.join(outside, "result.txt");
    const created = await context.manager.create(`printf hello > '${target}' && cat '${target}'`);
    const job = await wait(context.manager, created.id);
    expect(job.status).toBe("succeeded");
    expect(job.chunks.map((chunk) => chunk.data).join("")).toBe("hello");
  });

  it("cancels a running process group", async () => {
    const context = await manager("full");
    const created = await context.manager.create("sleep 30");
    let pid: number | undefined;
    for (let index = 0; index < 50; index += 1) {
      const job = context.manager.get(created.id)!;
      pid = job.processIds[0];
      if (job.status === "running" && pid) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(pid).toBeTypeOf("number");
    const cancelled = await context.manager.cancel(created.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(() => process.kill(pid!, 0)).toThrow();
  });
});
