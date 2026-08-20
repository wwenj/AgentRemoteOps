import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import type { WriteStream } from "node:fs";
import { DEFAULT_LOCALE, localize } from "./i18n.js";
import type { AuditEvent, Locale } from "./types.js";
import { redactSensitive } from "./utils.js";

const labels: Record<Locale, Record<string, string>> = {
  "zh-CN": {
    "session.start": "Session 启动", "session.stop": "Session 结束", "auth.failed": "认证失败",
    "client.bound": "客户端绑定", "client.rejected": "连接拒绝", "job.start": "命令开始",
    "job.done": "命令结束", "job.denied": "命令拒绝", "fs.read": "文件读取",
    "fs.write": "文件写入", "fs.list": "目录列表", "fs.stat": "文件状态", "fs.denied": "文件操作拒绝", "fs.failed": "文件操作失败", "http.request": "HTTP 请求",
  },
  en: {
    "session.start": "Session started", "session.stop": "Session ended", "auth.failed": "Authentication failed",
    "client.bound": "Client bound", "client.rejected": "Connection rejected", "job.start": "Command started",
    "job.done": "Command completed", "job.denied": "Command denied", "fs.read": "File read",
    "fs.write": "File write", "fs.list": "Directory list", "fs.stat": "File stat", "fs.denied": "File operation denied", "fs.failed": "File operation failed", "http.request": "HTTP request",
  },
};

const statuses: Record<Locale, Record<string, string>> = {
  "zh-CN": {
    accepted: "已接受", ready: "已就绪", started: "执行中", succeeded: "成功", success: "成功",
    failed: "失败", denied: "已拒绝", cancelled: "已取消", timed_out: "已超时",
    nonzero_exit: "命令退出码非 0", infrastructure_error: "执行基础设施错误",
    "ttl-expired": "Session 到期", "startup-failed": "启动失败", "tunnel-exit": "Tunnel 异常退出",
  },
  en: {
    accepted: "accepted", ready: "ready", started: "running", succeeded: "succeeded", success: "succeeded",
    failed: "failed", denied: "denied", cancelled: "cancelled", timed_out: "timed out",
    nonzero_exit: "command exited non-zero", infrastructure_error: "execution infrastructure error",
    "ttl-expired": "Session expired", "startup-failed": "startup failed", "tunnel-exit": "Tunnel exited unexpectedly",
  },
};

const rules: Record<Locale, Record<string, string>> = {
  "zh-CN": {
    "filesystem-destroy": "禁止破坏文件系统", "disk-destroy": "禁止破坏磁盘", "system-lifecycle": "禁止关闭或重启系统",
    "kernel-change": "禁止修改内核配置", "privilege-change": "禁止变更系统权限", "identity-change": "禁止变更用户或用户组",
    "permission-change": "禁止变更文件权限", "process-kill": "禁止终止系统进程", "network-change": "禁止修改网络或防火墙",
    "package-management": "禁止执行包管理操作", "interpreter-bypass": "禁止通过解释器绕过策略", "shell-bypass": "禁止绕过 Shell 策略",
    "process-detach": "禁止创建脱离 Session 的进程", "service-management": "禁止修改系统服务状态",
    "container-destructive": "禁止高风险容器操作", "kubernetes-write": "禁止 Kubernetes 写操作", "git-destructive": "禁止高风险 Git 操作",
    "readonly-shell-operator": "readonly 不允许重定向、后台执行、命令替换或子 Shell",
    "readonly-command-substitution": "readonly 不允许命令替换",
    "readonly-explicit-binary-path": "readonly 不允许显式二进制路径",
    "systemctl-subcommand": "仅允许只读 systemctl 操作",
    "curl-write-or-body-option": "curl 仅允许无请求体、无文件输出的 GET/HEAD",
    "curl-method": "curl 仅允许 GET/HEAD method",
    "curl-http-url": "curl 仅允许 HTTP/HTTPS URL",
  },
  en: {
    "filesystem-destroy": "filesystem destruction is blocked", "disk-destroy": "disk destruction is blocked",
    "system-lifecycle": "system shutdown or restart is blocked", "kernel-change": "kernel changes are blocked",
    "privilege-change": "privilege changes are blocked", "identity-change": "user or group changes are blocked",
    "permission-change": "file permission changes are blocked", "process-kill": "terminating system processes is blocked",
    "network-change": "network or firewall changes are blocked", "package-management": "package management is blocked",
    "interpreter-bypass": "interpreter-based policy bypass is blocked", "shell-bypass": "Shell policy bypass is blocked",
    "process-detach": "detached processes are blocked", "service-management": "service state changes are blocked",
    "container-destructive": "high-risk container operations are blocked", "kubernetes-write": "Kubernetes writes are blocked",
    "git-destructive": "high-risk Git operations are blocked",
    "readonly-shell-operator": "readonly blocks redirection, background execution, command substitution, and subshells",
    "readonly-command-substitution": "command substitution is blocked in readonly mode",
    "readonly-explicit-binary-path": "explicit binary paths are blocked in readonly mode",
    "systemctl-subcommand": "only readonly systemctl operations are allowed",
    "curl-write-or-body-option": "curl only allows GET/HEAD without request bodies or file output",
    "curl-method": "curl only allows GET/HEAD methods",
    "curl-http-url": "curl only allows HTTP/HTTPS URLs",
  },
};

