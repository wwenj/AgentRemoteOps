import { confirm, input, select } from "@inquirer/prompts";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { localize } from "./i18n.js";
import { AgentRemoteOpsRuntime } from "./runtime.js";
import type { Locale, PermissionMode, SessionConfig } from "./types.js";
import { createId, parseDuration } from "./utils.js";
import { describePolicy } from "./policy.js";
import {
  renderConfiguration,
  renderIntro,
  renderSessionReady,
  startLoadingIndicator,
  terminalColorEnabled,
} from "./terminal-ui.js";

async function ask<T>(prompt: () => Promise<T>): Promise<T> {
  const answer = await prompt();
  process.stdout.write("\n");
  return answer;
}

function cancelled(locale: Locale): void {
  process.stdout.write(`${localize(locale, "已取消启动，未创建临时服务。", "Startup cancelled. No temporary service was created.")}\n`);
}

export async function startInteractive(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive terminal required.");
  const locale = await ask(() => select<Locale>({
    message: "请选择语言 / Select language",
    choices: [
      { name: "中文", value: "zh-CN" },
      { name: "English", value: "en" },
    ],
    default: "zh-CN",
  }));
  if (process.platform !== "linux" && process.env.AGENT_REMOTEOPS_TUNNEL !== "none") {
    throw new Error(localize(locale, "Agent RemoteOps 服务端目前仅支持 Linux x64/arm64", "The Agent RemoteOps server currently supports Linux x64/arm64 only"));
  }
  process.stdout.write(renderIntro(locale));
  const ttlChoice = await ask(() => select({
    message: localize(locale, "Session 有效期", "Session lifetime"),
    choices: [
      { name: localize(locale, "15 分钟", "15 minutes"), value: "15m" },
      { name: localize(locale, "30 分钟（推荐）", "30 minutes (recommended)"), value: "30m" },
      { name: localize(locale, "1 小时", "1 hour"), value: "1h" },
      { name: localize(locale, "自定义", "Custom"), value: "custom" },
    ],
    default: "30m",
  }));
  const ttlText = ttlChoice === "custom" ? await ask(() => input({
      message: localize(locale, "自定义有效期（5m - 8h）", "Custom lifetime (5m - 8h)"),
      default: "30m",
      validate: (value) => { try { parseDuration(value, locale); return true; } catch (error) { return (error as Error).message; } },
    })) : ttlChoice;
  const mode = await ask(() => select<PermissionMode>({
    message: localize(locale, "权限模式", "Permission mode"),
    choices: [
      { name: localize(locale, "readonly · 只读安全模式（推荐）", "readonly · Safe read-only mode (recommended)"), value: "readonly" },
      { name: localize(locale, "full     · 完全访问模式，不限制命令和文件路径", "full     · Full access with unrestricted commands and file paths"), value: "full" },
    ],
    default: "readonly",
  }));
  const workingDirectoryInput = await ask(() => input({
    message: localize(locale, "工作目录（仅提供给 Agent，不涉及权限限制）", "Working directory (provided to the Agent only; not a permission boundary)"),
    default: process.cwd(),
    validate: async (value) => {
      try {
        const resolved = await realpath(value);
        return (await stat(resolved)).isDirectory() || localize(locale, "必须选择目录", "A directory is required");
      } catch { return localize(locale, "目录不存在或无法访问", "Directory does not exist or cannot be accessed"); }
    },
  }));
  const workingDirectory = await realpath(workingDirectoryInput);
  const auditEnabled = await ask(() => confirm({ message: localize(locale, "保留本地审计日志", "Keep a local audit log"), default: true }));
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    process.stdout.write(`${localize(locale, "⚠ 当前进程将以 root 权限运行，所选权限会继承 root 的系统能力。", "⚠ This process will run as root. The selected mode inherits root system permissions.")}\n\n`);
    if (!await ask(() => confirm({ message: localize(locale, "确认继续以 root 权限运行", "Continue running as root"), default: true }))) {
      cancelled(locale);
      return;
    }
  }
  const ttlMs = parseDuration(ttlText, locale);
  const auditDir = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "agent-remoteops", "audit");
  const config: SessionConfig = {
    id: createId("session"), locale, workingDirectory, mode, ttlMs, auditEnabled, auditDir,
  };
  const tunnelLabel = process.env.AGENT_REMOTEOPS_TUNNEL === "none"
    ? localize(locale, "仅限本机（开发模式）", "Local only (development mode)")
    : "Cloudflare Quick Tunnel";
  process.stdout.write(renderConfiguration({
    workingDirectory,
    ttlMs,
    mode,
    policy: describePolicy(mode, locale),
    linuxUser: process.env.USER ?? process.getuid?.() ?? "unknown",
    audit: auditEnabled ? localize(locale, `已开启 · ${auditDir}`, `Enabled · ${auditDir}`) : localize(locale, "已关闭", "Disabled"),
    tunnel: tunnelLabel,
  }, locale));
  if (!await ask(() => confirm({ message: localize(locale, "确认启动临时远程服务", "Start the temporary remote service"), default: true }))) {
    cancelled(locale);
    return;
  }
  const color = terminalColorEnabled();
  const stopLoading = startLoadingIndicator(
    localize(locale, "正在启动 Agent RemoteOps，请稍候……", "Starting Agent RemoteOps. Please wait..."),
    { color },
  );
  const runtime = new AgentRemoteOpsRuntime(config);
  const session = await runtime.start(stopLoading).finally(stopLoading);
  process.stdout.write(renderSessionReady({
    url: session.url,
    token: session.token,
    expiresAt: session.expiresAt,
    workingDirectory,
    ttlMs,
    mode,
  }, locale, { color }));
  await runtime.wait();
}
