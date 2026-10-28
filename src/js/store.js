/* ===========================================================
 * store.js —— 本地数据层
 * 数据结构持久化在浏览器 localStorage，支持导出 / 导入备份。
 * =========================================================== */
(function (global) {
  'use strict';

  var KEY_DATA = 'info_butler_notes_v1';
  var KEY_CONF = 'info_butler_config_v1';

  var DEFAULT_CONFIG = {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    userName: '',
    domains: '',
    autoTag: true
  };

  var PROVIDERS = {
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    custom: { baseUrl: '', model: '' }
  };

  var MAX_CONTENT = 20000;                                  // 单条正文上限，防止撑爆 localStorage
  var VALID_TYPES = ['idea', 'material', 'todo', 'summary'];
  var VALID_PRIO = ['high', 'medium', 'low'];

  function uid() {
    return 'n_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  /** 生成标题的兜底：Engine 尚未加载时（如单元测试）退化为直接截断 */
  function fallbackTitle(content) {
    if (typeof Engine !== 'undefined' && Engine && Engine.makeTitle) return Engine.makeTitle(content);
    return content.slice(0, 34);
  }

  function safeParse(raw, fallback) {
    if (!raw) return fallback;
    try {
      var v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  var Store = {
    notes: [],
    config: null,
    _index: null,          // id → note 的索引，避免列表页每条都做线性查找
    onError: null,         // 写入失败等错误的通知回调，由界面层注册

    /* ---------- 载入 / 保存 ---------- */
    load: function () {
      this.notes = safeParse(localStorage.getItem(KEY_DATA), []);
      if (!Array.isArray(this.notes)) this.notes = [];
      this.config = Object.assign({}, DEFAULT_CONFIG, safeParse(localStorage.getItem(KEY_CONF), {}));
      this._index = null;
      return this;
    },

    saveNotes: function () {
      try {
        localStorage.setItem(KEY_DATA, JSON.stringify(this.notes));
        return true;
      } catch (e) {
        // 最常见是配额写满：必须让用户知道，否则改动悄悄丢失
        var msg = (e && e.name === 'QuotaExceededError')
          ? '本地存储空间已满，本次改动没能保存。建议先导出备份，再删除一些历史记录。'
          : '本地存储写入失败：' + ((e && e.message) || '未知原因');
        console.error('保存失败', e);
        if (this.onError) this.onError(msg);
        return false;
      }
    },

    saveConfig: function () {
      localStorage.setItem(KEY_CONF, JSON.stringify(this.config));
    },

    /* ---------- 增删改查 ---------- */
    all: function () {
      return this.notes;
    },

    get: function (id) {
      if (!id) return null;
      if (!this._index) {
        this._index = {};
        for (var i = 0; i < this.notes.length; i++) this._index[this.notes[i].id] = this.notes[i];
      }
      var n = this._index[id];
      // 索引可能与列表不同步（外部直接改过 notes），兜底做一次线性查找
      if (!n) {
        for (var j = 0; j < this.notes.length; j++) {
          if (this.notes[j].id === id) { n = this.notes[j]; this._index[id] = n; break; }
        }
      }
      return n || null;
    },

    add: function (data) {
      var now = Date.now();
      var note = {
        id: uid(),
        type: data.type || 'idea',
        title: data.title || '',
        content: (typeof data.content === 'string' && data.content.length > MAX_CONTENT)
          ? data.content.slice(0, MAX_CONTENT)
          : (data.content || ''),
        tags: Array.isArray(data.tags) ? data.tags.slice(0, 8) : [],
        priority: data.priority || 'medium',
        dueDate: data.dueDate || null,
        done: !!data.done,
        doneAt: data.doneAt || null,
        pinned: !!data.pinned,
        summary: data.summary || '',
        keyPoints: Array.isArray(data.keyPoints) ? data.keyPoints : [],
        related: Array.isArray(data.related) ? data.related : [],
        aiTagged: !!data.aiTagged,
        createdAt: data.createdAt || now,
        updatedAt: now
      };
      if (note.done && !note.doneAt) note.doneAt = now;
      this.notes.unshift(note);
      this._index = null;
      this.saveNotes();
      return note;
    },

    update: function (id, patch) {
      var n = this.get(id);
      if (!n) return null;
      Object.keys(patch).forEach(function (k) { n[k] = patch[k]; });
      // 与 add 一致：防止超长正文把 localStorage 撑爆（导入路径已在 sanitize 截断）
      if (n.content && n.content.length > MAX_CONTENT) n.content = n.content.slice(0, MAX_CONTENT);
      n.updatedAt = Date.now();
      if (patch.done === true && !n.doneAt) n.doneAt = Date.now();
      if (patch.done === false) n.doneAt = null;
      this.saveNotes();
      return n;
    },

    remove: function (id) {
      var idx = -1;
      for (var i = 0; i < this.notes.length; i++) {
        if (this.notes[i].id === id) { idx = i; break; }
      }
      if (idx < 0) return false;
      this.notes.splice(idx, 1);
      this._index = null;
      this.notes.forEach(function (n) {
        n.related = (n.related || []).filter(function (r) { return r.id !== id; });
      });
      this.saveNotes();
      return true;
    },

    /* ---------- 查询辅助 ---------- */
    countBy: function (type) {
      if (type === 'all') return this.notes.length;
      if (type === 'star') return this.notes.filter(function (n) { return n.pinned; }).length;
      return this.notes.filter(function (n) { return n.type === type; }).length;
    },

    tagStats: function () {
      var map = {};
      this.notes.forEach(function (n) {
        (n.tags || []).forEach(function (t) {
          map[t] = (map[t] || 0) + 1;
        });
      });
      return Object.keys(map)
        .map(function (t) { return { tag: t, count: map[t] }; })
        .sort(function (a, b) { return b.count - a.count; });
    },

    inRange: function (days) {
      if (!days) return this.notes.slice();
      var from = Date.now() - days * 86400000;
      return this.notes.filter(function (n) { return (n.createdAt || 0) >= from; });
    },

    /* ---------- 导入导出 ---------- */
    exportJSON: function () {
      return JSON.stringify(
        { app: 'info-butler', version: 1, exportedAt: new Date().toISOString(), notes: this.notes },
        null, 2
      );
    },

    /**
     * 导入前逐字段清洗：外部 JSON 可能字段缺失、类型不对或超长，
     * 直接入库会让渲染层抛错或把 localStorage 撑爆，因此这里统一收敛。
     */
    sanitize: function (n) {
      if (!n || typeof n !== 'object') return null;
      var content = typeof n.content === 'string' ? n.content : (n.content == null ? '' : String(n.content));
      if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT);
      if (!content.trim()) return null;

      var now = Date.now();
      var title = typeof n.title === 'string' ? n.title.slice(0, 200) : '';
      var createdAt = (typeof n.createdAt === 'number' && isFinite(n.createdAt)) ? n.createdAt : now;
      return {
        id: (typeof n.id === 'string' && n.id) ? n.id : uid(),
        type: VALID_TYPES.indexOf(n.type) >= 0 ? n.type : 'idea',
        title: title || fallbackTitle(content),
        content: content,
        tags: (Array.isArray(n.tags) ? n.tags : [])
          .map(function (t) { return typeof t === 'string' ? t.trim().slice(0, 16) : ''; })
          .filter(Boolean).slice(0, 8),
        priority: VALID_PRIO.indexOf(n.priority) >= 0 ? n.priority : 'medium',
        dueDate: (typeof n.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(n.dueDate)) ? n.dueDate : null,
        done: !!n.done,
        doneAt: (typeof n.doneAt === 'number' && isFinite(n.doneAt)) ? n.doneAt : null,
        pinned: !!n.pinned,
        summary: typeof n.summary === 'string' ? n.summary.slice(0, 400) : '',
        keyPoints: (Array.isArray(n.keyPoints) ? n.keyPoints : [])
          .map(function (k) { return String(k == null ? '' : k).slice(0, 120); })
          .filter(Boolean).slice(0, 5),
        related: [],                       // 关联一律重建，避免导入悬空 id
        aiTagged: !!n.aiTagged,
        createdAt: createdAt,
        updatedAt: (typeof n.updatedAt === 'number' && isFinite(n.updatedAt)) ? n.updatedAt : createdAt
      };
    },

    importJSON: function (text) {
      var obj = JSON.parse(text);
      var incoming = Array.isArray(obj) ? obj : obj.notes;
      if (!Array.isArray(incoming)) throw new Error('文件格式不正确：缺少 notes 数组');

      var exists = {};
      this.notes.forEach(function (n) { exists[n.id] = true; });
      var added = 0, skipped = 0;

      var self = this;
      incoming.forEach(function (raw) {
        var copy = self.sanitize(raw);
        if (!copy) { skipped++; return; }
        if (exists[copy.id]) { skipped++; return; }
        exists[copy.id] = true;
        self.notes.push(copy);
        added++;
      });

      this.notes.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      this._index = null;
      this.saveNotes();
      return { added: added, skipped: skipped };
    },

    clearAll: function () {
      this.notes = [];
      this._index = null;
      this.saveNotes();
    },

    /* ---------- 示例数据 ---------- */
    seed: function () {
      var now = Date.now();
      var H = 3600000, D = 86400000;
      var demo = [
        {
          type: 'idea', content: '想把每周读到的好内容沉淀成一个"第二大脑"，而不是散落在收藏夹里吃灰。核心是记录要足够轻，回顾要足够强。',
          tags: ['知识管理', '产品思考'], priority: 'high', pinned: true, createdAt: now - 2 * H
        },
        {
          type: 'todo', content: '整理 Q4 产品路线图，把三个候选方向按投入产出比排序，下周三之前发出来。',
          tags: ['工作', '规划'], priority: 'high', dueDate: new Date(now + 6 * D).toISOString().slice(0, 10), createdAt: now - 5 * H
        },
        {
          type: 'material', content: '《卡片笔记写作法》摘录：笔记的价值不在于收集，而在于建立连接。一条笔记只有和已有笔记产生关联时，才真正进入思考网络。',
          tags: ['阅读', '知识管理'], priority: 'medium', createdAt: now - 1 * D
        },
        {
          type: 'idea', content: '待办清单越堆越长会让人焦虑。或许可以每天只推三件"今日必做"，其余折叠起来，降低决策负担。',
          tags: ['效率', '产品思考'], priority: 'medium', createdAt: now - 2 * D
        },
        {
          type: 'todo', content: '约设计师聊一聊信息录入的交互原型，确认语音输入和快捷入口的优先级。',
          tags: ['工作', '协作'], priority: 'medium', dueDate: new Date(now + 2 * D).toISOString().slice(0, 10), createdAt: now - 2 * D
        },
        {
          type: 'material', content: '一篇关于检索增强的文章提到：先做关键词召回再交给模型总结，比直接把全部内容塞进上下文，成本低一个数量级，准确率还更高。',
          tags: ['技术', 'AI'], priority: 'medium', createdAt: now - 3 * D
        },
        {
          type: 'todo', content: '把健身计划重新排一下，这周三次力量训练，周末补一次有氧。',
          tags: ['生活', '健康'], priority: 'low', createdAt: now - 4 * D, done: true, doneAt: now - 3 * D
        },
        {
          type: 'idea', content: '考虑给记录加一个"回顾提醒"：当某条笔记被反复检索到，说明它是当前关注焦点，可以主动推送到首页。',
          tags: ['产品思考', 'AI'], priority: 'low', createdAt: now - 6 * D
        }
      ];
      var self = this;
      demo.forEach(function (d) {
        var n = self.add(d);
        n.title = Engine.makeTitle(d.content);
        n.summary = Engine.extractiveSummary(d.content, 1);
        n.keyPoints = Engine.keyPoints(d.content, 2);
      });
      this.saveNotes();
      return demo.length;
    },

    PROVIDERS: PROVIDERS,
    DEFAULT_CONFIG: DEFAULT_CONFIG
  };

  global.Store = Store;
})(window);
