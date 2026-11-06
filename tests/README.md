# Tests

`platform.test.js` covers Windows mirror paths, quoting, environment and tunnel ownership. `ssh-forwarding.test.js` uses Windows system OpenSSH with an isolated loopback SSH fixture and temporary keys to verify reverse forwarding and reconnect; it is skipped on other platforms.

Run `npm test`; service and desktop integration checks are in `scripts/`. No real server credentials are required or stored.

`dockterm.test.js` exercises incremental/deduplicated messages, tool results across history pages, Windows SSH options and the actual remote Python transcript/image reader against a temporary home. Python 3 is required (`python` on PATH, or `TAKT_PYTHON`). No Claude login or network endpoint is used.

`npm run test:smoke` also verifies mandatory MCP auth even with `TAKT_REQUIRE_MCP_TOKEN=0`, strict Origin checks, sandboxed HTML previews, the project-sync status endpoint, and absence of remote desktop APIs. `npm run test:desktop` checks the real Electron UI and PowerShell, then uses `scripts/dockterm-ui-fixture.js` to verify conversation rendering, Markdown, model display, pasted attachments, sending and view switching without a real Linux node.
