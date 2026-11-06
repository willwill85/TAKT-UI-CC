# Windows 11 使用与交付

版本：1.2.1；构建日期：2026-11-06。目标：Windows 11 x64。

## 安装与启动

推荐运行 `dist/windows/TAKT-UI-CC-Setup-1.2.1-x64.exe`，安装时可选择目录并创建桌面/开始菜单快捷方式。也可双击便携版 `TAKT-UI-CC-1.2.1-win-x64.exe`。

安装包包含 Electron、Node.js 和 Windows node-pty/ConPTY 运行时，不需要 WSL、Git Bash 或另装 Node.js。SSH 使用 Windows 的 OpenSSH 客户端；本机目标软件、Syncthing、Tailscale 均独立安装。安装包未配置代码签名证书。

源码运行需要 Node.js ≥22.13 和 npm。在项目目录双击 `start-windows.cmd`，首次启动会安装锁定的依赖；也可执行：

```powershell
git clone https://github.com/willwill85/TAKT-UI-CC.git
cd TAKT-UI-CC
npm ci
npm run desktop
```

仅启动浏览器版：

```powershell
npm run start:all
Start-Process http://127.0.0.1:3080
npm run doctor
npm run stop
```

桌面版自主管理自己的工作台、MCP 和隧道，退出窗口时清理本机子进程；远端 tmux 会话继续保留。不要同时启动使用同一 MCP 端口的桌面与浏览器实例；冲突会明确报错。桌面工作台默认选择空闲端口，MCP 默认仍为 18765，以便服务器配置保持稳定。

## 连接 Linux 服务器

1. 确认 Windows 的 `ssh -V` 可用；缺失时在 Windows“可选功能”中安装 **OpenSSH 客户端**。
2. 配置 `%USERPROFILE%\.ssh\config`：

```sshconfig
Host my-server
    HostName 192.168.1.50
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 30
```

3. 在本机终端运行 `ssh my-server`，核对首次连接的主机指纹并完成密钥登录设置。随后确认 `ssh -o BatchMode=yes my-server "echo ok"` 无需交互即可成功。
4. Linux 需要 `tmux`、`python3`、`curl`，以及已安装并登录的 Claude Code。远端仍是 Linux，不需要把 Claude Code 安装到本机 Windows。
5. 打开工作台的“节点”，选择 SSH 别名并保存。项目会写入远端 Claude MCP 配置并启动专用反向隧道；终端标签通过 ConPTY → Windows OpenSSH → Linux tmux 工作。
6. 在远端终端执行 `claude`，使用 `/mcp` 检查 `mac-industrial`。工具名称为兼容旧配置而保留，实际操作的是本机 Windows。

“本机终端”直接打开 PowerShell，方便检查 SSH/工具，且不依赖服务器。普通项目终端仍连接远端 Linux。关闭本机终端不会结束远端 tmux；显式关闭远端标签仍按原逻辑结束对应 tmux 会话。

## Tailscale 独立组网

分别在 Windows 和服务器安装 Tailscale，完成加入同一 tailnet 的授权，然后将 SSH 配置中的 `HostName` 换为服务器的 Tailscale IP 或 MagicDNS 名称。项目不安装、不登录、不更改 Tailscale 配置；仅展示检测状态。

MCP 链路为：远端 Claude → 服务器回环端口 → SSH 反向隧道（可走 Tailscale）→ Windows 回环 MCP 服务。无需把 MCP 端口开放到局域网或公网。

## 文件同步

### 对话视图（2026-11-05 上游整合）

远端 Claude 标签页可在“终端 / 对话”之间切换（Windows 快捷键 Ctrl+Shift+E）。对话模式支持增量历史、权限确认、图片、文件链接、粘贴/拖拽附件及模型/effort 切换；本机 PowerShell 标签页保持终端模式。

附件通过 Windows OpenSSH 上传到远端会话目录的 `.takt/uploads/`，预览优先读取本地项目映射，尚未同步或工作区外的文件按需通过 SSH 缓存。文本文件使用记事本打开；可执行及未知文件只定位。MCP 始终要求 Token，`TAKT_REQUIRE_MCP_TOKEN=0` 不会关闭鉴权。此次整合不包含远程桌面或 VNC 功能。

### 直接同步已有本地项目

左上角点击“同步本地项目”，选择节点和已有本地目录，填写服务器工作区下的新项目名称，再确认暂停原 work 整目录同步。原目录直接参与双向同步，无需复制到本机 work。服务器目标必须尚不存在，已有同步文件夹或项目路径重叠会被拒绝。

首次添加会暂停两端原 work 同步，保留文件及原配置，其他原 work 文件暂时停止同步。后续可继续添加多个独立项目。每次修改前的文件夹配置保存于 `%USERPROFILE%\.takt-ai\sync-backups`；失败会尝试删除本次新配置并恢复原文件夹配置，失败信息会注明回滚是否完成。不要手动恢复原整目录同步，否则会与项目级目录重叠。

项目配置会写入 nodes.json 的 projectMappings；文件树、预览、路径注入和远端终端均使用原本地路径对应服务器项目路径。同步包含修改和删除，界面会列出已配置的项目。目录选择也支持直接输入完整路径。

右键独立同步项目，选择“移除项目（保留文件）”，可以解除两端该文件夹的 Syncthing 配置并从 TAKT 列表移除。需先关闭项目终端；work 根目录不能移除。移除过程备份两端配置并在失败时尝试回滚。项目文件保留，Syncthing 自身的文件夹标记可能由服务清理。原整目录同步保持暂停；保留的远端目录不会被后台扫描重新添加到列表。

