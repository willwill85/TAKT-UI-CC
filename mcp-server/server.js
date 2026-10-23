#!/usr/bin/env node
/**
 * TAKT-UI-CC — local MCP server ("mac-industrial-mcp")
 * --------------------------------------------------------------------------------------
 * Runs on YOUR machine (macOS) and is reverse-tunnelled (ssh -R) to every Linux node, so that
 * Claude Code running remotely can drive local applications and hardware:
 *   1. Blender            - bpy scripts, Metal GPU rendering, GUI launch
 *   2. FreeCAD            - freecadcmd parametric modeling, STEP inspection, GUI launch
 *   3. JLC EDA Pro (EasyEDA) - .epro/.epro2 parser & patcher, bridge scripts (optional external bridge)
 *   4. Local browser      - JS-rendered DOM dump, Markdown fetch, open URL
 *   5. Xcode / iPhone     - xcodebuild, xcrun devicectl, xctrace
 *   6. USB / serial       - enumeration and serial port I/O
 *   7. MCU flashing       - esptool / ESP-IDF, J-Link, dfu-util
 *   8. Host command bridge (mac_host_exec) and screen capture
 *   9. Built-in 3D model viewer at http://127.0.0.1:<port>/viewer
 *
 * Every tool is optional: tools whose application is not installed simply return an error message.
 * SECURITY: binds to 127.0.0.1 only and requires `Authorization: Bearer <token>` on /mcp
 * (token file: $TAKT_HOME/mcp-token). Do NOT expose this port to a network.
 */

const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../config');

const MAC_WORK_DIR = cfg.DEFAULT_WORK_DIR;
const NODES_CONFIG_PATH = cfg.NODES_FILE;
const LINUX_WORK_DIR = '/root/work';
const LINUX_ALT_WORK_DIR = '/home/ubuntu/work';
const PORT = cfg.MCP_PORT;
const BIND_HOST = cfg.MCP_HOST;
const EDA_PORT = cfg.EDA_PORT;
const SYNCTHING_URL = cfg.SYNCTHING_URL;
const SSH_SOCKET_DIR = cfg.SSH_SOCKET_DIR;
const MCP_TOKEN = cfg.getMcpToken();
fs.mkdirSync(SSH_SOCKET_DIR, { recursive: true });

const PATHS = {
  blenderBin: '/Applications/Blender.app/Contents/MacOS/Blender',
  blenderApp: '/Applications/Blender.app',
  freecadCmd: '/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd',
  freecadApp: '/Applications/FreeCAD.app',
  jlcedaApp: '/Applications/嘉立创EDA(专业版).app',
  chromeBin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  xcodeBuild: '/usr/bin/xcodebuild',
  xcrun: '/usr/bin/xcrun',
  jlinkExe: '/usr/local/bin/JLinkExe',
  dfuUtil: '/opt/homebrew/bin/dfu-util',
  esptoolPy: path.join(cfg.ESP_PYTHON_ENV, 'bin/esptool.py'),
  espPython: path.join(cfg.ESP_PYTHON_ENV, 'bin/python'),
};

fs.mkdirSync(MAC_WORK_DIR, { recursive: true });

let activeMcpNodeId = null;

function loadConfiguredNodes() {
  try {
    if (fs.existsSync(NODES_CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(NODES_CONFIG_PATH, 'utf8'));
      if (parsed && Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
        return parsed.nodes;
      }
    }
  } catch {}
  return [
    {
      id: cfg.PRIMARY_NODE_ID,
      name: 'Linux 节点 1',
      badge: 'LX-1',
      sshHost: '',
      remoteWorkDir: LINUX_WORK_DIR,
      localWorkDir: MAC_WORK_DIR,
      localWorkAlias: 'work',
      syncthingFolderId: 'takt-work',
      syncthingDeviceId: '',
      enabled: false,
    },
  ];
}

function getActiveNodeConfig(nodeId = activeMcpNodeId) {
  const nodes = loadConfiguredNodes();
  if (nodeId) {
    const found = nodes.find((n) => n.id === nodeId || n.sshHost === nodeId || n.localWorkAlias === nodeId);
    if (found) return found;
  }
  return nodes[0];
}

function resolveWorkPath(inputPath = '') {
  const node = getActiveNodeConfig();
  const primaryLocalDir = (node && node.localWorkDir) || MAC_WORK_DIR;
  const primaryRemoteDir = ((node && node.remoteWorkDir) || LINUX_WORK_DIR).replace(/\/+$/, '');
  if (!inputPath) return primaryLocalDir;

  let p = String(inputPath).trim();
  let rel = null;

  if (p === cfg.TAKT_HOME || p.startsWith(cfg.TAKT_HOME + path.sep)) {
    return path.resolve(p);
  }
  if (cfg.WORKSPACE_LINK_DIR && (p === cfg.WORKSPACE_LINK_DIR || p.startsWith(cfg.WORKSPACE_LINK_DIR + path.sep))) {
    const rest = p.slice(cfg.WORKSPACE_LINK_DIR.length).replace(/^\/+/, '');
    return path.resolve(cfg.TAKT_HOME, rest);
  }
  for (const n of loadConfiguredNodes()) {
    const rDir = (n.remoteWorkDir || '').replace(/\/+$/, '');
    if (rDir && rDir !== '/root/work' && (p === rDir || p.startsWith(rDir + '/'))) {
      const rRel = p.slice(rDir.length).replace(/^\/+/, '');
      return path.join(n.localWorkDir || primaryLocalDir, rRel);
    }
  }
  if (p === primaryRemoteDir || p.startsWith(primaryRemoteDir + '/')) {
    rel = p.slice(primaryRemoteDir.length).replace(/^\/+/, '');
  } else if (p === LINUX_WORK_DIR || p.startsWith(LINUX_WORK_DIR + '/')) {
    rel = p.slice(LINUX_WORK_DIR.length).replace(/^\/+/, '');
  } else if (p === LINUX_ALT_WORK_DIR || p.startsWith(LINUX_ALT_WORK_DIR + '/')) {
    rel = p.slice(LINUX_ALT_WORK_DIR.length).replace(/^\/+/, '');
  } else if (p.startsWith('/home/ubuntu/Projects')) {
    rel = p.slice('/home/ubuntu/Projects'.length).replace(/^\/+/, '');
  } else if (!path.isAbsolute(p)) {
    rel = p;
  }

  if (rel !== null) {
    const cand = path.join(primaryLocalDir, rel);
    if (fs.existsSync(cand)) return cand;
    // Also check across all other configured localWorkDirs (work, work2, work3...) if the file exists there
    for (const n of loadConfiguredNodes()) {
      if (n.localWorkDir) {
        const alt = path.join(n.localWorkDir, rel);
        if (fs.existsSync(alt)) return alt;
      }
    }
    return cand;
  }

  return p;
}

function rewriteScriptPaths(code = '') {
  const node = getActiveNodeConfig();
  const primaryLocalDir = (node && node.localWorkDir) || MAC_WORK_DIR;
  const primaryRemoteDir = ((node && node.remoteWorkDir) || LINUX_WORK_DIR).replace(/\/+$/, '');
  let out = String(code);
  if (primaryRemoteDir && primaryRemoteDir !== '/root/work') {
    out = out.replaceAll(primaryRemoteDir, primaryLocalDir);
  }
  return out
    .replaceAll('/root/work', primaryLocalDir)
    .replaceAll('/home/ubuntu/work', primaryLocalDir)
    .replaceAll('/home/ubuntu/Projects', primaryLocalDir);
}

