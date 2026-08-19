import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { FilePolicyError, FileService } from "../src/file-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-remoteops-test-"));
  directories.push(directory);
  return directory;
}

describe("FileService", () => {
  it("reads, lists and atomically writes files", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "a.txt"), "alpha");
    const service = await FileService.create(root, "readwrite");
    const original = await service.read("a.txt");
    expect(Buffer.from(original.content, "base64").toString()).toBe("alpha");
    const result = await service.write("a.txt", Buffer.from("beta").toString("base64"), original.sha256);
    expect(result.size).toBe(4);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("beta");
    expect((await service.list(".")).map((entry) => entry.name)).toContain("a.txt");
  });

  it("enforces readonly writes", async () => {
    const service = await FileService.create(await workspace(), "readonly");
    await expect(service.write("a.txt", Buffer.from("x").toString("base64"))).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
  });

  it("rejects traversal and symlinks", async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(path.join(outside, "secret"), "secret");
    await symlink(outside, path.join(root, "link"));
    const service = await FileService.create(root, "readwrite");
    await expect(service.read("../secret")).rejects.toBeInstanceOf(FilePolicyError);
    await expect(service.read("link/secret")).rejects.toBeInstanceOf(FilePolicyError);
  });

  it("rejects stale ifMatch", async () => {
    const root = await workspace();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "a.txt"), "new");
    const service = await FileService.create(root, "readwrite");
    await expect(service.write("src/a.txt", Buffer.from("x").toString("base64"), "0".repeat(64))).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
