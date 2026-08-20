import { spawn, type ChildProcess } from "node:child_process";
import { localize } from "../i18n.js";
import type { ProcessRegistry } from "../process-registry.js";
import type { Locale } from "../types.js";
import { redactSensitive, sleep } from "../utils.js";
import type { StartupProgressListener } from "./progress.js";
import { resolveCloudflared, type ResolveCloudflaredOptions } from "./resolver.js";

export interface TunnelHandle {
  url: string;
  child?: ChildProcess;
}

export interface StartTunnelOptions {
  port: number;
  registry: ProcessRegistry;
  configPath: string;
  onUnexpectedExit: (code: number | null) => void;
  signal: AbortSignal;
  locale: Locale;
  onProgress?: StartupProgressListener;
  urlTimeoutMs?: number;
  healthTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  resolveBinary?: (options: ResolveCloudflaredOptions) => Promise<string>;
  binary?: string;
}

export async function startTunnel(options: StartTunnelOptions): Promise<TunnelHandle> {
  const {
    port,
    registry,
    configPath,
    onUnexpectedExit,
    signal,
    locale,
    onProgress,
    urlTimeoutMs = 45_000,
    healthTimeoutMs = 60_000,
    fetchImpl = fetch,
    resolveBinary = resolveCloudflared,
    binary: providedBinary,
  } = options;
  if (process.env.AGENT_REMOTEOPS_TUNNEL === "none") return { url: `http://127.0.0.1:${port}` };
  const binary = providedBinary ?? await resolveBinary({ signal, locale, ...(onProgress ? { onProgress } : {}) });
  onProgress?.({ stage: "tunnel", message: localize(locale, "正在建立 Cloudflare Quick Tunnel（45 秒超时）", "Establishing Cloudflare Quick Tunnel (45 second timeout)") });
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
  let buffer = "";
  const exitController = new AbortController();
  child.once("exit", (code) => {
    if (ready) onUnexpectedExit(code);
    else exitController.abort(new Error(withLogDetail(localize(locale, `cloudflared 在建立 Tunnel 前退出：${code ?? "信号终止"}`, `cloudflared exited before the Tunnel was ready: ${code ?? "signal"}`), buffer)));
  });
  const startupSignal = AbortSignal.any([signal, exitController.signal]);
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(withLogDetail(localize(locale, "等待 Cloudflare Quick Tunnel URL 超时", "Timed out waiting for the Cloudflare Quick Tunnel URL"), buffer))), urlTimeoutMs);
    const inspect = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
      if (buffer.length > 32_000) buffer = buffer.slice(-16_000);
    };
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    startupSignal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(startupSignal.reason ?? new Error("Tunnel startup cancelled"));
    }, { once: true });
  });
  await waitForHealth(url, startupSignal, locale, healthTimeoutMs, fetchImpl, onProgress);
  ready = true;
  return { url, child };
}

async function waitForHealth(
  url: string,
  signal: AbortSignal,
  locale: Locale,
  healthTimeoutMs: number,
  fetchImpl: typeof fetch,
  onProgress?: StartupProgressListener,
): Promise<void> {
  const deadline = Date.now() + healthTimeoutMs;
  let attempt = 0;
  let lastError: unknown;
  while (Date.now() < deadline) {
    attempt += 1;
    onProgress?.({ stage: "health", message: localize(locale, `正在验证公网连接（第 ${attempt} 次）`, `Verifying the public connection (attempt ${attempt})`), attempt });
    try {
      const timeout = Math.max(1, Math.min(3_000, deadline - Date.now()));
      const response = await fetchImpl(`${url}/healthz`, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (signal.aborted) throw signal.reason;
    await sleep(Math.min(1_000, Math.max(0, deadline - Date.now())));
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(localize(locale, `Tunnel 健康检查失败：${detail}`, `Tunnel health check failed: ${detail}`));
}

function withLogDetail(message: string, buffer: string): string {
  const lines = buffer.trim().split("\n").filter(Boolean);
  const lastLine = lines.at(-1);
  return lastLine ? `${message}；cloudflared: ${redactSensitive(lastLine)}` : message;
}
