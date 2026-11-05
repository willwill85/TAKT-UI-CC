# Changelog

## Unreleased — layout cleanup + DockTerm rework

**Layout**
- Tab bar: one compact `终端 | 对话` switch (⌘E) instead of four separate DockTerm toggles; rarely used actions moved into a `⋯` menu; tabs show machine badge + title, middle-click closes.
- One context bar under the tabs for both views (machine · path · status · actions) replaces the CLI hint bar and the DockTerm sub-bar.
- Right panel and status bar use short labels; details moved to tooltips (per-node SSH latency, MCP failures, sync backlog).
- Narrow windows (≤1280px) get slimmer side panels.

**Sidebar with many machines**
- Machine filter is a wrapping chip row (with session counts) instead of a segmented control that silently overflowed; hidden when there is only one machine.
- Fixed project groups being squeezed and clipped when the list overflows (flex-shrink + overflow:hidden).
- The list no longer jumps back to the top on every background refresh.
- Machine sections in the "all machines" view can be folded; "clear filters" link; duplicate "全部" tag chip removed.

**DockTerm (conversation view)**
- Incremental transcript reading: the node returns only bytes appended since the last poll, pre-compacted (tool results/images dropped), and the browser receives deltas (`epoch`/`ver`) — no more 512 KB over SSH every second.
- Full history: older messages page in when scrolling to the top (`/api/chat-history`), with the scroll position anchored.
- Correct transcript resolution: exact Claude project slug (no more showing a sub-project's conversation in the root tab), the Claude process's real cwd and `--session-id`/`-r` flag, transcripts shown by other tabs are excluded, `/clear` is followed. New tabs launch `claude --session-id <tab id>`.
- Status is read from the visible tmux pane only (stale "esc to interrupt" in scrollback no longer pins "working"); permission prompts show the whole dialog (command, diff) and support multi-select and free-text answers.
- Keyed rendering: messages are rendered once and updated by id, so text selection, scroll position and expanded blocks survive polling; reading older messages is never interrupted by auto-scroll; "N 条新消息" jump button.
- New Markdown renderer: fenced code with language + copy, headings inside paragraphs, nested/task lists, quotes, links, tables in a horizontal scroller.
- Composer: optimistic "sending" bubble, Enter delay scaled to paste size (long prompts were sometimes never submitted), Esc only interrupts when Claude is busy, ↑ history never overwrites a draft, confirm before sending to a shell without Claude, number keys answer prompts.
- Adaptive polling (1 s busy / 2 s idle / paused in background), per-tab view mode remembered across reloads.

**Fixes**
- Web terminal no longer duplicates its history on every reconnect; an ended session shows a notice and reconnects on key press.
- macOS app: implement JS `alert/confirm/prompt` panels (previously `confirm()` always returned false, e.g. deleting a session never worked).
- "桌面分屏" button crashed on missing elements.

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
