'use strict';
/* engine.js 单元测试 —— 本地智能引擎的正确性基线 */
const test = require('node:test');
const assert = require('node:assert');
const { createSandbox, note } = require('./harness');

const sb = createSandbox();
const E = sb.Engine;

test('tokenize 抽出中文实词并过滤停用词', () => {
  const toks = E.tokenize('这个项目的知识管理方案需要重新整理');
  assert.ok(toks.includes('知识'), '应抽出「知识」：' + toks.join('/'));
  assert.ok(toks.includes('管理'), '应抽出「管理」：' + toks.join('/'));
  assert.ok(toks.includes('方案'), '应抽出「方案」：' + toks.join('/'));
  assert.ok(!toks.includes('这个'), '不应包含停用词「这个」');
  assert.ok(!toks.includes('需要'), '不应包含停用词「需要」');
});

test('tokenize 保留英文与数字串、忽略单字符', () => {
  const toks = E.tokenize('用 deepseek 和 GPT-4 做 RAG 检索');
  assert.ok(toks.some((t) => /deepseek/i.test(t)));
  assert.ok(toks.some((t) => /gpt-4/i.test(t)), '英文带连字符应整体成词：' + toks.join('/'));
  assert.ok(toks.some((t) => /rag/i.test(t)));
});

test('makeTitle 取首句并截断超长标题', () => {
  assert.strictEqual(E.makeTitle('第一句是标题。第二句是正文。'), '第一句是标题');
  const long = E.makeTitle('很长'.repeat(60));
  assert.ok(long.length <= 35, '标题应被截断到 35 字以内，实际 ' + long.length);
  assert.ok(long.endsWith('…'));
  assert.strictEqual(E.makeTitle('   '), '（无标题）');
  assert.strictEqual(E.makeTitle('# 带井号的标题\n正文'), '带井号的标题');
});

test('classify 区分待办 / 资料 / 想法', () => {
  assert.strictEqual(E.classify('明天下午三点前提交周报给张总'), 'todo');
  assert.strictEqual(E.classify('《卡片笔记写作法》摘录：笔记的价值在于建立连接，作者提到…'), 'material');
  assert.strictEqual(E.classify('我在想，如果把这个功能砍掉，用户会不会反而更轻松？'), 'idea');
  assert.strictEqual(E.classify('参考 https://example.com/post/123 这篇讲检索增强的文章'), 'material');
});

test('classify 真实语料回归表（短句不再一律判待办）', () => {
  const cases = [
    // [文本, 期望类型]
    ['明天下午三点前把 Q4 路线图发给张总，记得附上投入产出比表格。', 'todo'],
    ['路线图不要只列功能，要写清楚每个方向的投入产出比，否则评审时没法排序。', 'idea'],
    ['整理 Q4 产品路线图，把三个候选方向按投入产出比排序，下周三之前发出来。', 'todo'],
    ['《卡片笔记写作法》摘录：笔记的价值不在于收集，而在于建立连接。', 'material'],
    ['我在想，如果把这个功能砍掉，用户会不会反而更轻松？', 'idea'],
    ['买牛奶', 'todo'],
    ['明天开会', 'todo'],
    ['今天读到一个有意思的观点：记录的价值在于回顾。', 'idea'],
    ['待办清单越堆越长会让人焦虑。或许可以每天只推三件今日必做。', 'idea'],
    ['把健身计划重新排一下，这周三次力量训练，周末补一次有氧。', 'todo'],
    ['一篇关于检索增强的文章提到：先做关键词召回再交给模型总结，成本低一个数量级。', 'material'],
    ['要不要给记录加一个回顾提醒？', 'idea'],
    ['周五前把合同扫描件发给法务确认', 'todo'],
    ['感觉这个配色有点脏，可能换成暖灰会好一些', 'idea'],
    // 句首时间状语不能挡住后面的动词：这是最典型的待办句式
    ['明天交周报', 'todo'],
    ['今天要做完', 'todo'],
    ['下周把方案发我', 'todo'],
    ['月底前报销差旅费', 'todo'],
    ['这周读完这本书', 'todo'],
    ['今天读到一个有意思的观点：记录的价值在于回顾。', 'idea']
  ];
  const wrong = [];
  cases.forEach(([text, want]) => {
    const got = E.classify(text);
    if (got !== want) wrong.push({ text: text.slice(0, 24), want, got, score: E.classifyScore(text) });
  });
  assert.deepStrictEqual(wrong, [], '分类错误：\n' + wrong.map((w) =>
    `  「${w.text}」期望 ${w.want} 实得 ${w.got} ${JSON.stringify(w.score)}`).join('\n'));
});

