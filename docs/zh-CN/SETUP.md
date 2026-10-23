# 使用指南

从零到可用的多机工作台，每台服务器约 10 分钟。

> English: [docs/SETUP.md](../SETUP.md)

## 0. 准备清单

| 位置 | 要求 |
|---|---|
| 你的 Mac | macOS 13+、**Node.js ≥ 22.13**、`ssh`、Xcode 命令行工具（`xcode-select --install`）。可选：Syncthing |
| 每台 Linux | 一个 SSH 账号、`tmux`、`python3`、`curl`、**Claude Code**。可选：`syncthing` |
| 网络 | Mac 能 `ssh` 到服务器。服务器在 NAT 后面时，建议用 [Tailscale](https://tailscale.com) 之类的组网工具，把 Tailscale IP 写进 `~/.ssh/config` |

## 1. SSH 免密登录

TAKT 的一切都走你本机的 `ssh` 命令，所以唯一硬性要求是：`~/.ssh/config` 里有一个能**用密钥、免交互**登录的主机条目。

```sshconfig
# ~/.ssh/config
Host my-server
    HostName 203.0.113.10        # 或 Tailscale / 内网地址
    User root                    # 或你的普通用户
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 30
```

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub my-server      # 一次性：安装公钥
ssh -o BatchMode=yes my-server 'echo ok'            # 必须直接输出 ok，不能要求输入密码
```

> 普通用户也可以用。默认远端目录 `/root/work` 没权限时，TAKT 会自动回退到 `~/Documents/work` 或 `~/work`，并记录真实路径。

## 2. 准备 Linux 服务器

每台服务器跑一次辅助脚本（安装 `tmux`、`python3`、`curl`、`syncthing`，并把 Syncthing 设为用户服务）：

```bash
ssh my-server 'bash -s' < scripts/remote-bootstrap.sh
```

然后为该 SSH 用户安装 **Claude Code**（见[官方文档](https://docs.claude.com/claude-code)）并登录一次（运行 `claude`）。脚本结尾会输出 ✔/✘ 检查清单。

## 3. 安装并启动客户端

```bash
git clone https://github.com/willwill85/TAKT-UI-CC.git
cd TAKT-UI-CC
bash scripts/install.sh      # 检查依赖 + npm install + node-pty 自检
bash scripts/start.sh        # 工作台 :3080 + MCP 服务 :18765（已装 brew syncthing 时一并启动）
```

打开 <http://127.0.0.1:3080>。首次启动会看到一个空的“Linux 节点 1”，状态栏提示 **“未绑定 SSH 节点”** —— 这是正常的。

### 可选：原生 macOS App

```bash
bash scripts/build-app.sh
cp -R build/TAKT-UI-CC.app /Applications/
```

首次打开请**右键 → 打开**（ad-hoc 签名）。App 会自己执行 `scripts/start.sh`，之后双击即可。它记住的是构建时所在的仓库路径（`Info.plist` 的 `TAKTRepoPath`），移动仓库后请重新构建。

## 4. 连接第一台服务器

1. 点左上角 **节点** 按钮（服务器图标），列表里会列出从 `~/.ssh/config` 读到的主机。
2. 编辑第一个“Linux 节点 1”：选 SSH 主机、起个名字/徽标（如 `HOME`）、确认远端目录、勾选 **启用**，保存。
3. TAKT 会自动完成配置，你会看到类似日志：
   - 本地目录 `~/.takt-ai/work` 已创建
   - Mac Syncthing 文件夹已注册
   - **MCP 反向隧道**已建立（`ssh -R 18765…`）
   - 服务器 `~/.claude.json` 写入 `mac-industrial` MCP（含 Token），`~/.claude/settings.json` 写入权限规则
   - **Syncthing 双向配对完成**（Mac 信任服务器、服务器信任 Mac、共享同一个文件夹 ID）
4. 状态栏变绿：SSH（延迟）· Tailscale · MCP 隧道 · Syncthing。

再加服务器同理 —— 每台自动得到独立的本地目录（`work2`、`work3`……）、Syncthing 文件夹（`takt-work2`……）和隧道。侧边栏顶部的机器开关（`全部 / HOME / GPU …`）按机器筛选。

## 5. 日常使用

- **项目** = 节点工作目录下的一级文件夹。左上角“新建文件夹”图标创建。
- **打开终端**：鼠标悬停项目 → **＋**。在服务器该目录下创建 tmux 会话 `takt_<tab>`。
- **运行 Claude**：点终端上方的 **注入终端**，它会输入 `claude`（打开历史对话时是 `claude -r <session-id>`）。TAKT 不会自己启动 Claude。
- **恢复对话**：点侧边栏任意对话。随时可关闭应用 —— tmux 会话在服务器上继续运行。
- **重命名 / 删除**对话：悬停 → 铅笔 / 垃圾桶。重命名会同步写入服务器上该会话的 `.jsonl`，不会丢。
- **标签**：`＋ 标签` 新建；悬停项目 → 标签图标（或右键）设置；点胶囊筛选；右键 / 双击胶囊可编辑或删除。
- **文件**：右侧是当前项目在**本机的镜像**。把文件从树里拖进终端会粘贴路径；从 Finder 拖文件到树里即上传（并同步到服务器）。

## 6. 在 Claude 里使用 MCP 工具

在已连接的服务器上启动 `claude`，输入 `/mcp`，应当看到 **mac-industrial** 已连接（23 个工具）。可以说“用 Metal 渲染这个 .blend 并保存 PNG”、“列出我 Mac 上的 USB 串口”。工具清单见 [MCP-TOOLS.md](../MCP-TOOLS.md)。

`mac_host_exec`（在你的 Mac 上执行任意 Shell）默认为**询问**，Claude 每次都要你确认。想预先放行：在 `~/.takt-ai/env` 加一行 `TAKT_AUTO_ALLOW_HOST_EXEC=1`，重启工作台并重新保存节点（规则是在保存节点时写到服务器的）。

## 排错

先跑 `npm run doctor` —— 它会检查本机和每个节点。

| 现象 | 可能原因 / 解决 |
|---|---|
| 打开终端报 `posix_spawnp failed` | `node-pty` 的 helper 丢了可执行位：`node scripts/postinstall.js`（`npm install` 后会自动执行）。仍不行：`npm rebuild node-pty` |
| `Node.js >= 22.13 not found` / 缺少 `node:sqlite` | 升级 Node（`brew install node`）。可用 `TAKT_NODE=/path/to/node` 指定具体二进制 |
| 终端提示“连续 N 次无法连接” | `ssh <host>` 无法免交互登录。修好密钥 / `~/.ssh/config` / VPN，然后在终端按回车重试 |
| 状态栏 **SSH 断开**，但手动 ssh 正常 | Clash、Surge 等 TUN 模式可能劫持 22 端口。用 `ssh -o ProxyCommand=none host` 对比测试，或把服务器地址排除出 TUN |
| 刚添加的节点显示离线 | 扫描通过 ssh 运行一小段 `python3`，服务器需要有 `python3`。跑 `npm run doctor`。非 root 用户的远端目录会在首次扫描时自动纠正 |
| **MCP 隧道断开** | 看门狗最多 15 秒重建一次。一直不恢复：服务器上有别的进程占了 `127.0.0.1:18765`（`ss -tlnp 'sport = :18765'`），或 `sshd` 配置了 `AllowTcpForwarding no`。可点状态栏的 **隧道自愈** |
| Claude 里 `/mcp` 提示 *Unauthorized* | Token 不一致。重新保存该节点（会用 `~/.takt-ai/mcp-token` 里的当前 Token 重写 `~/.claude.json`） |
| Syncthing 始终连不上 | 两端的 Syncthing 都要**在运行**（`brew services start syncthing`；`systemctl --user enable --now syncthing`）。服务器防火墙挡了 TCP **22000** 时会走中继（较慢），放行端口速度最佳 |
| 侧边栏对话比预期少 | 只列出 `cwd` 位于节点工作目录内的对话，并按一级项目文件夹归类。在别处（如 `/tmp`）启动的对话不会显示 |
| 升级后数据丢了？ | 数据都在 `~/.takt-ai`（SQLite + `nodes.json`），升级不会动它 |

日志：`~/.takt-ai/logs/workbench.log`、`~/.takt-ai/logs/mcp-server.log`。

## 升级

```bash
git pull
npm install
bash scripts/stop.sh && bash scripts/start.sh
```

## 卸载

```bash
bash scripts/stop.sh
rm -rf ~/.takt-ai            # 全部本地数据（含 work 镜像！它们只是副本，原件在服务器上）
```

服务器上如不再需要，删除 `~/.claude.json` 里的 `mac-industrial` 条目，以及 `~/.claude/settings.json` 里的 `mcp__mac-industrial*` 规则。
