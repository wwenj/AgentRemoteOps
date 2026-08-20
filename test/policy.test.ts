import { describe, expect, it } from "vitest";
import { describePolicy, evaluateCommand } from "../src/policy.js";

describe("readonly policy", () => {
  it("parses conditional sequences and pipelines", () => {
    const decision = evaluateCommand("readonly", "date -Is; ps aux | grep node && uptime || uname -a");
    expect(decision.allowed).toBe(true);
    expect(decision.sequence?.map((group) => group.operator)).toEqual([undefined, ";", "&&", "||"]);
    expect(decision.sequence?.[1]?.pipeline.map((command) => command.binary)).toEqual(["ps", "grep"]);
  });

  it.each([
    "hostnamectl status",
    "lscpu",
    "vmstat 1 5",
    "top -b -n 1 -w 180",
    "nproc",
    "pwdx 123",
    "lsblk",
    "blkid",
    "dmesg --level=err,warn",
    "ip address show",
    "rpm -q opencloudos-release",
    "systemctl --failed --no-pager",
    "systemctl cat app.service",
    "journalctl -u app -n 20",
    "docker ps --no-trunc",
    "git status --short",
    "find /etc -maxdepth 1 -type f",
    "cat /etc/os-release",
    "curl -I --max-time 5 http://127.0.0.1:80",
    "curl -X GET https://example.com/status",
  ])("allows readonly command: %s", (command) => {
    expect(evaluateCommand("readonly", command).allowed).toBe(true);
  });

  it.each([
    ["cat file > copy", "readonly-shell-operator"],
    ["cat $(whoami)", "readonly-command-substitution"],
    ["cat `whoami`", "readonly-command-substitution"],
    ["uptime &", "readonly-shell-operator"],
    ["(uptime)", "readonly-shell-operator"],
    ["/bin/cat file", "readonly-explicit-binary-path"],
    ["find . -delete", "find-mutating-action"],
    ["date 010100002026", "date-mutating-argument"],
    ["rg --pre sh pattern .", "rg-preprocessor"],
    ["ss --kill dst 127.0.0.1", "ss-kill"],
    ["sort -oresult.txt input.txt", "sort-output-option"],
    ["uniq input.txt 2", "uniq-output-file"],
    ["hostnamectl set-hostname changed", "hostnamectl-subcommand"],
    ["journalctl --update-catalog", "journalctl-mutating-action"],
    ["systemctl restart app", "systemctl-subcommand"],
    ["systemctl --failed restart app", "systemctl-subcommand"],
    ["rpm -i package.rpm", "rpm-mutating-operation"],
    ["dmesg --clear", "dmesg-mutating-option"],
    ["ip link set eth0 down", "ip-mutating-operation"],
    ["curl -X POST https://example.com", "curl-method"],
    ["curl -d value https://example.com", "curl-write-or-body-option"],
    ["curl -dvalue https://example.com", "curl-write-or-body-option"],
    ["curl -o result https://example.com", "curl-write-or-body-option"],
    ["curl -T file https://example.com", "curl-write-or-body-option"],
    ["curl --url=file:///etc/passwd https://example.com", "curl-http-url"],
    ["curl --max-time 31 https://example.com", "curl-timeout"],
    ["curl --retry 3 https://example.com", "curl-retry-option"],
    ["git -c alias.status='!sh' status", "git-external-or-output-option"],
    ["git diff --output=result.patch", "git-external-or-output-option"],
    ["git branch -Dmain", "git-branch-write"],
    ["git reset status", "git-subcommand"],
    ["python3 -c 'print(1)'", "readonly-command:python3"],
  ])("rejects %s", (command, rule) => {
    expect(evaluateCommand("readonly", command)).toMatchObject({ allowed: false, rule });
  });

  it("rejects the whole sequence when any child is unsafe", () => {
    const decision = evaluateCommand("readonly", "echo safe; systemctl restart app; uptime");
    expect(decision).toMatchObject({ allowed: false, rule: "systemctl-subcommand" });
    expect(decision.sequence).toBeUndefined();
  });

  it("does not treat command-substitution text inside single quotes as syntax", () => {
    expect(evaluateCommand("readonly", "echo '`literal` $(literal)'").allowed).toBe(true);
  });
});

describe("full policy", () => {
  it("does not filter command content", () => {
    expect(evaluateCommand("full", "printf hello > /tmp/example && rm /tmp/example").allowed).toBe(true);
  });
});

describe("localized policy description", () => {
  it("documents the English security boundaries", () => {
    const readonly = describePolicy("readonly", "en").join("\n");
    const full = describePolicy("full", "en").join("\n");
    expect(readonly).toContain("not information confidentiality");
    expect(full).toContain("not a security boundary");
    expect(`${readonly}\n${full}`).not.toMatch(/[\u3400-\u9fff]/);
  });
});
