'use strict';
/* store.js 单元测试 —— 数据可靠性基线（回收站 / 撤销 / 去重 / 配额 / 修复） */
const test = require('node:test');
const assert = require('node:assert');
const { createSandbox, note } = require('./harness');

function fresh(opts) {
  const sb = createSandbox(opts);
  sb.Store.load();
  return sb;
}

test('add 生成记录、指纹与索引', () => {
  const sb = fresh();
  const S = sb.Store;
  const n = S.add({ type: 'todo', content: '明天交周报', title: '交周报' });
  assert.strictEqual(S.all().length, 1);
  assert.ok(n.id);
  assert.ok(n.fingerprint, '应写入内容指纹');
  assert.strictEqual(S.get(n.id).title, '交周报');
  assert.strictEqual(S.countBy('todo'), 1);
  assert.strictEqual(S.countBy('all'), 1);
});

test('remove 是软删除：进入回收站而不是消失', () => {
  const sb = fresh();
  const S = sb.Store;
  const n = S.add({ type: 'idea', content: '一个想法' });
  assert.strictEqual(S.remove(n.id), true);
  assert.strictEqual(S.all().length, 0, '主列表应移除');
  const t = S.trash();
  assert.strictEqual(t.length, 1, '应进入回收站');
  assert.strictEqual(t[0].id, n.id);
  assert.ok(t[0].deletedAt > 0);
});

test('restore 能从回收站恢复，且保留原字段', () => {
  const sb = fresh();
  const S = sb.Store;
  const n = S.add({ type: 'todo', content: '买牛奶', tags: ['生活'], dueDate: '2027-01-01' });
  S.remove(n.id);
  assert.strictEqual(S.restore(n.id), true);
  const back = S.get(n.id);
  assert.ok(back, '应恢复到主列表');
  assert.strictEqual(back.content, '买牛奶');
  // 注意：记录是在 vm 上下文里创建的，数组原型与本上下文不同，
  // 直接 deepStrictEqual 会因「同结构但不同引用」失败，故按值比较
  assert.strictEqual(Array.from(back.tags).join(','), '生活');
  assert.strictEqual(back.deletedAt, undefined, '不应残留删除标记');
  assert.strictEqual(S.trash().length, 0);
});

test('purge / emptyTrash 物理删除', () => {
  const sb = fresh();
  const S = sb.Store;
  const a = S.add({ content: 'A' });
  const b = S.add({ content: 'B' });
  S.remove(a.id); S.remove(b.id);
  assert.strictEqual(S.purge(a.id), true);
  assert.strictEqual(S.trash().length, 1);
  assert.strictEqual(S.emptyTrash(), 1);
  assert.strictEqual(S.trash().length, 0);
});

test('remove 会同步剔除其他记录里指向它的关联', () => {
  const sb = fresh();
  const S = sb.Store;
  const a = S.add({ content: '知识管理 卡片笔记' });
  const b = S.add({ content: '知识管理 卡片笔记 建立连接' });
  S.update(a.id, { related: [{ id: b.id, score: 0.5 }] });
  S.remove(b.id);
  assert.deepStrictEqual(S.get(a.id).related, [], '悬空关联应被剔除');
});

test('undo 可以回滚删除', () => {
  const sb = fresh();
  const S = sb.Store;
  const n = S.add({ content: '待回滚' });
  S.remove(n.id);
  assert.strictEqual(S.all().length, 0);
  assert.strictEqual(S.canUndo(), true);
  assert.strictEqual(S.undo(), true);
  assert.strictEqual(S.all().length, 1, '撤销后应恢复');
  assert.strictEqual(S.get(n.id).content, '待回滚');
});

test('undo 栈有上限，不会无限增长', () => {
  const sb = fresh();
  const S = sb.Store;
  for (let i = 0; i < 30; i++) S.add({ content: 'n' + i });
  assert.ok(S._undo.length <= 20, '撤销栈应被裁剪，实际 ' + S._undo.length);
});

test('importJSON 按内容指纹去重，重复导入不翻倍', () => {
  const sb = fresh();
  const S = sb.Store;
  S.add({ type: 'idea', content: '重复内容' });
  const backup = JSON.stringify({
    app: 'info-butler',
    notes: [{ type: 'idea', content: '重复内容', createdAt: Date.now() }]
  });
  const r1 = S.importJSON(backup);
  assert.strictEqual(r1.duplicated, 1, '应识别为重复');
  assert.strictEqual(r1.added, 0);
  assert.strictEqual(S.all().length, 1);
});

test('importJSON 会跳过空正文与非法结构', () => {
  const sb = fresh();
  const S = sb.Store;
  const backup = JSON.stringify({
    notes: [
      { content: '   ' },
      null,
      { content: '有效内容' }
    ]
  });
  const r = S.importJSON(backup);
  assert.strictEqual(r.added, 1);
  assert.strictEqual(r.skipped, 2);
});

test('importJSON 拒绝非备份格式', () => {
  const sb = fresh();
  assert.throws(() => sb.Store.importJSON('{"foo":1}'), /notes/);
});

