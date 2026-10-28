'use strict';
/* ===========================================================
 * 信息管家 · 单文件可执行启动器（模板）
 * build-exe.js 会把下面的资源占位符替换成内嵌资源表，再交给 Node SEA 打包。
 * 运行时不依赖 node / python 等任何外部环境。
 * =========================================================== */

const http = require('http');
const { spawn } = require('child_process');

const APP_NAME = '信息管家';
const APP_VERSION = '/*__VERSION__*/';
const DEFAULT_PORT = 4173;

/* ============ 内嵌资源 ============ */
const ASSETS = /*__ASSETS__*/;

/* ============ 参数解析 ============ */
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.indexOf(name) >= 0;
const optValue = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

if (hasFlag('--help') || hasFlag('-h')) {
  console.log('');
  console.log('  ' + APP_NAME + ' v' + APP_VERSION + ' —— 本地单文件版');
  console.log('');
  console.log('  用法：信息管家.exe [选项]');
  console.log('');
  console.log('    --port <端口>    指定服务端口（默认 ' + DEFAULT_PORT + '）');
  console.log('    --no-browser     启动服务但不自动打开浏览器');
  console.log('    --version        显示版本信息');
  console.log('    --help           显示本帮助');
  console.log('');
  console.log('  双击运行即可：会自动在浏览器打开 http://127.0.0.1:' + DEFAULT_PORT + '/');
  console.log('  关闭本窗口即停止服务。');
  console.log('');
  process.exit(0);
}

if (hasFlag('--version') || hasFlag('-v')) {
  console.log(APP_NAME + ' v' + APP_VERSION + '  (single-file build, node ' + process.versions.node + ')');
  process.exit(0);
}

const WANT_PORT = Number(process.env.PORT || optValue('--port', DEFAULT_PORT) || DEFAULT_PORT) || DEFAULT_PORT;
const NO_BROWSER = hasFlag('--no-browser') || process.env.INFO_BUTLER_NO_BROWSER === '1';

/* ============ 静态服务 ============ */
const MIME_FALLBACK = 'application/octet-stream';

function lookup(pathname) {
  // 内嵌资源表的 key 均为不带前导斜杠的相对路径
  const rel = String(pathname).replace(/^[/\\]+/, '');
  if (rel === '') return ASSETS['index.html'];
  if (rel.endsWith('/')) {
    const withIndex = rel + 'index.html';
    if (ASSETS[withIndex]) return ASSETS[withIndex];
  }
  return ASSETS[rel] || null;
}

function createServer() {
  return http.createServer((req, res) => {
    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch (e) {
      pathname = '/';
    }

    let entry = lookup(pathname);
    if (!entry && (pathname === '/favicon.ico' || pathname === '/favicon.png')) {
      entry = ASSETS['icon.ico'] || ASSETS['icon.png'] || null;
    }

    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end('404 Not Found: ' + pathname);
      return;
    }

    const body = Buffer.from(entry.d, entry.e === 'b64' ? 'base64' : 'utf8');
    res.writeHead(200, {
      'Content-Type': entry.t || MIME_FALLBACK,
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'X-Info-Butler': APP_VERSION
    });
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(body);
  });
}

/* ============ 端口探测 ============ */
/* 先探测端口上是否已有「本应用」在运行：
 * Windows 允许「指定地址(127.0.0.1)」与「通配地址(0.0.0.0)」同时绑定同一端口，
 * 若直接 listen 会静默起第二个服务，因此必须先探测再绑定。 */
function probeApp(port, cb) {
  let done = false;
  let timer = null;
  const finish = (alive, ours) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    cb({ alive: alive, ours: ours });
  };
  const looksOurs = (body, headers) => {
    if (headers && headers['x-info-butler']) return true;          // 新版单文件服务
    return /<title>\s*信息管家/.test(body);                        // 旧版 bat 启动器（同一套前端）
  };

  const req = http.get({ host: '127.0.0.1', port: port, path: '/' }, (res) => {
    const hdrs = res.headers || {};
    let body = '';
    res.setEncoding('utf8');
    if (looksOurs('', hdrs)) {
      finish(true, res.statusCode === 200);
      res.destroy();
      return;
    }
    res.on('data', (chunk) => {
      if (done) return;
      body += chunk;
      if (looksOurs(body, hdrs) || body.length > 16384) {
        finish(true, res.statusCode === 200 && looksOurs(body, hdrs));
        res.destroy();
      }
    });
    res.on('end', () => finish(true, res.statusCode === 200 && looksOurs(body, hdrs)));
    res.on('error', () => finish(true, looksOurs(body, hdrs)));
    res.on('aborted', () => finish(true, looksOurs(body, hdrs)));
    res.on('close', () => finish(true, looksOurs(body, hdrs)));
  });
  req.on('error', () => finish(false, false));
  req.on('timeout', () => { finish(false, false); try { req.destroy(); } catch (e) { } });

  timer = setTimeout(() => {
    finish(false, false);
    try { req.destroy(); } catch (e) { }
  }, 2500);
}

