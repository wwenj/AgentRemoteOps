import type { ChildProcess } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { sleep } from "./utils.js";

interface TrackedProcess {
  child: ChildProcess;
  label: string;
}

export class ProcessRegistry {
  private readonly processes = new Map<number, TrackedProcess>();

  register(child: ChildProcess, label: string): void {
    if (!child.pid) throw new Error(`无法跟踪未启动的进程：${label}`);
    this.processes.set(child.pid, { child, label });
    child.once("exit", () => this.processes.delete(child.pid!));
  }

  unregister(pid: number): void {
    this.processes.delete(pid);
  }

  get size(): number {
    return this.processes.size;
  }

  async terminatePids(pids: number[], graceMs = 3_000): Promise<void> {
    const active = pids.filter((pid) => this.isAlive(pid));
    for (const pid of active) this.signalGroup(pid, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && active.some((pid) => this.isAlive(pid))) {
      await sleep(50);
    }
    for (const pid of active) {
      if (this.isAlive(pid)) this.signalGroup(pid, "SIGKILL");
      this.processes.delete(pid);
    }
  }

  async terminateAll(sessionId: string): Promise<number> {
    const pids = [...this.processes.keys()];
    await this.terminatePids(pids);
    await this.terminateSessionProcesses(sessionId);
    return pids.length;
  }

  private signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        try { process.kill(pid, signal); } catch { /* already gone */ }
      }
    }
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async terminateSessionProcesses(sessionId: string): Promise<void> {
    if (process.platform !== "linux") return;
    let entries: string[];
    try { entries = await readdir("/proc"); } catch { return; }
    const marker = `AGENT_REMOTEOPS_SESSION_ID=${sessionId}`;
    const found: number[] = [];
    await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(async (entry) => {
      const pid = Number(entry);
      if (pid === process.pid) return;
      try {
        const env = await readFile(`/proc/${entry}/environ`, "utf8");
        if (env.split("\0").includes(marker)) found.push(pid);
      } catch { /* different user or exited */ }
    }));
    await this.terminatePids(found, 500);
  }
}
