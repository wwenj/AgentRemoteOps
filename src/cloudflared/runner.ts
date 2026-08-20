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
  const logs = new RecentCloudflaredLogs();
  const exitController = new AbortController();
  child.once("exit", (code) => {
    if (ready) onUnexpectedExit(code);
    else exitController.abort(new Error(withLogDetail(localize(locale, `cloudflared 在建立 Tunnel 前退出：${code ?? "信号终止"}`, `cloudflared exited before the Tunnel was ready: ${code ?? "signal"}`), logs)));
  });
  const startupSignal = AbortSignal.any([signal, exitController.signal]);
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(withLogDetail(localize(locale, "等待 Cloudflare Quick Tunnel URL 超时", "Timed out waiting for the Cloudflare Quick Tunnel URL"), logs))), urlTimeoutMs);
    const inspect = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      logs.append(text);
      const match = logs.text().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
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
  await waitForHealth(url, startupSignal, locale, healthTimeoutMs, fetchImpl, logs, onProgress);
  ready = true;
  return { url, child };
}

async function waitForHealth(
  url: string,
  signal: AbortSignal,
  locale: Locale,
  healthTimeoutMs: number,
  fetchImpl: typeof fetch,
  logs: RecentCloudflaredLogs,
  onProgress?: StartupProgressListener,
): Promise<void> {
  const deadline = Date.now() + healthTimeoutMs;
  let attempt = 0;
  let lastError: unknown;
  let lastStatus: number | undefined;
  let lastCfRay: string | undefined;
  let lastDurationMs: number | undefined;
  while (Date.now() < deadline) {
    attempt += 1;
    onProgress?.({ stage: "health", message: localize(locale, `正在验证公网连接（第 ${attempt} 次）`, `Verifying the public connection (attempt ${attempt})`), attempt });
    const startedAt = Date.now();
    lastStatus = undefined;
    lastCfRay = undefined;
    try {
      const timeout = Math.max(1, Math.min(10_000, deadline - Date.now()));
      const response = await fetchImpl(`${url}/healthz`, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
      lastDurationMs = Date.now() - startedAt;
      lastStatus = response.status;
      lastCfRay = response.headers.get("cf-ray") ?? undefined;
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastDurationMs = Date.now() - startedAt;
      lastError = error;
    }
    if (signal.aborted) throw signal.reason;
    await sleep(Math.min(1_000, Math.max(0, deadline - Date.now())));
  }
  throw new Error(formatHealthFailure({
    url,
    attempt,
    lastError,
    ...(lastStatus === undefined ? {} : { lastStatus }),
    ...(lastCfRay === undefined ? {} : { lastCfRay }),
    ...(lastDurationMs === undefined ? {} : { lastDurationMs }),
    logs,
    locale,
  }));
}

interface HealthFailureContext {
  url: string;
  attempt: number;
  lastError: unknown;
  lastStatus?: number;
  lastCfRay?: string;
  lastDurationMs?: number;
  logs: RecentCloudflaredLogs;
  locale: Locale;
}

function formatHealthFailure(context: HealthFailureContext): string {
  const { url, attempt, lastError, lastStatus, lastCfRay, lastDurationMs, logs, locale } = context;
  const cause = lastError instanceof Error && lastError.cause instanceof Error ? lastError.cause : undefined;
  const reason = lastStatus === undefined
    ? [lastError instanceof Error ? `${lastError.name}: ${lastError.message}` : String(lastError), cause?.message].filter(Boolean).join("; ")
    : `HTTP ${lastStatus}`;
  const lines = [
    localize(locale, `Tunnel 健康检查失败（共 ${attempt} 次）`, `Tunnel health check failed after ${attempt} attempts`),
    `URL: ${url}/healthz`,
    localize(locale, `最后结果: ${reason}`, `Last result: ${reason}`),
    ...(lastDurationMs === undefined ? [] : [localize(locale, `最后请求耗时: ${lastDurationMs} ms`, `Last request duration: ${lastDurationMs} ms`)]),
    ...(lastCfRay ? [`cf-ray: ${lastCfRay}`] : []),
  ];
  const recentLogs = logs.lines();
  if (recentLogs.length > 0) {
    lines.push(localize(locale, "cloudflared 最近日志:", "Recent cloudflared logs:"), ...recentLogs.map((line) => `  ${redactSensitive(line)}`));
  }
  return lines.join("\n");
}

function withLogDetail(message: string, logs: RecentCloudflaredLogs): string {
  const lastLine = logs.lines().at(-1);
  return lastLine ? `${message}；cloudflared: ${redactSensitive(lastLine)}` : message;
}

class RecentCloudflaredLogs {
  private buffer = "";

  append(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 32_000) this.buffer = this.buffer.slice(-16_000);
  }

  text(): string {
    return this.buffer;
  }

  lines(limit = 12): string[] {
    return this.buffer.trim().split("\n").filter(Boolean).slice(-limit);
  }
}
