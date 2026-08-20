import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { localize } from "../i18n.js";
import type { Locale } from "../types.js";
import { downloadCloudflared, type DownloadCloudflaredOptions } from "./downloader.js";
import { isExecutable, matchesDigest } from "./files.js";
import { getCloudflaredSpec, type CloudflaredSpec } from "./manifest.js";
import type { StartupProgressListener } from "./progress.js";

const require = createRequire(import.meta.url);

export interface ResolveCloudflaredOptions {
  signal: AbortSignal;
  locale: Locale;
  onProgress?: StartupProgressListener;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  env?: NodeJS.ProcessEnv;
  cacheRoot?: string;
  packageResolve?: (specifier: string) => string;
  downloader?: (options: DownloadCloudflaredOptions) => Promise<string>;
  spec?: CloudflaredSpec;
}

export async function resolveCloudflared(options: ResolveCloudflaredOptions): Promise<string> {
  const {
    signal,
    locale,
    onProgress,
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    cacheRoot = env.XDG_CACHE_HOME || path.join(homedir(), ".cache"),
    packageResolve = (specifier) => require.resolve(specifier),
    downloader = downloadCloudflared,
    spec: providedSpec,
  } = options;
  onProgress?.({ stage: "environment", message: localize(locale, "正在检查运行环境", "Checking the runtime environment") });

  if (env.AGENT_REMOTEOPS_CLOUDFLARED) {
    const explicit = path.resolve(env.AGENT_REMOTEOPS_CLOUDFLARED);
    if (!await isExecutable(explicit)) {
      throw new Error(localize(locale, `AGENT_REMOTEOPS_CLOUDFLARED 不可执行：${explicit}`, `AGENT_REMOTEOPS_CLOUDFLARED is not executable: ${explicit}`));
    }
    onProgress?.({ stage: "binary", message: localize(locale, "使用显式指定的 cloudflared", "Using the explicitly configured cloudflared") });
    return explicit;
  }

  const spec = providedSpec ?? getCloudflaredSpec(platform, arch);
  if (!spec) {
    throw new Error(localize(locale, `Quick Tunnel 不支持 ${platform}/${arch}`, `Quick Tunnel does not support ${platform}/${arch}`));
  }

  try {
    const bundled = packageResolve(`${spec.packageName}/bin/cloudflared`);
    if (await isExecutable(bundled) && await matchesDigest(bundled, spec.sha256)) {
      onProgress?.({ stage: "binary", message: localize(locale, `已加载内置 cloudflared ${spec.version}`, `Loaded bundled cloudflared ${spec.version}`) });
      return bundled;
    }
    onProgress?.({ stage: "binary", message: localize(locale, "内置 cloudflared 校验失败，正在自动修复", "Bundled cloudflared failed verification; repairing automatically") });
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;
    onProgress?.({ stage: "binary", message: localize(locale, "未找到内置 cloudflared，正在自动修复", "Bundled cloudflared was not found; repairing automatically") });
  }

  const cached = path.join(cacheRoot, "agent-remoteops", "cloudflared", spec.version, spec.asset);
  if (await isExecutable(cached) && await matchesDigest(cached, spec.sha256)) {
    onProgress?.({ stage: "binary", message: localize(locale, `已加载缓存 cloudflared ${spec.version}`, `Loaded cached cloudflared ${spec.version}`) });
    return cached;
  }

  return downloader({ spec, cacheRoot, signal, locale, ...(onProgress ? { onProgress } : {}) });
}

function isModuleNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
}
