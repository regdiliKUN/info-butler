/**
 * 验证报告生成器：读回桌面/开始菜单 .lnk 的真实目标，判定是否落在本地包体内，
 * 并把结果写成 UTF-8 文本，避免 Git-Bash 控制台代码页把中文显示成乱码。
 * 用法：node scripts/verify-package-targets.js [包体目录]
 * 不带参数时自动定位：开发态为 dist/info-butler-v<版本>-<平台>-<架构>；
 * 被打进包体后（<包体>/scripts/）默认就是包体根目录。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const platTag = (process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'macos' : 'linux') + '-' + process.arch;

/** 包体的特征文件：单文件 EXE / Windows 启动器 / POSIX 启动器 */
function looksLikePackage(dir) {
  return fs.existsSync(path.join(dir, '信息管家.exe'))
    || fs.existsSync(path.join(dir, '启动应用.bat'))
    || fs.existsSync(path.join(dir, 'start.sh'));
}

let defaultPkg;
let installDirCfg = null;
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).config || {};
  if (cfg.packageInstallDir) installDirCfg = path.resolve(cfg.packageInstallDir);
} catch (e) { /* ignore */ }
if (looksLikePackage(ROOT)) {
  defaultPkg = ROOT; // 运行在包体内部：<包体>/scripts/verify-package-targets.js
} else if (installDirCfg && fs.existsSync(installDirCfg)) {
  // 配置了包体落地目录（如 I 盘）且存在：入口实际指向它，以它为校验基准
  defaultPkg = installDirCfg;
} else {
  let version = '0.0.0';
  try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch (e) { /* ignore */ }
  defaultPkg = path.join(ROOT, 'dist', 'info-butler-v' + version + '-' + platTag);
}

const PKG = path.resolve(process.argv[2] || defaultPkg);
const APP = '信息管家';

// 桌面可能被重定向到其他盘符（如 D:\Desktop）或 OneDrive，必须经注册表 /
// known-folder 权威解析；若仍按 %USERPROFILE%\Desktop 猜，会去错误位置读回目标、
// 把实际正确的入口误报为「目标不在包体内」。
const Desktop = require('./lib/desktop');
const desktop = Desktop.resolveDesktop() || path.join(os.homedir(), 'Desktop');
const startMenu = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', APP);

const links = [
  path.join(desktop, APP + '.lnk'),
  path.join(startMenu, APP + '.lnk')
];

// 通过 shortcut.ps1 的读模式拿真实 TargetPath / WorkingDirectory
const outFile = path.join(os.tmpdir(), 'ib-verify-' + process.pid + '.out');
const cfgPath = path.join(os.tmpdir(), 'ib-verify-' + process.pid + '.json');
fs.writeFileSync(cfgPath, '\uFEFF' + JSON.stringify({
  links: links.map((l) => ({ linkPath: l })), read: true, readOut: outFile
}), 'utf8');

const r = cp.spawnSync('powershell', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  path.join(ROOT, 'scripts', 'lib', 'shortcut.ps1'), '-ConfigPath', cfgPath
], { encoding: 'utf8', windowsHide: true });
try { fs.unlinkSync(cfgPath); } catch (e) { /* ignore */ }

// 控制台输出经系统代码页（GBK）会把中文变成乱码，优先读 ps1 写出的 UTF-8 结果文件；
// 同时不按链接路径字符串匹配（路径含中文），而按输出顺序一一对应。
let source = '';
try { source = fs.readFileSync(outFile, 'utf8'); } catch (e) { source = String(r.stdout || ''); }
try { fs.unlinkSync(outFile); } catch (e) { /* ignore */ }
// PS 5.1 的 Set-Content -Encoding UTF8 会写 BOM，去掉以免首行匹配失败
source = source.replace(/^\uFEFF/, '');

const readLines = source.split(/\r?\n/).filter((l) => l.startsWith('READ|'));
const report = [];
let allInside = readLines.length === links.length;

report.push('本地包体目录：' + PKG);
report.push('包体存在：' + (fs.existsSync(PKG) ? '是' : '否'));
report.push('');

// Windows 路径大小写不敏感（COM/文件系统可能改写大小写，如 I:\WorkBuddy 被读回
// I:\workbuddy），前缀判定必须做大小写归一，否则会把正确目标误报为「不在包体内」。
function insidePkg(target) {
  if (!PKG) return true;
  const norm = (s) => s.replace(/\//g, '\\');
  const t = norm(target).toLowerCase();
  const p = norm(PKG).replace(/\\+$/, '').toLowerCase() + '\\';
  return t.startsWith(p);
}

links.forEach((link, i) => {
  const line = readLines[i];
  const exists = fs.existsSync(link);
  if (!line) {
    allInside = false;
    report.push('✗ ' + link + '　存在=' + exists + '　读回失败（PowerShell 退出码 ' + r.status + '）');
    return;
  }
  const bar = line.indexOf('|', 'READ|'.length);
  const target = line.slice(bar + 1);
  const inside = insidePkg(target);
  if (!inside) allInside = false;
  report.push((inside ? '✓ ' : '✗ ') + link);
  report.push('    目标 = ' + target);
  report.push('    目标在包体内：' + (inside ? '是（右键「打开文件所在位置」直达本地包体）' : '否'));
});

report.push('');
report.push(allInside ? '结论：全部入口目标均落在本地包体内，需求达成。' : '结论：存在目标不在包体内的入口，需要修复。');

const out = looksLikePackage(ROOT)
  ? path.join(os.tmpdir(), 'info-butler-TARGET-VERIFY.txt')   // 包体内运行：不往包体写文件
  : path.join(ROOT, 'dist', 'TARGET-VERIFY.txt');
fs.writeFileSync(out, report.join('\n') + '\n', 'utf8');
console.log(report.join('\n'));
console.log('\n报告已写入：' + out);
process.exit(allInside ? 0 : 1);
