import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tsx = path.resolve("node_modules/.bin/tsx");
const entry = path.resolve("src/index.ts");

describe("remote-only CLI", () => {
  it("exposes only server commands", () => {
    const result = spawnSync(tsx, [entry, "--help"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("start");
    expect(result.stdout).toContain("policy");
    for (const legacy of ["connect", "status", "exec", "jobs", "cancel", "list", "stat", "read", "write", "disconnect"]) {
      expect(result.stdout).not.toMatch(new RegExp(`^\\s+${legacy}(?:\\s|$)`, "m"));
    }
  });

  it("rejects legacy client commands", () => {
    const result = spawnSync(tsx, [entry, "connect", "https://example.invalid"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown command 'connect'");
  });
});
