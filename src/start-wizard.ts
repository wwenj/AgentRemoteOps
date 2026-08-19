import { confirm, input, select } from "@inquirer/prompts";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { AgentRemoteOpsRuntime } from "./runtime.js";
import type { PermissionMode, SessionConfig } from "./types.js";
import { createId, formatDuration, parseDuration } from "./utils.js";
import { describePolicy } from "./policy.js";

export async function startInteractive(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive terminal required.");
  if (process.platform !== "linux" && process.env.AGENT_REMOTEOPS_TUNNEL !== "none") {
    throw new Error("Agent RemoteOps 服务端首发仅支持 Linux x64/arm64");
  }
  process.stdout.write("\nAgent RemoteOps - Temporary remote access for Coding Agents\n\n");
  const workspaceInput = await input({
    message: "工作目录",
    default: process.cwd(),
    validate: async (value) => {
      try { await access(value); return true; } catch { return "目录不存在或无法访问"; }
    },
  });
  const workspace = await realpath(workspaceInput);
  const ttlChoice = await select({
    message: "会话有效期",
    choices: [
      { name: "15 分钟", value: "15m" },
      { name: "30 分钟", value: "30m" },
      { name: "1 小时", value: "1h" },
      { name: "自定义", value: "custom" },
    ],
    default: "30m",
  });
  const ttlText = ttlChoice === "custom" ? await input({
    message: "自定义有效期（5m - 8h）",
    default: "30m",
    validate: (value) => { try { parseDuration(value); return true; } catch (error) { return (error as Error).message; } },
  }) : ttlChoice;
  const mode = await select<PermissionMode>({
    message: "权限模式",
    choices: [
      { name: "只读权限 - 文件只读 + 受控诊断命令", value: "readonly" },
      { name: "读写权限 - 文件读写 + 高危命令拦截", value: "readwrite" },
      { name: "完全权限 - 不限制命令", value: "full" },
    ],
    default: "readonly",
  });
  const auditEnabled = await confirm({ message: "是否保留本地审计日志", default: true });
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    process.stdout.write("\n警告：Agent RemoteOps 当前将以 root 权限运行。\n");
    if (!await confirm({ message: "确认继续以 root 权限运行？", default: false })) return;
  }
  const ttlMs = parseDuration(ttlText);
  const auditDir = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "agent-remoteops", "audit");
  const config: SessionConfig = {
    id: createId("session"), workspace, mode, ttlMs, auditEnabled, auditDir,
  };
  process.stdout.write("\nConfiguration\n\n");
  process.stdout.write(`Workspace:   ${workspace}\nTTL:         ${formatDuration(ttlMs)}\nPermission:  ${mode}\n`);
  for (const line of describePolicy(mode)) process.stdout.write(`             ${line}\n`);
  const tunnelLabel = process.env.AGENT_REMOTEOPS_TUNNEL === "none" ? "Local only (development)" : "Cloudflare Quick Tunnel";
  process.stdout.write(`Linux user:  ${process.env.USER ?? process.getuid?.() ?? "unknown"}\nAudit log:   ${auditEnabled ? auditDir : "disabled"}\nTunnel:      ${tunnelLabel}\n\n`);
  if (!await confirm({ message: "确认启动临时远程服务？", default: false })) return;
  process.stdout.write("\nStarting Agent RemoteOps...\n");
  const runtime = new AgentRemoteOpsRuntime(config);
  const session = await runtime.start();
  process.stdout.write("\nAgent RemoteOps session ready\n\n");
  process.stdout.write(`URL:\n${session.url}\n\nToken:\n${session.token}\n\nExpires:\n${session.expiresAt.toLocaleString()}\n\nPermission:\n${mode}\n\nWorkspace:\n${workspace}\n\n`);
  process.stdout.write(`Connect locally:\nagent-remoteops connect ${session.url}\n\nPress Ctrl+C to stop the session.\n\n`);
  await runtime.wait();
}
