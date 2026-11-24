#!/usr/bin/env node
/**
 * TAKT AI — Multi-Linux Node SSH Terminal Workbench Server
 * ---------------------------------------------------------------------
 * 1. Multi-Linux Node Registry (/Users/will/.takt-ai/nodes.json):
 *    Each Linux server maps to its own isolated Mac local folder (work, work2, work3...),
 *    its own Syncthing folder, and its own dedicated MCP Reverse SSH Tunnel (-R 18765 & -R 49620)
 *    so EVERY Linux server can invoke the Mac's 21 MCP tools (Blender, FreeCAD, 嘉立创EDA, Xcode, Browser).
 * 2. Left Sidebar API: Passively scans all configured Linux servers & local work directories
 *    without touching the `claude` CLI binary, tagging every project and session with its Linux node badge.
 * 3. Center Multi-Tab Terminal WS: Each open conversation tab maps 1:1 to a persistent
 *    SSH + remote `tmux` session on that project's target Linux server.
 * 4. Right Sidebar File Browser & Preview API: Reads 100% from the Mac local filesystem
 *    corresponding to the active project's node (`work`, `work2`, `work3`...).
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const pty = require('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/node-pty');
const { WebSocketServer } = require('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/ws');
const { createChatHub } = require('./claude-chat/chat-hub');

const PORT = Number(process.env.PORT || 3080);
const BASE_TAKT_DIR = '/Users/will/.takt-ai';
const KOREA_WORKSPACE_DIR = '/Users/will/Documents/Korea_Server';
const NODES_FILE = path.join(BASE_TAKT_DIR, 'nodes.json');
const SESSION_TITLES_FILE = path.join(BASE_TAKT_DIR, 'session-titles.json');
const WORKBENCH_DB_FILE = path.join(BASE_TAKT_DIR, 'takt-workbench.sqlite');
const LOCAL_WORK_DIR = path.join(BASE_TAKT_DIR, 'work');
const DSH_WEB_LOG = path.join(BASE_TAKT_DIR, 'logs/workbench-web.log');
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;
const VENDOR_DIR = path.join(PUBLIC_DIR, 'vendor');
const CHAT_PUBLIC_DIR = path.join(PUBLIC_DIR, 'chat');

fs.mkdirSync(LOCAL_WORK_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DSH_WEB_LOG), { recursive: true });

// Local-only guard helpers (see SECURITY.md): loopback Host blocks DNS rebinding,
// same-origin check blocks cross-site requests from web pages.
function isLoopbackHost(hostHeader) {
  const h = String(hostHeader || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}
function isSameLocalOrigin(origin) {
  try {
    const o = new URL(origin);
    return isLoopbackHost(o.host) && Number(o.port || 80) === PORT;
  } catch {
    return false;
  }
}

function shSingleQuote(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function runCmd(cmd, args, timeoutMs = 8000) {
  const isBgSsh = cmd === 'ssh' && Array.isArray(args) && args.includes('-Nf');
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: {
        ...process.env,
        TAILSCALE_BE_CLI: 'true',
        PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`,
      },
      stdio: isBgSsh ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

// ============================================================================
// 0. Multi-Linux Node Registry & Auto-Provisioning (work, work2, work3...)
// ============================================================================
const DEFAULT_NODES = [
  {
    id: 'korea-claude',
    name: '韩国首尔主节点',
    badge: 'KR-1',
    sshHost: 'korea-claude',
    remoteWorkDir: '/root/work',
    localWorkDir: '/Users/will/.takt-ai/work',
    localWorkAlias: 'work',
    syncthingFolderId: 'korea-work',
    syncthingDeviceId: 'A6U6UBG-HA5OGV6-UWMIWSH-RTW7ZJD-3HLDTB4-CNQ3WEX-HO2L5RM-SDD4UAO',
    enabled: true,
  },
  {
    id: 'linux-work2',
    name: 'Linux 节点 2',
    badge: 'LX-2',
    sshHost: '',
    remoteWorkDir: '/root/work',
    localWorkDir: '/Users/will/.takt-ai/work2',
    localWorkAlias: 'work2',
    syncthingFolderId: 'takt-work2',
    syncthingDeviceId: '',
    enabled: false,
  },
];

function ensureNodeLocalDirAndSymlink(node) {
  try {
    const alias = String(node.localWorkAlias || path.basename(node.localWorkDir || 'work2')).replace(/[^a-zA-Z0-9_-]/g, '');
    const localDir = node.localWorkDir || path.join(BASE_TAKT_DIR, alias);
    node.localWorkDir = localDir;
    node.localWorkAlias = alias;
    fs.mkdirSync(localDir, { recursive: true });

    // Seed CLAUDE.md and .stignore if new workN directory
    const srcClaude = path.join(LOCAL_WORK_DIR, 'CLAUDE.md');
    const dstClaude = path.join(localDir, 'CLAUDE.md');
    if (fs.existsSync(srcClaude) && !fs.existsSync(dstClaude)) {
      try { fs.copyFileSync(srcClaude, dstClaude); } catch {}
    }
    const srcStignore = path.join(LOCAL_WORK_DIR, '.stignore');
    const dstStignore = path.join(localDir, '.stignore');
    if (fs.existsSync(srcStignore) && !fs.existsSync(dstStignore)) {
      try { fs.copyFileSync(srcStignore, dstStignore); } catch {}
    }

    // Create convenience symlink in /Users/will/Documents/Korea_Server/<alias>
    if (fs.existsSync(KOREA_WORKSPACE_DIR)) {
      const linkPath = path.join(KOREA_WORKSPACE_DIR, alias);
      if (!fs.existsSync(linkPath)) {
        try { fs.symlinkSync(localDir, linkPath); } catch {}
      }
    }
  } catch {}
}

function loadNodes() {
  try {
    if (fs.existsSync(NODES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(NODES_FILE, 'utf8'));
      if (raw && Array.isArray(raw.nodes) && raw.nodes.length > 0) {
        for (const n of raw.nodes) ensureNodeLocalDirAndSymlink(n);
        return raw.nodes;
      }
    }
  } catch {}
  for (const n of DEFAULT_NODES) ensureNodeLocalDirAndSymlink(n);
  saveNodes(DEFAULT_NODES);
  return DEFAULT_NODES;
}

function saveNodes(nodes) {
  for (const n of nodes) ensureNodeLocalDirAndSymlink(n);
  try {
    fs.writeFileSync(NODES_FILE, JSON.stringify({ nodes }, null, 2), 'utf8');
  } catch {}
}

function getNodeById(nodeId) {
  const nodes = loadNodes();
  if (!nodeId) return nodes[0];
  return (
    nodes.find((n) => n.id === nodeId || n.sshHost === nodeId || n.localWorkAlias === nodeId) ||
    nodes[0]
  );
}

function discoverSshConfigHosts() {
  const out = [];
  const seen = new Set();
  try {
    const cfgPath = path.join(os.homedir(), '.ssh/config');
    if (fs.existsSync(cfgPath)) {
      const content = fs.readFileSync(cfgPath, 'utf8');
      let currentHosts = [];
      let hostName = '';
      let user = 'root';
      const flush = () => {
        for (const h of currentHosts) {
          if (!h || h.includes('*') || h.includes('?') || seen.has(h)) continue;
          seen.add(h);
          out.push({ alias: h, hostName: hostName || h, user: user || 'root' });
        }
      };
      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const mHost = line.match(/^Host\s+(.+)$/i);
        if (mHost) {
          flush();
          currentHosts = mHost[1].trim().split(/\s+/);
          hostName = '';
          user = 'root';
          continue;
        }
        const mHn = line.match(/^HostName\s+(\S+)/i);
        if (mHn) hostName = mHn[1];
        const mUser = line.match(/^User\s+(\S+)/i);
        if (mUser) user = mUser[1];
      }
      flush();
    }
  } catch {}
  return out;
}

function getSyncthingApiKey() {
  try {
    const cfgXml = fs.readFileSync(
      path.join(os.homedir(), 'Library/Application Support/Syncthing/config.xml'),
      'utf8'
    );
    const m = cfgXml.match(/<apikey>([^<]+)<\/apikey>/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// Automatically provision a Linux node:
// 1. Ensure local workN folder + Syncthing folder registration on Mac
// 2. Establish isolated Reverse SSH Tunnel (-R 18765 & -R 49620) to the Linux host
// 3. Configure remote ~/.claude.json to point `mac-industrial-mcp` to http://127.0.0.1:18765/mcp?node=<nodeId>
// 4. Auto-pair Syncthing device & folder if Syncthing is installed on the remote Linux host
async function provisionLinuxNode(node) {
  ensureNodeLocalDirAndSymlink(node);
  const logs = [`本地目录已就绪: ${node.localWorkDir}`];

  // Register local folder in Mac Syncthing if API key available
  const stKey = getSyncthingApiKey();
  let macDeviceId = '';
  if (stKey && node.syncthingFolderId) {
    try {
      const sysRes = await runCmd('curl', ['-s', '--max-time', '2', '-H', `X-API-Key: ${stKey}`, 'http://127.0.0.1:8384/rest/system/status'], 2500);
      if (sysRes.stdout) {
        macDeviceId = JSON.parse(sysRes.stdout).myID || '';
      }
      const folderPayload = {
        id: node.syncthingFolderId,
        label: `TAKT ${node.localWorkAlias} (${node.name})`,
        filesystemType: 'basic',
        path: node.localWorkDir,
        type: 'sendreceive',
        fsWatcherEnabled: true,
        fsWatcherDelayS: 1,
        rescanIntervalS: 60,
      };
      if (node.syncthingDeviceId) {
        folderPayload.devices = macDeviceId
          ? [{ deviceID: macDeviceId }, { deviceID: node.syncthingDeviceId }]
          : [{ deviceID: node.syncthingDeviceId }];
      }
      await runCmd('curl', [
        '-s', '-X', 'PUT',
        '-H', `X-API-Key: ${stKey}`,
        '-H', 'Content-Type: application/json',
        '-d', JSON.stringify(folderPayload),
        `http://127.0.0.1:8384/rest/config/folders/${encodeURIComponent(node.syncthingFolderId)}`,
      ], 3000);
      logs.push(`Mac Syncthing 同步目录已注册 (${node.syncthingFolderId})`);
    } catch {}
  }

  if (!node.sshHost) {
    return { ok: true, logs };
  }

  // Establish isolated MCP reverse tunnel for this node
  const sock = node.id === 'korea-claude'
    ? '/Users/will/.ssh/sockets/takt-mcp-tunnel.sock'
    : `/Users/will/.ssh/sockets/takt-mcp-tunnel-${node.id.replace(/[^a-zA-Z0-9_-]/g, '')}.sock`;

  await runCmd('ssh', ['-S', sock, '-O', 'exit', node.sshHost], 2500);
  const tunRes = await runCmd('ssh', [
    '-M', '-S', sock, '-Nf',
    '-o', 'ConnectTimeout=5',
    '-o', 'ExitOnForwardFailure=no',
    '-o', 'ServerAliveInterval=20',
    '-R', '18765:127.0.0.1:18765',
    '-R', '49620:127.0.0.1:49620',
    ...(node.syncthingTunnelPort ? ['-L', `127.0.0.1:${node.syncthingTunnelPort}:127.0.0.1:22000`] : []),
    ...(node.desktopWebPort ? ['-L', `127.0.0.1:${node.desktopWebPort}:127.0.0.1:6080`] : []),
    ...(node.desktopVncPort ? ['-L', `127.0.0.1:${node.desktopVncPort}:127.0.0.1:5901`] : []),
    node.sshHost,
  ], 7000);

  if (tunRes.exitCode === 0) {
    logs.push(`SSH 逆向 MCP 隧道已建立 (${node.sshHost} -> 127.0.0.1:18765)`);
  }

  // Provision remote work directory + ~/.claude.json MCP entry + read remote Syncthing Device ID
  const remoteWork = node.remoteWorkDir || '/root/work';
  const mcpUrl = `http://127.0.0.1:18765/mcp?node=${encodeURIComponent(node.id)}`;
  const setupPy = `
import json, os, subprocess

work_dir = ${JSON.stringify(remoteWork)}
mcp_url = ${JSON.stringify(mcpUrl)}
try:
    os.makedirs(work_dir, exist_ok=True)
except Exception:
    alt_doc = os.path.expanduser("~/Documents/work")
    alt_home = os.path.expanduser("~/work")
    work_dir = alt_doc if os.path.isdir(alt_doc) else alt_home
    os.makedirs(work_dir, exist_ok=True)

claude_cfg_path = os.path.expanduser("~/.claude.json")
cfg = {}
if os.path.exists(claude_cfg_path):
    try:
        with open(claude_cfg_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}

if not isinstance(cfg.get("mcpServers"), dict):
    cfg["mcpServers"] = {}

cfg["mcpServers"].pop("mac-industrial-mcp", None)
if os.path.exists("/usr/local/bin/mac-industrial-mcp-client"):
    cfg["mcpServers"]["mac-industrial"] = {
        "type": "stdio",
        "command": "/usr/local/bin/mac-industrial-mcp-client",
        "args": [],
        "env": {"TAKT_NODE_ID": ${JSON.stringify(node.id)}}
    }
else:
    cfg["mcpServers"]["mac-industrial"] = {
        "type": "http",
        "url": mcp_url
    }

if os.path.exists("/usr/local/bin/instabox-computer-use"):
    cfg["mcpServers"]["open-computer-use"] = {
        "type": "stdio",
        "command": "/usr/local/bin/instabox-computer-use",
        "args": ["mcp"]
    }

try:
    with open(claude_cfg_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
except Exception:
    pass

settings_path = os.path.expanduser("~/.claude/settings.json")
os.makedirs(os.path.dirname(settings_path), exist_ok=True)
st_cfg = {}
if os.path.exists(settings_path):
    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            st_cfg = json.load(f)
    except Exception:
        st_cfg = {}
perms = st_cfg.setdefault("permissions", {})
allow_list = perms.setdefault("allow", [])
for rule in ("mcp__mac-industrial", "mcp__mac-industrial__*", "mcp__mac-industrial__mac_host_exec"):
    if rule not in allow_list:
        allow_list.append(rule)
try:
    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(st_cfg, f, indent=2, ensure_ascii=False)
except Exception:
    pass

st_id = ""
try:
    r = subprocess.run(["syncthing", "--device-id"], capture_output=True, text=True, timeout=2)
    if r.returncode == 0 and r.stdout.strip():
        st_id = r.stdout.strip().splitlines()[0].strip()
except Exception:
    pass

print(json.dumps({"ok": True, "workDir": work_dir, "mcpUrl": mcp_url, "syncthingDeviceId": st_id}))
`.trim();

  const b64 = Buffer.from(setupPy, 'utf8').toString('base64');
  const remRes = await runCmd('ssh', [
    '-o', 'ConnectTimeout=5',
    '-o', 'ClearAllForwardings=yes',
    node.sshHost,
    `python3 -c "import base64;exec(base64.b64decode('${b64}'))"`,
  ], 8000);

  if (remRes.exitCode === 0 && remRes.stdout.trim()) {
    try {
      const info = JSON.parse(remRes.stdout.trim().split('\n').pop());
      if (info.workDir && info.workDir !== node.remoteWorkDir) {
        node.remoteWorkDir = info.workDir;
      }
      logs.push(`远端目录 ${info.workDir} 与 Mac MCP 桥接已自动注入 ~/.claude.json`);
      if (info.syncthingDeviceId && !node.syncthingDeviceId) {
        node.syncthingDeviceId = info.syncthingDeviceId;
        logs.push(`检测到远端 Syncthing Device ID: ${info.syncthingDeviceId.slice(0, 15)}...`);
      }
    } catch {}
  }

  return { ok: true, logs };
}

// Ensure Mac Industrial MCP Daemon (:18765) stays running in background
let mcpSupervisorBusy = false;
async function ensureMacMcpDaemonRunning() {
  if (mcpSupervisorBusy) return;
  mcpSupervisorBusy = true;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1800);
    let ok = false;
    try {
      const res = await fetch('http://127.0.0.1:18765/system-status', { signal: ctrl.signal });
      if (res.ok) {
        const st = await res.json();
        ok = true;
        if (st && st.mcpStatus && !st.mcpStatus.remoteTunnelOk && !st.healing) {
          fetch('http://127.0.0.1:18765/system-heal', { method: 'POST' }).catch(() => {});
        }
      }
    } catch {}
    clearTimeout(timer);

    if (!ok) {
      const mcpChild = spawn(process.execPath, ['/Users/will/.takt-ai/mcp-server/server.js', '--http'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
      mcpChild.unref();
    }
  } catch {} finally {
    mcpSupervisorBusy = false;
  }
}

setInterval(() => {
  ensureMacMcpDaemonRunning().catch(() => {});
}, 5000);
ensureMacMcpDaemonRunning().catch(() => {});

// ============================================================================
// 1. Passive Multi-Node Project & Session Scanner (NEVER touches `claude` CLI)
// ============================================================================
function buildRemoteScanPy(remoteWorkDir = '/root/work') {
  const cleanRoot = String(remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
  return `
import glob, json, os

work_root = ${JSON.stringify(cleanRoot)}
try:
    os.makedirs(work_root, exist_ok=True)
except Exception:
    alt_doc = os.path.expanduser("~/Documents/work")
    alt_home = os.path.expanduser("~/work")
    work_root = alt_doc if os.path.isdir(alt_doc) else alt_home
    os.makedirs(work_root, exist_ok=True)

encoded_exact = work_root.replace("/", "-")
encoded_prefix = encoded_exact + "-"

root_label = os.path.basename(work_root) or "work"
folders = {work_root: {"path": work_root, "name": f"{root_label} (主工作区)", "sessions": []}}
for entry in sorted(os.listdir(work_root)):
    if entry.startswith(".") or entry in ("uploads", "node_modules", "__pycache__"):
        continue
    full = os.path.join(work_root, entry)
    if os.path.isdir(full):
        folders[full] = {"path": full, "name": entry, "sessions": []}

def normalize_to_top_project(raw_path):
    c = (raw_path or "").rstrip("/") or work_root
    if c == work_root:
        return work_root
    if c.startswith(work_root + "/"):
        rel = c[len(work_root) + 1:]
        top_seg = rel.split("/")[0]
        if top_seg:
            return os.path.join(work_root, top_seg)
    return work_root

def decode_project_dir(dir_name):
    if dir_name == encoded_exact or dir_name == (encoded_exact + "---"):
        return work_root
    if dir_name.startswith(encoded_prefix):
        sub = dir_name[len(encoded_prefix):]
        cand = os.path.join(work_root, sub)
        if os.path.isdir(cand):
            return normalize_to_top_project(cand)
        for existing_full in list(folders.keys()):
            if existing_full == work_root:
                continue
            existing_sub = os.path.basename(existing_full).replace("_", "-").replace(" ", "-")
            if sub == existing_sub or sub.startswith(existing_sub + "-"):
                return existing_full
    return work_root

def iter_jsonl_sample_lines(filepath, file_size):
    CHUNK = 256 * 1024
    if file_size <= CHUNK * 2:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                yield line
    else:
        with open(filepath, "rb") as f:
            head = f.read(CHUNK).decode("utf-8", errors="replace").splitlines()
            for line in head[:-1]:
                yield line
            f.seek(max(0, file_size - CHUNK))
            tail = f.read(CHUNK).decode("utf-8", errors="replace").splitlines()
            for line in tail[1:]:
                yield line

claude_glob = os.path.expanduser("~/.claude/projects/*/*.jsonl")
for p in glob.glob(claude_glob):
    try:
        st = os.stat(p)
        if st.st_size < 20:
            continue
        sid = os.path.splitext(os.path.basename(p))[0]
        proj_dir_name = os.path.basename(os.path.dirname(p))
        cwd = decode_project_dir(proj_dir_name)
        title = ""
        ai_title = ""
        first_user = ""
        last_user = ""
        user_turns = 0
        for line in iter_jsonl_sample_lines(p, st.st_size):
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("cwd") and isinstance(obj.get("cwd"), str):
                c = obj["cwd"].rstrip("/") or work_root
                if c.startswith(work_root):
                    cwd = normalize_to_top_project(c)
            t = obj.get("type")
            if t == "custom-title" and obj.get("customTitle"):
                title = str(obj["customTitle"]).strip()
            elif t == "summary" and obj.get("summary") and not title:
                title = str(obj["summary"]).strip()
            elif t == "ai-title" and obj.get("aiTitle"):
                ai_title = str(obj["aiTitle"]).strip()
            elif t == "user":
                msg = obj.get("message") or {}
                content = msg.get("content")
                txt = ""
                if isinstance(content, str):
                    txt = content.strip()
                elif isinstance(content, list):
                    for part in content:
                        if isinstance(part, dict) and part.get("type") == "text":
                            txt += str(part.get("text") or "")
                    txt = txt.strip()
                if txt and not txt.startswith("<local-command") and not txt.startswith("<command-name>") and not txt.startswith("<relay"):
                    user_turns += 1
                    clean_txt = " ".join(txt.split())
                    if not first_user:
                        first_user = clean_txt[:80]
                    last_user = clean_txt[:80]
        display_title = title or first_user or ai_title or f"会话 {sid[:8]}"
        cwd = normalize_to_top_project(cwd)
        if cwd not in folders:
            folders[cwd] = {
                "path": cwd,
                "name": os.path.basename(cwd) or root_label,
                "sessions": []
            }
        folders[cwd]["sessions"].append({
            "id": sid,
            "title": display_title,
            "lastPrompt": last_user,
            "cwd": cwd,
            "updatedAt": int(st.st_mtime * 1000),
            "sizeBytes": st.st_size,
            "turns": max(1, user_turns),
            "existsOnDisk": True
        })
    except Exception:
        pass

