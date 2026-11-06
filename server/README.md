# Workbench service

`server.js` serves the local UI, SQLite tree, file preview/mutation APIs and WebSocket PTYs. `public/index.html` contains the dependency-free interface; `public/vendor` contains vendored xterm assets.

Windows terminals use `../scripts/ssh-session.js` with ConPTY and system OpenSSH. `native-ssh-session.sh` is retained for macOS/Linux. MCP runs separately in `../mcp-server`.
