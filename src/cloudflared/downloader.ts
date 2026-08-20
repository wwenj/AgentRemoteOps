import { createWriteStream } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { localize } from "../i18n.js";
import type { Locale } from "../types.js";
import { matchesDigest } from "./files.js";
import type { CloudflaredSpec } from "./manifest.js";
import type { StartupProgressListener } from "./progress.js";

const DEFAULT_TOTAL_TIMEOUT_MS = 180_000;
const DEFAULT_STALL_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const LOCK_STALE_MS = 5 * 60_000;

export interface DownloadCloudflaredOptions {
  spec: CloudflaredSpec;
  cacheRoot: string;
  signal: AbortSignal;
  locale: Locale;
  onProgress?: StartupProgressListener;
  fetchImpl?: typeof fetch;
  totalTimeoutMs?: number;
  stallTimeoutMs?: number;
  maxAttempts?: number;
}

export async function downloadCloudflared(options: DownloadCloudflaredOptions): Promise<string> {
  const {
    spec,
    cacheRoot,
    signal,
    locale,
    onProgress,
    fetchImpl = fetch,
    totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
    stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  } = options;
  const directory = path.join(cacheRoot, "agent-remoteops", "cloudflared", spec.version);
  const target = path.join(directory, spec.asset);
  const partial = `${target}.download`;
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + totalTimeoutMs;
  await mkdir(directory, { recursive: true, mode: 0o700 });

  if (await matchesDigest(target, spec.sha256)) return target;
  const lock = await acquireLock(lockPath, target, spec.sha256, deadline, signal, locale, onProgress);
  if (!lock) return target;

  try {
    if (await matchesDigest(target, spec.sha256)) return target;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      throwIfAborted(signal);
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      onProgress?.({
        stage: "download",
        message: localize(locale, `正在自动获取 cloudflared（第 ${attempt}/${maxAttempts} 次）`, `Downloading cloudflared automatically (attempt ${attempt}/${maxAttempts})`),
        attempt,
        maxAttempts,
      });
      try {
        await downloadAttempt({
          spec,
          partial,
          signal,
          fetchImpl,
          remainingMs: remaining,
          stallTimeoutMs,
          attempt,
          maxAttempts,
          locale,
          ...(onProgress ? { onProgress } : {}),
        });
        if (!await matchesDigest(partial, spec.sha256)) {
          await rm(partial, { force: true });
          throw new Error(localize(locale, "cloudflared SHA-256 校验失败", "cloudflared SHA-256 verification failed"));
        }
        await chmod(partial, 0o755);
        await rename(partial, target);
        return target;
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        lastError = error;
        if (attempt < maxAttempts && Date.now() < deadline) {
          await delay(Math.min(2 ** (attempt - 1) * 1_000, Math.max(0, deadline - Date.now())), signal);
        }
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "timeout");
    throw new Error(localize(locale, `自动获取 cloudflared 失败：${detail}`, `Failed to acquire cloudflared automatically: ${detail}`));
  } finally {
    await lock.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

interface DownloadAttemptOptions {
  spec: CloudflaredSpec;
  partial: string;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
  remainingMs: number;
  stallTimeoutMs: number;
  attempt: number;
  maxAttempts: number;
  onProgress?: StartupProgressListener;
  locale: Locale;
}

async function downloadAttempt(options: DownloadAttemptOptions): Promise<void> {
  const { spec, partial, signal, fetchImpl, remainingMs, stallTimeoutMs, attempt, maxAttempts, onProgress, locale } = options;
  let existingBytes = await fileSize(partial);
  if (existingBytes > 0 && await matchesDigest(partial, spec.sha256)) return;

  const timeoutController = new AbortController();
  const stallController = new AbortController();
  const totalTimer = setTimeout(() => timeoutController.abort(new Error(localize(locale, "cloudflared 下载超时", "cloudflared download timed out"))), remainingMs);
  let stallTimer: NodeJS.Timeout | undefined;
  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => stallController.abort(new Error(localize(locale, "cloudflared 下载 20 秒无数据", "cloudflared download stalled"))), stallTimeoutMs);
  };
  resetStallTimer();
  const combinedSignal = AbortSignal.any([signal, timeoutController.signal, stallController.signal]);

  try {
    const headers = existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : undefined;
    const response = await fetchImpl(`${spec.releaseBaseUrl}/${spec.asset}`, {
      redirect: "follow",
      signal: combinedSignal,
      ...(headers ? { headers } : {}),
    });
    if (response.status === 416 && existingBytes > 0) {
      await rm(partial, { force: true });
      throw new Error(localize(locale, "断点下载位置已失效", "The download resume position is no longer valid"));
    }
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

    let append = existingBytes > 0 && response.status === 206;
    if (append) {
      const rangeStart = parseContentRangeStart(response.headers.get("content-range"));
      if (rangeStart !== existingBytes) {
        await rm(partial, { force: true });
        throw new Error(localize(locale, "服务端返回了无效的断点范围", "The server returned an invalid resume range"));
      }
    } else {
      existingBytes = 0;
      append = false;
    }

    const responseBytes = Number(response.headers.get("content-length")) || undefined;
    const totalBytes = responseBytes === undefined ? undefined : existingBytes + responseBytes;
    let currentBytes = existingBytes;
    let lastReportedBytes = existingBytes;
    const reportStep = Math.max(1024 * 1024, totalBytes === undefined ? 0 : Math.ceil(totalBytes / 20));
    const progressStream = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
        resetStallTimer();
        currentBytes += chunk.length;
        if (currentBytes - lastReportedBytes >= reportStep || currentBytes === totalBytes) {
          lastReportedBytes = currentBytes;
          onProgress?.({
            stage: "download",
            message: localize(locale, "正在下载 cloudflared", "Downloading cloudflared"),
            attempt,
            maxAttempts,
            currentBytes,
            ...(totalBytes === undefined ? {} : { totalBytes }),
          });
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as never),
        progressStream,
        createWriteStream(partial, { flags: append ? "a" : "w", mode: 0o600 }),
        { signal: combinedSignal },
      );
    } catch (error) {
      if (combinedSignal.aborted && combinedSignal.reason instanceof Error) throw combinedSignal.reason;
      throw error;
    }
  } finally {
    clearTimeout(totalTimer);
    if (stallTimer) clearTimeout(stallTimer);
  }
}

async function acquireLock(
  lockPath: string,
  target: string,
  expectedDigest: string,
  deadline: number,
  signal: AbortSignal,
  locale: Locale,
  onProgress?: StartupProgressListener,
) {
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid} ${Date.now()}\n`);
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await matchesDigest(target, expectedDigest)) return undefined;
      const lockOwner = await readLockPid(lockPath);
      if (lockOwner !== undefined && !isProcessAlive(lockOwner)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      onProgress?.({
        stage: "download",
        message: localize(locale, "正在等待另一个 cloudflared 下载任务", "Waiting for another cloudflared download"),
      });
      await delay(Math.min(250, Math.max(0, deadline - Date.now())), signal);
    }
  }
  throw new Error(localize(locale, "等待 cloudflared 下载锁超时", "Timed out waiting for the cloudflared download lock"));
}

async function readLockPid(lockPath: string): Promise<number | undefined> {
  try {
    const value = await readFile(lockPath, "utf8");
    const pid = Number(value.trim().split(/\s+/)[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

function parseContentRangeStart(value: string | null): number | undefined {
  const match = /^bytes (\d+)-\d+\/\d+$/.exec(value ?? "");
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted");
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Operation aborted"));
    }, { once: true });
  });
}
