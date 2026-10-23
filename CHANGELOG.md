# Changelog

## 1.0.0 — first public release

- Multi-node workbench: any number of Linux hosts, each with its own local mirror folder, Syncthing folder and MCP tunnel.
- Codex-style sidebar: machine switch, projects → conversations, tags with colour filter, "see all" folding, rename/delete.
- Local SQLite state store — the sidebar is served from the database and never loses entries when a server is offline.
- Persistent terminals (ssh + tmux) with auto-reconnect; native SwiftTerm engine in the macOS app, xterm.js/node-pty in the browser.
- Local file mirror with instant preview, drag & drop in/out of the terminal.
- One-click node provisioning including **automatic two-way Syncthing pairing**.
- Local MCP server with 23 tools, reverse-tunnelled to every node; generic multi-node watchdog with tunnel self-heal.
- Security hardening: loopback-only servers, Host/Origin validation, bearer-token auth on MCP, `mac_host_exec` = ask by default.
- Scripts: `install`, `start`, `stop`, `doctor`, `build-app`, `remote-bootstrap`.