res = list(folders.values())
for f in res:
    f["sessions"].sort(key=lambda x: x["updatedAt"], reverse=True)
res.sort(key=lambda x: (0 if x["path"] == work_root else 1, x["name"].lower()))
print(json.dumps({"ok": True, "resolvedWorkRoot": work_root, "folders": res}))
`.trim();
}

// ============================================================================
// 1b. Mac Local SQLite State Store (/Users/will/.takt-ai/takt-workbench.sqlite)
//     Maintains projects & sessions locally so UI never flickers or loses items
//     when SSH polls time out or are in-flight.
// ============================================================================
const workbenchDb = new DatabaseSync(WORKBENCH_DB_FILE);
workbenchDb.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS projects (
    key TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    path TEXT NOT NULL,
    local_path TEXT NOT NULL,
    name TEXT NOT NULL,
    pinned_visible INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    project_path TEXT NOT NULL,
    title TEXT NOT NULL,
    custom_title TEXT NOT NULL DEFAULT '',
    last_prompt TEXT NOT NULL DEFAULT '',
    turns INTEGER NOT NULL DEFAULT 1,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (node_id, id)
  );

  CREATE TABLE IF NOT EXISTS node_status (
    node_id TEXT PRIMARY KEY,
    online INTEGER NOT NULL DEFAULT 0,
    last_sync_at INTEGER NOT NULL DEFAULT 0
  );

  -- Project classification tags (Antigravity-style sidebar tags)
  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'blue',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS project_tags (
    project_key TEXT PRIMARY KEY,
    tag_id TEXT NOT NULL
  );
`);

