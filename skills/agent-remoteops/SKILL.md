---
name: agent-remoteops
description: Use Agent RemoteOps to diagnose a temporary remote Linux session through the local agent-remoteops CLI when the user supplies or has connected a RemoteOps session.
---

# Agent RemoteOps

Use the `agent-remoteops` CLI for temporary remote Linux diagnostics.

## Workflow

1. Run `agent-remoteops status --json` before any remote operation.
2. Inspect `mode`, `workspace`, `capabilities`, and `expiresAt`.
3. Start with small evidence-gathering commands and file reads.
4. Use `agent-remoteops exec '<command>'` for shell diagnostics.
5. Use `agent-remoteops read`, `list`, and `stat` for structured file access.
6. Before writing files or causing service/process changes, explain the intended change and get user approval.
7. Summarize remote commands, files changed, and validation performed.

## Safety

- Never read, print, or copy the locally stored Session Token.
- Never try to bypass readonly or readwrite policy denials.
- `workspace` limits the file API and initial command directory; it is not a shell sandbox.
- In full mode, commands inherit all permissions of the Linux user running the server.
- Prefer bounded commands such as `journalctl -n`, `tail -n`, and explicit timeouts.
- Do not start detached/background processes because the Session is temporary.
- Do not assume a timed-out or disconnected mutating request is safe to repeat. Query its Job ID first.
