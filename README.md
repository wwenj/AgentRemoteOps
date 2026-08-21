<p align="center">
  <img src="https://raw.githubusercontent.com/wwenj/AgentRemoteOps/master/public/logo.png" alt="Agent RemoteOps Logo" width="160">
</p>

<h1 align="center">Agent RemoteOps</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/agent-remoteops"><img src="https://img.shields.io/npm/v/agent-remoteops?logo=npm&label=npm" alt="npm version"></a>
  <a href="https://github.com/wwenj/AgentRemoteOps"><img src="https://img.shields.io/github/languages/top/wwenj/AgentRemoteOps?logo=typescript&label=TypeScript" alt="TypeScript"></a>
  <a href="#requirements"><img src="https://img.shields.io/badge/platform-Linux-FCC624?logo=linux&logoColor=black" alt="Linux platform"></a>
</p>

<p align="center">English | <a href="./README.zh-CN.md">简体中文</a></p>

<p align="center">Give Codex temporary, controlled access to a remote Linux host for diagnostics and maintenance, with scoped permissions, expiring Sessions, and auditable execution.</p>

> [!WARNING]
> Remote commands executed by an agent are risky. Prefer `readonly`. The `full` mode inherits the permissions of the Linux user that starts the server. Understand the security boundaries below before using it on important systems.

## Why Agent RemoteOps

Most developers are now accustomed to using powerful agent tools such as Claude Code and Codex in their daily work. However, these local agents depend on the environment in which they run, making it difficult for them to assist with production deployments, take over a Linux server, or troubleshoot a live service on short notice.

Private networks, closed ports, host firewalls, and inbound and outbound security-group rules can make both installing an agent on a remote server and connecting a local agent over SSH unnecessarily cumbersome.

Agent RemoteOps was built to solve this problem. It consists of the [Agent-Remoteops](https://www.npmjs.com/package/agent-remoteops) npm package installed on the remote host and a Skill installed in local Codex. The remote service starts quickly and **requires no changes to the existing network configuration or firewall. As long as the host has outbound internet access, it can create a temporary externally accessible URL.** Codex then uses the Skill to establish a temporary connection to the service for fast remote diagnostics and maintenance.

Agent RemoteOps starts a temporary service on the remote Linux host that listens only on `127.0.0.1`, then exposes it through a short-lived Cloudflare Quick Tunnel URL. Give the URL, Token, and task to Codex, and Codex can read files or run commands within the Session's permission scope. When the Session expires or the user presses `Ctrl+C`, the HTTP server, Tunnel, Jobs, and tracked child processes are all shut down.

```text
Local Codex
  `- Agent RemoteOps Skill
       `- bundled Python client
              | HTTPS + Token
              v
       Cloudflare Quick Tunnel
              v
Remote Linux
  `- agent-remoteops CLI
       |- file API
       |- command Jobs
       `- policy, TTL, audit, and process cleanup
```

## Demo

### 1. Start a Session on remote Linux

![Start a Session on remote Linux](./public/demo-start.gif)

### 2. Give the Session and task directly to Codex

![Give the Session and task directly to Codex](./public/demo-codex.gif)

### 3. Watch the remote console in real time

The remote console shows the Agent's connection, authentication, requests, and command Job logs in real time for execution tracking and auditing.

![Remote console logs in real time](./public/demo-console.gif)

## Requirements

### Remote Linux

- Linux x64 or arm64
- Node.js 22 or later
- Outbound HTTPS access to npm and Cloudflare
- GitHub Releases is needed on first start only when the npm registry did not provide the platform binary package and automatic repair is required

### Local Codex

- Codex with the Agent RemoteOps Skill installed
- macOS or Linux
- Python 3.10 or later
- Network access to the generated `trycloudflare.com` URL

## Installation

### Remote Linux: install the CLI

```bash
npm install -g agent-remoteops
agent-remoteops --version
```

The matching `cloudflared` binary is installed automatically as a platform-specific optional npm dependency. No RPM or manual binary installation is required. Each x64/arm64 host downloads only one compressed package of approximately 18 MiB.

If an npm mirror skips the platform package, `agent-remoteops start` repairs it internally with visible progress, resumable downloads, up to three attempts, and a 180-second total download budget. The binary is never executed until its pinned SHA-256 digest has been verified.

The CLI starts and manages remote Sessions:

| Command                                | Purpose                                  |
| -------------------------------------- | ---------------------------------------- |
| `agent-remoteops start`                | Interactively create a temporary Session |
| `agent-remoteops policy show readonly` | Show the readonly policy summary         |
| `agent-remoteops policy show full`     | Show the full policy summary             |

### Local Codex: install the Skill

Ask Codex to install this GitHub directory:

```text
Install the Agent RemoteOps Skill from:
https://github.com/wwenj/AgentRemoteOps/tree/master/skills/agent-remoteops
```

## Quick start

1. On remote Linux, enter the desired initial directory and run:

   ```bash
   cd /srv/app
   agent-remoteops start
   ```

2. In the CLI, select the language, Session lifetime, permission level, working directory, and audit-log settings. Confirm the configuration and wait for the Session to become ready.

3. Send the URL and Token displayed in the console, together with a concrete task, to Codex with the Skill installed.

4. Codex securely submits the Token through the Skill's bundled client, verifies the actual permissions reported by the server, and then performs the task. The connection is established automatically, with no manual setup required from the user.

5. Each CLI Session accepts a connection from only one client, preventing other unauthorized clients from connecting.

6. When finished, press `Ctrl+C` in the remote terminal, or let the Session expire automatically.

7. All execution logs are stored locally on the remote service for later inspection and troubleshooting.

## Permission and security boundaries

| Mode       | File access                                          | Command access                                                              | Intended use                 |
| ---------- | ---------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------- |
| `readonly` | Reads paths available to the runtime user; no writes | Argument-level allowlist without a shell; validated sequences and pipelines | Default diagnostics          |
| `full`     | Reads and writes paths available to the runtime user | Unrestricted `/bin/bash -lc` commands                                       | Explicitly authorized repair |

- `workingDirectory` is only the relative-path base and initial cwd, not an access boundary.
- `readonly` protects integrity, not confidentiality. It can still read sensitive files available to the runtime user.
- `full` is a server capability, not authorization for a particular mutation.
- The Token is never passed through command arguments or environment variables. It is entered through a masked TTY prompt and stored only in an expiring `0600` temporary state file.
- Quick Tunnel has no SLA and is not suitable for persistent administration or production traffic.
- Normal shutdown cleans tracked processes but cannot roll back persistent side effects or guarantee cleanup after SIGKILL or host failure.

## License

[MIT](./LICENSE)

The `cloudflared` platform packages are redistributed under Apache-2.0. See [Third-party notices](./THIRD_PARTY_NOTICES.md).
