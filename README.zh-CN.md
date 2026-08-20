<p align="center">
  <img src="https://raw.githubusercontent.com/wwenj/AgentRemoteOps/master/public/logo.png" alt="Agent RemoteOps Logo" width="160">
</p>

<h1 align="center">Agent RemoteOps</h1>

<p align="center"><a href="./README.md">English</a> | 简体中文</p>

<p align="center">只在远程 Linux 安装 CLI，本地 Codex 仅安装 Skill 的短时、可审计远程运维桥接工具。</p>

> [!WARNING]
> Agent 自动执行远程命令具有风险。优先使用 `readonly`；`full` 会继承启动服务的 Linux 用户权限。将其用于重要环境前，请先理解下方安全边界。

## 它解决什么问题

本地 Codex 通常无法直接看到真实服务器上的进程、端口、systemd、容器、日志和部署文件。直接提供长期 SSH 凭据权限过大，而临时开放公网管理端口也会扩大攻击面。

Agent RemoteOps 在远程 Linux 上启动一个仅监听 `127.0.0.1` 的临时服务，再通过 Cloudflare Quick Tunnel 生成短时公网地址。用户把 URL、Token 和任务交给安装了 Skill 的 Codex，Codex 即可在 Session 权限范围内读取文件或执行命令。Session 到期或用户按下 `Ctrl+C` 后，HTTP 服务、Tunnel、Job 和已跟踪子进程都会关闭。

```text
本地 Codex
  └─ Agent RemoteOps Skill
       └─ Skill 内置 Python 客户端
              │ HTTPS + Token + Client ID + Protocol v2
              ▼
       Cloudflare Quick Tunnel
              ▼
远程 Linux
  └─ agent-remoteops CLI
       ├─ 文件 API
       ├─ 命令 Job
       └─ 权限、TTL、审计与进程清理
```

本地不需要安装 `agent-remoteops` npm CLI。

## 使用演示

### 1. 在远程 Linux 启动 Session

https://github.com/user-attachments/assets/fbdbfffc-45fb-4570-a29a-0e5936de580a

### 2. 把 Session 和任务直接交给 Codex

https://github.com/user-attachments/assets/ceefcfb1-6c5d-42c8-84cf-aab5a5a41422

### 3. 查看远程控制台实时日志

控制台会实时显示 Agent 的连接、认证、请求和命令 Job 日志，便于观察执行进度与审计记录。

https://github.com/user-attachments/assets/f0023ce0-07c3-4946-8803-329c76188cbb

## 环境要求

### 远程 Linux

- Linux x64 或 arm64
- Node.js 22 及以上版本
- 能够通过 HTTPS 访问 npm、GitHub Releases 和 Cloudflare

### 本地 Codex

- 已安装 Codex 和 Agent RemoteOps Skill
- macOS 或 Linux
- Python 3.10 及以上版本
- 能够访问生成的 `trycloudflare.com` 地址

## 安装

### 远程 Linux：安装 CLI

```bash
npm install -g agent-remoteops
agent-remoteops --version
```

CLI 只负责远程服务端：

| 命令 | 用途 |
| --- | --- |
| `agent-remoteops start` | 交互式创建临时 Session |
| `agent-remoteops policy show readonly` | 查看 readonly 权限摘要 |
| `agent-remoteops policy show full` | 查看 full 权限摘要 |

### 本地 Codex：只安装 Skill

在 Codex 中发送：

```text
请从下面的 GitHub 目录安装 Agent RemoteOps Skill：
https://github.com/wwenj/AgentRemoteOps/tree/master/skills/agent-remoteops
```

不要在本地安装 npm CLI。若本地曾安装 0.2.x，可手动清理：

```bash
npm uninstall -g agent-remoteops
```

新版不会读取、迁移或删除旧版 `${XDG_CONFIG_HOME:-~/.config}/agent-remoteops/sessions.json`。

## 快速使用

1. 在远程 Linux 进入期望的初始工作目录并执行：

   ```bash
   cd /srv/app
   agent-remoteops start
   ```

2. 选择语言、有效期、`readonly` 或 `full`、初始工作目录和审计日志，最终确认后等待 Session 就绪。
3. 将控制台显示的 URL、Token 和具体任务一起发送给安装了 Skill 的 Codex。
4. Codex 会通过 Skill 内置客户端安全提交 Token，核验服务端返回的真实权限，再执行任务；用户不需要手动连接。
5. 完成后在远程终端按 `Ctrl+C`，或等待 TTL 自动结束。

## 权限与安全边界

| 模式 | 文件能力 | 命令能力 | 使用场景 |
| --- | --- | --- | --- |
| `readonly` | 可读取启动用户有权访问的路径，禁止写入 | 参数级白名单，不经过 Shell；支持整体预校验的序列和 pipeline | 默认诊断 |
| `full` | 可读写启动用户有权访问的路径 | 通过 `/bin/bash -lc` 执行，不限制命令内容 | 明确授权的修复 |

- `workingDirectory` 只负责相对路径和命令初始 cwd，不是访问边界。
- `readonly` 保护系统完整性，不保护信息机密性；它仍能读取运行用户可访问的敏感文件。
- `full` 只是服务端能力，不代表用户已经授权某次修改。
- 首次成功认证会绑定唯一 Client ID；错误协议不会占用绑定。
- Token 不进入命令参数或环境变量，只通过 TTY 掩码输入，并以 `0600` 保存到自动过期的临时状态文件。
- Quick Tunnel 没有 SLA，不适合长期管理或承载生产流量。
- 正常退出可以清理受跟踪进程，但不能回滚命令已产生的持久化副作用，也无法覆盖 `SIGKILL` 或主机故障。

## Protocol v2

0.3.0 使用破坏性的 Protocol v2。所有受保护请求必须包含 Bearer Token、UUID Client ID 和 `X-Agent-RemoteOps-Protocol: 2`；创建 Job 和文件写入还要求 `Idempotency-Key`。旧版 `/v1/*` 和 0.2.x 本地客户端不受支持，也不会提供协议降级。

服务端提供 Session、Job 轮询/取消以及结构化的 `stat`、`list`、`read`、`write` API。单个 Job 默认超时 60 秒，最大 10 分钟；输出上限 4 MiB；文件 API 单文件上限 10 MiB。

## 本地开发

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
git diff --check
```

开发和测试同时需要 Node.js 22+ 与 Python 3.10+。`pnpm check` 会执行 TypeScript、Vitest、Python Skill、Skill 结构验证、生产构建和 npm 打包检查。

## 许可证

[MIT](./LICENSE)
