'use strict';
/* ===========================================================
 * tests/e2e.spec.js —— 端到端冒烟测试（Playwright + 本地静态服务）
 * 覆盖：启动无报错 → 记录 → 分类 → 检索 → 完成待办 → 阶段总结 → 设置持久化
 * 用法：node tests/e2e.spec.js [--headed] [--shots]
 * =========================================================== */
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.E2E_PORT || 4321);
const BASE = 'http://127.0.0.1:' + PORT + '/';
const SHOT_DIR = path.resolve(__dirname, '..', 'docs', 'screenshots');
const WANT_SHOTS = process.argv.includes('--shots');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Chromium/Chrome，可设置 CHROME_PATH 环境变量');
}

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push({ name, ok: true }); console.log('  ✓ ' + name); })
    .catch((e) => { results.push({ name, ok: false, err: e }); console.log('  ✗ ' + name + '\n      ' + e.message); });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function waitServer(url, timeoutMs = 15000) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = new Error('HTTP ' + res.status);
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('服务器未在超时内就绪：' + url + '（最后一次错误：' + (lastErr && lastErr.message) + '）');
}

(async () => {
  const server = spawn(process.execPath, [path.resolve(__dirname, '..', 'tools', 'serve.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (d) => process.env.E2E_DEBUG && console.log('[serve] ' + String(d).trim()));
  server.stderr.on('data', (d) => console.log('[serve:err] ' + String(d).trim()));
  server.on('error', (e) => console.log('[serve:spawn-error] ' + e.message));
  server.on('exit', (c) => process.env.E2E_DEBUG && console.log('[serve:exit] ' + c));

  let browser;
  let failed = 0;
  try {
    await waitServer(BASE);
    browser = await chromium.launch({
      executablePath: findChrome(),
      headless: !process.argv.includes('--headed'),
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN' });
    const page = await ctx.newPage();

    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cardList', { state: 'attached' });

    await check('页面加载无 JS 报错', async () => {
      assert(consoleErrors.length === 0, '控制台错误：' + consoleErrors.join(' | '));
    });

    await check('空库显示空状态引导', async () => {
      const visible = await page.isVisible('#emptyState');
      assert(visible, '空状态未显示');
    });

    await check('可以创建一条待办记录', async () => {
      await page.click('#btnCompose');
      await page.fill('#composeText', '明天下午三点前把 Q4 路线图发给张总，记得附上投入产出比表格。');
      await page.click('#typePicker .type-btn[data-type="auto"]');
      await page.click('#btnSaveNote');
      await page.waitForFunction(() => document.querySelectorAll('#cardList .card').length === 1, null, { timeout: 5000 });
      const badge = await page.textContent('#cardList .card .type-badge');
      assert(/待办/.test(badge), '应自动判定为待办，实际：' + badge);
    });

    await check('自动识别出截止日期', async () => {
      const txt = await page.textContent('#cardList .card');
      assert(/截止 \d{4}-\d{2}-\d{2}/.test(txt), '卡片未显示截止日期：' + txt.slice(0, 200));
    });

    await check('再记录一条想法并产生关联', async () => {
      await page.click('#btnCompose');
      await page.fill('#composeText', '路线图不要只列功能，要写清楚每个方向的投入产出比，否则评审时没法排序。');
      await page.click('#btnSaveNote');
      await page.waitForFunction(() => document.querySelectorAll('#cardList .card').length === 2, null, { timeout: 5000 });
      const rel = await page.locator('#cardList .card-rel').count();
      assert(rel >= 1, '两条内容应建立关联');
    });

    await check('关键词检索能命中并高亮', async () => {
      await page.fill('#searchInput', '路线图');
      // 必须等高亮出现，而不是等卡片数量——搜索前卡片数就已经是 2
      await page.waitForFunction(() => document.querySelectorAll('#cardList mark').length >= 1, null, { timeout: 4000 });
      const marks = await page.locator('#cardList mark').count();
      assert(marks >= 1, '搜索结果应高亮关键词');
      await page.click('#searchClear');
    });

    await check('勾选完成待办', async () => {
      await page.click('#cardList .card .todo-check');
      await page.waitForFunction(() => !!document.querySelector('#cardList .card.done'), null, { timeout: 4000 });
      const count = await page.textContent('[data-count="todo"]');
      assert(count === '1', '待办计数应为 1，实际 ' + count);
    });

    await check('阶段总结可生成且含五个小节', async () => {
      await page.click('#navMain .nav-item[data-view="insights"]');
      await page.click('#btnGenerateSummary');
      await page.waitForFunction(() => {
        const el = document.querySelector('#summaryBody');
        return el && el.textContent.includes('后续行动建议');
      }, null, { timeout: 8000 });
      const body = await page.textContent('#summaryBody');
      ['概览', '主要关注主题', '重点内容回顾', '待办与进展', '后续行动建议'].forEach((h) => {
        assert(body.includes(h), '总结缺少小节：' + h);
      });
    });

    await check('离线问答可回答待办类问题', async () => {
      await page.click('#navMain .nav-item[data-view="chat"]');
      await page.fill('#chatInput', '还有哪些没完成的待办？');
      await page.click('#btnAsk');
      // 占位气泡本身也是 .msg.ai，必须等到「真正有内容」而不是等到出现气泡
      await page.waitForFunction(() => {
        const el = document.querySelector('#chatLog .msg.ai .msg-body');
        return el && !/检索并思考中/.test(el.textContent) && el.textContent.length > 8;
      }, null, { timeout: 8000 });
      const txt = await page.textContent('#chatLog .msg.ai');
      assert(/待办|未完成/.test(txt), '回答未涉及待办：' + txt.slice(0, 120));
    });

    await check('刷新后数据仍在（localStorage 持久化）', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#cardList .card', { state: 'attached' });
      const n = await page.locator('#cardList .card').count();
      assert(n === 2, '刷新后应有 2 条记录，实际 ' + n);
    });

    await check('详情抽屉可打开并显示原文', async () => {
      await page.click('#cardList .card .card-title');
      await page.waitForSelector('#detailDrawer:not([hidden])');
      const txt = await page.textContent('#detailBox');
      assert(txt.length > 20, '详情内容为空');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#detailDrawer[hidden]', { state: 'attached' });
    });

    await check('删除有二次确认且可取消', async () => {
      let dialogMsg = null;
      page.once('dialog', async (d) => { dialogMsg = d.message(); await d.dismiss(); });
      await page.click('#cardList .card .mini-btn.warn');
      await page.waitForTimeout(200);
      assert(dialogMsg && /删除/.test(dialogMsg), '未弹出删除确认');
      const n = await page.locator('#cardList .card').count();
      assert(n === 2, '取消后不应删除，实际剩 ' + n);
    });

    if (WANT_SHOTS) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      await page.click('#navMain .nav-item[data-view="stream"][data-filter="all"]');
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOT_DIR, '01-stream.png'), fullPage: false });
      await page.click('#navMain .nav-item[data-view="insights"]');
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOT_DIR, '02-insights.png') });
      await page.click('#navMain .nav-item[data-view="chat"]');
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOT_DIR, '03-chat.png') });
    }

    failed = results.filter((r) => !r.ok).length;
  } catch (e) {
    console.error('e2e 运行失败：', e);
    failed = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }

  console.log('\n  e2e: ' + (results.length - failed) + '/' + results.length + ' 通过');
  process.exit(failed ? 1 : 0);
})();
