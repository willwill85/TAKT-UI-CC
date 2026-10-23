# Configuration

All settings are optional — defaults work out of the box. Set variables in your shell, or (recommended) put `KEY=value` lines into **`$TAKT_HOME/env`** (default `~/.takt-ai/env`); `scripts/start.sh` and the desktop app load it.

## Environment variables

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `TAKT_HOME` | `~/.takt-ai` | all | Data directory (see layout below) |
| `TAKT_PORT` (or `PORT`) | `3080` | workbench, desktop app | Web UI / REST / WebSocket port. Always bound to `127.0.0.1`. |
| `TAKT_MCP_PORT` (or `MAC_MCP_PORT`) | `18765` | MCP server, tunnels | Local MCP port; the same number is forwarded on every server (`ssh -R`). |
| `TAKT_MCP_HOST` | `127.0.0.1` | MCP server | Bind address. **Do not change** unless you fully understand [the risk](SECURITY.md). |
| `TAKT_MCP_TOKEN` | *(generated)* | MCP server, provisioning | Override the bearer token instead of using `$TAKT_HOME/mcp-token`. |
| `TAKT_EDA_PORT` | `49620` | MCP server, tunnels | First port of the optional EasyEDA bridge range (`+0…+9`); also forwarded to servers. |
| `TAKT_AUTO_ALLOW_HOST_EXEC` | unset | provisioning | `1` → write an *allow* rule for `mac_host_exec` on servers instead of *ask*. |
| `TAKT_WORKSPACE_LINK_DIR` | unset | workbench | If set, `<alias> → <local work dir>` symlinks are created in this folder (handy to open mirrors from an IDE workspace). |
| `TAKT_SYNCTHING_URL` | `http://127.0.0.1:8384` | workbench, MCP server | Local Syncthing REST endpoint. |
| `TAKT_SYNCTHING_CONFIG` | auto-detect | workbench, MCP server | Path to Syncthing's `config.xml` (API key is read from it). Auto-detect order: `~/Library/Application Support/Syncthing`, `~/.local/state/syncthing`, `~/.config/syncthing`. |
| `TAKT_NODE` | `node` on `PATH` | scripts | Node.js binary (≥ 22.13) used by `scripts/*.sh`. |
| `TAKT_REPO` | from `Info.plist` | desktop app | Override the checkout the app launches scripts from. |
| `TAKT_EASYEDA_BRIDGE` | unset | MCP server | Path to an EasyEDA/JLC EDA `bridge-server.mjs` to auto-start (also looks in `~/.claude/skills/easyeda-api/scripts` and `$TAKT_HOME/easyeda-api/scripts`). |
| `TAKT_IDF_EXPORT` | `~/esp/esp-idf/export.sh` | MCP `hardware_flash_firmware` (idf_py) | ESP-IDF environment script. |
| `TAKT_ESP_PYTHON_ENV` | `~/.espressif/python_env/idf5.1_py3.9_env` | MCP `hardware_flash_firmware` (esptool) | ESP-IDF Python venv containing `esptool.py`. |

## `$TAKT_HOME` layout

```
~/.takt-ai/
├── env                        optional KEY=value overrides
├── nodes.json                 machines (see ARCHITECTURE.md)
├── mcp-token                  bearer token for /mcp (mode 0600) — created on first start
├── takt-workbench.sqlite      projects, sessions, tags, node status (+ -wal/-shm files)
├── session-titles.json        custom conversation titles (legacy mirror of renames)
├── work/  work2/  work3/ …    local mirror of each node's remote work dir
├── logs/                      workbench.log, mcp-server.log
└── run/                       pid files
```

Back up `nodes.json` and `takt-workbench.sqlite` to carry your setup (tags, names) to another Mac. `work*/` are only copies of the servers' files.

## `nodes.json`

Normally edited through the UI ("节点"). Fields:

| Field | Meaning |
|---|---|
| `id` | Stable id. First node `node-1`; others `linux-<random>`. |
| `name`, `badge` | Display name and the short badge shown in the sidebar (`HOME`, `GPU`…). |
| `sshHost` | Alias or `user@host` understood by your `ssh`. Empty = node not connected yet. |
| `remoteWorkDir` | Directory on the server that contains your project folders. Auto-corrected for non-root users. |
| `localWorkDir`, `localWorkAlias` | Local mirror folder and its short name (`work`, `work2`…). |
| `syncthingFolderId`, `syncthingDeviceId` | Syncthing folder id (same on both sides) and the server's device id (auto-detected). |
| `enabled` | `false` pauses scanning, tunnel and probes for this node. |

See [`examples/nodes.example.json`](../examples/nodes.example.json).

## Ports

| Port | Where | Purpose |
|---|---|---|
| 3080 | Mac, loopback | Workbench UI/API |
| 18765 | Mac loopback **and** each server's loopback (via `ssh -R`) | MCP |
| 49620–49629 | same | Optional EasyEDA bridge |
| 8384 / 22000 | Syncthing | GUI+REST (loopback) / sync traffic (open 22000 on servers for direct connections) |

Run several instances side by side (e.g. for testing) by changing `TAKT_HOME`, `TAKT_PORT`, `TAKT_MCP_PORT` **and** `TAKT_EDA_PORT`.
