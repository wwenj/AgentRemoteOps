import { Command } from "commander";
import { describePolicy } from "./policy.js";
import { startInteractive } from "./start-wizard.js";
import type { PermissionMode } from "./types.js";
import { SERVER_VERSION } from "./version.js";

const program = new Command();
program.name("agent-remoteops").description("Temporary remote operations server for coding agents").version(SERVER_VERSION);

program.command("start").description("交互式启动临时远程服务").action(startInteractive);

const policy = program.command("policy").description("查看权限策略");
policy.command("show").argument("<mode>").action((mode: PermissionMode) => {
  if (!["readonly", "full"].includes(mode)) throw new Error("mode 必须是 readonly 或 full");
  process.stdout.write(`${describePolicy(mode).join("\n")}\n`);
});

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