文件预览读取本机镜像，默认位于 `%USERPROFILE%\.takt-ai\work`、`work2` 等。需要两端同步时分别安装并运行 Syncthing；Windows 默认从 `%LOCALAPPDATA%\Syncthing\config.xml` 读取配置，也可设置 `TAKT_SYNCTHING_CONFIG`。两端运行后，保存节点会尝试自动配对设备与同步目录。

未安装 Syncthing 不影响 SSH/MCP，但不会自动获得服务器文件镜像。文件拖到远端终端时映射为 Linux 路径；拖到本机终端时保留 Windows 路径并按 PowerShell 引号规则处理。

## Windows MCP 工具

Windows 提供 21 个工具，隐藏 Xcode 的两个 macOS 专用工具。

| 功能 | Windows 实现 / 依赖 |
|---|---|
| 本机命令 | Windows PowerShell；`mac_host_exec` 输入使用 PowerShell 语法，默认要求 Claude 询问权限 |
| USB 与串口 | CIM 枚举 USB/COM，.NET SerialPort 读写 COM 口；占用或缺失时返回错误 |
| 截图 | .NET System.Drawing；支持区域、尺寸限制与 MCP 内联 PNG |
| 浏览器 | 系统默认浏览器；页面提取使用 Chrome，未找到时尝试 Edge |
| Blender / FreeCAD | Windows 程序，支持常见安装目录自动发现和环境变量覆盖 |
| 嘉立创EDA | 设置 Windows 程序路径；API 桥另行安装，项目可连接已有桥 |
| ESP32 / J-Link / DFU | 安装相应 Windows 工具与设备驱动；esptool 使用 Python 模块；ESP-IDF 指定 export.ps1 |

可在 `%USERPROFILE%\.takt-ai\env` 中按需设置（只解析 KEY=value，不执行脚本）：

```text
TAKT_PYTHON=C:\Python312\python.exe
TAKT_BLENDER_BIN=C:\Program Files\Blender Foundation\Blender 4.5\blender.exe
TAKT_FREECAD_CMD=C:\Program Files\FreeCAD 1.0\bin\FreeCADCmd.exe
TAKT_FREECAD_GUI=C:\Program Files\FreeCAD 1.0\bin\FreeCAD.exe
TAKT_EASYEDA_EXE=D:\Applications\EasyEDA\EasyEDA.exe
TAKT_IDF_EXPORT_PS1=C:\Espressif\frameworks\esp-idf\export.ps1
TAKT_JLINK_EXE=C:\Program Files\SEGGER\JLink\JLink.exe
```

还支持 `TAKT_CHROME_BIN`、`TAKT_DFU_UTIL`、`TAKT_TAILSCALE_BIN`、`TAKT_SSH_BIN`。示例路径需换成实际安装路径；可选软件未安装时，相应功能不可用。

## 数据与安全

节点、SQLite、Token、日志和镜像都放在 `%USERPROFILE%\.takt-ai`，可通过 `TAKT_HOME` 改变；卸载应用不删除此目录。Token 首次生成时通过 NTFS ACL 限制为当前用户访问，Linux 上写入的 Claude 配置也设为 0600。服务保持默认回环监听与 Bearer 鉴权。Electron 开启 sandbox 和 context isolation，不向页面暴露 Node.js。

## 开发、打包与验证

```powershell
npm run check
npm run lint
npm test
npm run test:smoke
node scripts/desktop-smoke.js
npm run build:windows
node scripts/desktop-smoke.js "E:\路径\dist\windows\win-unpacked\TAKT-UI-CC.exe"
```

打包使用当前执行构建命令的 Node.js x64 作为独立后端运行时，复制生产依赖闭包到 `resources/backend/node_modules`，不进行 Electron ABI 重编译，不复制个人凭据或运行数据。afterPack 会使用内置 Node 验证依赖存在且从包内解析；缺失时立即终止构建。桌面测试会把解包目录复制到临时目录，避免意外使用源码目录中的依赖。产物在 `dist/windows`。

验证报告与截图输出到忽略的 `build/`：`smoke-result.json`、`desktop-result.json`、`windows-desktop.png`。SSH 自动化测试使用本机临时 SSH 服务验证真实 Windows OpenSSH 的反向 HTTP 转发、断线重连与进程回收；它不代表真实 Linux/Claude 或硬件设备已验收。

## 常见问题

| 现象 | 处理 |
|---|---|
| 首次 SSH 失败 | 先在“本机终端”执行普通 `ssh my-server` 完成指纹确认，检查密钥与服务端账号 |
| 提示私钥权限过宽 | 修正私钥 NTFS ACL，使其仅对密钥所有者与受信任管理员可读 |
| MCP 端口被占用 | 退出另一个实例；或为不同实例设置不同 TAKT_HOME/TAKT_MCP_PORT/TAKT_EDA_PORT |
| Tailscale 显示待机 | 检查独立客户端；直接使用局域网 SSH 时不影响工作 |
| 文件树为空 | 确认两端 Syncthing 正在运行并已同步；预览不通过 SSH 即时下载 |
| PowerShell 命令报语法错误 | Windows 本机命令使用 PowerShell 语法，远端 Linux 终端使用 Linux shell 语法 |
