import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Locale } from "./types.js";

export interface ClientSession {
  name: string;
  url: string;
  token: string;
  clientId: string;
  locale?: Locale;
  expiresAt: string;
  mode: string;
  workingDirectory: string;
}

interface StoreData {
  current?: string;
  sessions: Record<string, ClientSession>;
}

export class SessionStore {
  private readonly file = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "agent-remoteops", "sessions.json");

  async save(session: ClientSession): Promise<void> {
    const data = await this.read();
    data.sessions[session.name] = session;
    data.current = session.name;
    await this.write(data);
  }

  async current(): Promise<ClientSession> {
    const data = await this.read();
    if (!data.current || !data.sessions[data.current]) throw new Error("尚未连接 Agent RemoteOps Session");
    const session = data.sessions[data.current]!;
    if (!session.clientId) throw new Error("本地 Session 来自旧版协议，请重新执行 agent-remoteops connect");
    return session;
  }

  async remove(name?: string): Promise<void> {
    const data = await this.read();
    const target = name ?? data.current;
    if (!target) return;
    delete data.sessions[target];
    if (data.current === target) {
      const next = Object.keys(data.sessions)[0];
      if (next) data.current = next;
      else delete data.current;
    }
    await this.write(data);
  }

  private async read(): Promise<StoreData> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as StoreData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sessions: {} };
      throw error;
    }
  }

  private async write(data: StoreData): Promise<void> {
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.file);
  }
}
