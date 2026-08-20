import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileService } from "../src/file-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-remoteops-test-"));
  directories.push(directory);
  return directory;
}

describe("FileService", () => {
  it("allows readonly access to absolute paths, parent traversal, and symlinks", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const secret = path.join(outside, "secret.txt");
    await writeFile(secret, "secret");
    await symlink(secret, path.join(root, "secret-link"));
    const service = await FileService.create(root, "readonly");

    const absolute = await service.read(secret);
    const traversed = await service.read(path.relative(root, secret));
    const linked = await service.read("secret-link");
    expect([absolute, traversed, linked].map((result) => Buffer.from(result.content, "base64").toString())).toEqual(["secret", "secret", "secret"]);
  });

  it("always rejects writes in readonly mode", async () => {
    const root = await temporaryDirectory();
    const service = await FileService.create(root, "readonly");
    await expect(service.write(path.join(root, "a.txt"), Buffer.from("x").toString("base64"))).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
  });

  it("allows full mode to atomically write outside workingDirectory", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const target = path.join(outside, "nested", "a.txt");
    const service = await FileService.create(root, "full");
    const result = await service.write(target, Buffer.from("alpha").toString("base64"));
    expect(result.size).toBe(5);
    expect(await readFile(target, "utf8")).toBe("alpha");

    const original = await service.read(target);
    await service.write(path.relative(root, target), Buffer.from("beta").toString("base64"), original.sha256);
    expect(await readFile(target, "utf8")).toBe("beta");
  });

  it("follows an existing symlink when writing in full mode", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const target = path.join(outside, "target.txt");
    await writeFile(target, "before");
    await symlink(target, path.join(root, "target-link"));
    const service = await FileService.create(root, "full");
    await service.write("target-link", Buffer.from("after").toString("base64"));
    expect(await readFile(target, "utf8")).toBe("after");
  });

  it("rejects stale ifMatch", async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "a.txt"), "new");
    const service = await FileService.create(root, "full");
    await expect(service.write("src/a.txt", Buffer.from("x").toString("base64"), "0".repeat(64))).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
