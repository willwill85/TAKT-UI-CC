# Windows installation with WSL2

TAKT-UI-CC can run on Windows through WSL2. The workbench, SSH client, `node-pty`,
Syncthing and helper scripts run inside Linux; the UI opens in a Windows browser at
<http://127.0.0.1:3080>.

> The native Swift desktop shell, Xcode/Apple-device tools and Mac application launchers remain
> macOS-only. Common MCP tools — Windows desktop capture, browser control, WSL/PowerShell command
> execution, synced-file access and USB/COM discovery — work from WSL2.

简体中文版：[docs/zh-CN/WINDOWS-WSL2.md](zh-CN/WINDOWS-WSL2.md)

## One-command installation (recommended)

If the other PC already has an initialized WSL2 Ubuntu distribution with the same name, a normal
PowerShell window can complete the setup in one run. Copy the VPS private key to the new PC, then
download and run the repository installer:

```powershell
$installer = Join-Path $env:TEMP 'install-takt.ps1'
Invoke-WebRequest 'https://raw.githubusercontent.com/willwill85/TAKT-UI-CC/main/scripts/install-windows.ps1' -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer `
  -SshKey 'C:\Users\YOUR_WINDOWS_USER\Downloads\server-key.pem' `
  -SshHost 'server.example.com' `
  -SshUser 'ubuntu' `
  -SshAlias 'takt-vps'
```

The installer sets up the Linux packages, Node.js 22, repository, WSL SSH key and config, TAKT
services, VPS node, MCP tunnel, and health check. It also creates `Start-TAKT.cmd` on the Windows
desktop. The private key is copied into WSL's `~/.ssh` with mode `0600` and is never written to the
repository. The first SSH connection uses `StrictHostKeyChecking=accept-new`; verify the host-key
fingerprint through the VPS console first when your security policy requires it.

Useful options:

- Add `-SkipRemoteBootstrap` when this VPS was already prepared.
- Add `-RemoteWorkDir '/absolute/path'` when the work directory is not the SSH user's `~/work`.
- Add `-Plan` to validate and print the plan without changing anything.
- Use `-RepoUrl` and `-Branch` for a non-default checkout, including an unmerged PR branch.

A completely fresh Windows installation still needs one operating-system initialization that cannot
continue automatically across a reboot: run `wsl --install -d Ubuntu` in elevated PowerShell, reboot
if requested, open Ubuntu once to create its Linux user, then run the installer above.

> **Multiple-PC limit for one VPS:** only one TAKT client should actively own the default MCP setup
> for the same SSH/Claude user. Before moving or switching PCs, run `bash scripts/stop.sh` in the old
> PC's WSL checkout, then start the new PC. Concurrent clients contend for the remote MCP port, and
> the most recently provisioned client updates remote `~/.claude.json`. When switching back, stop the
> new PC, start the old one, then open **Nodes** and save its node once so that its MCP token is written
> again. No Windows username or local path is disclosed to the VPS, but two clients cannot control the
> same remote Claude configuration simultaneously.

## 1. Install WSL2

In an elevated PowerShell window:

```powershell
wsl --install -d Ubuntu
wsl --set-default-version 2
```

Restart Windows if requested, open **Ubuntu**, and create its Linux user. Ubuntu 22.04+
is recommended.

Keep the checkout in the WSL filesystem (for example `~/TAKT-UI-CC`), not under
`/mnt/c`; native npm modules and file watching are faster and more reliable there.

## 2. Install local dependencies

In Ubuntu:

```bash
sudo apt update
sudo apt install -y build-essential curl git lsof openssh-client perl python3 syncthing tmux
```

Install Node.js 22.13 or newer with NodeSource, nvm, or another trusted source, then check:

```bash
node --version
npm --version
```

Ubuntu's older LTS repositories may contain a Node version below the minimum required by
`node:sqlite`, so check the version rather than assuming the distribution package is new enough.

## 3. Configure SSH inside WSL

TAKT uses the Linux `ssh` command inside WSL. Its key and `~/.ssh/config` must therefore be
available inside WSL even if Windows OpenSSH is already configured.

For a PEM key stored in Windows:

```bash
install -d -m 700 ~/.ssh
install -m 600 /mnt/c/Users/YOUR_WINDOWS_USER/Downloads/server-key.pem ~/.ssh/server-key.pem
```

Create `~/.ssh/config`:

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

The last command must print `ok` without asking for a password or host confirmation. Copying
the key into WSL and applying mode `0600` also avoids Windows/DrvFS permission errors.

## 4. Prepare the Linux node

From the checkout, run:

```bash
ssh my-server 'bash -s' < scripts/remote-bootstrap.sh
```

Install Claude Code for the same SSH user and log in once. The server's SSH daemon must permit
remote TCP forwarding because the MCP endpoint uses `ssh -R`. Most distributions allow it by
default. If the status remains **MCP tunnel disconnected**, check the effective sshd setting and,
for this dedicated account only, allow remote forwarding:

```text
Match User YOUR_SSH_USER
    AllowTcpForwarding remote
```

