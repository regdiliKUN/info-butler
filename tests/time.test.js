'use strict';
/* 时间表达式解析与「时间 + 关键词」混合检索 */
const test = require('node:test');
const assert = require('node:assert');
const { createSandbox, note } = require('./harness');

const sb = createSandbox();
const E = sb.Engine;

const DAY = 86400000;
function daysAgo(n) { return Date.now() - n * DAY; }

test('parseTimeRange 识别「今天」为当天 00:00–24:00', () => {
  const r = E.parseTimeRange('今天');
  assert.ok(r, '应识别出今天');
  const from = new Date(r.from);
  assert.strictEqual(from.getHours(), 0);
  assert.strictEqual(from.getMinutes(), 0);
  assert.strictEqual(r.to - r.from, DAY, '跨度应为一天');
  assert.strictEqual(r.label, '今天');
});

test('parseTimeRange 剥离时间词后保留剩余关键词', () => {
  const r = E.parseTimeRange('上周关于产品的想法');
  assert.ok(r);
  assert.strictEqual(r.label, '上周');
  assert.strictEqual(r.cleaned, '关于产品的想法');
});

test('parseTimeRange 清掉时间词后残留的连接词', () => {
  assert.strictEqual(E.parseTimeRange('最近3天的产品记录').cleaned, '产品记录');
  assert.strictEqual(E.parseTimeRange('这个月的 复盘').cleaned, '复盘');
});

test('parseTimeRange 支持「最近 N 天 / 周 / 个月」', () => {
  const d = E.parseTimeRange('最近 5 天');
  assert.strictEqual(d.label, '最近 5 天');
  assert.ok(d.to - d.from >= 5 * DAY, '跨度应覆盖 5 天');

  const w = E.parseTimeRange('最近2周');
  assert.strictEqual(w.label, '最近 2 周');
  assert.ok(w.to - w.from >= 14 * DAY);

  const m = E.parseTimeRange('最近3个月');
  assert.strictEqual(m.label, '最近 3 个月');
  assert.ok(m.to - m.from > 60 * DAY);
});

test('parseTimeRange 支持「N 天前」定位到那一天', () => {
  const r = E.parseTimeRange('3天前');
  assert.ok(r);
  assert.strictEqual(r.to - r.from, DAY, '应只覆盖一天');
  const mid = new Date((r.from + r.to) / 2);
  assert.strictEqual(Math.round((Date.now() - mid.getTime()) / DAY), 3);
});

test('parseTimeRange 本周以上周一为起点', () => {
  const r = E.parseTimeRange('本周');
  const from = new Date(r.from);
  assert.strictEqual(from.getDay(), 1, '应从周一开始');
  assert.ok(r.to - r.from === 7 * DAY);
});

test('parseTimeRange 普通关键词不误判为时间', () => {
  ['产品', '路线图', '今天的天气怎么样', ''].forEach((q) => {
    const r = E.parseTimeRange(q);
    if (q === '今天的天气怎么样') {
      // 含「今天」当然要识别，但剩余关键词必须保留
      assert.strictEqual(r.cleaned, '的天气怎么样'.replace(/^的/, ''));
      return;
    }
    assert.strictEqual(r, null, '不应把「' + q + '」当成时间');
  });
});

test('search 纯时间查询只返回该时间段的记录', () => {
  const notes = [
    note({ id: 'today', content: '今天记的', createdAt: daysAgo(0) }),
    note({ id: 'yesterday', content: '昨天记的', createdAt: daysAgo(1) }),
    note({ id: 'week', content: '八天前记的', createdAt: daysAgo(8) })
  ];
  const hits = E.search(notes, '今天');
  assert.deepStrictEqual(hits.map((h) => h.note.id), ['today']);
  assert.ok(hits.time, '结果应带上识别出的时间范围');
});

test('search 时间 + 关键词同时生效', () => {
  const notes = [
    note({ id: 'a', content: '本周的产品评审记录', createdAt: daysAgo(1) }),
    note({ id: 'b', content: '上周的产品评审记录', createdAt: daysAgo(9) }),
    note({ id: 'c', content: '本周的健身记录', createdAt: daysAgo(1) })
  ];
  const hits = E.search(notes, '本周产品');
  assert.deepStrictEqual(hits.map((h) => h.note.id), ['a'], '应只剩本周且含产品的记录');
});

test('search 时间范围内无结果时返回空而不是全量', () => {
  const notes = [note({ id: 'old', content: '很久以前', createdAt: daysAgo(400) })];
  assert.strictEqual(E.search(notes, '今天').length, 0);
  assert.strictEqual(E.search(notes, '去年').length, 1);
});

test('search 单字查询仍然可用（不被时间解析吃掉）', () => {
  const notes = [note({ id: 'a', content: '这个月的房租已经付了' })];
  const hits = E.search(notes, '钱');
  assert.ok(Array.isArray(hits), '单字查询不应抛错');
  const hits2 = E.search(notes, '房租');
  assert.deepStrictEqual(hits2.map((h) => h.note.id), ['a']);
});
