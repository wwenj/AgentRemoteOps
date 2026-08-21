<p align="center">
  <img src="https://raw.githubusercontent.com/wwenj/AgentRemoteOps/master/public/logo.png" alt="Agent RemoteOps Logo" width="160">
</p>

<h1 align="center">Agent RemoteOps</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/agent-remoteops"><img src="https://img.shields.io/npm/v/agent-remoteops?logo=npm&label=npm" alt="npm 版本"></a>
  <a href="https://github.com/wwenj/AgentRemoteOps"><img src="https://img.shields.io/github/languages/top/wwenj/AgentRemoteOps?logo=typescript&label=TypeScript" alt="TypeScript"></a>
  <a href="#环境要求"><img src="https://img.shields.io/badge/platform-Linux-FCC624?logo=linux&logoColor=black" alt="Linux 平台"></a>
</p>

<p align="center"><a href="./README.md">English</a> | 简体中文</p>

<p align="center">让 Codex 临时连接远程 Linux 完成诊断与维护，并通过分级权限、自动过期和执行审计控制运维风险。</p>

> [!WARNING]
> Agent 自动执行远程命令具有风险。优先使用 `readonly`；`full` 会继承启动服务的 Linux 用户权限。将其用于重要环境前，请先理解下方安全边界。

## 它解决什么问题

我相信大家已经习惯 Claude Code 或 Codex 等强大的 Agent 工具用于日常工作，但这类本地 Agent 运行依赖本地环境，当你要部署上线、接管 Linux 服务器、临时排查线上服务问题时很难介入。

受到内网网络、端口开放、机器防火墙、进出安全组的各种策略，无论是远程服务器安装 Agent 还是本地通过 SSH 的方式链接都非常不方便。

为了解决这个问题我开发了当前项目，由一个远程安装的 NPM 包 [Agent-Remoteops](https://www.npmjs.com/package/agent-remoteops) 和 一个本地 Codex 安装的 SKILL 组成，在远程服务可快速启动，**无需修改任何当前网络配置与安全防火墙，只要能访问外部网络，即可创建一个临时可访问链接**，本地 Codex 通过 Skill 即可完成本地与当前服务的临时连接，实现快速运维调试。

Agent RemoteOps 在远程 Linux 上启动一个仅监听 `127.0.0.1` 的临时服务，再通过 Cloudflare Quick Tunnel 生成短时公网地址。用户把 URL、Token 和任务交给 Codex，Codex 即可在 Session 权限范围内读取文件或执行命令。Session 到期或用户按下 `Ctrl+C` 后，HTTP 服务、Tunnel、Job 和已跟踪子进程都会关闭。

```text
本地 Codex
  └─ Agent RemoteOps Skill
       └─ Skill 内置 Python 客户端
              │ HTTPS + Token
              ▼
       Cloudflare Quick Tunnel
              ▼
远程 Linux
  └─ agent-remoteops CLI
       ├─ 文件 API
       ├─ 命令 Job
       └─ 权限、TTL、审计与进程清理
```

## 使用演示

### 1. 在远程 Linux 服务器中启动临时会话连接

![在远程 Linux 启动 Session](./public/demo-start.gif)

### 2. 把临时会话连接和任务直接交给 Codex

![把 Session 和任务交给 Codex](./public/demo-codex.gif)

### 3. 查看远程控制台实时日志

控制台会实时显示 Agent 的连接、认证、请求和命令 Job 日志，便于观察执行进度与审计记录。

![远程控制台实时日志](./public/demo-console.gif)

## 环境要求

### 远程 Linux

- Linux x64 或 arm64
- Node.js 22 及以上版本
- 能够通过 HTTPS 访问 npm 和 Cloudflare
- 仅当 npm 镜像未提供平台二进制包时，首次启动才需要访问 GitHub Releases 自动修复

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

`cloudflared` 会作为当前 Linux 架构的 npm 可选依赖自动安装，无需手动安装 RPM 或二进制文件。x64/arm64 每台机器只会下载一个约 18 MiB 的压缩包。

如果 npm 镜像跳过了平台包，`agent-remoteops start` 会在内部自动修复：显示下载进度，支持断点续传和最多 3 次重试，总下载阶段不超过 180 秒。下载完成后必须通过内置 SHA-256 校验才会执行。

CLI 用于启动和管理远程 Session：

| 命令                                   | 用途                   |
| -------------------------------------- | ---------------------- |
| `agent-remoteops start`                | 交互式创建临时 Session |
| `agent-remoteops policy show readonly` | 查看 readonly 权限摘要 |
| `agent-remoteops policy show full`     | 查看 full 权限摘要     |

### 本地 Codex：安装 Skill

在 Codex 中发送：

```text
请从下面的 GitHub 目录安装 Agent RemoteOps Skill：
https://github.com/wwenj/AgentRemoteOps/tree/master/skills/agent-remoteops
```

## 快速使用

1. 在远程 Linux 进入期望的初始工作目录并执行：

   ```bash
   cd /srv/app
   agent-remoteops start
   ```

2. CLI 中选择语言、有效期、开放权限、工作目录和审计日志，最终确认后等待 Session 就绪。

3. 将控制台显示的 URL、Token 和具体任务一起发送给安装了 Skill 的 Codex。

4. Codex 会通过 Skill 内置客户端安全提交 Token，核验服务端返回的真实权限，再执行任务；用户完全无感，自动链接。

5. CLI 每次启动只允许一个端建立连接，杜绝其他非安全连接。

6. 完成后在远程终端按 `Ctrl+C`，或等待失效自动结束。

7. 所有执行日志保存在服务本地，随时排查执行记录

## 权限与安全边界

| 模式       | 文件能力                               | 命令能力                                                    | 使用场景       |
| ---------- | -------------------------------------- | ----------------------------------------------------------- | -------------- |
| `readonly` | 可读取启动用户有权访问的路径，禁止写入 | 参数级白名单，不经过 Shell；支持整体预校验的序列和 pipeline | 默认诊断       |
| `full`     | 可读写启动用户有权访问的路径           | 通过 `/bin/bash -lc` 执行，不限制命令内容                   | 明确授权的修复 |

- `workingDirectory` 只负责相对路径和命令初始 cwd，不是访问边界。
- `readonly` 保护系统完整性，不保护信息机密性；它仍能读取运行用户可访问的敏感文件。
- `full` 只是服务端能力，不代表用户已经授权某次修改。
- Token 不进入命令参数或环境变量，只通过 TTY 掩码输入，并以 `0600` 保存到自动过期的临时状态文件。
- Quick Tunnel 没有 SLA，不适合长期管理或承载生产流量。
- 正常退出可以清理受跟踪进程，但不能回滚命令已产生的持久化副作用，也无法覆盖 `SIGKILL` 或主机故障。

## 许可证

[MIT](./LICENSE)

`cloudflared` 平台包依 Apache-2.0 再分发，详见 [第三方软件声明](./THIRD_PARTY_NOTICES.md)。
