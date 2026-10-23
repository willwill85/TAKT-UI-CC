#!/usr/bin/env node
/**
 * TAKT AI — Multi-Linux Node SSH Terminal Workbench Server
 * ---------------------------------------------------------------------
 * 1. Multi-Linux Node Registry ($TAKT_HOME/nodes.json):
 *    Each Linux server maps to its own isolated Mac local folder (work, work2, work3...),
 *    its own Syncthing folder, and its own dedicated MCP Reverse SSH Tunnel (-R $MCP_PORT & -R $EDA_PORT)
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
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const cfg = require('../config');

const PORT = cfg.PORT;
const MCP_PORT = cfg.MCP_PORT;
const EDA_PORT = cfg.EDA_PORT;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}`;
const SYNCTHING_URL = cfg.SYNCTHING_URL;
const BASE_TAKT_DIR = cfg.TAKT_HOME;
const WORKSPACE_LINK_DIR = cfg.WORKSPACE_LINK_DIR;
const PRIMARY_NODE_ID = cfg.PRIMARY_NODE_ID;
const MCP_SERVER_SCRIPT = path.join(cfg.REPO_ROOT, 'mcp-server', 'server.js');
const NODES_FILE = cfg.NODES_FILE;
const SESSION_TITLES_FILE = cfg.SESSION_TITLES_FILE;
const WORKBENCH_DB_FILE = cfg.DB_FILE;
const LOCAL_WORK_DIR = cfg.DEFAULT_WORK_DIR;
const WORKBENCH_LOG = path.join(cfg.LOG_DIR, 'workbench-web.log');
const PUBLIC_DIR = path.join(__dirname, 'public');
const VENDOR_DIR = path.join(PUBLIC_DIR, 'vendor');
const SSH_SOCKET_DIR = cfg.SSH_SOCKET_DIR;

fs.mkdirSync(LOCAL_WORK_DIR, { recursive: true });
fs.mkdirSync(path.dirname(WORKBENCH_LOG), { recursive: true });
fs.mkdirSync(SSH_SOCKET_DIR, { recursive: true });

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
    id: PRIMARY_NODE_ID,
    name: 'Linux 节点 1',
    badge: 'LX-1',
    sshHost: '', // bind an SSH host from the UI ("节点" button) to activate this node
    remoteWorkDir: '/root/work',
    localWorkDir: path.join(BASE_TAKT_DIR, 'work'),
    localWorkAlias: 'work',
    syncthingFolderId: 'takt-work',
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

    // Optional convenience symlink: $TAKT_WORKSPACE_LINK_DIR/<alias> -> local work dir
    if (WORKSPACE_LINK_DIR && fs.existsSync(WORKSPACE_LINK_DIR)) {
      const linkPath = path.join(WORKSPACE_LINK_DIR, alias);
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
    const cfgXml = fs.readFileSync(cfg.findSyncthingConfig(), 'utf8');
    const m = cfgXml.match(/<apikey>([^<]+)<\/apikey>/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Syncthing auto-pairing (Mac <-> Linux node), via both sides' local REST APIs
// ---------------------------------------------------------------------------
async function stFetch(stKey, method, apiPath, body) {
  try {
    const r = await fetch(`${SYNCTHING_URL}${apiPath}`, {
      method,
      headers: { 'X-API-Key': stKey, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(4000),
    });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch (err) {
    return { ok: false, status: 0, text: err.message };
  }
}

// Resolves the real host name / IP of an ssh alias (so Syncthing can dial it directly)
async function resolveSshHostName(sshHost) {
  const r = await runCmd('ssh', ['-G', sshHost], 3000);
  const m = (r.stdout || '').match(/^hostname\s+(\S+)/m);
  return m ? m[1] : sshHost;
}

async function pairSyncthingForNode(node, stKey, macDeviceId, logs) {
  if (!stKey || !macDeviceId || !node.syncthingDeviceId || !node.syncthingFolderId || !node.sshHost) return;
  const remoteId = node.syncthingDeviceId;
  const hostName = await resolveSshHostName(node.sshHost);
  const remoteAddrs = ['dynamic'];
  if (hostName && !/^(localhost|127\.)/.test(hostName)) remoteAddrs.unshift(`tcp://${hostName}:22000`);

  // 1) Mac side: add the remote device, then (re)register the folder shared with it
  const dev = await stFetch(stKey, 'PUT', `/rest/config/devices/${encodeURIComponent(remoteId)}`, {
    deviceID: remoteId,
    name: node.name || node.sshHost,
    addresses: remoteAddrs,
    compression: 'metadata',
    autoAcceptFolders: false,
  });
  if (!dev.ok) { logs.push(`⚠ Mac Syncthing 添加远端设备失败 (${dev.status}): ${dev.text.slice(0, 120)}`); return; }
  const folder = await stFetch(stKey, 'PUT', `/rest/config/folders/${encodeURIComponent(node.syncthingFolderId)}`, {
    id: node.syncthingFolderId,
    label: `TAKT ${node.localWorkAlias} (${node.name})`,
    filesystemType: 'basic',
    path: node.localWorkDir,
    type: 'sendreceive',
    fsWatcherEnabled: true,
    fsWatcherDelayS: 1,
    rescanIntervalS: 60,
    devices: [{ deviceID: macDeviceId }, { deviceID: remoteId }],
  });
  if (!folder.ok) { logs.push(`⚠ Mac Syncthing 共享目录失败 (${folder.status}): ${folder.text.slice(0, 120)}`); return; }
  logs.push(`Mac Syncthing 已与 ${node.sshHost} 配对 (${node.syncthingFolderId})`);

  // 2) Linux side: trust the Mac and share the same folder id on the node's work dir
  const pairPy = `
import json, os, re, urllib.request

mac_id = ${JSON.stringify(macDeviceId)}
folder_id = ${JSON.stringify(node.syncthingFolderId)}
folder_path = ${JSON.stringify(node.remoteWorkDir)}
label = ${JSON.stringify(`TAKT ${node.localWorkAlias}`)}

home = os.path.expanduser("~")
cfg = next((p for p in (home + "/.local/state/syncthing/config.xml", home + "/.config/syncthing/config.xml") if os.path.exists(p)), None)
if not cfg:
    print(json.dumps({"ok": False, "error": "remote syncthing has no config yet (start it once: systemctl --user enable --now syncthing)"})); raise SystemExit
xml = open(cfg, encoding="utf-8").read()
key = re.search(r"<apikey>([^<]+)</apikey>", xml).group(1)
addr = re.search(r"<gui[^>]*>.*?<address>([^<]+)</address>", xml, re.S)
base = "http://" + (addr.group(1) if addr else "127.0.0.1:8384")

def api(method, path, body=None):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"X-API-Key": key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read().decode() or "null")

my_id = api("GET", "/rest/system/status")["myID"]
api("PUT", "/rest/config/devices/" + mac_id, {"deviceID": mac_id, "name": "TAKT-Mac", "addresses": ["dynamic"], "compression": "metadata", "autoAcceptFolders": False})
os.makedirs(folder_path, exist_ok=True)
api("PUT", "/rest/config/folders/" + folder_id, {"id": folder_id, "label": label, "filesystemType": "basic", "path": folder_path,
    "type": "sendreceive", "fsWatcherEnabled": True, "fsWatcherDelayS": 1, "rescanIntervalS": 60,
    "devices": [{"deviceID": my_id}, {"deviceID": mac_id}]})
print(json.dumps({"ok": True, "deviceId": my_id}))
`.trim();
  const b64 = Buffer.from(pairPy, 'utf8').toString('base64');
  const rr = await runCmd('ssh', [
    '-o', 'ConnectTimeout=5', '-o', 'ClearAllForwardings=yes', node.sshHost,
    `python3 -c "import base64;exec(base64.b64decode('${b64}'))"`,
  ], 15000);
  try {
    const out = JSON.parse((rr.stdout || '').trim().split('\n').pop());
    logs.push(out.ok ? `${node.sshHost} 上的 Syncthing 已信任 Mac 并共享 ${node.remoteWorkDir}` : `⚠ 远端 Syncthing 配对失败: ${out.error || '未知错误'}`);
  } catch {
    logs.push(`⚠ 远端 Syncthing 配对无响应 (${(rr.stderr || '').trim().slice(0, 120) || 'no output'})`);
  }
}

// Automatically provision a Linux node:
// 1. Ensure local workN folder + Syncthing folder registration on Mac
// 2. Establish isolated Reverse SSH Tunnel (-R $MCP_PORT & -R $EDA_PORT) to the Linux host
// 3. Configure remote ~/.claude.json to point `mac-industrial-mcp` to http://127.0.0.1:$MCP_PORT/mcp?node=<nodeId>
// 4. Auto-pair Syncthing device & folder if Syncthing is installed on the remote Linux host
async function provisionLinuxNode(node) {
  ensureNodeLocalDirAndSymlink(node);
  const logs = [`本地目录已就绪: ${node.localWorkDir}`];

  // Register local folder in Mac Syncthing if API key available
  const stKey = getSyncthingApiKey();
  let macDeviceId = '';
  if (stKey && node.syncthingFolderId) {
    try {
      const sysRes = await runCmd('curl', ['-s', '--max-time', '2', '-H', `X-API-Key: ${stKey}`, `${SYNCTHING_URL}/rest/system/status`], 2500);
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
        folderPayload.devices = [{ deviceID: node.syncthingDeviceId }];
      }
      await runCmd('curl', [
        '-s', '-X', 'PUT',
        '-H', `X-API-Key: ${stKey}`,
        '-H', 'Content-Type: application/json',
        '-d', JSON.stringify(folderPayload),
        `${SYNCTHING_URL}/rest/config/folders/${encodeURIComponent(node.syncthingFolderId)}`,
      ], 3000);
      logs.push(`Mac Syncthing 同步目录已注册 (${node.syncthingFolderId})`);
    } catch {}
  }

  if (!node.sshHost) {
    return { ok: true, logs };
  }

  // Establish isolated MCP reverse tunnel for this node
  const sock = path.join(SSH_SOCKET_DIR, `takt-mcp-tunnel-${node.id.replace(/[^a-zA-Z0-9_-]/g, '')}.sock`);

  await runCmd('ssh', ['-S', sock, '-O', 'exit', node.sshHost], 2500);
  const tunRes = await runCmd('ssh', [
    '-M', '-S', sock, '-Nf',
    '-o', 'ConnectTimeout=5',
    '-o', 'ExitOnForwardFailure=no',
    '-o', 'ServerAliveInterval=20',
    '-R', `${MCP_PORT}:127.0.0.1:${MCP_PORT}`,
    '-R', `${EDA_PORT}:127.0.0.1:${EDA_PORT}`,
    node.sshHost,
  ], 7000);

  if (tunRes.exitCode === 0) {
    logs.push(`SSH 逆向 MCP 隧道已建立 (${node.sshHost} -> 127.0.0.1:${MCP_PORT})`);
  }

  // Provision remote work directory + ~/.claude.json MCP entry + read remote Syncthing Device ID
  const remoteWork = node.remoteWorkDir || '/root/work';
  const mcpUrl = `${MCP_URL}/mcp?node=${encodeURIComponent(node.id)}`;
  const mcpToken = cfg.getMcpToken();
  const autoAllowHostExec = process.env.TAKT_AUTO_ALLOW_HOST_EXEC === '1';
  const setupPy = `
import json, os, re, subprocess

work_dir = ${JSON.stringify(remoteWork)}
mcp_url = ${JSON.stringify(mcpUrl)}
mcp_token = ${JSON.stringify(mcpToken)}
auto_allow_host_exec = ${autoAllowHostExec ? 'True' : 'False'}
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
cfg["mcpServers"]["mac-industrial"] = {
    "type": "http",
    "url": mcp_url,
    "headers": {"Authorization": "Bearer " + mcp_token}
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
if "mcp__mac-industrial" not in allow_list:
    allow_list.append("mcp__mac-industrial")
# mac_host_exec runs arbitrary shell commands on your local machine: keep asking unless explicitly opted in
ask_list = perms.setdefault("ask", [])
exec_rule = "mcp__mac-industrial__mac_host_exec"
if auto_allow_host_exec:
    if exec_rule in ask_list:
        ask_list.remove(exec_rule)
    if exec_rule not in allow_list:
        allow_list.append(exec_rule)
elif exec_rule not in ask_list:
    ask_list.append(exec_rule)
try:
    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(st_cfg, f, indent=2, ensure_ascii=False)
except Exception:
    pass

st_id = ""
try:
    for cmd in (["syncthing", "device-id"], ["syncthing", "--device-id"]):
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=4)
        if r.returncode == 0 and re.match(r"^[A-Z0-9]{7}(-[A-Z0-9]{7}){7}$", r.stdout.strip().splitlines()[0].strip() if r.stdout.strip() else ""):
            st_id = r.stdout.strip().splitlines()[0].strip()
            break
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
  } else {
    logs.push(`⚠ 无法通过 SSH 配置远端 (${(remRes.stderr || '').trim().split('\n').pop().slice(0, 140) || '无输出'})。请先确认 ssh ${node.sshHost} 可免密登录，且远端有 python3。`);
  }

  // Finish Syncthing pairing in both directions (needs Syncthing running on both machines)
  await pairSyncthingForNode(node, stKey, macDeviceId, logs);

  return { ok: true, logs };
}

// Ensure Mac Industrial MCP Daemon (:$MCP_PORT) stays running in background
let mcpSupervisorBusy = false;
async function ensureMacMcpDaemonRunning() {
  if (mcpSupervisorBusy) return;
  mcpSupervisorBusy = true;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1800);
    let ok = false;
    try {
      const res = await fetch(`${MCP_URL}/system-status`, { signal: ctrl.signal });
      if (res.ok) {
        const st = await res.json();
        ok = true;
        if (st && st.mcpStatus && !st.mcpStatus.remoteTunnelOk && !st.healing) {
          fetch(`${MCP_URL}/system-heal`, { method: 'POST' }).catch(() => {});
        }
      }
    } catch {}
    clearTimeout(timer);

    if (!ok) {
      const mcpChild = spawn(process.execPath, [MCP_SERVER_SCRIPT, '--http'], {
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
        display_title = title or first_user or f"会话 {sid[:8]}"
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
// 1b. Local SQLite State Store ($TAKT_HOME/takt-workbench.sqlite)
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
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    project_path TEXT NOT NULL,
    title TEXT NOT NULL,
    custom_title TEXT NOT NULL DEFAULT '',
    last_prompt TEXT NOT NULL DEFAULT '',
    turns INTEGER NOT NULL DEFAULT 1,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
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
  ON CONFLICT(id) DO UPDATE SET
    node_id = excluded.node_id,
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
  ON CONFLICT(id) DO UPDATE SET
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
    if (WORKSPACE_LINK_DIR) {
      const docAliasDir = path.join(WORKSPACE_LINK_DIR, n.localWorkAlias || 'work');
      if (raw === docAliasDir || raw.startsWith(docAliasDir + '/')) {
        return n;
      }
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
  const docAliasBase = WORKSPACE_LINK_DIR
    ? path.join(WORKSPACE_LINK_DIR, node.localWorkAlias || 'work')
    : localBase;

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
  const docAliasBase = WORKSPACE_LINK_DIR
    ? path.join(WORKSPACE_LINK_DIR, node.localWorkAlias || 'work')
    : localBase;

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
  } else if (raw.startsWith(os.homedir() + '/')) {
    localPath = path.resolve(raw);
    remotePath = localPath;
  } else if (raw.startsWith('/')) {
    remotePath = path.posix.normalize(raw);
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
    const res = await fetch(`${MCP_URL}/system-status`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      mcpData = await res.json();
    }
  } catch {}

  let localTailscaleOk = false;
  let localTailscaleIp = '';
  try {
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
    } else {
      const ifRes = await runCmd('/sbin/ifconfig', [], 1500);
      const m = (ifRes.stdout || '').match(/inet\s+(100\.\d+\.\d+\.\d+)\s+-->/);
      if (m) {
        localTailscaleOk = true;
        localTailscaleIp = m[1];
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
    : '';
  const egressIp = onlineNodeEntries[0]?.egressIp || mcpData?.remoteCli?.egressIp || '';
  const remoteTailscaleOk = Boolean(mcpData?.remoteCli?.tailscaleOk);
  const remoteTailscaleIp = mcpData?.remoteCli?.tailscaleIp || '';

  return {
    ok: true,
    ssh: {
      online: anyNodeOnline,
      host: activeHostSummary,
      egressIp,
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
    },
    healing: Boolean(mcpData?.healing),
    timestamp: Date.now(),
  };
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

    // Serve vendor static files
    if (req.method === 'GET' && u.pathname.startsWith('/vendor/')) {
      const fileName = path.basename(u.pathname);
      const filePath = path.join(VENDOR_DIR, fileName);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(fileName).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_MAP[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    // Serve main UI
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      const htmlPath = path.join(PUBLIC_DIR, 'index.html');
      const html = await fsp.readFile(htmlPath, 'utf8');
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
      fetch(`${MCP_URL}/system-heal`, { method: 'POST' }).catch(() => {});
      sendJson(res, 200, { ok: true, node: target, nodes, logs: prov.logs });
      return;
    }

    // API: Delete a non-primary Linux Node config (never deletes local workN files)
    if (req.method === 'DELETE' && u.pathname === '/api/nodes') {
      const id = String(u.searchParams.get('id') || '').trim();
      if (!id || id === (loadNodes()[0] || {}).id) {
        sendJson(res, 400, { ok: false, error: '主节点不可删除' });
        return;
      }
      const nodes = loadNodes().filter((n) => n.id !== id);
      saveNodes(nodes);
      sendJson(res, 200, { ok: true, nodes });
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
      registerSessionInSqlite({
        id: sid,
        nodeId: body.nodeId || PRIMARY_NODE_ID,
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
      if (localPath && fs.existsSync(localPath)) {
        try { localStat = await fsp.stat(localPath); } catch {}
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

      const buf = await fsp.readFile(localPath);
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
      const { localPath, remotePath } = resolveAnyFilePathToLocalAndRemote(reqPath, cwd, nodeId);
      const ext = path.extname(localPath || remotePath).toLowerCase();
      const contentType = MIME_MAP[ext] || 'application/octet-stream';

      if (localPath && fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache',
        });
        fs.createReadStream(localPath).pipe(res);
        return;
      }

      res.writeHead(404);
      res.end('Local file not found');
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
        await fetch(`${MCP_URL}/system-heal`, { method: 'POST' });
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

// WebSocket Server for Multi-Tab Persistent Terminal Sessions
const wss = new WebSocketServer({ noServer: true });

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
    fs.writeFileSync(WORKBENCH_LOG, logLine, 'utf8');
  } catch {}
  console.log(logLine.trim());
});