// Auto-migrate legacy sessions table if primary key is not composite (node_id, id)
try {
  const cols = workbenchDb.prepare("PRAGMA table_info(sessions)").all();
  const pkCols = cols.filter((c) => Number(c.pk) > 0);
  if (pkCols.length === 1 && pkCols[0].name === 'id') {
    workbenchDb.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE sessions_v2 (
        id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        title TEXT NOT NULL,
        custom_title TEXT NOT NULL DEFAULT '',
        last_prompt TEXT NOT NULL DEFAULT '',
        turns INTEGER NOT NULL DEFAULT 1,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (node_id, id)
      );
      INSERT OR REPLACE INTO sessions_v2
        SELECT id, node_id, project_path, title, custom_title, last_prompt, turns, size_bytes, updated_at, deleted
        FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v2 RENAME TO sessions;
      COMMIT;
    `);
  }
} catch {}

function readTagsFromSqlite() {
  const tags = workbenchDb.prepare('SELECT id, name, color, sort FROM tags ORDER BY sort ASC, created_at ASC').all();
  const projectTags = {};
  for (const r of workbenchDb.prepare('SELECT project_key, tag_id FROM project_tags').all()) {
    projectTags[r.project_key] = r.tag_id;
  }
  return { tags, projectTags };
}

const stmtUpsertProject = workbenchDb.prepare(`
  INSERT INTO projects (key, node_id, path, local_path, name, pinned_visible, deleted, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  ON CONFLICT(key) DO UPDATE SET
    local_path = excluded.local_path,
    name = excluded.name,
    pinned_visible = MAX(projects.pinned_visible, excluded.pinned_visible),
    deleted = 0,
    updated_at = excluded.updated_at
`);

const stmtUpsertSessionFromScan = workbenchDb.prepare(`
  INSERT INTO sessions (id, node_id, project_path, title, custom_title, last_prompt, turns, size_bytes, updated_at, deleted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  ON CONFLICT(node_id, id) DO UPDATE SET
    project_path = excluded.project_path,
    title = CASE
      WHEN sessions.custom_title != '' THEN sessions.custom_title
      ELSE excluded.title
    END,
    last_prompt = CASE
      WHEN excluded.last_prompt != '' THEN excluded.last_prompt
      ELSE sessions.last_prompt
    END,
    turns = MAX(sessions.turns, excluded.turns),
    size_bytes = MAX(sessions.size_bytes, excluded.size_bytes),
    updated_at = MAX(sessions.updated_at, excluded.updated_at)
`);

const stmtRegisterLocalSession = workbenchDb.prepare(`
  INSERT INTO sessions (id, node_id, project_path, title, custom_title, last_prompt, turns, size_bytes, updated_at, deleted)
  VALUES (?, ?, ?, ?, '', '', 1, 0, ?, 0)
  ON CONFLICT(node_id, id) DO UPDATE SET
    deleted = 0,
    updated_at = MAX(sessions.updated_at, excluded.updated_at)
`);

const stmtRenameSession = workbenchDb.prepare(`
  UPDATE sessions
  SET custom_title = ?, title = ?, updated_at = ?
  WHERE id = ?
`);

const stmtSoftDeleteSession = workbenchDb.prepare(`
  UPDATE sessions
  SET deleted = 1, updated_at = ?
  WHERE id = ?
`);

const stmtUpsertNodeStatus = workbenchDb.prepare(`
  INSERT INTO node_status (node_id, online, last_sync_at)
  VALUES (?, ?, ?)
  ON CONFLICT(node_id) DO UPDATE SET
    online = excluded.online,
    last_sync_at = CASE
      WHEN excluded.last_sync_at > 0 THEN excluded.last_sync_at
      ELSE node_status.last_sync_at
    END
`);

function loadCustomSessionTitles() {
  try {
    if (fs.existsSync(SESSION_TITLES_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_TITLES_FILE, 'utf8')) || {};
    }
  } catch {}
  return {};
}

function saveCustomSessionTitle(sid, newTitle) {
  const map = loadCustomSessionTitles();
  if (newTitle) {
    map[sid] = newTitle;
  } else {
    delete map[sid];
  }
  try {
    fs.writeFileSync(SESSION_TITLES_FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch {}
  try {
    if (newTitle) {
      stmtRenameSession.run(newTitle, newTitle, Date.now(), sid);
    }
  } catch {}
}

function normalizeToTopProjectPath(node, rawRemotePath) {
  const remoteRoot = ((node && node.remoteWorkDir) || '/root/work').replace(/\/+$/, '') || '/root/work';
  const clean = String(rawRemotePath || remoteRoot).replace(/\/+$/, '') || remoteRoot;
  if (clean === remoteRoot) return remoteRoot;
  if (clean.startsWith(remoteRoot + '/')) {
    const rel = clean.slice(remoteRoot.length + 1);
    const topSeg = rel.split('/')[0];
    if (topSeg) return `${remoteRoot}/${topSeg}`;
  }
  return remoteRoot;
}

function upsertProjectInSqlite(node, remotePath, name, pinnedVisible = 0) {
  const remoteRoot = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
  const cleanPath = normalizeToTopProjectPath(node, remotePath);
  const rel = cleanPath === remoteRoot
    ? ''
    : cleanPath.slice(remoteRoot.length + 1);
  const localPath = rel ? path.join(node.localWorkDir, rel) : node.localWorkDir;
  const displayName = cleanPath === remoteRoot ? `${node.localWorkAlias} (主工作区)` : path.basename(cleanPath);
  const key = `${node.id}::${cleanPath}`;
  stmtUpsertProject.run(key, node.id, cleanPath, localPath, displayName, pinnedVisible ? 1 : 0, Date.now());
  return { key, cleanPath, localPath, displayName };
}

// Titles the workbench makes up before a session has a real one
// ("会话 1a2b3c4d" from the scan, "<project> · 终端" for new tabs, "对话 …" / "终端 (…)" for pty tabs)
function isPlaceholderSessionTitle(title) {
  const t = String(title || '').trim();
  return !t || /^(会话|对话) [0-9a-f]{8}$/i.test(t) || / · 终端$/.test(t) || /^终端 \(.*\)$/.test(t);
}

function registerSessionInSqlite({ id, nodeId, cwd, title }) {
  if (!id) return;
  const node = getNodeById(nodeId);
  const cleanCwd = normalizeToTopProjectPath(node, cwd);
  upsertProjectInSqlite(node, cleanCwd, path.basename(cleanCwd), 1);
  stmtRegisterLocalSession.run(id, node.id, cleanCwd, title || `会话 ${id.slice(0, 8)}`, Date.now());
}

async function syncSingleNodeToSqlite(node, customTitles) {
  ensureNodeLocalDirAndSymlink(node);
  const remoteRoot = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';

  // 1. Always index Mac local subdirectories into SQLite immediately
  upsertProjectInSqlite(node, remoteRoot, `${node.localWorkAlias} (主工作区)`, 0);
  try {
    const entries = await fsp.readdir(node.localWorkDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'uploads') {
        upsertProjectInSqlite(node, `${remoteRoot}/${e.name}`, e.name, 0);
      }
    }
  } catch {}

  // 2. If SSH is enabled & configured, scan remote folders & .jsonl sessions and upsert into SQLite
  if (node.enabled && node.sshHost) {
    const py = buildRemoteScanPy(remoteRoot);
    const b64 = Buffer.from(py, 'utf8').toString('base64');
    const r = await runCmd('ssh', [
      '-o', 'ConnectTimeout=4',
      '-o', 'ClearAllForwardings=yes',
      node.sshHost,
      `python3 -c "import base64;exec(base64.b64decode('${b64}'))"`,
    ], 6500);

    if (!loadNodes().some((n) => n.id === node.id)) return false;

    if (r.exitCode === 0 && r.stdout.trim()) {
      try {
        const parsed = JSON.parse(r.stdout.trim().split('\n').pop());
        if (parsed && Array.isArray(parsed.folders)) {
          if (parsed.resolvedWorkRoot && parsed.resolvedWorkRoot !== node.remoteWorkDir) {
            const oldRoot = node.remoteWorkDir;
            node.remoteWorkDir = parsed.resolvedWorkRoot;
            const allNodes = loadNodes();
            const target = allNodes.find((x) => x.id === node.id);
            if (target) {
              target.remoteWorkDir = parsed.resolvedWorkRoot;
              saveNodes(allNodes);
            }
            try {
              workbenchDb.prepare('DELETE FROM projects WHERE key = ?').run(`${node.id}::${oldRoot}`);
            } catch {}
          }
          const now = Date.now();
          workbenchDb.exec('BEGIN IMMEDIATE');
          try {
            for (const f of parsed.folders) {
              const fPath = normalizeToTopProjectPath(node, f.path);
              upsertProjectInSqlite(node, fPath, f.name, 0);
              for (const s of (f.sessions || [])) {
                const customTitle = customTitles[s.id] || '';
                const finalTitle = customTitle || s.title || `会话 ${String(s.id).slice(0, 8)}`;
                stmtUpsertSessionFromScan.run(
                  s.id,
                  node.id,
                  fPath,
                  finalTitle,
                  customTitle,
                  s.lastPrompt || '',
                  Number(s.turns || 1),
                  Number(s.sizeBytes || 0),
                  Number(s.updatedAt || now)
                );
              }
            }
            stmtUpsertNodeStatus.run(node.id, 1, now);
            workbenchDb.exec('COMMIT');
          } catch (txErr) {
            try { workbenchDb.exec('ROLLBACK'); } catch {}
            throw txErr;
          }
          return true;
        }
      } catch {}
    }
    // Note: on SSH timeout/failure, we ONLY mark online=0; we NEVER delete or clear existing projects/sessions in SQLite!
    stmtUpsertNodeStatus.run(node.id, 0, 0);
    return false;
  }

  stmtUpsertNodeStatus.run(node.id, 0, 0);
  return false;
}

let sqliteSyncInFlight = null;
let lastSqliteSyncAt = 0;

async function syncAllNodesToSqlite() {
  if (sqliteSyncInFlight) return sqliteSyncInFlight;
  sqliteSyncInFlight = (async () => {
    try {
      const customTitles = loadCustomSessionTitles();
      const nodes = loadNodes();
      await Promise.all(nodes.map((n) => syncSingleNodeToSqlite(n, customTitles)));
      lastSqliteSyncAt = Date.now();
    } catch {} finally {
      sqliteSyncInFlight = null;
    }
  })();
  return sqliteSyncInFlight;
}

function readTreeFromSqlite() {
  const nodes = loadNodes();
  const statusRows = workbenchDb.prepare('SELECT node_id, online, last_sync_at FROM node_status').all();
  const statusMap = new Map(statusRows.map((r) => [r.node_id, r]));

  // Ensure every node's local root & subdirs are present in SQLite
  for (const n of nodes) {
    ensureNodeLocalDirAndSymlink(n);
    const remoteRoot = (n.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
    upsertProjectInSqlite(n, remoteRoot, `${n.localWorkAlias} (主工作区)`, 0);
    try {
      const entries = fs.readdirSync(n.localWorkDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'uploads') {
          upsertProjectInSqlite(n, `${remoteRoot}/${e.name}`, e.name, 0);
        }
      }
    } catch {}
  }

  const projectRows = workbenchDb.prepare(`
    SELECT key, node_id, path, local_path, name, pinned_visible, updated_at
    FROM projects
    WHERE deleted = 0
  `).all();

  const sessionRows = workbenchDb.prepare(`
    SELECT id, node_id, project_path, title, custom_title, last_prompt, turns, size_bytes, updated_at
    FROM sessions
    WHERE deleted = 0
    ORDER BY updated_at DESC
  `).all();

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const foldersByKey = new Map();

  for (const p of projectRows) {
    const node = nodeMap.get(p.node_id);
    if (!node) continue;
    const remoteRoot = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
    const st = statusMap.get(node.id);
    foldersByKey.set(p.key, {
      key: p.key,
      path: p.path,
      localPath: p.local_path,
      name: p.path === remoteRoot ? `${node.localWorkAlias} (主工作区)` : p.name,
      nodeId: node.id,
      nodeName: node.name,
      nodeBadge: node.badge,
      sshHost: node.sshHost || '',
      remoteWorkDir: remoteRoot,
      localWorkDir: node.localWorkDir,
      localWorkAlias: node.localWorkAlias,
      pinnedVisible: Boolean(p.pinned_visible),
      online: st ? Boolean(st.online) : false,
      sessions: [],
    });
  }

  for (const s of sessionRows) {
    const node = nodeMap.get(s.node_id);
    if (!node) continue;
    // Never-used sessions only carry a placeholder title: keep them out of the sidebar
    // (they show up as soon as the first prompt gives them a real title)
    if (!s.custom_title && isPlaceholderSessionTitle(s.title)) continue;
    const remoteRoot = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
    const fKey = `${node.id}::${s.project_path}`;
    if (!foldersByKey.has(fKey)) {
      const info = upsertProjectInSqlite(node, s.project_path, path.basename(s.project_path), 0);
      const st = statusMap.get(node.id);
      foldersByKey.set(fKey, {
        key: fKey,
        path: info.cleanPath,
        localPath: info.localPath,
        name: info.displayName,
        nodeId: node.id,
        nodeName: node.name,
        nodeBadge: node.badge,
        sshHost: node.sshHost || '',
        remoteWorkDir: remoteRoot,
        localWorkDir: node.localWorkDir,
        localWorkAlias: node.localWorkAlias,
        pinnedVisible: false,
        online: st ? Boolean(st.online) : false,
        sessions: [],
      });
    }
    const folder = foldersByKey.get(fKey);
    folder.sessions.push({
      id: s.id,
      title: s.custom_title || s.title,
      lastPrompt: s.last_prompt,
      cwd: s.project_path,
      updatedAt: s.updated_at,
      sizeBytes: s.size_bytes,
      turns: s.turns,
      existsOnDisk: true,
      nodeId: node.id,
      nodeName: node.name,
      nodeBadge: node.badge,
      sshHost: node.sshHost || '',
      localWorkDir: node.localWorkDir,
      localWorkAlias: node.localWorkAlias,
      localPath: folder.localPath,
    });
  }

  const allFolders = [];
  const nodeStates = nodes.map((n) => {
    const remoteRoot = (n.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
    const nodeFolders = Array.from(foldersByKey.values())
      .filter((f) => f.nodeId === n.id)
      .sort((a, b) => {
        if (a.path === remoteRoot && b.path !== remoteRoot) return -1;
        if (b.path === remoteRoot && a.path !== remoteRoot) return 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });
    for (const f of nodeFolders) allFolders.push(f);
    const st = statusMap.get(n.id);
    return {
      ...n,
      online: st ? Boolean(st.online) : false,
      lastSyncAt: st ? st.last_sync_at : 0,
      projectCount: nodeFolders.length,
      sessionCount: nodeFolders.reduce((acc, f) => acc + f.sessions.length, 0),
    };
  });

  return {
    ok: true,
    source: 'sqlite',
    dbPath: WORKBENCH_DB_FILE,
    nodes: nodeStates,
    folders: allFolders,
  };
}

// Background SQLite sync daemon (every 10 seconds, non-blocking)
setInterval(() => {
  syncAllNodesToSqlite().catch(() => {});
}, 10000);
syncAllNodesToSqlite().catch(() => {});

// ============================================================================
// 2. Persistent Multi-Tab SSH Terminal Sessions (node-pty)
// ============================================================================
const activePtyTabs = new Map();

function getOrCreatePtyTab({ tabId, sessionId, title, cwd, resume, mode, nodeId, sshHost }) {
  if (activePtyTabs.has(tabId)) {
    const existing = activePtyTabs.get(tabId);
    if (!existing.exited) {
      if (title && title !== existing.title) existing.title = title;
      return existing;
    }
    activePtyTabs.delete(tabId);
  }

  const node = getNodeById(nodeId || sshHost);
  const remoteRoot = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
  const targetCwd = (cwd && String(cwd).startsWith('/')) ? String(cwd) : remoteRoot;
  const targetSshHost = sshHost || node.sshHost || '';
  const sid = sessionId || crypto.randomUUID();
  const isShell = mode === 'shell';
  registerSessionInSqlite({ id: sid, nodeId: node.id, cwd: targetCwd, title });

  const launcherScript = path.join(__dirname, 'native-ssh-session.sh');
  const ptyProc = pty.spawn('/bin/bash', [launcherScript, String(tabId), targetCwd, targetSshHost], {
    name: 'xterm-256color',
    cols: 120,
    rows: 36,
    cwd: node.localWorkDir || LOCAL_WORK_DIR,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'en_US.UTF-8',
      PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`,
    },
  });

  const tabObj = {
    tabId,
    sessionId: sid,
    title: title || (isShell ? `终端 (${path.basename(targetCwd)})` : `对话 ${sid.slice(0, 8)}`),
    cwd: targetCwd,
    nodeId: node.id,
    nodeName: node.name,
    nodeBadge: node.badge,
    sshHost: targetSshHost,
    localWorkDir: node.localWorkDir,
    localWorkAlias: node.localWorkAlias,
    mode: isShell ? 'shell' : 'claude',
    createdAt: Date.now(),
    ptyProc,
    clients: new Set(),
    scrollback: [],
    scrollbackBytes: 0,
    exited: false,
    exitCode: null,
  };

  const MAX_SCROLLBACK_BYTES = 256 * 1024;

  ptyProc.onData((chunk) => {
    tabObj.scrollback.push(chunk);
    tabObj.scrollbackBytes += Buffer.byteLength(chunk, 'utf8');
    while (tabObj.scrollbackBytes > MAX_SCROLLBACK_BYTES && tabObj.scrollback.length > 1) {
      const removed = tabObj.scrollback.shift();
      tabObj.scrollbackBytes -= Buffer.byteLength(removed, 'utf8');
    }

    const msg = JSON.stringify({ type: 'output', tabId, data: chunk });
    for (const ws of tabObj.clients) {
      if (ws.readyState === 1) {
        try { ws.send(msg); } catch {}
      }
    }
  });

  ptyProc.onExit(({ exitCode, signal }) => {
    tabObj.exited = true;
    tabObj.exitCode = exitCode;
    const msg = JSON.stringify({ type: 'exit', tabId, exitCode, signal });
    for (const ws of tabObj.clients) {
      if (ws.readyState === 1) {
        try { ws.send(msg); } catch {}
      }
    }
    activePtyTabs.delete(tabId);
  });

  activePtyTabs.set(tabId, tabObj);
  return tabObj;
}

function sanitizeTmuxSessionId(tabId) {
  const safe = String(tabId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28) || 'main';
  return `takt_${safe}`;
}

function closePtyTab(tabId, explicitNodeId) {
  const tab = activePtyTabs.get(tabId);
  const node = getNodeById(explicitNodeId || (tab && tab.nodeId));
  const targetHost = (tab && tab.sshHost) || (node && node.sshHost) || '';
  const tmuxSess = sanitizeTmuxSessionId(tabId);
  chatHub.closeTab(tabId, (node && node.id) || explicitNodeId || '');
  if (targetHost) {
    runCmd('ssh', [
      '-o', 'ConnectTimeout=3',
      '-o', 'ClearAllForwardings=yes',
      targetHost,
      `tmux kill-session -t ${shSingleQuote(tmuxSess)} >/dev/null 2>&1 || true`,
    ], 4000).catch(() => {});
  }

  if (!tab) return false;
  activePtyTabs.delete(tabId);
  try {
    tab.ptyProc.kill();
  } catch {}
  for (const ws of tab.clients) {
    try { ws.close(); } catch {}
  }
  tab.clients.clear();
  return true;
}

// ============================================================================
// 3. Multi-Node Session File Browser & Preview Helpers (Mac Local Path Priority)
// ============================================================================
function inferNodeFromPathOrId(inputPath = '', nodeId = '') {
  const nodes = loadNodes();
  const raw = String(inputPath || '').trim();
  // First check if raw path explicitly starts with a node's localWorkDir (sort longest first so work2 matches before work!)
  const sortedByLocalLen = [...nodes].sort((a, b) => (b.localWorkDir || '').length - (a.localWorkDir || '').length);
  for (const n of sortedByLocalLen) {
    if (n.localWorkDir && (raw === n.localWorkDir || raw.startsWith(n.localWorkDir + '/'))) {
      return n;
    }
    const docAliasDir = path.join(KOREA_WORKSPACE_DIR, n.localWorkAlias || 'work');
    if (raw === docAliasDir || raw.startsWith(docAliasDir + '/')) {
      return n;
    }
  }
  if (nodeId) {
    const byId = nodes.find((n) => n.id === nodeId || n.sshHost === nodeId || n.localWorkAlias === nodeId);
    if (byId) return byId;
  }
  return nodes[0];
}

function mapRemoteCwdToLocal(remoteCwd = '/root/work', nodeId = '') {
  const node = inferNodeFromPathOrId(remoteCwd, nodeId);
  const localBase = node.localWorkDir || LOCAL_WORK_DIR;
  const remoteBase = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
  const docAliasBase = path.join(KOREA_WORKSPACE_DIR, node.localWorkAlias || 'work');

  const clean = String(remoteCwd || remoteBase).trim().replace(/\/+$/, '') || remoteBase;
  if (clean === localBase || clean === remoteBase || clean === docAliasBase) {
    return localBase;
  }
  if (clean.startsWith(localBase + '/')) {
    const resolved = path.resolve(clean);
    if (resolved.startsWith(localBase)) return resolved;
  }
  if (clean.startsWith(docAliasBase + '/')) {
    const rel = clean.slice(docAliasBase.length + 1);
    const resolved = path.resolve(localBase, rel);
    if (resolved.startsWith(localBase)) return resolved;
  }
  if (clean.startsWith(remoteBase + '/')) {
    const rel = clean.slice(remoteBase.length + 1);
    const resolved = path.resolve(localBase, rel);
    if (resolved.startsWith(localBase)) return resolved;
  }
  if (clean.startsWith('/root/work/')) {
    const rel = clean.slice('/root/work/'.length);
    const resolved = path.resolve(localBase, rel);
    if (resolved.startsWith(localBase)) return resolved;
  }
  return localBase;
}

