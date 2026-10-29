'use strict';
/* 待办到期分桶：逾期 / 今天 / 本周 */
const test = require('node:test');
const assert = require('node:assert');
const { createSandbox, note } = require('./harness');

const sb = createSandbox();
const E = sb.Engine;

const DAY = 86400000;
const NOW = new Date('2026-06-15T10:00:00').getTime();   // 固定"现在"，避免跨天导致测试抖动
function d(offset) {
  const dt = new Date(NOW + offset * DAY);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}
const todo = (over) => note(Object.assign({ type: 'todo', title: 't', content: 't', done: false }, over));
// 沙箱里创建的数组原型与宿主不同，deepStrictEqual 会因为原型不一致报错，
// 统一用 Array.from 转成宿主数组再比较
const ids = (arr) => Array.from(arr, (n) => n.id);

test('dueBuckets 按截止日分到 逾期 / 今天 / 本周', () => {
  const notes = [
    todo({ id: 'late', dueDate: d(-3) }),
    todo({ id: 'today', dueDate: d(0) }),
    todo({ id: 'in3', dueDate: d(3) }),
    todo({ id: 'in7', dueDate: d(7) }),
    todo({ id: 'far', dueDate: d(30) }),
    todo({ id: 'nodue' })
  ];
  const b = E.dueBuckets(notes, NOW);
  assert.deepStrictEqual(ids(b.overdue), ['late']);
  assert.deepStrictEqual(ids(b.today), ['today']);
  assert.deepStrictEqual(ids(b.soon), ['in3', 'in7'], '本周应只含 1–7 天内到期的');
  assert.ok(!b.soon.some((n) => n.id === 'far'), '30 天后不应算本周');
  assert.ok(!b.soon.some((n) => n.id === 'nodue'), '无截止日不应进桶');
});

test('dueBuckets 忽略已完成与非待办', () => {
  const notes = [
    todo({ id: 'done', dueDate: d(-1), done: true, doneAt: NOW }),
    note({ id: 'idea', type: 'idea', dueDate: d(-1) }),
    todo({ id: 'open', dueDate: d(-1) })
  ];
  const b = E.dueBuckets(notes, NOW);
  assert.deepStrictEqual(ids(b.overdue), ['open']);
});

test('dueBuckets 逾期按日期升序，同日按优先级降序', () => {
  const notes = [
    todo({ id: 'b', dueDate: d(-1), priority: 'low' }),
    todo({ id: 'a', dueDate: d(-5), priority: 'low' }),
    todo({ id: 'c', dueDate: d(-1), priority: 'high' })
  ];
  const b = E.dueBuckets(notes, NOW);
  assert.deepStrictEqual(ids(b.overdue), ['a', 'c', 'b']);
});

test('dueBuckets 空数据不报错', () => {
  const b = E.dueBuckets([], NOW);
  assert.deepStrictEqual([b.overdue.length, b.today.length, b.soon.length], [0, 0, 0]);
});

test('todayStr 支持注入时间，便于测试', () => {
  assert.strictEqual(E.todayStr(NOW), '2026-06-15');
});
