import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRemoteOpsRuntime } from "../src/runtime.js";

const roots: string[] = [];
const previousTunnel = process.env.AGENT_REMOTEOPS_TUNNEL;

afterEach(async () => {
  if (previousTunnel === undefined) delete process.env.AGENT_REMOTEOPS_TUNNEL;
  else process.env.AGENT_REMOTEOPS_TUNNEL = previousTunnel;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentRemoteOpsRuntime", () => {
  it("automatically closes the local server when TTL expires", async () => {
    process.env.AGENT_REMOTEOPS_TUNNEL = "none";
    const root = await mkdtemp(path.join(tmpdir(), "agent-remoteops-runtime-"));
    roots.push(root);
    const runtime = new AgentRemoteOpsRuntime({
      id: "runtime-test",
      locale: "zh-CN",
      workingDirectory: root,
      mode: "readonly",
      ttlMs: 100,
      auditEnabled: false,
      auditDir: root,
    });
    const session = await runtime.start();
    expect((await fetch(`${session.url}/healthz`)).ok).toBe(true);
    await runtime.wait();
    await expect(fetch(`${session.url}/healthz`)).rejects.toThrow();
  });
});
