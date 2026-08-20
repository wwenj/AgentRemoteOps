import path from "node:path";
import { parse } from "shell-quote";
import { DEFAULT_LOCALE, localize } from "./i18n.js";
import type { Locale, PermissionMode } from "./types.js";

export interface CommandSpec {
  binary: string;
  args: string[];
}

export type SequenceOperator = ";" | "&&" | "||";

export interface ReadonlyCommandGroup {
  operator?: SequenceOperator;
  pipeline: CommandSpec[];
}

export interface PolicyDecision {
  allowed: boolean;
  rule?: string;
  sequence?: ReadonlyCommandGroup[];
}

const SIMPLE_READONLY = new Set([
  "pwd", "ls", "stat", "cat", "head", "tail", "wc", "grep", "cut",
  "uptime", "uname", "id", "whoami", "df", "du", "free", "ps",
  "netstat", "lsof", "jq", "readlink", "realpath", "getent", "getfacl",
  "nproc", "lscpu", "vmstat", "pwdx", "lsblk", "echo", "printf", "true", "false",
]);

const SPECIAL_READONLY = new Set([
  "date", "hostname", "sort", "uniq", "rg", "ss", "find", "journalctl", "systemctl", "docker",
  "git", "hostnamectl", "top", "blkid", "dmesg", "ip", "rpm", "curl",
]);

function basename(binary: string): string {
  return path.posix.basename(binary).toLowerCase();
}

function hasOption(args: string[], names: string[]): boolean {
  return args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

function validateDate(args: string[]): string | undefined {
  if (args.some((arg) => arg === "-s" || /^-s.+/.test(arg) || arg === "--set" || arg.startsWith("--set="))) {
    return "date-mutating-option";
  }
  const optionsWithValue = new Set(["-d", "--date", "-f", "--file", "-r", "--reference"]);
  const optionsWithoutValue = new Set(["-u", "--utc", "--universal", "-R", "--rfc-email", "--debug", "--help", "--version", "--resolution"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("+") || optionsWithoutValue.has(arg) || /^-(?:I|d|f|r).+/.test(arg)
      || /^--(?:date|file|reference|iso-8601|rfc-3339)=/.test(arg) || arg === "-I" || arg === "--iso-8601") continue;
    if (optionsWithValue.has(arg) && args[index + 1] !== undefined) {
      index += 1;
      continue;
    }
    return "date-mutating-argument";
  }
  return undefined;
}

function validateHostname(args: string[]): string | undefined {
  const safe = new Set(["-a", "--alias", "-d", "--domain", "-f", "--fqdn", "--long", "-i", "--ip-address", "-I", "--all-ip-addresses", "-s", "--short", "-y", "--yp", "--nis"]);
  return args.every((arg) => safe.has(arg)) ? undefined : "hostname-mutating-argument";
}

function validateSort(args: string[]): string | undefined {
  return hasOption(args, ["-o", "--output", "--compress-program"]) || args.some((arg) => /^-o.+/.test(arg))
    ? "sort-output-option"
    : undefined;
}

function validateUniq(args: string[]): string | undefined {
  const optionsWithValue = new Set(["-f", "--skip-fields", "-s", "--skip-chars", "-w", "--check-chars"]);
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (optionsWithValue.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) positional.push(arg);
  }
  return positional.length > 1 ? "uniq-output-file" : undefined;
}

function validateRg(args: string[]): string | undefined {
  return hasOption(args, ["--pre"]) ? "rg-preprocessor" : undefined;
}

function validateSs(args: string[]): string | undefined {
  return hasOption(args, ["-K", "--kill"]) || args.some((arg) => /^-[^-]*K/.test(arg)) ? "ss-kill" : undefined;
}

function validateFind(args: string[]): string | undefined {
  return args.some((arg) => /^-(?:exec|execdir|ok|okdir|delete|fls|fprint|fprintf)(?:$|[^A-Za-z])/.test(arg))
    ? "find-mutating-action"
    : undefined;
}

