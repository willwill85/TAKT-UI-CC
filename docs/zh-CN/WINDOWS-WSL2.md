# Windows + WSL2 部署

TAKT-UI-CC 可以通过 WSL2 在 Windows 上运行：工作台、SSH、`node-pty`、Syncthing
和辅助脚本都运行在 Linux 中，界面则使用 Windows 浏览器打开
<http://127.0.0.1:3080>。

> Swift 原生桌面外壳、Xcode/Apple 设备工具和 Mac App 启动器仍只支持 macOS。常用 MCP
> 能力——Windows 桌面截图、浏览器控制、WSL/PowerShell 命令、同步文件访问、USB/COM
> 枚举——均可通过 WSL2 使用。

English: [docs/WINDOWS-WSL2.md](../WINDOWS-WSL2.md)

## 一键安装（推荐）

如果另一台电脑已经安装并初始化了同名 WSL2 Ubuntu，安装可以在普通 PowerShell 中一次完成。
先把 VPS 私钥复制到新电脑，然后下载并运行仓库内的安装器：

```powershell
$installer = Join-Path $env:TEMP 'install-takt.ps1'
Invoke-WebRequest 'https://raw.githubusercontent.com/willwill85/TAKT-UI-CC/main/scripts/install-windows.ps1' -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer `
  -SshKey 'C:\Users\YOUR_WINDOWS_USER\Downloads\server-key.pem' `
  -SshHost 'server.example.com' `
  -SshUser 'ubuntu' `
  -SshAlias 'takt-vps'
```

脚本会在 WSL 内完成 Linux 依赖、Node.js 22、仓库、SSH 密钥和配置、TAKT 服务、VPS
节点、MCP 隧道与健康检查，并在 Windows 桌面创建 `Start-TAKT.cmd`。私钥会复制到
WSL 的 `~/.ssh` 并设为 `0600`；不会写入仓库。首次 SSH 连接使用
`StrictHostKeyChecking=accept-new` 保存主机密钥，安全要求较高时请先通过 VPS 控制台核对指纹。

常用选项：

- 同一台 VPS 已经执行过远端准备时，加 `-SkipRemoteBootstrap`。
- 远端工作目录不是该 SSH 用户的 `~/work` 时，加 `-RemoteWorkDir '/absolute/path'`。
- 先检查参数但不做任何修改时，加 `-Plan`。
- 仓库或分支不是默认值时，用 `-RepoUrl` 和 `-Branch` 指定；这也适合测试尚未合并的 PR。

全新的 Windows 仍需要一次系统级初始化，这是 Windows 本身无法跨重启自动完成的步骤：用管理员
PowerShell 运行 `wsl --install -d Ubuntu`，按要求重启，打开一次 Ubuntu 创建 Linux 用户，
然后执行上面的一键安装命令。

> **同一 VPS 的多电脑限制：** 同一个 SSH/Claude 用户只能由一台 TAKT 客户端主动接管默认
> MCP 配置。迁移或切换电脑前，先在旧电脑的 WSL 仓库中运行 `bash scripts/stop.sh`，再启动
> 新电脑。两台电脑同时运行会争用远端 MCP 端口，并且最后配置的电脑会更新远端
> `~/.claude.json`。以后切回旧电脑时，先停止新电脑，在旧电脑启动后打开“节点”并保存一次，
> 让该电脑重新写入自己的 MCP Token。这不会向 VPS 暴露 Windows 用户名或本地路径，但两台
> 客户端不能同时控制同一个远端 Claude 配置。

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

## 6. Windows 一键启动

上面的一键安装器会自动在 Windows 桌面创建 `Start-TAKT.cmd`。双击它即可启动 WSL 内的
服务并打开浏览器。

手动安装时，也可以在任意方便的位置创建 `Start-TAKT.cmd`；如果仓库路径不同，请相应修改：

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

## 7. Windows MCP 工具

为了兼容远端已有配置，`mac_*` 工具名保持不变，运行时会自动选择正确的平台实现：

- `mac_screen_capture` 通过 Windows PowerShell 截取真实 Windows 桌面，保存到
  `work/screenshots/`，并以内联图片返回给 Claude。
- `mac_browser_chrome_extract` 自动查找 Windows Chrome 或 Edge。浏览器装在非标准目录时，
  用 `TAKT_CHROMIUM_BIN` 指定可执行文件。
- `mac_browser_open_url` 使用 Windows 默认浏览器打开 URL。
- `mac_host_exec` 默认执行 WSL Bash；传入 `shell: "windows-powershell"` 时直接执行原生
  PowerShell，并把当前工作目录映射为 `\\wsl.localhost` 路径。
- `usb_list_devices_and_ports` 同时列出 Windows PnP/COM 设备与已附加到 WSL 的设备；
  `usb_serial_monitor` 既接受 `/dev/ttyUSB0`，也接受 `COM3`。

工作台中的本机操作也会自动映射到 Windows：打开/定位文件会使用 Windows 默认应用或文件
管理器，“在本机系统终端中打开”会用 Windows Terminal 打开同一个远端 tmux 会话（未安装
Windows Terminal 时回退到 `wsl.exe` 控制台）。状态栏会同时检查 WSL Tailscale CLI 和
Windows Tailscale 网卡。

需要在 WSL 中运行烧录工具时，先用
[usbipd-win](https://learn.microsoft.com/windows/wsl/connect-usb) 把 USB 设备附加到 WSL。
Xcode 和 Apple 设备工具仍只支持 macOS，在 WSL2 调用会返回明确的平台错误。

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
| Windows 截图失败 | 保持 Windows 交互式桌面会话已登录且未锁屏，并确认 WSL 可以运行 `powershell.exe`；没有桌面的服务会话无法截图。 |
| 找不到 Chrome/Edge | 将 `TAKT_CHROMIUM_BIN` 设为 `chrome.exe` 或 `msedge.exe` 的 WSL 路径，再重启 TAKT。 |
| Windows 能看到 USB，但 `/dev` 下没有 | 安装 `usbipd-win`，把设备附加到当前 WSL 发行版，再运行 `usb_list_devices_and_ports`；Windows PnP 枚举本身不需要附加。 |

## 安全说明

- 不要把 `3080`、`18765` 或 Syncthing GUI 的 `8384` 端口暴露到局域网或公网。
- 私钥只放在 `~/.ssh`，权限设为 `0600`；绝不能提交进仓库。
- Linux 节点会在该 SSH 用户的 `~/.claude.json` 中保存 MCP Bearer Token，只连接你信任的账号和主机。
- WSL2 是本机客户端环境；Claude Code 仍运行在配置的 Linux 节点上，默认看到的是该节点的
  系统、文件和出口网络。只有显式调用本机 MCP 工具时才会访问 WSL/Windows 侧能力。
