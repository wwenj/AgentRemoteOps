# Agent RemoteOps

English | [简体中文](./README.zh-CN.md)

Agent RemoteOps is a short-lived, auditable remote-operations bridge for coding agents. It lets a local Codex, Claude Code, or another agent diagnose a real Linux host without distributing permanent SSH credentials or exposing a long-lived management service.

Current source version: `0.2.0`.

> [!WARNING]
> Agent RemoteOps is still in early development. `readonly` protects system integrity, not information confidentiality. `full` is unrestricted at the CLI layer and inherits the permissions of the Linux user that starts the server. Read the [security boundaries](#permission-modes-and-security-boundaries) before using it on a production host.

## Why Agent RemoteOps

Coding agents are substantially more useful when they can inspect the real runtime environment: processes, listeners, systemd state, logs, deployed files, and application health endpoints. Production and staging hosts, however, should not receive permanent agent credentials or expose a permanent administration API.

Agent RemoteOps provides a temporary alternative:

1. It starts an HTTP service bound only to `127.0.0.1` on the remote host.
2. It exposes that service through a temporary Cloudflare Quick Tunnel.
3. Every protected request requires a random Session Token and the bound Client ID.
4. The Session is constrained by a TTL and either `readonly` or `full` mode.
5. Expiration or shutdown closes the HTTP service and Tunnel and terminates tracked jobs and child processes.

```text
Local coding agent
        │  agent-remoteops CLI
        ▼
Cloudflare Quick Tunnel
        │  Token + Client ID
        ▼
127.0.0.1-only RemoteOps server
        ├── structured file API
        └── validated command jobs
```

The remote host needs outbound HTTPS access only. A Quick Tunnel does not require an inbound firewall rule, a Cloudflare account, or a fixed public hostname.

## Capabilities

- Interactive Chinese or English setup for lifetime, permission mode, initial working directory, and audit logging
- Structured file operations: `list`, `stat`, `read`, and atomic `write`
- Remote command jobs with streamed output, timeout, status, cancellation, and output truncation reporting
- A parameter-validated readonly command allowlist, including bounded system, process, network, log, Docker, Git, and HTTP inspection
- An explicit unrestricted mode for approved administrative work
- Random expiring bearer token stored locally with `0600` permissions
- Exclusive binding to the first authenticated Client ID, without binding the Session to a changing client IP
- Per-IP authentication failure rate limiting and optional local JSONL audit logs
- Optional Codex Skill that handles pasted Session details and applies a consistent safety workflow
- Automatic, SHA-256-verified download of the pinned `cloudflared` binary on supported Linux hosts

## Requirements

### Remote Linux host

- Linux x64 or arm64
- Node.js 22 or later
- Outbound HTTPS access to GitHub Releases and Cloudflare

### Local machine

- Node.js 22 or later
- Network access to the generated `trycloudflare.com` URL

The CLI must currently be installed from source on both machines.

## Installation

```bash
git clone https://github.com/wwenj/AgentRemoteOps.git
cd AgentRemoteOps
corepack enable
pnpm install --frozen-lockfile
pnpm build
npm install -g .
```

Verify that the active global installation matches the source tree:

```bash
agent-remoteops --version
agent-remoteops --help
```

When updating an existing installation, rebuild before reinstalling it:

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
npm install -g .
```

## Quick start with a coding agent

### 1. Start a temporary Session on the remote host

```bash
cd /path/to/your/initial-directory
agent-remoteops start
```

The wizard asks for:

- Chinese or English interface language;
- a lifetime between 5 minutes and 8 hours;
- `readonly` or `full` permission mode;
- the Agent's initial working directory, defaulting to the current directory;
- whether to keep a local audit log.

The server displays its URL, Token, verified permission mode, initial working directory, and expiry. Keep this process in the foreground. Press `Ctrl+C` to end the Session early; otherwise it closes automatically when the TTL expires.

### 2. Hand the Session directly to the agent

Install the bundled Codex Skill once on the local machine:

```bash
agent-remoteops skill install codex
```

Use `--force` when replacing an existing installation:

```bash
agent-remoteops skill install codex --force
```

Then paste the generated Session block and the task in the same message:

```text
URL          https://example.trycloudflare.com
Token        <temporary-session-token>
Permission   readonly
Initial cwd  /srv/app
Lifetime     30 minutes

Check server health, deployed services, listeners, and recent errors. Do not make changes.
```

The Skill instructs the agent to connect through the masked token prompt, verify the authenticated Session with `status --json`, and continue with the requested task.

> [!IMPORTANT]
> Treat both the URL and Token as temporary credentials. The first successful connection binds the Session to that local Client ID. Do not connect from another client before handing the Session to the intended agent, or the agent will receive `CLIENT_ID_NOT_ALLOWED`.

### 3. Connect manually instead

```bash
agent-remoteops connect https://example.trycloudflare.com --name production-check
```

Enter the Token at the masked prompt. The Session becomes the current local Session for subsequent commands.

For trusted non-interactive automation, the client also accepts `AGENT_REMOTEOPS_TOKEN`. Supply it through a secret manager; do not place it in command arguments, shell history, logs, or documentation.

## Common workflow

```bash
# Verify server-reported scope before doing anything else
agent-remoteops status --json

# Run a bounded readonly diagnostic
agent-remoteops exec 'journalctl -u app -n 100 --no-pager' --timeout 30000

# Current readonly builds support prevalidated sequences and pipelines
agent-remoteops exec 'uptime; ps aux | grep node'

# Use the structured file API when possible
agent-remoteops list /srv/app --json
agent-remoteops stat /srv/app/package.json --json
agent-remoteops read /srv/app/package.json
agent-remoteops read /var/log/app.log --out ./app.log

# Download the current file to obtain its SHA-256, then upload with
# optimistic concurrency in full mode
agent-remoteops read /srv/app/config.json --out ./config.remote.json
agent-remoteops write ./config.json /srv/app/config.json --if-match <remote-sha256>

# Inspect or cancel jobs
agent-remoteops jobs --json
agent-remoteops cancel <job-id>

# Remove the current saved local Session
agent-remoteops disconnect
```

## CLI reference

| Command | Purpose |
| --- | --- |
| `start` | Interactively start the remote server and temporary Tunnel |
| `connect <url> [--name <name>]` | Authenticate and save a local Session |
| `status [--json]` | Read server version, mode, capabilities, working directory, and expiry |
| `exec <command> [--timeout <ms>] [--json]` | Create a job and stream its output until completion |
| `jobs [--json]` | List jobs retained by the current Session |
| `cancel <job-id>` | Cancel a queued or running job |
| `list <path> [--json]` | List a remote directory through the structured API |
| `stat <path> [--json]` | Read remote file metadata |
| `read <remote-path> [--out <file>]` | Print or download a remote file |
| `write <local-file> <remote-path> [--if-match <sha256>]` | Atomically upload a file in `full` mode |
| `policy show <readonly\|full>` | Show the installed CLI's permission summary |
| `skill install codex [--force]` | Install the bundled Codex Skill |
| `disconnect [name]` | Remove a saved local Session |

`--json` is supported by `status`, `exec`, `jobs`, `list`, and `stat`.

## Permission modes and security boundaries

| Mode | File API | Commands | Intended use |
| --- | --- | --- | --- |
| `readonly` | Read any path accessible to the runtime user; writes denied | Parameter-validated allowlist; commands run without a Shell; prevalidated `;`, `&&`, `||`, and pipelines are supported | Inspection and incident diagnosis |
| `full` | Read and write any path accessible to the runtime user | No content restrictions; commands run through `/bin/bash -lc` | Explicitly approved administration |

### Readonly behavior

`readonly` permits selected inspection commands and validates their arguments. Examples include `systemctl status`, bounded `journalctl`, `ps`, `ss`, `df`, `git status`, `docker ps`, and HTTP `GET`/`HEAD` requests with `curl`.

It rejects, among other things:

- commands outside the allowlist;
- file redirection, background execution, command substitution, and subshells;
- mutating `systemctl`, Docker, Git, `find`, network, and package-manager operations;
- `curl` uploads, request bodies, output files, non-HTTP(S) URLs, and non-GET/HEAD methods;
- explicit binary paths that could bypass the controlled readonly `PATH`.

The whole sequence is validated before any child command starts. A rejected child prevents the entire sequence from running.

### Important boundaries

- `workingDirectory` is only the initial `cwd` and the base for relative paths. It is not a read or write boundary.
- `readonly` can read any file available to the Linux user and follows symlinks. It protects integrity, not confidentiality.
- `full` inherits every permission of the Linux user that starts Agent RemoteOps. Avoid starting it as `root` unless strictly necessary.
- Quick Tunnel URLs are public endpoints. Protected routes require the Token and bound Client ID; `/healthz` is intentionally unauthenticated and returns only basic liveness.
- Authentication is rate-limited per observed client IP, but the Token remains the primary credential.
- Normal shutdown terminates tracked jobs and child processes. `SIGKILL`, host failure, and persistent effects already created by commands cannot be rolled back.
- Quick Tunnels have no availability guarantee and are not suitable for permanent administration or production traffic.

## Operational limits

| Limit | Value |
| --- | --- |
| Session lifetime | 5 minutes to 8 hours |
| Job timeout | 1 second to 10 minutes; CLI default 60 seconds |
| Captured output per job | 4 MiB; additional output is marked truncated |
| Structured file read/write | 10 MiB per file |
| Job concurrency | One active job, up to eight queued jobs |
| API request body | 16 MiB |

Local Sessions are stored under `${XDG_CONFIG_HOME:-~/.config}/agent-remoteops/sessions.json` with mode `0600`. Audit logs are written under `${XDG_STATE_HOME:-~/.local/state}/agent-remoteops/audit/` when enabled. Do not print or copy the stored Token.

## Troubleshooting

### Verify the authenticated server first

```bash
agent-remoteops status --json
```

Trust the returned `version`, `mode`, `capabilities`, `workingDirectory`, and `expiresAt` rather than a copied label or an old local assumption.

### `CLIENT_ID_NOT_ALLOWED`

Another Client ID authenticated first. Continue from the originally connected client or stop the remote process and create a new Session. Reusing the Token from a different local installation will not rebind an active Session.

### `readonly-command:<name>` or another policy denial

Do not retry the same prohibited operation. Use an allowed readonly alternative, the structured file API, or start a new `full` Session only when the user has explicitly authorized the required mutation.

### A current readonly sequence is rejected as `readonly-shell-operator`

Redirection, `&`, command substitution, and subshells are intentionally rejected. The current source does support `;`, `&&`, `||`, and pipelines. If those are also rejected, the running global installation was likely built from older or stale output even if `package.json` already reports `0.2.0`. Split the diagnostic into individual commands, then rebuild and reinstall the server and local CLI from the same commit.

### Tunnel startup fails

Confirm that the remote host can reach GitHub Releases and Cloudflare over HTTPS. The server downloads a pinned `cloudflared` binary, verifies its SHA-256 digest, caches it under `${XDG_CACHE_HOME:-~/.cache}/agent-remoteops/cloudflared/`, and waits for `/healthz` before showing the Session as ready.

For local development without Cloudflare:

```bash
AGENT_REMOTEOPS_TUNNEL=none pnpm dev start
```

## Local development

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs TypeScript checking, the Vitest suite, and a production build.

## License

[MIT](./LICENSE)