function validateJournalctl(args: string[]): string | undefined {
  return args.some((arg) => /^--(?:rotate|vacuum(?:-[A-Za-z-]+)?|flush|sync|relinquish-var|smart-relinquish-var|setup-keys|update-catalog)(?:=|$)/.test(arg))
    ? "journalctl-mutating-action"
    : undefined;
}

function validateSystemctl(args: string[]): string | undefined {
  const allowed = new Set([
    "status", "show", "is-active", "is-failed", "list-units", "list-unit-files", "cat",
    "list-sockets", "list-timers", "get-default",
  ]);
  const subcommand = args.find((arg) => !arg.startsWith("-"));
  if (subcommand && allowed.has(subcommand)) return undefined;
  if (!subcommand && args.includes("--failed")) return undefined;
  return "systemctl-subcommand";
}

function validateDocker(args: string[]): string | undefined {
  const allowed = new Set(["ps", "logs", "inspect", "stats", "top", "version", "info"]);
  const subcommand = args.find((arg) => !arg.startsWith("-"));
  return subcommand && allowed.has(subcommand) ? undefined : "docker-subcommand";
}

function validateGit(args: string[]): string | undefined {
  const allowed = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "grep"]);
  if (hasOption(args, ["-c", "--config-env", "--exec-path", "--output", "--ext-diff", "--textconv", "--open-files-in-pager"])) {
    return "git-external-or-output-option";
  }
  const subcommandIndex = args.findIndex((arg) => allowed.has(arg));
  if (subcommandIndex < 0) return "git-subcommand";
  const globalOptionsWithValue = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);
  for (let index = 0; index < subcommandIndex; index += 1) {
    const arg = args[index]!;
    if (globalOptionsWithValue.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-") || /^(?:--git-dir|--work-tree|--namespace|--super-prefix)=/.test(arg)) continue;
    return "git-subcommand";
  }
  const subcommand = args[subcommandIndex]!;
  if (subcommand === "branch") {
    const mutating = ["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "--edit-description", "--set-upstream-to", "--unset-upstream"];
    if (args.slice(subcommandIndex + 1).some((arg) => mutating.some((option) => arg === option || arg.startsWith(`${option}=`) || (/^-[dDmMcC]/.test(arg) && option.length === 2)))) {
      return "git-branch-write";
    }
    if (args.slice(subcommandIndex + 1).some((arg) => !arg.startsWith("-"))) return "git-branch-write";
  }
  return undefined;
}

function validateHostnamectl(args: string[]): string | undefined {
  const positional = args.filter((arg) => !arg.startsWith("-"));
  return positional.length === 0 || (positional.length === 1 && positional[0] === "status")
    ? undefined
    : "hostnamectl-subcommand";
}

function validateTop(args: string[]): string | undefined {
  if (!args.includes("-b") && !args.includes("--batch-mode")) return "top-interactive-mode";
  const iterations = args.findIndex((arg) => arg === "-n" || arg === "--iterations" || /^-n\d+$/.test(arg) || arg.startsWith("--iterations="));
  if (iterations >= 0) {
    const argument = args[iterations]!;
    const count = Number(argument.startsWith("-n") && argument !== "-n"
      ? argument.slice(2)
      : argument.startsWith("--iterations=") ? argument.slice("--iterations=".length) : args[iterations + 1]);
    if (!Number.isInteger(count) || count < 1 || count > 5) return "top-iterations";
  }
  return undefined;
}

function validateBlkid(args: string[]): string | undefined {
  return hasOption(args, ["-w", "--write-cache", "-g", "--garbage-collect"])
    ? "blkid-mutating-option"
    : undefined;
}

function validateDmesg(args: string[]): string | undefined {
  return hasOption(args, ["-C", "--clear", "-c", "--read-clear"]) || args.some((arg) => /^-[^-]*[Cc]/.test(arg))
    ? "dmesg-mutating-option"
    : undefined;
}

function validateIp(args: string[]): string | undefined {
  const mutating = new Set(["add", "append", "change", "delete", "del", "flush", "replace", "set"]);
  if (args.some((arg) => mutating.has(arg))) return "ip-mutating-operation";
  const objects = new Set(["address", "addr", "link", "route", "rule", "neighbor", "neighbour", "neigh"]);
  const object = args.find((arg) => !arg.startsWith("-"));
  return object && objects.has(object) ? undefined : "ip-object";
}

function validateRpm(args: string[]): string | undefined {
  const mutatingLong = ["--install", "--upgrade", "--freshen", "--erase", "--setperms", "--setugids", "--rebuilddb", "--initdb"];
  if (hasOption(args, mutatingLong) || args.some((arg) => /^-(?:i|U|F|e)(?:$|[^q])/.test(arg))) {
    return "rpm-mutating-operation";
  }
  const query = args.some((arg) => arg === "--query" || /^-[^-]*q/.test(arg));
  return query ? undefined : "rpm-query-only";
}

function validateCurl(args: string[]): string | undefined {
  const blocked = [
    "-d", "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode", "--json",
    "-F", "--form", "--form-string", "-T", "--upload-file", "-o", "--output", "-O", "--remote-name",
    "--remote-name-all", "--output-dir", "--create-dirs", "-c", "--cookie-jar", "-K", "--config",
    "-D", "--dump-header", "--trace", "--trace-ascii", "--trace-config", "--libcurl", "--proto",
    "--proto-redir", "--etag-save", "--alt-svc", "--hsts",
  ];
  if (hasOption(args, blocked) || args.some((arg) => /^-(?:d|F|T|o|c|K|D).+/.test(arg))) {
    return "curl-write-or-body-option";
  }
  if (hasOption(args, ["--retry", "--retry-all-errors", "--retry-delay", "--retry-max-time"])) {
    return "curl-retry-option";
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    let method: string | undefined;
    if (arg === "-X" || arg === "--request") method = args[index + 1];
    else if (arg.startsWith("--request=")) method = arg.slice("--request=".length);
    else if (/^-X.+/.test(arg)) method = arg.slice(2);
    if (method && !["GET", "HEAD"].includes(method.toUpperCase())) return "curl-method";

    let timeout: string | undefined;
    if (arg === "-m" || arg === "--max-time") timeout = args[index + 1];
    else if (/^-m.+/.test(arg)) timeout = arg.slice(2);
    else if (arg.startsWith("--max-time=")) timeout = arg.slice("--max-time=".length);
    if (timeout !== undefined && (!Number.isFinite(Number(timeout)) || Number(timeout) <= 0 || Number(timeout) > 30)) {
      return "curl-timeout";
    }
  }

  const urls: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--url" && args[index + 1]) urls.push(args[++index]!);
    else if (arg.startsWith("--url=")) urls.push(arg.slice("--url=".length));
    else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(arg)) urls.push(arg);
  }
  if (urls.length === 0 || urls.some((url) => !/^https?:\/\//i.test(url))) return "curl-http-url";
  return undefined;
}

function deniedReadonlyArgs(binary: string, args: string[]): string | undefined {
  switch (binary) {
    case "date": return validateDate(args);
    case "hostname": return validateHostname(args);
    case "sort": return validateSort(args);
    case "uniq": return validateUniq(args);
    case "rg": return validateRg(args);
    case "ss": return validateSs(args);
    case "find": return validateFind(args);
    case "journalctl": return validateJournalctl(args);
    case "systemctl": return validateSystemctl(args);
    case "docker": return validateDocker(args);
    case "git": return validateGit(args);
    case "hostnamectl": return validateHostnamectl(args);
    case "top": return validateTop(args);
    case "blkid": return validateBlkid(args);
    case "dmesg": return validateDmesg(args);
    case "ip": return validateIp(args);
    case "rpm": return validateRpm(args);
    case "curl": return validateCurl(args);
    default: return undefined;
  }
}

function containsCommandSubstitution(command: string): boolean {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && !singleQuoted) {
      escaped = true;
      continue;
    }
    if (character === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
      continue;
    }
    if (character === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (!singleQuoted && (character === "`" || (character === "$" && command[index + 1] === "("))) return true;
  }
  return false;
}

