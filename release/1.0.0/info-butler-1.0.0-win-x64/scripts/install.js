#!/usr/bin/env node
'use strict';
/* ===========================================================
 * install.js —— 桌面 / 应用入口安装（快捷方式）
 *
 *   node scripts/install.js              创建
 *   node scripts/install.js --verify     校验是否已存在
 *   node scripts/install.js --uninstall  移除
 *
 * 各平台实现差异：
 *   Windows : 通过 PowerShell + WScript.Shell COM 生成 .lnk（桌面 + 开始菜单目录），
 *             在线版入口用 .url（InternetShortcut，纯文本）。
 *             路径经 UTF-8 JSON 配置文件传递，避免命令行代码页导致中文路径乱码。
 *   macOS   : 生成标准 .app 束（Contents/Info.plist + Contents/MacOS/launcher）
 *             到 /Applications（无权限时自动回退到 ~/Applications），
 *             桌面放一个可直接双击的 .command 脚本。在线版用 .webloc。
 *   Linux   : 遵循 XDG 规范写 ~/.local/share/applications/*.desktop，
 *             并复制到 ~/Desktop（存在时）并赋予可执行权限；
 *             freedesktop 要求 .desktop 必须可执行，否则会显示为不可信。
 * =========================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const Desktop = require('./lib/desktop');

const ROOT = path.resolve(__dirname, '..');
// package.json 携带 appName/onlineUrl 等配置；包体内默认会随包分发，
// 若被剥离则回退到默认值，保证「包体自建快捷方式」始终可用。
let pkg = { version: '0.0.0', config: {} };
try {
  pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
} catch (e) {
  console.log('提示：未找到 package.json，使用默认配置（应用名：信息管家）');
}
const cfg = pkg.config || {};

const argv = process.argv.slice(2);
const MODE = argv.includes('--uninstall') ? 'uninstall'
  : argv.includes('--verify') ? 'verify'
    : 'install';
const FROM_BUILD = argv.includes('--from-build');
// 本地包体目录：从包体内（或构建时）调用时传入，使快捷方式目标落在包体内部，
// 从而右键「打开文件所在位置」能直达本地包体。
const PKG_IDX = argv.indexOf('--package');
const PKG_DIR = PKG_IDX >= 0 && argv[PKG_IDX + 1] ? path.resolve(argv[PKG_IDX + 1]) : null;
const READ_TARGETS = argv.includes('--read-targets');

const APP_NAME = cfg.appName || '信息管家';
const ONLINE_URL = cfg.onlineUrl || '';
const PORT = cfg.port || 4173;

/* ---------------- 目标路径规划 ---------------- */

function home() { return os.homedir(); }

/**
 * Windows 真实桌面目录。桌面可能被重定向到其他盘符（如 D:\Desktop）或
 * OneDrive，直接猜 %USERPROFILE%\Desktop 会把快捷方式建到用户看不到的位置，
 * 因此交给 lib/desktop.js 经 PowerShell + 注册表权威解析。
 */
function windowsDesktop() {
  return Desktop.resolveDesktop() || path.join(home(), 'Desktop');
}

