'use strict';
/* ===========================================================
 * tools/build-exe.js —— 把 src/ 打包成单文件可执行程序
 *
 * 流程：内联资源 → 生成 SEA blob → 复制 node 宿主 → postject 注入 blob
 * 依赖：Node 22+（自带 SEA）、devDependency: postject
 * 用法：npm run build:exe [-- --keep-temp]
 * 产物：dist/信息管家.exe
 * =========================================================== */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const EXE_NAME = '信息管家.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};
const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.json', '.svg', '.txt', '.md']);

function walk(dir, base = '') {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ rel, full });
  }
  return out;
}

function collectAssets() {
  const assets = {};
  let bytes = 0;
  for (const f of walk(SRC)) {
    const ext = path.extname(f.full).toLowerCase();
    const raw = fs.readFileSync(f.full);
    bytes += raw.length;
    const type = MIME[ext] || 'application/octet-stream';
    if (TEXT_EXT.has(ext)) {
      assets[f.rel] = { t: type, e: 'txt', d: raw.toString('utf8') };
    } else {
      assets[f.rel] = { t: type, e: 'b64', d: raw.toString('base64') };
    }
  }
  return { assets, bytes };
}

function main() {
  if (process.platform !== 'win32') {
    console.error('  ✗ 单文件 exe 只能在 Windows 上产出（当前：' + process.platform + '）');
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  // 1) 内联资源
  console.log('[1/5] 内联前端资源');
  const { assets, bytes } = collectAssets();
  const keys = Object.keys(assets).sort();
  if (!keys.includes('index.html')) throw new Error('src/index.html 不存在，无法打包');

  let main = fs.readFileSync(path.join(__dirname, 'exe-template.js'), 'utf8');
  // 必须用函数替换：替换串里如果出现 $& / $' / $$ 等序列，会被当成特殊模式，
  // 而源码里恰好有 `'\\$&'`（正则转义），直接把占位符原样插回来，产出的 exe 是坏的。
  main = main.replace('/*__ASSETS__*/', () => JSON.stringify(assets, null, 2));
  main = main.replace('/*__VERSION__*/', () => pkg.version);
  if (main.includes('/*__ASSETS__*/') || main.includes('/*__VERSION__*/')) {
    throw new Error('模板占位符未被完全替换');
  }

  fs.mkdirSync(BUILD, { recursive: true });
  fs.writeFileSync(path.join(BUILD, 'main.js'), main, 'utf8');
  console.log('      ' + keys.length + ' 个资源，' + (bytes / 1024).toFixed(0) + ' KB');

  // 2) SEA blob
  console.log('[2/5] 生成 SEA blob');
  const seaConfig = {
    main: path.join(BUILD, 'main.js').replace(/\\/g, '/'),
    output: path.join(BUILD, 'sea-prep.blob').replace(/\\/g, '/'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false
  };
  fs.writeFileSync(path.join(BUILD, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', path.join(BUILD, 'sea-config.json')], {
    stdio: 'inherit',
    cwd: BUILD
  });

  // 3) 复制 node 宿主
  console.log('[3/5] 复制 node 宿主');
  fs.mkdirSync(DIST, { recursive: true });
  const outExe = path.join(DIST, EXE_NAME);
  if (fs.existsSync(outExe)) fs.rmSync(outExe);
  fs.copyFileSync(process.execPath, outExe);

  // 4) 注入 blob
  console.log('[4/5] 注入 SEA blob');
  const postjectCli = require.resolve('postject/dist/cli.js');
  execFileSync(process.execPath, [
    postjectCli, outExe, 'NODE_SEA_BLOB', path.join(BUILD, 'sea-prep.blob'),
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
  ], { stdio: 'inherit' });

  // 5) 自检
  console.log('[5/5] 自检');
  const ver = execFileSync(outExe, ['--version'], { encoding: 'utf8' }).trim();
  if (!ver.includes(pkg.version)) throw new Error('产物自检失败，--version 输出：' + ver);

  const size = fs.statSync(outExe).size;
  console.log('');
  console.log('  ✓ 完成：' + outExe);
  console.log('    ' + (size / 1048576).toFixed(1) + ' MB · ' + ver);
  console.log('');

  if (!process.argv.includes('--keep-temp')) {
    fs.rmSync(path.join(BUILD, 'sea-prep.blob'), { force: true });
  }
}

main();