function runCommand(cmd, args, options = {}) {
  const timeoutMs = options.timeoutMs || 180000;
  const cwd = options.cwd || MAC_WORK_DIR;
  const isBgSsh = cmd === 'ssh' && Array.isArray(args) && args.includes('-Nf');
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`,
        ...(options.env || {}),
      },
      stdio: isBgSsh ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: stderr + '\n' + err.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, stdout, stderr, timedOut });
    });
  });
}

// ============================================================================
// MCP Tool Definitions (19 Tools covering 3D/CAD/EDA/Browser/Xcode/USB/Flashing)
// ============================================================================
const TOOLS = [
  // --- 1. Blender Tools ---
  {
    name: 'blender_run_python',
    description:
      '在用户本机 Mac 的 Blender (/Applications/Blender.app) 中无头执行 bpy Python 脚本。脚本默认在共享目录 work/ 下运行，支持将 /root/work 路径自动映射为 Mac 本地 work 目录。可用于组装 .stl/.obj、赋予材质、设置灯光动画并导出 .blend 或 .glb。',
    inputSchema: {
      type: 'object',
      properties: {
        script_code: { type: 'string', description: '完整的 Blender Python (bpy) 脚本内容。' },
        script_file: { type: 'string', description: 'work/ 目录下已有的 .py 脚本路径。' },
        blend_file: { type: 'string', description: '可选：启动时先加载的 .blend 文件路径。' },
      },
    },
  },
  {
    name: 'blender_render_image',
    description:
      '调用用户本机 MacBook 的 Apple Silicon (Metal GPU) 对指定的 .blend 工程进行高速硬件光追/EEVEE渲染，并将渲染出的 PNG 图片保存到同步的 work/ 目录中。',
    inputSchema: {
      type: 'object',
      properties: {
        blend_file: { type: 'string', description: '要渲染的 .blend 文件路径（位于 work/ 下）。' },
        output_image: { type: 'string', description: '输出的 PNG 文件路径（默认 render_preview.png）。' },
        engine: {
          type: 'string',
          enum: ['BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'CYCLES'],
          description: '渲染引擎，快速预览推荐 BLENDER_EEVEE_NEXT，真实光追推荐 CYCLES（自动开启苹果 Metal GPU）。',
        },
        samples: { type: 'number', description: '渲染采样数（默认 32）。' },
      },
      required: ['blend_file'],
    },
  },
  {
    name: 'blender_open_gui',
    description: '在用户本地 MacBook 桌面上直接唤起原生 Blender GUI 界面并打开指定的 .blend 文件。',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '要打开的 .blend 文件路径（可选）。' },
      },
    },
  },

  // --- 2. FreeCAD Tools ---
  {
    name: 'freecad_run_python',
    description:
      '在用户本机 Mac 的 FreeCAD (/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd) 中无头执行 Python 参数化建模脚本，生成原生 .FCStd（带完整特征树）、.step 与 .stl 文件到同步的 work/ 目录。',
    inputSchema: {
      type: 'object',
      properties: {
        script_code: { type: 'string', description: '完整的 FreeCAD Python 脚本代码（可使用 FreeCAD, Part, Mesh 等模块）。' },
        script_file: { type: 'string', description: 'work/ 目录下已有的 .py 脚本路径。' },
      },
    },
  },
  {
    name: 'freecad_inspect_step',
    description:
      '使用本机 Mac 的 FreeCAD 引擎读取 work/ 目录下的 .step / .stp / .FCStd 文件（如 PCB 3D 模型），精确提取 BoundingBox 边界尺寸以及安装孔坐标与半径。',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'STEP 或 FCStd 文件路径（位于 work/ 下）。' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'freecad_open_gui',
    description: '在用户本地 MacBook 桌面上直接唤起原生 FreeCAD GUI 并打开指定的 .FCStd / .step 文件。',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '要打开的 .FCStd 或 .step 文件路径。' },
      },
    },
  },

  // --- 3. 嘉立创 EDA Pro Tools (EasyEDA Bridge + .epro Tools) ---
  {
    name: 'jlceda_bridge_status',
    description:
      '检查本地 Mac 嘉立创EDA专业版 (EasyEDA) WebSocket Bridge (端口 49620-49629) 的健康状态与已连接的 EDA 窗口列表 (/health 与 /eda-windows)，若 Bridge 未启动会自动在 Mac 后台拉起，并支持切换当前激活的 EDA 窗口。注意：该 Bridge 端口已通过 SSH 反向隧道同步映射至韩国 Linux 的 http://localhost:49620，你也可以直接在 Bash 中 curl http://localhost:49620/health。',
    inputSchema: {
      type: 'object',
      properties: {
        select_window_id: {
          type: 'string',
          description: '可选：若传入 windowId，则将该窗口设为当前活动的嘉立创EDA窗口 (/eda-windows/select)。',
        },
      },
    },
  },
  {
    name: 'jlceda_bridge_execute',
    description:
      '通过本地 Mac 嘉立创EDA专业版 (EasyEDA) WebSocket Bridge (POST http://127.0.0.1:49620/execute) 在正在运行的嘉立创EDA客户端内实时执行 eda.* API JavaScript 代码并返回结果（如创建/打开工程、绘制原理图器件与连线、PCB 布局布线、DRC 检查等）。完整 API 规范请参考 ~/.claude/skills/easyeda-api/SKILL.md。',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            '要在嘉立创EDA客户端 async function(eda) { ... } 上下文中执行的 JavaScript 代码（必须使用 return 返回结果，不要包含单行 // 注释）。例如: return await eda.dmt_Project.getCurrentProjectInfo();',
        },
        window_id: {
          type: 'string',
          description: '可选：指定执行的 EDA 窗口 ID（默认使用当前激活窗口）。',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'jlceda_inspect_epro',
    description:
      '解析 work/ 目录下的嘉立创 EDA 专业版工程文件（.epro / .epro2），提取内部结构、原理图/PCB 列表、器件 BOM 清单及网表概要。',
    inputSchema: {
      type: 'object',
      properties: {
        epro_path: { type: 'string', description: 'work/ 目录下的 .epro 或 .epro2 文件路径。' },
      },
      required: ['epro_path'],
    },
  },
  {
    name: 'jlceda_modify_epro',
    description:
      '对 work/ 目录下的嘉立创 EDA 专业版 (.epro / .epro2) 工程进行源码级修改：自动解压、执行 Python 修改脚本后重打包（自动备份原文件）。',
    inputSchema: {
      type: 'object',
      properties: {
        epro_path: { type: 'string', description: '目标 .epro / .epro2 文件路径。' },
        output_path: { type: 'string', description: '输出文件路径（默认覆盖原文件并创建 .bak 备份）。' },
        python_patch_code: {
          type: 'string',
          description: '用于修改解压后目录的 Python 代码（环境变量 EPRO_UNPACK_DIR 指向解压后的根目录）。',
        },
      },
      required: ['epro_path', 'python_patch_code'],
    },
  },
  {
    name: 'jlceda_generate_extension_script',
    description:
      '生成嘉立创 EDA 专业版扩展 SDK (eda.* API) 自动化脚本并保存至 work/ 目录，同时支持生成标准 .kicad_mod 封装文件。',
    inputSchema: {
      type: 'object',
      properties: {
        file_name: { type: 'string', description: '保存的文件名，如 jlc_script.js 或 sensor.kicad_mod。' },
        content: { type: 'string', description: '脚本或封装文件的完整内容。' },
      },
      required: ['file_name', 'content'],
    },
  },
  {
    name: 'jlceda_open_gui',
    description: '在用户本地 MacBook 桌面上直接启动 嘉立创EDA(专业版).app，可选传入工程文件路径。',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '可选：要在嘉立创 EDA 专业版中打开的 .epro / .epro2 文件路径。' },
      },
    },
  },

  // --- 4. Local Mac Browser Tools ---
  {
    name: 'mac_browser_fetch',
    description:
      '使用用户本机 Mac 的真实网络请求 URL 并提取文本/Markdown。可绕过远端 Linux 服务器机房 IP 访问立创商城、GitHub、国内网站时的验证码或拦截。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要访问的完整 URL (http/https)。' },
        max_chars: { type: 'number', description: '返回的最大字符数（默认 20000）。' },
      },
      required: ['url'],
    },
  },
  {
    name: 'mac_browser_chrome_extract',
    description:
      '使用用户本机 Mac 的 Google Chrome 浏览器渲染动态网页（支持 SPA / JavaScript 渲染页面）并提取渲染后的 DOM 文本或 HTML。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要使用本地 Chrome 渲染提取的网页 URL。' },
        raw_html: { type: 'boolean', description: '是否返回原始 HTML（默认 false）。' },
        max_chars: { type: 'number', description: '返回的最大字符数（默认 20000）。' },
      },
      required: ['url'],
    },
  },
  {
    name: 'mac_browser_open_url',
    description: '在用户本机 Mac 的默认浏览器中打开指定 URL。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要在 Mac 桌面浏览器打开的 URL。' },
      },
      required: ['url'],
    },
  },

  // --- 5. Xcode & iPhone Build / Flash / Debug Tools ---
  {
    name: 'xcode_list_devices',
    description:
      '列出当前连接到用户 MacBook 的所有 iPhone / iPad / Apple Watch 真机设备及 iOS 模拟器（获取设备名称、UDID、连接状态与系统版本）。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'xcode_build_and_deploy_iphone',
    description:
      '调用本机 Mac 的 Xcode (xcodebuild + xcrun devicectl) 编译 iOS/macOS 工程，并支持直接将编译生成的 .app 烧录安装并启动到连接在 Mac 上的 iPhone 真机！',
    inputSchema: {
      type: 'object',
      properties: {
        project_or_workspace_path: {
          type: 'string',
          description: '.xcodeproj 或 .xcworkspace 路径（可位于 work/ 或 Mac 本机任意路径）。',
        },
        scheme: { type: 'string', description: 'Xcode 编译 Scheme 名称。' },
        configuration: { type: 'string', enum: ['Debug', 'Release'], description: '默认 Debug。' },
        device_udid: {
          type: 'string',
          description: '目标 iPhone 真机的 UDID（可通过 xcode_list_devices 获取；若为空则仅编译或安装到首台连接的真机）。',
        },
        install_and_launch: {
          type: 'boolean',
          description: '编译成功后是否自动烧录安装并启动到 iPhone 真机（默认 true）。',
        },
        bundle_id: {
          type: 'string',
          description: '可选：安装后自动在 iPhone 上启动的 App Bundle Identifier。',
        },
        extra_xcodebuild_args: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：附加给 xcodebuild 的参数（如 ["-allowProvisioningUpdates"]）。',
        },
      },
      required: ['project_or_workspace_path', 'scheme'],
    },
  },

  // --- 6. Local USB Hardware & Serial Port Tools ---
  {
    name: 'usb_list_devices_and_ports',
    description:
      '枚举本机 Mac 当前连接的所有物理 USB 设备树（system_profiler SPUSBDataType）以及所有可用串口设备（/dev/cu.* 与 /dev/tty.*，如 ESP32、CH340、CP2102、J-Link、ST-Link、WCH-Link、iPhone 等）。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'usb_serial_monitor',
    description:
      '读写本机 Mac 上的 USB 串口设备（如 /dev/cu.usbserial-* 或 /dev/cu.usbmodem*）。支持发送串口指令并采集指定时长的硬件串口日志输出。',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'string',
          description: '串口路径，例如 /dev/cu.usbserial-5B0B0246551。',
        },
        baudrate: {
          type: 'number',
          description: '波特率，默认 115200。',
        },
        send_data: {
          type: 'string',
          description: '可选：连接后先向串口发送的字符串指令（会自动附带 \\r\\n）。',
        },
        read_duration_sec: {
          type: 'number',
          description: '持续读取串口输出的时间（秒，默认 3 秒，最大 30 秒）。',
        },
      },
      required: ['port'],
    },
  },

  // --- 7. Local MCU / Embedded Firmware Flashing Tools ---
  {
    name: 'hardware_flash_firmware',
    description:
      '通过本机 Mac 的物理 USB 接口向硬件板卡烧录固件！支持 4 种常用烧录器模式：\n' +
      '1. "esptool"：使用本机 ESP-IDF 的 esptool.py 烧录 ESP32 / ESP32-S3 / ESP32-C3 固件 (.bin)\n' +
      '2. "jlink"：使用本机 SEGGER JLinkExe (/Applications/SEGGER/JLink) 通过 SWD/JTAG 烧录 STM32 / NRF52 / ARM 芯片 (.hex / .bin / .elf)\n' +
      '3. "dfu"：使用本机 dfu-util 通过 USB DFU 模式烧录固件\n' +
      '4. "idf_py"：在指定 ESP-IDF 工程目录下直接执行 `idf.py -p <port> build flash`',
    inputSchema: {
      type: 'object',
      properties: {
        flasher: {
          type: 'string',
          enum: ['esptool', 'jlink', 'dfu', 'idf_py'],
          description: '烧录工具类型：esptool | jlink | dfu | idf_py',
        },
        port: {
          type: 'string',
          description: '串口设备路径（用于 esptool / idf_py，如 /dev/cu.usbserial-5B0B0246551）。',
        },
        chip: {
          type: 'string',
          description: '目标芯片型号（如 esp32s3、STM32F103RC、NRF52840_XXAA 等）。',
        },
        firmware_path: {
          type: 'string',
          description: '要烧录的固件文件路径（.bin / .hex / .elf，位于 work/ 或本机路径）。',
        },
        flash_address: {
          type: 'string',
          description: '烧录起始地址（默认 0x0 或 0x08000000）。',
        },
        extra_args: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：附加命令行参数。',
        },
      },
      required: ['flasher'],
    },
  },

  // --- 8. Local Mac Host Command Execution Bridge & Screen Capture ---
  {
    name: 'mac_screen_capture',
    description:
      '对用户本机 MacBook 桌面或指定应用窗口（如 嘉立创EDA、FreeCAD、Blender、Xcode、iOS 模拟器、Chrome）进行截屏！\n' +
      '截图会自动保存到同步目录 work/screenshots/（远端 /root/work/screenshots/ 可直接访问），并同时将压缩后的高清图像直接作为 MCP 视觉图像块返回给 Claude 直接查看。',
    inputSchema: {
      type: 'object',
      properties: {
        activate_app: {
          type: 'string',
          description: '可选：截屏前先激活置顶的 Mac 应用名称（例如 "FreeCAD"、"Blender"、"嘉立创EDA(专业版)"、"Google Chrome"、"Xcode"、"Simulator"）。',
        },
        region: {
          type: 'string',
          description: '可选：指定截取区域 "x,y,width,height"（如 "0,0,1440,900"），不填则截取整个主屏幕。',
        },
        output_filename: {
          type: 'string',
          description: '可选：保存在 work/screenshots/ 下的文件名（默认 screen_<timestamp>.png）。',
        },
        max_dimension_px: {
          type: 'number',
          description: '返回给 AI 视觉识别的最大长边像素（默认 1600，使用 macOS sips 缩放以保证清晰且低延迟）。',
        },
        return_inline_image: {
          type: 'boolean',
          description: '是否在 MCP 响应中直接返回 base64 图像块供 Claude 视觉查看（默认 true）。',
        },
      },
    },
  },
  {
    name: 'mac_host_exec',
    description:
      '在用户本机 MacBook 上直接执行 Shell 命令（如调用本机编译器、自定义烧录脚本、操控本地软件、查看硬件状态等）。默认工作目录为 $TAKT_HOME/work。',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要在 Mac 本机执行的 zsh/bash 命令字符串。',
        },
        cwd: {
          type: 'string',
          description: '可选：执行目录（默认 $TAKT_HOME/work，支持自动转换 /root/work）。',
        },
        timeout_sec: {
          type: 'number',
          description: '超时时间（秒，默认 120）。',
        },
      },
      required: ['command'],
    },
  },

  // --- 9. Work Directory Sync Status ---
  {
    name: 'work_sync_status',
    description: '查看本机 Mac 的 work/ 同步文件夹文件列表及三维模型/硬件工程状态。',
    inputSchema: {
      type: 'object',
      properties: {
        subdir: { type: 'string', description: '可选子目录路径。' },
      },
    },
  },
];

function stripHtmlToText(html = '') {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

// ============================================================================
// Tool Execution Implementation
// ============================================================================
async function executeTool(name, args = {}) {
  switch (name) {
    case 'blender_run_python': {
      let scriptPath;
      if (args.script_file) {
        scriptPath = resolveWorkPath(args.script_file);
        if (fs.existsSync(scriptPath)) {
          const original = await fsp.readFile(scriptPath, 'utf8');
          const rewritten = rewriteScriptPaths(original);
          if (rewritten !== original) await fsp.writeFile(scriptPath, rewritten, 'utf8');
        }
      } else if (args.script_code) {
        scriptPath = path.join(MAC_WORK_DIR, `_blender_job_${Date.now()}.py`);
        await fsp.writeFile(scriptPath, rewriteScriptPaths(args.script_code), 'utf8');
      } else {
        throw new Error('请提供 script_code 或 script_file');
      }

      const cliArgs = ['-b'];
      if (args.blend_file) {
        const bf = resolveWorkPath(args.blend_file);
        if (fs.existsSync(bf)) cliArgs.push(bf);
      }
      cliArgs.push('-P', scriptPath);

      const res = await runCommand(PATHS.blenderBin, cliArgs, { cwd: MAC_WORK_DIR });
      return `Blender 执行完成 (exitCode=${res.exitCode}):\nSTDOUT:\n${res.stdout.slice(-4000)}\nSTDERR:\n${res.stderr.slice(-2000)}`;
    }

    case 'blender_render_image': {
      const blendFile = resolveWorkPath(args.blend_file);
      const outImg = resolveWorkPath(args.output_image || 'render_preview.png');
      const engine = args.engine || 'BLENDER_EEVEE_NEXT';
      const samples = Number(args.samples || 32);

      const renderPy = path.join(MAC_WORK_DIR, `_blender_render_${Date.now()}.py`);
      const pyContent = `
import bpy
scene = bpy.context.scene
try:
    scene.render.engine = '${engine}'
except Exception:
    scene.render.engine = 'CYCLES'

if scene.render.engine == 'CYCLES':
    scene.cycles.samples = ${samples}
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        scene.cycles.device = 'GPU'
    except Exception as e:
        print("Metal GPU setup warning:", e)
else:
    try:
        scene.eevee.taa_render_samples = ${samples}
    except Exception:
        pass

if not scene.camera:
    bpy.ops.object.camera_add(location=(6.0, -6.0, 5.0), rotation=(1.1, 0.0, 0.785))
    scene.camera = bpy.context.active_object

scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = ${JSON.stringify(outImg)}
bpy.ops.render.render(write_still=True)
print("RENDER_SAVED_TO:", scene.render.filepath)
`;
      await fsp.writeFile(renderPy, pyContent, 'utf8');
      const res = await runCommand(PATHS.blenderBin, ['-b', blendFile, '-P', renderPy], { cwd: MAC_WORK_DIR });
      await fsp.unlink(renderPy).catch(() => {});
      return `Mac GPU 渲染完成 (exitCode=${res.exitCode})\n输出图片: ${outImg}\n日志:\n${res.stdout.slice(-3000)}`;
    }

    case 'blender_open_gui': {
      const target = args.file_path ? resolveWorkPath(args.file_path) : '';
      const cmdArgs = target && fs.existsSync(target)
        ? ['-a', PATHS.blenderApp, target]
        : ['-a', PATHS.blenderApp];
      await runCommand('open', cmdArgs);
      return `已在 Mac 桌面打开 Blender${target ? `: ${target}` : ''}`;
    }

    case 'freecad_run_python': {
      let scriptPath;
      if (args.script_file) {
        scriptPath = resolveWorkPath(args.script_file);
        if (fs.existsSync(scriptPath)) {
          const original = await fsp.readFile(scriptPath, 'utf8');
          const rewritten = rewriteScriptPaths(original);
          if (rewritten !== original) await fsp.writeFile(scriptPath, rewritten, 'utf8');
        }
      } else if (args.script_code) {
        scriptPath = path.join(MAC_WORK_DIR, `_freecad_job_${Date.now()}.py`);
        await fsp.writeFile(scriptPath, rewriteScriptPaths(args.script_code), 'utf8');
      } else {
        throw new Error('请提供 script_code 或 script_file');
      }

      const res = await runCommand(PATHS.freecadCmd, [scriptPath], { cwd: MAC_WORK_DIR });
      return `Mac FreeCADCmd 执行完成 (exitCode=${res.exitCode}):\nSTDOUT:\n${res.stdout.slice(-4000)}\nSTDERR:\n${res.stderr.slice(-2000)}`;
    }

    case 'freecad_inspect_step': {
      const targetFile = resolveWorkPath(args.file_path);
      if (!fs.existsSync(targetFile)) {
        throw new Error(`文件不存在: ${targetFile}`);
      }
      const inspectPy = path.join(MAC_WORK_DIR, `_freecad_inspect_${Date.now()}.py`);
      const pyCode = `
import json, FreeCAD, Part
path = ${JSON.stringify(targetFile)}
if path.lower().endswith('.fcstd'):
    doc = FreeCAD.openDocument(path)
    shapes = [o.Shape for o in doc.Objects if hasattr(o, 'Shape') and not o.Shape.isNull()]
    shape = Part.makeCompound(shapes) if shapes else Part.Shape()
else:
    shape = Part.read(path)

bb = shape.BoundBox
holes = []
for f in shape.Faces:
    surf = f.Surface
    if surf.__class__.__name__ == 'Cylinder':
        c = surf.Center
        r = surf.Radius
        holes.append({
            "center": [round(c.x, 3), round(c.y, 3), round(c.z, 3)],
            "radius": round(r, 3),
            "diameter": round(r * 2, 3)
        })

info = {
    "file": path,
    "bounding_box_mm": {
        "x_min": round(bb.XMin, 3), "x_max": round(bb.XMax, 3), "x_length": round(bb.XLength, 3),
        "y_min": round(bb.YMin, 3), "y_max": round(bb.YMax, 3), "y_length": round(bb.YLength, 3),
        "z_min": round(bb.ZMin, 3), "z_max": round(bb.ZMax, 3), "z_length": round(bb.ZLength, 3),
    },
    "solids_count": len(shape.Solids),
    "faces_count": len(shape.Faces),
    "cylindrical_features_sample": holes[:30]
}
print("STEP_INSPECT_JSON:" + json.dumps(info, ensure_ascii=False))
`;
      await fsp.writeFile(inspectPy, pyCode, 'utf8');
      const res = await runCommand(PATHS.freecadCmd, [inspectPy], { cwd: MAC_WORK_DIR });
      await fsp.unlink(inspectPy).catch(() => {});
      const match = res.stdout.match(/STEP_INSPECT_JSON:(\{.*\})/);
      if (match) {
        return JSON.stringify(JSON.parse(match[1]), null, 2);
      }
      return `FreeCAD Inspect Output:\n${res.stdout}\n${res.stderr}`;
    }

    case 'freecad_open_gui': {
      const target = args.file_path ? resolveWorkPath(args.file_path) : '';
      const cmdArgs = target && fs.existsSync(target)
        ? ['-a', PATHS.freecadApp, target]
        : ['-a', PATHS.freecadApp];
      await runCommand('open', cmdArgs);
      return `已在 Mac 桌面打开 FreeCAD${target ? `: ${target}` : ''}`;
    }

    case 'jlceda_bridge_status': {
      const bridgePort = await ensureEasyEdaBridge();
      if (args.select_window_id) {
        await runCommand('curl', [
          '-s',
          '-X',
          'POST',
          `http://127.0.0.1:${bridgePort}/eda-windows/select`,
          '-H',
          'Content-Type: application/json',
          '-d',
          JSON.stringify({ windowId: String(args.select_window_id) }),
        ]);
      }
      const healthRes = await runCommand('curl', ['-s', `http://127.0.0.1:${bridgePort}/health`]);
      const winRes = await runCommand('curl', ['-s', `http://127.0.0.1:${bridgePort}/eda-windows`]);
      let health = {};
      let windows = {};
      try { health = JSON.parse(healthRes.stdout || '{}'); } catch {}
      try { windows = JSON.parse(winRes.stdout || '{}'); } catch {}
      return JSON.stringify({
        bridgePort,
        bridgeUrl: `http://localhost:${bridgePort}`,
        health,
        windows,
      }, null, 2);
    }

    case 'jlceda_bridge_execute': {
      const bridgePort = await ensureEasyEdaBridge();
      const payload = { code: String(args.code || '') };
      if (args.window_id) payload.windowId = String(args.window_id);
      const execRes = await runCommand('curl', [
        '-s',
        '--max-time',
        '35',
        '-X',
        'POST',
        `http://127.0.0.1:${bridgePort}/execute`,
        '-H',
        'Content-Type: application/json',
        '-d',
        JSON.stringify(payload),
      ]);
      return execRes.stdout || execRes.stderr || 'No response from EasyEDA Bridge';
    }

    case 'jlceda_inspect_epro': {
      const eproPath = resolveWorkPath(args.epro_path);
      if (!fs.existsSync(eproPath)) {
        throw new Error(`未找到嘉立创工程文件: ${eproPath}`);
      }
      const pyCode = `
import zipfile, json, sys
path = sys.argv[1]
result = {"file": path, "entries": [], "json_files": {}}
with zipfile.ZipFile(path, 'r') as z:
    result["entries"] = z.namelist()
    for name in z.namelist():
        if name.endswith('.json') and z.getinfo(name).file_size < 2_000_000:
            try:
                data = json.loads(z.read(name).decode('utf-8', errors='replace'))
                result["json_files"][name] = list(data.keys()) if isinstance(data, dict) else f"list[{len(data)}]"
            except Exception as e:
                result["json_files"][name] = f"parse_error: {e}"
print(json.dumps(result, ensure_ascii=False, indent=2))
`;
      const res = await runCommand('/usr/bin/python3', ['-c', pyCode, eproPath], { cwd: MAC_WORK_DIR });
      return res.stdout || res.stderr;
    }

    case 'jlceda_modify_epro': {
      const eproPath = resolveWorkPath(args.epro_path);
      const outPath = args.output_path ? resolveWorkPath(args.output_path) : eproPath;
      if (!fs.existsSync(eproPath)) {
        throw new Error(`未找到嘉立创工程文件: ${eproPath}`);
      }
      const wrapperPy = `
import zipfile, tempfile, shutil, os, subprocess, sys
epro_path = sys.argv[1]
out_path = sys.argv[2]
patch_code = sys.argv[3]

if os.path.abspath(epro_path) == os.path.abspath(out_path):
    shutil.copy2(epro_path, epro_path + '.bak')

tmp_dir = tempfile.mkdtemp(prefix='jlceda_epro_')
try:
    with zipfile.ZipFile(epro_path, 'r') as z:
        z.extractall(tmp_dir)
    env = dict(os.environ)
    env['EPRO_UNPACK_DIR'] = tmp_dir
    proc = subprocess.run([sys.executable, '-c', patch_code], cwd=tmp_dir, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        print("PATCH_ERROR:", proc.stderr, file=sys.stderr)
        sys.exit(proc.returncode)
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as zout:
        for root, dirs, files in os.walk(tmp_dir):
            for file in files:
                full = os.path.join(root, file)
                rel = os.path.relpath(full, tmp_dir)
                zout.write(full, rel)
    print("EPRO_REPACKED_OK:", out_path)
    if proc.stdout:
        print("PATCH_STDOUT:", proc.stdout)
finally:
    shutil.rmtree(tmp_dir, ignore_errors=True)
`;
      const res = await runCommand('/usr/bin/python3', ['-c', wrapperPy, eproPath, outPath, args.python_patch_code], {
        cwd: MAC_WORK_DIR,
      });
      return `嘉立创 .epro 工程修改结果 (exitCode=${res.exitCode}):\n${res.stdout}\n${res.stderr}`;
    }

    case 'jlceda_generate_extension_script': {
      const target = resolveWorkPath(args.file_name || 'jlc_script.js');
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, args.content, 'utf8');
      return `已生成嘉立创 EDA 自动化脚本/封装文件并同步至: ${target}`;
    }

    case 'jlceda_open_gui': {
      const target = args.file_path ? resolveWorkPath(args.file_path) : '';
      const cmdArgs = target && fs.existsSync(target)
        ? ['-a', PATHS.jlcedaApp, target]
        : ['-a', PATHS.jlcedaApp];
      await runCommand('open', cmdArgs);
      return `已在 Mac 桌面启动 嘉立创EDA(专业版)${target ? `: ${target}` : ''}`;
    }

    case 'mac_browser_fetch': {
      const maxChars = Number(args.max_chars || 20000);
      const res = await runCommand('curl', [
        '-sSL',
        '--max-time', '25',
        '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        args.url,
      ]);
      if (res.exitCode !== 0 && !res.stdout) {
        throw new Error(`请求失败: ${res.stderr}`);
      }
      const text = stripHtmlToText(res.stdout).slice(0, maxChars);
      return `URL: ${args.url}\n---\n${text}`;
    }

    case 'mac_browser_chrome_extract': {
      const maxChars = Number(args.max_chars || 20000);
      const res = await runCommand(PATHS.chromeBin, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--virtual-time-budget=5000',
        '--dump-dom',
        args.url,
      ], { timeoutMs: 35000 });
      const content = args.raw_html ? res.stdout : stripHtmlToText(res.stdout);
      return `Chrome Rendered URL: ${args.url}\n---\n${content.slice(0, maxChars)}`;
    }

    case 'mac_browser_open_url': {
      await runCommand('open', [args.url]);
      return `已在 Mac 默认浏览器打开: ${args.url}`;
    }

    // --- 5. Xcode & iPhone Build / Flash / Debug ---
    case 'xcode_list_devices': {
      const devCtl = await runCommand(PATHS.xcrun, ['devicectl', 'list', 'devices'], { timeoutMs: 20000 });
      const xcTrace = await runCommand(PATHS.xcrun, ['xctrace', 'list', 'devices'], { timeoutMs: 20000 });
      return `=== xcrun devicectl list devices ===\n${devCtl.stdout}\n${devCtl.stderr}\n=== xcrun xctrace list devices ===\n${xcTrace.stdout}`;
    }

    case 'xcode_build_and_deploy_iphone': {
      const projPath = resolveWorkPath(args.project_or_workspace_path);
      const isWorkspace = projPath.endsWith('.xcworkspace');
      const cfg = args.configuration || 'Debug';
      const derivedData = path.join(MAC_WORK_DIR, '.xcode_derived_data');

      const buildArgs = [
        isWorkspace ? '-workspace' : '-project',
        projPath,
        '-scheme',
        args.scheme,
        '-configuration',
        cfg,
        '-derivedDataPath',
        derivedData,
        '-allowProvisioningUpdates',
      ];
      if (args.device_udid) {
        buildArgs.push('-destination', `id=${args.device_udid}`);
      } else {
        buildArgs.push('-destination', 'generic/platform=iOS');
      }
      if (Array.isArray(args.extra_xcodebuild_args)) {
        buildArgs.push(...args.extra_xcodebuild_args);
      }
      buildArgs.push('build');

      const buildRes = await runCommand(PATHS.xcodeBuild, buildArgs, {
        cwd: path.dirname(projPath),
        timeoutMs: 300000,
      });

      let outputLog = `xcodebuild 结果 (exitCode=${buildRes.exitCode}):\n${buildRes.stdout.slice(-3500)}\n${buildRes.stderr.slice(-1500)}`;
      if (buildRes.exitCode !== 0 || args.install_and_launch === false || !args.device_udid) {
        return outputLog;
      }

      const findRes = await runCommand('find', [derivedData, '-name', '*.app', '-type', 'd']);
      const appPath = findRes.stdout.split('\n').map((s) => s.trim()).find((s) => s.includes(`${cfg}-iphoneos`));
      if (!appPath) {
        return `${outputLog}\n⚠️ 未找到真机 .app 产物，请检查编译日志。`;
      }

      const installRes = await runCommand(PATHS.xcrun, [
        'devicectl', 'device', 'install', 'app',
        '--device', args.device_udid,
        appPath,
      ], { timeoutMs: 120000 });
      outputLog += `\n\n=== 真机烧录安装 (${appPath}) ===\n${installRes.stdout}\n${installRes.stderr}`;

      if (args.bundle_id && installRes.exitCode === 0) {
        const launchRes = await runCommand(PATHS.xcrun, [
          'devicectl', 'device', 'process', 'launch',
          '--device', args.device_udid,
          args.bundle_id,
        ]);
        outputLog += `\n=== 真机启动 (${args.bundle_id}) ===\n${launchRes.stdout}\n${launchRes.stderr}`;
      }
      return outputLog;
    }

    // --- 6. Local USB & Serial Port Tools ---
    case 'usb_list_devices_and_ports': {
      const serials = fs.readdirSync('/dev')
        .filter((f) => f.startsWith('cu.') || f.startsWith('tty.usb'))
        .map((f) => `/dev/${f}`);
      const usbRes = await runCommand('system_profiler', ['SPUSBDataType', '-detailLevel', 'mini'], { timeoutMs: 15000 });
      return `=== Mac 本地串口设备 (/dev/cu.*) ===\n${serials.join('\n')}\n\n=== Mac USB 物理设备树 ===\n${usbRes.stdout}`;
    }

    case 'usb_serial_monitor': {
      const port = args.port;
      const baud = Number(args.baudrate || 115200);
      const duration = Math.min(30, Math.max(1, Number(args.read_duration_sec || 3)));
      const sendData = args.send_data || '';

      const pyScript = `
import os, sys, termios, time, select

port = sys.argv[1]
baud = int(sys.argv[2])
duration = float(sys.argv[3])
send_str = sys.argv[4]

BAUD_MAP = {
    9600: termios.B9600,
    19200: termios.B19200,
    38400: termios.B38400,
    57600: termios.B57600,
    115200: termios.B115200,
    230400: termios.B230400,
}

fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
try:
    attrs = termios.tcgetattr(fd)
    spd = BAUD_MAP.get(baud, termios.B115200)
    attrs[0] = 0
    attrs[1] = 0
    attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
    attrs[3] = 0
    attrs[4] = spd
    attrs[5] = spd
    termios.tcsetattr(fd, termios.TCSANOW, attrs)

    if send_str:
        os.write(fd, (send_str + "\\r\\n").encode('utf-8'))

    end_time = time.time() + duration
    buf = bytearray()
    while time.time() < end_time:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            chunk = os.read(fd, 4096)
            if chunk:
                buf.extend(chunk)
    print(buf.decode('utf-8', errors='replace'))
finally:
    os.close(fd)
`;
      const res = await runCommand('/usr/bin/python3', ['-c', pyScript, port, String(baud), String(duration), sendData], {
        timeoutMs: (duration + 5) * 1000,
      });
      return `串口 ${port} (@${baud}bps, 采集 ${duration}s) 输出:\n${res.stdout}\n${res.stderr}`;
    }

    // --- 7. Local MCU / Embedded Firmware Flashing ---
    case 'hardware_flash_firmware': {
      const flasher = args.flasher;
      const fwPath = args.firmware_path ? resolveWorkPath(args.firmware_path) : '';
      const addr = args.flash_address || '0x0';

      if (flasher === 'esptool') {
        const port = args.port || '/dev/cu.usbserial-5B0B0246551';
        const chip = args.chip || 'auto';
        const cliArgs = [PATHS.esptoolPy, '--chip', chip, '--port', port, 'write_flash', addr, fwPath];
        if (Array.isArray(args.extra_args)) cliArgs.push(...args.extra_args);
        const res = await runCommand(PATHS.espPython, cliArgs, { timeoutMs: 120000 });
        return `ESP32 烧录结果 (exitCode=${res.exitCode}):\n${res.stdout}\n${res.stderr}`;
      }

      if (flasher === 'jlink') {
        const chip = args.chip || 'STM32F103RC';
        const jlinkScript = path.join(MAC_WORK_DIR, `_jlink_flash_${Date.now()}.jlink`);
        const loadAddr = fwPath.endsWith('.bin') ? ` ${addr === '0x0' ? '0x08000000' : addr}` : '';
        const content = `r\nh\nloadfile "${fwPath}"${loadAddr}\nr\ng\nq\n`;
        await fsp.writeFile(jlinkScript, content, 'utf8');
        const res = await runCommand(PATHS.jlinkExe, [
          '-device', chip,
          '-if', 'SWD',
          '-speed', '4000',
          '-autoconnect', '1',
          '-CommandFile', jlinkScript,
        ], { timeoutMs: 60000 });
        await fsp.unlink(jlinkScript).catch(() => {});
        return `SEGGER J-Link 烧录结果 (exitCode=${res.exitCode}):\n${res.stdout}\n${res.stderr}`;
      }

      if (flasher === 'dfu') {
        const cliArgs = ['-a', '0', '-D', fwPath];
        if (Array.isArray(args.extra_args)) cliArgs.push(...args.extra_args);
        const res = await runCommand(PATHS.dfuUtil, cliArgs, { timeoutMs: 60000 });
        return `DFU 烧录结果 (exitCode=${res.exitCode}):\n${res.stdout}\n${res.stderr}`;
      }

      if (flasher === 'idf_py') {
        const projDir = fwPath || MAC_WORK_DIR;
        const portFlag = args.port ? `-p ${args.port}` : '';
        const cmd = `source ${JSON.stringify(cfg.IDF_EXPORT_SH)} && idf.py ${portFlag} build flash`;
        const res = await runCommand('/bin/zsh', ['-c', cmd], { cwd: projDir, timeoutMs: 300000 });
        return `ESP-IDF 编译烧录结果 (exitCode=${res.exitCode}):\n${res.stdout.slice(-4000)}\n${res.stderr.slice(-2000)}`;
      }

      throw new Error(`未知烧录器类型: ${flasher}`);
    }

    // --- 8. Local Mac Screen Capture & Host Command Bridge ---
    case 'mac_screen_capture': {
      const shotsDir = path.join(MAC_WORK_DIR, 'screenshots');
      await fsp.mkdir(shotsDir, { recursive: true });
      const fileName = args.output_filename || `screen_${Date.now()}.png`;
      const outPath = path.join(shotsDir, path.basename(fileName));
      const shotNode = getActiveNodeConfig();
      const linuxSyncedPath = `${((shotNode && shotNode.remoteWorkDir) || LINUX_WORK_DIR).replace(/\/+$/, '')}/screenshots/${path.basename(fileName)}`;

      if (args.activate_app) {
        await runCommand('osascript', ['-e', `tell application "${args.activate_app}" to activate`], { timeoutMs: 5000 });
        await new Promise((r) => setTimeout(r, 500));
      }

      const capArgs = ['-x'];
      if (args.region) {
        capArgs.push('-R', String(args.region));
      }
      capArgs.push(outPath);
      const capRes = await runCommand('/usr/sbin/screencapture', capArgs, { timeoutMs: 15000 });
      if (!fs.existsSync(outPath)) {
        throw new Error(`Mac 截屏失败 (请确认终端/Node 具有 macOS 屏幕录制权限): ${capRes.stderr}`);
      }

      const maxDim = Number(args.max_dimension_px || 1600);
      if (maxDim > 0) {
        await runCommand('/usr/bin/sips', ['-Z', String(maxDim), outPath], { timeoutMs: 10000 });
      }

      const textSummary = `✅ Mac 截屏成功！\n- Mac 本地路径: ${outPath}\n- 远端 Linux 同步路径: ${linuxSyncedPath}`;
      if (args.return_inline_image !== false) {
        const imgBuf = await fsp.readFile(outPath);
        return {
          __mcp_content: [
            { type: 'text', text: textSummary },
            { type: 'image', data: imgBuf.toString('base64'), mimeType: 'image/png' },
          ],
        };
      }
      return textSummary;
    }

    case 'mac_host_exec': {
      const cwd = args.cwd ? resolveWorkPath(args.cwd) : MAC_WORK_DIR;
      const timeoutMs = Math.min(600000, Math.max(5000, Number(args.timeout_sec || 120) * 1000));
      const cmd = rewriteScriptPaths(args.command);
      const res = await runCommand('/bin/zsh', ['-c', cmd], { cwd, timeoutMs });
      return `Mac 本机命令执行完成 (exitCode=${res.exitCode}, cwd=${cwd}):\nSTDOUT:\n${res.stdout.slice(-6000)}\nSTDERR:\n${res.stderr.slice(-3000)}`;
    }

    case 'work_sync_status': {
      const dir = args.subdir ? resolveWorkPath(args.subdir) : MAC_WORK_DIR;
      const items = await fsp.readdir(dir, { withFileTypes: true });
      const rows = [];
      for (const item of items) {
        const full = path.join(dir, item.name);
        const st = await fsp.stat(full).catch(() => null);
        rows.push({
          name: item.name,
          type: item.isDirectory() ? 'dir' : 'file',
          size: st ? st.size : 0,
          mtime: st ? st.mtime.toISOString() : null,
        });
      }
      return JSON.stringify({ mac_work_dir: dir, files: rows }, null, 2);
    }

    default:
      throw new Error(`未知工具: ${name}`);
  }
}

