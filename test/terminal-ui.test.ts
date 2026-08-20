import { describe, expect, it, vi } from "vitest";
import {
  formatDurationHuman,
  formatPermission,
  renderConfiguration,
  renderSessionReady,
  startLoadingIndicator,
} from "../src/terminal-ui.js";

describe("terminal UI", () => {
  it("formats durations and permission modes for people", () => {
    expect(formatDurationHuman(30 * 60_000)).toBe("30 分钟");
    expect(formatDurationHuman(90 * 60_000)).toBe("1 小时 30 分钟");
    expect(formatPermission("readonly")).toBe("readonly（只读安全模式）");
    expect(formatPermission("full")).toBe("full（完全访问模式）");
  });

  it("renders the configuration as single-line label-value rows", () => {
    const output = renderConfiguration({
      workingDirectory: "/srv/app",
      ttlMs: 30 * 60_000,
      mode: "readonly",
      policy: ["文件 API：stat、list、read"],
      linuxUser: "app",
      audit: "已关闭",
      tunnel: "Cloudflare Quick Tunnel",
    });

    expect(output).toContain("初始工作目录  /srv/app");
    expect(output).toContain("有效期    30 分钟");
    expect(output).toContain("权限模式  readonly（只读安全模式）");
    expect(output).toContain("  • 文件 API：stat、list、read");
  });

  it("renders copy guidance, expiry, cleanup, and live-log hints", () => {
    const output = renderSessionReady({
      url: "https://example.trycloudflare.com",
      token: "arops_example",
      expiresAt: new Date("2026-08-19T11:00:00.000Z"),
      workingDirectory: "/srv/app",
      ttlMs: 30 * 60_000,
      mode: "readonly",
    });

    expect(output).toContain("URL       https://example.trycloudflare.com");
    expect(output).toContain("Token     arops_example");
    expect(output).toContain("复制以上 URL、Token 和任务");
    expect(output).toContain("Codex");
    expect(output).toContain("本地只需要安装 Skill");
    expect(output).not.toContain("agent-remoteops connect");
    expect(output).toContain("Client ID 将成为本次 Session 唯一客户端");
    expect(output).toContain("不构成权限边界");
    expect(output).toContain("Session 将在 30 分钟后自动到期");
    expect(output).toContain("日志会在下方实时输出");
  });

  it("renders an animated loading indicator and clears it when stopped", () => {
    vi.useFakeTimers();
    const chunks: string[] = [];
    try {
      const stop = startLoadingIndicator("正在启动 Agent RemoteOps，请稍候……", { color: false }, (chunk) => chunks.push(chunk));

      expect(chunks.join("")).toContain("⣋ 正在启动 Agent RemoteOps，请稍候……");
      vi.advanceTimersByTime(80);
      expect(chunks.join("")).toContain("⣙ 正在启动 Agent RemoteOps，请稍候……");
      stop();
      expect(chunks.at(-1)).toBe("\r\u001B[2K");
    } finally {
      vi.useRealTimers();
    }
  });

  it("highlights the ready banner and connection values when color is enabled", () => {
    const output = renderSessionReady({
      url: "https://example.trycloudflare.com",
      token: "arops_example",
      expiresAt: new Date("2026-08-19T11:00:00.000Z"),
      workingDirectory: "/srv/app",
      ttlMs: 30 * 60_000,
      mode: "readonly",
    }, "zh-CN", { color: true });

    expect(output).toContain("\u001B[1;92m✓ Agent RemoteOps 临时 Session 已启动\u001B[0m");
    expect(output).toContain("\u001B[96mhttps://example.trycloudflare.com\u001B[0m");
    expect(output).toContain("\u001B[93marops_example\u001B[0m");
  });

  it("renders the full startup summary in English", () => {
    const output = renderSessionReady({
      url: "https://example.trycloudflare.com",
      token: "arops_example",
      expiresAt: new Date("2026-08-19T11:00:00.000Z"),
      workingDirectory: "/srv/app",
      ttlMs: 30 * 60_000,
      mode: "readonly",
    }, "en");

    expect(formatDurationHuman(90 * 60_000, "en")).toBe("1 hour 30 minutes");
    expect(formatPermission("readonly", "en")).toBe("readonly (safe read-only)");
    expect(output).toContain("Agent RemoteOps temporary Session is ready");
    expect(output).toContain("The first Client ID authenticated with the Token");
    expect(output).toContain("Waiting for Agent requests");
    expect(output).not.toMatch(/[\u3400-\u9fff]/);
  });
});
