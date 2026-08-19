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

async function manager(mode: "readonly" | "readwrite" | "full") {
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

  it("blocks denied commands", async () => {
    const context = await manager("readwrite");
    await expect(context.manager.create("rm -rf data")).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it("runs a normal shell command", async () => {
    const context = await manager("readwrite");
    const created = await context.manager.create("printf hello > result.txt && cat result.txt");
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
