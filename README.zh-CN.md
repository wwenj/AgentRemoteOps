# Agent RemoteOps

[English](./README.md) | 简体中文

Agent RemoteOps 是一个面向 Coding Agent 的短时、可审计远程运维桥接工具。它允许本地 Codex、Claude Code 或其他 Agent 诊断真实 Linux 主机，无需分发长期 SSH 凭证，也不需要暴露常驻管理服务。

当前源码版本：`0.2.0`。

> [!WARNING]
> Agent RemoteOps 仍处于早期开发阶段。`readonly` 保护系统完整性，但不保护信息机密性；`full` 在 CLI 层不做限制，并继承启动服务的 Linux 用户权限。在生产主机上使用前，请先了解[权限模式与安全边界](#权限模式与安全边界)。

## 为什么需要 Agent RemoteOps

Coding Agent 只有接触真实运行环境，才能有效检查进程、监听端口、systemd 状态、日志、部署文件和应用健康接口。但生产、测试服务器不应该获得长期 Agent 凭证，也不应该暴露常驻管理 API。

Agent RemoteOps 提供了一种短时替代方案：

1. 在远程主机启动仅监听 `127.0.0.1` 的 HTTP 服务；
2. 通过 Cloudflare Quick Tunnel 建立临时外部访问地址；
3. 所有受保护请求都必须携带随机 Session Token 和已绑定的 Client ID；
4. Session 受 TTL 和 `readonly`/`full` 权限模式约束；
5. Session 到期或主动关闭时，停止 HTTP 服务、Tunnel、Job 和已跟踪的子进程。

```text
本地 Coding Agent
        │  agent-remoteops CLI
        ▼
Cloudflare Quick Tunnel
        │  Token + Client ID
        ▼
仅监听 127.0.0.1 的 RemoteOps 服务
        ├── 结构化文件 API
        └── 经过校验的命令 Job
```

远程主机只需要具备出站 HTTPS 能力。Quick Tunnel 不要求开放入站防火墙端口，不需要 Cloudflare 账号，也不提供固定公网域名。

## 主要能力

- 使用中文或 English 交互式配置有效期、权限模式、初始工作目录和审计日志
- 结构化文件操作：`list`、`stat`、`read` 和原子 `write`
- 支持流式输出、超时、状态查询、取消和输出截断提示的远程命令 Job
- 参数级校验的 readonly 命令白名单，覆盖系统、进程、网络、日志、Docker、Git 和 HTTP 检查
- 面向明确授权管理操作的 unrestricted 模式
- 随机、自动过期的 Bearer Token，本地存储权限为 `0600`
- Session 绑定首次认证成功的 Client ID，不绑定可能变化的客户端 IP
- 基于 IP 的认证失败限流，以及可选本地 JSONL 审计日志
- 可选 Codex Skill，可直接识别用户粘贴的 Session 信息并执行统一安全流程
- 在支持的 Linux 主机上自动下载固定版本的 `cloudflared`，并校验 SHA-256

## 环境要求

### 远程 Linux 主机

- Linux x64 或 arm64
- Node.js 22 及以上版本
- 能够通过 HTTPS 访问 GitHub Releases 和 Cloudflare

### 本地环境

- Node.js 22 及以上版本
- 能够访问生成的 `trycloudflare.com` 地址

当前需要在远程主机和本地环境中分别从源码安装 CLI。

## 安装

```bash
git clone https://github.com/wwenj/AgentRemoteOps.git
cd AgentRemoteOps
corepack enable
pnpm install --frozen-lockfile
pnpm build
npm install -g .
```

确认当前全局安装与源码版本一致：

```bash
agent-remoteops --version
agent-remoteops --help
```

更新已有安装时，应先重新构建再安装：

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
npm install -g .
```

## 通过 Coding Agent 快速使用

### 1. 在远程主机启动临时 Session

```bash
cd /path/to/your/initial-directory
agent-remoteops start
```

交互式向导会要求确认：

- 中文或 English 界面语言；
- 5 分钟至 8 小时的 Session 有效期；
- `readonly` 或 `full` 权限模式；
- Agent 初始工作目录，默认使用当前目录；
- 是否记录本地审计日志。

服务端会显示 URL、Token、权限模式、初始工作目录和到期时间。请保持该进程在前台运行；按 `Ctrl+C` 可提前结束 Session，否则会在 TTL 到期后自动关闭。

### 2. 直接把 Session 交给 Agent

在本地环境安装一次内置 Codex Skill：

```bash
agent-remoteops skill install codex
```

覆盖已有安装：

```bash
agent-remoteops skill install codex --force
```

然后在同一条消息中粘贴 Session 信息和任务：

```text
URL          https://example.trycloudflare.com
Token        <temporary-session-token>
Permission   readonly
Initial cwd  /srv/app
Lifetime     30 minutes

检查服务器健康、服务部署、监听端口和近期错误，不要执行修改。
```

Skill 会要求 Agent 通过掩码输入提交 Token，使用 `status --json` 核验服务端返回的真实 Session，再继续执行任务。

> [!IMPORTANT]
> URL 和 Token 都是临时敏感凭据。首次连接成功后，Session 会锁定该本地 Client ID。在把 Session 交给目标 Agent 前，不要先用其他客户端连接，否则 Agent 会收到 `CLIENT_ID_NOT_ALLOWED`。

### 3. 手动连接

```bash
agent-remoteops connect https://example.trycloudflare.com --name production-check
```

根据掩码提示输入 Token。连接成功后，该 Session 会成为后续命令使用的当前本地 Session。

可信的非交互自动化也可以使用 `AGENT_REMOTEOPS_TOKEN`。应通过 Secret Manager 注入，不要把 Token 放入命令参数、Shell History、日志或文档。

## 常用工作流

```bash
# 任何操作前先核验服务端返回的真实范围
agent-remoteops status --json

# 执行有明确范围的只读诊断
agent-remoteops exec 'journalctl -u app -n 100 --no-pager' --timeout 30000

# 当前 readonly 版本支持经过整体预校验的序列和 pipeline
agent-remoteops exec 'uptime; ps aux | grep node'

# 优先使用结构化文件 API
agent-remoteops list /srv/app --json
agent-remoteops stat /srv/app/package.json --json
agent-remoteops read /srv/app/package.json
agent-remoteops read /var/log/app.log --out ./app.log

# 下载当前文件并取得 SHA-256，然后在 full 模式下使用乐观并发控制上传
agent-remoteops read /srv/app/config.json --out ./config.remote.json
agent-remoteops write ./config.json /srv/app/config.json --if-match <remote-sha256>

# 查看或取消 Job
agent-remoteops jobs --json
agent-remoteops cancel <job-id>

# 删除当前保存的本地 Session
agent-remoteops disconnect
```

## CLI 速查

| 命令 | 用途 |
| --- | --- |
| `start` | 交互式启动远程服务和临时 Tunnel |
| `connect <url> [--name <name>]` | 认证并保存本地 Session |
| `status [--json]` | 查看服务端版本、模式、能力、工作目录和到期时间 |
| `exec <command> [--timeout <ms>] [--json]` | 创建 Job 并持续输出结果直至完成 |
| `jobs [--json]` | 查看当前 Session 保留的 Job |
| `cancel <job-id>` | 取消排队中或运行中的 Job |
| `list <path> [--json]` | 通过结构化 API 列出远程目录 |
| `stat <path> [--json]` | 获取远程文件元数据 |
| `read <remote-path> [--out <file>]` | 输出或下载远程文件 |
| `write <local-file> <remote-path> [--if-match <sha256>]` | 在 `full` 模式下原子上传文件 |
| `policy show <readonly\|full>` | 查看当前 CLI 的权限策略摘要 |
| `skill install codex [--force]` | 安装内置 Codex Skill |
| `disconnect [name]` | 删除保存的本地 Session |

`status`、`exec`、`jobs`、`list` 和 `stat` 支持 `--json`。

## 权限模式与安全边界

| 模式 | 文件 API | 命令能力 | 适用场景 |
| --- | --- | --- | --- |
| `readonly` | 可读取运行用户有权访问的任意路径；禁止写入 | 参数级校验的白名单；不经过 Shell；支持整体预校验的 `;`、`&&`、`||` 和 pipeline | 环境检查与故障诊断 |
| `full` | 可读写运行用户有权访问的任意路径 | 不限制命令内容，通过 `/bin/bash -lc` 执行 | 经过明确授权的管理操作 |

### Readonly 行为

`readonly` 只允许选定的检查命令，并逐项校验参数。例如：`systemctl status`、有界 `journalctl`、`ps`、`ss`、`df`、`git status`、`docker ps`，以及使用 `curl` 发起 HTTP `GET`/`HEAD` 请求。

以下行为会被拒绝：

- 白名单之外的命令；
- 文件重定向、后台执行、命令替换和子 Shell；
- 会修改状态的 `systemctl`、Docker、Git、`find`、网络和包管理操作；
- `curl` 上传、请求体、输出文件、非 HTTP(S) URL，以及 GET/HEAD 以外的方法；
- 可能绕过受控 readonly `PATH` 的显式二进制路径。

执行前会校验整个命令序列；只要其中一个子命令不安全，整条序列都不会执行。

### 重要边界

- `workingDirectory` 只是初始 `cwd` 和相对路径解析基准，不是读取或写入边界。
- `readonly` 可读取 Linux 运行用户有权访问的任意文件，并会跟随 symlink。它保护系统完整性，不保护信息机密性。
- `full` 继承启动 Agent RemoteOps 的 Linux 用户拥有的全部权限。除非确有必要，请避免以 `root` 启动。
- Quick Tunnel URL 是公开端点。受保护路由需要 Token 和已绑定 Client ID；`/healthz` 有意保持免认证，只返回基础存活状态。
- 认证失败会按观测到的客户端 IP 限流，但 Token 仍是主要凭据。
- 正常关闭会终止已跟踪 Job 和子进程；`SIGKILL`、主机故障，以及命令已经产生的持久化副作用无法自动回滚。
- Quick Tunnel 不提供可用性保证，不适合长期管理或承载生产流量。

## 运行限制

| 限制项 | 当前值 |
| --- | --- |
| Session 有效期 | 5 分钟至 8 小时 |
| Job 超时 | 1 秒至 10 分钟；CLI 默认 60 秒 |
| 单个 Job 捕获输出 | 4 MiB，超出部分标记为 truncated |
| 结构化文件读写 | 单文件 10 MiB |
| Job 并发 | 同时运行一个，最多排队八个 |
| API 请求体 | 16 MiB |

本地 Session 保存在 `${XDG_CONFIG_HOME:-~/.config}/agent-remoteops/sessions.json`，权限为 `0600`。启用审计时，日志写入 `${XDG_STATE_HOME:-~/.local/state}/agent-remoteops/audit/`。不要读取、打印或复制其中保存的 Token。

## 常见问题

### 首先核验服务端 Session

```bash
agent-remoteops status --json
```

应以返回的 `version`、`mode`、`capabilities`、`workingDirectory` 和 `expiresAt` 为准，不要依赖粘贴文本或本地旧印象。

### `CLIENT_ID_NOT_ALLOWED`

说明已有其他 Client ID 率先完成认证。请继续使用最初连接的客户端，或者停止远程进程并创建新 Session。正在运行的 Session 不会因为另一个客户端重复提交 Token 而重新绑定。

### `readonly-command:<name>` 或其他策略拒绝

不要重复尝试被禁止的操作。应改用白名单内的只读替代命令、结构化文件 API，或在用户明确授权修改后创建新的 `full` Session。

### 当前 readonly 序列被判定为 `readonly-shell-operator`

重定向、`&`、命令替换和子 Shell 本来就会被拒绝。当前源码支持 `;`、`&&`、`||` 和 pipeline。如果这些操作也被拒绝，说明正在运行的全局安装很可能使用了旧的或未更新的构建产物，即使 `package.json` 已显示 `0.2.0`。可以先把诊断拆成多条独立命令，再从同一 commit 重新构建并安装远程服务端和本地 CLI。

### Tunnel 启动失败

确认远程主机可以通过 HTTPS 访问 GitHub Releases 和 Cloudflare。服务端会下载固定版本的 `cloudflared`、校验 SHA-256，并缓存到 `${XDG_CACHE_HOME:-~/.cache}/agent-remoteops/cloudflared/`；只有 `/healthz` 检查成功后才会显示 Session 已就绪。

本地开发时可以不使用 Cloudflare：

```bash
AGENT_REMOTEOPS_TUNNEL=none pnpm dev start
```

## 本地开发

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 会依次执行 TypeScript 检查、Vitest 测试和生产构建。

## 许可证

[MIT](./LICENSE)
