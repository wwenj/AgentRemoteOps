# Agent RemoteOps

[English](./README.md) | 简体中文

Agent RemoteOps 是一个面向 Coding Agent 的临时、可审计远程运维桥接工具。它允许本地 Agent 检查和操作远程 Linux 工作区，无需部署长期暴露的管理服务。

> [!WARNING]
> Agent RemoteOps 仍处于早期开发阶段。`readwrite` 模式的拒绝规则只能降低误操作风险，并不是操作系统级安全沙箱。在生产主机上使用前，请先了解[权限与安全边界](#权限模式与安全边界)。

## 背景

Coding Agent 只有接触真实运行环境，才能有效分析日志、定位故障和辅助修复。但生产、测试服务器通常无法由开发者本地直接访问；为 Agent 提供长期 SSH 凭证，或暴露一个常驻管理端口，又会引入不必要的安全风险。

Agent RemoteOps 提供了一种短时替代方案：

1. 在远程 Linux 主机启动仅监听回环地址的 HTTP 服务；
2. 通过 Cloudflare Quick Tunnel 建立临时外部访问地址；
3. 使用随机生成的 Session Token 认证每一次操作；
4. 通过工作目录、有效期和权限模式限制 Session；
5. Session 到期或主动关闭时，停止服务、Tunnel、Job 和已跟踪的子进程。

远程主机只需具备出站网络访问能力；使用 Quick Tunnel 不需要配置入站防火墙规则，也不需要 Cloudflare 账号。

## 主要能力

- 交互式配置工作目录、Session 有效期、权限模式和审计日志
- 结构化文件操作：目录列表、状态查询、读取和受控写入
- 支持输出流、超时、状态查询和取消的远程命令 Job
- 面向诊断、受控变更和完全操作的三种权限模式
- 自动过期的 Bearer Token，本地配置文件权限为 `0600`
- 可选 Codex Skill，规范 Agent 的远程运维流程
- 正常退出、收到终止信号或 TTL 到期时自动清理

## 环境要求

### 远程主机

- Linux x64 或 arm64
- Node.js 22 及以上版本
- 能够通过 HTTPS 访问 GitHub Releases 和 Cloudflare

### 本地环境

- Node.js 22 及以上版本
- 能够访问生成的 `trycloudflare.com` 地址

## 安装

Agent RemoteOps 当前推荐从源码构建。远程主机和本地环境均需安装：

```bash
git clone https://github.com/wwenj/AgentRemoteOps.git
cd AgentRemoteOps
corepack enable
pnpm install --frozen-lockfile
pnpm build
npm install -g .
```

确认安装成功：

```bash
agent-remoteops --help
```

## 使用方法

### 1. 在远程主机启动临时 Session

```bash
cd /path/to/your/workspace
agent-remoteops start
```

交互式向导会要求确认：

- 结构化文件 API 可以访问的工作目录；
- 5 分钟至 8 小时的 Session 有效期；
- `readonly`、`readwrite` 或 `full` 权限模式；
- 是否记录本地审计日志。

每个交互选项之间会保留清晰间距，所有选择完成后会先显示配置摘要，只有再次确认才会启动服务。启动成功后，URL、Token、权限、工作目录和到期时间会按单行键值排列，同时显示 Agent 使用说明、安全提示和自动清理说明。

复制终端输出的 URL 和 Token，发送给已安装 Agent RemoteOps Skill 的 Codex、Claude Code 或其他 Coding Agent，并保持服务端进程在前台运行。后续文件与命令调用日志会实时显示在连接信息下方。按 `Ctrl+C` 可提前关闭 Session，否则会在 TTL 到期后自动关闭并清理临时资源。

### 2. 从本地环境连接

```bash
agent-remoteops connect https://example.trycloudflare.com
```

根据提示输入 Token。连接信息会保存在本地，后续命令将复用当前 Session。非交互环境可以通过 `AGENT_REMOTEOPS_TOKEN` 提供 Token。

### 3. 检查和操作远程工作区

```bash
# 查看 Session 范围与能力
agent-remoteops status

# 执行有明确输出范围的诊断命令
agent-remoteops exec 'journalctl -u app -n 200 --no-pager'

# 通过结构化 API 操作文件
agent-remoteops list .
agent-remoteops stat package.json
agent-remoteops read package.json
agent-remoteops read logs/app.log --out app.log

# Session 允许写入时，上传本地文件
agent-remoteops write ./config.json config/config.json

# 查看或取消远程 Job
agent-remoteops jobs
agent-remoteops cancel <job-id>

# 删除本地保存的 Session
agent-remoteops disconnect
```

Agent 或脚本集成时，可以为 `status`、`exec`、`jobs`、`list` 和 `stat` 命令添加 `--json`。

### 4. 安装 Codex Skill（可选）

```bash
agent-remoteops skill install codex
```

覆盖已有安装：

```bash
agent-remoteops skill install codex --force
```

## 权限模式与安全边界

| 模式 | 文件 API | 命令能力 | 适用场景 |
| --- | --- | --- | --- |
| `readonly` | `stat`、`list`、`read` | 诊断命令白名单；禁止 Shell 重定向、替换和组合操作 | 环境检查与故障诊断 |
| `readwrite` | 读取和写入 | 普通 Shell，并拦截内置高风险命令 | 受控修复与配置变更 |
| `full` | 读取和写入 | 不限制命令内容 | 经过明确授权的管理操作 |

需要特别注意：

- 工作目录会限制结构化文件 API，但对通用 Shell 命令而言，它只是初始执行目录。
- `readwrite` 规则用于防止误操作，不是安全沙箱或权限隔离机制。
- `full` 模式继承启动 Agent RemoteOps 的 Linux 用户拥有的全部权限。除非确有必要，请避免使用 `root` 启动。
- Quick Tunnel URL 是由 Session Token 保护的公开端点。URL 和 Token 都应视为敏感信息，并尽量设置较短的 TTL。
- 正常关闭时会尝试终止已跟踪的 Job 和子进程；主进程被 `SIGKILL`、主机故障，以及命令已经产生的持久化副作用无法自动回滚。

## 本地开发

```bash
pnpm install --frozen-lockfile
pnpm check
```

不使用 Cloudflare，在本机启动服务：

```bash
AGENT_REMOTEOPS_TUNNEL=none pnpm dev start
```

## 许可证

[MIT](./LICENSE)
