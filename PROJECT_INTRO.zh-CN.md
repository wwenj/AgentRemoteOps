# Agent RemoteOps：只在远程安装 CLI 的临时运维桥接工具

Agent RemoteOps 用于把一个短时、明确授权的远程 Linux Session 交给本地 Codex。它不分发长期 SSH 凭据，不要求在服务器安装 Codex，也不要求开放固定公网管理端口。

产品由两个边界清晰的部分组成：

```text
远程 Linux：agent-remoteops CLI
  负责 HTTP 服务、Quick Tunnel、权限、Job、文件 API、TTL 和退出清理

本地 Codex：Agent RemoteOps Skill
  通过 Skill 内置 Python 客户端连接 Protocol v2，不安装 npm CLI
```

用户只需要在远程主机执行 `agent-remoteops start`，通过交互向导选择有效期、`readonly` 或 `full`、初始工作目录和审计设置。启动成功后，将 URL、Token 和任务发送给安装了 Skill 的 Codex。Codex 会安全提交 Token，以服务端返回的真实权限和到期时间为准，再读取文件或提交命令 Job。

`readonly` 使用参数级命令白名单并禁止文件写入，适合默认诊断；`full` 允许文件写入和不受限 Shell，继承启动服务的 Linux 用户权限，只适合已经明确授权的修复。初始工作目录只负责相对路径解析，不是文件系统隔离边界。

0.3.0 使用不兼容的 Protocol v2。所有受保护请求必须携带 Bearer Token、UUID Client ID 和协议版本头；创建 Job 与写文件还要求幂等键。旧版 `/v1/*`、本地 npm 客户端、状态迁移和协议降级均不保留。

Session 到期、Tunnel 异常或用户按下 `Ctrl+C` 后，工具会停止 HTTP 服务、Tunnel、排队和运行中的 Job，并终止已跟踪子进程。Quick Tunnel 没有 SLA，Agent RemoteOps 的定位始终是人工在场、目标明确、时间有限的临时诊断与修复工具，而不是 SSH、VPN、堡垒机或长期运维平台的替代品。
