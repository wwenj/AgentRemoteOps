import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_LOCALE, localize } from "./i18n.js";
import type { Locale, PermissionMode } from "./types.js";
import { sha256 } from "./utils.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export class FilePolicyError extends Error {
  constructor(message: string, readonly code = "PATH_DENIED", readonly messageEn = "File operation denied") {
    super(message);
  }
}

export class FileService {
  private constructor(
    readonly workingDirectory: string,
    private readonly mode: PermissionMode,
  ) {}

  static async create(workingDirectory: string, mode: PermissionMode, locale: Locale = DEFAULT_LOCALE): Promise<FileService> {
    const root = await realpath(workingDirectory);
    const info = await stat(root);
    if (!info.isDirectory()) {
      throw new FilePolicyError(
        localize(locale, "workingDirectory 必须是目录", "workingDirectory must be a directory"),
        "INVALID_WORKING_DIRECTORY",
        "workingDirectory must be a directory",
      );
    }
    return new FileService(root, mode);
  }

  async stat(inputPath: string): Promise<Record<string, unknown>> {
    const target = await this.resolveExisting(inputPath);
    const info = await stat(target);
    return {
      path: target,
      type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
      size: info.size,
      mode: info.mode & 0o777,
      mtime: info.mtime.toISOString(),
    };
  }

  async list(inputPath: string): Promise<Array<Record<string, unknown>>> {
    const target = await this.resolveExisting(inputPath);
    const entries = await readdir(target, { withFileTypes: true });
    return Promise.all(entries.map(async (entry) => {
      const info = await lstat(path.join(target, entry.name));
      return {
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
        size: info.size,
        mtime: info.mtime.toISOString(),
      };
    }));
  }

  async read(inputPath: string): Promise<{ content: string; encoding: "base64"; size: number; sha256: string }> {
    const target = await this.resolveExisting(inputPath);
    const info = await stat(target);
    if (!info.isFile()) throw new FilePolicyError("目标不是普通文件", "NOT_FILE", "The target is not a regular file");
    if (info.size > MAX_FILE_BYTES) throw new FilePolicyError("文件超过 10 MiB 上限", "FILE_TOO_LARGE", "The file exceeds the 10 MiB limit");
    const content = await readFile(target);
    return { content: content.toString("base64"), encoding: "base64", size: content.length, sha256: sha256(content) };
  }

  async write(inputPath: string, encoded: string, ifMatch?: string): Promise<{ size: number; sha256: string }> {
    if (this.mode === "readonly") {
      throw new FilePolicyError("readonly 禁止写文件", "CAPABILITY_DENIED", "File writes are not allowed in readonly mode");
    }
    const content = Buffer.from(encoded, "base64");
    if (content.length > MAX_FILE_BYTES) throw new FilePolicyError("文件超过 10 MiB 上限", "FILE_TOO_LARGE", "The file exceeds the 10 MiB limit");

    const lexicalTarget = this.resolveInput(inputPath);
    let target = lexicalTarget;
    try {
      const targetInfo = await lstat(lexicalTarget);
      if (targetInfo.isDirectory()) throw new FilePolicyError("禁止写入目录", "NOT_FILE", "Writing to a directory is not allowed");
      if (targetInfo.isSymbolicLink()) target = await realpath(lexicalTarget);
    } catch (error) {
      if (error instanceof FilePolicyError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true });
    let existingMode = 0o644;
    try {
      const current = await readFile(target);
      if (ifMatch && sha256(current) !== ifMatch) throw new FilePolicyError("文件已发生变化", "PRECONDITION_FAILED", "The file has changed");
      existingMode = (await stat(target)).mode & 0o777;
    } catch (error) {
      if (error instanceof FilePolicyError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (ifMatch) throw new FilePolicyError("目标文件不存在", "PRECONDITION_FAILED", "The target file does not exist");
    }

    const temporary = path.join(parent, `.agent-remoteops-${randomBytes(8).toString("hex")}.tmp`);
    try {
      const handle = await open(temporary, "wx", existingMode);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(temporary, existingMode);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return { size: content.length, sha256: sha256(content) };
  }

  async resolveCwd(inputPath: string): Promise<string> {
    const target = await this.resolveExisting(inputPath || ".");
    if (!(await stat(target)).isDirectory()) throw new FilePolicyError("cwd 必须是目录", "INVALID_CWD", "cwd must be a directory");
    return target;
  }

  private resolveInput(value: string): string {
    if (typeof value !== "string" || value.includes("\0")) throw new FilePolicyError("无效路径", "PATH_DENIED", "Invalid path");
    return path.normalize(path.isAbsolute(value) ? value : path.resolve(this.workingDirectory, value || "."));
  }

  private async resolveExisting(inputPath: string): Promise<string> {
    return realpath(this.resolveInput(inputPath));
  }
}
