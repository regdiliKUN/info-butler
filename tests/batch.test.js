'use strict';
/* 批量事务：一次快照 + 一次落盘 */
const test = require('node:test');
const assert = require('node:assert');
const { createSandbox } = require('./harness');

function fresh() {
  const sb = createSandbox();
  sb.Store.load();
  return sb;
}

test('batchUpdate 只改选中的记录', () => {
  const sb = fresh();
  const S = sb.Store;
  const a = S.add({ content: '甲', type: 'idea' });
  const b = S.add({ content: '乙', type: 'idea' });
  const c = S.add({ content: '丙', type: 'idea' });

  const n = S.batchUpdate([a.id, c.id], { type: 'material' });
  assert.strictEqual(n, 2);
  assert.strictEqual(S.get(a.id).type, 'material');
  assert.strictEqual(S.get(c.id).type, 'material');
  assert.strictEqual(S.get(b.id).type, 'idea', '未选中的不应被改');
});

test('batchUpdate 支持按条计算 patch', () => {
  const sb = fresh();
  const S = sb.Store;
  const a = S.add({ content: '甲' });
  const b = S.add({ content: '乙' });

  S.batchUpdate([a.id, b.id], function (note) {
    return { summary: '摘要：' + note.content };
  });
  assert.strictEqual(S.get(a.id).summary, '摘要：甲');
  assert.strictEqual(S.get(b.id).summary, '摘要：乙');
});

test('batchUpdate 只落盘一次（不是 N 次）', () => {
  const sb = fresh();
  const S = sb.Store;
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(S.add({ content: '条目' + i }).id);

  let saves = 0;
  const realSave = S.saveNotes.bind(S);
  S.saveNotes = function () { saves++; return realSave(); };

  S.batchUpdate(ids, { priority: 'high' });
  assert.strictEqual(saves, 1, '5 条应只写一次库，实际 ' + saves);
});

test('batchUpdate 可整体撤销', () => {
  const sb = fresh();
  const S = sb.Store;
  const a = S.add({ content: '甲', type: 'idea' });
  S.batchUpdate([a.id], { type: 'todo' });
  assert.strictEqual(S.get(a.id).type, 'todo');
  assert.ok(S.undo(), '应有可撤销的步骤');
  assert.strictEqual(S.get(a.id).type, 'idea', '撤销后应回到改之前');
});

test('batchRemove 移入回收站而不是物理删除', () => {
  const sb = fresh();
  const S = sb.Store;
  const a = S.add({ content: '甲' });
  const b = S.add({ content: '乙' });
  const c = S.add({ content: '丙' });

  const n = S.batchRemove([a.id, b.id]);
  assert.strictEqual(n, 2);
  assert.strictEqual(S.all().length, 1, '活跃列表应只剩 1 条');
  const trash = S.trash();
  assert.strictEqual(trash.length, 2, '回收站应有 2 条');
  assert.ok(trash.some((x) => x.id === a.id));
  assert.ok(S.get(c.id), '未选中的不应被删');
});

test('batchRemove 后可恢复', () => {
  const sb = fresh();
  const S = sb.Store;
  const a = S.add({ content: '甲' });
  S.batchRemove([a.id]);
  S.restore(a.id);
  assert.strictEqual(S.all().length, 1);
  assert.ok(!S.get(a.id).deletedAt, '恢复后不应带删除标记');
});

test('空选择是安全操作', () => {
  const sb = fresh();
  const S = sb.Store;
  S.add({ content: '甲' });
  assert.strictEqual(S.batchUpdate([], { type: 'todo' }), 0);
  assert.strictEqual(S.batchRemove([]), 0);
  assert.strictEqual(S.all().length, 1);
});
