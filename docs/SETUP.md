# Setup guide

This guide takes you from zero to a working multi-machine workbench. Estimated time: 10 minutes per server.

> 简体中文版: [docs/zh-CN/SETUP.md](zh-CN/SETUP.md)

## 0. What you need

| Where | Requirement |
|---|---|
| Your Mac | macOS 13+, **Node.js ≥ 22.13**, `ssh`, Xcode CLT (`xcode-select --install`). Optional: Syncthing. |
| Each Linux server | an SSH account, `tmux`, `python3`, `curl`, **Claude Code**. Optional: `syncthing`. |
| Network | Your Mac must be able to `ssh` to the server. If the server is behind NAT, use a VPN/overlay such as [Tailscale](https://tailscale.com) and put the Tailscale IP in `~/.ssh/config`. |

## 1. SSH access

TAKT drives everything through your normal `ssh` client, so a host entry in `~/.ssh/config` with **key-based, non-interactive** login is the only hard requirement.

```sshconfig
# ~/.ssh/config
Host my-server
    HostName 203.0.113.10        # or a Tailscale / LAN address
    User root                    # or your normal user
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 30
```

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub my-server      # one-time: install your public key
ssh -o BatchMode=yes my-server 'echo ok'            # must print "ok" without asking for a password
```

> Non-root users work too. If the default remote work dir `/root/work` is not writable, TAKT automatically falls back to `~/Documents/work` or `~/work` and records the real path.

## 2. Prepare the Linux server

Run the helper once per server (installs `tmux`, `python3`, `curl`, `syncthing` and enables Syncthing as a user service):

```bash
ssh my-server 'bash -s' < scripts/remote-bootstrap.sh
```

Then install **Claude Code** for the SSH user (see the [official docs](https://docs.claude.com/claude-code)) and log in once (`claude`). The script ends with a ✔/✘ checklist.

## 3. Install and start the client

```bash
git clone https://github.com/willwill85/TAKT-UI-CC.git
cd TAKT-UI-CC
bash scripts/install.sh      # prerequisite check + npm install + node-pty sanity test
bash scripts/start.sh        # workbench :3080 + MCP server :18765 (+ Syncthing via brew if installed)
```

Open <http://127.0.0.1:3080>. The first start shows an empty "Linux 节点 1" with the status bar message **"未绑定 SSH 节点"** (no SSH node bound yet) — that is expected.

### Optional: native macOS app

```bash
bash scripts/build-app.sh
cp -R build/TAKT-UI-CC.app /Applications/
```

First launch: right-click → **Open** (ad-hoc signed). The app launches `scripts/start.sh` itself, so you can just double-click it afterwards. It remembers the checkout it was built from (`TAKTRepoPath` in its `Info.plist`); if you move the repo, rebuild.

## 4. Connect your first server

1. Click the **节点 (Nodes)** button (server icon, top-left). The dialog lists the hosts it found in `~/.ssh/config`.
2. For the first node, edit "Linux 节点 1": choose the SSH host, give it a name/badge (e.g. `HOME`), keep or change the remote work dir, make sure **enabled** is ticked, **Save**.
3. TAKT now provisions the node automatically — you will see a log like:
   - local folder `~/.takt-ai/work` created
   - Mac Syncthing folder registered
   - **MCP reverse tunnel** established (`ssh -R 18765…`)
   - remote `~/.claude.json` gets the `mac-industrial` MCP server (with token), remote `~/.claude/settings.json` gets permission rules
   - **Syncthing paired in both directions** (Mac trusts the node, node trusts the Mac, same folder id)
4. The status bar turns green: SSH (latency) · Tailscale · MCP tunnel · Syncthing.

Add more servers the same way — each gets its own local folder (`work2`, `work3`, …), Syncthing folder (`takt-work2`, …) and tunnel. The sidebar's machine switch (`全部 / HOME / GPU …`) filters by machine.

## 5. Daily use

- **Projects** are folders directly under the node's work dir. Create one with the folder-plus icon (top-left).
- **Open a terminal**: hover a project → **＋**. A tmux session `takt_<tab>` is created on the server in that folder.
- **Run Claude**: press **注入终端** in the bar above the terminal; it types `claude` (or `claude -r <session-id>` when you opened an existing conversation). TAKT never starts Claude by itself.
- **Resume**: click any conversation in the sidebar. Close the app any time — the tmux session keeps running on the server.
- **Rename / delete** a conversation: hover it → pencil / trash. Renames are also written into the session's `.jsonl` on the server so they survive.
- **Tags**: `＋ 标签` creates a tag; hover a project → tag icon (or right-click) to assign; click a chip to filter. Right-click / double-click a chip to edit or delete it.
- **Files**: the right pane shows the *local mirror* of the active project. Drag a file from the tree into the terminal to paste its path, or drop files from Finder into the tree to upload (they sync to the server).

## 6. Using the MCP tools from Claude

On a connected server, start `claude` and run `/mcp` — you should see **mac-industrial** connected (23 tools). Ask for things like *"render this .blend with Metal and save the PNG"* or *"list my USB serial ports"*. Tool reference: [MCP-TOOLS.md](MCP-TOOLS.md).

The tool `mac_host_exec` (arbitrary shell on your Mac) is set to **ask** — Claude requests approval each time. To pre-approve it, add `TAKT_AUTO_ALLOW_HOST_EXEC=1` to `~/.takt-ai/env`, restart the workbench and re-save the node (the rule is written to the server when a node is saved).

## Troubleshooting

Run `npm run doctor` first — it checks the local install and every node.

| Symptom | Likely cause / fix |
|---|---|
| `posix_spawnp failed` when opening a terminal | `node-pty`'s helper lost its executable bit: `node scripts/postinstall.js` (runs automatically after `npm install`). If it persists: `npm rebuild node-pty`. |
| `Node.js >= 22.13 not found` / `node:sqlite` missing | Install a newer Node (`brew install node`); older versions lack stable `node:sqlite`. Point to a specific binary with `TAKT_NODE=/path/to/node`. |
| Terminal shows "连续 N 次无法连接" | `ssh <host>` doesn't work non-interactively. Fix keys/`~/.ssh/config`/VPN, then press Enter in the terminal. |
| Status bar: **SSH 断开** but you can ssh manually | A VPN/proxy with TUN mode (Clash, Surge…) may hijack port 22. Test with `ssh -o ProxyCommand=none host` or exclude the host's address from the TUN. |
| Node shows offline right after adding | The scan runs a small `python3` snippet over ssh, so the server needs `python3`. Run `npm run doctor`. For non-root users the remote work dir is auto-corrected on the first scan. |
| **MCP 隧道断开** | The watchdog rebuilds the tunnel every ≤15 s. If it never recovers: another process holds `127.0.0.1:18765` on the server (`ss -tlnp 'sport = :18765'`), or `sshd` has `AllowTcpForwarding no`. Click **隧道自愈** in the status bar. |
| `/mcp` in Claude says *Unauthorized* | Token mismatch. Re-save the node (re-writes `~/.claude.json` with the current token from `~/.takt-ai/mcp-token`). |
| Syncthing never connects | Both machines need Syncthing **running** (`brew services start syncthing`; `systemctl --user enable --now syncthing`). If the server's firewall blocks TCP **22000**, Syncthing falls back to relays (slower) — open the port for best speed. |
| Sidebar shows fewer conversations than expected | Only conversations whose `cwd` is inside the node's work dir are listed, grouped by the top-level project folder. Conversations started elsewhere (e.g. `/tmp`) are ignored. |
| Everything lost after upgrading | Data lives in `~/.takt-ai` (SQLite + `nodes.json`); upgrades never touch it. |

Logs: `~/.takt-ai/logs/workbench.log`, `~/.takt-ai/logs/mcp-server.log`.

## Updating

```bash
git pull
npm install
bash scripts/stop.sh && bash scripts/start.sh
```

## Uninstalling

```bash
bash scripts/stop.sh
rm -rf ~/.takt-ai            # all local data (work mirrors included! they are copies, servers keep the originals)
```

On each server, remove the `mac-industrial` entry from `~/.claude.json` and the `mcp__mac-industrial*` rules from `~/.claude/settings.json` if you no longer want them.