test('detectDueDate 识别绝对与相对日期', () => {  const today = new Date();
  const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  assert.strictEqual(E.detectDueDate('今天要做完'), fmt(today));
  assert.strictEqual(E.detectDueDate('明天交'), fmt(new Date(today.getTime() + 86400000)));
  assert.strictEqual(E.detectDueDate('后天回复'), fmt(new Date(today.getTime() + 2 * 86400000)));
  assert.strictEqual(E.detectDueDate('2027-03-05 上线'), '2027-03-05');
  assert.strictEqual(E.detectDueDate('3 天内给答复'), fmt(new Date(today.getTime() + 3 * 86400000)));
});

test('detectDueDate 拒绝非法日期而不是静默溢出', () => {
  assert.strictEqual(E.detectDueDate('2026-13-45 交'), null);
  assert.strictEqual(E.detectDueDate('13月45日交'), null);
});

test('detectDueDate 下周三落在未来且是周三', () => {
  const got = E.detectDueDate('下周三之前发出来');
  assert.ok(got, '应识别出日期');
  const d = new Date(got + 'T12:00:00');
  assert.strictEqual(d.getDay(), 3, '应为周三');
  assert.ok(d.getTime() > Date.now(), '应晚于今天');
});

test('detectPriority 高 / 低 / 按截止日推断', () => {
  assert.strictEqual(E.detectPriority('这个很紧急，马上处理'), 'high');
  assert.strictEqual(E.detectPriority('有空再看，不急'), 'low');
  const tomorrow = new Date(Date.now() + 86400000);
  const s = tomorrow.getFullYear() + '-' + String(tomorrow.getMonth() + 1).padStart(2, '0') + '-' + String(tomorrow.getDate()).padStart(2, '0');
  assert.strictEqual(E.detectPriority('常规事项', s), 'high', '48 小时内到期应为高优先级');
});

test('extractiveSummary 返回非空且不超长', () => {
  const text = '信息管家的目标是让记录足够轻。回顾必须足够强，否则记录会变成垃圾场。因此每周要做一次阶段总结。';
  const s = E.extractiveSummary(text, 1);
  assert.ok(s.length > 0 && s.length < 80, '摘要长度异常：' + s.length);
});

test('keyPoints 提取多条要点且去重', () => {
  const text = '第一，记录要轻。第二，回顾要强。第三，关联要自动。第四，导出要自由。';
  const kp = E.keyPoints(text, 3);
  assert.ok(kp.length >= 1 && kp.length <= 3, '要点数量异常：' + kp.length);
});

test('search 命中关键词并按相关度排序', () => {
  const notes = [
    note({ id: 'a', title: '知识管理方案', content: '第二大脑与卡片笔记' }),
    note({ id: 'b', title: '健身计划', content: '每周三次力量训练' }),
    note({ id: 'c', title: '阅读摘录', content: '知识管理的核心是建立连接' })
  ];
  const hits = E.search(notes, '知识管理');
  assert.ok(hits.length >= 2, '应至少命中 2 条，实际 ' + hits.length);
  assert.ok(hits[0].note.id !== 'b', '无关记录不应排第一');
  assert.ok(hits[0].score >= hits[hits.length - 1].score, '应按分数降序');
});

test('search 空查询返回全部且分数为 0', () => {
  const notes = [note({ id: 'a', content: 'x' }), note({ id: 'b', content: 'y' })];
  const hits = E.search(notes, '   ');
  assert.strictEqual(hits.length, 2);
  assert.ok(hits.every((h) => h.score === 0));
});