// ============================================================================
// JSON-RPC 2.0 MCP Handler
// ============================================================================
async function handleJsonRpc(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const { id, method, params } = msg;

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: 'mac-industrial-mcp',
            version: '2.1.0',
          },
        },
      };
    }

    if (method === 'notifications/initialized' || method === 'initialized') {
      return null;
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      };
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const output = await executeTool(toolName, toolArgs);
        const content = output && typeof output === 'object' && Array.isArray(output.__mcp_content)
          ? output.__mcp_content
          : [{ type: 'text', text: String(output) }];
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content,
            isError: false,
          },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Tool Error (${toolName}): ${err.message}` }],
            isError: true,
          },
        };
      }
    }

    if (id !== undefined) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
    }
    return null;
  } catch (err) {
    if (id !== undefined) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: err.message },
      };
    }
    return null;
  }
}

// ============================================================================
// Built-in 3D Real-time Model Viewer & Mac Hardware Action Bar HTML (/viewer)
// ============================================================================
const VIEWER_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>Mac 工业软件与硬件烧录控制台 & 3D 实时预览窗 (work/)</title>
  <script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      display: flex;
      height: 100vh;
      overflow: hidden;
    }
    .sidebar {
      width: 350px;
      background: #161922;
      border-right: 1px solid #262b38;
      display: flex;
      flex-direction: column;
      padding: 16px;
      gap: 12px;
    }
    h1 { font-size: 16px; font-weight: 600; color: #f8fafc; }
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 11px;
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .btn-group { display: flex; flex-direction: column; gap: 7px; }
    button {
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 9px 12px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      text-align: left;
      display: flex;
      align-items: center;
      justify-content: space-between;
      transition: background 0.15s;
    }
    button:hover { background: #1d4ed8; }
    button.secondary { background: #262b38; color: #cbd5e1; }
    button.secondary:hover { background: #333a4b; }
    .file-list {
      flex: 1;
      overflow-y: auto;
      border: 1px solid #262b38;
      border-radius: 8px;
      padding: 8px;
      background: #0f1117;
    }
    .file-item {
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .file-item:hover, .file-item.active { background: #1e293b; color: #60a5fa; }
    .viewer-pane {
      flex: 1;
      display: flex;
      flex-direction: column;
      position: relative;
      background: radial-gradient(circle at center, #1e2433 0%, #0f1117 100%);
    }
    model-viewer {
      width: 100%;
      height: 100%;
      --poster-color: transparent;
    }
    .topbar {
      position: absolute;
      top: 16px;
      left: 16px;
      right: 16px;
      display: flex;
      justify-content: space-between;
      pointer-events: none;
      z-index: 10;
    }
    .status-pill {
      pointer-events: auto;
      background: rgba(22, 25, 34, 0.85);
      backdrop-filter: blur(8px);
      border: 1px solid #2d3548;
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 12px;
      max-width: 90%;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <div class="sidebar">
    <div>
      <h1>Mac 工业软件与硬件 MCP 工作台</h1>
      <div style="margin-top:6px;"><span class="badge">Syncthing + 19项硬件/软件 MCP 在线</span></div>
    </div>
    <div class="btn-group">
      <button onclick="openApp('freecad_open_gui')">
        <span>🔧 用 FreeCAD 打开选中模型</span>
        <span>→</span>
      </button>
      <button onclick="openApp('blender_open_gui')">
        <span>🎨 用 Blender 打开/渲染场景</span>
        <span>→</span>
      </button>
      <button onclick="openApp('jlceda_open_gui')">
        <span>⚡ 启动 嘉立创 EDA (专业版)</span>
        <span>→</span>
      </button>
      <button class="secondary" onclick="openApp('usb_list_devices_and_ports')">
        <span>🔌 查看本机 USB 烧录器与串口</span>
        <span>→</span>
      </button>
      <button class="secondary" onclick="openApp('xcode_list_devices')">
        <span>📱 查看本机连接 iPhone / Xcode 设备</span>
        <span>→</span>
      </button>
      <button class="secondary" onclick="window.open('http://127.0.0.1:3080', '_blank')">
        <span>💬 打开 DeepSeek Harness (纯显示 UI)</span>
        <span>↗</span>
      </button>
    </div>
    <div style="font-size:12px;color:#94a3b8;margin-top:4px;">work/ 目录同步文件 (自动刷新):</div>
    <div class="file-list" id="fileList">加载中...</div>
  </div>
  <div class="viewer-pane">
    <div class="topbar">
      <div class="status-pill" id="currentFileLabel">选择左侧 .glb / .gltf 模型即可 360° 实时预览（或点击上方按钮调起 FreeCAD / Blender / 嘉立创 EDA / USB & iPhone 检测）</div>
    </div>
    <model-viewer id="mv" camera-controls auto-rotate shadow-intensity="1"></model-viewer>
  </div>
  <script>
    let selectedFile = '';
    let lastMtimeMap = {};

    async function refreshFiles() {
      const res = await fetch('/api/files');
      const data = await res.json();
      const list = document.getElementById('fileList');
      list.innerHTML = '';
      for (const f of data.files) {
        const div = document.createElement('div');
        div.className = 'file-item' + (selectedFile === f.name ? ' active' : '');
        div.innerHTML = '<span>' + f.name + '</span><span style="color:#64748b">' + (f.size / 1024).toFixed(1) + ' KB</span>';
        div.onclick = () => selectFile(f.name);
        list.appendChild(div);

        if (selectedFile === f.name && lastMtimeMap[f.name] && lastMtimeMap[f.name] !== f.mtime) {
          selectFile(f.name, true);
        }
        lastMtimeMap[f.name] = f.mtime;
      }
    }

    function selectFile(name, reload = false) {
      selectedFile = name;
      document.getElementById('currentFileLabel').textContent = '当前选中: ' + name + (reload ? ' (已实时同步更新!)' : '');
      if (name.endsWith('.glb') || name.endsWith('.gltf')) {
        document.getElementById('mv').src = '/work/' + encodeURIComponent(name) + '?t=' + Date.now();
      }
      refreshFiles();
    }

    async function openApp(toolName) {
      const res = await fetch('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: { name: toolName, arguments: selectedFile ? { file_path: selectedFile } : {} }
        })
      });
      const out = await res.json();
      const msg = out?.result?.content?.[0]?.text || '已发送指令';
      document.getElementById('currentFileLabel').textContent = msg.slice(0, 600);
    }

    refreshFiles();
    setInterval(refreshFiles, 1500);
  </script>
</body>
</html>`;

