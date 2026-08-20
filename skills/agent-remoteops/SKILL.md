---
name: agent-remoteops
description: Diagnose a temporary remote Linux machine through Agent RemoteOps when the user provides a Session URL and Token, asks to use RemoteOps, or already has a connected Session. Uses the Skill-bundled client; no local agent-remoteops CLI is required.
---

# Agent RemoteOps

Use `scripts/remoteops.py` from this Skill directory. Never invoke or install a local `agent-remoteops` npm CLI.

## Connect

When the user provides a Session URL and Token, treat them as credentials for the appended task:

1. Start `python3 <skill-directory>/scripts/remoteops.py connect <url>` in an interactive TTY.
2. Submit the Token only to the masked prompt through stdin. Never put it in command arguments, environment variables, logs, commentary, or the final response.
3. Run `python3 <skill-directory>/scripts/remoteops.py status` and trust its authenticated `mode`, `workingDirectory`, `capabilities`, and `expiresAt` over pasted labels.
4. Continue the requested task immediately when the verified capabilities allow it.

Without pasted credentials, use the current temporary Session. Never inspect or print the Skill's local Session files.

## Operate

- Use the bundled script's `exec`, `jobs`, `cancel`, `list`, `stat`, `read`, and `write` commands.
- Prefer structured file commands for file operations. Use bounded diagnostics and explicit timeouts.
- A readonly diagnostic request authorizes appropriate bounded readonly checks. Do not retry a policy denial; choose an allowed alternative or report the limitation.
- `full` is a server capability, not user authorization. Before changing files, services, or processes, obtain approval unless the current request explicitly authorizes that exact mutation.
- `workingDirectory` resolves relative paths but is not a security boundary. Readonly protects integrity, not confidentiality; full inherits the remote Linux user's permissions.
- Do not start detached processes. Do not repeat a timed-out mutation without first checking its Job state.

Report findings, evidence, remote commands, changed files, and validation without including credentials. Run `disconnect` after the task to remove local temporary state; this does not stop the remote Session.