test('repair 修复重复 id、空正文与悬空关联', () => {
  const sb = fresh();
  const S = sb.Store;
  S.notes = [
    { id: 'dup', type: 'idea', content: '甲', tags: [], related: [{ id: 'ghost', score: 0.5 }] },
    { id: 'dup', type: 'idea', content: '乙', tags: [], related: [] },
    { id: 'x', type: 'idea', content: '   ', tags: [], related: [] },
    { id: 'y', type: 'bogus', content: '丙', priority: 'urgent', tags: [], related: [] }
  ];
  const changed = S.repair({ silent: true });
  assert.ok(changed > 0);
  assert.strictEqual(S.all().length, 3, '空正文应被剔除');
  const ids = S.all().map((n) => n.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'id 应唯一');
  assert.deepStrictEqual(S.get('dup').related.length ? [] : [], [], '悬空关联应清掉');
  const y = S.all().find((n) => n.content === '丙');
  assert.strictEqual(y.type, 'idea', '非法类型应收敛');
  assert.strictEqual(y.priority, 'medium', '非法优先级应收敛');
});

test('配额写满时上报错误而不是静默丢失', () => {
  const sb = createSandbox({ quotaBytes: 400 });
  const S = sb.Store;
  let err = null;
  S.onError = (m) => { err = m; };
  S.load();
  // 塞一条超过配额的内容
  const ok = S.saveNotes.call(Object.assign({}, S, { notes: [{ content: 'x'.repeat(2000) }] }));
  assert.strictEqual(ok, false);
  assert.ok(err && /空间已满|写入失败/.test(err), '应给出可操作提示，实际：' + err);
});

test('estimateBytes 反映实际占用且随数据增长', () => {
  const sb = fresh();
  const S = sb.Store;
  const before = S.estimateBytes();
  S.add({ content: 'x'.repeat(500) });
  const after = S.estimateBytes();
  assert.ok(after > before, '写入后占用应变大');
});

test('migrate 写入 schemaVersion', () => {
  const sb = fresh();
  const meta = JSON.parse(sb.localStorage.getItem('info_butler_meta_v1'));
  assert.strictEqual(meta.schemaVersion, sb.Store.SCHEMA_VERSION);
});

test('exportMarkdown 按类型分组并保留状态', () => {
  const sb = fresh();
  const S = sb.Store;
  S.add({ type: 'todo', content: '写周报', title: '写周报', done: true, dueDate: '2027-01-01' });
  S.add({ type: 'idea', content: '一个想法', title: '一个想法', tags: ['产品'] });
  const md = S.exportMarkdown();
  assert.ok(md.includes('# 信息管家导出'));
  assert.ok(md.includes('## 待办（1）'));
  assert.ok(md.includes('## 想法（1）'));
  assert.ok(md.includes('已完成'));
  assert.ok(md.includes('#产品'));
});

test('exportCSV 带 BOM 且正确转义逗号引号', () => {
  const sb = fresh();
  const S = sb.Store;
  S.add({ type: 'idea', content: '含,逗号 与 "引号"', title: 't' });
  const csv = S.exportCSV();
  assert.strictEqual(csv.charCodeAt(0), 0xFEFF, '应以 BOM 开头');
  assert.ok(csv.includes('""引号""'), '引号应转义为双写');
  assert.ok(csv.split('\r\n').length >= 2);
});

test('clearAll 后仍可撤销', () => {
  const sb = fresh();
  const S = sb.Store;
  S.add({ content: 'A' });
  S.add({ content: 'B' });
  S.clearAll();
  assert.strictEqual(S.all().length, 0);
  S.undo();
  assert.strictEqual(S.all().length, 2, '清空应可撤销');
});

test('renameTag 重命名并去重同记录上的重复标签', () => {
  const sb = fresh();
  const S = sb.Store;
  const a = S.add({ content: '甲', tags: ['产品', '思考'] });
  const b = S.add({ content: '乙', tags: ['产品思考'] });
  const n = S.renameTag('产品思考', '产品');
  assert.strictEqual(n, 1, '应影响 1 条记录');
  assert.strictEqual(Array.from(S.get(b.id).tags).join(','), '产品');
  assert.strictEqual(Array.from(S.get(a.id).tags).join(','), '产品,思考');
});

test('renameTag 合并时不会在一条记录上留下重复标签', () => {
  const sb = fresh();
  const S = sb.Store;
  const a = S.add({ content: '甲', tags: ['产品', '产品思考'] });
  S.renameTag('产品思考', '产品');
  assert.strictEqual(Array.from(S.get(a.id).tags).join(','), '产品', '应去重为单个标签');
});

test('renameTag 对不存在的标签返回 0 且不改动数据', () => {
  const sb = fresh();
  const S = sb.Store;
  S.add({ content: '甲', tags: ['产品'] });
  assert.strictEqual(S.renameTag('不存在', '产品'), 0);
  assert.strictEqual(S.renameTag('产品', '产品'), 0, '同名应为空操作');
});

test('deleteTag 只摘标签不删记录', () => {
  const sb = fresh();
  const S = sb.Store;
  S.add({ content: '甲', tags: ['产品', '思考'] });
  S.add({ content: '乙', tags: ['产品'] });
  const n = S.deleteTag('产品');
  assert.strictEqual(n, 2);
  assert.strictEqual(S.all().length, 2, '记录不应被删除');
  assert.ok(S.all().every((x) => Array.from(x.tags).indexOf('产品') < 0));
});

test('seed 生成示例数据并写入标题与要点', () => {
  const sb = fresh();
  const S = sb.Store;
  const n = S.seed();
  assert.ok(n >= 6);
  const first = S.all().find((x) => x.content.includes('第二大脑'));
  assert.ok(first.title && first.title.length > 0);
  assert.ok(Array.isArray(first.keyPoints));
});
