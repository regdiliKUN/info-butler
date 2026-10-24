/* ===========================================================
 * ai.js —— 大模型适配层（OpenAI 兼容 /chat/completions）
 * 未配置密钥或调用失败时，上层自动回退到本地引擎，功能不中断。
 * =========================================================== */
(function (global) {
  'use strict';

  var TIMEOUT = 60000;

  function cfg() { return Store.config || {}; }

  function ready() {
    var c = cfg();
    return !!(c.apiKey && c.baseUrl && c.model);
  }

  function endpoint() {
    var base = (cfg().baseUrl || '').replace(/\/+$/, '');
    return base + '/chat/completions';
  }

  /**
   * 部分服务商 / 中转网关不认识 response_format=json_object，会直接 400。
   * 遇到 400 时自动去掉该参数重试一次，JSON 由 parseJSON 从纯文本里兜底解析。
   */
  function request(messages, opts) {
    return requestOnce(messages, opts).catch(function (err) {
      if (opts && opts.json && err && err.status === 400) {
        var retry = Object.assign({}, opts, { json: false });
        return requestOnce(messages, retry);
      }
      throw err;
    });
  }

  function requestOnce(messages, opts) {
    opts = opts || {};
    var c = cfg();
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, opts.timeout || TIMEOUT);

    var body = {
      model: c.model,
      messages: messages,
      temperature: opts.temperature != null ? opts.temperature : 0.3,
      stream: false
    };
    if (opts.json) body.response_format = { type: 'json_object' };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;

    return fetch(endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + c.apiKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    }).then(function (res) {
      clearTimeout(timer);
      return res.text().then(function (txt) {
        if (!res.ok) {
          var e = new Error(readableError(res.status, txt));
          e.status = res.status;      // 交给上层判断是否值得降级重试
          throw e;
        }
        var data;
        try { data = JSON.parse(txt); } catch (e) { throw new Error('返回内容不是合法 JSON'); }
        var content = data &&
          data.choices && data.choices[0] &&
          data.choices[0].message && data.choices[0].message.content;
        if (!content) throw new Error('模型返回为空');
        return content;
      });
    }).catch(function (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error('请求超时，请稍后重试');
      if (err instanceof TypeError) throw new Error('网络请求失败：可能是跨域限制或网络不通，可换用支持浏览器直连的服务商');
      throw err;
    });
  }

  function readableError(status, txt) {
    var msg = '';
    try {
      var j = JSON.parse(txt);
      msg = (j.error && (j.error.message || j.error.code)) || j.message || '';
    } catch (e) { msg = (txt || '').slice(0, 120); }
    var map = {
      401: 'API Key 无效或已过期',
      403: '没有该模型的访问权限',
      404: '接口地址或模型名不存在',
      429: '请求过于频繁或额度不足',
      500: '服务端错误',
      503: '服务暂时不可用'
    };
    return (map[status] || ('请求失败（' + status + '）')) + (msg ? '：' + msg : '');
  }

  /** 从模型输出里抠出 JSON，兼容不带 json mode 的服务 */
  function parseJSON(text) {
    var s = String(text).trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    var start = s.indexOf('{');
    var end = s.lastIndexOf('}');
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
    try {
      return JSON.parse(s);
    } catch (e) {
      throw new Error('模型返回格式无法解析');
    }
  }

  function normalizeList(v, max) {
    if (!v) return [];
    var arr = Array.isArray(v) ? v : String(v).split(/[,，、;；]/);
    return arr.map(function (x) { return String(x).trim().replace(/^#/, ''); })
      .filter(function (x) { return x && x.length <= 16; })
      .slice(0, max || 6);
  }

  var TYPES = ['idea', 'material', 'todo'];

  function normType(v) {
    var s = String(v || '').toLowerCase().trim();
    if (TYPES.indexOf(s) >= 0) return s;
    if (/待办|todo|task/.test(s)) return 'todo';
    if (/资料|材料|摘录|note|material|reference/.test(s)) return 'material';
    return 'idea';
  }

  function normPrio(v) {
    var s = String(v || '').toLowerCase().trim();
    if (/high|高|紧急|重要/.test(s)) return 'high';
    if (/low|低/.test(s)) return 'low';
    return 'medium';
  }

  /* ---------------- 对外能力 ---------------- */

  var AI = {
    ready: ready,

    test: function () {
      return request([{ role: 'user', content: '回复两个字：正常' }], { maxTokens: 16 })
        .then(function (t) { return t.trim().slice(0, 40) || '正常'; });
    },

    /** 单条记录的结构化处理 */
    analyze: function (text, domains) {
      var sys = '你是个人信息管家。对用户输入做结构化处理，只输出 JSON，不要任何解释。字段：' +
        'type(idea|material|todo)、title(≤20字)、summary(≤50字)、tags(数组，2-4个中文关键词)、' +
        'priority(high|medium|low)、dueDate(YYYY-MM-DD 或 null)、keyPoints(数组，2-3条要点，每条≤30字)。' +
        '判定规则：表达要做的事/有明确动作和时间 → todo；摘录、引用、资料、链接、读书笔记 → material；' +
        '感想、灵感、推测、观点 → idea。没有明确时间时 dueDate 为 null。' +
        (domains ? '用户关注领域：' + domains + '，打标签时优先参考。' : '');

      return request([
        { role: 'system', content: sys },
        { role: 'user', content: String(text).slice(0, 4000) }
      ], { json: true, temperature: 0.2 }).then(function (raw) {
        var o = parseJSON(raw);
        return {
          type: normType(o.type),
          title: String(o.title || '').slice(0, 40) || Engine.makeTitle(text),
          summary: String(o.summary || '').slice(0, 200),
          tags: normalizeList(o.tags, 5),
          priority: normPrio(o.priority),
          dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(o.dueDate || '')) ? o.dueDate : Engine.detectDueDate(text),
          keyPoints: normalizeList(o.keyPoints, 3).map(function (s) { return s.slice(0, 60); })
        };
      });
    },

    /**
     * 检索增强问答
     * @param {Array} [history] 最近若干轮 [{q, a}]，用于支持「再详细点」这类追问
     */
    answer: function (question, contexts, userName, history) {
      var sys = '你是用户的个人信息管家。只能依据下面「参考资料」回答，不要编造。' +
        '回答用中文，简洁有条理，先给结论再展开，必要时分点。' +
        '引用时在句末用 [1][2] 标注对应资料编号。若资料不足，直接说明资料里没有相关内容。' +
        (userName ? '用户称呼：' + userName + '。' : '');

      var ctx = contexts.map(function (c, i) {
        var n = c.note;
        return '[' + (i + 1) + '] ' + (n.title || '') + '\n' +
          String(n.content || '').slice(0, 900) + '\n' +
          '标签：' + (n.tags || []).join('、') +
          (n.type === 'todo' ? ('　状态：' + (n.done ? '已完成' : '未完成') + (n.dueDate ? '　截止：' + n.dueDate : '')) : '');
      }).join('\n\n');

      var msgs = [{ role: 'system', content: sys }];
      // 只带最近 2 轮，避免上下文无限膨胀
      (history || []).slice(-2).forEach(function (h) {
        if (!h || !h.q) return;
        msgs.push({ role: 'user', content: h.q });
        msgs.push({ role: 'assistant', content: String(h.a || '').slice(0, 1200) });
      });
      msgs.push({ role: 'user', content: '参考资料：\n' + ctx + '\n\n问题：' + question });

      return request(msgs, { temperature: 0.4 });
    },

    /** 阶段总结与行动建议 */
    summarize: function (rangeNotes, days, userName) {
      var sys = '你是用户的个人信息管家。基于给定的记录写一份阶段总结，用 Markdown。' +
        '结构固定为：## 一、概览 / ## 二、主要关注主题 / ## 三、重点内容回顾 / ## 四、待办与进展 / ## 五、后续行动建议。' +
        '要求：只基于给定内容，不编造；建议部分要具体可执行，写明做什么和为什么，最多 5 条；语言克制，不空话。' +
        (userName ? '用户称呼：' + userName + '。' : '');

      var dump = rangeNotes.slice(0, 120).map(function (n, i) {
        return (i + 1) + '. [' + n.type + '] ' + (n.title || '') + '\n' +
          String(n.content || '').slice(0, 500) + '\n' +
          '标签：' + (n.tags || []).join('、') +
          (n.type === 'todo' ? ('　状态：' + (n.done ? '已完成' : '未完成') + (n.dueDate ? '　截止：' + n.dueDate : '')) : '');
      }).join('\n');

      return request([
        { role: 'system', content: sys },
        { role: 'user', content: '时间范围：' + (days ? ('近 ' + days + ' 天') : '全部') + '\n记录共 ' + rangeNotes.length + ' 条：\n\n' + dump }
      ], { temperature: 0.5 });
    },

    /** 从零散记录中整理出待办 */
    organizeTodos: function (notes) {
      var sys = '你是个人信息管家。从下面的记录中抽取所有"尚未完成、需要行动"的事项，' +
        '只输出 JSON 数组，每项字段：title(≤24字，动词开头)、priority(high|medium|low)、' +
        'dueDate(YYYY-MM-DD 或 null)、source(来自第几条，数字)、reason(≤20字，为什么算待办)。' +
        '已明确完成的不要列入；没有可抽取的事项就返回空数组。';

      var dump = notes.slice(0, 60).map(function (n, i) {
        return (i + 1) + '. [' + n.type + (n.done ? '/已完成' : '') + '] ' + String(n.content || '').slice(0, 400);
      }).join('\n');

      return request([
        { role: 'system', content: sys },
        { role: 'user', content: dump }
      ], { json: true, temperature: 0.2 }).then(function (raw) {
        var o = parseJSON(raw);
        var arr = Array.isArray(o) ? o : (o.items || o.todos || []);
        return arr.map(function (x) {
          return {
            title: String(x.title || '').slice(0, 60),
            priority: normPrio(x.priority),
            dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(x.dueDate || '')) ? x.dueDate : null,
            reason: String(x.reason || '').slice(0, 60)
          };
        }).filter(function (x) { return x.title; }).slice(0, 12);
      });
    },

    /** 批量提取重点 */
    extract: function (note) {
      var sys = '你是个人信息管家。为下面这条记录输出 JSON：summary(≤60字摘要)、keyPoints(数组，2-3条要点，每条≤30字)。只输出 JSON。';
      return request([
        { role: 'system', content: sys },
        { role: 'user', content: (note.title || '') + '\n' + String(note.content || '').slice(0, 3000) }
      ], { json: true, temperature: 0.2 }).then(function (raw) {
        var o = parseJSON(raw);
        return {
          summary: String(o.summary || '').slice(0, 200),
          keyPoints: normalizeList(o.keyPoints, 3).map(function (s) { return s.slice(0, 60); })
        };
      });
    }
  };

  global.AI = AI;
})(window);
