import { DEFAULT_LOCALE, localize } from "./i18n.js";
import type { StartupProgress } from "./cloudflared/progress.js";
import type { Locale, PermissionMode } from "./types.js";

const divider = "─".repeat(64);
const successDivider = "━".repeat(64);
const spinnerFrames = ["⣋", "⣙", "⣹", "⣸", "⣼", "⣴", "⣦", "⣧", "⣇", "⣏"] as const;

const ansi = {
  reset: "\u001B[0m",
  clearLine: "\u001B[2K",
  cyan: "\u001B[96m",
  green: "\u001B[92m",
  yellow: "\u001B[93m",
  red: "\u001B[91m",
  boldGreen: "\u001B[1;92m",
} as const;

export interface TerminalRenderOptions {
  color?: boolean;
  tty?: boolean;
}

export interface LoadingIndicator {
  update(message: string): void;
  stop(): void;
}

export interface ConfigurationSummary {
  workingDirectory: string;
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
  workingDirectory: string;
  ttlMs: number;
  mode: PermissionMode;
}

function styled(value: string, style: string, enabled: boolean): string {
  return enabled ? `${style}${value}${ansi.reset}` : value;
}

export function terminalColorEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
}

export function startLoadingIndicator(
  message: string,
  options: TerminalRenderOptions = {},
  write: (chunk: string) => void = (chunk) => process.stdout.write(chunk),
): () => void {
  return createLoadingIndicator(message, options, write).stop;
}

export function createLoadingIndicator(
  initialMessage: string,
  options: TerminalRenderOptions = {},
  write: (chunk: string) => void = (chunk) => process.stdout.write(chunk),
): LoadingIndicator {
  const color = options.color ?? terminalColorEnabled();
  const tty = options.tty ?? Boolean(process.stdout.isTTY);
  let frameIndex = 0;
  let stopped = false;
  let message = initialMessage;
  let lastWritten = "";
  const render = () => {
    if (stopped) return;
    if (!tty) {
      if (message !== lastWritten) {
        lastWritten = message;
        write(`${message}\n`);
      }
      return;
    }
    const frame = spinnerFrames[frameIndex % spinnerFrames.length] ?? spinnerFrames[0];
    frameIndex += 1;
    write(`\r${ansi.clearLine}${styled(frame, ansi.cyan, color)} ${message}`);
  };
  render();
  const timer = tty ? setInterval(render, 80) : undefined;
  timer?.unref();
  return {
    update(nextMessage: string) {
      if (stopped || nextMessage === message) return;
      message = nextMessage;
      render();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      if (tty) write(`\r${ansi.clearLine}`);
    },
  };
}

export function formatStartupProgress(progress: StartupProgress, locale: Locale = DEFAULT_LOCALE): string {
  if (progress.stage !== "download" || progress.currentBytes === undefined) return progress.message;
  const current = formatMiB(progress.currentBytes);
  const attempt = progress.attempt && progress.maxAttempts ? localize(locale, `，第 ${progress.attempt}/${progress.maxAttempts} 次`, `, attempt ${progress.attempt}/${progress.maxAttempts}`) : "";
  if (progress.totalBytes === undefined || progress.totalBytes <= 0) return `${progress.message}：${current}${attempt}`;
  const percent = Math.min(100, Math.floor(progress.currentBytes / progress.totalBytes * 100));
  return `${progress.message}：${current} / ${formatMiB(progress.totalBytes)} (${percent}%)${attempt}`;
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function formatDurationHuman(ms: number, locale: Locale = DEFAULT_LOCALE): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (locale === "en") {
    const hourText = `${hours} ${hours === 1 ? "hour" : "hours"}`;
    const minuteText = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
    if (hours === 0) return minuteText;
    if (minutes === 0) return hourText;
    return `${hourText} ${minuteText}`;
  }
  if (hours === 0) return `${minutes} 分钟`;
  if (minutes === 0) return `${hours} 小时`;
  return `${hours} 小时 ${minutes} 分钟`;
}

export function formatPermission(mode: PermissionMode, locale: Locale = DEFAULT_LOCALE): string {
  if (mode === "readonly") return localize(locale, "readonly（只读安全模式）", "readonly (safe read-only)");
  return localize(locale, "full（完全访问模式）", "full (unrestricted access)");
}

export function renderIntro(locale: Locale = DEFAULT_LOCALE): string {
  return [
    "",
    divider,
    localize(locale, "Agent RemoteOps · Coding Agent 临时远程运维", "Agent RemoteOps · Temporary remote operations for Coding Agents"),
    divider,
    localize(locale, "请依次选择 Session 配置。最终确认前不会启动服务或创建公网 Tunnel。", "Choose the Session configuration below. No service or public Tunnel will be created before final confirmation."),
    "",
  ].join("\n");
}

