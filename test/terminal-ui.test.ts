import { describe, expect, it } from "vitest";
import {
  formatDurationHuman,
  formatPermission,
  renderConfiguration,
  renderSessionReady,
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
    expect(output).toContain("复制以上 URL 和 Token");
    expect(output).toContain("Codex");
    expect(output).toContain("Claude Code");
    expect(output).toContain("Client ID 将成为本次 Session 唯一客户端");
    expect(output).toContain("不构成权限边界");
    expect(output).toContain("Session 将在 30 分钟后自动到期");
    expect(output).toContain("日志会在下方实时输出");
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
