# Agent RemoteOps

English | [简体中文](./README.zh-CN.md)

Agent RemoteOps is a temporary, auditable remote operations bridge designed for coding agents. It lets an agent on your local machine inspect and operate a remote Linux workspace without requiring a permanently exposed management service.

> [!WARNING]
> Agent RemoteOps is in early development. The `readwrite` denylist reduces accidental damage, but it is not an operating-system security sandbox. Review the [security boundaries](#permission-modes-and-security-boundaries) before using it on a production host.

## Background

Coding agents are most useful when they can inspect the real runtime environment, but production and staging hosts are often inaccessible from a developer's local machine. Giving an agent a permanent SSH credential or exposing a long-lived administration endpoint creates unnecessary risk.

Agent RemoteOps provides a short-lived alternative:

1. Start a loopback-only HTTP service on the remote Linux host.
2. Expose it through a temporary Cloudflare Quick Tunnel.
3. Authenticate every operation with a randomly generated session token.
4. Restrict the session by workspace, lifetime, and permission mode.
5. Stop the service, tunnel, jobs, and tracked child processes when the session expires or is closed.

The remote host only needs outbound network access; no inbound firewall rule or Cloudflare account is required for a Quick Tunnel.

## Features

- Interactive setup for workspace, session TTL, permission mode, and audit logging
- Structured file operations: list, stat, read, and controlled write
- Remote command execution with job status, output streaming, timeout, and cancellation
- Three permission modes for diagnostics, controlled changes, or unrestricted operation
- Expiring bearer token stored locally with `0600` permissions
- Optional Codex Skill for a consistent remote-operations workflow
- Automatic cleanup on normal shutdown, signal handling, or TTL expiration

## Requirements

### Remote host

- Linux x64 or arm64
- Node.js 22 or later
- Outbound HTTPS access to GitHub Releases and Cloudflare

### Local machine

- Node.js 22 or later
- Network access to the generated `trycloudflare.com` URL

## Installation

Agent RemoteOps is currently intended to be built from source. Install it on both the remote host and the local machine:

```bash
git clone https://github.com/wwenj/AgentRemoteOps.git
cd AgentRemoteOps
corepack enable
pnpm install --frozen-lockfile
pnpm build
npm install -g .
```

Verify the installation:

```bash
agent-remoteops --help
```

## Usage

### 1. Start a temporary session on the remote host

```bash
cd /path/to/your/workspace
agent-remoteops start
```

The interactive wizard asks you to confirm:

- the workspace exposed through the structured file API;
- a session lifetime from 5 minutes to 8 hours;
- the `readonly`, `readwrite`, or `full` permission mode;
- whether local audit logging is enabled.

The wizard keeps each prompt visually separated and shows a configuration summary before the final confirmation. After startup, the URL, token, permission, workspace, and expiry are displayed as compact single-line fields together with agent handoff, security, live-log, and cleanup guidance.

Copy the generated URL and token to Codex, Claude Code, or another coding agent with the Agent RemoteOps Skill installed. Keep the server process in the foreground. Subsequent file and command logs appear below the connection details. Press `Ctrl+C` to close the session early; otherwise it closes and cleans up temporary resources automatically when the TTL expires.

### 2. Connect from the local machine

```bash
agent-remoteops connect https://example.trycloudflare.com
```

Enter the token at the prompt. The session is saved locally and reused by subsequent commands. For non-interactive environments, provide it through `AGENT_REMOTEOPS_TOKEN`.

### 3. Inspect and operate the remote workspace

```bash
# Inspect session scope and capabilities
agent-remoteops status

# Run a bounded diagnostic command
agent-remoteops exec 'journalctl -u app -n 200 --no-pager'

# Work with files through the structured API
agent-remoteops list .
agent-remoteops stat package.json
agent-remoteops read package.json
agent-remoteops read logs/app.log --out app.log

# Upload a local file when the session permits writes
agent-remoteops write ./config.json config/config.json

# Inspect or cancel remote jobs
agent-remoteops jobs
agent-remoteops cancel <job-id>

# Remove the saved local session
agent-remoteops disconnect
```

Use `--json` with `status`, `exec`, `jobs`, `list`, and `stat` when integrating with an agent or script.

### 4. Install the Codex Skill (optional)

```bash
agent-remoteops skill install codex
```

Use `--force` to replace an existing installation:

```bash
agent-remoteops skill install codex --force
```

## Permission modes and security boundaries

| Mode | File API | Commands | Intended use |
| --- | --- | --- | --- |
| `readonly` | `stat`, `list`, `read` | Diagnostic allowlist; no shell redirection, substitution, or compound operations | Inspection and incident diagnosis |
| `readwrite` | Read and write | General shell with built-in high-risk command blocking | Controlled repair and configuration changes |
| `full` | Read and write | No content restrictions | Explicitly approved administration |

Important boundaries:

- The workspace confines the structured file API, but it is only the initial working directory for general shell commands.
- `readwrite` rules are accident-prevention guardrails, not a sandbox or privilege boundary.
- `full` inherits every permission of the Linux user that starts Agent RemoteOps. Avoid running as `root` unless it is strictly necessary.
- Quick Tunnel URLs are public endpoints protected by the session token. Treat both the URL and token as sensitive and keep the TTL short.
- Normal shutdown attempts to terminate tracked jobs and child processes. `SIGKILL`, host failure, and persistent side effects created by commands cannot be rolled back automatically.

## Local development

```bash
pnpm install --frozen-lockfile
pnpm check
```

Run the service locally without Cloudflare:

```bash
AGENT_REMOTEOPS_TUNNEL=none pnpm dev start
```

## License

[MIT](./LICENSE)
