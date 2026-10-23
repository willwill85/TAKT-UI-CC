# Security

TAKT-UI-CC connects remote servers to *your* computer. That is powerful, so please understand the trust model.

## Threat model

| Asset | Who can reach it | Protection |
|---|---|---|
| Workbench UI/API (`:3080`) | Local processes and local browsers | Bound to `127.0.0.1`; every request's `Host` must be loopback (blocks DNS rebinding); state-changing requests with a foreign `Origin` are rejected (blocks CSRF from web pages); WebSocket upgrade checks the same. |
| MCP server (`:18765`) | Local processes + connected servers via `ssh -R` | Bound to `127.0.0.1`; `/mcp`, `/messages`, `/sse` need `Authorization: Bearer <token>` (constant-time compare); **no CORS headers**; Host/Origin validation. `/health`, `/system-status`, `/viewer`, `/work/*` are read-only and token-free (they never run code). |
| MCP token | Anyone who can read `~/.takt-ai/mcp-token` (mode 0600) or a node's `~/.claude.json` | Random 192-bit token generated on first start. Rotate by deleting the file, restarting and re-saving each node. |
| `mac_host_exec` | Claude on a connected server, after the permission prompt | Written as an **ask** rule in the server's `~/.claude/settings.json`. Opt-in to auto-approval with `TAKT_AUTO_ALLOW_HOST_EXEC=1`. |
| SSH | Your normal keys | TAKT only shells out to your `ssh`; it stores no passwords or keys. |

## What a connected server can do

A connected node can call every MCP tool: render in Blender, flash firmware, take **screenshots of your screen**, and — if you approve — **run shell commands on your Mac**. Anyone who can log into that server as the SSH user can read the token from `~/.claude.json` and reach `127.0.0.1:18765` on the server, i.e. gets the same capabilities. Consequences:

- Only connect machines and accounts you fully trust.
- Don't connect shared / multi-user servers unless you accept that other users with shell access could use the tunnel (the token is only readable by the SSH user, but root can read everything).
- Keep `mac_host_exec` on **ask** unless you are on a dedicated, trusted box.

## Hardening checklist

- [ ] Keep `TAKT_MCP_HOST` at `127.0.0.1` (the default). `npm run doctor` warns if the MCP port is bound elsewhere.
- [ ] Use key-based SSH with passphrases / an agent; disable password auth on your servers.
- [ ] Give macOS permissions (Screen Recording, Accessibility…) only to the terminals/apps that need them.
- [ ] Review `~/.claude/settings.json` on servers: the `permissions.ask` entry for `mcp__mac-industrial__mac_host_exec` should be present.
- [ ] Don't expose `3080` or `18765` through a reverse proxy, port-forward or tunnel to other machines.
- [ ] Syncthing: the folders are shared only between your Mac and each node. If you let nodes sync with other devices, anything in the work folders can leave your machine.

## Local data

`~/.takt-ai/` contains your project/conversation titles, tags and the MCP token. The work mirrors contain copies of your server files. Nothing is sent to any third party by TAKT itself (it makes no outbound calls besides SSH, Syncthing's local API and the pages you ask `mac_browser_*` to fetch).

## Reporting a vulnerability

Please open a **private security advisory** on GitHub (*Security → Report a vulnerability*) instead of a public issue. Include steps to reproduce; you'll get an answer within a few days.
