import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn, type ChildProcess } from "node:child_process";
import type { ProcessRegistry } from "./process-registry.js";
import { sleep } from "./utils.js";

const VERSION = "2026.7.2";
const BINARIES = {
  x64: {
    asset: "cloudflared-linux-amd64",
    sha256: "ec905ea7b7e327ff8abdde8cb64697a2152de74dbcdbf6aec9db8364eb3886cd",
  },
  arm64: {
    asset: "cloudflared-linux-arm64",
    sha256: "405df476437e027fc6d18729a5a77155c0a33a6082aeee60a799a688f3052e66",
  },
} as const;

export interface TunnelHandle {
  url: string;
  child?: ChildProcess;
}

export async function startTunnel(
  port: number,
  registry: ProcessRegistry,
  configPath: string,
  onUnexpectedExit: (code: number | null) => void,
  signal: AbortSignal,
): Promise<TunnelHandle> {
  if (process.env.AGENT_REMOTEOPS_TUNNEL === "none") return { url: `http://127.0.0.1:${port}` };
  const binary = process.env.AGENT_REMOTEOPS_CLOUDFLARED || await ensureCloudflared(signal);
  const child = spawn(binary, [
    "--config", configPath,
    "--no-autoupdate",
    "tunnel",
    "--url", `http://127.0.0.1:${port}`,
    "--loglevel", "info",
  ], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  registry.register(child, "cloudflared");
  let ready = false;
  child.once("exit", (code) => {
    if (ready) onUnexpectedExit(code);
  });
  const url = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("等待 Cloudflare Quick Tunnel URL 超时")), 45_000);
    const inspect = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
      if (buffer.length > 64_000) buffer = buffer.slice(-32_000);
    };
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error(`cloudflared 在建立 Tunnel 前退出：${code ?? "signal"}`));
      }
    });
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Tunnel startup cancelled"));
    }, { once: true });
  });
  await waitForHealth(url, signal);
  ready = true;
  return { url, child };
}

async function ensureCloudflared(signal: AbortSignal): Promise<string> {
  if (process.platform !== "linux" || !(process.arch in BINARIES)) {
    throw new Error("Quick Tunnel 首发仅支持 Linux x64/arm64");
  }
  const spec = BINARIES[process.arch as keyof typeof BINARIES];
  const cacheRoot = process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  const directory = path.join(cacheRoot, "agent-remoteops", "cloudflared", VERSION);
  const target = path.join(directory, spec.asset);
  try {
    await access(target);
    if (await digestFile(target) === spec.sha256) return target;
    await rm(target, { force: true });
  } catch { /* download below */ }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.download`;
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${spec.asset}`;
  const response = await fetch(url, { redirect: "follow", signal });
  if (!response.ok || !response.body) throw new Error(`下载 cloudflared 失败：HTTP ${response.status}`);
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temporary, { mode: 0o600 }), { signal });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  const digest = await digestFile(temporary);
  if (digest !== spec.sha256) {
    await rm(temporary, { force: true });
    throw new Error("cloudflared SHA-256 校验失败");
  }
  await chmod(temporary, 0o755);
  await rename(temporary, target);
  return target;
}

async function digestFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = Readable.toWeb((await import("node:fs")).createReadStream(file));
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return hash.digest("hex");
}

async function waitForHealth(url: string, signal: AbortSignal): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    if (signal.aborted) throw signal.reason;
    await sleep(1_000);
  }
  throw new Error(`Tunnel 健康检查失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
