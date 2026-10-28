'use strict';
/* ===========================================================
 * tools/bench.js —— 性能基准
 * 在真实浏览器里灌入 N 条记录，测「建索引 / 关联 / 首屏渲染 / 检索」耗时。
 * 用法：node tools/bench.js [N]，默认 2000
 * =========================================================== */
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const N = Number(process.argv[2] || 2000);
const PORT = Number(process.env.BENCH_PORT || 4331);
const BASE = 'http://127.0.0.1:' + PORT + '/';

const CHROME = [
  process.env.CHROME_PATH,
  path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
].filter(Boolean).find((p) => fs.existsSync(p));

(async () => {
  if (!CHROME) throw new Error('找不到 Chromium');
  const server = spawn(process.execPath, [path.resolve(__dirname, 'serve.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: 'ignore'
  });

  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try { if ((await fetch(BASE)).ok) break; } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 120));
  }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await page.goto(BASE);
  await page.waitForSelector('#cardList', { state: 'attached' });

  const seeded = await page.evaluate((n) => {
    const types = ['idea', 'material', 'todo'];
    const words = ['产品', '需求', '评审', '路线图', '用户', '增长', '数据', '分析', '设计', '原型',
      '知识管理', '笔记', '学习', '健身', '投资', '预算', '复盘', '会议', '协作', '交付',
      '检索', '摘要', '标签', '关联', '总结', '优先级', '截止', '排期'];
    const pick = () => words[Math.floor(Math.random() * words.length)];
    const now = Date.now();
    const arr = [];
    for (let i = 0; i < n; i++) {
      const content = pick() + pick() + '的' + pick() + '记录第 ' + i + ' 条：' +
        pick() + '与' + pick() + '的关系需要在' + pick() + '阶段确认，' + pick() + '之后再复盘。';
      arr.push({
        id: 'bench_' + i,
        type: types[i % 3],
        title: content.slice(0, 24),
        content,
        tags: [pick(), pick()],
        priority: i % 5 === 0 ? 'high' : 'medium',
        dueDate: null,
        done: i % 4 === 0,
        doneAt: null,
        pinned: i % 37 === 0,
        summary: '',
        keyPoints: [],
        related: [],
        createdAt: now - i * 60000,
        updatedAt: now - i * 60000
      });
    }
    Store.notes = arr;
    Store._index = null;
    Store.saveNotes();
    return arr.length;
  }, N);

  const result = await page.evaluate(() => {
    const out = {};
    const time = (label, fn) => {
      const t = performance.now();
      const r = fn();
      out[label] = Math.round((performance.now() - t) * 10) / 10;
      return r;
    };

    Engine.clearIndex();
    time('建索引', () => Engine.buildIndex(Store.all()));
    time('关联全量', () => Engine.relate(Store.all()));
    time('渲染首屏', () => window.__infoButler.renderStream());
    time('检索(2字)', () => Engine.search(Store.all(), '产品'));
    time('检索(6字)', () => Engine.search(Store.all(), '产品需求评审路线'));
    time('切换待办筛选', () => window.__infoButler.switchView('stream', 'todo'));
    time('生成阶段总结', () => Engine.buildSummary(Store.all(), Store.all(), 30));
    out['DOM 卡片数'] = document.querySelectorAll('#cardList .card').length;
    out['记录总数'] = Store.all().length;
    return out;
  });

  console.log('\n  基准结果（' + seeded + ' 条记录）');
  console.log('  ' + '─'.repeat(46));
  Object.keys(result).forEach((k) => {
    const v = result[k];
    const unit = /数$/.test(k) ? '' : ' ms';
    const warn = !/数$/.test(k) && v > 300 ? '   ← 偏慢' : '';
    console.log('  ' + k.padEnd(16, ' ') + String(v).padStart(8) + unit + warn);
  });
  console.log('  ' + '─'.repeat(46) + '\n');

  await browser.close();
  server.kill();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
