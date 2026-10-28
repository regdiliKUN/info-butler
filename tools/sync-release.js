'use strict';
/* ===========================================================
 * tools/sync-release.js —— 把源码与打包产物同步到发布目录
 *
 * 发布目录（默认 I:/workbuddy/info-butler-v1.0.0-win-x64）是"给最终用户看的"，
 * 里面既要有能双击的 exe，也要有可读的源码副本（start.sh 走的是源码路径）。
 * 两边不同步就会出现"exe 是新版、start.sh 是旧版"的诡异问题。
 *
 * 用法：node tools/sync-release.js [目标目录]
 * =========================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = process.argv[2] || process.env.RELEASE_DIR || 'I:/workbuddy/info-butler-v1.0.0-win-x64';

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!fs.existsSync(TARGET)) {
    console.error('  ✗ 发布目录不存在：' + TARGET);
    process.exit(1);
  }

  // 1) 源码副本
  const srcMap = [
    ['src/index.html', 'index.html'],
    ['src/icon.png', 'icon.png'],
    ['src/icon.ico', 'icon.ico'],
    ['src/css/styles.css', 'css/styles.css']
  ];
  for (const name of fs.readdirSync(path.join(ROOT, 'src', 'js'))) {
    srcMap.push(['src/js/' + name, 'js/' + name]);
  }
  let n = 0;
  for (const [from, to] of srcMap) {
    const abs = path.join(ROOT, from);
    if (!fs.existsSync(abs)) continue;
    copyFile(abs, path.join(TARGET, to));
    n++;
  }

  // 2) exe
  const exe = path.join(ROOT, 'dist', '信息管家.exe');
  if (fs.existsSync(exe)) {
    copyFile(exe, path.join(TARGET, '信息管家.exe'));
    n++;
  } else {
    console.warn('  ! 没有找到 dist/信息管家.exe，跳过（先跑 npm run build:exe）');
  }

  // 3) 使用说明里的构建时间
  const readme = path.join(TARGET, '使用说明.txt');
  if (fs.existsSync(readme)) {
    let txt = fs.readFileSync(readme, 'utf8');
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    txt = txt.replace(/版本 v[\d.]+ · 构建 [^\n]*/, '版本 v' + pkg.version + ' · 构建 ' + stamp);
    txt = txt.replace(/构建时间：[^\n]*/, '构建时间：' + stamp);
    fs.writeFileSync(readme, txt, 'utf8');
  }

  console.log('  ✓ 已同步 ' + n + ' 个文件到 ' + TARGET);
}

main();