function linuxDesktop() {
  const candidates = [path.join(home(), 'Desktop'), path.join(home(), '桌面')];
  // 优先读取 XDG 规范里的桌面目录（部分发行版/中文环境用它）
  const ud = path.join(home(), '.config', 'user-dirs.dirs');
  try {
    const txt = fs.readFileSync(ud, 'utf8');
    const m = txt.match(/XDG_DESKTOP_DIR="?([^"\n]+)"?/);
    if (m) {
      const dir = m[1].replace(/\$HOME/g, home()).replace(/^~/, home());
      if (fs.existsSync(dir)) candidates.unshift(dir);
    }
  } catch (e) { /* 文件不存在时忽略 */ }
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function targets() {
  const platform = process.platform;
  const out = { dirs: [], links: [], files: [], removeDirs: [] };

  if (platform === 'win32') {
    const startMenu = path.join(process.env.APPDATA || path.join(home(), 'AppData', 'Roaming'),
      'Microsoft', 'Windows', 'Start Menu', 'Programs', APP_NAME);
    const desktop = windowsDesktop();
    // 包体模式：优先指向包体内的单文件「信息管家.exe」，其次退回旧的「启动应用.bat」
    const inPkg = !!PKG_DIR;
    const exePath = inPkg ? path.join(PKG_DIR, '信息管家.exe') : '';
    const hasExe = !!exePath && fs.existsSync(exePath);
    const launchTarget = inPkg
      ? (hasExe ? exePath : path.join(PKG_DIR, '启动应用.bat'))
      : (process.env.COMSPEC || 'cmd.exe');
    const launchArgs = inPkg ? '' : '/c "' + path.join(ROOT, 'scripts', 'start.cmd') + '"';
    const launchWork = inPkg ? PKG_DIR : ROOT;
    // 应用图标：单文件版直接取 exe 内嵌图标，否则用包体内 / 项目 assets 下的 icon.ico
    const iconCandidate = inPkg
      ? (hasExe ? exePath : path.join(PKG_DIR, 'icon.ico'))
      : path.join(ROOT, 'assets', 'icon.ico');
    const icon = fs.existsSync(iconCandidate) ? iconCandidate : 'imageres.dll,3';
    // 单文件版常驻控制台窗口（关闭即停止服务），旧 bat 启动器沿用最小化
    const winStyle = hasExe ? 1 : 7;

    out.dirs.push(startMenu);
    out.links.push({
      linkPath: path.join(desktop, APP_NAME + '.lnk'),
      target: launchTarget,
      args: launchArgs,
      workDir: launchWork,
      icon: icon,
      windowStyle: winStyle,
      description: APP_NAME + ' · 本地启动'
    });
    out.links.push({
      linkPath: path.join(startMenu, APP_NAME + '.lnk'),
      target: launchTarget,
      args: launchArgs,
      workDir: launchWork,
      icon: icon,
      windowStyle: winStyle,
      description: APP_NAME + ' · 本地启动'
    });
    out.urlFiles = [{
      path: path.join(startMenu, APP_NAME + '（在线版）.url'),
      url: ONLINE_URL
    }];
    out.removeDirs.push(startMenu);
    out.removeFiles = [
      path.join(desktop, APP_NAME + '.lnk'),
      path.join(startMenu, APP_NAME + '.lnk'),
      path.join(startMenu, APP_NAME + '（在线版）.url')
    ];
    out.verifyList = out.removeFiles.slice();
    // 桌面重定向前的历史位置（如桌面从 C: 搬到 D: 后，旧位置的入口用户已看不到）：
    // 加入清理清单，安装 / 卸载时一并移除，避免残留失效入口。
    out.cleanupFiles = Desktop.allDesktopDirs()
      .filter((d) => d !== desktop)
      .map((d) => path.join(d, APP_NAME + '.lnk'));
  } else if (platform === 'darwin') {
    const appsDir = fs.existsSync('/Applications') && canWrite('/Applications')
      ? '/Applications'
      : path.join(home(), 'Applications');
    const appBundle = path.join(appsDir, APP_NAME + '.app');
    const desktopCmd = path.join(home(), 'Desktop', APP_NAME + '.command');
    const webloc = path.join(home(), 'Desktop', APP_NAME + '（在线版）.webloc');
    const launchBase = PKG_DIR || ROOT;
    const launchPath = posixLaunch(launchBase);

    out.dirs.push(path.join(appBundle, 'Contents', 'MacOS'), path.join(home(), 'Desktop'));
    out.files.push({ path: path.join(appBundle, 'Contents', 'MacOS', 'launcher'), data: launcherScript(launchPath), mode: 0o755 });
    out.files.push({ path: path.join(appBundle, 'Contents', 'Info.plist'), data: infoPlist(), mode: 0o644 });
    out.files.push({ path: desktopCmd, data: launcherScript(launchPath), mode: 0o755 });
    if (ONLINE_URL) out.files.push({ path: webloc, data: weblocPlist(), mode: 0o644 });
    out.removeDirs.push(appBundle);
    out.removeFiles = [desktopCmd, webloc];
    out.verifyList = [path.join(appBundle, 'Contents', 'MacOS', 'launcher'), desktopCmd];
  } else {
    const appsDir = path.join(home(), '.local', 'share', 'applications');
    const desktop = linuxDesktop();
    const mainDesktop = path.join(appsDir, (cfg.appId || 'info-butler') + '.desktop');
    const onlineDesktop = path.join(appsDir, (cfg.appId || 'info-butler') + '-online.desktop');

    const launchBase = PKG_DIR || ROOT;
    const launchPath = posixLaunch(launchBase);
    out.dirs.push(appsDir);
    out.files.push({ path: mainDesktop, data: desktopEntry(APP_NAME, '"' + launchPath + '"', launchBase), mode: 0o755 });
    if (ONLINE_URL) {
      out.files.push({
        path: onlineDesktop,
        data: desktopEntry(APP_NAME + '（在线版）', 'xdg-open "' + ONLINE_URL + '"', launchBase),
        mode: 0o755
      });
    }
    if (desktop) {
      out.files.push({ path: path.join(desktop, (cfg.appId || 'info-butler') + '.desktop'), data: desktopEntry(APP_NAME, '"' + launchPath + '"', launchBase), mode: 0o755 });
    }
    out.removeFiles = [mainDesktop, onlineDesktop].concat(desktop ? [path.join(desktop, (cfg.appId || 'info-butler') + '.desktop')] : []);
    out.verifyList = [mainDesktop];
  }

  return out;
}

