<p align="center">
  <img src="./public/logo.png" alt="Agent RemoteOps Logo" width="160">
</p>

<h1 align="center">Agent RemoteOps</h1>

<p align="center">English | <a href="./README.zh-CN.md">简体中文</a></p>

<p align="center">Short-lived, auditable remote access for coding agents—without long-lived SSH credentials or a permanent administration service.</p>

> [!WARNING]
> Allowing an agent to run commands on a server is inherently risky. Use `readonly` whenever possible. `full` does not restrict commands and inherits the permissions of the Linux user running the service. Review the [permission modes and security boundaries](#permission-modes-and-security-boundaries) before using Agent RemoteOps on a production host.

## Demo

The workflow has three steps: start a temporary Session on the remote host, give its URL and Token to Codex along with your task, and monitor activity from the server console.

### 1. Start a temporary Session

Run `agent-remoteops start` on the remote Linux host, then choose the lifetime, permission mode, and initial working directory. Once ready, the console displays the temporary URL, Token, and Session scope.

<video src="./public/demo-start.mp4" controls muted playsinline width="100%"></video>

[Open the video directly](./public/demo-start.mp4)

### 2. Hand the task to Codex

Send the Session details and your task to Codex with the Agent RemoteOps Skill installed. Codex verifies the effective permissions and expiry before inspecting the server through the controlled command and file APIs.

<video src="./public/demo-codex.mp4" controls muted playsinline width="100%"></video>

[Open the video directly](./public/demo-codex.mp4)

### 3. Monitor the server console

Connections, Session checks, API requests, and remote commands appear in the server console as they happen, making the agent's work easy to follow and audit.

<video src="./public/demo-console.mp4" controls muted playsinline width="100%"></video>

[Open the video directly](./public/demo-console.mp4)

## Why Agent RemoteOps

Coding agents such as Codex and Claude Code are far more useful when they can inspect the environment where an application actually runs: processes, listening ports, systemd services, logs, deployed files, and health endpoints. Direct SSH access, however, is often impractical for hosts behind private networks, firewalls, or restrictive security groups—and permanent agent credentials are rarely a good tradeoff.

Agent RemoteOps creates a temporary, outbound-only path for these situations. It is designed around short-lived access, controlled execution, and visible activity, complementing SSH and bastion hosts when they are unavailable or inconvenient.

Each Session works as follows:

1. A local HTTP service listens only on `127.0.0.1` of the remote host.
2. Cloudflare Quick Tunnel provides a temporary public URL.
3. Protected requests require a random Session Token and the bound Client ID.
4. A TTL and either `readonly` or `full` mode define the Session scope.
5. Expiry or manual shutdown stops the service, Tunnel, jobs, and tracked child processes.

```text
Local coding agent
        │  Agent RemoteOps Skill
        ▼
Cloudflare Quick Tunnel
        │  Token + Client ID
        ▼
RemoteOps service on 127.0.0.1
        ├── controlled file access
        └── validated command jobs
```

The remote host only needs outbound HTTPS access. Quick Tunnel requires no inbound firewall rule, Cloudflare account, or fixed public hostname.

## What you can do

- Connect Codex to a remote Linux host without exposing SSH or opening an inbound firewall port.
- Use a capable coding agent to investigate service failures and security issues in the real runtime environment.
- Inspect services, processes, ports, logs, disks, Docker, Git, and application health endpoints.
- View and download remote files; with explicit authorization, upload files or run commands that make changes.
- Default to `readonly` mode to reduce the risk of accidental modification.
- Let the Session expire automatically or stop it at any time with `Ctrl+C`, while following all activity in the server console.

## Requirements

### Remote Linux host

- Linux x64 or arm64
- Node.js 22 or later
- Outbound HTTPS access to GitHub Releases and Cloudflare

### Local Codex

- A working Codex installation
- Network access to the generated `trycloudflare.com` URL

## Installation

### Install the CLI on the remote server

Install the CLI only on the Linux server you want to inspect:

```bash
npm install -g agent-remoteops
```

Verify the installation:

```bash
agent-remoteops --version
agent-remoteops --help
```

To update an existing installation:

```bash
npm update -g agent-remoteops
```

### Install the Skill in local Codex

Send the following prompt to Codex to install the project Skill:

```text
Install the Agent RemoteOps Skill from this GitHub directory:
https://github.com/wwenj/AgentRemoteOps/tree/master/skills/agent-remoteops
```

## Usage

On the remote Linux host, enter the directory you want to inspect and run `agent-remoteops start`. Give the displayed URL, Token, and your task to a coding agent with the [Agent RemoteOps Skill](https://github.com/wwenj/AgentRemoteOps/tree/master/skills/agent-remoteops) installed.

See the three demo videos above for the complete flow, from starting a Session to running a Codex task and monitoring the console. Press `Ctrl+C` when you are done.

## CLI reference

| Command | Purpose |
| --- | --- |
| `start` | Start a temporary Session |
| `connect <url>` | Connect to a Session manually |
| `status` | Show permissions, working directory, and expiry |
| `exec <command>` | Run a remote command |
| `list` / `stat` / `read` / `write` | Work with remote files |
| `jobs` / `cancel` | Inspect or cancel jobs |
| `disconnect` | Remove locally saved Session details |

## Permission modes and security boundaries

| Mode | Access | Recommendation |
| --- | --- | --- |
| `readonly` | Reads files available to the runtime user and allows only approved read-only commands | Use by default for inspection and diagnosis |
| `full` | Reads and writes files and runs arbitrary shell commands | Use only with explicit authorization |

- The initial working directory is not an access boundary. Both modes inherit the permissions of the Linux user running the service.
- `readonly` prevents writes and high-risk commands, but it does not prevent access to sensitive readable data.
- `full` does not restrict command content. Avoid running Agent RemoteOps as `root`.
- Treat the URL and Token as temporary credentials. Quick Tunnel is intended for short-lived tasks, not as a permanent production access path.

## License

[MIT](./LICENSE)
