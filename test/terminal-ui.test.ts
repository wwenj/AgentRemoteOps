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
    expect(formatPermission("readwrite")).toBe("readwrite（读写受控）");
  });

  it("renders the configuration as single-line label-value rows", () => {
    const output = renderConfiguration({
      workspace: "/srv/app",
      ttlMs: 30 * 60_000,
      mode: "readonly",
      policy: ["文件 API：stat、list、read"],
      linuxUser: "app",
      audit: "已关闭",
      tunnel: "Cloudflare Quick Tunnel",
    });

    expect(output).toContain("工作目录  /srv/app");
    expect(output).toContain("有效期    30 分钟");
    expect(output).toContain("权限模式  readonly（只读）");
    expect(output).toContain("  • 文件 API：stat、list、read");
  });

  it("renders copy guidance, expiry, cleanup, and live-log hints", () => {
    const output = renderSessionReady({
      url: "https://example.trycloudflare.com",
      token: "arops_example",
      expiresAt: new Date("2026-08-19T11:00:00.000Z"),
      workspace: "/srv/app",
      ttlMs: 30 * 60_000,
      mode: "readonly",
    });

    expect(output).toContain("URL       https://example.trycloudflare.com");
    expect(output).toContain("Token     arops_example");
    expect(output).toContain("复制以上 URL 和 Token");
    expect(output).toContain("Codex");
    expect(output).toContain("Claude Code");
    expect(output).toContain("会话将在 30 分钟后自动到期");
    expect(output).toContain("日志会在下方实时输出");
  });
});
