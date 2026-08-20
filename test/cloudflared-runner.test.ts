import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTunnel } from "../src/cloudflared/runner.js";
import { ProcessRegistry } from "../src/process-registry.js";

const roots: string[] = [];
const previousTunnel = process.env.AGENT_REMOTEOPS_TUNNEL;

afterEach(async () => {
  if (previousTunnel === undefined) delete process.env.AGENT_REMOTEOPS_TUNNEL;
  else process.env.AGENT_REMOTEOPS_TUNNEL = previousTunnel;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cloudflared runner", () => {
  it("extracts the Quick Tunnel URL and verifies public health", async () => {
    delete process.env.AGENT_REMOTEOPS_TUNNEL;
    const root = await makeRoot();
    const binary = await script(root, "echo 'https://steady-example.trycloudflare.com' >&2\nwhile true; do sleep 1; done");
    const registry = new ProcessRegistry();
    try {
      const progress: string[] = [];
      const result = await startTunnel({
        port: 32123,
        registry,
        configPath: path.join(root, "cloudflared.yml"),
        onUnexpectedExit: vi.fn(),
        signal: new AbortController().signal,
        locale: "en",
        resolveBinary: async () => binary,
        fetchImpl: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })) as typeof fetch,
        onProgress: (event) => progress.push(event.stage),
      });
      expect(result.url).toBe("https://steady-example.trycloudflare.com");
      expect(progress).toContain("tunnel");
      expect(progress).toContain("health");
    } finally {
      await registry.terminateAll("runner-test");
    }
  });

  it("fails quickly when cloudflared exits before returning a URL", async () => {
    delete process.env.AGENT_REMOTEOPS_TUNNEL;
    const root = await makeRoot();
    const binary = await script(root, "echo 'edge connection refused' >&2\nexit 2");
    const registry = new ProcessRegistry();
    await expect(startTunnel({
      port: 32123,
      registry,
      configPath: path.join(root, "cloudflared.yml"),
      onUnexpectedExit: vi.fn(),
      signal: new AbortController().signal,
      locale: "en",
      resolveBinary: async () => binary,
      urlTimeoutMs: 500,
    })).rejects.toThrow(/exited before.*edge connection refused/i);
  });

  it("bounds waiting for a URL", async () => {
    delete process.env.AGENT_REMOTEOPS_TUNNEL;
    const root = await makeRoot();
    const binary = await script(root, "while true; do sleep 1; done");
    const registry = new ProcessRegistry();
    try {
      await expect(startTunnel({
        port: 32123,
        registry,
        configPath: path.join(root, "cloudflared.yml"),
        onUnexpectedExit: vi.fn(),
        signal: new AbortController().signal,
        locale: "en",
        resolveBinary: async () => binary,
        urlTimeoutMs: 30,
      })).rejects.toThrow("Timed out waiting");
    } finally {
      await registry.terminateAll("runner-timeout-test");
    }
  });

  it("bounds public health verification and cleans up the tracked process", async () => {
    delete process.env.AGENT_REMOTEOPS_TUNNEL;
    const root = await makeRoot();
    const binary = await script(root, "echo 'https://unhealthy-example.trycloudflare.com' >&2\nwhile true; do sleep 1; done");
    const registry = new ProcessRegistry();
    try {
      const failure = startTunnel({
        port: 32123,
        registry,
        configPath: path.join(root, "cloudflared.yml"),
        onUnexpectedExit: vi.fn(),
        signal: new AbortController().signal,
        locale: "en",
        resolveBinary: async () => binary,
        fetchImpl: vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })) as typeof fetch,
        healthTimeoutMs: 30,
      });
      await expect(failure).rejects.toThrow("Tunnel health check failed");
      await expect(failure).rejects.toThrow("https://unhealthy-example.trycloudflare.com/healthz");
      await expect(failure).rejects.toThrow("HTTP 503");
    } finally {
      await registry.terminateAll("runner-health-test");
    }
  });

  it("skips binary resolution entirely in local-only mode", async () => {
    process.env.AGENT_REMOTEOPS_TUNNEL = "none";
    const resolveBinary = vi.fn();
    const result = await startTunnel({
      port: 32123,
      registry: new ProcessRegistry(),
      configPath: "/unused",
      onUnexpectedExit: vi.fn(),
      signal: new AbortController().signal,
      locale: "en",
      resolveBinary,
    });
    expect(result.url).toBe("http://127.0.0.1:32123");
    expect(resolveBinary).not.toHaveBeenCalled();
  });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-remoteops-runner-"));
  roots.push(root);
  return root;
}

async function script(root: string, body: string): Promise<string> {
  const file = path.join(root, "fake-cloudflared.sh");
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}
