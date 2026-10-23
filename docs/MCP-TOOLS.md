# MCP tools

The local MCP server (`mcp-server/server.js`) exposes **23 tools** to Claude Code running on your servers. Server name in Claude: `mac-industrial` (tools appear as `mcp__mac-industrial__<tool>`).

Every tool is **optional and degrades gracefully**: if the application isn't installed, the call returns an error message and nothing else is affected. Paths under a node's remote work dir (e.g. `/home/dev/work/part.step`) are translated to that node's local mirror automatically, and outputs written into the mirror sync back to the server.

> All tools run **as you, on your Mac**. Treat them like handing Claude a terminal on your laptop. See [SECURITY.md](SECURITY.md).

| Group | Tool | What it does | Needs |
|---|---|---|---|
| **Blender** | `blender_run_python` | Run a headless `bpy` script (inline code or a `.py` in the work dir), optionally on a `.blend` | `/Applications/Blender.app` |
| | `blender_render_image` | Render a `.blend` to PNG with EEVEE or Cycles (Metal GPU) | Blender |
| | `blender_open_gui` | Open Blender's GUI on your desktop | Blender |
| **FreeCAD** | `freecad_run_python` | Headless parametric modelling; exports `.FCStd` / `.step` / `.stl` | `/Applications/FreeCAD.app` |
| | `freecad_inspect_step` | Bounding box, mounting holes, etc. of a `.step` / `.FCStd` | FreeCAD |
| | `freecad_open_gui` | Open FreeCAD GUI | FreeCAD |
| **JLC EDA Pro / EasyEDA** | `jlceda_bridge_status` | Health of the EasyEDA WebSocket bridge, list/select EDA windows | EDA bridge script (`TAKT_EASYEDA_BRIDGE`) |
| | `jlceda_bridge_execute` | Run `eda.*` API JavaScript inside the running EDA client | bridge + running client |
| | `jlceda_inspect_epro` | Parse `.epro`/`.epro2`: schematics, PCBs, BOM, netlist summary | – (pure parsing) |
| | `jlceda_modify_epro` | Unpack → run your Python patch → repack (auto-backup) | – |
| | `jlceda_generate_extension_script` | Generate EDA SDK automation scripts / `.kicad_mod` footprints | – |
| | `jlceda_open_gui` | Launch JLC EDA Pro, optionally with a project | `/Applications/嘉立创EDA(专业版).app` |
| **Browser** | `mac_browser_fetch` | HTTP fetch from *your* network → text/Markdown | – |
| | `mac_browser_chrome_extract` | Render a JS-heavy page in Chrome, return DOM text/HTML | Google Chrome |
| | `mac_browser_open_url` | Open a URL in your default browser | – |
| **Xcode / iPhone** | `xcode_list_devices` | Connected iPhones/iPads/Watches and simulators | Xcode |
| | `xcode_build_and_deploy_iphone` | `xcodebuild` an iOS/macOS project; install + launch on a connected iPhone | Xcode, signing set up |
| **USB / hardware** | `usb_list_devices_and_ports` | USB device tree and `/dev/cu.*` serial ports | – |
| | `usb_serial_monitor` | Read/write a serial port | – |
| | `hardware_flash_firmware` | Flash MCUs: `esptool`, ESP-IDF `idf.py`, SEGGER `JLinkExe`, `dfu-util` | the respective tool (`TAKT_ESP_PYTHON_ENV`, `TAKT_IDF_EXPORT`, `/usr/local/bin/JLinkExe`, `/opt/homebrew/bin/dfu-util`) |
| **Host** | `mac_screen_capture` | Screenshot of the desktop or a window; saved to `<work>/screenshots/` (synced) and returned as an image | Screen Recording permission |
| | `mac_host_exec` | **Run any shell command on your Mac** | – (⚠ see security) |
| | `work_sync_status` | List the local work mirror and project status | – |

## Calling the server by hand

```bash
TOKEN=$(cat ~/.takt-ai/mcp-token)
curl -s http://127.0.0.1:18765/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
```

`/health` needs no token. Add `?node=<node id>` to `/mcp` to get that node's path mapping.

## Adding your own tool

1. Add an entry to the `TOOLS` array in `mcp-server/server.js` (`name`, `description`, JSON-Schema `inputSchema`).
2. Add a `case '<name>':` to `executeTool()` returning a string (or an MCP content block).
3. Restart the MCP server (`bash scripts/stop.sh && bash scripts/start.sh`) and re-open `/mcp` in Claude.

Use `resolveWorkPath(inputPath)` for any path argument so remote paths map to the local mirror.
