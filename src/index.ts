import { Command } from "commander";
import {
  cancelCommand,
  connectCommand,
  disconnectCommand,
  execCommand,
  installSkillCommand,
  jobsCommand,
  listCommand,
  readCommand,
  statCommand,
  statusCommand,
  writeCommand,
} from "./client-commands.js";
import { describePolicy } from "./policy.js";
import { startInteractive } from "./start-wizard.js";
import type { PermissionMode } from "./types.js";

const program = new Command();
program.name("agent-remoteops").description("Temporary remote operations bridge for coding agents").version("0.2.0");

program.command("start").description("交互式启动临时远程服务").action(startInteractive);
program.command("connect")
  .description("连接远程 Session")
  .argument("<url>")
  .option("-n, --name <name>", "Session 名称", "default")
  .action((url, options) => connectCommand(url, options.name));
program.command("status").option("--json").action((options) => statusCommand(Boolean(options.json)));
program.command("exec")
  .argument("<command>")
  .option("--timeout <ms>", "超时毫秒", "60000")
  .option("--json")
  .action((command, options) => execCommand(command, Number(options.timeout), Boolean(options.json)));
program.command("jobs").option("--json").action((options) => jobsCommand(Boolean(options.json)));
program.command("cancel").argument("<job-id>").action(cancelCommand);
program.command("list").argument("<path>").option("--json").action((remotePath, options) => listCommand(remotePath, Boolean(options.json)));
program.command("stat").argument("<path>").option("--json").action((remotePath, options) => statCommand(remotePath, Boolean(options.json)));
program.command("read").argument("<remote-path>").option("-o, --out <file>").action((remotePath, options) => readCommand(remotePath, options.out));
program.command("write")
  .argument("<local-file>")
  .argument("<remote-path>")
  .option("--if-match <sha256>")
  .action((localPath, remotePath, options) => writeCommand(localPath, remotePath, options.ifMatch));
program.command("disconnect").argument("[name]").action(disconnectCommand);

const policy = program.command("policy").description("查看权限策略");
policy.command("show").argument("<mode>").action((mode: PermissionMode) => {
  if (!["readonly", "full"].includes(mode)) throw new Error("mode 必须是 readonly 或 full");
  process.stdout.write(`${describePolicy(mode).join("\n")}\n`);
});
const skill = program.command("skill").description("管理 Coding Agent Skill");
skill.command("install").argument("[target]", "当前仅支持 codex", "codex").option("--force").action((target, options) => {
  if (target !== "codex") throw new Error("当前仅支持 Codex Skill");
  return installSkillCommand(Boolean(options.force));
});

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
