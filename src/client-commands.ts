import { password } from "@inquirer/prompts";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiClient } from "./api-client.js";
import { DEFAULT_LOCALE, localize } from "./i18n.js";
import { SessionStore } from "./session-store.js";
import type { Locale } from "./types.js";
import { sleep } from "./utils.js";

const store = new SessionStore();

export async function connectCommand(urlValue: string, name: string): Promise<void> {
  const url = new URL(urlValue);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("连接地址必须是 HTTP(S) URL");
  const token = process.env.AGENT_REMOTEOPS_TOKEN || await password({ message: "Token", mask: "*" });
  const clientId = randomUUID();
  const client = new ApiClient({ url: url.toString().replace(/\/$/, ""), token, clientId });
  const info = await client.get<{ expiresAt: string; mode: string; workingDirectory: string; locale?: Locale }>("/v1/session");
  await store.save({ name, url: url.toString().replace(/\/$/, ""), token, clientId, ...info });
  const locale = info.locale ?? DEFAULT_LOCALE;
  process.stdout.write(localize(
    locale,
    `已连接：${name}\n权限模式：${info.mode}\n初始工作目录：${info.workingDirectory}\n到期时间：${info.expiresAt}\n`,
    `Connected: ${name}\nPermission mode: ${info.mode}\nInitial working directory: ${info.workingDirectory}\nExpires: ${info.expiresAt}\n`,
  ));
}

export async function statusCommand(json: boolean): Promise<void> {
  const session = await store.current();
  const info = await new ApiClient(session).get<Record<string, unknown>>("/v1/session");
  process.stdout.write(json ? `${JSON.stringify(info)}\n` : formatObject(info));
}

export async function execCommand(command: string, timeoutMs: number, json: boolean): Promise<void> {
  const session = await store.current();
  const client = new ApiClient(session);
  const created = await client.post<{ jobId: string }>("/v1/jobs", { command, timeoutMs }, true);
  let cursor = 0;
  while (true) {
    const job = await client.get<{
      status: string; chunks: Array<{ cursor: number; stream: "stdout" | "stderr"; data: string }>;
      exitCode?: number | null; truncated: boolean; error?: string;
    }>(`/v1/jobs/${created.jobId}?cursor=${cursor}`);
    for (const chunk of job.chunks) {
      cursor = Math.max(cursor, chunk.cursor);
      if (!json) (chunk.stream === "stderr" ? process.stderr : process.stdout).write(chunk.data);
    }
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(job.status)) {
      if (json) process.stdout.write(`${JSON.stringify({ jobId: created.jobId, ...job })}\n`);
      if (job.truncated && !json) process.stderr.write(localize(session.locale ?? DEFAULT_LOCALE, "\n[输出已截断]\n", "\n[output truncated]\n"));
      if (job.status !== "succeeded") process.exitCode = job.exitCode ?? 1;
      return;
    }
    await sleep(400);
  }
}

export async function jobsCommand(json: boolean): Promise<void> {
  const session = await store.current();
  const result = await new ApiClient(session).get<{ jobs: unknown[] }>("/v1/jobs");
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result.jobs, null, 2)}\n`);
}

export async function cancelCommand(id: string): Promise<void> {
  const session = await store.current();
  const result = await new ApiClient(session).post<Record<string, unknown>>(`/v1/jobs/${id}/cancel`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function statCommand(remotePath: string, json: boolean): Promise<void> {
  const result = await fsRequest<Record<string, unknown>>("stat", remotePath);
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : formatObject(result));
}

export async function listCommand(remotePath: string, json: boolean): Promise<void> {
  const result = await fsRequest<{ entries: Array<Record<string, unknown>> }>("list", remotePath);
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result.entries, null, 2)}\n`);
}

export async function readCommand(remotePath: string, output?: string): Promise<void> {
  const result = await fsRequest<{ content: string; size: number; sha256: string }>("read", remotePath);
  const data = Buffer.from(result.content, "base64");
  if (output) {
    await writeFile(output, data);
    process.stdout.write(`Saved ${result.size} bytes to ${output} (${result.sha256})\n`);
  } else process.stdout.write(data);
}

export async function writeCommand(localPath: string, remotePath: string, ifMatch?: string): Promise<void> {
  const session = await store.current();
  const content = await readFile(localPath);
  const result = await new ApiClient(session).post<Record<string, unknown>>("/v1/fs/write", {
    path: remotePath, content: content.toString("base64"), encoding: "base64", ...(ifMatch ? { ifMatch } : {}),
  }, true);
  process.stdout.write(formatObject(result));
}

export async function disconnectCommand(name?: string): Promise<void> {
  await store.remove(name);
  process.stdout.write("Disconnected.\n");
}

export async function installSkillCommand(force: boolean): Promise<void> {
  const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
  const target = path.join(codexHome, "skills", "agent-remoteops");
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "agent-remoteops");
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force, errorOnExist: !force });
  process.stdout.write(`Codex Skill installed: ${target}\n`);
}

async function fsRequest<T>(action: string, remotePath: string): Promise<T> {
  const session = await store.current();
  return new ApiClient(session).post<T>(`/v1/fs/${action}`, { path: remotePath });
}

function formatObject(value: Record<string, unknown>): string {
  return Object.entries(value).map(([key, item]) => `${key}: ${typeof item === "object" ? JSON.stringify(item) : String(item)}`).join("\n") + "\n";
}