function canWrite(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 尽力删除文件。直接 unlink 失败时（文件被占用、或 ACL/安全策略限制删除），
 * 在 Windows 上再尝试经 PowerShell 把文件移出目标目录后再删——
 * 「改名让位」所需权限低于「删除」，是受限环境下唯一可靠的清理手段。
 */
function tryUnlink(f) {
  try { fs.unlinkSync(f); return true; } catch (e) { /* 换用其他手段 */ }
  if (process.platform !== 'win32') return false;
  try {
    const tmp = path.join(os.tmpdir(), 'ib-stale-' + process.pid + '-' + path.basename(f));
    const r = cp.spawnSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      'try { [System.IO.File]::Move($env:IB_SRC, $env:IB_DST); [System.IO.File]::Delete($env:IB_DST) } catch { }'
    ], {
      encoding: 'utf8', windowsHide: true,
      env: Object.assign({}, process.env, { IB_SRC: f, IB_DST: tmp })
    });
    return r.status === 0 && !fs.existsSync(f);
  } catch (e) {
    return false;
  }
}

/* ---------------- 各平台文件内容 ---------------- */

/** 选择包体内启动器：优先用包体根目录的 start.sh，否则退回 scripts/start.sh（开发态） */
function posixLaunch(base) {
  const atRoot = path.join(base, 'start.sh');
  return fs.existsSync(atRoot) ? atRoot : path.join(base, 'scripts', 'start.sh');
}

function launcherScript(launchPath) {
  return [
    '#!/bin/bash',
    '# ' + APP_NAME + ' launcher (generated, do not edit)',
    'exec bash "' + launchPath + '"',
    ''
  ].join('\n');
}

function infoPlist() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>CFBundleName</key><string>' + APP_NAME + '</string>',
    '  <key>CFBundleDisplayName</key><string>' + APP_NAME + '</string>',
    '  <key>CFBundleIdentifier</key><string>local.' + (cfg.appId || 'info-butler') + '</string>',
    '  <key>CFBundleVersion</key><string>' + pkg.version + '</string>',
    '  <key>CFBundleExecutable</key><string>launcher</string>',
    '  <key>CFBundlePackageType</key><string>APPL</string>',
    '  <key>LSUIElement</key><false/>',
    '</dict>',
    '</plist>',
    ''
  ].join('\n');
}

function weblocPlist() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict><key>URL</key><string>' + ONLINE_URL + '</string></dict>',
    '</plist>',
    ''
  ].join('\n');
}

function desktopEntry(name, exec, workDir) {
  return [
    '[Desktop Entry]',
    'Version=1.0',
    'Type=Application',
    'Name=' + name,
    'Comment=' + APP_NAME + ' · 个人信息管家 Agent',
    'Exec=' + exec,
    'Path=' + workDir,
    'Terminal=false',
    'Categories=Utility;Productivity;',
    'Keywords=info;butler;notes;todo;',
    ''
  ].join('\n');
}

/* ---------------- Windows：PowerShell ---------------- */