function mapAnyCwdToRemote(inputCwd = '/root/work', nodeId = '') {
  const node = inferNodeFromPathOrId(inputCwd, nodeId);
  const localBase = node.localWorkDir || LOCAL_WORK_DIR;
  const remoteBase = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
  const localDir = mapRemoteCwdToLocal(inputCwd, node.id);
  const rel = path.relative(localBase, localDir).split(path.sep).join('/');
  return rel ? `${remoteBase}/${rel}` : remoteBase;
}

function cwdMapsToLocal(cwd, node) {
  const clean = String(cwd || '').trim().replace(/\/+$/, '');
  if (!clean || !clean.startsWith('/')) return true;
  const localBase = node.localWorkDir || LOCAL_WORK_DIR;
  const remoteBase = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
  const docAliasBase = path.join(KOREA_WORKSPACE_DIR, node.localWorkAlias || 'work');
  return [localBase, remoteBase, docAliasBase, '/root/work'].some((b) => clean === b || clean.startsWith(`${b}/`));
}

function resolveAnyFilePathToLocalAndRemote(inputPath, sessionCwd = '/root/work', nodeId = '') {
  let raw = String(inputPath || '').trim();
  raw = raw.replace(/^['"`]+|['"`]+$/g, '');
  const lineMatch = raw.match(/^(.*?\.[a-zA-Z0-9_-]+):(\d+)(?::\d+)?$/);
  let lineNum = null;
  if (lineMatch) {
    raw = lineMatch[1];
    lineNum = Number(lineMatch[2]);
  }

  const node = inferNodeFromPathOrId(raw || sessionCwd, nodeId);
  const localBase = node.localWorkDir || LOCAL_WORK_DIR;
  const remoteBase = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
  const docAliasBase = path.join(KOREA_WORKSPACE_DIR, node.localWorkAlias || 'work');

  let remotePath = '';
  let localPath = '';

  if (raw === localBase || raw.startsWith(localBase + '/')) {
    localPath = path.resolve(raw);
    const rel = localPath.slice(localBase.length).replace(/^\/+/, '');
    remotePath = rel ? `${remoteBase}/${rel}` : remoteBase;
  } else if (raw === docAliasBase || raw.startsWith(docAliasBase + '/')) {
    const rel = raw.slice(docAliasBase.length).replace(/^\/+/, '');
    localPath = path.resolve(localBase, rel);
    remotePath = rel ? `${remoteBase}/${rel}` : remoteBase;
  } else if (raw === remoteBase || raw.startsWith(remoteBase + '/')) {
    remotePath = path.posix.normalize(raw);
    const rel = remotePath.slice(remoteBase.length).replace(/^\/+/, '');
    localPath = path.resolve(localBase, rel);
  } else if (raw.startsWith('/root/work')) {
    const rel = raw.slice('/root/work'.length).replace(/^\/+/, '');
    localPath = path.resolve(localBase, rel);
    remotePath = rel ? `${remoteBase}/${rel}` : remoteBase;
  } else if (raw.startsWith('/Users/will/')) {
    localPath = path.resolve(raw);
    remotePath = localPath;
  } else if (raw.startsWith('/')) {
    remotePath = path.posix.normalize(raw);
    localPath = '';
  } else if (raw === '~' || raw.startsWith('~/')) {
    remotePath = raw; // node home: only reachable over SSH
    localPath = '';
  } else if (!cwdMapsToLocal(sessionCwd, node)) {
    // Session runs outside the synced work dir: the file only exists on the node
    remotePath = path.posix.normalize(path.posix.join(String(sessionCwd).trim(), raw));
    localPath = '';
  } else {
    const baseLocal = mapRemoteCwdToLocal(sessionCwd, node.id);
    localPath = path.resolve(baseLocal, raw);
    if (localPath.startsWith(localBase)) {
      const rel = localPath.slice(localBase.length).replace(/^\/+/, '');
      remotePath = rel ? `${remoteBase}/${rel}` : remoteBase;
    } else {
      const baseRemote = mapAnyCwdToRemote(sessionCwd, node.id);
      remotePath = path.posix.normalize(path.posix.join(baseRemote, raw));
    }
  }

  return { localPath, remotePath, lineNum, node };
}

// ---- Shared recursive directory watchers for the live file tree (one fs.watch per root, ref-counted) ----
const FILE_WATCH_IGNORE = /(^|[\\/])(\.git|node_modules|__pycache__|\.DS_Store|\.stfolder|\.stversions|dist|build|\.next|\.st[^\\/]*)([\\/]|$)/;
const fileWatchers = new Map(); // localRoot -> { watcher, subs:Set<fn>, timer }
function subscribeFileChanges(localRoot, cb) {
  if (!localRoot) return null;
  let entry = fileWatchers.get(localRoot);
  if (!entry) {
    let watcher;
    try {
      entry = { watcher: null, subs: new Set(), timer: null };
      const fire = () => {
        if (entry.timer) return;
        entry.timer = setTimeout(() => { entry.timer = null; entry.subs.forEach((fn) => { try { fn(); } catch {} }); }, 250);
      };
      watcher = fs.watch(localRoot, { recursive: true }, (_evt, filename) => {
        if (filename && FILE_WATCH_IGNORE.test(String(filename))) return;
        fire();
      });
      watcher.on('error', () => {});
      entry.watcher = watcher;
    } catch {
      return null;
    }
    fileWatchers.set(localRoot, entry);
  }
  entry.subs.add(cb);
  return () => {
    entry.subs.delete(cb);
    if (entry.subs.size === 0) {
      try { entry.watcher.close(); } catch {}
      if (entry.timer) clearTimeout(entry.timer);
      if (fileWatchers.get(localRoot) === entry) fileWatchers.delete(localRoot);
    }
  };
}

async function buildFileTree(localRoot, remoteRoot, node, maxDepth = 4) {
  const IGNORE = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store', '.stfolder', '.stversions', 'dist', 'build', '.next']);
  const localBase = (node && node.localWorkDir) || LOCAL_WORK_DIR;
  const remoteBase = ((node && node.remoteWorkDir) || '/root/work').replace(/\/+$/, '') || '/root/work';

  async function walkLocal(dir, depth) {
    if (depth > maxDepth) return [];
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const items = [];
    for (const e of entries) {
      if (IGNORE.has(e.name) || e.name.startsWith('.st')) continue;
      const fullLocal = path.join(dir, e.name);
      const relFromWork = path.relative(localBase, fullLocal).split(path.sep).join('/');
      const fullRemote = relFromWork ? `${remoteBase}/${relFromWork}` : remoteBase;
      const relFromProject = path.relative(localRoot, fullLocal).split(path.sep).join('/');

      try {
        const st = await fsp.stat(fullLocal);
        if (e.isDirectory()) {
          const children = await walkLocal(fullLocal, depth + 1);
          items.push({
            name: e.name,
            type: 'dir',
            path: fullLocal,
            localPath: fullLocal,
            remotePath: fullRemote,
            relPath: relFromProject,
            mtime: Math.round(st.mtimeMs),
            children,
          });
        } else if (e.isFile()) {
          items.push({
            name: e.name,
            type: 'file',
            path: fullLocal,
            localPath: fullLocal,
            remotePath: fullRemote,
            relPath: relFromProject,
            size: st.size,
            mtime: Math.round(st.mtimeMs),
            ext: path.extname(e.name).toLowerCase(),
          });
        }
      } catch {}
    }
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    return items;
  }

  try {
    await fsp.mkdir(localRoot, { recursive: true });
  } catch {}
  const tree = await walkLocal(localRoot, 1);
  return {
    ok: true,
    nodeId: node.id,
    nodeBadge: node.badge,
    nodeName: node.name,
    localWorkAlias: node.localWorkAlias,
    root: localRoot,
    localRoot,
    remoteRoot: mapAnyCwdToRemote(remoteRoot, node.id),
    items: tree,
    source: 'mac-local',
  };
}

const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.stl': 'model/stl',
  '.obj': 'text/plain; charset=utf-8',
};

// ============================================================================
// 4. Bottom Status Bar Aggregator (Multi-Node SSH + Tailscale + MCP + Syncthing)
// ============================================================================
async function getCombinedSystemStatus() {
  let mcpData = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch('http://127.0.0.1:18765/system-status', { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      mcpData = await res.json();
    }
  } catch {}

  let localTailscaleOk = false;
  let localTailscaleIp = '';
  try {
    const nets = os.networkInterfaces();
    for (const [ifName, addrs] of Object.entries(nets)) {
      if (!ifName.startsWith('utun') || !Array.isArray(addrs)) continue;
      const v4 = addrs.find((a) => a.family === 'IPv4' && /^100\.\d+\.\d+\.\d+$/.test(a.address));
      if (v4) {
        localTailscaleOk = true;
        localTailscaleIp = v4.address;
        break;
      }
    }
    if (!localTailscaleOk) {
      const tsBin = fs.existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
        ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
        : 'tailscale';
      const tsRes = await runCmd(tsBin, ['ip', '-4'], 1500);
      const candidate = (tsRes.stdout || '')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => /^100\.\d+\.\d+\.\d+$/.test(l));
      if (candidate) {
        localTailscaleOk = true;
        localTailscaleIp = candidate;
      }
    }
  } catch {}

  const nodesStatus = mcpData?.nodesStatus || {};
  const nodeEntries = Object.values(nodesStatus);
  const onlineNodeEntries = nodeEntries.filter((n) => n && n.online);
  const anyNodeOnline = onlineNodeEntries.length > 0 || Boolean(mcpData?.remoteCli?.online);
  const anyMcpOk = nodeEntries.some((n) => n && n.mcpOk) || Boolean(mcpData?.mcpStatus?.ok);
  const totalCliProcs = nodeEntries.reduce((acc, n) => acc + Number(n?.processCount || 0), 0) || (mcpData?.remoteCli?.processCount ?? activePtyTabs.size);
  const bestPing = onlineNodeEntries.length > 0
    ? Math.min(...onlineNodeEntries.map((n) => Number(n.pingMs || 999)))
    : (mcpData?.mcpStatus?.pingMs || null);
  const activeHostSummary = onlineNodeEntries.length > 0
    ? onlineNodeEntries.map((n) => n.sshHost).join('+')
    : ((loadNodes().find((n) => n.enabled && n.sshHost) || loadNodes()[0] || {}).sshHost || '');
  const egressIp = onlineNodeEntries[0]?.egressIp || mcpData?.remoteCli?.egressIp || '210.121.44.96';
  const remoteTailscaleOk = Boolean(mcpData?.remoteCli?.tailscaleOk);
  const remoteTailscaleIp = mcpData?.remoteCli?.tailscaleIp || '';

  return {
    ok: true,
    ssh: {
      online: anyNodeOnline,
      host: activeHostSummary,
      ingressIp: '210.126.238.129',
      egressIp,
      egressLocked: egressIp === '210.121.44.96',
      pingMs: bestPing,
      remoteCliProcesses: totalCliProcs,
      activeWorkbenchTabs: activePtyTabs.size,
      onlineNodesCount: onlineNodeEntries.length,
      totalNodesCount: nodeEntries.length || 1,
    },
    nodesStatus,
    tailscale: {
      ok: remoteTailscaleOk || localTailscaleOk,
      remoteDaemonActive: remoteTailscaleOk,
      remoteIp: remoteTailscaleIp,
      localIp: localTailscaleIp,
    },
    mcp: {
      ok: anyMcpOk,
      localHttpOk: Boolean(mcpData?.mcpStatus?.localMcpOk),
      remoteTunnelOk: anyMcpOk || Boolean(mcpData?.mcpStatus?.remoteTunnelOk),
      edaBridgeOk: Boolean(mcpData?.mcpStatus?.edaBridgeOk),
      tools: mcpData?.mcpStatus?.tools || 23,
    },
    syncthing: {
      ok: Boolean(mcpData?.diskSync?.connected) || (mcpData?.diskSync?.inSyncFiles > 0),
      connected: Boolean(mcpData?.diskSync?.connected),
      state: mcpData?.diskSync?.state || 'idle',
      inSyncFiles: mcpData?.diskSync?.inSyncFiles || 0,
      globalFiles: mcpData?.diskSync?.globalFiles || 0,
      needFiles: mcpData?.diskSync?.needFiles || 0,
      needBytes: mcpData?.diskSync?.needBytes || 0,
    },
    healing: Boolean(mcpData?.healing),
    timestamp: Date.now(),
  };
}