test('search 识别待办意图并优先召回未完成项', () => {
  const notes = [
    note({ id: 'a', type: 'todo', title: '写周报', content: '写周报', done: false, priority: 'high' }),
    note({ id: 'b', type: 'todo', title: '买牛奶', content: '买牛奶', done: true }),
    note({ id: 'c', type: 'material', title: '一篇文章', content: '无关内容' })
  ];
  const hits = E.search(notes, '还有哪些没做的');
  assert.ok(hits.length > 0, '意图型提问应有召回');
  assert.strictEqual(hits[0].note.id, 'a', '未完成的高优先级待办应排第一');
});

test('pickContext 待办意图补齐全部未完成项', () => {
  const notes = [];
  for (let i = 0; i < 20; i++) {
    notes.push(note({ id: 't' + i, type: 'todo', title: '待办' + i, content: '待办' + i, done: false }));
  }
  const ctx = E.pickContext(notes, '还有哪些没做完的', 6);
  assert.strictEqual(ctx.length, 20, '待办意图应带全部 20 条，实际 ' + ctx.length);
});

test('relate 建立双向关联并排除自身', () => {
  const notes = [
    note({ id: 'a', title: '知识管理', content: '第二大脑 卡片笔记 知识管理', tags: ['知识管理'] }),
    note({ id: 'b', title: '卡片笔记', content: '卡片笔记 知识管理 建立连接', tags: ['知识管理'] }),
    note({ id: 'c', title: '健身', content: '力量训练 有氧 蛋白质', tags: ['健康'] })
  ];
  E.relate(notes);
  const a = notes.find((n) => n.id === 'a');
  assert.ok(a.related.length >= 1, 'a 应有相关记录');
  assert.ok(a.related.every((r) => r.id !== 'a'), '不应关联自己');
  assert.strictEqual(a.related[0].id, 'b', '最相关的应是 b');
  const c = notes.find((n) => n.id === 'c');
  assert.ok(c.related.every((r) => r.id !== 'c'));
});

test('relate 增量模式与全量模式结果一致', () => {
  const build = () => [
    note({ id: 'a', title: '甲', content: '产品 需求 评审' }),
    note({ id: 'b', title: '乙', content: '产品 需求 排期' }),
    note({ id: 'c', title: '丙', content: '健身 训练' })
  ];
  const full = build();
  E.relate(full);
  const inc = build();
  E.relate(inc, ['a']);
  const fa = full.find((n) => n.id === 'a').related.map((r) => r.id).sort();
  const ia = inc.find((n) => n.id === 'a').related.map((r) => r.id).sort();
  assert.deepStrictEqual(ia, fa, 'a 的关联应与全量结果一致');
});

test('stats 统计各类型与逾期', () => {
  const notes = [
    note({ id: '1', type: 'idea' }),
    note({ id: '2', type: 'todo', done: true, doneAt: Date.now() }),
    note({ id: '3', type: 'todo', done: false, dueDate: '2000-01-01' })
  ];
  const st = E.stats(notes, notes);
  assert.strictEqual(st.total, 3);
  assert.strictEqual(st.byType.todo, 2);
  assert.strictEqual(st.todoDone, 1);
  assert.strictEqual(st.todoOpen, 1);
  assert.strictEqual(st.overdue.length, 1, '过期未完成应计入逾期');
});

test('buildSummary 输出五段式 Markdown 且含关键数字', () => {
  const notes = [
    note({ id: '1', type: 'todo', title: '写周报', content: '写周报', done: false, priority: 'high' }),
    note({ id: '2', type: 'idea', title: '想法', content: '一个想法', tags: ['产品'] })
  ];
  const { markdown, stats } = E.buildSummary(notes, notes, 30);
  ['## 一、概览', '## 二、主要关注主题', '## 三、重点内容回顾', '## 四、待办与进展', '## 五、后续行动建议']
    .forEach((h) => assert.ok(markdown.includes(h), '缺少小节：' + h));
  assert.strictEqual(stats.total, 2);
  assert.ok(/共记录 \*\*2\*\* 条/.test(markdown), '概览应写明总数');
});

