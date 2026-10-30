'use strict';
/* 大模型流式输出（SSE）：解析器 + 端到端拼装 */
const test = require('node:test');
const assert = require('node:assert');
const { createSandbox, note } = require('./harness');

const enc = new TextEncoder();

/** 假响应：把若干字符串当成分片依次吐出 */
function fakeStream(chunks, opts = {}) {
  let i = 0;
  return {
    ok: opts.ok !== false,
    status: opts.status || 200,
    headers: { get: () => opts.ctype || 'text/event-stream' },
    body: {
      getReader() {
        return {
          read() {
            if (i >= chunks.length) return Promise.resolve({ done: true, value: undefined });
            return Promise.resolve({ done: false, value: enc.encode(chunks[i++]) });
          }
        };
      }
    },
    text: () => Promise.resolve(opts.body || '')
  };
}

function sse(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }
const piece = (t) => ({ choices: [{ delta: { content: t } }] });

/** 建一个配好密钥的沙箱，并把 fetch 换成给定的桩 */
function sandboxWith(fetchImpl) {
  const sb = createSandbox({ fetch: fetchImpl });
  sb.Store.load();
  sb.Store.config.apiKey = 'sk-test';
  sb.Store.config.baseUrl = 'https://example.invalid/v1';
  sb.Store.config.model = 'test-model';
  return sb;
}

test('splitSSE 按空行切事件，多行 data 拼成一条', () => {
  const sb = sandboxWith(() => Promise.reject(new Error('unused')));
  const r = sb.AI.__sse.split('data: a\n\ndata: b\n\n');
  assert.deepStrictEqual(Array.from(r.events), ['a', 'b']);
  assert.strictEqual(r.rest, '', '完整事件不应留残余');
});

test('splitSSE 保留半截事件，等下一个分片', () => {
  const sb = sandboxWith(() => Promise.reject(new Error('unused')));
  const r = sb.AI.__sse.split('data: {"x":1}\n\ndata: {"x":');
  assert.deepStrictEqual(Array.from(r.events), ['{"x":1}']);
  assert.strictEqual(r.rest, 'data: {"x":', '未闭合的事件必须留在缓冲区');
});

test('splitSSE 兼容 CRLF 与注释行', () => {
  const sb = sandboxWith(() => Promise.reject(new Error('unused')));
  const r = sb.AI.__sse.split(': keep-alive\r\n\r\ndata: hello\r\n\r\n');
  assert.deepStrictEqual(Array.from(r.events), ['hello'], '注释行不应变成内容');
});

test('deltaOf 只取增量，忽略 [DONE] 与坏 JSON', () => {
  const sb = sandboxWith(() => Promise.reject(new Error('unused')));
  const d = sb.AI.__sse.delta;
  assert.strictEqual(d(JSON.stringify(piece('你好'))), '你好');
  assert.strictEqual(d('[DONE]'), '');
  assert.strictEqual(d('not json'), '');
  assert.strictEqual(d(''), '');
  // 少数网关把整包 message 塞在流里
  assert.strictEqual(d(JSON.stringify({ choices: [{ message: { content: '整包' } }] })), '整包');
});

test('answerStream 边收边回调，并返回完整文本', async () => {
  const chunks = [
    sse(piece('先给')),
    sse(piece('结论')),   // 故意切成多个事件
    ': keep-alive\n\n',
    sse(piece('，再展开。')),
    'data: [DONE]\n\n'
  ];
  let sentBody = null;
  const sb = sandboxWith((url, opts) => {
    sentBody = JSON.parse(opts.body);
    return Promise.resolve(fakeStream(chunks));
  });

  const seen = [];
  const full = await sb.AI.answerStream('我在推进什么', [], '', [], (d, acc) => {
    seen.push([d, acc]);
  });

  assert.strictEqual(full, '先给结论，再展开。');
  assert.deepStrictEqual(seen.map((x) => x[0]), ['先给', '结论', '，再展开。'], '每段增量都要回调');
  assert.strictEqual(seen[2][1], '先给结论，再展开。', '累计全文应逐段增长');
  assert.strictEqual(sentBody.stream, true, '请求必须显式要求 stream');
});

test('分片从半个 UTF-8 汉字中间切断也能拼回', async () => {
  const payload = Buffer.from(sse(piece('中文不能乱码')), 'utf8');
  // 在字节层面切成两块，模拟网络把多字节字符劈开
  const cut = 30;
  const sb = sandboxWith(() => Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader() {
        const parts = [payload.subarray(0, cut), payload.subarray(cut)];
        let i = 0;
        return {
          read() {
            if (i >= parts.length) return Promise.resolve({ done: true, value: undefined });
            return Promise.resolve({ done: false, value: new Uint8Array(parts[i++]) });
          }
        };
      }
    },
    text: () => Promise.resolve('')
  }));
  const full = await sb.AI.answerStream('q', [], '', [], () => {});
  assert.strictEqual(full, '中文不能乱码');
});

test('网关无视 stream:true 直接返回整包 JSON 时也能出结果', async () => {
  const sb = sandboxWith(() => Promise.resolve(fakeStream([], {
    ctype: 'application/json',
    body: JSON.stringify({ choices: [{ message: { content: '整包回答' } }] })
  })));
  const seen = [];
  const full = await sb.AI.answerStream('q', [], '', [], (d) => seen.push(d));
  assert.strictEqual(full, '整包回答');
  assert.deepStrictEqual(seen, ['整包回答'], '兜底路径也要回调一次，界面才会渲染');
});

test('HTTP 错误带上状态码，交给上层决定是否降级', async () => {
  const sb = sandboxWith(() => Promise.resolve({
    ok: false,
    status: 401,
    headers: { get: () => 'application/json' },
    body: null,
    text: () => Promise.resolve(JSON.stringify({ error: { message: 'bad key' } }))
  }));
  await assert.rejects(
    () => sb.AI.answerStream('q', [], '', [], () => {}),
    (err) => {
      assert.strictEqual(err.status, 401);
      assert.ok(/API Key 无效/.test(err.message), '错误文案应可读：' + err.message);
      return true;
    }
  );
});

test('流里一个字都没有时报错，避免界面停在"生成中"', async () => {
  const sb = sandboxWith(() => Promise.resolve(fakeStream(['data: [DONE]\n\n'])));
  await assert.rejects(() => sb.AI.answerStream('q', [], '', [], () => {}), /返回为空/);
});

test('answerStream 会把检索到的资料带进 prompt', async () => {
  let body = null;
  const sb = sandboxWith((url, opts) => {
    body = JSON.parse(opts.body);
    return Promise.resolve(fakeStream([sse(piece('好')), 'data: [DONE]\n\n']));
  });
  const ctx = [{ note: note({ title: 'Q4 路线图', content: '投入产出比表格' }) }];
  await sb.AI.answerStream('路线图', ctx, '小林', [], () => {});
  const last = body.messages[body.messages.length - 1].content;
  assert.ok(last.includes('Q4 路线图') && last.includes('投入产出比'), '参考资料应在最后一条 user 消息里');
  assert.ok(body.messages[0].content.includes('小林'), '称呼应进 system prompt');
});
