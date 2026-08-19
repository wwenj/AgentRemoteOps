import path from "node:path";
import { parse } from "shell-quote";
import type { PermissionMode } from "./types.js";

export interface CommandSpec {
  binary: string;
  args: string[];
}

export interface PolicyDecision {
  allowed: boolean;
  rule?: string;
  pipeline?: CommandSpec[];
}

const SIMPLE_READONLY = new Set([
  "pwd", "ls", "stat", "cat", "head", "tail", "wc", "grep", "rg", "cut", "sort", "uniq",
  "date", "uptime", "uname", "id", "whoami", "hostname", "df", "du", "free", "ps", "ss",
  "netstat", "lsof", "jq", "readlink", "realpath",
]);

const READWRITE_DENIED = new Map<string, string>([
  ["rm", "filesystem-destroy"], ["rmdir", "filesystem-destroy"], ["unlink", "filesystem-destroy"],
  ["shred", "filesystem-destroy"], ["truncate", "filesystem-destroy"], ["dd", "disk-destroy"],
  ["wipefs", "disk-destroy"], ["blkdiscard", "disk-destroy"], ["fdisk", "disk-destroy"],
  ["sfdisk", "disk-destroy"], ["cfdisk", "disk-destroy"], ["parted", "disk-destroy"],
  ["shutdown", "system-lifecycle"], ["reboot", "system-lifecycle"], ["poweroff", "system-lifecycle"],
  ["halt", "system-lifecycle"], ["init", "system-lifecycle"], ["kexec", "system-lifecycle"],
  ["insmod", "kernel-change"], ["rmmod", "kernel-change"], ["modprobe", "kernel-change"],
  ["sysctl", "kernel-change"], ["sudo", "privilege-change"], ["su", "privilege-change"],
  ["doas", "privilege-change"], ["passwd", "identity-change"], ["useradd", "identity-change"],
  ["userdel", "identity-change"], ["usermod", "identity-change"], ["groupadd", "identity-change"],
  ["groupdel", "identity-change"], ["groupmod", "identity-change"], ["visudo", "privilege-change"],
  ["chown", "permission-change"], ["chmod", "permission-change"], ["setcap", "permission-change"],
  ["kill", "process-kill"], ["killall", "process-kill"], ["pkill", "process-kill"],
  ["iptables", "network-change"], ["nft", "network-change"], ["ufw", "network-change"],
  ["firewall-cmd", "network-change"], ["apt", "package-management"], ["apt-get", "package-management"],
  ["yum", "package-management"], ["dnf", "package-management"], ["pacman", "package-management"],
  ["zypper", "package-management"], ["apk", "package-management"], ["snap", "package-management"],
  ["python", "interpreter-bypass"], ["python3", "interpreter-bypass"], ["node", "interpreter-bypass"],
  ["perl", "interpreter-bypass"], ["ruby", "interpreter-bypass"], ["php", "interpreter-bypass"],
  ["lua", "interpreter-bypass"], ["sh", "interpreter-bypass"], ["bash", "interpreter-bypass"],
  ["zsh", "interpreter-bypass"], ["dash", "interpreter-bypass"], ["eval", "shell-bypass"],
  ["source", "shell-bypass"], ["exec", "shell-bypass"], ["command", "shell-bypass"],
  ["builtin", "shell-bypass"], ["env", "shell-bypass"], ["xargs", "shell-bypass"],
  ["nohup", "process-detach"], ["setsid", "process-detach"],
]);

function basename(binary: string): string {
  return path.posix.basename(binary).toLowerCase();
}

function deniedReadonlyArgs(binary: string, args: string[]): string | undefined {
  if (binary === "find" && args.some((arg) => /^-(?:exec|execdir|ok|okdir|delete|fls|fprint|fprintf)/.test(arg))) {
    return "find-mutating-action";
  }
  if (binary === "journalctl" && args.some((arg) => /^--(?:rotate|vacuum|flush|sync|relinquish-var)/.test(arg))) {
    return "journalctl-mutating-action";
  }
  if (binary === "systemctl") {
    const allowed = new Set(["status", "show", "is-active", "is-failed", "list-units", "list-unit-files"]);
    const subcommand = args.find((arg) => !arg.startsWith("-"));
    if (!subcommand || !allowed.has(subcommand)) return "systemctl-subcommand";
  }
  if (binary === "docker") {
    const allowed = new Set(["ps", "logs", "inspect", "stats", "top", "version", "info"]);
    const subcommand = args.find((arg) => !arg.startsWith("-"));
    if (!subcommand || !allowed.has(subcommand)) return "docker-subcommand";
  }
  if (binary === "git") {
    const allowed = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "grep"]);
    const subcommand = args.find((arg) => !arg.startsWith("-") && !arg.includes("="));
    if (!subcommand || !allowed.has(subcommand)) return "git-subcommand";
    if (subcommand === "branch" && args.some((arg) => !arg.startsWith("-") && arg !== "branch")) return "git-branch-write";
  }
  return undefined;
}