test('offlineAnswer 待办意图给出未完成清单', () => {
  const notes = [
    note({ id: 'a', type: 'todo', title: '写周报', content: '写周报', done: false }),
    note({ id: 'b', type: 'todo', title: '买牛奶', content: '买牛奶', done: true })
  ];
  const hits = E.pickContext(notes, '还有哪些没做完的', 6);
  const md = E.offlineAnswer('还有哪些没做完的', hits);
  assert.ok(md.includes('写周报'));
  assert.ok(/1\*\* 项未完成|1 项未完成/.test(md), '应报告 1 项未完成：' + md);
});

test('buildIndex 缓存命中后不重复计算', () => {
  const notes = [note({ id: 'a', content: '缓存 测试 内容' })];
  const i1 = E.buildIndex(notes);
  const i2 = E.buildIndex(notes);
  assert.strictEqual(i1, i2, '签名未变时应复用同一索引对象');
  notes.push(note({ id: 'b', content: '新增' }));
  const i3 = E.buildIndex(notes);
  assert.notStrictEqual(i3, i1, '记录数变化后应重建索引');
});

test('tokenize 对无词典词的短句也能抽出多个词（二元组兜底）', () => {
  const toks = E.tokenize('明天下午三点前把 Q4 路线图发给张总，记得附上投入产出比表格。');
  assert.ok(toks.length >= 8, '应抽出 8 个以上词，实际 ' + toks.length + '：' + toks.join('/'));
  assert.ok(toks.includes('路线') && toks.includes('投入'), '应包含「路线」「投入」：' + toks.join('/'));
  assert.ok(!toks.includes('的投'), '不应包含跨词边界的虚词碎片');
});

test('tokenizeWords 只返回词典成词（用于标签）', () => {
  const words = E.tokenizeWords('明天下午三点前把 Q4 路线图发给张总');
  assert.ok(words.every((w) => w === 'q4' || w.length >= 2));
  assert.ok(!words.includes('天下'), '不应把「天下」当成词');
});

test('buildIndex 在条数相同但内容不同时不复用旧索引', () => {
  const batch1 = [note({ id: 'a', content: '健身 力量 训练' }), note({ id: 'b', content: '牛肉 面食' })];
  E.buildIndex(batch1);
  // 同样 2 条、同样的时间戳，但内容完全换掉——旧实现会命中旧签名
  const batch2 = [note({ id: 'c', content: '产品 需求 评审' }), note({ id: 'd', content: '原型 交互 稿' })];
  const idx = E.buildIndex(batch2);
  assert.ok(idx.vs.c, '新数据必须重新建索引');
});

test('relate 判定表：相关要连上，无关要断开', () => {
  const cases = [
    ['明天下午三点前把 Q4 路线图发给张总，记得附上投入产出比表格。',
      '路线图不要只列功能，要写清楚每个方向的投入产出比，否则评审时没法排序。', true],
    ['产品需求评审定在周四，要提前把原型发给设计和开发。',
      '原型评审前需要把交互稿整理好，发给设计和开发确认。', true],
    ['健身计划：这周三次力量训练，周末补一次有氧。',
      '今天午饭吃了牛肉面，味道一般。', false],
    ['明天下午三点前把 Q4 路线图发给张总。',
      '健身计划：这周三次力量训练。', false]
  ];
  const bad = [];
  cases.forEach(([x, y, want], i) => {
    const a = note({ id: 'ra' + i, title: x, content: x });
    const b = note({ id: 'rb' + i, title: y, content: y });
    const notes = [a, b];
    E.relate(notes);
    const got = a.related.length > 0;
    if (got !== want) bad.push({ i: i + 1, want, got, score: a.related[0] && a.related[0].score });
  });
  assert.deepStrictEqual(bad, [], '关联判定错误：' + JSON.stringify(bad));
});
