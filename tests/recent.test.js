'use strict';
/* 最近搜索：命令面板的历史记录 */
const test = require('node:test');
const assert = require('node:assert');
const { createSandbox } = require('./harness');

const sb = createSandbox();
const S = sb.Store;

test('pushQuery 把新查询放在最前，重复的提到最前而不是再存一份', () => {
  S.load();
  S.pushQuery('知识管理');
  S.pushQuery('产品复盘');
  assert.deepStrictEqual(Array.from(S.recentQueries()), ['产品复盘', '知识管理']);

  S.pushQuery('知识管理');
  assert.deepStrictEqual(Array.from(S.recentQueries()), ['知识管理', '产品复盘'], '重复项应提到最前且不重复');
});

test('pushQuery 只留最近 8 条', () => {
  S.load();
  S.clearQueries();
  for (let i = 0; i < 12; i++) S.pushQuery('查询' + i);
  const list = Array.from(S.recentQueries());
  assert.strictEqual(list.length, 8);
  assert.strictEqual(list[0], '查询11', '最新的应在最前');
  assert.ok(!list.includes('查询0'), '最老的应被挤掉');
});

test('pushQuery 忽略空串与单字，避免历史被噪声填满', () => {
  S.load();
  S.clearQueries();
  S.pushQuery('');
  S.pushQuery('  ');
  S.pushQuery('我');
  S.pushQuery('a');
  assert.deepStrictEqual(Array.from(S.recentQueries()), []);
  S.pushQuery('ab');
  assert.deepStrictEqual(Array.from(S.recentQueries()), ['ab'], '两个字符起才收录');
});

test('pushQuery 折叠多余空白并截断超长查询', () => {
  S.load();
  S.clearQueries();
  S.pushQuery('  上周   关于产品   的想法  ');
  assert.strictEqual(S.recentQueries()[0], '上周 关于产品 的想法');
  S.pushQuery('长'.repeat(200));
  assert.strictEqual(S.recentQueries()[0].length, 60, '超长查询应截断，别把一整段正文塞进历史');
});

test('clearQueries 清空且不抛错', () => {
  S.load();
  S.pushQuery('要删掉的');
  S.clearQueries();
  assert.deepStrictEqual(Array.from(S.recentQueries()), []);
  S.clearQueries();   // 再清一次也不该炸
});

test('历史被写坏时退化为空数组', () => {
  sb.localStorage.setItem('info_butler_recent_q_v1', '{"not":"an array"}');
  assert.deepStrictEqual(Array.from(S.recentQueries()), []);
  sb.localStorage.setItem('info_butler_recent_q_v1', '不是 JSON');
  assert.deepStrictEqual(Array.from(S.recentQueries()), []);
});