function parseReadonly(command: string): PolicyDecision {
  if (containsCommandSubstitution(command)) return { allowed: false, rule: "readonly-command-substitution" };
  let tokens: ReturnType<typeof parse>;
  try {
    tokens = parse(command, () => { throw new Error("variable expansion"); });
  } catch {
    return { allowed: false, rule: "readonly-invalid-syntax" };
  }

  const groups: Array<{ operator?: SequenceOperator; segments: string[][] }> = [{ segments: [[]] }];
  for (const token of tokens) {
    const group = groups.at(-1)!;
    const segment = group.segments.at(-1)!;
    if (typeof token === "string") {
      segment.push(token);
      continue;
    }
    if (!("op" in token)) return { allowed: false, rule: "readonly-shell-operator" };
    if (token.op === "|") {
      if (segment.length === 0) return { allowed: false, rule: "readonly-empty-pipe" };
      group.segments.push([]);
      continue;
    }
    if (token.op === ";" || token.op === "&&" || token.op === "||") {
      if (segment.length === 0) return { allowed: false, rule: "readonly-empty-command" };
      groups.push({ operator: token.op, segments: [[]] });
      continue;
    }
    return { allowed: false, rule: "readonly-shell-operator" };
  }
  if (groups.some((group) => group.segments.some((segment) => segment.length === 0))) {
    return { allowed: false, rule: "readonly-empty-command" };
  }

  const sequence: ReadonlyCommandGroup[] = [];
  for (const group of groups) {
    const pipeline: CommandSpec[] = [];
    for (const segment of group.segments) {
      const [rawBinary, ...args] = segment;
      const binary = basename(rawBinary!);
      if (rawBinary !== binary) return { allowed: false, rule: "readonly-explicit-binary-path" };
      if (!SIMPLE_READONLY.has(binary) && !SPECIAL_READONLY.has(binary)) {
        return { allowed: false, rule: `readonly-command:${binary}` };
      }
      const denied = deniedReadonlyArgs(binary, args);
      if (denied) return { allowed: false, rule: denied };
      pipeline.push({ binary, args });
    }
    sequence.push({ ...(group.operator ? { operator: group.operator } : {}), pipeline });
  }
  return { allowed: true, sequence };
}