function runWindows(plan) {
  const config = {
    dirs: plan.dirs,
    links: plan.links.map((l) => ({
      linkPath: l.linkPath, target: l.target, args: l.args,
      workDir: l.workDir, icon: l.icon, windowStyle: l.windowStyle, description: l.description
    })),
    urlFiles: plan.urlFiles || [],
    remove: MODE === 'uninstall'
      ? (plan.removeFiles || []).concat(plan.cleanupFiles || []).concat(plan.removeDirs || [])
      : []
  };

  const tmpFile = path.join(os.tmpdir(), 'info-butler-shortcut-' + process.pid + '.json');
  fs.writeFileSync(tmpFile, '\uFEFF' + JSON.stringify(config, null, 2), 'utf8');

  const ps1 = path.join(__dirname, 'lib', 'shortcut.ps1');
  const r = cp.spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-ConfigPath', tmpFile
  ], { encoding: 'utf8', windowsHide: true });

  try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }

  if (r.stdout) console.log(r.stdout.trim());
  if (r.stderr) console.log(String(r.stderr).trim());
  if (r.error) {
    console.log('✗ 无法调用 PowerShell：' + r.error.message);
    return false;
  }
  if (r.status !== 0) {
    console.log('✗ PowerShell 返回码 ' + r.status);
    return false;
  }
  return true;
}

/* ---------------- macOS / Linux：直接写文件 ---------------- */

function runPosix(plan) {
  if (MODE === 'uninstall') {
    (plan.removeFiles || []).concat(plan.cleanupFiles || []).forEach((f) => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    (plan.removeDirs || []).forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { } });
    return true;
  }
  (plan.dirs || []).forEach((d) => fs.mkdirSync(d, { recursive: true }));
  (plan.files || []).forEach((f) => {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, f.data, 'utf8');
    try { fs.chmodSync(f.path, f.mode); } catch (e) { /* ignore */ }
  });
  return true;
}

function readTargets() {
  const plan = targets();
  // Windows 路径大小写不敏感（COM 可能改写大小写），前缀判定做大小写归一
  const insidePkg = (target) => {
    if (!PKG_DIR) return true;
    const norm = (s) => String(s).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() + '\\';
    return norm(target).startsWith(norm(PKG_DIR));
  };
  if (process.platform !== 'win32') {
    // 非 Windows：按构造出的目标路径校验是否在包体内
    let ok = true;
    (plan.links || []).forEach((l) => {
      const inside = insidePkg(l.target);
      console.log('  ' + (inside ? '✓' : '✗') + ' ' + l.linkPath + ' -> ' + l.target +
        (inside ? '（目标在包体内）' : '（警告：目标不在包体内）'));
      if (!inside) ok = false;
    });
    return ok;
  }
  // Windows：用 PowerShell 读回 .lnk 真实 TargetPath 校验
  const outFile = path.join(os.tmpdir(), 'info-butler-read-' + process.pid + '.out');
  const config = { links: plan.links.map((l) => ({ linkPath: l.linkPath })), read: true, readOut: outFile };
  const tmpFile = path.join(os.tmpdir(), 'info-butler-read-' + process.pid + '.json');
  fs.writeFileSync(tmpFile, '﻿' + JSON.stringify(config), 'utf8');
  const ps1 = path.join(__dirname, 'lib', 'shortcut.ps1');
  const r = cp.spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-ConfigPath', tmpFile], { encoding: 'utf8', windowsHide: true });
  try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
  // 优先读 UTF-8 结果文件（控制台输出经系统代码页会把中文变成乱码），失败再退回解析 stdout
  let source = '';
  try { source = fs.readFileSync(outFile, 'utf8'); } catch (e) { source = String(r.stdout || ''); }
  try { fs.unlinkSync(outFile); } catch (e) { /* ignore */ }
  // PS 5.1 的 Set-Content -Encoding UTF8 会写 BOM，去掉以免首行匹配失败
  source = source.replace(/^\uFEFF/, '');
  let ok = true;
  const iconMap = {};
  if (source) {
    // PowerShell 控制台输出为 CRLF，用 /\r?\n/ 切分避免行尾 \r 破坏正则匹配
    source.split(/\r?\n/).forEach((line) => {
      let m = line.match(/^READICON\|(.+?)\|(.*)$/);
      if (m) { iconMap[m[1]] = m[2]; return; }
      m = line.match(/^READ\|(.+?)\|(.+)$/);
      if (!m) return;
      const link = m[1], target = m[2];
      const inside = insidePkg(target);
      console.log('  ' + (inside ? '✓' : '✗') + ' ' + link + ' => ' + target +
        (inside ? '（目标在包体内，右键「打开文件所在位置」直达本地包体）' : '（警告：目标不在包体内）'));
      if (!inside) ok = false;
    });
    // 图标校验：IconLocation 应指向真实存在的 .ico
    (plan.links || []).forEach((l) => {
      const ic = (iconMap[l.linkPath] || '').trim();
      const iconPath = ic.split(',')[0];
      if (!iconPath || iconPath.toLowerCase().endsWith('.dll') || iconPath.toLowerCase().endsWith('.exe')) {
        console.log('  ! ' + l.linkPath + ' 图标为系统默认（' + (ic || '空') + '），未使用应用图标 icon.ico');
        return;
      }
      if (!fs.existsSync(iconPath)) {
        console.log('  ✗ ' + l.linkPath + ' 图标文件不存在：' + iconPath);
        ok = false;
      } else {
        console.log('  ✓ ' + l.linkPath + ' 应用图标：' + iconPath);
      }
    });
  }
  if (r.status !== 0) { console.log('✗ PowerShell 读回失败'); ok = false; }
  return ok;
}

