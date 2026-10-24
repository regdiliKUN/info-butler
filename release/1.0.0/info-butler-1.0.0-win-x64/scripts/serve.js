#!/usr/bin/env node
'use strict';
/* 零依赖静态服务器：本地预览 / 线上托管共用
 * 用法：node scripts/serve.js [--root <dir>] [--port <n>]
 * 默认 root 为项目根（index.html 所在目录），端口取 PORT 环境变量，缺省 4173。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const ROOT = path.resolve(opt('--root', path.resolve(__dirname, '..')));
const PORT = Number(process.env.PORT || opt('--port', 4173) || 4173);

// 启动前校验根目录，避免「服务在跑但内容为空」或根目录拼错时静默假活
if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error('[serve] 错误：根目录 ' + ROOT + ' 下没有 index.html，请检查 --root 参数');
  process.exit(1);
}

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

const server = http.createServer((req, res) => {
  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch (e) {
    pathname = '/';
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  // 严格目录穿越防护：先 path.normalize 消解 ..，再与 ROOT 拼接，最后用 ROOT + 路径分隔符做前缀判定。
  // 用「ROOT + sep」而非「startsWith(ROOT)」，避免 Windows 上 C:\foo 误把 C:\foobar 当作子路径。
  const safeBase = path.normalize(pathname).replace(/^([/\\])+/, '');
  const filePath = path.resolve(ROOT, safeBase);
  const rootWithSep = path.resolve(ROOT);
  if (filePath !== rootWithSep && !filePath.startsWith(rootWithSep + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('信息管家已启动：http://127.0.0.1:' + PORT + '   (root=' + ROOT + ')');
});