if (process.argv.includes('--stdio')) {
  let buf = '';
  process.stdin.on('data', async (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const resp = await handleJsonRpc(msg);
        if (resp) {
          process.stdout.write(JSON.stringify(resp) + '\n');
        }
      } catch {}
    }
  });
} else {
  const sseClients = new Map();

  const server = http.createServer(async (req, res) => {
    // No CORS headers on purpose: browsers on other origins must not be able to call this server.
    // Reject DNS-rebinding (non-loopback Host) and any browser request carrying a foreign Origin.
    const hostName = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!['127.0.0.1', 'localhost', '::1'].includes(hostName)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden host');
      return;
    }
    if (req.headers.origin) {
      let originOk = false;
      try {
        const o = new URL(req.headers.origin);
        originOk = ['127.0.0.1', 'localhost'].includes(o.hostname) && Number(o.port || 80) === PORT;
      } catch {}
      if (!originOk) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden origin');
        return;
      }
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const urlObj = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    // MCP endpoints can run commands on this machine: require the shared token.
    const isMcpEndpoint = urlObj.pathname === '/mcp' || urlObj.pathname === '/messages' || urlObj.pathname === '/sse';
    if (isMcpEndpoint) {
      const auth = String(req.headers.authorization || '');
      const supplied = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(req.headers['x-takt-token'] || urlObj.searchParams.get('token') || '');
      const a = Buffer.from(supplied);
      const b = Buffer.from(MCP_TOKEN);
      if (a.length !== b.length || !require('node:crypto').timingSafeEqual(a, b)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: missing or invalid MCP token' } }));
        return;
      }
    }

    if (urlObj.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'mac-industrial-mcp', workDir: MAC_WORK_DIR, tools: TOOLS.length }));
      return;
    }

    if (urlObj.pathname === '/system-status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(systemStatusState));
      return;
    }

    if (urlObj.pathname === '/system-heal' && req.method === 'POST') {
      await runSystemWatchdogCycle(true);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(systemStatusState));
      return;
    }

    if (urlObj.pathname === '/viewer' || urlObj.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(VIEWER_HTML);
      return;
    }

    if (urlObj.pathname === '/api/files') {
      const raw = await executeTool('work_sync_status', {});
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(raw);
      return;
    }

    if (urlObj.pathname.startsWith('/work/')) {
      const rel = decodeURIComponent(urlObj.pathname.slice('/work/'.length));
      let safePath = path.resolve(MAC_WORK_DIR, rel);
      if (safePath.startsWith(MAC_WORK_DIR) && !fs.existsSync(safePath)) {
        try {
          const topEntries = fs.readdirSync(MAC_WORK_DIR, { withFileTypes: true });
          for (const ent of topEntries) {
            if (ent.isDirectory() && !ent.name.startsWith('.')) {
              const cand = path.resolve(MAC_WORK_DIR, ent.name, rel);
              if (cand.startsWith(MAC_WORK_DIR) && fs.existsSync(cand)) {
                safePath = cand;
                break;
              }
            }
          }
        } catch {}
      }
      if (!safePath.startsWith(MAC_WORK_DIR) || !fs.existsSync(safePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(safePath).toLowerCase();
      const mimeMap = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.glb': 'model/gltf-binary',
        '.gltf': 'model/gltf+json',
        '.pdf': 'application/pdf',
      };
      const headers = {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      };
      if (mimeMap[ext]) {
        headers['Content-Type'] = mimeMap[ext];
      }
      res.writeHead(200, headers);
      fs.createReadStream(safePath).pipe(res);
      return;
    }

    if (urlObj.pathname === '/sse' && req.method === 'GET') {
      const clientId = String(Date.now()) + Math.random().toString(36).slice(2, 6);
      const nodeParam = urlObj.searchParams.get('node') || req.headers['x-takt-node'] || '';
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const endpointUrl = `/messages?clientId=${clientId}${nodeParam ? `&node=${encodeURIComponent(nodeParam)}` : ''}`;
      res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);
      sseClients.set(clientId, { res, nodeId: nodeParam });
      req.on('close', () => sseClients.delete(clientId));
      return;
    }

    if ((urlObj.pathname === '/mcp' || urlObj.pathname === '/messages') && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const clientId = urlObj.searchParams.get('clientId');
          const sseEntry = clientId ? sseClients.get(clientId) : null;
          const reqNodeId = urlObj.searchParams.get('node') || req.headers['x-takt-node'] || (sseEntry && sseEntry.nodeId) || null;
          const prevNode = activeMcpNodeId;
          activeMcpNodeId = reqNodeId;
          let resp;
          try {
            resp = await handleJsonRpc(payload);
          } finally {
            activeMcpNodeId = prevNode;
          }
          if (sseEntry && sseEntry.res && resp) {
            sseEntry.res.write(`event: message\ndata: ${JSON.stringify(resp)}\n\n`);
            res.writeHead(202);
            res.end('Accepted');
            return;
          }
          if (!resp) {
            res.writeHead(202);
            res.end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(resp));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: err.message } }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(PORT, BIND_HOST, () => {
    console.log(`[mac-industrial-mcp] Listening on http://${BIND_HOST}:${PORT}/mcp (3D Viewer: http://127.0.0.1:${PORT}/viewer)`);
    startBridgeAndTunnelWatchdog();
  });
}