function listen(server, port) {
  return new Promise((resolve) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      resolve({ ok: false, err: err });
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve({ ok: true });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/* ============ 打开浏览器 ============ */
function openBrowser(url) {
  if (NO_BROWSER) return;
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) {
    console.log('  （自动打开浏览器失败，请手动访问：' + url + '）');
  }
}

function banner(url, port, note) {
  const line = '─'.repeat(58);
  console.log('');
  console.log('  ' + line);
  console.log('   ' + APP_NAME + '  v' + APP_VERSION + '   本地单文件版');
  console.log('  ' + line);
  console.log('   访问地址 : ' + url);
  if (note) console.log('   说  明  : ' + note);
  console.log('');
  console.log('   数据保存在浏览器本地（localStorage，绑定 127.0.0.1:' + port + '）');
  console.log('   关闭本窗口即可停止服务。');
  console.log('  ' + line);
  console.log('');
}

function pauseAndExit(code) {
  if (!process.stdin.isTTY) {
    setTimeout(() => process.exit(code), 1200);
    return;
  }
  console.log('   按回车键退出…');
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(code));
  setTimeout(() => process.exit(code), 30000);
}

/* ============ 主流程 ============ */
function main() {
  process.title = APP_NAME + ' · 本地服务';

  const reuseExisting = (port) => {
    const url = 'http://127.0.0.1:' + port + '/';
    banner(url, port, '检测到已有实例在运行，已直接打开现有窗口');
    openBrowser(url);
    setTimeout(() => process.exit(0), 2500);
  };

  probeApp(WANT_PORT, (p) => {
    if (p.ours) {
      reuseExisting(WANT_PORT);
      return;
    }

    const MAX_TRY = 10;
    const tryBind = (port, attempt) => {
      const server = createServer();
      listen(server, port).then((r) => {
        if (r.ok) {
          const url = 'http://127.0.0.1:' + port + '/';
          const note = port === WANT_PORT ? null
            : '端口 ' + WANT_PORT + ' 被其它程序占用，已改用 ' + port + '（该端口的数据与 ' + WANT_PORT + ' 相互独立）';
          banner(url, port, note);
          openBrowser(url);
          const shutdown = () => {
            console.log('');
            console.log('  正在停止服务…');
            try { server.close(); } catch (e) { }
            setTimeout(() => process.exit(0), 150);
          };
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);
          process.on('SIGHUP', shutdown);
          return;
        }

        if (r.err && r.err.code === 'EADDRINUSE') {
          probeApp(port, (p2) => {
            if (p2.ours) { reuseExisting(port); return; }
            if (attempt >= MAX_TRY) {
              console.log('');
              console.log('  启动失败：端口 ' + WANT_PORT + ' ~ ' + port + ' 均不可用。');
              console.log('  可改用：信息管家.exe --port 5000');
              console.log('');
              pauseAndExit(1);
              return;
            }
            tryBind(port + 1, attempt + 1);
          });
          return;
        }

        console.log('');
        console.log('  启动失败：' + (r.err && r.err.message ? r.err.message : '未知错误'));
        console.log('  可改用：信息管家.exe --port 5000');
        console.log('');
        pauseAndExit(1);
      });
    };

    tryBind(WANT_PORT, 1);
  });
}

/* 双击运行时若出错，不要静默消失，把原因留在窗口里 */
process.on('uncaughtException', (e) => {
  console.log('');
  console.log('  运行出错：' + (e && e.message ? e.message : String(e)));
  console.log('  可尝试：信息管家.exe --port 5000');
  console.log('');
  pauseAndExit(1);
});
process.on('unhandledRejection', (e) => {
  console.log('');
  console.log('  运行出错：' + (e && e.message ? e.message : String(e)));
  console.log('');
  pauseAndExit(1);
});

main();