function parseReadonly(command: string): PolicyDecision {
  let tokens: ReturnType<typeof parse>;
  try {
    tokens = parse(command, () => { throw new Error("variable expansion"); });
  } catch {
    return { allowed: false, rule: "readonly-invalid-syntax" };
  }
  const pipelines: string[][] = [[]];
  for (const token of tokens) {
    if (typeof token === "string") {
      pipelines[pipelines.length - 1]!.push(token);
      continue;
    }
    if ("op" in token && token.op === "|") {
      if (pipelines[pipelines.length - 1]!.length === 0) return { allowed: false, rule: "readonly-empty-pipe" };
      pipelines.push([]);
      continue;
    }
    return { allowed: false, rule: "readonly-shell-operator" };
  }
  if (pipelines.some((segment) => segment.length === 0)) return { allowed: false, rule: "readonly-empty-command" };
  const specs: CommandSpec[] = [];
  for (const segment of pipelines) {
    const [rawBinary, ...args] = segment;
    const binary = basename(rawBinary!);
    if (rawBinary !== binary) return { allowed: false, rule: "readonly-explicit-binary-path" };
    if (!SIMPLE_READONLY.has(binary) && !["find", "journalctl", "systemctl", "docker", "git"].includes(binary)) {
      return { allowed: false, rule: `readonly-command:${binary}` };
    }
    if (args.some((arg) => path.posix.isAbsolute(arg) || arg === ".." || arg.startsWith("../") || arg.includes("=/"))) {
      return { allowed: false, rule: "readonly-path-outside-workspace" };
    }
    const denied = deniedReadonlyArgs(binary, args);
    if (denied) return { allowed: false, rule: denied };
    specs.push({ binary: rawBinary!, args });
  }
  return { allowed: true, pipeline: specs };
}

function parseExecutables(command: string): Array<{ binary: string; args: string[] }> {
  const tokens = parse(command);
  const commands: Array<{ binary: string; args: string[] }> = [];
  let current: string[] = [];
  const flush = () => {
    const withoutAssignments = current.filter((part, index) => index > 0 || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(part));
    if (withoutAssignments.length > 0) commands.push({ binary: basename(withoutAssignments[0]!), args: withoutAssignments.slice(1) });
    current = [];
  };
  for (const token of tokens) {
    if (typeof token === "string") current.push(token);
    else if ("op" in token) flush();
  }
  flush();
  return commands;
}

function checkReadwrite(command: string): PolicyDecision {
  if (/`|\$\s*\(/.test(command)) return { allowed: false, rule: "shell-command-substitution" };
  if (/\bmkfs(?:\.[A-Za-z0-9_-]+)?\b/i.test(command)) return { allowed: false, rule: "disk-destroy" };
  let commands: Array<{ binary: string; args: string[] }>;
  try { commands = parseExecutables(command); } catch { return { allowed: false, rule: "shell-invalid-syntax" }; }
  for (const item of commands) {
    const direct = READWRITE_DENIED.get(item.binary);
    if (direct) return { allowed: false, rule: direct };
    const subcommand = item.args.find((arg) => !arg.startsWith("-"));
    if (item.binary === "systemctl" && subcommand && ["start", "stop", "restart", "reload", "enable", "disable", "mask", "daemon-reload"].includes(subcommand)) {
      return { allowed: false, rule: "service-management" };
    }
    if (item.binary === "docker" && subcommand && ["rm", "rmi", "kill", "stop", "restart", "exec", "system", "volume"].includes(subcommand)) {
      return { allowed: false, rule: "container-destructive" };
    }
    if (item.binary === "kubectl" && subcommand && ["delete", "apply", "patch", "edit", "replace", "scale", "exec", "cp"].includes(subcommand)) {
      return { allowed: false, rule: "kubernetes-write" };
    }
    if (item.binary === "git") {
      const joined = item.args.join(" ");
      if (/\bclean\b|\breset\s+--hard\b|\bpush\b.*--force|\b(?:checkout|restore)\s+(?:--\s+)?\.\b/.test(joined)) {
        return { allowed: false, rule: "git-destructive" };
      }
    }
  }
  return { allowed: true };
}

export function evaluateCommand(mode: PermissionMode, command: string): PolicyDecision {
  if (!command.trim()) return { allowed: false, rule: "empty-command" };
  if (command.length > 16_384) return { allowed: false, rule: "command-too-long" };
  if (mode === "full") return { allowed: true };
  if (mode === "readonly") return parseReadonly(command);
  return checkReadwrite(command);
}

export function describePolicy(mode: PermissionMode): string[] {
  if (mode === "readonly") return [
    "文件 API：stat、list、read",
    "命令：诊断命令白名单，无 Shell 重定向、替换和组合操作",
  ];
  if (mode === "readwrite") return [
    "文件 API：stat、list、read、write",
    "命令：允许普通 Shell，拦截内置高危命令（防误操作，不是安全沙箱）",
  ];
  return ["文件 API：完整读写", "命令：不做内容限制，继承当前 Linux 用户全部权限"];
}
