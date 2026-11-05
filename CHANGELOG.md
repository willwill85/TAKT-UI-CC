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

**DockTerm: images, files, usage, model**
- Images in the conversation are shown inline: pasted screenshots (read from the node's transcript on demand and cached on the Mac), images returned by tools (e.g. `Read` of a PNG, screenshot MCP tools), `![](path)` and image paths mentioned in replies. Click for a full-size viewer.
- File paths in replies, user messages and tool rows (`Read`/`Edit`/`Write`) are links: click previews on the right, ⌘-click opens with the Mac app, ⌥-click reveals in Finder; CAD/EDA/office files open in their app directly.
- Everything is previewed/opened from the Mac's disk: the Syncthing mirror when the file is there, otherwise a one-time SSH copy into `~/.takt-ai/cache` (re-used while size/mtime are unchanged, pruned after 7 days). `open` only launches documents; code opens in the text editor; anything executable is only revealed.
- Usage (5-hour + weekly, like `/usage`) as two small rings inside the composer (yellow ≥ 75, red ≥ 90): fetched by the node from Anthropic's usage endpoint with its own Claude login when the conversation view opens and every 10 minutes — nothing is typed into the terminal and the token never leaves the node.
- Model + effort switch under the composer: shows what the conversation is actually using (from the latest reply), the model list (with supported effort levels) is fetched once per node; switching runs `/model` / `/effort` in that session, refused while Claude is busy.

**DockTerm: attachments, typing while Claude works, sidebar**
- Paste (⌘V) or drop images and files into the conversation: they appear as chips above the input (image thumbnails, file type + size, × to remove, click a failed one to retry) and upload immediately over SSH to `<session cwd>/.takt/uploads/` (git-ignored via a `*` .gitignore). Sending appends their paths so Claude reads them; sent messages show the attachments instead of the raw paths. Rich text that only carries a rendered picture (Excel, Word) still pastes as text.
- Typing while Claude works: the macOS app no longer moves keyboard focus to the hidden native terminal when the conversation view sends input (conversation input now goes through tmux on the node; the Swift side only focuses a visible terminal). Messages sent while Claude works are marked "排队中"; sending is held back while a permission prompt is open.
- Terminal-output image cards no longer pop up over the conversation view, and paths with dotted folders (`.takt/uploads`, `.cache`) are recognised.
- Sidebar hides sessions that never got a real title (opened but never used: "会话 1a2b3c4d", "<project> · 终端" …); they appear with their first prompt as title once used. Renamed sessions always show; Claude Code's own `ai-title` is used when a session has no text prompt.

**DockTerm: stuck "Pasting…", stale "排队中", menus under the terminal**
- Attachments are sent as `[附件] <path>` lines. A bare image path on its own line made Claude Code inline the image: it looks up the clipboard (`xclip -o`, which hangs forever on nodes where `xclip` is a copy-only shim, leaving "Pasting…" on screen) and drops any Enter that arrives meanwhile, so the message was never sent. Old messages with bare paths still render as attachments.
- Submitting a paste waits on the node until Claude Code's "Pasting…" footer is gone before pressing Enter; if it never clears (8 s), Enter is left out and the bubble turns red ("没有提交 · Claude Code 停在「Pasting…」") instead of pretending to be queued.
- Messages typed while Claude works are mostly handed over mid-turn as `queued_command` records, not user records: they are now shown in the conversation and clear their "排队中" bubble. A bubble that still has no transcript entry after Claude has been idle for 8 s is removed with a hint to look at the terminal.
- Attachments upload into the folder the Claude process actually runs in (falls back to the tab's folder), so Claude can read them without a permission prompt.
- Tag and ⋯ menus open at the top level of the page; menus from the sidebar stay inside the sidebar, and any dialog (incl. appearance settings) or menu that overlaps the macOS app's native terminal hides it while open — HTML can't be drawn over that native view.
- Machines in the sidebar (filter chips, machine headers) use a small server icon with a status dot instead of a plain dot, so they no longer look like project tags.

**DockTerm: prompt suggestions**
- Claude Code's prompt suggestion (the grey "what you'd type next" in the terminal's input box) shows up in the conversation view as the composer's placeholder with a `Tab 填入` badge: Tab (or a click on the badge) fills it in, Enter sends it as usual. It is read from the input row of the visible tmux pane (Claude Code keeps it only on screen), only while Claude waits for input; Claude Code's own `Try "…"` / queue hints are not taken for suggestions, and a sent suggestion never reappears.

**Security**
- Restored the documented Host/Origin guard (HTTP + WebSocket) that went missing in `efd9650`: web pages can no longer drive the workbench API or type into terminals.
- HTML/SVG previews are served with a CSP sandbox so a page from a node can't call the workbench API.

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
