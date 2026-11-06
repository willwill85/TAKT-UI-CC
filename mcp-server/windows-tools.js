'use strict';
const fs = require('node:fs');
const path = require('node:path');
const platform = require('../lib/platform');
const cfg = require('../config');
const { psQuote: q, psArgs } = platform;

function installed(root, prefix, suffix) {
  try { return fs.readdirSync(root).filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase())).sort().reverse().map((n) => path.join(root, n, suffix)); } catch { return []; }
}
function paths() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const local = process.env.LOCALAPPDATA || path.join(cfg.HOME, 'AppData/Local');
  const find = platform.findProgram;
  return {
    blenderBin: find('TAKT_BLENDER_BIN', installed(path.join(pf, 'Blender Foundation'), 'Blender', 'blender.exe'), 'blender.exe'),
    freecadCmd: find('TAKT_FREECAD_CMD', installed(pf, 'FreeCAD', 'bin/FreeCADCmd.exe'), 'FreeCADCmd.exe'),
    freecadApp: find('TAKT_FREECAD_GUI', installed(pf, 'FreeCAD', 'bin/FreeCAD.exe'), 'FreeCAD.exe'),
    jlcedaApp: find('TAKT_EASYEDA_EXE', [path.join(local, 'Programs/EasyEDA Pro/EasyEDA Pro.exe'), path.join(pf, '嘉立创EDA专业版/嘉立创EDA专业版.exe')], ''),
    chromeBin: find('TAKT_CHROME_BIN', [path.join(pf, 'Google/Chrome/Application/chrome.exe'), path.join(local, 'Google/Chrome/Application/chrome.exe'), path.join(process.env['ProgramFiles(x86)'] || pf, 'Microsoft/Edge/Application/msedge.exe')], 'msedge.exe'),
    jlinkExe: find('TAKT_JLINK_EXE', installed(path.join(pf, 'SEGGER'), 'JLink', 'JLink.exe'), 'JLink.exe'),
    dfuUtil: process.env.TAKT_DFU_UTIL || 'dfu-util.exe',
  };
}

function describe(tools) {
  const descriptions = {
    freecad_run_python: '在本机 Windows FreeCADCmd 中执行 Python 参数化建模，生成 FCStd、STEP 或 STL 到同步工作目录。',
    mac_host_exec: '在本机 Windows 上运行 PowerShell 命令；使用 PowerShell 语法，支持 cwd 与 timeout_sec，默认由 Claude 询问执行权限。',
    usb_list_devices_and_ports: '枚举本机 Windows 的 USB 设备与 COM 串口，返回设备名称、标识及状态。',
    usb_serial_monitor: '使用 Windows COM 串口读取指定时长的输出，可先发送一行文本；不依赖 Python。',
    mac_screen_capture: '截取本机 Windows 桌面或 x,y,width,height 区域，保存 PNG 到当前节点镜像并可返回内联图片。',
    hardware_flash_firmware: '通过本机 Windows esptool、ESP-IDF export.ps1、J-Link 或 dfu-util 操作设备；需安装相应工具与驱动并指定实际端口和固件。',
  };
  return tools.filter((t) => !t.name.startsWith('xcode_')).map((t) => {
    const tool = { ...t, description: descriptions[t.name] || t.description.replaceAll('Mac', 'Windows').replaceAll('macOS', 'Windows 11').replaceAll('Metal', 'GPU') };
    if (t.inputSchema?.properties?.port) tool.inputSchema = { ...t.inputSchema, properties: { ...t.inputSchema.properties, port: { type: 'string', description: 'Windows 串口，例如 COM3 或 COM10' } } };
    return tool;
  });
}

