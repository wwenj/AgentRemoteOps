import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudflaredSpec } from "../src/cloudflared/manifest.js";
import { resolveCloudflared } from "../src/cloudflared/resolver.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cloudflared resolver", () => {
  it("prefers an explicitly configured executable", async () => {
    const root = await makeRoot();
    const binary = await executable(path.join(root, "custom-cloudflared"), "custom");
    const result = await resolveCloudflared({
      signal: new AbortController().signal,
      locale: "zh-CN",
      platform: "darwin",
      arch: "arm64",
      env: { AGENT_REMOTEOPS_CLOUDFLARED: binary },
    });
    expect(result).toBe(binary);
  });

  it("uses the verified platform package before cache or download", async () => {
    const root = await makeRoot();
    const content = "bundled";
    const binary = await executable(path.join(root, "bundled-cloudflared"), content);
    const downloader = vi.fn();
    const result = await resolveCloudflared({
      signal: new AbortController().signal,
      locale: "zh-CN",
      env: {},
      cacheRoot: root,
      spec: specFor(content),
      packageResolve: (specifier) => {
        expect(specifier).toBe("agent-remoteops-cloudflared-linux-x64/bin/cloudflared");
        return binary;
      },
      downloader,
    });
    expect(result).toBe(binary);
    expect(downloader).not.toHaveBeenCalled();
  });

  it("reuses a verified legacy cache when the optional package is missing", async () => {
    const root = await makeRoot();
    const content = "cached";
    const spec = specFor(content);
    const binary = path.join(root, "agent-remoteops", "cloudflared", spec.version, spec.asset);
    await mkdir(path.dirname(binary), { recursive: true });
    await executable(binary, content);
    const result = await resolveCloudflared({
      signal: new AbortController().signal,
      locale: "zh-CN",
      env: {},
      cacheRoot: root,
      spec,
      packageResolve: () => { throw Object.assign(new Error("missing"), { code: "MODULE_NOT_FOUND" }); },
      downloader: vi.fn(),
    });
    expect(result).toBe(binary);
  });

  it("downloads internally when package and cache are unavailable", async () => {
    const root = await makeRoot();
    const downloader = vi.fn().mockResolvedValue("/downloaded/cloudflared");
    const result = await resolveCloudflared({
      signal: new AbortController().signal,
      locale: "zh-CN",
      env: {},
      cacheRoot: root,
      spec: specFor("expected"),
      packageResolve: () => { throw Object.assign(new Error("missing"), { code: "MODULE_NOT_FOUND" }); },
      downloader,
    });
    expect(result).toBe("/downloaded/cloudflared");
    expect(downloader).toHaveBeenCalledOnce();
  });

  it("rejects unsupported remote platforms", async () => {
    await expect(resolveCloudflared({
      signal: new AbortController().signal,
      locale: "en",
      platform: "darwin",
      arch: "arm64",
      env: {},
    })).rejects.toThrow("does not support darwin/arm64");
  });
});

function specFor(content: string): CloudflaredSpec {
  return {
    version: "test-version",
    releaseBaseUrl: "https://example.test/releases",
    platform: "linux",
    arch: "x64",
    asset: "cloudflared-linux-amd64",
    packageName: "agent-remoteops-cloudflared-linux-x64",
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-remoteops-resolver-"));
  roots.push(root);
  return root;
}

async function executable(file: string, content: string): Promise<string> {
  await writeFile(file, content);
  await chmod(file, 0o755);
  return file;
}