/* ---------------- 主流程 ---------------- */

function main() {
  const platform = process.platform;
  const label = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[platform] || platform;

  if (READ_TARGETS) { process.exit(readTargets() ? 0 : 1); }

  if (!FROM_BUILD) {
    console.log('平台：' + label + '　应用：' + APP_NAME + '　模式：' +
      ({ install: '创建入口', verify: '校验入口', uninstall: '移除入口' }[MODE]));
    console.log('项目根目录：' + ROOT);
    if (MODE === 'install') console.log('本地服务端口：' + PORT + '　在线版：' + (ONLINE_URL || '未配置'));
  }

  const plan = targets();

  // 安装前先清理已存在的旧入口（上一构建生成的 .lnk 可能被 Explorer 占用，
  // 直接覆盖 CreateShortcut 会报「无法创建数据链接格式」），删除后由下方步骤重建。
  if (MODE === 'install') {
    (plan.removeFiles || []).forEach((f) => { try { fs.unlinkSync(f); } catch (e) { /* 可能被占用，交给下方重试 */ } });
    // 清理历史桌面位置上的残留入口（桌面重定向后旧位置的 .lnk 用户已不可见）
    (plan.cleanupFiles || []).forEach((f) => {
      if (!fs.existsSync(f)) return;
      if (tryUnlink(f)) console.log('  ✓ 清理历史位置残留：' + f);
      else console.log('  ! 历史位置残留清理失败，可手动删除：' + f);
    });
  }

  let ok = true;
  if (MODE === 'verify') {
    // 校验模式是只读的：只由下方文件系统复核入口是否存在，不重复创建。
    // 重复创建会去覆盖已被 Explorer 占用的 .lnk，触发「无法创建数据链接格式」失败。
  } else if (platform === 'win32') {
    ok = runWindows(plan);
  } else if (platform === 'darwin' || platform === 'linux') {
    ok = runPosix(plan);
  } else {
    console.log('✗ 暂不支持的平台：' + platform);
    process.exit(1);
  }

  if (MODE === 'uninstall') {
    console.log(ok ? '✓ 已移除桌面 / 应用目录入口' : '✗ 移除过程中出现失败');
    process.exit(ok ? 0 : 1);
  }

  if (MODE === 'install' && platform === 'linux') {
    try {
      cp.spawnSync('update-desktop-database', [path.join(home(), '.local', 'share', 'applications')], { stdio: 'ignore' });
    } catch (e) { /* 命令不存在时忽略 */ }
  }

  // 统一用文件系统复核，不信任子进程的输出
  const list = plan.verifyList || [];
  let pass = 0;
  list.forEach((p) => {
    const exists = fs.existsSync(p);
    if (exists) pass++;
    console.log('  ' + (exists ? '✓' : '✗') + ' ' + p);
  });
  const allOk = ok && pass === list.length && list.length > 0;

  if (MODE === 'verify') {
    console.log(allOk ? '\n✓ 入口校验通过（' + pass + '/' + list.length + '）' : '\n✗ 入口校验未通过（' + pass + '/' + list.length + '）');
  } else {
    console.log(allOk ? '\n✓ 入口创建完成（' + pass + '/' + list.length + '）' : '\n✗ 入口未全部创建（' + pass + '/' + list.length + '）');
    if (platform === 'darwin' && allOk) {
      console.log('  提示：macOS 未签名应用首次打开需右键 → 打开，或在「系统设置 → 隐私与安全性」中允许。');
    }
    if (platform === 'linux' && allOk) {
      console.log('  提示：部分桌面环境需右键桌面图标选择「允许启动」。');
    }
  }
  process.exit(allOk ? 0 : 1);
}

main();