// ============================================================================
// 4B. Remote helpers for inline chat images & Claude OAuth meta + ChatHub WebSocket
// ============================================================================
const DOCKTERM_REMOTE_PY = String.raw`
import os, sys, json, glob, base64

cfg = json.loads(base64.b64decode(CFG_B64).decode("utf-8"))
mode = cfg.get("mode", "meta")
home = os.path.expanduser("~")
proj_root = os.path.join(home, ".claude", "projects")
proj_root_real = os.path.realpath(proj_root)

def out(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()

def queued_prompt(obj):
    a = obj.get("attachment") if isinstance(obj.get("attachment"), dict) else {}
    if a.get("type") != "queued_command" or a.get("commandMode", "prompt") != "prompt" or a.get("isMeta"):
        return None
    origin = a.get("origin") if isinstance(a.get("origin"), dict) else {}
    if origin.get("kind") != "human" and not a.get("humanTurn"):
        return None
    p = a.get("prompt")
    return p if isinstance(p, (str, list)) else None

def iter_images(content):
    found = []
    if isinstance(content, list):
        for b in content:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "image":
                found.append(b)
            elif b.get("type") == "tool_result" and isinstance(b.get("content"), list):
                for ib in b["content"]:
                    if isinstance(ib, dict) and ib.get("type") == "image":
                        found.append(ib)
    return found

def safe_jsonl(p):
    if not p:
        return ""
    real = os.path.realpath(p)
    if not real.startswith(proj_root_real + os.sep) or not real.endswith(".jsonl") or not os.path.isfile(real):
        return ""
    return real

if mode == "image":
    fp = safe_jsonl(cfg.get("path", ""))
    off = int(cfg.get("off", -1))
    idx = int(cfg.get("idx", -1))
    if not fp or off < 0 or idx < 0:
        out({"error": "bad-ref"})
        sys.exit(0)
    with open(fp, "rb") as f:
        f.seek(off)
        line = f.readline()
    try:
        obj = json.loads(line.decode("utf-8", "ignore"))
    except Exception:
        obj = None
    if not isinstance(obj, dict) or (cfg.get("uuid") and obj.get("uuid") != cfg.get("uuid")):
        out({"error": "moved"})
        sys.exit(0)
    msg = obj.get("message") if isinstance(obj.get("message"), dict) else {}
    imgs = iter_images(queued_prompt(obj) if obj.get("type") == "attachment" else msg.get("content"))
    src = imgs[idx].get("source") if idx < len(imgs) and isinstance(imgs[idx].get("source"), dict) else {}
    if src.get("type") != "base64" or not isinstance(src.get("data"), str):
        out({"error": "not-inline"})
        sys.exit(0)
    out({"mediaType": src.get("media_type") or "image/png", "data": src["data"]})
    sys.exit(0)

if mode == "meta":
    want = set(cfg.get("parts") or [])
    res = {}
    try:
        with open(os.path.join(home, ".claude.json")) as f:
            cj = json.load(f)
        if not isinstance(cj, dict):
            cj = {}
    except Exception:
        cj = {}
    acct = cj.get("oauthAccount") if isinstance(cj.get("oauthAccount"), dict) else {}
    res["plan"] = acct.get("billingType") or acct.get("subscriptionType") or ""

    if "usage" in want:
        u = None
        src = ""
        err = ""
        fetched = 0
        cu = cj.get("cachedUsageUtilization") if isinstance(cj.get("cachedUsageUtilization"), dict) else {}
        if isinstance(cu.get("utilization"), dict):
            u = cu["utilization"]
            src = "cache"
            fetched = cu.get("fetchedAtMs") or 0
        def pick(key):
            v = u.get(key) if isinstance(u, dict) else None
            if isinstance(v, dict) and v.get("utilization") is not None:
                return {"pct": v.get("utilization"), "resetsAt": v.get("resets_at")}
            return None
        res["usage"] = {
            "fiveHour": pick("five_hour"),
            "week": pick("seven_day"),
            "weekOpus": pick("seven_day_opus"),
            "weekSonnet": pick("seven_day_sonnet"),
            "source": src,
            "fetchedAt": fetched,
        } if isinstance(u, dict) else None
        res["usageError"] = err if res["usage"] else "no-cache"

    if "models" in want:
        res["models"] = [
            {"id": "default", "name": "Default (CLI 默认)", "line": "", "efforts": ["low", "medium", "high", "xhigh", "max"]},
            {"id": "opus", "name": "Opus", "line": "opus", "efforts": ["low", "medium", "high", "xhigh", "max"]},
            {"id": "sonnet", "name": "Sonnet", "line": "sonnet", "efforts": ["low", "medium", "high", "xhigh", "max"]},
            {"id": "haiku", "name": "Haiku", "line": "haiku", "efforts": ["low", "medium", "high"]},
        ]
        extra = cj.get("additionalModelOptionsCache")
        res["extraModels"] = [
            {"id": o.get("value"), "name": o.get("label") or o.get("value"), "description": o.get("description") or ""}
            for o in (extra if isinstance(extra, list) else []) if isinstance(o, dict) and isinstance(o.get("value"), str)
        ]

    if "commands" in want:
        cmds = []
        seen = set()
        cwd_ = (cfg.get("cwd") or home).rstrip("/") or "/"
        def scan_md(path_, default_name):
            name = default_name
            desc = ""
            try:
                with open(path_, "r", encoding="utf-8", errors="ignore") as f:
                    lines = [f.readline() for _ in range(40)]
                if lines and lines[0].strip() == "---":
                    for ln in lines[1:]:
                        s = ln.strip()
                        if s == "---":
                            break
                        if s.startswith("name:") and s[5:].strip():
                            name = s[5:].strip().strip("\"'")
                        elif s.startswith("description:") and s[12:].strip():
                            desc = s[12:].strip().strip("\"'")
                if not desc:
                    for ln in lines:
                        s = ln.strip()
                        if s and not s.startswith("#") and s != "---" and not s.startswith("name:") and not s.startswith("description:"):
                            desc = s[:120]
                            break
            except Exception:
                pass
            if name and name not in seen:
                seen.add(name)
                cmds.append({"name": name, "description": desc})

        for base in (os.path.join(cwd_, ".claude"), os.path.join(home, ".claude")):
            for p in sorted(glob.glob(os.path.join(base, "commands", "*.md"))):
                scan_md(p, os.path.splitext(os.path.basename(p))[0])
            for p in sorted(glob.glob(os.path.join(base, "skills", "*", "SKILL.md"))):
                scan_md(p, os.path.basename(os.path.dirname(p)))
        res["commands"] = cmds

    if "current" in want:
        merged = {}
        cwd_ = (cfg.get("cwd") or home).rstrip("/") or "/"
        for p in (os.path.join(home, ".claude", "settings.json"),
                  os.path.join(cwd_, ".claude", "settings.json"),
                  os.path.join(cwd_, ".claude", "settings.local.json")):
            try:
                with open(p) as f:
                    d = json.load(f)
            except Exception:
                continue
            if isinstance(d, dict):
                for key in ("model", "effortLevel", "modelSettings"):
                    if key in d:
                        merged[key] = d[key]
        res["settings"] = {
            "model": merged.get("model") if isinstance(merged.get("model"), str) else "",
            "effortLevel": merged.get("effortLevel") if isinstance(merged.get("effortLevel"), str) else "",
            "modelSettings": merged.get("modelSettings") if isinstance(merged.get("modelSettings"), dict) else {},
        }
    out(res)
    sys.exit(0)
`.trim();

function buildDocktermRemotePy(cfg) {
  const cfgB64 = Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64');
  return DOCKTERM_REMOTE_PY.replace('CFG_B64', JSON.stringify(cfgB64));
}

// One multiplexed SSH connection per node for metadata/file/transcript reads
const DOCKTERM_SSH_OPTS = [
  '-o', 'ConnectTimeout=4',
  '-o', 'BatchMode=yes',
  '-o', 'ControlMaster=auto',
  '-o', 'ControlPath=/tmp/takt-chat-mux-%r@%h:%p',
  '-o', 'ControlPersist=120s',
  '-o', 'ClearAllForwardings=yes',
];

async function runDocktermRemotePy(host, cfg, timeoutMs) {
  const b64 = Buffer.from(buildDocktermRemotePy(cfg), 'utf8').toString('base64');
  const r = await runCmd('ssh', [
    ...DOCKTERM_SSH_OPTS,
    host,
    `python3 -c "import base64;exec(base64.b64decode('${b64}'))"`,
  ], timeoutMs);
  if (r.exitCode !== 0 || !r.stdout.trim()) return null;
  try {
    return JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    return null;
  }
}

const chatHub = createChatHub({
  getNodeById,
  runCmd,
  sshOpts: DOCKTERM_SSH_OPTS,
  sanitizeTmuxSessionId,
  activePtyTabs,
  onSessionActivity: ({ nodeId, cwd, sessionId, title }) => {
    try {
      registerSessionInSqlite({ id: sessionId, nodeId, cwd, title });
    } catch {}
  },
});

// ============================================================================
// 4C. Local copies on the Mac: remote files, inline chat images, Claude usage/models
//     Everything the UI previews or opens is read from the Mac's disk. Files outside the
//     Syncthing mirror (or not synced yet) are copied once over SSH into a local cache.
// ============================================================================
const TAKT_CACHE_DIR = path.join(BASE_TAKT_DIR, 'cache');
const REMOTE_FILE_CACHE_DIR = path.join(TAKT_CACHE_DIR, 'remote-files');
const CHAT_IMAGE_CACHE_DIR = path.join(TAKT_CACHE_DIR, 'chat-images');
const TAKT_CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const REMOTE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
const REMOTE_OPEN_MAX_BYTES = 512 * 1024 * 1024;

function sha1Hex(str) {
  return crypto.createHash('sha1').update(String(str)).digest('hex');
}

function formatByteSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Paths that already live on this Mac (never fetched from a node)
function isLocalMacPath(p) {
  const s = String(p || '');
  return s.startsWith('/Users/') || s === BASE_TAKT_DIR || s.startsWith(`${BASE_TAKT_DIR}/`) || s.startsWith(`${KOREA_WORKSPACE_DIR}/`);
}

function remoteShellPath(p) {
  if (p === '~') return '"$HOME"';
  if (p.startsWith('~/')) return `"$HOME"/${shSingleQuote(p.slice(2))}`;
  return shSingleQuote(p);
}

function streamSshToFile(host, command, filePath, timeoutMs) {
  return new Promise((resolve) => {
    let fd;
    try {
      fd = fs.openSync(filePath, 'w');
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch {}
      resolve(ok);
    };
    const child = spawn('ssh', [...DOCKTERM_SSH_OPTS, host, command], {
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`,
      },
      stdio: ['ignore', fd, 'ignore'],
    });
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

let taktCacheLastPrune = 0;
async function pruneTaktCache() {
  const now = Date.now();
  if (now - taktCacheLastPrune < 3600 * 1000) return;
  taktCacheLastPrune = now;
  const walk = async (dir, depth) => {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) {
          if (depth > 0) await walk(p, depth - 1);
          const left = await fsp.readdir(p);
          if (!left.length) await fsp.rmdir(p);
        } else if (now - (await fsp.stat(p)).mtimeMs > TAKT_CACHE_MAX_AGE_MS) {
          await fsp.rm(p, { force: true });
        }
      } catch {}
    }
  };
  await walk(REMOTE_FILE_CACHE_DIR, 2);
  await walk(CHAT_IMAGE_CACHE_DIR, 0);
}

const remoteFileInflight = new Map();
const remoteFileMisses = new Map(); // short negative cache: a gallery of missing paths must not hammer SSH

/** Copy a node file into the Mac cache (re-used while size + mtime are unchanged). */
async function ensureRemoteFileCopy(node, remotePath, maxBytes = REMOTE_PREVIEW_MAX_BYTES) {
  const rp = String(remotePath || '');
  if (!node || !node.sshHost || !(rp.startsWith('/') || rp.startsWith('~/')) || isLocalMacPath(rp)) {
    return { ok: false, error: 'Mac 本地没有这个文件，也没有可读取它的远端节点' };
  }
  const key = `${node.id}::${rp}`;
  const miss = remoteFileMisses.get(key);
  if (miss && Date.now() - miss.at < 15000) return miss.result;
  if (remoteFileInflight.has(key)) return remoteFileInflight.get(key);

  const job = (async () => {
    const q = remoteShellPath(rp);
    const st = await runCmd('ssh', [...DOCKTERM_SSH_OPTS, node.sshHost, `stat -L -c '%s %Y %F' -- ${q}`], 8000);
    const m = (st.stdout.trim().split('\n').pop() || '').match(/^(\d+) (\d+) (.+)$/);
    if (st.exitCode !== 0 || !m) return { ok: false, error: `Mac 本地和节点 ${node.badge || node.id} 上都没有找到这个文件`, missing: true };
    const size = Number(m[1]);
    const mtime = Number(m[2]);
    if (!/regular/.test(m[3])) {
      const isDir = /directory/.test(m[3]);
      return { ok: false, isDir, missing: true, error: isDir ? '这是一个目录' : '不是普通文件' };
    }
    if (size > maxBytes) {
      return { ok: false, tooLarge: true, size, error: `文件太大（${formatByteSize(size)}），超过 ${formatByteSize(maxBytes)} 的拷贝上限` };
    }
    const dir = path.join(REMOTE_FILE_CACHE_DIR, String(node.id).replace(/[^a-zA-Z0-9_-]/g, '_'), sha1Hex(rp).slice(0, 16));
    const localPath = path.join(dir, path.posix.basename(rp) || 'file');
    const metaPath = path.join(dir, '.meta.json');
    try {
      const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
      if (meta.size === size && meta.mtime === mtime && fs.existsSync(localPath)) {
        return { ok: true, localPath, size, cached: true };
      }
    } catch {}
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${localPath}.part-${process.pid}-${Date.now()}`;
    const ok = await streamSshToFile(node.sshHost, `cat -- ${q}`, tmp, 20000 + Math.ceil(size / (1024 * 1024)) * 3000);
    let got = -1;
    try { got = (await fsp.stat(tmp)).size; } catch {}
    if (!ok || got !== size) {
      await fsp.rm(tmp, { force: true });
      return { ok: false, error: '从节点拷贝文件失败（文件可能正在写入）' };
    }
    await fsp.rename(tmp, localPath);
    await fsp.writeFile(metaPath, JSON.stringify({ remotePath: rp, nodeId: node.id, size, mtime, fetchedAt: Date.now() }));
    pruneTaktCache().catch(() => {});
    return { ok: true, localPath, size, cached: false };
  })()
    .catch((err) => ({ ok: false, error: err.message }))
    .then((result) => {
      if (!result.ok && result.missing) remoteFileMisses.set(key, { at: Date.now(), result });
      else remoteFileMisses.delete(key);
      return result;
    })
    .finally(() => remoteFileInflight.delete(key));
  remoteFileInflight.set(key, job);
  return job;
}

/** Resolve a path from the conversation to something readable on this Mac. */
async function resolveReadableLocalFile(reqPath, cwd, nodeId, maxBytes = REMOTE_PREVIEW_MAX_BYTES) {
  const r = resolveAnyFilePathToLocalAndRemote(reqPath, cwd, nodeId);
  if (r.localPath) {
    try {
      const st = fs.statSync(r.localPath);
      return { ...r, readPath: r.localPath, fromRemote: false, isDir: st.isDirectory(), size: st.size };
    } catch {}
  }
  const copy = await ensureRemoteFileCopy(r.node, r.remotePath, maxBytes);
  if (!copy.ok) return { ...r, readPath: '', fromRemote: false, error: copy.error, isDir: Boolean(copy.isDir), tooLarge: Boolean(copy.tooLarge), size: copy.size };
  return { ...r, readPath: copy.localPath, fromRemote: true, isDir: false, size: copy.size };
}

const CHAT_IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const chatImageInflight = new Map();

/** Images pasted into the conversation live base64-encoded in the node's transcript. */
async function ensureChatImageCopy({ nodeId, path: jsonlPath, off, idx, u }) {
  const node = getNodeById(nodeId);
  const host = node && node.sshHost;
  const p = String(jsonlPath || '');
  const o = Number(off);
  const i = Number(idx);
  if (!host || !/\/\.claude\/projects\/[^/]+\/[^/]+\.jsonl$/.test(p) || !Number.isInteger(o) || o < 0 || !Number.isInteger(i) || i < 0 || i > 256) {
    return { ok: false, error: '图片引用无效' };
  }
  const key = sha1Hex(`${host}|${p}|${o}|${i}|${u || ''}`).slice(0, 24);
  for (const ext of new Set(Object.values(CHAT_IMAGE_EXT))) {
    const f = path.join(CHAT_IMAGE_CACHE_DIR, key + ext);
    if (fs.existsSync(f)) return { ok: true, localPath: f };
  }
  if (chatImageInflight.has(key)) return chatImageInflight.get(key);
  const job = (async () => {
    const raw = await runDocktermRemotePy(host, { mode: 'image', path: p, off: o, idx: i, uuid: String(u || '') }, 20000);
    if (!raw || raw.error || typeof raw.data !== 'string') {
      return { ok: false, error: raw && raw.error === 'moved' ? '对话记录已变化，找不到这张图片' : '从节点读取图片失败' };
    }
    const ext = CHAT_IMAGE_EXT[String(raw.mediaType || '').toLowerCase()];
    if (!ext) return { ok: false, error: `不支持的图片格式 ${raw.mediaType}` };
    await fsp.mkdir(CHAT_IMAGE_CACHE_DIR, { recursive: true });
    const f = path.join(CHAT_IMAGE_CACHE_DIR, key + ext);
    const tmp = `${f}.part-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, Buffer.from(raw.data, 'base64'));
    await fsp.rename(tmp, f);
    pruneTaktCache().catch(() => {});
    return { ok: true, localPath: f };
  })()
    .catch((err) => ({ ok: false, error: err.message }))
    .finally(() => chatImageInflight.delete(key));
  chatImageInflight.set(key, job);
  return job;
}

// What `open` may do with a file. Documents open in their app, text in the text editor;
// anything that could execute (apps, scripts with a launcher, unknown binaries) is only revealed.
const MAC_OPEN_DOC_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.svg', '.ico', '.psd',
  '.pdf', '.html', '.htm',
  '.glb', '.gltf', '.stl', '.obj', '.fbx', '.3mf', '.ply', '.usdz', '.step', '.stp', '.iges', '.igs',
  '.fcstd', '.blend', '.dxf', '.dwg', '.epro', '.epro2', '.kicad_pcb', '.kicad_sch', '.kicad_pro',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.key', '.pages', '.numbers', '.rtf', '.csv',
  '.mp4', '.mov', '.m4v', '.webm', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg',
]);
const MAC_OPEN_TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.log', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.css', '.scss', '.less', '.xml',
  '.py', '.ipynb', '.sh', '.bash', '.zsh', '.fish', '.c', '.cc', '.cpp', '.h', '.hpp', '.m', '.mm', '.swift',
  '.rs', '.go', '.java', '.kt', '.rb', '.php', '.pl', '.lua', '.r', '.sql', '.cmake', '.mk', '.ld', '.s',
  '.gitignore', '.stignore', '.dockerfile', '.lock',
]);

function macOpenArgs(target, reveal) {
  if (reveal) return { mode: 'reveal', args: ['-R', target] };
  let st = null;
  try { st = fs.statSync(target); } catch {}
  if (!st) return { mode: 'reveal', args: ['-R', target] };
  if (st.isDirectory()) {
    return /\.(app|bundle|framework|plugin|kext|prefpane|workflow|action|pkg|mpkg|saver|qlgenerator)$/i.test(target)
      ? { mode: 'reveal', args: ['-R', target] }
      : { mode: 'open', args: [target] };
  }
  const ext = path.extname(target).toLowerCase();
  const base = path.basename(target).toLowerCase();
  if (MAC_OPEN_DOC_EXTS.has(ext)) return { mode: 'open', args: [target] };
  if (MAC_OPEN_TEXT_EXTS.has(ext) || ['dockerfile', 'makefile', 'readme', 'license', 'claude.md'].includes(base)) {
    return { mode: 'text', args: ['-t', target] };
  }
  return { mode: 'reveal', args: ['-R', target] };
}

// Attachments for a prompt: <session cwd>/.takt/uploads/<stamp>-<name> on the node. The folder
// carries a "*" .gitignore so uploads never show up in the project's git status.
const CHAT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

function chatUploadName(raw) {
  const base = path.posix.basename(String(raw || '').replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '').trim();
  const safe = base.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').replace(/^[.\-]+/, '').slice(-80) || 'file';
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}-${safe}`;
}

function uploadChatAttachment(node, cwd, rawName, stream, size) {
  const dir = path.posix.join(cwd.replace(/\/+$/, '') || '/', '.takt', 'uploads');
  const name = chatUploadName(rawName);
  const remotePath = path.posix.join(dir, name);
  const qd = shSingleQuote(dir);
  const qf = shSingleQuote(remotePath);
  const qp = shSingleQuote(`${remotePath}.part`);
  const cmd = `mkdir -p ${qd} && { [ -e ${qd}/.gitignore ] || printf '*\\n' > ${qd}/.gitignore; } && cat > ${qp} && mv -f ${qp} ${qf} && echo takt-upload-ok`;
  return new Promise((resolve) => {
    let settled = false;
    let received = 0;
    let out = '';
    let err = '';
    let timer = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn('ssh', [...DOCKTERM_SSH_OPTS, node.sshHost, cmd], {
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ ok: false, error: '上传超时' });
    }, 30000 + Math.ceil(size / (1024 * 1024)) * 4000);
    stream.on('data', (chunk) => {
      received += chunk.length;
      if (received > CHAT_UPLOAD_MAX_BYTES) {
        try { child.kill('SIGKILL'); } catch {}
        finish({ ok: false, error: '文件太大' });
      }
    });
    stream.on('error', () => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ ok: false, error: '上传中断' });
    });
    child.stdin.on('error', () => {});
    stream.pipe(child.stdin);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (code === 0 && out.includes('takt-upload-ok') && received === size) {
        finish({ ok: true, remotePath, name, size: received });
      } else {
        finish({ ok: false, error: (err.trim().split('\n').pop() || `上传失败（${code}）`).slice(0, 200) });
      }
    });
  });
}

