# Windows + WSL2 部署

TAKT-UI-CC 可以通过 WSL2 在 Windows 上运行：工作台、SSH、`node-pty`、Syncthing
和辅助脚本都运行在 Linux 中，界面则使用 Windows 浏览器打开
<http://127.0.0.1:3080>。

> Swift 原生桌面外壳及 macOS 专属 MCP 工具（Xcode、Apple 设备部署、macOS 截屏、
> Mac App 启动器）仍不可用。浏览器工作台、SSH/tmux 会话、历史对话、文件预览/同步、
> 本机 Shell MCP 等功能可在 WSL2 下使用。

English: [docs/WINDOWS-WSL2.md](../WINDOWS-WSL2.md)

## 1. 安装 WSL2

用管理员身份打开 PowerShell：

```powershell
wsl --install -d Ubuntu
wsl --set-default-version 2
```

按提示重启 Windows，打开 **Ubuntu** 并创建 Linux 用户。建议 Ubuntu 22.04 或更新版本。

建议把仓库放在 WSL 文件系统中（例如 `~/TAKT-UI-CC`），不要放在 `/mnt/c` 下；
npm 原生模块编译、文件监听和大量小文件访问会更稳定、更快。

## 2. 安装本机依赖

在 Ubuntu 中执行：

```bash
sudo apt update
sudo apt install -y build-essential curl git lsof openssh-client perl python3 syncthing tmux
```

使用 NodeSource、nvm 或其他可信来源安装 Node.js 22.13 或更新版本，然后确认：

```bash
node --version
npm --version
```

某些 Ubuntu LTS 软件源里的 Node 版本低于 `node:sqlite` 所需版本，因此请以实际版本号为准。

## 3. 在 WSL 内配置 SSH

TAKT 调用的是 WSL 内的 Linux `ssh`。即使 Windows OpenSSH 已配置好，密钥和
`~/.ssh/config` 仍需在 WSL 内可用。

如果 PEM 密钥保存在 Windows：

```bash
install -d -m 700 ~/.ssh
install -m 600 /mnt/c/Users/YOUR_WINDOWS_USER/Downloads/server-key.pem ~/.ssh/server-key.pem
```

创建 `~/.ssh/config`：

```sshconfig
Host my-server
    HostName server.example.com
    User ubuntu
    IdentityFile ~/.ssh/server-key.pem
    IdentitiesOnly yes
    ServerAliveInterval 30
```

```bash
chmod 600 ~/.ssh/config
ssh -o BatchMode=yes my-server 'echo ok'
```

最后一条必须直接输出 `ok`，不能要求输入密码或确认主机。把密钥复制到 WSL 并设置
`0600` 也能避免 Windows/DrvFS 权限不兼容。

## 4. 准备 Linux 节点

在仓库目录执行：

```bash
ssh my-server 'bash -s' < scripts/remote-bootstrap.sh
```

再为同一个 SSH 用户安装 Claude Code，并至少登录一次。MCP 使用 `ssh -R`，因此服务器
sshd 必须允许远程 TCP 转发；多数发行版默认允许。如果状态一直显示 **MCP 隧道断开**，
检查 sshd 的生效配置，只为该专用账号加入：

```text
Match User YOUR_SSH_USER
    AllowTcpForwarding remote
```

把它放进 sshd 的 drop-in 配置，先运行 `sudo sshd -t`，通过后再 reload sshd。
不要为无关账号放宽转发权限。

## 5. 安装并启动 TAKT

```bash
git clone https://github.com/willwill85/TAKT-UI-CC.git
cd TAKT-UI-CC
bash scripts/install.sh
bash scripts/start.sh
```

在 Windows 打开 <http://127.0.0.1:3080>。WSL2 会把 Windows localhost 转发到 Linux
服务，无需开放公网防火墙端口；界面和 MCP 服务仍只监听回环地址。

点击 **节点**，选择 `~/.ssh/config` 里的主机，勾选启用并保存。TAKT 会创建本地镜像、
配置带 Token 的 MCP 反向隧道、探测远端工作目录，并在两端已安装 Syncthing 时自动配对。

随时可以运行：

```bash
npm run doctor
```

## 6. 可选：Windows 一键启动

在任意方便的位置创建 `Start-TAKT.cmd`；如果仓库路径不同，请相应修改：

```bat
@echo off
wsl.exe -d Ubuntu -- bash -lc "cd ~/TAKT-UI-CC && bash scripts/start.sh"
if errorlevel 1 (
  pause
  exit /b 1
)
start "" "http://127.0.0.1:3080"
```

启动脚本是幂等的，重复运行只会提示服务已经启动。

## 排错

| 现象 | 解决办法 |
|---|---|
| 缺少 `node:sqlite` | 在 WSL 内安装 Node.js 22.13 或更新版本；Windows 里的 Node 不能替代 WSL 运行时。 |
| `node-pty` 编译或启动失败 | 安装 `build-essential`、`python3`，再执行 `npm rebuild node-pty`。 |
| PowerShell 可以 SSH，但 TAKT 不行 | 在 WSL 的 `~/.ssh` 中配置密钥和主机，再测试 `ssh -o BatchMode=yes my-server`。 |
| Windows 浏览器打不开 3080 | 先在 WSL 内确认 `curl http://127.0.0.1:3080`；然后在 PowerShell 执行 `wsl --shutdown` 并重新打开 Ubuntu。 |
| MCP 隧道始终未就绪 | 检查 `AllowTcpForwarding`、服务器端口冲突并运行 `npm run doctor`，再点界面的隧道自愈。 |
| Syncthing 已安装但离线 | 运行 `syncthing serve --no-browser` 或启用用户服务。不开 22000 也可走中继，直连速度更快。 |
| WSL 提示无法转换某个 Windows PATH | 删除失效的 Windows PATH，或在 `/etc/wsl.conf` 禁用 Windows PATH 导入；通常不影响 TAKT。 |

## 安全说明

- 不要把 `3080`、`18765` 或 Syncthing GUI 的 `8384` 端口暴露到局域网或公网。
- 私钥只放在 `~/.ssh`，权限设为 `0600`；绝不能提交进仓库。
- Linux 节点会在该 SSH 用户的 `~/.claude.json` 中保存 MCP Bearer Token，只连接你信任的账号和主机。
- WSL2 是本机客户端环境；Claude Code 仍运行在配置的 Linux 节点上，默认看到的是该节点的
  系统、文件和出口网络。只有显式调用本机 MCP 工具时才会访问 WSL/Windows 侧能力。