export function evaluateCommand(mode: PermissionMode, command: string): PolicyDecision {
  if (!command.trim()) return { allowed: false, rule: "empty-command" };
  if (command.length > 16_384) return { allowed: false, rule: "command-too-long" };
  return mode === "full" ? { allowed: true } : parseReadonly(command);
}

export function describePolicy(mode: PermissionMode, locale: Locale = DEFAULT_LOCALE): string[] {
  if (mode === "readonly") return [
    localize(locale, "文件 API：可读取启动用户有权访问的任意路径，禁止写入", "File API: read any path accessible to the launching user; writes are denied"),
    localize(locale, "命令：只读命令白名单，支持 ;、&&、|| 和 pipeline，整条命令预校验", "Commands: readonly allowlist with ;, &&, || and pipelines; the whole command is prevalidated"),
    localize(locale, "保护系统完整性，不保护信息机密性", "Protects system integrity, not information confidentiality"),
  ];
  return [
    localize(locale, "文件 API：可读写启动用户有权访问的任意路径", "File API: read and write any path accessible to the launching user"),
    localize(locale, "命令：不做内容限制，通过 /bin/bash -lc 执行", "Commands: unrestricted and executed through /bin/bash -lc"),
    localize(locale, "workingDirectory 仅作为初始 cwd，不是安全边界", "workingDirectory is only the initial cwd, not a security boundary"),
  ];
}
