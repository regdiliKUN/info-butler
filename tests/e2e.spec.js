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

    await check('删除会进回收站，且提示里能一键撤销', async () => {
      page.once('dialog', async (d) => { await d.accept(); });
      await page.click('#cardList .card .mini-btn.warn');
      await page.waitForFunction(() => document.querySelectorAll('#cardList .card').length === 1, null, { timeout: 4000 });
      const act = await page.textContent('#toast .toast-act');
      assert(/撤销/.test(act), '提示里应有撤销按钮，实际：' + act);
      await page.click('#toast .toast-act');
      await page.waitForFunction(() => document.querySelectorAll('#cardList .card').length === 2, null, { timeout: 4000 });
    });

    await check('Ctrl+Z 可撤销上一步操作', async () => {
      // 只盯「有待办勾选框」的那张卡：首张卡可能是想法，没有 done 状态
      const todoCard = page.locator('#cardList .card').filter({ has: page.locator('.todo-check') }).first();
      const before = await todoCard.evaluate((el) => el.classList.contains('done'));
      await todoCard.locator('.todo-check').click();
      await page.waitForFunction(
        (b) => {
          const c = document.querySelector('#cardList .card .todo-check');
          return c && c.closest('.card').classList.contains('done') !== b;
        },
        before, { timeout: 3000 }
      );
      // 让焦点离开卡片，模拟真实的「点完就按 Ctrl+Z」
      await page.locator('.stream-head').click({ position: { x: 5, y: 5 } }).catch(() => {});
      await page.keyboard.press('Control+z');
      await page.waitForFunction(
        (b) => {
          const c = document.querySelector('#cardList .card .todo-check');
          return c && c.closest('.card').classList.contains('done') === b;
        },
        before, { timeout: 3000 }
      );
    });

    await check('设置页显示回收站与存储用量', async () => {
      await page.click('#navMain .nav-item[data-view="settings"]');
      await page.waitForSelector('#usageBar:not([hidden])');
      const usage = await page.textContent('#usageText');
      assert(/已用/.test(usage), '应显示存储用量，实际：' + usage);
      const trash = await page.textContent('#trashList');
      assert(trash.length > 0, '回收站区域应有内容');
    });

    await check('Ctrl+K 打开命令面板并能搜到记录', async () => {
      await page.click('#navMain .nav-item[data-view="stream"][data-filter="all"]');
      await page.keyboard.press('Control+k');
      await page.waitForSelector('#palette:not([hidden])');
      await page.fill('#paletteInput', '路线图');
      await page.waitForFunction(() => document.querySelectorAll('#paletteList .palette-item').length >= 1, null, { timeout: 3000 });
      const first = await page.textContent('#paletteList .palette-item');
      assert(/路线图/.test(first), '命令面板应能搜到记录，实际：' + first);
      await page.keyboard.press('Escape');
      await page.waitForSelector('#palette[hidden]', { state: 'attached' });
    });

    await check('命令面板可切换主题并生效', async () => {
      await page.keyboard.press('Control+k');
      await page.waitForSelector('#palette:not([hidden])', { timeout: 3000 });
      await page.fill('#paletteInput', '浅色');
      await page.waitForFunction(() => {
        const it = document.querySelector('#paletteList .palette-item');
        return it && /切换深色/.test(it.textContent);
      }, null, { timeout: 3000 });
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light', null, { timeout: 3000 });
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert(bg !== 'rgb(14, 17, 22)', '浅色主题下背景应变亮，实际 ' + bg);
    });

    await check('浅色主题下无深色残留块', async () => {
      // 侧边栏、卡片、设置面板是最容易被漏掉的三个面
      const bad = await page.evaluate(() => {
        const pick = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const m = getComputedStyle(el).backgroundColor.match(/\d+/g);
          return m ? Number(m[0]) + Number(m[1]) + Number(m[2]) : null;
        };
        return { sidebar: pick('.sidebar'), card: pick('.card'), panel: pick('.panel') };
      });
      Object.keys(bad).forEach((k) => {
        if (bad[k] != null) assert(bad[k] > 300, k + ' 仍是深色（RGB 和 ' + bad[k] + '）');
      });
    });

    await check('大列表分批渲染，不会一次塞满 DOM', async () => {
      await page.evaluate(() => {
        const now = Date.now();
        const arr = [];
        for (let i = 0; i < 150; i++) {
          arr.push({
            id: 'bulk_' + i, type: i % 2 ? 'idea' : 'material',
            title: '批量记录 ' + i, content: '批量记录 ' + i + ' 的正文内容，用于验证分批渲染。',
            tags: ['批量'], priority: 'medium', dueDate: null, done: false, doneAt: null,
            pinned: false, summary: '', keyPoints: [], related: [],
            createdAt: now - i * 60000, updatedAt: now - i * 60000
          });
        }
        Store.notes = arr.concat(Store.all());
        Store._index = null;
        Store.saveNotes();
        window.__infoButler.switchView('stream', 'all');
      });
      await page.waitForFunction(() => document.querySelectorAll('#cardList .card').length === 60, null, { timeout: 5000 });
      assert(await page.isVisible('#loadMoreWrap'), '应显示「继续加载」');
      const hint = await page.textContent('#loadMoreHint');
      assert(/60 \/ 15[0-9]/.test(hint), '应显示进度，实际：' + hint);
      await page.click('#btnLoadMore');
      await page.waitForFunction(() => document.querySelectorAll('#cardList .card').length > 60, null, { timeout: 4000 });
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
