'use strict';
/* 到期通知：文案压缩（dueDigest）+ 每天一次的去重状态 */
const test = require('node:test');
const assert = require('node:assert');
const { createSandbox, note } = require('./harness');

const sb = createSandbox();
const E = sb.Engine;
const S = sb.Store;

const todo = (over) => note(Object.assign({ type: 'todo', title: 't', content: 't' }, over));

test('dueDigest 只报最紧急的一档：逾期压过今天与本周', () => {
  const b = {
    overdue: [todo({ title: '交季度报告' })],
    today: [todo({ title: '回邮件' })],
    soon: [todo({ title: '订机票' })]
  };
  const d = E.dueDigest(b);
  assert.strictEqual(d.level, 'overdue');
  assert.strictEqual(d.title, '有 1 项待办已逾期');
  assert.ok(d.body.includes('交季度报告'), '正文应带上具体待办：' + d.body);
  assert.ok(!d.body.includes('回邮件'), '不该把三档混在一条通知里');
});

test('dueDigest 没有逾期时报今天，再没有才报本周', () => {
  assert.strictEqual(E.dueDigest({ overdue: [], today: [todo()], soon: [todo()] }).level, 'today');
  assert.strictEqual(E.dueDigest({ overdue: [], today: [], soon: [todo()] }).level, 'soon');
  assert.strictEqual(E.dueDigest({ overdue: [], today: [todo(), todo()], soon: [] }).title, '今天有 2 项待办到期');
});

test('dueDigest 全空返回 null，调用方据此不发通知', () => {
  assert.strictEqual(E.dueDigest({ overdue: [], today: [], soon: [] }), null);
  assert.strictEqual(E.dueDigest(null), null, '没传参数也不该炸');
});

test('dueDigest 正文最多 3 条，其余折叠成计数', () => {
  const list = [1, 2, 3, 4, 5].map((i) => todo({ title: '任务' + i }));
  const d = E.dueDigest({ overdue: list, today: [], soon: [] });
  const lines = d.body.split('\n');
  assert.strictEqual(lines.length, 4, '3 条明细 + 1 行折叠');
  assert.ok(/…等 5 项/.test(lines[3]), '折叠行应给出总数：' + lines[3]);
});

test('dueDigest 超长标题截断，并保留截止日', () => {
  const long = '这是一个特别特别长的待办标题用来测试截断逻辑是否生效';
  const d = E.dueDigest({ overdue: [todo({ title: long, dueDate: '2026-06-01' })], today: [], soon: [] });
  assert.ok(d.body.length < long.length + 20, '正文不该原样塞进整条长标题');
  assert.ok(d.body.includes('…'), '应出现省略号');
  assert.ok(d.body.includes('2026-06-01'), '截止日要保留，用户才知道拖了多久');
});

test('通知去重状态独立存放，不污染配置', () => {
  S.load();
  assert.deepStrictEqual(Object.keys(S.notifyState()), [], '初始应为空对象');

  S.markNotified('2026-06-15', 'overdue');
  assert.strictEqual(S.notifyState().date, '2026-06-15');
  assert.strictEqual(S.notifyState().sig, 'overdue');

  // 配置里不该出现通知痕迹，否则会跟着备份导出到另一台机器
  const cfg = JSON.parse(sb.localStorage.getItem('info_butler_config_v1') || '{}');
  assert.ok(!('date' in cfg) && !('sig' in cfg), '配置项不应被写入通知状态');
});

test('通知去重状态写坏时退化为空对象而不是抛错', () => {
  sb.localStorage.setItem('info_butler_notify_v1', '{坏掉的 JSON');
  assert.deepStrictEqual(Object.keys(S.notifyState()), [], '解析失败应静默兜底');
});
