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
const { buildPdf } = require('./fixtures');

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
  // 优先问 Playwright 自己：CI 里 `npx playwright install chromium` 装好的路径它能直接给出
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* 没装浏览器时继续走下面的兜底 */ }

  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;

  // 兜底：在 ms-playwright 目录里找任意版本的 chromium
  const base = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (fs.existsSync(base)) {
    for (const dir of fs.readdirSync(base)) {
      if (!dir.startsWith('chromium-')) continue;
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome']) {
        const full = path.join(base, dir, rel);
        if (fs.existsSync(full)) return full;
      }
    }
  }
  throw new Error('找不到 Chromium/Chrome，可执行 `npx playwright install chromium` 或设置 CHROME_PATH');
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

    await check('首页提醒条把快到期的待办捞到顶上', async () => {
      await page.waitForSelector('#focusBar:not([hidden])', { timeout: 4000 });
      const txt = await page.textContent('#focusBar');
      assert(/本周还有|今天有|已逾期/.test(txt), '提醒条文案不对：' + txt);
      // 点按钮应把列表筛到只剩这一项
      await page.click('#focusBar [data-due]');
      await page.waitForFunction(() => !!document.querySelector('#filterChips .chip'), null, { timeout: 4000 });
      const n = await page.locator('#cardList .card').count();
      assert(n === 1, '只看到期应只剩 1 条，实际 ' + n);
      await page.click('#filterChips [data-undue]');
      await page.waitForFunction(() => !document.querySelector('#filterChips [data-undue]'), null, { timeout: 4000 });
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

    await check('搜索里的时间词会变成可取消的筛选条件', async () => {
      await page.fill('#searchInput', '今天');
      await page.waitForFunction(() => !!document.querySelector('#filterChips .chip-time'), null, { timeout: 4000 });
      const label = await page.textContent('#filterChips .chip-time');
      assert(/今天/.test(label), '时间条件应回显「今天」，实际：' + label);
      const n = await page.locator('#cardList .card').count();
      assert(n === 2, '两条记录都是今天创建的，应全部命中，实际 ' + n);
      await page.click('#filterChips .chip-time');
      await page.waitForFunction(() => !document.querySelector('#filterChips .chip-time'), null, { timeout: 4000 });
      const left = await page.inputValue('#searchInput');
      assert(left === '', '取消时间条件后关键词应为空，实际：' + left);
      await page.click('#searchClear');
    });

    await check('勾选完成待办', async () => {
      await page.click('#cardList .card .todo-check');
      await page.waitForFunction(() => !!document.querySelector('#cardList .card.done'), null, { timeout: 4000 });
      const count = await page.textContent('[data-count="todo"]');
      assert(count === '1', '待办计数应为 1，实际 ' + count);
    });

    await check('待办全部完成后提醒条自动消失', async () => {
      await page.waitForSelector('#focusBar[hidden]', { state: 'attached', timeout: 4000 });
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
      // 用顶栏按钮打开而不是 Ctrl+K：Ctrl+K 是「切换」语义，
      // 上一步如果没关干净就会变成"关掉"，测试会偶发失败。
      await page.evaluate(() => { document.querySelector('#palette').hidden = true; });
      await page.click('#btnPalette');
      await page.waitForSelector('#palette:not([hidden])', { timeout: 3000 });
      await page.fill('#paletteInput', '浅色');
      await page.waitForFunction(() => {
        const it = document.querySelector('#paletteList .palette-item');
        return it && /切换深色/.test(it.textContent);
      }, null, { timeout: 3000 });
      await page.click('#paletteList .palette-item');
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

    await check('Tab 焦点被困在弹层内，关闭后归还', async () => {
      await page.click('#navMain .nav-item[data-view="stream"][data-filter="all"]');
      // 分批渲染的 IntersectionObserver 可能在聚焦之后重建列表，把焦点元素摘掉，
      // 于是 Enter 打不开详情。重试几次，聚焦成功再按。
      let opened = false;
      for (let i = 0; i < 3 && !opened; i++) {
        await page.locator('#cardList .card .card-title').first().focus();
        await page.keyboard.press('Enter');
        opened = await page.isVisible('#detailDrawer');
        if (!opened) await page.waitForTimeout(150);
      }
      assert(opened, '按 Enter 应打开详情抽屉');
      await page.waitForSelector('#detailDrawer:not([hidden])');
      // 连续 Tab 20 次，焦点不应跑到弹层外
      let escaped = false;
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press('Tab');
        const inside = await page.evaluate(() => {
          const d = document.querySelector('#detailDrawer');
          return d.contains(document.activeElement);
        });
        if (!inside) { escaped = true; break; }
      }
      assert(!escaped, '焦点跑出了抽屉');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#detailDrawer[hidden]', { state: 'attached' });
      const back = await page.evaluate(() => document.activeElement && document.activeElement.className);
      assert(/card-title/.test(back || ''), '关闭后焦点应回到触发元素，实际：' + back);
    });

    await check('关键控件具备可读的无障碍名称', async () => {
      const bad = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('button').forEach((b) => {
          if (b.offsetParent === null) return;
          const name = (b.getAttribute('aria-label') || b.textContent || '').trim();
          if (!name) out.push(b.id || b.className || b.outerHTML.slice(0, 60));
        });
        return out;
      });
      assert(bad.length === 0, '这些按钮没有可读名称：' + bad.join(' | '));
    });

    await check('存在跳到内容的跳转链接', async () => {
      const href = await page.getAttribute('.skip-link', 'href');
      assert(href === '#cardList', '跳转链接应指向内容区，实际 ' + href);
    });

    await check('详情里可用 ← → 在记录间移动', async () => {
      await page.click('#navMain .nav-item[data-view="stream"][data-filter="all"]');
      await page.click('#cardList .card .card-title');
      await page.waitForSelector('#detailDrawer:not([hidden])');
      const firstId = await page.getAttribute('#detailBox', 'data-note-id');
      const pos = await page.textContent('#detailBox .detail-pos');
      assert(/^1 \/ \d+/.test(pos), '应显示位置，实际：' + pos);
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction((prev) => document.querySelector('#detailBox').getAttribute('data-note-id') !== prev, firstId, { timeout: 3000 });
      const secondId = await page.getAttribute('#detailBox', 'data-note-id');
      assert(secondId && secondId !== firstId, '→ 应切到下一条');
      await page.keyboard.press('ArrowLeft');
      await page.waitForFunction((want) => document.querySelector('#detailBox').getAttribute('data-note-id') === want, firstId, { timeout: 3000 });
      await page.keyboard.press('Escape');
      await page.waitForSelector('#detailDrawer[hidden]', { state: 'attached' });
    });

    await check('记录重复内容时提示已有相似记录', async () => {
      await page.click('#btnCompose');
      await page.fill('#composeText', '明天下午三点前把 Q4 路线图发给张总，记得附上投入产出比表格。');
      await page.click('#btnSaveNote');
      await page.waitForFunction(() => {
        const t = document.querySelector('#toast .toast-msg');
        return t && /相似/.test(t.textContent);
      }, null, { timeout: 5000 });
      const act = await page.textContent('#toast .toast-act');
      assert(/查看/.test(act), '提示里应有「查看」，实际：' + act);
      // 清理这条重复记录，避免影响后面的列表断言
      await page.evaluate(() => {
        const n = Store.all()[0];
        Store.remove(n.id);
        Store.emptyTrash();
        window.__infoButler.renderAll();
      });
    });

    await check('可以导入 PDF 并提取出文字', async () => {
      await page.click('#navMain .nav-item[data-view="settings"]');
      const pdf = buildPdf({ content: 'BT /F1 12 Tf 72 720 Td (Quarterly review notes from PDF) Tj ET', flate: true });
      await page.setInputFiles('#importDocFile', {
        name: '季度评审.pdf', mimeType: 'application/pdf', buffer: pdf
      });
      await page.waitForFunction(() => {
        const t = document.querySelector('#toast');
        return t && !t.hidden && /导入/.test(t.textContent);
      }, null, { timeout: 10000 });
      const toastTxt = await page.textContent('#toast');
      assert(/成功导入 1 篇文档/.test(toastTxt), '导入结果不对：' + toastTxt);
      // 导入后会自动切回记录流并定位到新内容
      await page.waitForFunction(() => document.querySelectorAll('#cardList .card').length >= 1, null, { timeout: 5000 });
      const body = await page.textContent('#cardList');
      assert(/Quarterly review notes/.test(body), '导入的正文应出现在列表里：' + body.slice(0, 160));
    });

    await check('批量选择后可以一次改类型', async () => {
      await page.click('#searchClear');
      await page.waitForFunction(() => document.querySelectorAll('#cardList .card').length >= 3, null, { timeout: 4000 });
      await page.click('#btnSelectMode');
      await page.waitForSelector('#cardList .card-pick', { state: 'attached', timeout: 4000 });
      const cards = page.locator('#cardList .card');
      await cards.nth(0).click();
      await cards.nth(1).click();
      await page.waitForFunction(() => /已选 2 项/.test(document.querySelector('#batchCount').textContent), null, { timeout: 4000 });
      await page.click('#batchBar [data-batch="type-material"]');
      await page.waitForFunction(() => {
        const first = document.querySelector('#cardList .card');
        return first && /资料/.test(first.querySelector('.type-badge').textContent);
      }, null, { timeout: 4000 });
    });

    await check('批量加标签走自绘对话框而不是原生 prompt', async () => {
      await page.click('#batchBar [data-batch="tag"]');
      await page.waitForSelector('#askModal:not([hidden])', { timeout: 4000 });
      const tag = '批量测试标签';
      await page.fill('#askInput', tag);
      await page.press('#askInput', 'Enter');
      await page.waitForSelector('#askModal[hidden]', { state: 'attached', timeout: 4000 });
      await page.waitForFunction((t) => {
        const el = document.querySelector('#toast');
        return el && !el.hidden && el.textContent.indexOf(t) >= 0;
      }, tag, { timeout: 4000 });
      const txt = await page.textContent('#cardList');
      assert(txt.includes(tag), '标签应出现在卡片上');
      await page.click('#batchCancel');
      await page.waitForSelector('#batchBar[hidden]', { state: 'attached', timeout: 4000 });
      const picks = await page.locator('#cardList .card-pick').count();
      assert(picks === 0, '退出批量后不应残留选择框');
    });

    await check('大模型回答边生成边显示（流式）', async () => {
      // 用假 fetch 顶掉真实网络：验证的是「分片到达 → 增量渲染」这条链路，
      // 不依赖任何 API Key，也就不会因为网络抖动而假失败。
      await page.evaluate(() => {
        window.__origFetch = window.fetch;
        Store.config.apiKey = 'sk-e2e';
        Store.config.baseUrl = 'https://example.invalid/v1';
        Store.config.model = 'e2e-model';
        Store.saveConfig();
        const enc = new TextEncoder();
        const chunks = [
          'data: ' + JSON.stringify({ choices: [{ delta: { content: '## 结论\n' } }] }) + '\n\n',
          'data: ' + JSON.stringify({ choices: [{ delta: { content: '你最近在推进 Q4 路线图。' } }] }) + '\n\n',
          'data: [DONE]\n\n'
        ];
        window.fetch = () => Promise.resolve(new Response(new ReadableStream({
          start(c) {
            let i = 0;
            const push = () => {
              if (i >= chunks.length) { c.close(); return; }
              c.enqueue(enc.encode(chunks[i++]));
              setTimeout(push, 120);   // 拉开间隔，保证能看到"只出了一部分"的中间态
            };
            push();
          }
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      });

      await page.click('#navMain .nav-item[data-view="chat"]');
      await page.fill('#chatInput', '我在推进什么');
      await page.click('#btnAsk');

      await page.waitForSelector('#chatLog .stream-caret', { timeout: 5000 });
      const partial = await page.textContent('#chatLog .msg.ai:last-child');
      assert(/结论/.test(partial), '第一段应先渲染出来：' + partial);
      assert(!/Q4 路线图/.test(partial), '此时第二段还没到，不该提前显示');

      await page.waitForFunction(() => !document.querySelector('#chatLog .stream-caret'), null, { timeout: 8000 });
      const full = await page.textContent('#chatLog .msg.ai:last-child');
      assert(/Q4 路线图/.test(full), '完整回答应渲染：' + full);

      await page.evaluate(() => {
        window.fetch = window.__origFetch;
        Store.config.apiKey = '';
        Store.saveConfig();
      });
    });

    await check('到期通知默认关闭，开启后只弹一次', async () => {
      const off = await page.evaluate(() => !!Store.config.notifyDue);
      assert(off === false, '默认必须是关闭的');

      // 无头浏览器里看不到真实系统通知，用假的 Notification 记录调用
      await page.evaluate(() => {
        window.__notified = [];
        function Fake(title, opts) { window.__notified.push({ title: title, body: (opts && opts.body) || '' }); }
        Fake.permission = 'granted';
        Fake.requestPermission = function () { return Promise.resolve('granted'); };
        window.Notification = Fake;
      });

      await page.evaluate(() => {
        const d = new Date(Date.now() - 3 * 86400000);
        const due = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        window.__e2eOverdue = Store.add({ type: 'todo', title: '交季度复盘', content: '交季度复盘', dueDate: due });
        Store.saveNotes();
      });

      const whileOff = await page.evaluate(() => window.__infoButler.notifyDue(false));
      assert(whileOff === false, '开关关着时不该发通知');

      const first = await page.evaluate(() => {
        Store.config.notifyDue = true;
        Store.saveConfig();
        return window.__infoButler.notifyDue(false);
      });
      assert(first === true, '开启且已授权时应发出通知');
      const got = await page.evaluate(() => window.__notified.slice());
      assert(got.length === 1 && /逾期/.test(got[0].title), '通知应说明逾期：' + JSON.stringify(got));
      assert(/交季度复盘/.test(got[0].body), '正文应包含待办标题：' + got[0].body);

      const again = await page.evaluate(() => window.__infoButler.notifyDue(false));
      assert(again === false, '同一天不该重复提醒');

      // 收尾：删掉造出来的逾期项，避免影响后面的列表断言
      await page.evaluate(() => {
        Store.remove(window.__e2eOverdue.id);
        Store.emptyTrash();
        Store.config.notifyDue = false;
        Store.saveConfig();
        window.__infoButler.renderAll();
      });
    });

    await check('命令面板能搜记录，并把关键词记成最近搜索', async () => {
      await page.evaluate(() => Store.clearQueries());

      await page.click('#btnPalette');
      await page.fill('#paletteInput', 'Q4');
      await page.waitForSelector('#paletteList .palette-item', { timeout: 4000 });
      const labels = await page.textContent('#paletteList');
      assert(/在列表里搜索「Q4」/.test(labels), '关键词应能一键落到列表：' + labels.slice(0, 120));

      await page.click('#paletteList .palette-item:has-text("在列表里搜索")');
      await page.waitForSelector('#palette[hidden]', { state: 'attached', timeout: 4000 });
      // 面板的 run 是下一帧执行的，不能读完 hidden 就立刻断言列表状态
      await page.waitForFunction(
        () => /匹配「Q4」/.test(document.querySelector('#streamSub').textContent),
        null, { timeout: 4000 }
      );
      const sub = await page.textContent('#streamSub');
      assert(/匹配「Q4」/.test(sub), '列表应进入搜索结果：' + sub);

      await page.click('#btnPalette');
      await page.waitForFunction(
        () => /最近搜索/.test(document.querySelector('#paletteList').textContent),
        null, { timeout: 4000 }
      );
      const recent = await page.textContent('#paletteList');
      assert(/最近搜索/.test(recent) && recent.includes('Q4'), '空输入时应回显最近搜索：' + recent.slice(0, 120));
      await page.keyboard.press('Escape');
      await page.waitForSelector('#palette[hidden]', { state: 'attached', timeout: 4000 });

      const kept = await page.evaluate(() => Store.recentQueries());
      assert(kept.includes('Q4'), '查询应写进历史：' + JSON.stringify(kept));
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
