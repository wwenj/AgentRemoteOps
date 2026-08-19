import type { PermissionMode } from "./types.js";

const divider = "─".repeat(64);

export interface ConfigurationSummary {
  workspace: string;
  ttlMs: number;
  mode: PermissionMode;
  policy: string[];
  linuxUser: string | number;
  audit: string;
  tunnel: string;
}

export interface SessionSummary {
  url: string;
  token: string;
  expiresAt: Date;
  workspace: string;
  ttlMs: number;
  mode: PermissionMode;
}

export function formatDurationHuman(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} 分钟`;
  if (minutes === 0) return `${hours} 小时`;
  return `${hours} 小时 ${minutes} 分钟`;
}

export function formatPermission(mode: PermissionMode): string {
  if (mode === "readonly") return "readonly（只读）";
  if (mode === "readwrite") return "readwrite（读写受控）";
  return "full（完全权限）";
}

export function renderIntro(): string {
  return [
    "",
    divider,
    "Agent RemoteOps · Coding Agent 临时远程运维",
    divider,
    "请依次选择会话配置。最终确认前不会启动服务或创建公网隧道。",
    "",
  ].join("\n");
}

export function renderConfiguration(summary: ConfigurationSummary): string {
  return [
    divider,
    "会话配置确认",
    divider,
    `工作目录  ${summary.workspace}`,
    `有效期    ${formatDurationHuman(summary.ttlMs)}`,
    `权限模式  ${formatPermission(summary.mode)}`,
    `审计日志  ${summary.audit}`,
    `运行用户  ${summary.linuxUser}`,
    `网络隧道  ${summary.tunnel}`,
    "",
    "权限范围",
    ...summary.policy.map((line) => `  • ${line}`),
    "",
  ].join("\n");
}

export function renderSessionReady(summary: SessionSummary): string {
  const duration = formatDurationHuman(summary.ttlMs);
  const expiresAt = summary.expiresAt.toLocaleString("zh-CN", { hour12: false });
  const permissionNotice = summary.mode === "readonly"
    ? "当前为只读模式，只允许读取文件和执行受控诊断命令。"
    : summary.mode === "readwrite"
      ? "当前为受控读写模式，高危命令拦截仅用于降低误操作风险，并非安全沙箱。"
      : "当前为完全权限模式，Agent 可使用启动用户拥有的全部系统权限。";

  return [
    "",
    divider,
    "Agent RemoteOps 临时远程会话已启动",
    divider,
    `URL       ${summary.url}`,
    `Token     ${summary.token}`,
    `权限      ${formatPermission(summary.mode)}`,
    `工作目录  ${summary.workspace}`,
    `有效期    ${duration}（${expiresAt} 到期）`,
    divider,
    "",
    "请复制以上 URL 和 Token，发送给已安装 Agent RemoteOps Skill 的 Codex、",
    "Claude Code 或其他 Coding Agent，即可让 Agent 连接并开始临时排查。",
    "",
    "本地手动连接",
    `  agent-remoteops connect ${summary.url}`,
    "",
    "使用与安全提示",
    "  • URL 和 Token 都属于临时敏感凭据，请只发送给本次授权的 Agent。",
    `  • 会话将在 ${duration}后自动到期，并清理 HTTP 服务、Tunnel 和已跟踪子进程。`,
    "  • 请保持当前进程运行；关闭终端或按 Ctrl+C 会立即结束本次会话。",
    `  • ${permissionNotice}`,
    "",
    "正在等待 Agent 请求，后续文件、命令和认证日志会在下方实时输出。",
    "按 Ctrl+C 可随时停止并清理本次临时服务。",
    "",
  ].join("\n");
}
