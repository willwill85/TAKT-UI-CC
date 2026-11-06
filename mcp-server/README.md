# Local MCP service

`server.js` owns the JSON-RPC/SSE endpoints, node context, bridge watchdog and SSH tunnels. `windows-tools.js` implements Windows-specific command, browser/app launch, screenshot, USB/COM and flashing adapters; common CAD/EDA/browser operations reuse the shared executor with platform paths.

MCP remains loopback-bound and token-protected. Tool names retain the `mac_` prefix for compatibility; Windows lists 21 tools and excludes Xcode. See [Windows guide](../docs/WINDOWS11.md) and [tool reference](../docs/MCP-TOOLS.md).