export class OperationLogger {
  readonly auditPath?: string;
  private readonly stream?: WriteStream;

  constructor(auditDir: string, sessionId: string, enabled: boolean, private readonly locale: Locale = DEFAULT_LOCALE) {
    if (enabled) {
      mkdirSync(auditDir, { recursive: true, mode: 0o700 });
      this.auditPath = path.join(auditDir, `${sessionId}.jsonl`);
      this.stream = createWriteStream(this.auditPath, { flags: "a", mode: 0o600 });
    }
  }

  event(event: AuditEvent, options: { console?: boolean } = {}): void {
    const normalized: AuditEvent = {
      ...event,
      time: event.time ?? new Date().toISOString(),
      ...(event.clientId ? { clientId: event.clientId.slice(0, 8) } : {}),
      ...(event.command ? { command: redactSensitive(event.command) } : {}),
      ...(event.message ? { message: redactSensitive(event.message) } : {}),
    };
    const time = new Date(normalized.time!).toLocaleTimeString(this.locale === "en" ? "en-US" : "zh-CN", { hour12: false });
    const label = labels[this.locale][normalized.action] ?? normalized.action;
    const subject = normalized.command ?? normalized.path ?? normalized.message ?? "";
    const ruleDescription = normalized.rule ? describeRule(this.locale, normalized.rule) : undefined;
    const details = [
      normalized.jobId ? `${localize(this.locale, "任务", "Job")}=${normalized.jobId}` : "",
      normalized.status ? `${localize(this.locale, "状态", "Status")}=${statuses[this.locale][normalized.status] ?? normalized.status}` : "",
      normalized.code ? `${localize(this.locale, "错误码", "Code")}=${normalized.code}` : "",
      normalized.rule ? `${localize(this.locale, "规则", "Rule")}=${normalized.rule}${ruleDescription ? localize(this.locale, `（${ruleDescription}）`, ` (${ruleDescription})`) : ""}` : "",
      normalized.exitCode !== undefined ? `${localize(this.locale, "退出码", "Exit")}=${normalized.exitCode ?? localize(this.locale, "信号终止", "signal")}` : "",
      normalized.durationMs !== undefined ? `${localize(this.locale, "耗时", "Duration")}=${normalized.durationMs}ms` : "",
      normalized.bytes !== undefined ? `${localize(this.locale, "字节", "Bytes")}=${normalized.bytes}` : "",
      normalized.message && subject !== normalized.message ? `${localize(this.locale, "原因", "Reason")}=${normalized.message}` : "",
      normalized.clientId ? `Client ID=${normalized.clientId.slice(0, 8)}` : "",
      normalized.clientIp ? `${localize(this.locale, "客户端IP", "Client IP")}=${normalized.clientIp}` : "",
    ].filter(Boolean).join(" ");
    if (options.console !== false) {
      process.stdout.write(`${[time, `[${label}]`, subject, details].filter(Boolean).join("  ")}\n`);
    }
    this.stream?.write(`${JSON.stringify(normalized)}\n`);
  }

  async close(): Promise<void> {
    if (!this.stream || this.stream.closed) return;
    await new Promise<void>((resolve, reject) => {
      this.stream!.once("error", reject);
      this.stream!.end(resolve);
    });
  }
}

function describeRule(locale: Locale, rule: string): string | undefined {
  const fixed = rules[locale][rule];
  if (fixed) return fixed;
  if (rule.startsWith("readonly-command:")) {
    const command = rule.slice("readonly-command:".length);
    return localize(locale, `命令 ${command} 不在 readonly 白名单中`, `command ${command} is not registered in the readonly allowlist`);
  }
  return undefined;
}
