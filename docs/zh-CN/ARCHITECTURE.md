# 架构说明

> English: [ARCHITECTURE.md](../ARCHITECTURE.md)

TAKT-UI-CC 在你的 Mac 上有三个运行单元，每台服务器上只有很小的占用。架构图见英文版（Mermaid）；下面是要点。

## 1. 节点注册表

`$TAKT_HOME/nodes.json` 是机器的唯一数据源：

```json
{ "nodes": [{
  "id": "node-1", "name": "Home Server", "badge": "HOME",
  "sshHost": "home-server",                 // ~/.ssh/config 里的别名
  "remoteWorkDir": "/home/dev/work",        // 服务器上项目所在目录
  "localWorkDir": "/Users/me/.takt-ai/work",// 它在本机的镜像
  "localWorkAlias": "work",
  "syncthingFolderId": "takt-work",
  "syncthingDeviceId": "XXXXXXX-…",         // 自动填入
  "enabled": true
}]}
```

每个节点独占**一个**本地目录、**一个** Syncthing 文件夹 ID、**一个**隧道 socket（`~/.ssh/sockets/takt-mcp-tunnel-<id>.sock`）。第一个节点 `node-1` 不可删除，之后新增的节点会生成 `linux-xxxxxxxx` 形式的 id。

### 保存节点时发生了什么（`provisionLinuxNode()`）

1. 创建本地目录，并在本机 Syncthing 中注册该文件夹；
2. 建立 MCP 反向隧道：`ssh -M -S <sock> -Nf -R 18765:127.0.0.1:18765 -R 49620:127.0.0.1:49620 <host>`；
3. 在服务器上运行一小段 `python3`：
   - 创建远端工作目录（非 root 自动回退到 `~/Documents/work` / `~/work`）；
   - 把 `mac-industrial` MCP（URL + `Authorization: Bearer <token>`）写入 `~/.claude.json`；
   - 在 `~/.claude/settings.json` 里把 `mcp__mac-industrial` 加入 `permissions.allow`，`mac_host_exec` 加入 `permissions.ask`；
   - 上报服务器的 Syncthing 设备 ID；
4. 通过两端各自的本地 REST API（`PUT /rest/config/devices/<id>` + `PUT /rest/config/folders/<id>`）**双向配对 Syncthing**，无需手动操作即可开始同步。

## 2. 侧边栏数据：被动扫描 + SQLite

侧边栏从不调用 `claude` 二进制。对每个已启用节点，`syncAllNodesToSqlite()` 通过 `ssh` 运行只读 `python3` 片段：

- 列出远端工作目录的一级文件夹（= 项目）；
- 采样 `~/.claude/projects/*/*.jsonl`（每个文件取头尾）得到会话 id、自定义标题 / 摘要 / 首条提问、轮数、大小和修改时间；
- 把深层工作目录（`/work/proj/repos/x`）归一到一级项目文件夹。

结果 **upsert** 进 SQLite：

| 表 | 用途 |
|---|---|
| `projects` | `key = <节点 id>::<远端路径>`，含 `pinned_visible`、软删除 |
| `sessions` | 重命名存 `custom_title`，删除为软删除 |
| `node_status` | 最近一次已知的在线状态 |
| `tags` / `project_tags` | 侧边栏标签（每个项目一个标签） |

`GET /api/tree` 直接**从 SQLite 返回（<1 ms）**，后台最多每 ~6 秒刷新一次。扫描失败（服务器离线、ssh 抖动）**绝不会删除任何数据** —— 列表因此稳定。空项目默认隐藏，除非有标签、在界面里创建、或刚打开过。

## 3. 终端

两种可切换的引擎（顶部栏切换）：

- **原生**（桌面 App）：SwiftTerm 的 `LocalProcessTerminalView` 直接运行 `native-ssh-session.sh`，网页只负责告知绘制区域（`taktNative` 消息通道）。
- **Web PTY**：浏览器 xterm.js 经 `WS /ws/term` 连接，服务端用 `node-pty` 启动同一脚本，每个标签保留 256 KB 回滚并支持多客户端。

`native-ssh-session.sh <tab> <cwd> <host>` 以 `ControlMaster=no`、`ClearAllForwardings=yes` 运行 `ssh -tt`（终端从不共用或干扰隧道），然后在服务器的项目目录里创建/接入 tmux 会话 `takt_<tab>`。ssh 退出码 255（网络断开）自动重连；连续 4 次瞬间失败则停下等你按回车，而不是死循环。

## 4. 文件区

右侧文件树与预览**只读本地镜像**（`/api/files`、`/api/file-content`、`/api/raw-file`）。终端里出现的路径（`/home/dev/work/x/y.png`）会按各节点 `remoteWorkDir` 映射到镜像。预览上限：图片 ≤ 12 MB、HTML ≤ 2 MB、代码/文本 ≤ 200 KB，二进制跳过。写操作（`move`、`upload`、`mkdir`）拒绝 `$TAKT_HOME` 之外的路径。

## 5. MCP 服务与看门狗

`mcp-server/server.js --http` 在 `POST /mcp` 上提供 MCP（JSON-RPC 2.0；也支持 SSE：`GET /sse` + `POST /messages`）。`?node=<id>` 告诉它调用方是哪个节点，以便把远端路径（`<remoteWorkDir>/foo`）翻译成该节点的本地镜像路径。其他端点：`/health`、`/system-status`（状态栏数据）、`POST /system-heal`、`/viewer`（3D 查看器）、`/work/*`（只读文件）。

**看门狗**每 5 秒：

1. 检查嘉立创 EDA 桥与 Syncthing（汇总所有节点的文件夹/设备）；
2. 对每个已启用节点，通过该节点的 ControlMaster socket 运行 `python3` 探针（claude 进程、服务器侧能否访问 MCP、出网 IP、Tailscale、用量估算）；
3. 隧道不可用时重建（每节点最多 15 秒一次）—— 只动专用隧道 socket，绝不碰交互终端；
4. 通过 `/system-status` 发布结果，工作台合并进 `/api/status` 给底部状态栏。

## 6. 安全边界

见 [SECURITY.md](../SECURITY.md)。简言之：两个 HTTP 服务只监听回环地址并校验 `Host`/`Origin`，`/mcp` 需要 Bearer Token，隧道是服务器通往你 Mac 的唯一通路。

## 7. 进程模型

`scripts/start.sh` 以脱离终端的独立会话（`setsid`）启动 `mcp-server` 和 `workbench`，pid 写入 `$TAKT_HOME/run/`，日志在 `$TAKT_HOME/logs/`。工作台还会监管 MCP 服务（`/system-status` 不响应就重启它）。
