'use strict';
/* ===========================================================
 * tests/harness.js —— 零依赖测试沙箱
 * 把浏览器端脚本（engine / store / docimport / ai）加载进一个
 * 仿 window 的 vm 上下文，让它们能像在浏览器里一样跑单测。
 * =========================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.resolve(__dirname, '..', 'src', 'js');

/** 最小 localStorage 实现，可注入容量上限以模拟配额写满 */
function makeLocalStorage(quotaBytes) {
  const map = new Map();
  let used = 0;
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) {
      const s = String(v);
      const prev = map.get(k);
      const next = used - (prev ? prev.length : 0) + s.length;
      if (quotaBytes && next > quotaBytes) {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      used = next;
      map.set(k, s);
    },
    removeItem(k) {
      const prev = map.get(k);
      if (prev) used -= prev.length;
      map.delete(k);
    },
    clear() { map.clear(); used = 0; },
    key(i) { return Array.from(map.keys())[i] || null; },
    get length() { return map.size; },
    get _bytes() { return used; }
  };
}

/** 极简 DOM 桩：只够让 app.js 的模块级代码不炸；界面逻辑走 e2e */
function makeDocumentStub() {
  const noop = () => {};
  const el = () => ({
    style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, removeEventListener: noop, appendChild: noop, removeChild: noop,
    querySelector: () => null, querySelectorAll: () => [], setAttribute: noop, getAttribute: () => null,
    focus: noop, click: noop, innerHTML: '', textContent: '', value: '', hidden: false, files: null
  });
  return {
    readyState: 'complete',
    addEventListener: noop, removeEventListener: noop,
    createElement: el, querySelector: () => null, querySelectorAll: () => [],
    body: el(), documentElement: el()
  };
}

/**
 * 创建沙箱
 * @param {object} [opts]
 * @param {number} [opts.quotaBytes] localStorage 容量上限
 * @param {string[]} [opts.files] 要加载的脚本名（默认全部，按依赖顺序）
 */
function createSandbox(opts = {}) {
  const ctx = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    TextDecoder, TextEncoder, Blob, Response, URL, URLSearchParams,
    fetch: opts.fetch || (() => Promise.reject(new Error('fetch not stubbed'))),
    AbortController,
    DecompressionStream: globalThis.DecompressionStream,
    performance: globalThis.performance,
    localStorage: makeLocalStorage(opts.quotaBytes),
    navigator: { clipboard: null, userAgent: 'node-test' },
    document: makeDocumentStub(),
    location: { href: 'http://127.0.0.1:4173/' }
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);

  const files = opts.files || ['store.js', 'engine.js', 'docimport.js', 'ai.js'];
  for (const f of files) {
    const p = path.join(SRC, f);
    const code = fs.readFileSync(p, 'utf8');
    vm.runInContext(code, ctx, { filename: p });
  }
  return ctx;
}

/** 生成一条笔记的原始对象（不经过 Store） */
function note(over = {}) {
  return Object.assign({
    id: 'n_' + Math.random().toString(36).slice(2),
    type: 'idea',
    title: '',
    content: '',
    tags: [],
    priority: 'medium',
    dueDate: null,
    done: false,
    doneAt: null,
    pinned: false,
    summary: '',
    keyPoints: [],
    related: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }, over);
}

module.exports = { createSandbox, makeLocalStorage, note, SRC };
