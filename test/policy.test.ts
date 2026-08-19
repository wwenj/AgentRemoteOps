import { describe, expect, it } from "vitest";
import { evaluateCommand } from "../src/policy.js";

describe("readonly policy", () => {
  it("allows diagnostic commands and safe pipelines", () => {
    expect(evaluateCommand("readonly", "ps aux | grep node").allowed).toBe(true);
    expect(evaluateCommand("readonly", "journalctl -u app -n 20").allowed).toBe(true);
    expect(evaluateCommand("readonly", "systemctl status app").allowed).toBe(true);
  });

  it("rejects writes and shell operators", () => {
    expect(evaluateCommand("readonly", "cat file > copy").rule).toBe("readonly-shell-operator");
    expect(evaluateCommand("readonly", "echo test").rule).toBe("readonly-command:echo");
    expect(evaluateCommand("readonly", "find . -delete").rule).toBe("find-mutating-action");
    expect(evaluateCommand("readonly", "systemctl restart app").rule).toBe("systemctl-subcommand");
    expect(evaluateCommand("readonly", "cat $(whoami)").allowed).toBe(false);
    expect(evaluateCommand("readonly", "/bin/cat file").rule).toBe("readonly-explicit-binary-path");
    expect(evaluateCommand("readonly", "cat /etc/passwd").rule).toBe("readonly-path-outside-workspace");
  });
});

describe("readwrite policy", () => {
  it("allows ordinary file editing commands", () => {
    expect(evaluateCommand("readwrite", "printf hello > file.txt").allowed).toBe(true);
    expect(evaluateCommand("readwrite", "cp a b && mv b c").allowed).toBe(true);
  });

  it.each([
    ["rm -rf build", "filesystem-destroy"],
    ["/bin/rm file", "filesystem-destroy"],
    ["systemctl restart app", "service-management"],
    ["docker rm app", "container-destructive"],
    ["git reset --hard HEAD", "git-destructive"],
    ["python3 -c 'import os'", "interpreter-bypass"],
    ["echo $(whoami)", "shell-command-substitution"],
  ])("rejects %s", (command, rule) => {
    expect(evaluateCommand("readwrite", command).rule).toBe(rule);
  });
});

describe("full policy", () => {
  it("does not filter command content", () => {
    expect(evaluateCommand("full", "rm -rf /tmp/example").allowed).toBe(true);
  });
});
