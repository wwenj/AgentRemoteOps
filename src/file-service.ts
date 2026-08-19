import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import type { PermissionMode } from "./types.js";
import { sha256 } from "./utils.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export class FilePolicyError extends Error {
  constructor(message: string, readonly code = "PATH_DENIED") {
    super(message);
  }
}

export class FileService {
  private constructor(
    readonly workspace: string,
    private readonly mode: PermissionMode,
  ) {}

  static async create(workspace: string, mode: PermissionMode): Promise<FileService> {
    const root = await realpath(workspace);
    const info = await stat(root);
    if (!info.isDirectory()) throw new FilePolicyError("workspace 必须是目录", "INVALID_WORKSPACE");
    return new FileService(root, mode);
  }

  async stat(relativePath: string): Promise<Record<string, unknown>> {
    const target = await this.resolveExisting(relativePath);
    const info = await lstat(target);
    return {
      path: this.normalizeRelative(relativePath),
      type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
      size: info.size,
      mode: info.mode & 0o777,
      mtime: info.mtime.toISOString(),
    };
  }

  async list(relativePath: string): Promise<Array<Record<string, unknown>>> {
    const target = await this.resolveExisting(relativePath);
    const entries = await readdir(target, { withFileTypes: true });
    return Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(target, entry.name);
      const info = await lstat(entryPath);
      return {
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
        size: info.size,
        mtime: info.mtime.toISOString(),
      };
    }));
  }

  async read(relativePath: string): Promise<{ content: string; encoding: "base64"; size: number; sha256: string }> {
    const target = await this.resolveExisting(relativePath);
    const info = await stat(target);
    if (!info.isFile()) throw new FilePolicyError("目标不是普通文件", "NOT_FILE");
    if (info.size > MAX_FILE_BYTES) throw new FilePolicyError("文件超过 10 MiB 上限", "FILE_TOO_LARGE");
    const content = await readFile(target);
    return { content: content.toString("base64"), encoding: "base64", size: content.length, sha256: sha256(content) };
  }

  async write(relativePath: string, encoded: string, ifMatch?: string): Promise<{ size: number; sha256: string }> {
    if (this.mode === "readonly") throw new FilePolicyError("只读模式禁止写文件", "CAPABILITY_DENIED");
    const content = Buffer.from(encoded, "base64");
    if (content.length > MAX_FILE_BYTES) throw new FilePolicyError("文件超过 10 MiB 上限", "FILE_TOO_LARGE");
    const { target, parent } = await this.resolveForWrite(relativePath);
    let existingMode = 0o644;
    try {
      const current = await readFile(target);
      if (ifMatch && sha256(current) !== ifMatch) throw new FilePolicyError("文件已发生变化", "PRECONDITION_FAILED");
      existingMode = (await stat(target)).mode & 0o777;
    } catch (error) {
      if (error instanceof FilePolicyError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (ifMatch) throw new FilePolicyError("目标文件不存在", "PRECONDITION_FAILED");
    }
    await mkdir(parent, { recursive: true });
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

  async resolveCwd(relativePath: string): Promise<string> {
    const target = await this.resolveExisting(relativePath || ".");
    if (!(await stat(target)).isDirectory()) throw new FilePolicyError("cwd 必须是目录", "INVALID_CWD");
    return target;
  }

  private normalizeRelative(value: string): string {
    if (typeof value !== "string" || value.includes("\0")) throw new FilePolicyError("无效路径");
    if (path.isAbsolute(value)) throw new FilePolicyError("禁止绝对路径");
    const normalized = path.normalize(value || ".");
    if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new FilePolicyError("路径超出 workspace");
    return normalized;
  }

  private async resolveExisting(relativePath: string): Promise<string> {
    const normalized = this.normalizeRelative(relativePath);
    const lexical = path.join(this.workspace, normalized);
    await this.ensureNoSymlink(normalized);
    const resolved = await realpath(lexical);
    this.assertInside(resolved);
    return resolved;
  }

  private async resolveForWrite(relativePath: string): Promise<{ target: string; parent: string }> {
    const normalized = this.normalizeRelative(relativePath);
    const target = path.join(this.workspace, normalized);
    const parentRelative = path.dirname(normalized);
    await this.ensureNoSymlink(parentRelative);
    const parent = await realpath(path.join(this.workspace, parentRelative));
    this.assertInside(parent);
    try {
      const targetInfo = await lstat(target);
      if (targetInfo.isSymbolicLink() || targetInfo.isDirectory()) throw new FilePolicyError("禁止写入符号链接或目录");
    } catch (error) {
      if (error instanceof FilePolicyError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { target, parent };
  }

  private async ensureNoSymlink(relativePath: string): Promise<void> {
    const parts = this.normalizeRelative(relativePath).split(path.sep).filter((part) => part !== ".");
    let current = this.workspace;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new FilePolicyError("路径包含符号链接");
      } catch (error) {
        if (error instanceof FilePolicyError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
  }

  private assertInside(target: string): void {
    if (target !== this.workspace && !target.startsWith(`${this.workspace}${path.sep}`)) {
      throw new FilePolicyError("路径超出 workspace");
    }
  }
}