// Claude cached usage, models, settings & commands per node — strictly reads local files
// on the node; never reads OAuth tokens or makes external Anthropic API requests.
const claudeMetaCache = new Map(); // host -> { usage, models, commandsByCwd: Map }

async function fetchClaudeMeta({ nodeId, cwd, parts, force }) {
  const node = getNodeById(nodeId);
  const host = node && node.sshHost;
  if (!host) return { ok: false, error: '该节点没有配置 SSH 主机' };
  const want = new Set(String(parts || 'usage,models,current').split(',').map((x) => x.trim()).filter(Boolean));
  const now = Date.now();
  let c = claudeMetaCache.get(host);
  if (!c) {
    c = { commandsByCwd: new Map() };
    claudeMetaCache.set(host, c);
  }
  const cleanCwd = String(cwd || '').trim();
  const cmdCached = c.commandsByCwd.get(cleanCwd);
  const need = [];
  if (want.has('usage') && (force || !c.usage || now - c.usage.at > 60 * 1000)) need.push('usage');
  if (want.has('models') && (force || !c.models || now - c.models.at > 6 * 3600 * 1000)) need.push('models');
  if (want.has('commands') && (force || !cmdCached || now - cmdCached.at > 5 * 60 * 1000)) need.push('commands');
  if (want.has('current')) need.push('current');

  let settings = null;
  let error = '';
  if (need.length) {
    const raw = await runDocktermRemotePy(host, { mode: 'meta', parts: need, cwd: cleanCwd }, 12000);
    if (!raw) {
      error = '无法连接节点';
    } else {
      if (need.includes('usage')) c.usage = { at: now, data: { usage: raw.usage || null, error: raw.usageError || '', plan: raw.plan || '' } };
      if (need.includes('models')) c.models = { at: now, data: { models: Array.isArray(raw.models) ? raw.models : [], extraModels: Array.isArray(raw.extraModels) ? raw.extraModels : [], error: '' } };
      if (need.includes('commands')) c.commandsByCwd.set(cleanCwd, { at: now, commands: Array.isArray(raw.commands) ? raw.commands : [] });
      if (need.includes('current')) settings = raw.settings || null;
    }
  }
  const out = { ok: !error || Boolean(c.usage || c.models), nodeId: node.id, error };
  if (want.has('usage')) {
    out.usage = c.usage ? c.usage.data.usage : null;
    out.usageError = c.usage ? c.usage.data.error : error;
    out.plan = c.usage ? c.usage.data.plan : '';
    out.usageCheckedAt = c.usage ? c.usage.at : 0;
  }
  if (want.has('models')) {
    out.models = c.models ? c.models.data.models : [];
    out.extraModels = c.models ? c.models.data.extraModels : [];
    out.modelsError = '';
  }
  if (want.has('commands')) {
    const entry = c.commandsByCwd.get(cleanCwd);
    out.commands = entry ? entry.commands : [];
  }
  if (want.has('current')) out.settings = settings;
  return out;
}