async function execute(name, args, context) {
  const { runCommand: run, resolveWorkPath: resolve, rewriteScriptPaths: rewrite, node, paths: binaries } = context;
  const root = node?.localWorkDir || cfg.DEFAULT_WORK_DIR;
  const done = (output) => ({ handled: true, output });
  async function checked(command, argv, options) {
    const result = await run(command, argv, options);
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`Windows 工具执行失败 (${result.exitCode}): ${result.stderr || result.stdout}`);
    return result;
  }
  const ps = (script, options) => checked(platform.powershell, psArgs(script), options);
  switch (name) {
    case 'xcode_list_devices': case 'xcode_build_and_deploy_iphone':
      throw new Error('Xcode 与 iPhone 本机构建仅支持 macOS，Windows 不提供此工具。');
    case 'blender_open_gui': case 'freecad_open_gui': case 'jlceda_open_gui': {
      const executable = name === 'blender_open_gui' ? binaries.blenderBin : name === 'freecad_open_gui' ? binaries.freecadApp : binaries.jlcedaApp;
      if (!executable) throw new Error('请通过 TAKT_EASYEDA_EXE 配置嘉立创EDA Windows 程序路径');
      const target = args.file_path ? resolve(args.file_path) : '';
      await ps(`Start-Process -FilePath ${q(executable)}${target ? ` -ArgumentList ('"' + ${q(target)} + '"')` : ''}`);
      return done(`已启动本机应用${target ? ': ' + target : ''}`);
    }
    case 'mac_browser_open_url': {
      const url = new URL(args.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许打开 HTTP/HTTPS 地址');
      await ps(`Start-Process -FilePath ${q(url.href)}`);
      return done('已打开浏览器: ' + url.href);
    }
    case 'usb_list_devices_and_ports': {
      const result = await ps(`@{ ports = @(Get-CimInstance Win32_SerialPort | Select-Object DeviceID,Name,Description); usb = @(Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like 'USB*' } | Select-Object Name,PNPDeviceID,Status) } | ConvertTo-Json -Depth 5 -Compress`, { timeoutMs: 20000 });
      return done(result.stdout);
    }
    case 'usb_serial_monitor': {
      if (!/^COM\d+$/i.test(args.port || '')) throw new Error('Windows 串口格式应为 COM3、COM10 等');
      const baud = Number(args.baudrate || 115200);
      const duration = Math.min(30, Math.max(1, Number(args.read_duration_sec || 3)));
      if (!Number.isInteger(baud) || baud < 1 || !Number.isFinite(duration)) throw new Error('无效波特率或读取时长');
      const result = await ps(`$port = [IO.Ports.SerialPort]::new(${q(args.port)}, ${baud}); $port.ReadTimeout = 200; try { $port.Open(); ${args.send_data ? `$port.WriteLine(${q(args.send_data)});` : ''} $until = [DateTime]::UtcNow.AddSeconds(${duration}); while ([DateTime]::UtcNow -lt $until) { $text = $port.ReadExisting(); if ($text) { [Console]::Write($text) }; Start-Sleep -Milliseconds 50 } } finally { $port.Dispose() }`, { timeoutMs: (duration + 10) * 1000 });
      return done(`串口 ${args.port} (@${baud}bps):\n${result.stdout}`);
    }
    case 'mac_host_exec': {
      const cwd = args.cwd ? resolve(args.cwd) : root;
      const timeoutMs = Math.min(600000, Math.max(5000, Number(args.timeout_sec || 120) * 1000));
      const result = await checked(platform.powershell, psArgs(rewrite(args.command)), { cwd, timeoutMs });
      return done(`Windows PowerShell (cwd=${cwd}):\n${result.stdout.slice(-6000)}\n${result.stderr.slice(-3000)}`);
    }
    case 'mac_screen_capture': {
      const shots = path.join(root, 'screenshots');
      await fs.promises.mkdir(shots, { recursive: true });
      const name = path.parse(path.basename(args.output_filename || `screen_${Date.now()}.png`)).name + '.png';
      const output = path.join(shots, name);
      const region = args.region ? String(args.region).split(',').map(Number) : null;
      if (region && (region.length !== 4 || region.some((n) => !Number.isFinite(n)) || region[2] <= 0 || region[3] <= 0)) throw new Error('region 应为 x,y,width,height');
      const max = Number(args.max_dimension_px ?? 1600);
      if (!Number.isFinite(max) || max < 0) throw new Error('无效截图尺寸');
      const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ` +
        (args.activate_app ? `$shell = New-Object -ComObject WScript.Shell; [void]$shell.AppActivate(${q(args.activate_app)}); Start-Sleep -Milliseconds 500; ` : '') +
        `$r = ${region ? `[Drawing.Rectangle]::new(${region.join(',')})` : '[Windows.Forms.SystemInformation]::VirtualScreen'}; $bitmap = [Drawing.Bitmap]::new($r.Width,$r.Height); $g = [Drawing.Graphics]::FromImage($bitmap); try { $g.CopyFromScreen($r.Location,[Drawing.Point]::Empty,$r.Size); ` +
        `if (${max} -gt 0 -and [Math]::Max($r.Width,$r.Height) -gt ${max}) { $scale = ${max}/[double][Math]::Max($r.Width,$r.Height); $small = [Drawing.Bitmap]::new($bitmap,[Drawing.Size]::new([Math]::Max(1,[int]($r.Width*$scale)),[Math]::Max(1,[int]($r.Height*$scale)))); try { $small.Save(${q(output)},[Drawing.Imaging.ImageFormat]::Png) } finally { $small.Dispose() } } else { $bitmap.Save(${q(output)},[Drawing.Imaging.ImageFormat]::Png) } } finally { $g.Dispose(); $bitmap.Dispose() }`;
      await ps(script, { timeoutMs: 15000 });
      const summary = `Windows 截图: ${output}\n远端同步路径: ${(node?.remoteWorkDir || '/root/work').replace(/\/+$/, '')}/screenshots/${name}`;
      return done(args.return_inline_image === false ? summary : { __mcp_content: [
        { type: 'text', text: summary }, { type: 'image', data: (await fs.promises.readFile(output)).toString('base64'), mimeType: 'image/png' },
      ] });
    }
    case 'hardware_flash_firmware': {
      const firmware = args.firmware_path ? resolve(args.firmware_path) : '';
      const python = process.env.TAKT_PYTHON || 'python.exe';
      const extra = Array.isArray(args.extra_args) ? args.extra_args.map(String) : [];
      let result;
      if (args.flasher === 'esptool') {
        if (!args.port || !firmware) throw new Error('请指定 port (如 COM3) 和 firmware_path');
        result = await checked(python, ['-m', 'esptool', '--chip', args.chip || 'auto', '--port', args.port, 'write_flash', args.flash_address || '0x0', firmware, ...extra], { timeoutMs: 120000 });
      } else if (args.flasher === 'idf_py') {
        if (!cfg.IDF_EXPORT_PS1 || !fs.existsSync(cfg.IDF_EXPORT_PS1)) throw new Error('请配置 TAKT_IDF_EXPORT_PS1，指向 ESP-IDF 的 export.ps1');
        const idf = `Join-Path $env:IDF_PATH 'tools/idf.py'`;
        result = await ps(`. ${q(cfg.IDF_EXPORT_PS1)}; & ${q(python)} (${idf}) ${args.port ? '-p ' + q(args.port) : ''} build flash; if ($LASTEXITCODE) { exit $LASTEXITCODE }`, { cwd: firmware || root, timeoutMs: 300000 });
      } else if (args.flasher === 'dfu') {
        result = await checked(binaries.dfuUtil, ['-a', '0', '-D', firmware, ...extra], { timeoutMs: 60000 });
      } else if (args.flasher === 'jlink') {
        if (!firmware || /[\r\n"]/.test(firmware) || !/^0x[\da-f]+$/i.test(args.flash_address || '0x08000000')) throw new Error('无效固件路径或烧录地址');
        const script = path.join(root, `_jlink_${Date.now()}.jlink`);
        await fs.promises.writeFile(script, `r\nh\nloadfile "${firmware}"${firmware.endsWith('.bin') ? ' ' + (args.flash_address || '0x08000000') : ''}\nr\ng\nq\n`);
        try { result = await checked(binaries.jlinkExe, ['-device', args.chip || 'STM32F103RC', '-if', 'SWD', '-speed', '4000', '-autoconnect', '1', '-CommandFile', script], { timeoutMs: 60000 }); }
        finally { await fs.promises.unlink(script).catch(() => {}); }
      } else throw new Error('未知烧录器: ' + args.flasher);
      return done(`烧录工具执行完成:\n${result.stdout.slice(-6000)}\n${result.stderr.slice(-2000)}`);
    }
    default: return { handled: false };
  }
}
module.exports = { paths, describe, execute };