export function renderConfiguration(summary: ConfigurationSummary, locale: Locale = DEFAULT_LOCALE): string {
  return [
    divider,
    localize(locale, "Session 配置确认", "Confirm Session configuration"),
    divider,
    `${localize(locale, "初始工作目录", "Initial working directory")}  ${summary.workingDirectory}`,
    `${localize(locale, "有效期", "Lifetime")}    ${formatDurationHuman(summary.ttlMs, locale)}`,
    `${localize(locale, "权限模式", "Permission")}  ${formatPermission(summary.mode, locale)}`,
    `${localize(locale, "审计日志", "Audit log")}  ${summary.audit}`,
    `${localize(locale, "运行用户", "Runtime user")}  ${summary.linuxUser}`,
    `${localize(locale, "网络 Tunnel", "Network Tunnel")}  ${summary.tunnel}`,
    "",
    localize(locale, "权限范围", "Permission scope"),
    ...summary.policy.map((line) => `  • ${line}`),
    "",
  ].join("\n");
}

export function renderSessionReady(
  summary: SessionSummary,
  locale: Locale = DEFAULT_LOCALE,
  options: TerminalRenderOptions = {},
): string {
  const color = options.color ?? false;
  const duration = formatDurationHuman(summary.ttlMs, locale);
  const expiresAt = summary.expiresAt.toLocaleString(locale === "en" ? "en-US" : "zh-CN", { hour12: false });
  const permissionNotice = summary.mode === "readonly"
    ? localize(locale, "当前为 readonly：可读取启动用户有权访问的任意文件，但命令必须通过只读校验；该模式不保护信息机密性。", "The Session is readonly: it can read any file available to the runtime user, but commands must pass read-only validation. This mode does not protect confidentiality.")
    : localize(locale, "当前为 full：服务端不限制命令或文件路径，Agent 可使用启动用户拥有的全部系统权限。", "The Session is full: the server does not restrict commands or file paths, and the Agent inherits all permissions of the runtime user.");

  return [
    "",
    styled(successDivider, ansi.green, color),
    styled(`✓ ${localize(locale, "Agent RemoteOps 临时 Session 已启动", "Agent RemoteOps temporary Session is ready")}`, ansi.boldGreen, color),
    styled(successDivider, ansi.green, color),
    `URL       ${styled(summary.url, ansi.cyan, color)}`,
    `Token     ${styled(summary.token, ansi.yellow, color)}`,
    `${localize(locale, "权限", "Permission")}      ${styled(formatPermission(summary.mode, locale), summary.mode === "readonly" ? ansi.green : ansi.red, color)}`,
    `${localize(locale, "初始工作目录", "Initial cwd")}  ${summary.workingDirectory}`,
    `${localize(locale, "有效期", "Lifetime")}    ${localize(locale, `${duration}（${expiresAt} 到期）`, `${duration} (expires ${expiresAt})`)}`,
    divider,
    "",
    localize(locale, "请复制以上 URL、Token 和任务，发送给已安装 Agent RemoteOps Skill 的 Codex。", "Copy the URL, Token, and task above to Codex with the Agent RemoteOps Skill installed."),
    localize(locale, "本地只需要安装 Skill，不需要安装 agent-remoteops CLI。", "Only the Skill is required locally; do not install the agent-remoteops CLI."),
    "",
    localize(locale, "使用与安全提示", "Usage and security notes"),
    localize(locale, "  • URL 和 Token 都属于临时敏感凭据，请只发送给本次授权的 Agent。", "  • URL and Token are temporary sensitive credentials. Share them only with the Agent authorized for this Session."),
    localize(locale, "  • 首次通过 Token 认证的 Client ID 将成为本次 Session 唯一客户端；IP 变化不会中断连接。", "  • The first Client ID authenticated with the Token becomes the only client for this Session; IP changes do not interrupt it."),
    localize(locale, "  • 初始工作目录只用于解析相对路径，不构成权限边界。", "  • The initial working directory only resolves relative paths; it is not a permission boundary."),
    localize(locale, `  • Session 将在 ${duration}后自动到期，并清理 HTTP 服务、Tunnel 和已跟踪子进程。`, `  • The Session expires in ${duration} and then cleans up the HTTP service, Tunnel, and tracked child processes.`),
    localize(locale, "  • 请保持当前进程运行；关闭终端或按 Ctrl+C 会立即结束本次 Session。", "  • Keep this process running. Closing the terminal or pressing Ctrl+C ends the Session immediately."),
    `  • ${permissionNotice}`,
    "",
    localize(locale, "正在等待 Agent 请求，后续文件、命令和认证日志会在下方实时输出。", "Waiting for Agent requests. File, command, and authentication logs will appear below."),
    localize(locale, "按 Ctrl+C 可随时停止并清理本次临时服务。", "Press Ctrl+C at any time to stop and clean up the temporary service."),
    "",
  ].join("\n");
}
