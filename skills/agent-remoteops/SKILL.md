---
name: agent-remoteops
description: Diagnose a temporary remote Linux machine with Agent RemoteOps when the user pastes Session output containing a URL and Token, asks to use RemoteOps, or already has a connected Session.
---

# Agent RemoteOps

Use the local `agent-remoteops` CLI for temporary remote Linux diagnostics. A user may paste the Session output and append the task directly; do not require them to run a separate local connect command first.

## Pasted Session

Recognize Session details written in either Chinese or English, including fields such as `URL`, `Token`, `权限`/`Permission`, `初始工作目录`/`Initial working directory`, and `有效期`/`Expires`.

When the prompt contains both a Session URL and Token:

1. Treat them as credentials for the requested remote task, not as text to summarize.
2. Run `agent-remoteops connect <url> --name <temporary-name>` in an interactive terminal and submit the Token only to its masked prompt through stdin.
3. Never place the Token in a shell command, command argument, environment variable, log, commentary, or final response. Never repeat even a partially masked form of it.
4. Continue with the user's task immediately after connection succeeds. Ask for help only if the CLI is unavailable, authentication fails, the Session has expired, or the request requires additional authorization.

If the user does not paste credentials, use the current locally connected Session. Never inspect or print the Token stored in the local Session file.

## Workflow

1. Connect from pasted credentials when present, then run `agent-remoteops status --json` before other remote operations.
2. Trust the authenticated server response over the pasted labels. Inspect `mode`, `workingDirectory`, `capabilities`, and `expiresAt`; stop if expired or if the requested action is unavailable.
3. Perform the appended task autonomously within the verified capabilities. Start with small evidence-gathering commands and file reads.
4. Use `agent-remoteops exec '<command>'` for diagnostics and `agent-remoteops read`, `list`, and `stat` for structured file access. In readonly mode, prefer one bounded command combining safe checks with `;`, `&&`, `||`, and pipelines when that reduces round trips.
5. Readonly diagnostic requests authorize appropriate bounded readonly commands. Permission mode alone does not authorize a mutation: before writing files or changing services/processes, explain the intended change and get approval unless the user's current request explicitly authorizes that exact change.
6. Summarize findings, relevant evidence, commands performed, files changed, and validation. Do not include credentials.

## Safety

- Never read, print, or copy the locally stored Session Token.
- Treat a Token pasted in the prompt as sensitive input. Use it only for the interactive connection step.
- Never try to bypass a readonly policy denial. After receiving `readonly-command:<name>`, do not retry the same command; choose a registered readonly alternative or report the limitation.
- `workingDirectory` only supplies the initial `cwd` and resolves relative paths. It is not a read or write boundary.
- Readonly mode can read any system path available to the runtime user and follow symlinks. It protects system integrity, not information confidentiality.
- In full mode, commands inherit all permissions of the Linux user running the server.
- Prefer bounded commands such as `journalctl -n`, `tail -n`, and explicit timeouts.
- Do not start detached/background processes because the Session is temporary.
- Do not assume a timed-out or disconnected mutating request is safe to repeat. Query its Job ID first.