Place that in an sshd drop-in, run `sudo sshd -t`, then reload sshd. Do not weaken forwarding
policy for unrelated accounts.

## 5. Install and start TAKT

```bash
git clone https://github.com/willwill85/TAKT-UI-CC.git
cd TAKT-UI-CC
bash scripts/install.sh
bash scripts/start.sh
```

Open <http://127.0.0.1:3080> in Windows. WSL2 forwards Windows localhost to the Linux service;
no public firewall port is needed. Both the UI and MCP server remain bound to loopback.

Click **节点 (Nodes)**, choose the host from `~/.ssh/config`, enable it, and save. Provisioning
creates the local mirror, configures the authenticated reverse MCP tunnel, discovers the remote
work directory, and pairs Syncthing when it is installed on both machines.

Run the health check at any time:

```bash
npm run doctor
```

## 6. Windows launcher

The one-command installer above creates `Start-TAKT.cmd` on the Windows desktop automatically.
Double-click it to start the WSL services and open the browser.

For a manual installation, create `Start-TAKT.cmd` anywhere convenient and adjust the checkout path
if needed:

```bat
@echo off
wsl.exe -d Ubuntu -- bash -lc "cd ~/TAKT-UI-CC && bash scripts/start.sh"
if errorlevel 1 (
  pause
  exit /b 1
)
start "" "http://127.0.0.1:3080"
```

The script is idempotent; running it again reports that existing services are already running.

## 7. MCP tools on Windows

Existing `mac_*` names are kept so remote Claude configurations remain compatible. Their runtime
is selected automatically:

- `mac_screen_capture` captures the real Windows desktop with Windows PowerShell, saves it under
  `work/screenshots/`, and returns the image inline to Claude.
- `mac_browser_chrome_extract` discovers Windows Chrome or Edge. Set `TAKT_CHROMIUM_BIN` if the
  browser is installed in a non-standard location.
- `mac_browser_open_url` opens the Windows default browser.
- `mac_host_exec` runs WSL Bash by default. Pass `shell: "windows-powershell"` to run native
  PowerShell with the current work folder mapped to its `\\wsl.localhost` path.
- `usb_list_devices_and_ports` reports both Windows PnP/COM devices and devices attached to WSL.
  `usb_serial_monitor` accepts a WSL path such as `/dev/ttyUSB0` or a Windows name such as `COM3`.

The workbench also maps host UI actions to Windows: opening or revealing a file uses its default
Windows application or Explorer, and “open in system terminal” launches the same remote tmux session
in Windows Terminal (with a `wsl.exe` console fallback). The status bar checks both a WSL Tailscale
CLI and the Windows Tailscale network adapter.

For Linux-native flashing tools, attach the USB device to WSL first with
[usbipd-win](https://learn.microsoft.com/windows/wsl/connect-usb). Xcode and Apple-device tools
remain macOS-only and return an explicit platform error on WSL2.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `node:sqlite` missing | Install Node.js 22.13 or newer inside WSL. Windows Node does not satisfy the WSL runtime. |
| `node-pty` fails to build or spawn | Install `build-essential` and `python3`, then run `npm rebuild node-pty`. |
| SSH works in PowerShell but not TAKT | Configure the key and host in WSL's `~/.ssh`, then test `ssh -o BatchMode=yes my-server`. |
| Browser cannot open port 3080 | Confirm `curl http://127.0.0.1:3080` works inside WSL, then run `wsl --shutdown` in PowerShell and start Ubuntu again. |
| MCP tunnel never becomes ready | Check `AllowTcpForwarding`, a port conflict on the server, and `npm run doctor`; then use the UI's tunnel self-heal button. |
| Syncthing is installed but idle/offline | Run `syncthing serve --no-browser`, or enable its user service. Relays work without opening port 22000; a direct connection is faster. |
| WSL reports a failed Windows PATH translation | Remove the stale Windows PATH entry or disable Windows PATH import in `/etc/wsl.conf`; it does not normally block TAKT. |
| Windows screenshot fails | Keep an interactive Windows desktop session unlocked and confirm `powershell.exe` can run from WSL. Remote/service sessions without a desktop cannot be captured. |
| Chrome/Edge is not found | Set `TAKT_CHROMIUM_BIN` to the WSL path of `chrome.exe` or `msedge.exe`, then restart TAKT. |
| A USB device is visible in Windows but missing under `/dev` | Install `usbipd-win`, attach the device to the WSL distribution, then rerun `usb_list_devices_and_ports`. Windows PnP enumeration does not require attachment. |

## Security notes

- Do not expose ports `3080`, `18765`, or Syncthing's GUI port `8384` to the LAN or internet.
- Keep private keys inside `~/.ssh` with mode `0600`; never commit them to the repository.
- A connected Linux node receives the MCP bearer token in that SSH user's `~/.claude.json`.
  Connect only accounts and machines you trust.
- WSL2 is the local client environment. Claude Code still runs on the configured Linux node and
  sees that node's OS, files and outbound network unless you deliberately invoke a local MCP tool.
