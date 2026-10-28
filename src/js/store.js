/* ===========================================================
 * store.js —— 本地数据层
 * 数据结构持久化在浏览器 localStorage，支持导出 / 导入备份。
 *
 * 设计要点（都是踩过坑之后的结论）：
 * 1) 删除是「移入回收站」而不是物理删除 —— 本地应用没有服务端兜底，
 *    误删就是永久丢失，必须留一条退路。
 * 2) 每次写库前记一份内存快照，供撤销使用；快照不落盘，避免二次占用配额。
 * 3) 导入按「类型 + 正文」指纹去重，重复导入同一份备份不会翻倍。
 * 4) 配额写满时先清最老的回收站条目再重试，仍失败才报错给用户。
 * 5) 数据带 schemaVersion，为后续结构演进留迁移入口。
 * =========================================================== */
(function (global) {
  'use strict';

  var KEY_DATA = 'info_butler_notes_v1';
  var KEY_TRASH = 'info_butler_trash_v1';
  var KEY_CONF = 'info_butler_config_v1';
  var KEY_META = 'info_butler_meta_v1';

  var SCHEMA_VERSION = 2;

  var DEFAULT_CONFIG = {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    userName: '',
    domains: '',
    autoTag: true,
    theme: 'auto',        // auto | dark | light
    density: 'cozy',      // cozy | compact
    fontSize: 14
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

  var TRASH_MAX = 80;                                       // 回收站最多保留条数
  var TRASH_DAYS = 30;                                      // 回收站最多保留天数
  var QUOTA_SOFT = 4.2 * 1024 * 1024;                       // 软上限：超过就提示导出

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

  /** 内容指纹：类型 + 归一化正文，用于导入去重 */
  function fingerprint(n) {
    var s = (n.type || 'idea') + '\u0001' + String(n.content || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    // FNV-1a 32 位，够用且快
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(36) + ':' + s.length.toString(36);
  }

  function deepClone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  var Store = {
    notes: [],
    config: null,
    _index: null,          // id → note 的索引，避免列表页每条都做线性查找
    onError: null,         // 写入失败等错误的通知回调，由界面层注册
    onQuotaWarn: null,     // 容量接近上限时的提醒回调
    _undo: [],             // 内存撤销栈（不落盘）

    /* ---------- 载入 / 保存 ---------- */
    load: function () {
      this.notes = safeParse(localStorage.getItem(KEY_DATA), []);
      if (!Array.isArray(this.notes)) this.notes = [];
      this.config = Object.assign({}, DEFAULT_CONFIG, safeParse(localStorage.getItem(KEY_CONF), {}));
      this._index = null;
      this._undo = [];
      this.migrate();
      this.repair({ silent: true });
      return this;
    },

    /** schema 迁移：只做加法，保证老数据/老备份都能继续用 */
    migrate: function () {
      var meta = safeParse(localStorage.getItem(KEY_META), {}) || {};
      var from = Number(meta.schemaVersion) || 1;
      if (from >= SCHEMA_VERSION) return from;

      // v1 → v2：补齐新增字段；旧记录缺 theme/density 等配置项由 DEFAULT_CONFIG 兜底
      this.notes.forEach(function (n) {
        if (!n.fingerprint) n.fingerprint = fingerprint(n);
        if (!Array.isArray(n.keyPoints)) n.keyPoints = [];
        if (!Array.isArray(n.related)) n.related = [];
      });

      try {
        localStorage.setItem(KEY_META, JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          migratedAt: Date.now(),
          from: from
        }));
      } catch (e) { /* 配额紧张时元信息写不进去也不影响主数据 */ }
      this.saveNotes();
      return from;
    },

    /**
     * 写库。配额写满时按「清回收站 → 再试」的顺序自救一次，
     * 仍失败才把错误交给界面层 —— 改动静默丢失是最坏的结果。
     */
    saveNotes: function () {
      try {
        localStorage.setItem(KEY_DATA, JSON.stringify(this.notes));
        this._checkQuota();
        return true;
      } catch (e) {
        var isQuota = e && (e.name === 'QuotaExceededError' || e.code === 22);
        if (isQuota) {
          var freed = this.trimTrash(true);
          if (freed) {
            try {
              localStorage.setItem(KEY_DATA, JSON.stringify(this.notes));
              if (this.onQuotaWarn) this.onQuotaWarn('存储空间紧张，已自动清理回收站中较旧的记录。');
              return true;
            } catch (e2) { /* 继续走失败分支 */ }
          }
        }
        var msg = isQuota
          ? '本地存储空间已满，本次改动没能保存。请先在「设置 → 数据管理」导出备份，再删除一些历史记录。'
          : '本地存储写入失败：' + ((e && e.message) || '未知原因');
        console.error('保存失败', e);
        if (this.onError) this.onError(msg);
        return false;
      }
    },

    saveConfig: function () {
      try {
        localStorage.setItem(KEY_CONF, JSON.stringify(this.config));
        return true;
      } catch (e) {
        if (this.onError) this.onError('配置保存失败：本地存储可能已满。');
        return false;
      }
    },

    /** 估算当前占用（字节），用于设置页展示与提前预警 */
    estimateBytes: function () {
      var total = 0;
      try {
        [KEY_DATA, KEY_TRASH, KEY_CONF, KEY_META].forEach(function (k) {
          var v = localStorage.getItem(k);
          if (v) total += k.length + v.length;
        });
      } catch (e) { /* ignore */ }
      // localStorage 按 UTF-16 存，字节数约为字符数 × 2
      return total * 2;
    },

    _checkQuota: function () {
      var used = this.estimateBytes();
      if (used > QUOTA_SOFT && this.onQuotaWarn) {
        this.onQuotaWarn('本地存储已用 ' + (used / 1048576).toFixed(1) + ' MB，接近浏览器上限。建议导出备份并清理旧记录。');
      }
    },

    /* ---------- 撤销 ---------- */
    snapshot: function () {
      this._undo.push(deepClone(this.notes));
      if (this._undo.length > 20) this._undo.shift();
    },

    canUndo: function () { return this._undo.length > 0; },

    /** 回滚到上一次 snapshot 的状态；返回是否真的回滚了 */
    undo: function () {
      if (!this._undo.length) return false;
      this.notes = this._undo.pop();
      this._index = null;
      this.saveNotes();
      return true;
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
      note.fingerprint = fingerprint(note);
      if (note.done && !note.doneAt) note.doneAt = now;
      this.snapshot();
      this.notes.unshift(note);
      this._index = null;
      this.saveNotes();
      return note;
    },

    update: function (id, patch, opts) {
      var n = this.get(id);
      if (!n) return null;
      if (!opts || opts.snapshot !== false) this.snapshot();
      Object.keys(patch).forEach(function (k) { n[k] = patch[k]; });
      // 与 add 一致：防止超长正文把 localStorage 撑爆（导入路径已在 sanitize 截断）
      if (n.content && n.content.length > MAX_CONTENT) n.content = n.content.slice(0, MAX_CONTENT);
      if (patch.content != null || patch.type != null) n.fingerprint = fingerprint(n);
      n.updatedAt = Date.now();
      if (patch.done === true && !n.doneAt) n.doneAt = Date.now();
      if (patch.done === false) n.doneAt = null;
      this.saveNotes();
      return n;
    },

    /** 移入回收站（软删除）。真正物理删除用 purge。 */
    remove: function (id) {
      var idx = -1;
      for (var i = 0; i < this.notes.length; i++) {
        if (this.notes[i].id === id) { idx = i; break; }
      }
      if (idx < 0) return false;

      this.snapshot();
      var note = this.notes.splice(idx, 1)[0];
      note.deletedAt = Date.now();
      this._index = null;

      // 双向关联要同步剔除，否则详情里会出现指向空记录的死链
      this.notes.forEach(function (n) {
        n.related = (n.related || []).filter(function (r) { return r.id !== id; });
      });

      var trash = this.trash();
      trash.unshift(note);
      this._writeTrash(trash);
      this.saveNotes();
      return true;
    },

    /* ---------- 回收站 ---------- */
    trash: function () {
      var t = safeParse(localStorage.getItem(KEY_TRASH), []);
      if (!Array.isArray(t)) return [];
      var cutoff = Date.now() - TRASH_DAYS * 86400000;
      return t.filter(function (n) { return n && n.deletedAt && n.deletedAt >= cutoff; }).slice(0, TRASH_MAX);
    },

    _writeTrash: function (list) {
      try {
        localStorage.setItem(KEY_TRASH, JSON.stringify(list.slice(0, TRASH_MAX)));
        return true;
      } catch (e) {
        // 回收站写不进去时，退化为只保留最近 10 条
        try {
          localStorage.setItem(KEY_TRASH, JSON.stringify(list.slice(0, 10)));
          return true;
        } catch (e2) { return false; }
      }
    },

    restore: function (id) {
      var t = this.trash();
      var idx = -1;
      for (var i = 0; i < t.length; i++) if (t[i].id === id) { idx = i; break; }
      if (idx < 0) return false;

      var note = t.splice(idx, 1)[0];
      delete note.deletedAt;
      this._writeTrash(t);

      this.snapshot();
      // 恢复时若 id 已被占用（极端情况），换一个新 id
      if (this.get(note.id)) note.id = uid();
      note.updatedAt = Date.now();
      this.notes.push(note);
      this.notes.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      this._index = null;
      this.saveNotes();
      return true;
    },

    purge: function (id) {
      var t = this.trash();
      var next = t.filter(function (n) { return n.id !== id; });
      if (next.length === t.length) return false;
      this._writeTrash(next);
      return true;
    },

    emptyTrash: function () {
      var n = this.trash().length;
      this._writeTrash([]);
      return n;
    },

    /** 清理回收站：keepRecent=true 时只保留最近 7 天、最多 20 条 */
    trimTrash: function (keepRecent) {
      var t = this.trash();
      if (!t.length) return 0;
      var next = keepRecent
        ? t.filter(function (n) { return Date.now() - n.deletedAt < 7 * 86400000; }).slice(0, 20)
        : [];
      var removed = t.length - next.length;
      this._writeTrash(next);
      return removed;
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

    /* ---------- 标签维护 ---------- */
    /**
     * 重命名标签。若目标标签已存在，等价于合并：
     * 同一条记录上的两个标签会去重，不会出现「产品 产品」。
     * @returns {number} 受影响的记录数
     */
    renameTag: function (from, to) {
      var src = String(from || '').trim();
      var dst = String(to || '').trim().slice(0, 16);
      if (!src || !dst || src === dst) return 0;

      var n = 0;
      this.snapshot();
      this.notes.forEach(function (note) {
        var tags = note.tags || [];
        if (tags.indexOf(src) < 0) return;
        var next = [];
        tags.forEach(function (t) {
          var v = (t === src) ? dst : t;
          if (next.indexOf(v) < 0) next.push(v);
        });
        note.tags = next.slice(0, 8);
        note.updatedAt = Date.now();
        n++;
      });
      if (n) this.saveNotes();
      return n;
    },

    /** 删除标签（只摘掉标签，不删记录） */
    deleteTag: function (tag) {
      var t = String(tag || '').trim();
      if (!t) return 0;
      var n = 0;
      this.snapshot();
      this.notes.forEach(function (note) {
        var tags = note.tags || [];
        if (tags.indexOf(t) < 0) return;
        note.tags = tags.filter(function (x) { return x !== t; });
        note.updatedAt = Date.now();
        n++;
      });
      if (n) this.saveNotes();
      return n;
    },

    /* ---------- 完整性修复 ---------- */
    /**
     * 读取外部数据（或历史脏数据）后做一次体检：
     * 去掉空正文、去重 id、剔除悬空关联、收敛越界字段。
     * 默认静默，只有在真的改动了东西时才提示。
     */
    repair: function (opts) {
      var changed = 0;
      var seen = {};
      var kept = [];

      this.notes.forEach(function (n) {
        if (!n || typeof n !== 'object') { changed++; return; }
        if (typeof n.content !== 'string' || !n.content.trim()) { changed++; return; }
        if (!n.id || seen[n.id]) { n.id = uid(); changed++; }
        seen[n.id] = true;

        if (VALID_TYPES.indexOf(n.type) < 0) { n.type = 'idea'; changed++; }
        if (VALID_PRIO.indexOf(n.priority) < 0) { n.priority = 'medium'; changed++; }
        if (!Array.isArray(n.tags)) { n.tags = []; changed++; }
        if (!Array.isArray(n.keyPoints)) { n.keyPoints = []; changed++; }
        if (!Array.isArray(n.related)) { n.related = []; changed++; }
        if (!n.title) { n.title = fallbackTitle(n.content); changed++; }
        if (n.content.length > MAX_CONTENT) { n.content = n.content.slice(0, MAX_CONTENT); changed++; }
        if (!n.fingerprint) { n.fingerprint = fingerprint(n); changed++; }
        kept.push(n);
      });

      this.notes = kept;
      this._index = null;

      // 剔除指向不存在记录的关联
      var byId = {};
      kept.forEach(function (n) { byId[n.id] = true; });
      kept.forEach(function (n) {
        var before = n.related.length;
        n.related = n.related.filter(function (r) { return r && byId[r.id]; });
        if (n.related.length !== before) changed++;
      });

      if (changed) {
        this.saveNotes();
        if ((!opts || !opts.silent) && typeof Engine !== 'undefined' && Engine && Engine.relate) {
          // 修复后重建关联，避免只删不补
          Engine.relate(this.notes);
          this.saveNotes();
        }
      }
      return changed;
    },

    /* ---------- 导入导出 ---------- */
    exportJSON: function () {
      return JSON.stringify(
        {
          app: 'info-butler',
          version: SCHEMA_VERSION,
          exportedAt: new Date().toISOString(),
          config: { userName: this.config.userName, domains: this.config.domains },
          notes: this.notes
        },
        null, 2
      );
    },

    /** 导出 Markdown：按类型分组，保留标签、截止日与完成状态 */
    exportMarkdown: function () {
      var TYPE_CN = { idea: '想法', material: '资料', todo: '待办', summary: '阶段总结' };
      var out = [];
      var d = new Date();
      var stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      out.push('# 信息管家导出 · ' + stamp);
      out.push('');
      out.push('共 ' + this.notes.length + ' 条记录。');
      out.push('');

      var self = this;
      ['idea', 'material', 'todo', 'summary'].forEach(function (type) {
        var list = self.notes.filter(function (n) { return n.type === type; });
        if (!list.length) return;
        out.push('## ' + (TYPE_CN[type] || type) + '（' + list.length + '）');
        out.push('');
        list.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        list.forEach(function (n) {
          var flags = [];
          if (n.type === 'todo') flags.push(n.done ? '已完成' : '未完成');
          if (n.dueDate) flags.push('截止 ' + n.dueDate);
          if (n.pinned) flags.push('重点');
          out.push('### ' + (n.title || '（无标题）'));
          out.push('');
          if (flags.length || (n.tags || []).length) {
            var meta = [];
            if (flags.length) meta.push(flags.join(' · '));
            if ((n.tags || []).length) meta.push((n.tags || []).map(function (t) { return '#' + t; }).join(' '));
            out.push('> ' + meta.join('　|　'));
            out.push('');
          }
          out.push(n.content || '');
          out.push('');
        });
      });

      if (!this.notes.length) out.push('_（还没有记录）_');
      return out.join('\n');
    },

    /** 导出 CSV（Excel 可直接打开，含 BOM 以免中文乱码） */
    exportCSV: function () {
      var TYPE_CN = { idea: '想法', material: '资料', todo: '待办', summary: '阶段总结' };
      var esc = function (v) {
        var s = String(v == null ? '' : v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      var rows = [['类型', '标题', '正文', '标签', '优先级', '截止日期', '完成', '创建时间']];
      this.notes.forEach(function (n) {
        rows.push([
          TYPE_CN[n.type] || n.type,
          n.title || '',
          n.content || '',
          (n.tags || []).join(' '),
          n.priority || '',
          n.dueDate || '',
          n.type === 'todo' ? (n.done ? '是' : '否') : '',
          n.createdAt ? new Date(n.createdAt).toISOString().slice(0, 16).replace('T', ' ') : ''
        ]);
      });
      return '\uFEFF' + rows.map(function (r) { return r.map(esc).join(','); }).join('\r\n');
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
      var clean = {
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
      clean.fingerprint = fingerprint(clean);
      return clean;
    },

    /**
     * 导入备份。
     * @param {string} text JSON 文本
     * @param {object} [opts] { dedupe: true } 按内容指纹跳过重复
     * @returns {{added:number, skipped:number, duplicated:number}}
     */
    importJSON: function (text, opts) {
      var dedupe = !opts || opts.dedupe !== false;
      var obj = JSON.parse(text);
      var incoming = Array.isArray(obj) ? obj : obj.notes;
      if (!Array.isArray(incoming)) throw new Error('文件格式不正确：缺少 notes 数组');

      var existsId = {};
      var existsFp = {};
      this.notes.forEach(function (n) {
        existsId[n.id] = true;
        existsFp[n.fingerprint || fingerprint(n)] = true;
      });

      var added = 0, skipped = 0, duplicated = 0;
      var self = this;
      this.snapshot();

      incoming.forEach(function (raw) {
        var copy = self.sanitize(raw);
        if (!copy) { skipped++; return; }
        if (existsId[copy.id]) { skipped++; return; }
        if (dedupe && existsFp[copy.fingerprint]) { duplicated++; return; }
        existsId[copy.id] = true;
        existsFp[copy.fingerprint] = true;
        self.notes.push(copy);
        added++;
      });

      this.notes.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      this._index = null;
      this.saveNotes();
      return { added: added, skipped: skipped, duplicated: duplicated };
    },

    clearAll: function () {
      this.snapshot();
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
      this.snapshot();
      demo.forEach(function (d) {
        var n = self.add(d);
        n.title = Engine.makeTitle(d.content);
        n.summary = Engine.extractiveSummary(d.content, 1);
        n.keyPoints = Engine.keyPoints(d.content, 2);
      });
      this.saveNotes();
      return demo.length;
    },

    fingerprint: fingerprint,
    PROVIDERS: PROVIDERS,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_CONTENT: MAX_CONTENT
  };

  global.Store = Store;
})(window);
