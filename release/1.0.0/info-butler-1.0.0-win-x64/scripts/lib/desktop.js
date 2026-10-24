'use strict';
/**
 * 桌面目录解析（Windows 专用；其他平台返回 null，由调用方走各自逻辑）。
 *
 * 为什么需要它：桌面可能被重定向到其他盘符（例如 D:\Desktop）或 OneDrive 目录，
 * 只按 %USERPROFILE%\Desktop 猜测会把快捷方式建到用户根本看不到的位置。
 * 因此优先通过 PowerShell 调用 SHGetKnownFolderPath（GetFolderPath）与注册表
 * User Shell Folders 解析真实桌面；中文路径经 UTF-8 文件回传、不经控制台，
 * 规避 PS 5.1 代码页乱码。PowerShell 不可用时回退到常见候选目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const PS1 = path.join(__dirname, 'resolve-desktop.ps1');

/** 常见桌面候选目录（解析失败时的回退，也用于识别历史残留位置） */
function candidates() {
  const h = os.homedir();
  return [
    path.join(h, 'Desktop'),
    path.join(h, 'OneDrive', 'Desktop'),
    path.join(h, 'OneDrive - 个人', 'Desktop'),
    path.join(h, '桌面')
  ];
}

let cached = null;

/** 当前真实的桌面目录（Windows）；非 Windows 平台返回 null */
function resolveDesktop() {
  if (process.platform !== 'win32') return null;
  if (cached) return cached;

  // 1) PowerShell：权威解析（尊重注册表重定向；结果写 UTF-8 文件，绕开代码页问题）
  try {
    const out = path.join(os.tmpdir(), 'ib-desktop-' + process.pid + '.txt');
    const r = cp.spawnSync('powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-OutFile', out],
      { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && fs.existsSync(out)) {
      const dir = fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, '').trim();
      try { fs.unlinkSync(out); } catch (e) { /* ignore */ }
      if (dir && fs.existsSync(dir)) { cached = dir; return dir; }
    }
  } catch (e) { /* PowerShell 缺失等情况，回退候选目录 */ }

  // 2) 候选目录回退。注意：走到这里说明权威解析失败（ps1 解析错误 / PowerShell
  //    不可用 / 解析出的目录不存在），桌面被重定向到其他盘符时会被漏掉，
  //    因此必须留痕，不能静默回退。
  for (const c of candidates()) if (fs.existsSync(c)) { cached = c; return c; }
  cached = candidates()[0];
  console.error('[desktop] 未能经 PowerShell/注册表解析真实桌面，已回退到候选目录：' + cached);
  return cached;
}

/**
 * 所有可能的桌面位置（当前桌面 + 历史候选位置，去重，仅返回真实存在的）。
 * 桌面被重定向后，旧位置的快捷方式用户已看不到，属于应清理的残留。
 */
function allDesktopDirs() {
  const found = [];
  const resolved = resolveDesktop();
  if (resolved && fs.existsSync(resolved)) found.push(resolved);
  for (const c of candidates()) {
    if (fs.existsSync(c) && found.indexOf(c) < 0) found.push(c);
  }
  return found;
}

module.exports = { resolveDesktop, allDesktopDirs, candidates };
