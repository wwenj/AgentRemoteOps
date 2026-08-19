import { confirm, input, select } from "@inquirer/prompts";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { AgentRemoteOpsRuntime } from "./runtime.js";
import type { PermissionMode, SessionConfig } from "./types.js";
import { createId, parseDuration } from "./utils.js";
import { describePolicy } from "./policy.js";
import { renderConfiguration, renderIntro, renderSessionReady } from "./terminal-ui.js";

async function ask<T>(prompt: () => Promise<T>): Promise<T> {
  const answer = await prompt();
  process.stdout.write("\n");
  return answer;
}

function cancelled(): void {
  process.stdout.write("已取消启动，未创建临时服务。\n");
}

export async function startInteractive(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive terminal required.");
  if (process.platform !== "linux" && process.env.AGENT_REMOTEOPS_TUNNEL !== "none") {
    throw new Error("Agent RemoteOps 服务端首发仅支持 Linux x64/arm64");
  }
  process.stdout.write(renderIntro());
  const workspaceInput = await ask(() => input({
    message: "工作目录",
    default: process.cwd(),
    validate: async (value) => {
      try { await access(value); return true; } catch { return "目录不存在或无法访问"; }
    },
  }));
  const workspace = await realpath(workspaceInput);
  const ttlChoice = await ask(() => select({
    message: "会话有效期",
    choices: [
      { name: "15 分钟", value: "15m" },
      { name: "30 分钟（推荐）", value: "30m" },
      { name: "1 小时", value: "1h" },
      { name: "自定义", value: "custom" },
    ],
    default: "30m",
  }));
  const ttlText = ttlChoice === "custom" ? await ask(() => input({
      message: "自定义有效期（5m - 8h）",
      default: "30m",
      validate: (value) => { try { parseDuration(value); return true; } catch (error) { return (error as Error).message; } },
    })) : ttlChoice;
  const mode = await ask(() => select<PermissionMode>({
    message: "权限模式",
    choices: [
      { name: "readonly  · 文件只读 + 受控诊断命令（推荐）", value: "readonly" },
      { name: "readwrite · 文件读写 + 高危命令拦截", value: "readwrite" },
      { name: "full      · 完全权限，不限制命令", value: "full" },
    ],
    default: "readonly",
  }));
  const auditEnabled = await ask(() => confirm({ message: "保留本地审计日志", default: true }));
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    process.stdout.write("⚠ 当前进程将以 root 权限运行，所选权限会继承 root 的系统能力。\n\n");
    if (!await ask(() => confirm({ message: "确认继续以 root 权限运行", default: false }))) {
      cancelled();
      return;
    }
  }
  const ttlMs = parseDuration(ttlText);
  const auditDir = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "agent-remoteops", "audit");
  const config: SessionConfig = {
    id: createId("session"), workspace, mode, ttlMs, auditEnabled, auditDir,
  };
  const tunnelLabel = process.env.AGENT_REMOTEOPS_TUNNEL === "none" ? "Local only (development)" : "Cloudflare Quick Tunnel";
  process.stdout.write(renderConfiguration({
    workspace,
    ttlMs,
    mode,
    policy: describePolicy(mode),
    linuxUser: process.env.USER ?? process.getuid?.() ?? "unknown",
    audit: auditEnabled ? `已开启 · ${auditDir}` : "已关闭",
    tunnel: tunnelLabel,
  }));
  if (!await ask(() => confirm({ message: "确认启动临时远程服务", default: false }))) {
    cancelled();
    return;
  }
  process.stdout.write("正在启动 Agent RemoteOps，请稍候...\n");
  const runtime = new AgentRemoteOpsRuntime(config);
  const session = await runtime.start();
  process.stdout.write(renderSessionReady({
    url: session.url,
    token: session.token,
    expiresAt: session.expiresAt,
    workspace,
    ttlMs,
    mode,
  }));
  await runtime.wait();
}