// ============================================================================
// 5. HTTP & WebSocket Server
// ============================================================================
function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    // --- Local-only guard: blocks DNS-rebinding (bad Host) and cross-site requests (bad Origin) ---
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden host');
      return;
    }
    if (req.headers.origin && req.method !== 'GET' && req.method !== 'HEAD' && !isSameLocalOrigin(req.headers.origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden origin');
      return;
    }

    // Serve vendor static files (with ~/.takt-ai/terminal-workbench fallback against iCloud dataless eviction)
    if (req.method === 'GET' && u.pathname.startsWith('/vendor/')) {
      const rel = u.pathname.slice('/vendor/'.length);
      if (!rel || rel.includes('/') || rel.includes('\\') || rel.includes('..')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const fileName = path.basename(rel);
      const primaryPath = path.join(VENDOR_DIR, fileName);
      const fallbackPath = path.join(BASE_TAKT_DIR, 'terminal-workbench', 'vendor', fileName);
      for (const candidate of [primaryPath, fallbackPath]) {
        try {
          if (fs.existsSync(candidate)) {
            const buf = await fsp.readFile(candidate);
            const ext = path.extname(fileName).toLowerCase();
            res.writeHead(200, { 'Content-Type': MIME_MAP[ext] || 'application/octet-stream' });
            res.end(buf);
            return;
          }
        } catch {}
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    // Serve Claude Chat frontend modules (with ~/.takt-ai/terminal-workbench/chat fallback)
    if (req.method === 'GET' && u.pathname.startsWith('/chat/')) {
      const rel = u.pathname.slice('/chat/'.length);
      if (!rel || rel.includes('/') || rel.includes('\\') || rel.includes('..')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const fileName = path.basename(rel);
      const primaryPath = path.join(CHAT_PUBLIC_DIR, fileName);
      const fallbackPath = path.join(BASE_TAKT_DIR, 'terminal-workbench', 'chat', fileName);
      for (const candidate of [primaryPath, fallbackPath]) {
        try {
          if (fs.existsSync(candidate)) {
            const buf = await fsp.readFile(candidate);
            const ext = path.extname(fileName).toLowerCase();
            res.writeHead(200, {
              'Content-Type': MIME_MAP[ext] || 'application/octet-stream',
              'Cache-Control': 'no-store',
            });
            res.end(buf);
            return;
          }
        } catch {}
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    // Serve main UI (with ~/.takt-ai/terminal-workbench fallback against iCloud dataless eviction)
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      const primaryHtmlPath = path.join(PUBLIC_DIR, 'index.html');
      const fallbackHtmlPath = path.join(BASE_TAKT_DIR, 'terminal-workbench', 'index.html');
      let html = null;
      try {
        html = await fsp.readFile(primaryHtmlPath, 'utf8');
      } catch (err) {
        html = await fsp.readFile(fallbackHtmlPath, 'utf8');
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }

    // API: Get Multi-Node Projects & Conversations Tree + Active Tabs (Served from Local SQLite in <1ms)
    if (req.method === 'GET' && u.pathname === '/api/tree') {
      const forceSync = u.searchParams.get('sync') === '1';
      if (forceSync || lastSqliteSyncAt === 0) {
        await syncAllNodesToSqlite();
      } else if (Date.now() - lastSqliteSyncAt > 6000) {
        syncAllNodesToSqlite().catch(() => {});
      }
      const tree = readTreeFromSqlite();
      const openTabs = Array.from(activePtyTabs.values()).map((t) => ({
        tabId: t.tabId,
        sessionId: t.sessionId,
        title: t.title,
        cwd: t.cwd,
        nodeId: t.nodeId,
        nodeName: t.nodeName,
        nodeBadge: t.nodeBadge,
        sshHost: t.sshHost,
        localWorkDir: t.localWorkDir,
        localWorkAlias: t.localWorkAlias,
        mode: t.mode,
        createdAt: t.createdAt,
      }));
      sendJson(res, 200, { ...tree, ...readTagsFromSqlite(), openTabs });
      return;
    }

    // API: Tags CRUD (local SQLite)
    if (u.pathname === '/api/tags' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim().slice(0, 24);
      if (!name) { sendJson(res, 400, { ok: false, error: '标签名不能为空' }); return; }
      const id = `tag_${crypto.randomUUID().slice(0, 8)}`;
      const maxSort = workbenchDb.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM tags').get().m;
      workbenchDb.prepare('INSERT INTO tags (id, name, color, sort, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, name, String(body.color || 'blue'), maxSort + 1, Date.now());
      sendJson(res, 200, { ok: true, id, ...readTagsFromSqlite() });
      return;
    }
    if (u.pathname === '/api/tags' && req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const id = String(body.id || '');
      if (body.name !== undefined) {
        const name = String(body.name).trim().slice(0, 24);
        if (name) workbenchDb.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, id);
      }
      if (body.color) workbenchDb.prepare('UPDATE tags SET color = ? WHERE id = ?').run(String(body.color), id);
      sendJson(res, 200, { ok: true, ...readTagsFromSqlite() });
      return;
    }
    if (u.pathname === '/api/tags' && req.method === 'DELETE') {
      const id = String(u.searchParams.get('id') || '');
      workbenchDb.prepare('DELETE FROM tags WHERE id = ?').run(id);
      workbenchDb.prepare('DELETE FROM project_tags WHERE tag_id = ?').run(id);
      sendJson(res, 200, { ok: true, ...readTagsFromSqlite() });
      return;
    }
    if (u.pathname === '/api/project-tag' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const key = String(body.projectKey || '');
      const tagId = body.tagId ? String(body.tagId) : '';
      if (!key) { sendJson(res, 400, { ok: false, error: 'Missing projectKey' }); return; }
      if (tagId) {
        workbenchDb.prepare('INSERT INTO project_tags (project_key, tag_id) VALUES (?, ?) ON CONFLICT(project_key) DO UPDATE SET tag_id = excluded.tag_id').run(key, tagId);
        // Tagged projects should always stay visible in the sidebar
        workbenchDb.prepare('UPDATE projects SET pinned_visible = 1 WHERE key = ?').run(key);
      } else {
        workbenchDb.prepare('DELETE FROM project_tags WHERE project_key = ?').run(key);
      }
      sendJson(res, 200, { ok: true, ...readTagsFromSqlite() });
      return;
    }

    // API: List Configured Linux Nodes + Discovered ~/.ssh/config Hosts
    if (req.method === 'GET' && u.pathname === '/api/nodes') {
      const nodes = loadNodes();
      const sshCandidates = discoverSshConfigHosts();
      sendJson(res, 200, { ok: true, nodes, sshCandidates });
      return;
    }

    // API: Create or Update a Linux Node (binds SSH Host <-> local workN + Syncthing + MCP Reverse Tunnel)
    if (req.method === 'POST' && u.pathname === '/api/nodes') {
      const body = await readJsonBody(req);
      const nodes = loadNodes();
      const id = String(body.id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '') || `linux-${Date.now().toString(36)}`;
      const name = String(body.name || '').trim() || id;
      const badge = String(body.badge || '').trim().slice(0, 8) || `LX-${nodes.length + 1}`;
      const sshHost = String(body.sshHost || '').trim();
      const remoteWorkDir = (String(body.remoteWorkDir || '/root/work').trim().replace(/\/+$/, '')) || '/root/work';
      const aliasRaw = String(body.localWorkAlias || `work${nodes.length + 1}`).trim().replace(/[^a-zA-Z0-9_-]/g, '') || `work${nodes.length + 1}`;
      const localWorkDir = path.join(BASE_TAKT_DIR, aliasRaw);
      const syncthingFolderId = String(body.syncthingFolderId || `takt-${aliasRaw}`).trim();
      const enabled = body.enabled !== undefined ? Boolean(body.enabled) : Boolean(sshHost);

      let target = nodes.find((n) => n.id === id);
      if (target) {
        target.name = name;
        target.badge = badge;
        target.sshHost = sshHost;
        target.remoteWorkDir = remoteWorkDir;
        target.localWorkAlias = aliasRaw;
        target.localWorkDir = localWorkDir;
        target.syncthingFolderId = syncthingFolderId;
        target.enabled = enabled;
      } else {
        target = {
          id,
          name,
          badge,
          sshHost,
          remoteWorkDir,
          localWorkDir,
          localWorkAlias: aliasRaw,
          syncthingFolderId,
          syncthingDeviceId: '',
          enabled,
        };
        nodes.push(target);
      }

      saveNodes(nodes);
      const prov = await provisionLinuxNode(target);
      saveNodes(nodes);
      syncAllNodesToSqlite().catch(() => {});
      fetch('http://127.0.0.1:18765/system-heal', { method: 'POST' }).catch(() => {});
      sendJson(res, 200, { ok: true, node: target, nodes, logs: prov.logs });
      return;
    }

    // API: Delete a Linux Node config, clean SQLite rows & tunnel (never deletes local workN files)
    if (req.method === 'DELETE' && u.pathname === '/api/nodes') {
      const id = String(u.searchParams.get('id') || '').trim();
      if (!id) {
        sendJson(res, 400, { ok: false, error: '缺少节点 ID' });
        return;
      }
      const allNodes = loadNodes();
      const targetNode = allNodes.find((n) => n.id === id);
      const nodes = allNodes.filter((n) => n.id !== id);
      if (nodes.length === 0) {
        sendJson(res, 400, { ok: false, error: '至少保留一个节点' });
        return;
      }
      for (const [tid, tab] of activePtyTabs.entries()) {
        if (tab && tab.nodeId === id) {
          closePtyTab(tid, id);
        }
      }
      saveNodes(nodes);
      try {
        workbenchDb.prepare('DELETE FROM projects WHERE node_id = ?').run(id);
        workbenchDb.prepare('DELETE FROM sessions WHERE node_id = ?').run(id);
        workbenchDb.prepare('DELETE FROM node_status WHERE node_id = ?').run(id);
        workbenchDb.prepare('DELETE FROM project_tags WHERE project_key LIKE ?').run(`${id}::%`);
      } catch {}
      const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
      const sockDir = path.join(os.homedir(), '.ssh', 'sockets');
      const sockPaths = [path.join(sockDir, `takt-mcp-tunnel-${safeId}.sock`)];
      if (id === 'korea-claude') {
        sockPaths.push(path.join(sockDir, 'takt-mcp-tunnel.sock'));
      }
      for (const sock of sockPaths) {
        if (fs.existsSync(sock) && targetNode && targetNode.sshHost) {
          await runCmd('ssh', ['-S', sock, '-O', 'exit', targetNode.sshHost], 2000).catch(() => {});
        }
        try { fs.unlinkSync(sock); } catch {}
      }
      sendJson(res, 200, { ok: true, nodes });
      return;
    }

    // API: Instabox Remote Desktop Plugin (noVNC Web + macOS Native Screen Sharing + AI/Human Control)
    if (u.pathname === '/api/remote-desktop' && (req.method === 'GET' || req.method === 'POST')) {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const r = await fetch('http://127.0.0.1:18765/remote-desktop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: body.action || u.searchParams.get('action') || 'start',
          nodeId: body.nodeId || u.searchParams.get('nodeId') || 'linux-work4',
        }),
      });
      const data = await r.json();
      sendJson(res, r.status, data);
      return;
    }

    // API: Create a new project folder on the specified Linux node & its paired Mac local workN folder
    if (req.method === 'POST' && u.pathname === '/api/projects') {
      const body = await readJsonBody(req);
      const rawName = String(body.name || '').trim().replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5. ]/g, '').trim();
      if (!rawName) {
        sendJson(res, 400, { ok: false, error: '项目名称不能为空' });
        return;
      }
      const node = getNodeById(body.nodeId);
      const remoteRoot = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
      const localDir = path.join(node.localWorkDir, rawName);
      const remoteDir = `${remoteRoot}/${rawName}`;
      await fsp.mkdir(localDir, { recursive: true });
      upsertProjectInSqlite(node, remoteDir, rawName, 1);
      if (node.enabled && node.sshHost) {
        await runCmd('ssh', ['-o', 'ConnectTimeout=4', '-o', 'ClearAllForwardings=yes', node.sshHost, `mkdir -p ${shSingleQuote(remoteDir)}`], 5000);
      }
      sendJson(res, 200, {
        ok: true,
        key: `${node.id}::${remoteDir}`,
        nodeId: node.id,
        nodeBadge: node.badge,
        sshHost: node.sshHost,
        localWorkAlias: node.localWorkAlias,
        localPath: localDir,
        path: remoteDir,
        name: rawName,
      });
      return;
    }

    // API: Immediately register a newly launched session in Local SQLite (for Native SwiftTerm & Web PTY)
    if (req.method === 'POST' && u.pathname === '/api/sessions/register') {
      const body = await readJsonBody(req);
      const sid = String(body.id || '').trim();
      if (!sid) {
        sendJson(res, 400, { ok: false, error: 'Missing session id' });
        return;
      }
      const resolvedNode = getNodeById(body.nodeId);
      registerSessionInSqlite({
        id: sid,
        nodeId: resolvedNode.id,
        cwd: body.cwd || '/root/work',
        title: body.title || `会话 ${sid.slice(0, 8)}`,
      });
      sendJson(res, 200, { ok: true, id: sid });
      return;
    }

    // API: Rename a session (persists in Local SQLite + appends custom-title to remote .jsonl if present)
    if (req.method === 'POST' && u.pathname === '/api/sessions/rename') {
      const body = await readJsonBody(req);
      const sid = String(body.id || '').trim();
      const title = String(body.title || '').trim().slice(0, 120);
      const node = getNodeById(body.nodeId);
      if (!sid || !/^[a-zA-Z0-9_-]+$/.test(sid) || !title) {
        sendJson(res, 400, { ok: false, error: '会话 ID 或新名称不能为空' });
        return;
      }
      saveCustomSessionTitle(sid, title);
      if (activePtyTabs.has(sid)) {
        activePtyTabs.get(sid).title = title;
      }
      if (node && node.enabled && node.sshHost) {
        const lineJson = JSON.stringify({ type: 'custom-title', customTitle: title });
        const b64Line = Buffer.from(lineJson + '\n', 'utf8').toString('base64');
        runCmd('ssh', [
          '-o', 'ConnectTimeout=3',
          '-o', 'ClearAllForwardings=yes',
          node.sshHost,
          `for f in ~/.claude/projects/*/${sid}.jsonl; do [ -f "$f" ] && echo '${b64Line}' | base64 -d >> "$f"; done`,
        ], 4000).catch(() => {});
      }
      sendJson(res, 200, { ok: true, id: sid, title });
      return;
    }

    // API: Delete a session (soft-deletes in Local SQLite immediately + deletes remote .jsonl)
    if (req.method === 'DELETE' && u.pathname === '/api/sessions') {
      const sid = String(u.searchParams.get('id') || '').trim();
      const nodeId = String(u.searchParams.get('nodeId') || '').trim();
      const node = getNodeById(nodeId);
      if (!sid || !/^[a-zA-Z0-9_-]+$/.test(sid)) {
        sendJson(res, 400, { ok: false, error: 'Invalid session id' });
        return;
      }
      stmtSoftDeleteSession.run(Date.now(), sid);
      saveCustomSessionTitle(sid, '');
      closePtyTab(sid, node.id);
      if (node && node.enabled && node.sshHost) {
        await runCmd('ssh', [
          '-o', 'ConnectTimeout=4',
          '-o', 'ClearAllForwardings=yes',
          node.sshHost,
          `find ~/.claude/projects -name ${shSingleQuote(sid + '.jsonl')} -delete`,
        ], 5000);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // API: Close a specific Terminal Tab and terminate its CLI PTY
    if (req.method === 'DELETE' && u.pathname === '/api/tabs') {
      const tabId = String(u.searchParams.get('tabId') || '').trim();
      const nodeId = String(u.searchParams.get('nodeId') || '').trim();
      const closed = closePtyTab(tabId, nodeId);
      sendJson(res, 200, { ok: true, closed });
      return;
    }

    // API: Live file-tree change stream (SSE). The UI reloads the tree silently on each "change" event,
    // so the right-hand file panel stays current without pressing refresh.
    if (req.method === 'GET' && u.pathname === '/api/files-events') {
      const cwd = String(u.searchParams.get('cwd') || '/root/work').trim();
      const nodeId = String(u.searchParams.get('nodeId') || '').trim();
      const node = inferNodeFromPathOrId(cwd, nodeId);
      const localRoot = mapRemoteCwdToLocal(cwd, node.id);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const unsubscribe = subscribeFileChanges(localRoot, () => { try { res.write('event: change\ndata: 1\n\n'); } catch {} });
      res.write(unsubscribe ? 'event: ready\ndata: 1\n\n' : 'event: nowatch\ndata: 1\n\n');
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 20000);
      req.on('close', () => { clearInterval(ka); if (unsubscribe) unsubscribe(); });
      return;
    }

    // API: List files for a session's project directory (Mac Local Disk for that node's work/work2)
    if (req.method === 'GET' && u.pathname === '/api/files') {
      const cwd = String(u.searchParams.get('cwd') || '/root/work').trim();
      const nodeId = String(u.searchParams.get('nodeId') || '').trim();
      const node = inferNodeFromPathOrId(cwd, nodeId);
      const localRoot = mapRemoteCwdToLocal(cwd, node.id);
      const tree = await buildFileTree(localRoot, cwd, node);
      sendJson(res, 200, tree);
      return;
    }

    // API: Read text/code file content for Right Panel Preview (100% Mac Local Path + Strict Whitelist + Fast Size Guard)
    if (req.method === 'GET' && u.pathname === '/api/file-content') {
      const reqPath = String(u.searchParams.get('path') || '').trim();
      const cwd = String(u.searchParams.get('cwd') || '/root/work').trim();
      const nodeId = String(u.searchParams.get('nodeId') || '').trim();
      if (!reqPath) {
        sendJson(res, 400, { ok: false, error: 'Missing path' });
        return;
      }
      const { localPath, remotePath, lineNum, node } = resolveAnyFilePathToLocalAndRemote(reqPath, cwd, nodeId);
      const displayPath = localPath || remotePath;
      const baseName = path.basename(displayPath);
      const lowerBase = baseName.toLowerCase();
      const ext = path.extname(lowerBase);

      const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
      const WEB_EXTS = new Set(['.html', '.htm']);
      const CODE_EXTS = new Set([
        '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.bash', '.zsh',
        '.json', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env', '.md', '.txt',
        '.css', '.scss', '.less', '.c', '.cpp', '.cc', '.h', '.hpp', '.swift', '.rs',
        '.go', '.java', '.kt', '.sql', '.xml', '.csv', '.vue', '.svelte', '.lua',
        '.rb', '.php', '.pl', '.r', '.m', '.mm', '.cmake', '.mk', '.dockerfile',
        '.gitignore', '.stignore', '.log',
      ]);
      const CODE_BASENAMES = new Set(['dockerfile', 'makefile', 'claude.md', 'readme', 'license', '.gitignore', '.stignore', '.env']);

      const isImage = IMAGE_EXTS.has(ext);
      const isWeb = WEB_EXTS.has(ext);
      const isCode = CODE_EXTS.has(ext) || CODE_BASENAMES.has(lowerBase);

      const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
      const MAX_WEB_BYTES = 2 * 1024 * 1024;
      const MAX_CODE_BYTES = 200 * 1024;

      let localStat = null;
      let readPath = localPath;
      let fromRemote = false;
      if (localPath && fs.existsSync(localPath)) {
        try { localStat = await fsp.stat(localPath); } catch {}
      }
      // Not on this Mac (outside the mirror / not synced yet): copy it from the node first
      if (!localStat && (isImage || isWeb || isCode)) {
        const copy = await ensureRemoteFileCopy(node, remotePath, isImage ? MAX_IMAGE_BYTES : isWeb ? MAX_WEB_BYTES : MAX_CODE_BYTES);
        if (copy.ok) {
          readPath = copy.localPath;
          fromRemote = true;
          try { localStat = await fsp.stat(readPath); } catch {}
        } else if (copy.isDir) {
          sendJson(res, 200, { ok: true, kind: 'directory', path: displayPath, localPath: '', remotePath, nodeId: node.id, name: baseName });
          return;
        } else if (copy.tooLarge) {
          sendJson(res, 200, {
            ok: true,
            kind: 'unsupported',
            path: displayPath,
            localPath: '',
            remotePath,
            nodeId: node.id,
            name: baseName,
            ext,
            size: copy.size,
            reason: copy.error,
          });
          return;
        } else if (remotePath && !isLocalMacPath(remotePath)) {
          sendJson(res, 404, { ok: false, error: copy.error || `没有找到该文件: ${displayPath}` });
          return;
        }
      }

      if (localStat && localStat.isDirectory()) {
        sendJson(res, 200, { ok: true, kind: 'directory', path: displayPath, localPath, remotePath, nodeId: node.id, name: baseName });
        return;
      }

      if (!isImage && !isWeb && !isCode) {
        sendJson(res, 200, {
          ok: true,
          kind: 'unsupported',
          path: displayPath,
          localPath,
          remotePath,
          nodeId: node.id,
          name: baseName,
          ext: ext || '无后缀',
          size: localStat ? localStat.size : null,
          reason: `不支持预览 ${ext || '二进制/工程'} 类型文件（仅预览图片、网页与代码文件）`,
        });
        return;
      }

      if (!localStat) {
        sendJson(res, 404, { ok: false, error: `Mac 本地路径下未找到该文件: ${displayPath}` });
        return;
      }

      if (isImage) {
        if (localStat.size > MAX_IMAGE_BYTES) {
          sendJson(res, 200, {
            ok: true,
            kind: 'unsupported',
            path: displayPath,
            localPath,
            remotePath,
            nodeId: node.id,
            name: baseName,
            ext,
            size: localStat.size,
            reason: '图片体积超过 12 MB 阈值，已跳过加载以避免界面卡顿',
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          kind: 'image',
          fromRemote,
          path: displayPath,
          localPath,
          remotePath,
          nodeId: node.id,
          name: baseName,
          ext,
          size: localStat.size,
          rawUrl: `/api/raw-file?path=${encodeURIComponent(displayPath)}&cwd=${encodeURIComponent(cwd)}&nodeId=${encodeURIComponent(node.id)}&t=${Date.now()}`,
        });
        return;
      }

      if (isWeb) {
        if (localStat.size > MAX_WEB_BYTES) {
          sendJson(res, 200, {
            ok: true,
            kind: 'unsupported',
            path: displayPath,
            localPath,
            remotePath,
            nodeId: node.id,
            name: baseName,
            ext,
            size: localStat.size,
            reason: '网页文件超过 2 MB 阈值，已跳过内嵌渲染',
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          kind: 'html',
          fromRemote,
          path: displayPath,
          localPath,
          remotePath,
          nodeId: node.id,
          name: baseName,
          ext,
          size: localStat.size,
          rawUrl: `/api/raw-file?path=${encodeURIComponent(displayPath)}&cwd=${encodeURIComponent(cwd)}&nodeId=${encodeURIComponent(node.id)}`,
        });
        return;
      }

      if (localStat.size > MAX_CODE_BYTES) {
        sendJson(res, 200, {
          ok: true,
          kind: 'unsupported',
          path: displayPath,
          localPath,
          remotePath,
          nodeId: node.id,
          name: baseName,
          ext,
          size: localStat.size,
          reason: '代码/文本文件超过 200 KB 大文件阈值，为保证秒开流畅不直接加载',
        });
        return;
      }

      const buf = await fsp.readFile(readPath);
      const sampleLen = Math.min(buf.length, 4096);
      for (let i = 0; i < sampleLen; i++) {
        if (buf[i] === 0) {
          sendJson(res, 200, {
            ok: true,
            kind: 'unsupported',
            path: displayPath,
            localPath,
            remotePath,
            nodeId: node.id,
            name: baseName,
            ext,
            size: localStat.size,
            reason: '检测到二进制字节内容，已跳过文本预览',
          });
          return;
        }
      }

      sendJson(res, 200, {
        ok: true,
        kind: ext === '.md' ? 'markdown' : 'code',
        fromRemote,
        path: displayPath,
        localPath,
        remotePath,
        nodeId: node.id,
        name: baseName,
        ext,
        size: localStat.size,
        lineNum,
        content: buf.toString('utf8'),
        rawUrl: `/api/raw-file?path=${encodeURIComponent(displayPath)}&cwd=${encodeURIComponent(cwd)}&nodeId=${encodeURIComponent(node.id)}`,
      });
      return;
    }

    // API: Stream raw file directly from Mac local disk
    if (req.method === 'GET' && u.pathname === '/api/raw-file') {
      const reqPath = String(u.searchParams.get('path') || '').trim();
      const cwd = String(u.searchParams.get('cwd') || '/root/work').trim();
      const nodeId = String(u.searchParams.get('nodeId') || '').trim();
      const found = await resolveReadableLocalFile(reqPath, cwd, nodeId, REMOTE_PREVIEW_MAX_BYTES);
      const ext = path.extname(found.localPath || found.remotePath || '').toLowerCase();
      const contentType = MIME_MAP[ext] || 'application/octet-stream';

      if (found.readPath && !found.isDir) {
        // Pages from a node run in an opaque origin: their scripts can't drive this workbench's API
        const active = ['.html', '.htm', '.xhtml', '.svg'].includes(ext);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          ...(active ? { 'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals' } : {}),
        });
        fs.createReadStream(found.readPath).pipe(res);
        return;
      }

      res.writeHead(404);
      res.end('Local file not found');
      return;
    }

    // API: image pasted into a Claude conversation (cached on the Mac after the first view)
    if (req.method === 'GET' && u.pathname === '/api/chat-image') {
      const r = await ensureChatImageCopy({
        nodeId: u.searchParams.get('nodeId') || '',
        path: u.searchParams.get('path') || '',
        off: u.searchParams.get('off'),
        idx: u.searchParams.get('idx'),
        u: u.searchParams.get('u') || '',
      });
      if (!r.ok) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(r.error || 'not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME_MAP[path.extname(r.localPath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'private, max-age=604800, immutable',
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(r.localPath).pipe(res);
      return;
    }

    // API: open a file from the conversation with its Mac app (or reveal it in Finder)
    if (req.method === 'POST' && u.pathname === '/api/open-local') {
      const body = await readJsonBody(req);
      let target = '';
      let fromRemote = false;
      if (body.chatImage && typeof body.chatImage === 'object') {
        const r = await ensureChatImageCopy(body.chatImage);
        if (!r.ok) {
          sendJson(res, 404, { ok: false, error: r.error });
          return;
        }
        target = r.localPath;
        fromRemote = true;
      } else {
        const r = await resolveReadableLocalFile(String(body.path || ''), String(body.cwd || ''), String(body.nodeId || ''), REMOTE_OPEN_MAX_BYTES);
        if (!r.readPath) {
          sendJson(res, 404, { ok: false, error: r.error || '没有找到该文件' });
          return;
        }
        target = r.readPath;
        fromRemote = r.fromRemote;
      }
      const how = macOpenArgs(target, Boolean(body.reveal));
      const r = await runCmd('open', how.args, 8000);
      sendJson(res, r.exitCode === 0 ? 200 : 500, {
        ok: r.exitCode === 0,
        target,
        mode: how.mode,
        fromRemote,
        error: r.exitCode === 0 ? undefined : (r.stderr.trim() || 'open 失败'),
      });
      return;
    }

    // API: file pasted / dropped into the DockTerm composer -> written straight to the node
    if (req.method === 'POST' && u.pathname === '/api/chat-upload') {
      const node = getNodeById(u.searchParams.get('nodeId') || '');
      const cwd = String(u.searchParams.get('cwd') || '').trim();
      const size = Number(req.headers['content-length'] || 0);
      if (!node || !node.sshHost || !cwd.startsWith('/')) {
        req.resume();
        sendJson(res, 400, { ok: false, error: '缺少节点或工作目录' });
        return;
      }
      if (!size || size > CHAT_UPLOAD_MAX_BYTES) {
        req.resume();
        sendJson(res, 413, { ok: false, error: size ? `文件超过 ${formatByteSize(CHAT_UPLOAD_MAX_BYTES)}` : '空文件' });
        return;
      }
      const r = await uploadChatAttachment(node, cwd, u.searchParams.get('name') || 'file', req, size);
      sendJson(res, r.ok ? 200 : 500, r);
      return;
    }

    // API: Claude usage (5h / weekly) + model list + configured model/effort for a node
    if (req.method === 'GET' && u.pathname === '/api/claude-meta') {
      const data = await fetchClaudeMeta({
        nodeId: u.searchParams.get('nodeId') || '',
        cwd: u.searchParams.get('cwd') || '',
        parts: u.searchParams.get('parts') || '',
        force: u.searchParams.get('force') === '1',
      });
      sendJson(res, 200, data);
      return;
    }

    // API: Reveal in macOS Finder
    if (req.method === 'POST' && u.pathname === '/api/open-finder') {
      const body = await readJsonBody(req);
      const { localPath, node } = resolveAnyFilePathToLocalAndRemote(body.path || '', body.cwd || '', body.nodeId || '');
      const fallbackDir = (node && node.localWorkDir) || LOCAL_WORK_DIR;
      const target = (localPath && fs.existsSync(localPath)) ? localPath : fallbackDir;
      await runCmd('open', ['-R', target], 3000);
      sendJson(res, 200, { ok: true, target });
      return;
    }

    // API: Move / Reorganize file or folder via Drag & Drop in Right File Tree (Mac Local Disk)
    if (req.method === 'POST' && u.pathname === '/api/files/move') {
      const body = await readJsonBody(req);
      const cwd = String(body.cwd || '').trim();
      const nodeId = String(body.nodeId || '').trim();
      const srcInfo = resolveAnyFilePathToLocalAndRemote(body.sourcePath || '', cwd, nodeId);
      const dstDirInfo = resolveAnyFilePathToLocalAndRemote(body.targetDirPath || cwd, cwd, nodeId);
      if (!srcInfo.localPath || !dstDirInfo.localPath || !srcInfo.localPath.startsWith(BASE_TAKT_DIR) || !dstDirInfo.localPath.startsWith(BASE_TAKT_DIR)) {
        sendJson(res, 400, { ok: false, error: '非法路径：仅允许在本地工作区内拖拽移动' });
        return;
      }
      const baseName = path.basename(srcInfo.localPath);
      const newLocalPath = path.join(dstDirInfo.localPath, baseName);
      if (newLocalPath === srcInfo.localPath || newLocalPath.startsWith(srcInfo.localPath + path.sep)) {
        sendJson(res, 400, { ok: false, error: '不能将目录移动到其自身或子目录中' });
        return;
      }
      if (!fs.existsSync(srcInfo.localPath)) {
        sendJson(res, 404, { ok: false, error: '源路径不存在' });
        return;
      }
      await fsp.mkdir(path.dirname(newLocalPath), { recursive: true });
      await fsp.rename(srcInfo.localPath, newLocalPath);
      sendJson(res, 200, { ok: true, from: srcInfo.localPath, to: newLocalPath });
      return;
    }

    // API: Upload file(s) dropped from macOS Finder into Right File Tree (Mac Local Disk)
    if (req.method === 'POST' && u.pathname === '/api/files/upload') {
      const body = await readJsonBody(req);
      const cwd = String(body.cwd || '').trim();
      const nodeId = String(body.nodeId || '').trim();
      const dstDirInfo = resolveAnyFilePathToLocalAndRemote(body.targetDirPath || cwd, cwd, nodeId);
      const fileName = path.basename(String(body.fileName || '').trim());
      const contentBase64 = String(body.contentBase64 || '');
      if (!fileName || !dstDirInfo.localPath || !dstDirInfo.localPath.startsWith(BASE_TAKT_DIR)) {
        sendJson(res, 400, { ok: false, error: '无效的文件名或目标目录' });
        return;
      }
      await fsp.mkdir(dstDirInfo.localPath, { recursive: true });
      const dstFileLocal = path.join(dstDirInfo.localPath, fileName);
      const buf = Buffer.from(contentBase64, 'base64');
      await fsp.writeFile(dstFileLocal, buf);
      sendJson(res, 200, { ok: true, path: dstFileLocal, size: buf.length });
      return;
    }

    // API: Create subfolder inside Right File Tree (Mac Local Disk)
    if (req.method === 'POST' && u.pathname === '/api/files/mkdir') {
      const body = await readJsonBody(req);
      const cwd = String(body.cwd || '').trim();
      const nodeId = String(body.nodeId || '').trim();
      const parentInfo = resolveAnyFilePathToLocalAndRemote(body.parentDirPath || cwd, cwd, nodeId);
      const folderName = path.basename(String(body.name || '').trim());
      if (!folderName || !parentInfo.localPath || !parentInfo.localPath.startsWith(BASE_TAKT_DIR)) {
        sendJson(res, 400, { ok: false, error: '目录名不能为空' });
        return;
      }
      const newLocal = path.join(parentInfo.localPath, folderName);
      await fsp.mkdir(newLocal, { recursive: true });
      sendJson(res, 200, { ok: true, path: newLocal });
      return;
    }

    // API: Pop out active session in macOS native Terminal.app (attached to the same remote tmux session & Linux host)
    if (req.method === 'POST' && u.pathname === '/api/open-system-terminal') {
      const body = await readJsonBody(req);
      const tabId = String(body.tabId || 'default').trim();
      const cwd = String(body.cwd || '/root/work').trim();
      const node = getNodeById(body.nodeId || body.sshHost);
      const sshHost = String(body.sshHost || node.sshHost || '').trim();
      const launcherScript = path.join(__dirname, 'native-ssh-session.sh');
      const cmdStr = `/bin/bash ${shSingleQuote(launcherScript)} ${shSingleQuote(tabId)} ${shSingleQuote(cwd)} ${shSingleQuote(sshHost)}`;
      const osa = `tell application "Terminal"
        activate
        do script ${JSON.stringify(cmdStr)}
      end tell`;
      await runCmd('osascript', ['-e', osa], 4000);
      sendJson(res, 200, { ok: true });
      return;
    }

    // API: Bottom Status Bar
    if (req.method === 'GET' && u.pathname === '/api/status') {
      const st = await getCombinedSystemStatus();
      sendJson(res, 200, st);
      return;
    }

    // API: One-click Heal SSH Tunnel + MCP + Syncthing across all enabled nodes
    if (req.method === 'POST' && u.pathname === '/api/heal') {
      try {
        await fetch('http://127.0.0.1:18765/system-heal', { method: 'POST' });
      } catch {
        await ensureMacMcpDaemonRunning();
      }
      const st = await getCombinedSystemStatus();
      sendJson(res, 200, st);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

// WebSocket Server for Multi-Tab Persistent Terminal Sessions & Claude Chat Stream
const wss = new WebSocketServer({ noServer: true });
const chatWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (!isLoopbackHost(req.headers.host) || (req.headers.origin && !isSameLocalOrigin(req.headers.origin))) {
    socket.destroy();
    return;
  }
  if (u.pathname === '/ws/term') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, u);
    });
  } else if (u.pathname === '/ws/chat') {
    chatWss.handleUpgrade(req, socket, head, (ws) => {
      chatHub.handleConnection(ws, req, u);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, _req, u) => {
  const tabId = String(u.searchParams.get('tabId') || '').trim() || crypto.randomUUID();
  const sessionId = String(u.searchParams.get('sessionId') || tabId).trim();
  const cwd = String(u.searchParams.get('cwd') || '/root/work').trim();
  const nodeId = String(u.searchParams.get('nodeId') || '').trim();
  const sshHost = String(u.searchParams.get('sshHost') || '').trim();
  const title = String(u.searchParams.get('title') || '').trim();
  const resume = u.searchParams.get('resume') !== '0';
  const mode = String(u.searchParams.get('mode') || 'claude').trim();
  const cols = Number(u.searchParams.get('cols') || 120);
  const rows = Number(u.searchParams.get('rows') || 36);

  const tab = getOrCreatePtyTab({ tabId, sessionId, title, cwd, resume, mode, nodeId, sshHost });
  tab.clients.add(ws);

  try {
    if (cols > 10 && rows > 5) {
      tab.ptyProc.resize(cols, rows);
    }
  } catch {}

  if (tab.scrollback.length > 0) {
    try {
      ws.send(JSON.stringify({
        type: 'output',
        tabId: tab.tabId,
        data: tab.scrollback.join(''),
      }));
    } catch {}
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input' && typeof msg.data === 'string') {
        tab.ptyProc.write(msg.data);
      } else if (msg.type === 'resize' && msg.cols > 10 && msg.rows > 4) {
        tab.ptyProc.resize(Number(msg.cols), Number(msg.rows));
      } else if (msg.type === 'kill') {
        closePtyTab(tab.tabId, tab.nodeId);
      }
    } catch {}
  });

  ws.on('close', () => {
    tab.clients.delete(ws);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  const logLine = `[${new Date().toISOString()}] TAKT Multi-Node Workbench listening on ${url}\n`;
  try {
    fs.writeFileSync(DSH_WEB_LOG, logLine, 'utf8');
  } catch {}
  console.log(logLine.trim());
});