async function ensureEasyEdaBridgeDetailed() {
  for (let p = EDA_PORT; p <= EDA_PORT + 9; p++) {
    const r = await runCommand('curl', ['-s', '--max-time', '1', `http://127.0.0.1:${p}/health`]);
    if (r.stdout && r.stdout.includes('"easyeda-bridge"')) {
      try {
        const parsed = JSON.parse(r.stdout);
        return { port: p, ok: true, edaConnected: Boolean(parsed.edaConnected), windowCount: Number(parsed.edaWindowCount || 0) };
      } catch {
        return { port: p, ok: true, edaConnected: false, windowCount: 0 };
      }
    }
  }
  const candidates = [
    cfg.EASYEDA_BRIDGE_SCRIPT,
    path.join(cfg.HOME, '.claude/skills/easyeda-api/scripts/bridge-server.mjs'),
    path.join(cfg.TAKT_HOME, 'easyeda-api/scripts/bridge-server.mjs'),
  ].filter(Boolean);
  const bridgeScript = candidates.find((c) => fs.existsSync(c));
  if (bridgeScript) {
    const child = spawn(process.execPath, [bridgeScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
    await new Promise((r) => setTimeout(r, 1000));
    for (let p = EDA_PORT; p <= EDA_PORT + 9; p++) {
      const r = await runCommand('curl', ['-s', '--max-time', '1', `http://127.0.0.1:${p}/health`]);
      if (r.stdout && r.stdout.includes('"easyeda-bridge"')) {
        try {
          const parsed = JSON.parse(r.stdout);
          return { port: p, ok: true, edaConnected: Boolean(parsed.edaConnected), windowCount: Number(parsed.edaWindowCount || 0) };
        } catch {
          return { port: p, ok: true, edaConnected: false, windowCount: 0 };
        }
      }
    }
  }
  return { port: EDA_PORT, ok: false, edaConnected: false, windowCount: 0 };
}

async function ensureEasyEdaBridge() {
  const info = await ensureEasyEdaBridgeDetailed();
  return info.port;
}

const systemStatusState = {
  ok: false,
  updatedAt: Date.now(),
  healing: false,
  healCount: 0,
  lastHealAt: null,
  remoteCli: {
    online: false,
    processCount: 0,
    uptimeSec: 0,
    pids: [],
    egressIp: '',
  },
  mcpStatus: {
    ok: false,
    localMcpOk: true,
    remoteTunnelOk: false,
    edaBridgeOk: false,
    edaClientConnected: false,
    tools: TOOLS.length,
    pingMs: null,
  },
  diskSync: {
    ok: false,
    connected: false,
    state: 'idle',
    inSyncFiles: 0,
    globalFiles: 0,
    needFiles: 0,
    needBytes: 0,
    inBps: 0,
    outBps: 0,
    address: '',
  },
  claudeUsage: null,
  nodesStatus: {},
};

let prevSyncthingSample = null;
let watchdogRunning = false;
const lastNodeHealAt = new Map();

function getSyncthingApiKey() {
  try {
    const cfgXml = fs.readFileSync(cfg.findSyncthingConfig(), 'utf8');
    const m = cfgXml.match(/<apikey>([^<]+)<\/apikey>/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

async function syncthingGet(apiKey, apiPath) {
  const r = await runCommand('curl', ['-s', '--max-time', '1.5', '-H', `X-API-Key: ${apiKey}`, `${SYNCTHING_URL}${apiPath}`]);
  return r.stdout;
}

/** Aggregates Syncthing state over every node's folder / device (local Syncthing REST API). */
async function checkSyncthingStatus(nodes = loadConfiguredNodes().filter((n) => n.enabled && n.sshHost)) {
  const apiKey = getSyncthingApiKey();
  if (!apiKey) return; // Syncthing not installed / not configured: leave diskSync at defaults
  try {
    const connRaw = await syncthingGet(apiKey, '/rest/system/connections');
    if (!connRaw) {
      systemStatusState.diskSync.ok = false;
      systemStatusState.diskSync.connected = false;
      return;
    }
    const conns = JSON.parse(connRaw).connections || {};
    const deviceIds = nodes.map((n) => n.syncthingDeviceId).filter(Boolean);
    const relevant = deviceIds.length ? deviceIds.map((id) => conns[id]).filter(Boolean) : Object.values(conns);
    const connectedEntry = relevant.find((c) => c && c.connected) || {};
    const anyConnected = Boolean(connectedEntry.connected);

    const nowMs = Date.now();
    const inTotal = relevant.reduce((a, c) => a + Number(c.inBytesTotal || 0), 0);
    const outTotal = relevant.reduce((a, c) => a + Number(c.outBytesTotal || 0), 0);
    let inBps = 0;
    let outBps = 0;
    if (prevSyncthingSample && nowMs > prevSyncthingSample.ts) {
      const dtSec = (nowMs - prevSyncthingSample.ts) / 1000;
      if (dtSec > 0.5 && inTotal >= prevSyncthingSample.inTotal && outTotal >= prevSyncthingSample.outTotal) {
        inBps = Math.round((inTotal - prevSyncthingSample.inTotal) / dtSec);
        outBps = Math.round((outTotal - prevSyncthingSample.outTotal) / dtSec);
      }
    }
    prevSyncthingSample = { ts: nowMs, inTotal, outTotal };

    let inSyncFiles = 0, globalFiles = 0, needFiles = 0, needBytes = 0;
    let state = 'idle';
    const folderIds = [...new Set(nodes.map((n) => n.syncthingFolderId).filter(Boolean))];
    for (const fid of folderIds) {
      try {
        const db = JSON.parse((await syncthingGet(apiKey, `/rest/db/status?folder=${encodeURIComponent(fid)}`)) || '{}');
        inSyncFiles += Number(db.inSyncFiles || 0);
        globalFiles += Number(db.globalFiles || 0);
        needFiles += Number(db.needFiles || 0);
        needBytes += Number(db.needBytes || 0);
        if (db.state && db.state !== 'idle') state = db.state;
      } catch {}
    }

    systemStatusState.diskSync = {
      ok: anyConnected || inSyncFiles > 0,
      connected: anyConnected,
      state,
      inSyncFiles,
      globalFiles,
      needFiles,
      needBytes,
      inBps,
      outBps,
      address: connectedEntry.address || '',
    };
  } catch {}
}

// Python probe executed on each remote Linux node (over the node's ssh ControlMaster socket).
const REMOTE_PROBE_PY = `
import subprocess, json, urllib.request, glob, os, time, re
from datetime import datetime

pids = []
max_et = 0
out = subprocess.run(["ps", "-eo", "pid,etimes,comm,args"], capture_output=True, text=True).stdout
for line in out.splitlines()[1:]:
    parts = line.strip().split(None, 3)
    if len(parts) >= 3 and parts[2] == "claude":
        pids.append(int(parts[0]))
        et = int(parts[1])
        if et > max_et: max_et = et
mcp_ok = False
try:
    r = urllib.request.urlopen("http://127.0.0.1:${PORT}/health", timeout=1.5).read().decode()
    mcp_ok = '"mac-industrial-mcp"' in r
except Exception:
    pass
eda_ok = False
try:
    r2 = urllib.request.urlopen("http://127.0.0.1:${EDA_PORT}/health", timeout=1.5).read().decode()
    eda_ok = '"easyeda-bridge"' in r2
except Exception:
    pass
egress = ""
try:
    rt = subprocess.run(["ip", "route", "get", "160.79.104.10"], capture_output=True, text=True, timeout=2).stdout
    m_src = re.search(r"src\\s+(\\S+)", rt)
    egress = m_src.group(1) if m_src else ""
except Exception:
    pass

# Claude usage estimate (rolling window over local session JSONL files)
home = os.path.expanduser("~")
now = time.time()
creds_path = os.path.join(home, ".claude", ".credentials.json")
settings_path = os.path.join(home, ".claude", "settings.json")
creds_mtime = os.path.getmtime(creds_path) if os.path.exists(creds_path) else 0
plan_name = "Claude"
is_api_proxy = False
try:
    st = json.load(open(settings_path))
    if (st.get("env") or {}).get("ANTHROPIC_BASE_URL"):
        is_api_proxy = True
        plan_name = "API Proxy"
except Exception:
    pass

win_5h_start = max(now - 5 * 3600, creds_mtime if not is_api_proxy else 0)
win_7d_start = max(now - 7 * 86400, creds_mtime if not is_api_proxy else 0)
seen_ids = set()
turns_5h = 0; weighted_5h = 0.0; tokens_5h = 0; oldest_5h_ts = None
turns_7d = 0; weighted_7d = 0.0; tokens_7d = 0; oldest_7d_ts = None

for p in glob.glob(os.path.join(home, ".claude", "projects", "*", "*.jsonl")):
    try:
        if os.path.getmtime(p) < (now - 7 * 86400):
            continue
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            for l in f:
                if '"usage"' not in l:
                    continue
                d = json.loads(l)
                if d.get("type") != "assistant":
                    continue
                msg = d.get("message") or {}
                mid = msg.get("id")
                if not mid or mid in seen_ids:
                    continue
                seen_ids.add(mid)
                ts_str = d.get("timestamp")
                if not ts_str:
                    continue
                ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp()
                if ts < win_7d_start:
                    continue
                u = msg.get("usage") or {}
                inp = int(u.get("input_tokens") or 0)
                cc = int(u.get("cache_creation_input_tokens") or 0)
                cr = int(u.get("cache_read_input_tokens") or 0)
                out_t = int(u.get("output_tokens") or 0)
                raw = inp + cc + cr + out_t
                if raw <= 0:
                    continue
                w = inp * 1.0 + cc * 0.25 + cr * 0.05 + out_t * 4.0
                turns_7d += 1; weighted_7d += w; tokens_7d += raw
                if oldest_7d_ts is None or ts < oldest_7d_ts: oldest_7d_ts = ts
                if ts >= win_5h_start:
                    turns_5h += 1; weighted_5h += w; tokens_5h += raw
                    if oldest_5h_ts is None or ts < oldest_5h_ts: oldest_5h_ts = ts
    except Exception:
        pass

cap_5h_turns = 250.0 if is_api_proxy else 45.0
cap_5h_weight = 2500000.0 if is_api_proxy else 450000.0
cap_7d_turns = 2500.0 if is_api_proxy else 450.0
cap_7d_weight = 25000000.0 if is_api_proxy else 4500000.0
used_5h_pct = min(100, round(max(turns_5h / cap_5h_turns, weighted_5h / cap_5h_weight) * 100))
used_7d_pct = min(100, round(max(turns_7d / cap_7d_turns, weighted_7d / cap_7d_weight) * 100))
reset_5h_sec = max(0, int((oldest_5h_ts + 5 * 3600) - now)) if oldest_5h_ts else 5 * 3600
reset_7d_sec = max(0, int((oldest_7d_ts + 7 * 86400) - now)) if oldest_7d_ts else 7 * 86400

ts_ok = False
ts_ip = ""
try:
    ts_ok = subprocess.run(["systemctl", "is-active", "tailscaled"], capture_output=True, text=True, timeout=2).stdout.strip() == "active"
    ts_ip_out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=1.5).stdout.strip()
    if ts_ip_out:
        ts_ip = ts_ip_out.splitlines()[0].strip()
except Exception:
    pass

usage_info = {
    "plan": plan_name, "source": "session_meter", "authStatus": "ok",
    "remaining5hPct": max(0, 100 - used_5h_pct), "used5hPct": used_5h_pct, "reset5hSec": reset_5h_sec,
    "turns5h": turns_5h, "tokens5h": tokens_5h,
    "remaining7dPct": max(0, 100 - used_7d_pct), "used7dPct": used_7d_pct, "reset7dSec": reset_7d_sec,
    "turns7d": turns_7d, "tokens7d": tokens_7d,
}
print(json.dumps({"pids": pids, "count": len(pids), "uptimeSec": max_et, "mcpOk": mcp_ok, "edaOk": eda_ok,
                  "egressIp": egress, "tailscaleOk": ts_ok, "tailscaleIp": ts_ip, "usage": usage_info}))
`.trim();

const REMOTE_PROBE_CMD = `python3 -c "import base64;exec(base64.b64decode('${Buffer.from(REMOTE_PROBE_PY, 'utf8').toString('base64')}'))"`;

function nodeTunnelSock(node) {
  return path.join(SSH_SOCKET_DIR, `takt-mcp-tunnel-${String(node.id).replace(/[^a-zA-Z0-9_-]/g, '')}.sock`);
}

async function probeNode(node, timeoutMs = 5500) {
  const sock = nodeTunnelSock(node);
  const t0 = Date.now();
  const res = await runCommand('ssh', ['-S', sock, '-o', 'ConnectTimeout=4', node.sshHost, REMOTE_PROBE_CMD], { timeoutMs });
  const rtt = Date.now() - t0;
  let data = null;
  if (res.exitCode === 0 && res.stdout) {
    try { data = JSON.parse(res.stdout.trim().split('\n').pop()); } catch {}
  }
  return { data, pingMs: data ? Math.min(999, Math.round(rtt / 2)) : null };
}

/** Rebuilds the dedicated MCP reverse-tunnel ControlMaster for one node. Never touches interactive terminals. */
async function healNodeTunnel(node) {
  const sock = nodeTunnelSock(node);
  await runCommand('ssh', ['-S', sock, '-O', 'exit', node.sshHost], { timeoutMs: 2500 });
  await runCommand('pkill', ['-f', sock], { timeoutMs: 1500 });
  try { fs.unlinkSync(sock); } catch {}
  // Free the remote loopback ports in case a stale sshd child still holds them
  await runCommand('ssh', [
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=4',
    node.sshHost,
    `(sudo -n true 2>/dev/null && SUDO="sudo -n" || SUDO=""); $SUDO fuser -k ${PORT}/tcp ${EDA_PORT}/tcp >/dev/null 2>&1 || true`,
  ], { timeoutMs: 6000 });
  await runCommand('ssh', [
    '-M', '-S', sock, '-Nf',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'TCPKeepAlive=yes',
    '-R', `${PORT}:127.0.0.1:${PORT}`,
    '-R', `${EDA_PORT}:127.0.0.1:${EDA_PORT}`,
    node.sshHost,
  ], { timeoutMs: 6000 });
}

async function runSystemWatchdogCycle(forceHeal = false) {
  if (watchdogRunning && !forceHeal) return;
  watchdogRunning = true;
  try {
    const nodes = loadConfiguredNodes().filter((n) => n.enabled && n.sshHost);
    const [edaInfo] = await Promise.all([ensureEasyEdaBridgeDetailed(), checkSyncthingStatus(nodes)]);

    const nodesStatus = {};
    const probeData = {};
    await Promise.all(nodes.map(async (node) => {
      let { data, pingMs } = await probeNode(node);
      const needHeal = forceHeal || !data || !data.mcpOk;
      const sinceHeal = Date.now() - (lastNodeHealAt.get(node.id) || 0);
      if (needHeal && (forceHeal || sinceHeal > 15000)) {
        systemStatusState.healing = true;
        lastNodeHealAt.set(node.id, Date.now());
        await healNodeTunnel(node);
        ({ data, pingMs } = await probeNode(node));
        systemStatusState.healCount += 1;
        systemStatusState.lastHealAt = Date.now();
      }
      probeData[node.id] = data;
      nodesStatus[node.id] = {
        id: node.id,
        sshHost: node.sshHost,
        online: Boolean(data),
        mcpOk: Boolean(data && data.mcpOk),
        edaOk: Boolean(data && data.edaOk),
        egressIp: (data && data.egressIp) || '',
        processCount: Number((data && data.count) || 0),
        pingMs,
        tailscaleOk: Boolean(data && data.tailscaleOk),
        tailscaleIp: (data && data.tailscaleIp) || '',
      };
    }));
    systemStatusState.healing = false;
    systemStatusState.nodesStatus = nodesStatus;

    const onlineIds = Object.keys(nodesStatus).filter((id) => nodesStatus[id].online);
    const first = onlineIds.length ? nodesStatus[onlineIds[0]] : null;
    const firstData = first ? probeData[first.id] : null;
    const anyMcpOk = onlineIds.some((id) => nodesStatus[id].mcpOk);
    const anyEdaOk = onlineIds.some((id) => nodesStatus[id].edaOk);
    const bestPing = onlineIds.length ? Math.min(...onlineIds.map((id) => nodesStatus[id].pingMs || 999)) : null;

    systemStatusState.remoteCli = firstData
      ? {
          online: true,
          processCount: onlineIds.reduce((a, id) => a + nodesStatus[id].processCount, 0),
          uptimeSec: Number(firstData.uptimeSec || 0),
          pids: Array.isArray(firstData.pids) ? firstData.pids : [],
          egressIp: firstData.egressIp || '',
          tailscaleOk: Boolean(firstData.tailscaleOk),
          tailscaleIp: firstData.tailscaleIp || '',
        }
      : { online: false, processCount: 0, uptimeSec: 0, pids: [], egressIp: '' };
    systemStatusState.mcpStatus = {
      ok: anyMcpOk,
      localMcpOk: true,
      remoteTunnelOk: anyMcpOk,
      edaBridgeOk: Boolean(edaInfo.ok && anyEdaOk),
      edaClientConnected: Boolean(edaInfo.edaConnected),
      tools: TOOLS.length,
      pingMs: bestPing,
    };
    if (firstData && firstData.usage) systemStatusState.claudeUsage = firstData.usage;

    systemStatusState.ok = Boolean(onlineIds.length && anyMcpOk);
    systemStatusState.updatedAt = Date.now();
  } catch {
    systemStatusState.healing = false;
  } finally {
    watchdogRunning = false;
  }
}

function startBridgeAndTunnelWatchdog() {
  runSystemWatchdogCycle(false).catch(() => {});
  setInterval(() => {
    runSystemWatchdogCycle(false).catch(() => {});
  }, 5000);
}


