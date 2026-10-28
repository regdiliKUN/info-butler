/* ===========================================================
 * app.js —— 界面与交互
 * =========================================================== */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // 类型中文名统一取自引擎，界面不再单独维护一份
  var PRIO_LABEL = { high: '高', medium: '中', low: '低' };

  function typeLabel(t) { return (Engine.TYPE_CN && Engine.TYPE_CN[t]) || t || '未分类'; }

  var state = {
    view: 'stream',
    filter: 'all',
    tags: [],
    query: '',
    sort: 'recent',
    onlyOpen: false,
    editingId: null,
    lastSummary: null,
    limit: 60           // 列表一次渲染多少条；2000 条全量塞进 DOM 会明显拖慢滚动
  };

  var PAGE_SIZE = 60;

  var chatHistory = [];

  /* ---------------- 工具 ---------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts), now = new Date();
    var diff = (now.getTime() - d.getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400 && d.getDate() === now.getDate()) return Math.floor(diff / 3600) + ' 小时前';
    var y = d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '-';
    if (diff < 86400 * 2 && d.getDate() !== now.getDate()) return '昨天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    return y + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function mdToHtml(text) {
    var lines = String(text || '').split('\n');
    var html = '', inUl = false, inQuote = false;
    function closeLists() { if (inUl) { html += '</ul>'; inUl = false; } }
    function closeQuote() { if (inQuote) { html += '</blockquote>'; inQuote = false; } }
    function isTableSep(l) { return /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.indexOf('-') >= 0; }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var t = line.trim();

      // 表格：当前行含 | 且下一行是分隔行
      if (t.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1].trim())) {
        closeLists(); closeQuote();
        var headerCells = t.replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); });
        var sep = lines[i + 1].trim();
        var aligns = sep.replace(/^\||\|$/g, '').split('|').map(function (c) {
          var l = /^\s*:/.test(c), r = /:\s*$/.test(c);
          return r && l ? 'center' : r ? 'right' : l ? 'left' : '';
        });
        i += 1; // 跳过分隔行
        var rows = [];
        while (i + 1 < lines.length && lines[i + 1].trim().indexOf('|') >= 0) {
          i += 1;
          rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); }));
        }
        var th = '<tr>' + headerCells.map(function (c, ci) {
          var a = aligns[ci] ? ' style="text-align:' + aligns[ci] + '"' : '';
          return '<th' + a + '>' + inline(c) + '</th>';
        }).join('') + '</tr>';
        var tr = rows.map(function (r) {
          return '<tr>' + r.map(function (c, ci) {
            var a = aligns[ci] ? ' style="text-align:' + aligns[ci] + '"' : '';
            return '<td' + a + '>' + inline(c) + '</td>';
          }).join('') + '</tr>';
        }).join('');
        html += '<table class="md-table"><thead>' + th + '</thead><tbody>' + tr + '</tbody></table>';
        continue;
      }

      if (!t) { closeLists(); closeQuote(); continue; }

      if (/^>\s?/.test(t)) {
        closeLists();
        if (!inQuote) { html += '<blockquote>'; inQuote = true; }
        html += '<p>' + inline(t.replace(/^>\s?/, '')) + '</p>';
        continue;
      } else { closeQuote(); }

      if (/^###\s+/.test(t)) { closeLists(); html += '<h3>' + inline(t.replace(/^###\s+/, '')) + '</h3>'; continue; }
      if (/^##\s+/.test(t)) { closeLists(); html += '<h2>' + inline(t.replace(/^##\s+/, '')) + '</h2>'; continue; }
      if (/^#\s+/.test(t)) { closeLists(); html += '<h2>' + inline(t.replace(/^#\s+/, '')) + '</h2>'; continue; }
      if (/^[-*]\s+/.test(t)) {
        if (!inUl) { html += '<ul>'; inUl = true; }
        html += '<li>' + inline(t.replace(/^[-*]\s+/, '')) + '</li>';
        continue;
      }
      if (/^\d+[.、]\s*/.test(t)) {
        if (!inUl) { html += '<ul>'; inUl = true; }
        html += '<li>' + inline(t.replace(/^\d+[.、]\s*/, '')) + '</li>';
        continue;
      }
      closeLists();
      html += '<p>' + inline(t) + '</p>';
    }
    closeLists(); closeQuote();
    return html;
  }

  function inline(s) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  /**
   * 复制文本。navigator.clipboard 只在安全上下文（https / localhost）可用，
   * 本地直接双击 index.html（file://）时会失败，因此保留 execCommand 兜底。
   */
  function copyText(text) {
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        var ok = document.execCommand('copy');
        toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择文本');
      } catch (e) {
        toast('复制失败，请手动选择文本');
      }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制到剪贴板'); }, fallback);
    } else {
      fallback();
    }
  }

  var toastTimer = null;
  var toastAction = null;

  /**
   * 轻提示。可选带一个动作按钮（典型场景是「撤销」）。
   * 带动作时停留 6 秒而不是 2.4 秒 —— 否则用户根本来不及点。
   */
  function toast(msg, actionLabel, onAction) {
    var el = $('#toast');
    el.innerHTML = '';
    var span = document.createElement('span');
    span.className = 'toast-msg';
    span.textContent = msg;
    el.appendChild(span);

    toastAction = null;
    if (actionLabel && onAction) {
      var btn = document.createElement('button');
      btn.className = 'toast-act';
      btn.type = 'button';
      btn.textContent = actionLabel;
      btn.addEventListener('click', function () {
        el.hidden = true;
        clearTimeout(toastTimer);
        toastAction = null;
        onAction();
      });
      el.appendChild(btn);
      toastAction = onAction;
    }

    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.hidden = true;
      toastAction = null;
    }, actionLabel ? 6000 : 2400);
  }

  /* ---------------- 侧边栏 ---------------- */

  function renderSidebar() {
    ['all', 'idea', 'material', 'todo', 'summary', 'star'].forEach(function (k) {
      var el = $('[data-count="' + k + '"]');
      if (el) el.textContent = Store.countBy(k);
    });

    var tags = Store.tagStats().slice(0, 18);
    $('#tagCloud').innerHTML = tags.length
      ? tags.map(function (t) {
        var on = state.tags.indexOf(t.tag) >= 0;
        return '<button class="tag-chip' + (on ? ' on' : '') + '" data-tag="' + esc(t.tag) + '">' +
          esc(t.tag) + '<span class="tc">' + t.count + '</span></button>';
      }).join('')
      : '<div style="font-size:12px;color:var(--txt-3);padding:0 2px">记录后自动生成</div>';

    var pill = $('#modelPill');
    if (AI.ready()) { pill.classList.add('on'); $('#modelPillText').textContent = '大模型 · ' + (Store.config.model || ''); }
    else { pill.classList.remove('on'); $('#modelPillText').textContent = '本地引擎（离线）'; }
  }

  /* ---------------- 记录流 ---------------- */

  function currentList() {
    var list = Store.all().slice();

    if (state.filter === 'star') list = list.filter(function (n) { return n.pinned; });
    else if (state.filter !== 'all') list = list.filter(function (n) { return n.type === state.filter; });

    if (state.onlyOpen) list = list.filter(function (n) { return n.type !== 'todo' || !n.done; });

    if (state.tags.length) {
      list = list.filter(function (n) {
        return state.tags.every(function (t) { return (n.tags || []).indexOf(t) >= 0; });
      });
    }

    var scored = null;
    if (state.query.trim()) {
      scored = Engine.search(list, state.query);
      var map = {};
      scored.forEach(function (r) { map[r.note.id] = r; });
      list = scored.map(function (r) { return r.note; });
      list._score = map;
    }

    if (state.sort === 'relevance' && list._score) {
      // 已按相关度排序
    } else if (state.sort === 'priority') {
      list.sort(function (a, b) {
        var pa = (a.done ? 0 : 1) * 10 + rankPrio(a);
        var pb = (b.done ? 0 : 1) * 10 + rankPrio(b);
        if (pa !== pb) return pb - pa;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
    } else {
      list.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    }
    return list;
  }

  function rankPrio(n) { return n.priority === 'high' ? 3 : n.priority === 'medium' ? 2 : 1; }

  /** 统一切换排序方式，按钮高亮与状态只在这里维护，避免多处各改一半 */
  function setSort(sort) {
    state.sort = sort;
    state.limit = PAGE_SIZE;
    $$('#sortSeg .seg-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-sort') === sort);
    });
  }

  function renderStream() {
    var list = currentList();
    var titles = { all: '全部内容', idea: '想法', material: '资料', todo: '待办', summary: '阶段总结', star: '重点' };
    $('#streamTitle').textContent = titles[state.filter] || '全部内容';

    var parts = [list.length + ' 条记录'];
    if (state.query.trim()) parts.push('匹配「' + state.query.trim() + '」');
    if (state.tags.length) parts.push('标签 ' + state.tags.map(function (t) { return '#' + t; }).join(' '));
    $('#streamSub').textContent = parts.join(' · ');

    // 筛选 chips
    var chips = [];
    state.tags.forEach(function (t) {
      chips.push('<button class="chip on" data-untag="' + esc(t) + '">#' + esc(t) + '<span class="x">×</span></button>');
    });
    if (state.query.trim()) {
      chips.push('<button class="chip on" data-unquery="1">关键词：' + esc(state.query.trim()) + '<span class="x">×</span></button>');
    }
    if (state.filter === 'todo') {
      var openCount = Store.all().filter(function (n) { return n.type === 'todo' && !n.done; }).length;
      chips.push('<button class="chip" data-onlyopen="1">' + (state.onlyOpen ? '✓ ' : '') + '只看未完成（' + openCount + '）</button>');
    }
    $('#filterChips').innerHTML = chips.join('');

    var scoreMap = list._score || {};
    var shown = list.slice(0, state.limit);

    $('#cardList').innerHTML = shown.map(function (n) {
      return cardHTML(n, scoreMap[n.id]);
    }).join('');

    renderLoadMore(list.length, shown.length);
    renderEmptyState(list.length);
  }

  /** 分批渲染的"继续加载"。列表很长时，滚动到底部自动补一屏 */
  function renderLoadMore(total, shown) {
    var wrap = $('#loadMoreWrap');
    if (!wrap) return;
    if (shown >= total) { wrap.hidden = true; return; }
    wrap.hidden = false;
    $('#loadMoreHint').textContent = '已显示 ' + shown + ' / ' + total + ' 条';
  }

  function loadMore() {
    if (!state.view || state.view !== 'stream') return;
    var before = state.limit;
    state.limit += PAGE_SIZE;
    renderStream();
    // 触发后仍在可视区（记录不够多）时继续补，避免"点了没反应"
    if (state.limit !== before && state.limit < Store.all().length + PAGE_SIZE) {
      requestAnimationFrame(function () {
        var wrap = $('#loadMoreWrap');
        if (wrap && !wrap.hidden && wrap.getBoundingClientRect().top < window.innerHeight) loadMore();
      });
    }
  }

  /** 空态要区分「本来就没记录」和「筛选后没命中」，否则用户会以为数据丢了 */
  function renderEmptyState(count) {
    var es = $('#emptyState');
    es.hidden = count > 0;
    if (count > 0) return;
    var filtered = !!state.query.trim() || state.tags.length > 0 || state.filter !== 'all' || state.onlyOpen;
    $('#emptyTitle').textContent = filtered ? '没有匹配的内容' : '这里还空着';
    $('#emptyDesc').textContent = filtered
      ? '换个关键词，或清除当前的筛选条件再看看。'
      : '在上方输入框随手记一条，管家会自动分类、打标签并关联相关内容。';
    $('#emptyCompose').hidden = filtered;
    $('#emptyClear').hidden = !filtered;
  }

  function clearFilters() {
    state.limit = PAGE_SIZE;
    state.query = '';
    state.tags = [];
    state.onlyOpen = false;
    $('#searchInput').value = '';
    setSort('recent');
    renderStream();
  }

  function cardHTML(n, sc) {
    var hits = (sc && sc.hits) || [];
    var body = esc(n.content || '');
    hits.forEach(function (h) {
      try {
        body = body.replace(new RegExp(esc(h).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), function (m) { return '<mark>' + m + '</mark>'; });
      } catch (e) { /* ignore */ }
    });

    var rel = (n.related || []).slice(0, 3).map(function (r) {
      var m = Store.get(r.id);
      if (!m) return '';
      return '<div class="rel-item" data-open="' + m.id + '">' +
        '<span class="rel-bar"><i style="width:' + Math.round(r.score * 100) + '%"></i></span>' +
        '<span>' + esc(m.title) + '</span>' +
        '<span class="rel-score">' + Math.round(r.score * 100) + '%</span></div>';
    }).join('');

    var kp = (n.keyPoints || []).length
      ? '<ul class="card-keypoints">' + n.keyPoints.map(function (k) { return '<li>' + esc(k) + '</li>'; }).join('') + '</ul>'
      : '';

    var dueTag = '';
    if (n.type === 'todo' && n.dueDate) {
      var overdue = !n.done && n.dueDate < Engine.todayStr();
      dueTag = '<span class="due-badge' + (overdue ? ' overdue' : '') + '">' +
        (overdue ? '已逾期 ' : '截止 ') + esc(n.dueDate) + '</span>';
    }

    return '<article class="card' + (n.pinned ? ' pinned' : '') + (n.done ? ' done' : '') + '" data-id="' + n.id + '">' +
      '<div class="card-top">' +
      (n.type === 'todo'
        ? '<button class="todo-check' + (n.done ? ' on' : '') + '" data-act="toggle" data-id="' + n.id + '">✓</button>'
        : '') +
      '<span class="type-badge ' + n.type + '">' + esc(typeLabel(n.type)) + '</span>' +
      '<span class="prio-badge ' + (n.priority || 'medium') + '">' + PRIO_LABEL[n.priority || 'medium'] + '</span>' +
      dueTag +
      '<span class="card-time">' + fmtTime(n.createdAt) + '</span>' +
      '<button class="card-star' + (n.pinned ? ' on' : '') + '" data-act="star" data-id="' + n.id + '" title="设为重点">★</button>' +
      '</div>' +
      '<h3 class="card-title" data-open="' + n.id + '">' + esc(n.title || '（无标题）') + '</h3>' +
      '<p class="card-text">' + body + '</p>' +
      kp +
      ((n.tags || []).length
        ? '<div class="card-tags">' + n.tags.map(function (t) { return '<button class="mini-tag" data-tag="' + esc(t) + '">' + esc(t) + '</button>'; }).join('') + '</div>'
        : '') +
      (rel ? '<div class="card-rel"><div class="card-rel-label">相关内容</div>' + rel + '</div>' : '') +
      '<div class="card-actions">' +
      '<button class="mini-btn" data-act="detail" data-id="' + n.id + '">详情</button>' +
      '<button class="mini-btn" data-act="edit" data-id="' + n.id + '">编辑</button>' +
      '<button class="mini-btn" data-act="ai" data-id="' + n.id + '">重新提炼</button>' +
      '<button class="mini-btn warn" data-act="del" data-id="' + n.id + '">删除</button>' +
      '</div>' +
      '</article>';
  }

  /* ---------------- 详情抽屉 ---------------- */

  function openDetail(id) {
    var n = Store.get(id);
    if (!n) return;
    var rel = (n.related || []).map(function (r) {
      var m = Store.get(r.id);
      if (!m) return '';
      return '<div class="rel-item" data-open="' + m.id + '"><span class="rel-bar"><i style="width:' +
        Math.round(r.score * 100) + '%"></i></span><span>' + esc(m.title) + '</span>' +
        '<span class="rel-score">' + Math.round(r.score * 100) + '%</span></div>';
    }).join('');

    $('#detailBox').innerHTML =
      '<div class="detail-head">' +
      '<span class="type-badge ' + n.type + '">' + esc(typeLabel(n.type)) + '</span>' +
      '<span class="prio-badge ' + (n.priority || 'medium') + '">' + PRIO_LABEL[n.priority || 'medium'] + '</span>' +
      (n.dueDate ? '<span class="due-badge">截止 ' + esc(n.dueDate) + '</span>' : '') +
      '<span class="card-time">' + fmtTime(n.createdAt) + '</span>' +
      '<button class="icon-btn" data-close="1" style="margin-left:auto">×</button>' +
      '</div>' +
      '<h2 class="detail-title">' + esc(n.title || '（无标题）') + '</h2>' +
      (n.summary ? '<div class="detail-sec"><div class="detail-sec-t">摘要</div><div class="detail-text">' + esc(n.summary) + '</div></div>' : '') +
      '<div class="detail-sec"><div class="detail-sec-t">原文</div><div class="detail-text">' + esc(n.content || '') + '</div></div>' +
      ((n.keyPoints || []).length
        ? '<div class="detail-sec"><div class="detail-sec-t">重点提取</div><ul class="card-keypoints" style="padding-left:18px">' +
        n.keyPoints.map(function (k) { return '<li>' + esc(k) + '</li>'; }).join('') + '</ul></div>'
        : '') +
      ((n.tags || []).length
        ? '<div class="detail-sec"><div class="detail-sec-t">标签</div><div class="card-tags">' +
        n.tags.map(function (t) { return '<span class="mini-tag">' + esc(t) + '</span>'; }).join('') + '</div></div>'
        : '') +
      (rel ? '<div class="detail-sec"><div class="detail-sec-t">相关内容</div>' + rel + '</div>' : '') +
      '<div class="detail-sec"><div class="detail-sec-t">归类为</div><div class="type-picker">' +
      ['idea', 'material', 'todo'].map(function (t) {
        return '<button class="type-btn' + (n.type === t ? ' active' : '') + '" data-act="retype" data-type="' + t +
          '" data-id="' + n.id + '">' + esc(typeLabel(t)) + '</button>';
      }).join('') + '</div></div>' +
      '<div class="detail-actions">' +
      '<button class="ghost-btn" data-act="star" data-id="' + n.id + '">' + (n.pinned ? '取消重点' : '设为重点') + '</button>' +
      '<button class="ghost-btn" data-act="copy" data-id="' + n.id + '">复制原文</button>' +
      (n.type === 'todo' ? '<button class="ghost-btn" data-act="toggle" data-id="' + n.id + '">' + (n.done ? '标记未完成' : '标记完成') + '</button>' : '') +
      '<button class="ghost-btn" data-act="ai" data-id="' + n.id + '">重新提炼</button>' +
      '<button class="ghost-btn" data-act="edit" data-id="' + n.id + '">编辑</button>' +
      '<button class="ghost-btn danger" data-act="del" data-id="' + n.id + '">删除</button>' +
      '</div>';
    $('#detailDrawer').hidden = false;
  }

  /* ---------------- 记录 / 编辑 ---------------- */

  function openCompose(note) {
    state.editingId = note ? note.id : null;
    $('#composeText').value = note ? (note.content || '') : '';
    $('#composeTags').value = note ? (note.tags || []).join('，') : '';
    $('#composeStatus').textContent = note ? '修改后将重新智能处理' : '';
    $$('#typePicker .type-btn').forEach(function (b) { b.classList.remove('active'); });
    $('#typePicker .type-btn[data-type="auto"]').classList.add('active');
    $('#composeModal').hidden = false;
    setTimeout(function () { $('#composeText').focus(); }, 40);
  }

  function pickedType() {
    var b = $('#typePicker .type-btn.active');
    return b ? b.getAttribute('data-type') : 'auto';
  }

  /** 保存记录：先本地处理，配置大模型后再异步增强 */
  function saveNote() {
    var text = $('#composeText').value.trim();
    if (!text) { toast('写点什么再保存吧'); return; }

    var typeSel = pickedType();
    var manualTags = $('#composeTags').value.split(/[,，、]/).map(function (s) { return s.trim(); }).filter(Boolean);
    var btn = $('#btnSaveNote');
    btn.disabled = true;
    btn.textContent = '处理中…';

    var existing = state.editingId ? Store.get(state.editingId) : null;
    // 复用引擎的索引缓存，避免每次保存都重新计算整份语料索引（O(记录数×词数)）
    var idx = Engine.buildIndex(Store.all());
    var base = {
      content: text,
      type: typeSel === 'auto' ? Engine.classify(text) : typeSel,
      title: Engine.makeTitle(text),
      tags: manualTags.length ? manualTags : Engine.keywords(text, idx.df, idx.N, 3),
      priority: Engine.detectPriority(text, Engine.detectDueDate(text)),
      dueDate: Engine.detectDueDate(text),
      summary: Engine.extractiveSummary(text, 1),
      keyPoints: Engine.keyPoints(text, 3)
    };

    var note;
    if (existing) {
      Store.update(existing.id, base);
      note = Store.get(existing.id);
    } else {
      note = Store.add(base);
    }
    note.aiTagged = false;

    var finish = function () {
      btn.disabled = false;
      btn.textContent = '保存并智能处理';
      $('#composeModal').hidden = true;
      state.editingId = null;
      // 只重算这一条的关联（O(n)），不必全量 O(n²)
      Engine.relate(Store.all(), [note.id]);
      Store.saveNotes();
      renderAll();
      toast(existing ? '已更新' : '已记录');
    };

    if (AI.ready() && Store.config.autoTag) {
      AI.analyze(text, Store.config.domains).then(function (r) {
        Store.update(note.id, {
          type: typeSel === 'auto' ? r.type : typeSel,
          title: r.title || Engine.makeTitle(text),
          summary: r.summary || note.summary,
          tags: manualTags.length ? manualTags : (r.tags.length ? r.tags : note.tags),
          priority: r.priority,
          dueDate: r.dueDate,
          keyPoints: r.keyPoints.length ? r.keyPoints : note.keyPoints,
          aiTagged: true
        });
        finish();
      }).catch(function (err) {
        console.warn('AI 处理失败，已用本地结果', err);
        toast('已保存（大模型调用失败，用本地引擎处理）');
        finish();
      });
    } else {
      finish();
    }
  }

  /* ---------------- 洞察 ---------------- */

  function renderInsights() {
    var days = parseInt($('#rangeSelect').value, 10);
    var rangeNotes = Store.inRange(days);
    var st = Engine.stats(rangeNotes, Store.all());

    $('#statGrid').innerHTML = [
      { n: st.total, l: '记录总数', s: '想法 ' + st.byType.idea + ' · 资料 ' + st.byType.material + ' · 待办 ' + st.byType.todo },
      { n: st.todoTotal ? Math.round(st.todoDone / st.todoTotal * 100) + '%' : '0%', l: '待办完成率', s: st.todoDone + ' / ' + st.todoTotal + ' 项' },
      { n: st.todoOpen, l: '未完成待办', s: st.overdue.length ? (st.overdue.length + ' 项已逾期') : '没有逾期项' },
      { n: st.starred, l: '重点标记', s: st.topTags.length ? ('主线：' + st.topTags[0].tag) : '暂无标签' }
    ].map(function (c) {
      return '<div class="stat-card"><div class="stat-num">' + esc(c.n) + '</div>' +
        '<div class="stat-label">' + esc(c.l) + '</div><div class="stat-sub">' + esc(c.s) + '</div></div>';
    }).join('');

    var max = st.topTags.length ? st.topTags[0].count : 1;
    $('#topicPanel').innerHTML = st.topTags.length
      ? st.topTags.map(function (t) {
        return '<div class="topic-row" data-tag="' + esc(t.tag) + '">' +
          '<span class="topic-name" title="' + esc(t.tag) + '">#' + esc(t.tag) + '</span>' +
          '<span class="topic-bar"><i style="width:' + Math.round(t.count / max * 100) + '%"></i></span>' +
          '<span class="topic-cnt">' + t.count + '</span></div>';
      }).join('')
      : '<div class="hint">还没有标签数据，记录后会自动生成。</div>';

    var openTodos = Store.all().filter(function (n) { return n.type === 'todo' && !n.done; })
      .sort(function (a, b) { return (rankPrio(b) - rankPrio(a)) || ((a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1); });
    var doneTodos = Store.all().filter(function (n) { return n.type === 'todo' && n.done; });
    $('#todoPanel').innerHTML =
      (openTodos.length ? openTodos.slice(0, 8).map(function (n) {
        return '<div class="todo-line"><span class="todo-check" data-act="toggle" data-id="' + n.id + '"></span>' +
          '<span class="t" data-open="' + n.id + '">' + esc(n.title) + '</span>' +
          '<span class="rel-score">' + (n.dueDate ? esc(n.dueDate) : '—') + '</span></div>';
      }).join('') : '<div class="hint">没有未完成的待办。</div>') +
      (doneTodos.length ? '<div class="hint" style="margin-top:10px">已完成 ' + doneTodos.length + ' 项</div>' : '');
  }

  function generateSummary() {
    var days = parseInt($('#rangeSelect').value, 10);
    var rangeNotes = Store.inRange(days);
    if (!rangeNotes.length) { toast('这个时间范围内还没有记录'); return; }

    var btn = $('#btnGenerateSummary');
    btn.disabled = true;
    btn.textContent = '生成中…';
    $('#summaryPanel').hidden = false;
    $('#summaryTitle').textContent = (days ? '近 ' + days + ' 天' : '全部') + '阶段总结';
    $('#summaryBody').innerHTML = '<div class="typing"><span></span><span></span><span></span> 正在整理…</div>';

    var done = function (md, isAI) {
      state.lastSummary = md;
      $('#summaryBody').innerHTML = mdToHtml(md);
      $('#summaryTitle').textContent = (days ? '近 ' + days + ' 天' : '全部') + '阶段总结' + (isAI ? ' · 大模型' : ' · 本地引擎');
      btn.disabled = false;
      btn.textContent = '生成阶段总结';
    };

    if (AI.ready()) {
      AI.summarize(rangeNotes, days, Store.config.userName).then(function (md) {
        done(md, true);
      }).catch(function (err) {
        console.warn('总结失败，回退本地', err);
        toast('大模型调用失败，已用本地引擎生成');
        done(Engine.buildSummary(rangeNotes, Store.all(), days).markdown, false);
      });
    } else {
      setTimeout(function () {
        done(Engine.buildSummary(rangeNotes, Store.all(), days).markdown, false);
      }, 260);
    }
  }

  /* ---------------- 问答 ---------------- */

  var SUGGESTS = [
    '最近我在推进哪些事？',
    '有哪些还没完成的待办？',
    '帮我总结这个阶段的主要内容',
    '哪些内容是我标记的重点？',
    '关于知识管理我记过什么？'
  ];

  function renderSuggest() {
    $('#chatSuggest').innerHTML = SUGGESTS.map(function (s) {
      return '<button class="suggest-chip">' + esc(s) + '</button>';
    }).join('');
  }

  function pushMsg(role, html) {
    var el = document.createElement('div');
    el.className = 'msg ' + role;
    el.innerHTML = '<div class="msg-avatar">' + (role === 'user' ? '我' : 'AI') + '</div><div class="msg-body">' + html + '</div>';
    $('#chatLog').appendChild(el);
    $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
    return el;
  }

  function ask(question) {
    question = String(question || '').trim();
    if (!question) return;

    pushMsg('user', esc(question));
    $('#chatInput').value = '';

    var hits = Engine.pickContext(Store.all(), question, 6);

    var typing = pushMsg('ai', '<div class="typing"><span></span><span></span><span></span> 检索并思考中…</div>');

    var render = function (answer, isAI) {
      var src = hits.length
        ? '<div class="src-list"><div class="src-label">引用来源</div>' +
        hits.map(function (h, i) {
          return '<div class="src-item" data-open="' + h.note.id + '"><span class="src-idx">[' + (i + 1) + ']</span>' +
            '<span>' + esc(h.note.title) + '</span></div>';
        }).join('') + '</div>'
        : '';
      typing.querySelector('.msg-body').innerHTML =
        mdToHtml(answer) + src +
        (isAI ? '' : '<div class="src-label" style="margin-top:8px">本地引擎作答 · 在设置中配置大模型可得到更强的推理能力</div>');
      $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
      chatHistory.push({ q: question, a: answer });
    };

    if (AI.ready()) {
      // 带上最近两轮对话，让「再详细点 / 换种说法」这类追问有上下文
      AI.answer(question, hits, Store.config.userName, chatHistory.slice(-2)).then(function (a) {
        render(a, true);
      }).catch(function (err) {
        console.warn('问答失败，回退本地', err);
        toast('大模型调用失败，已用本地检索作答');
        render(Engine.offlineAnswer(question, hits), false);
      });
    } else {
      setTimeout(function () { render(Engine.offlineAnswer(question, hits), false); }, 320);
    }
  }

  /* ---------------- 设置 ---------------- */

  function fillSettings() {
    var c = Store.config;
    $('#cfgProvider').value = c.provider || 'deepseek';
    $('#cfgBaseUrl').value = c.baseUrl || '';
    $('#cfgApiKey').value = c.apiKey || '';
    $('#cfgModel').value = c.model || '';
    $('#cfgUserName').value = c.userName || '';
    $('#cfgDomains').value = c.domains || '';
    $('#cfgAutoTag').checked = !!c.autoTag;
    if ($('#cfgTheme')) $('#cfgTheme').value = c.theme || 'auto';
    if ($('#cfgDensity')) $('#cfgDensity').value = c.density || 'cozy';
    if ($('#cfgFontSize')) {
      var fs = Number(c.fontSize) || 14;
      $('#cfgFontSize').value = fs;
      $('#fontSizeLabel').textContent = fs + ' px';
    }

    var total = Store.all().length;
    var used = Store.estimateBytes();
    var trashN = Store.trash().length;
    $('#dataStat').textContent = total + ' 条记录 · 回收站 ' + trashN + ' 条 · 约 ' + (used / 1024).toFixed(0) + ' KB';

    // 用量条：浏览器 localStorage 上限约 5MB，到 84%（4.2MB）就会开始提示
    var quota = 5 * 1024 * 1024;
    var pct = Math.min(100, used / quota * 100);
    var bar = $('#usageBar');
    if (bar) {
      bar.hidden = false;
      var fill = $('#usageFill');
      fill.style.width = pct.toFixed(1) + '%';
      fill.className = pct > 84 ? 'warn' : (pct > 60 ? 'mid' : '');
      $('#usageText').textContent = '本地存储已用 ' + (used / 1024).toFixed(0) + ' KB / 约 5 MB（' + pct.toFixed(0) + '%）';
    }

    renderTrash();
  }

  function renderTrash() {
    var box = $('#trashList');
    if (!box) return;
    var list = Store.trash();
    if (!list.length) {
      box.innerHTML = '<div class="trash-empty">回收站是空的</div>';
      return;
    }
    box.innerHTML = list.map(function (n) {
      var days = Math.max(0, Math.ceil((Date.now() - n.deletedAt) / 86400000));
      return '<div class="trash-item" data-trash-id="' + esc(n.id) + '">' +
        '<div class="trash-main">' +
        '<div class="trash-title">' + esc(n.title || '（无标题）') + '</div>' +
        '<div class="trash-meta">' + esc(typeLabel(n.type)) + ' · 删除于 ' + days + ' 天前</div>' +
        '</div>' +
        '<button class="mini-btn" data-trash-act="restore" data-id="' + esc(n.id) + '">恢复</button>' +
        '<button class="mini-btn warn" data-trash-act="purge" data-id="' + esc(n.id) + '">彻底删除</button>' +
        '</div>';
    }).join('');
  }

  /* ---------------- 下载 ---------------- */

  /** 触发一次文件下载。放模块级是因为命令面板也要用（它不在 bind 的作用域里）。 */
  function download(text, filename, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 立刻 revoke 会让部分浏览器的下载中断，延后释放
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  /* ---------------- 主题 / 密度 / 字号 ---------------- */

  /**
   * 主题落地。'auto' 交给系统偏好，其余按用户选择。
   * 三个维度（主题 / 密度 / 字号）都写成 <html> 上的属性或 CSS 变量，
   * 这样样式表只需要关心变量，不必为每种组合写一套规则。
   */
  function applyTheme() {
    var c = Store.config || {};
    var theme = c.theme || 'auto';
    var resolved = theme;
    if (theme === 'auto') {
      resolved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.setAttribute('data-density', c.density === 'compact' ? 'compact' : 'cozy');
    document.documentElement.style.setProperty('--base-font', (Number(c.fontSize) || 14) + 'px');

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'light' ? '#f6f7fa' : '#0e1116');

    var btn = $('#btnTheme');
    if (btn) {
      btn.textContent = resolved === 'light' ? '☀' : '☾';
      btn.title = resolved === 'light' ? '切换到深色' : '切换到浅色';
    }
  }

  /** 一键切换深浅色：直接落到具体主题，不再绕回 auto，符合"我看到什么就切什么"的直觉 */
  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme');
    Store.config.theme = cur === 'light' ? 'dark' : 'light';
    Store.saveConfig();
    applyTheme();
    var sel = $('#cfgTheme');
    if (sel) sel.value = Store.config.theme;
  }

  /* ---------------- 命令面板 ---------------- */

  var palette = { items: [], idx: 0 };

  function paletteCommands() {
    return [
      { ico: '+', label: '新建记录', hint: 'N', kw: 'new compose 记录 新建', run: function () { openCompose(); } },
      { ico: '⌕', label: '搜索记录', hint: '/', kw: 'search 查找 检索', run: function () { $('#searchInput').focus(); } },
      { ico: '◎', label: '查看全部内容', kw: 'all 全部', run: function () { switchView('stream', 'all'); } },
      { ico: '·', label: '查看想法', kw: 'idea 想法', run: function () { switchView('stream', 'idea'); } },
      { ico: '·', label: '查看资料', kw: 'material 资料', run: function () { switchView('stream', 'material'); } },
      { ico: '·', label: '查看待办', kw: 'todo 待办 任务', run: function () { switchView('stream', 'todo'); } },
      { ico: '·', label: '查看阶段总结', kw: 'summary 总结', run: function () { switchView('stream', 'summary'); } },
      { ico: '★', label: '查看重点', kw: 'star 重点 收藏', run: function () { switchView('stream', 'star'); } },
      { ico: '◈', label: '打开洞察与总结', kw: 'insight 洞察 统计', run: function () { switchView('insights'); } },
      { ico: '◐', label: '打开智能问答', kw: 'chat ask 问答', run: function () { switchView('chat'); } },
      { ico: '⚙', label: '打开设置', kw: 'settings 设置 配置', run: function () { switchView('settings'); } },
      {
        ico: '◑', label: '切换深色 / 浅色', kw: 'theme 主题 深色 浅色 dark light',
        run: toggleTheme
      },
      {
        ico: '↓', label: '导出 JSON 备份', kw: 'export backup 导出 备份',
        run: function () { download(Store.exportJSON(), '信息管家备份-' + Engine.todayStr() + '.json', 'application/json'); toast('已导出 JSON 备份'); }
      },
      {
        ico: '↓', label: '导出 Markdown', kw: 'export md 导出',
        run: function () {
          if (!Store.all().length) { toast('还没有记录可导出'); return; }
          download(Store.exportMarkdown(), '信息管家-' + Engine.todayStr() + '.md', 'text/markdown;charset=utf-8');
          toast('已导出 Markdown');
        }
      },
      {
        ico: '↓', label: '导出 CSV', kw: 'export csv 导出 表格',
        run: function () {
          if (!Store.all().length) { toast('还没有记录可导出'); return; }
          download(Store.exportCSV(), '信息管家-' + Engine.todayStr() + '.csv', 'text/csv;charset=utf-8');
          toast('已导出 CSV');
        }
      },
      {
        ico: '◇', label: '生成阶段总结', kw: 'summary 总结 阶段',
        run: function () { switchView('insights'); setTimeout(function () { $('#btnGenerateSummary').click(); }, 60); }
      },
      {
        ico: '✓', label: '整理待办', kw: 'todo 整理 待办',
        run: function () { switchView('stream', 'all'); setTimeout(function () { $('#btnOrganizeTodos').click(); }, 60); }
      },
      {
        ico: '◆', label: '重新计算关联', kw: 'relate 关联',
        run: function () {
          Engine.relate(Store.all());
          Store.saveNotes();
          renderAll();
          toast('已重新计算关联');
        }
      },
      {
        ico: '↺', label: '撤销上一步', hint: 'Ctrl+Z', kw: 'undo 撤销',
        run: function () {
          if (!Store.canUndo()) { toast('没有可撤销的操作'); return; }
          Store.undo();
          Engine.relate(Store.all());
          Store.saveNotes();
          renderAll();
          fillSettings();
          toast('已撤销上一步');
        }
      },
      {
        ico: '♻', label: '打开回收站', kw: 'trash 回收站 删除',
        run: function () {
          switchView('settings');
          setTimeout(function () {
            var el = $('#trashList');
            if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }, 80);
        }
      },
      {
        ico: '?', label: '查看快捷键', kw: 'help shortcut 快捷键 帮助',
        run: function () { openPalette('快捷键'); }
      }
    ];
  }

  function paletteResults(q) {
    var query = String(q || '').trim();
    var cmds = paletteCommands();
    if (!query) return cmds.slice(0, 10);

    var out = cmds.filter(function (c) {
      return c.label.indexOf(query) >= 0 || (c.kw || '').indexOf(query) >= 0;
    });

    // 命令之外也直接搜记录：用户按 Ctrl+K 时往往就是想找某条笔记
    if (Store.all().length) {
      var hits = Engine.search(Store.all(), query).slice(0, 8);
      hits.forEach(function (h) {
        out.push({
          ico: '·',
          label: h.note.title || '（无标题）',
          hint: typeLabel(h.note.type),
          run: function () { openDetail(h.note.id); }
        });
      });
    }
    return out.slice(0, 14);
  }

  function renderPalette() {
    var q = $('#paletteInput').value;
    palette.items = paletteResults(q);
    if (palette.idx >= palette.items.length) palette.idx = 0;
    var box = $('#paletteList');
    if (!palette.items.length) {
      box.innerHTML = '<div class="palette-empty">没有匹配的命令或记录</div>';
      return;
    }
    box.innerHTML = palette.items.map(function (c, i) {
      return '<button class="palette-item' + (i === palette.idx ? ' on' : '') + '" data-pi="' + i + '" role="option">' +
        '<span class="pi-ico">' + esc(c.ico || '·') + '</span>' +
        '<span class="pi-label">' + esc(c.label) + '</span>' +
        (c.hint ? '<span class="pi-hint">' + esc(c.hint) + '</span>' : '') +
        '</button>';
    }).join('');
  }

  function openPalette(prefill) {
    $('#palette').hidden = false;
    var inp = $('#paletteInput');
    inp.value = prefill || '';
    palette.idx = 0;
    renderPalette();
    setTimeout(function () { inp.focus(); inp.select(); }, 0);
  }

  function closePalette() {
    $('#palette').hidden = true;
  }

  function runPaletteItem(i) {
    var c = palette.items[i];
    if (!c) return;
    closePalette();
    // 命令内部可能又要开面板（如"查看快捷键"），放到下一帧避免刚关又被同一个 Esc 关掉
    setTimeout(function () { c.run(); }, 0);
  }

  function initPalette() {
    var inp = $('#paletteInput');
    inp.addEventListener('input', function () { palette.idx = 0; renderPalette(); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        palette.idx = Math.min(palette.idx + 1, palette.items.length - 1);
        renderPalette();
        scrollPaletteIntoView();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        palette.idx = Math.max(palette.idx - 1, 0);
        renderPalette();
        scrollPaletteIntoView();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runPaletteItem(palette.idx);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closePalette();
      }
    });
    $('#paletteList').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-pi]');
      if (btn) runPaletteItem(Number(btn.getAttribute('data-pi')));
    });
    $('#btnPalette').addEventListener('click', function () { openPalette(); });
  }

  function scrollPaletteIntoView() {
    var el = $('#paletteList .palette-item.on');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function readSettings() {
    Store.config.provider = $('#cfgProvider').value;
    Store.config.baseUrl = $('#cfgBaseUrl').value.trim();
    Store.config.apiKey = $('#cfgApiKey').value.trim();
    Store.config.model = $('#cfgModel').value.trim();
    Store.config.userName = $('#cfgUserName').value.trim();
    Store.config.domains = $('#cfgDomains').value.trim();
    Store.config.autoTag = $('#cfgAutoTag').checked;
    if ($('#cfgTheme')) Store.config.theme = $('#cfgTheme').value;
    if ($('#cfgDensity')) Store.config.density = $('#cfgDensity').value;
    if ($('#cfgFontSize')) Store.config.fontSize = Number($('#cfgFontSize').value) || 14;
    Store.saveConfig();
    applyTheme();
  }

  /* ---------------- 批处理动作 ---------------- */

  function batchExtract() {
    var list = currentList().filter(function (n) { return n.type !== 'todo'; });
    if (!list.length) { toast('当前没有可提炼的内容'); return; }
    var targets = list.slice(0, 20);
    var btn = $('#btnExtract');
    btn.disabled = true;
    btn.textContent = '提炼中…';

    var idx = 0;
    var next = function () {
      if (idx >= targets.length) {
        btn.disabled = false; btn.textContent = '提取重点';
        Store.saveNotes(); renderAll();
        toast('已提炼 ' + targets.length + ' 条');
        return;
      }
      var n = targets[idx++];
      var applyLocal = function () {
        Store.update(n.id, { summary: Engine.extractiveSummary(n.content, 1), keyPoints: Engine.keyPoints(n.content, 3) });
        next();
      };
      if (AI.ready()) {
        AI.extract(n).then(function (r) {
          Store.update(n.id, { summary: r.summary || n.summary, keyPoints: r.keyPoints.length ? r.keyPoints : n.keyPoints });
          next();
        }).catch(applyLocal);
      } else {
        applyLocal();
      }
    };
    next();
  }

  function organizeTodos() {
    var pool = Store.all().filter(function (n) { return !n.done && n.type !== 'summary'; }).slice(0, 60);
    if (!pool.length) { toast('还没有可整理的内容'); return; }
    var btn = $('#btnOrganizeTodos');
    btn.disabled = true;
    btn.textContent = '整理中…';

    var existing = {};
    Store.all().forEach(function (n) { existing[String(n.title).slice(0, 20)] = true; });

    var addAll = function (items) {
      var added = 0;
      items.forEach(function (it) {
        if (existing[String(it.title).slice(0, 20)]) return;
        Store.add({
          type: 'todo',
          title: it.title,
          content: it.title + (it.reason ? '（' + it.reason + '）' : ''),
          tags: ['整理'],
          priority: it.priority || 'medium',
          dueDate: it.dueDate || null,
          summary: it.reason || ''
        });
        existing[String(it.title).slice(0, 20)] = true;
        added++;
      });
      btn.disabled = false; btn.textContent = '整理待办';
      Engine.relate(Store.all()); Store.saveNotes(); renderAll();
      toast(added ? ('新增 ' + added + ' 条待办') : '没有发现新的待办');
    };

    if (AI.ready()) {
      AI.organizeTodos(pool).then(addAll).catch(function (err) {
        console.warn('整理失败，回退本地', err);
        var items = [];
        pool.forEach(function (n) {
          Engine.actionItems(n.content || '').forEach(function (s) {
            items.push({ title: s.slice(0, 40), priority: n.priority, dueDate: n.dueDate, reason: '来自记录：' + n.title });
          });
        });
        addAll(items);
      });
    } else {
      var items = [];
      pool.forEach(function (n) {
        if (n.type === 'todo') items.push({ title: n.title, priority: n.priority, dueDate: n.dueDate, reason: '' });
        Engine.actionItems(n.content || '').forEach(function (s) {
          items.push({ title: s.slice(0, 40), priority: n.priority, dueDate: Engine.detectDueDate(s), reason: '来自记录：' + n.title });
        });
      });
      addAll(items);
    }
  }

  function reRelate() {
    Engine.relate(Store.all());
    Store.saveNotes();
    renderAll();
    toast('已重新计算内容关联');
  }

  function reAnalyze(id) {
    var n = Store.get(id);
    if (!n) return;
    if (!AI.ready()) {
      var idx2 = Engine.buildIndex(Store.all());
      Store.update(n.id, {
        type: Engine.classify(n.content),
        title: Engine.makeTitle(n.content),
        tags: Engine.keywords(n.content, idx2.df, idx2.N, 3),
        summary: Engine.extractiveSummary(n.content, 1),
        keyPoints: Engine.keyPoints(n.content, 3)
      });
      Store.saveNotes(); renderAll(); openDetail(id);
      toast('已用本地引擎重新提炼');
      return;
    }
    toast('正在重新提炼…');
    AI.analyze(n.content, Store.config.domains).then(function (r) {
      Store.update(n.id, {
        type: r.type, title: r.title, summary: r.summary,
        tags: r.tags, priority: r.priority, dueDate: r.dueDate, keyPoints: r.keyPoints, aiTagged: true
      });
      Store.saveNotes(); renderAll(); openDetail(id);
      toast('已重新提炼');
    }).catch(function (err) {
      toast('提炼失败：' + err.message);
    });
  }

  /* ---------------- 渲染总入口 ---------------- */

  function renderAll() {
    renderSidebar();
    if (state.view === 'stream') renderStream();
    if (state.view === 'insights') renderInsights();
  }

  function switchView(view, filter) {
    state.view = view;
    state.limit = PAGE_SIZE;
    if (filter) state.filter = filter;
    $$('.view').forEach(function (v) { v.classList.remove('active'); });
    var map = { stream: '#viewStream', insights: '#viewInsights', chat: '#viewChat', settings: '#viewSettings' };
    $(map[view]).classList.add('active');
    $$('#navMain .nav-item').forEach(function (a) { a.classList.remove('active'); });
    var active = $('#navMain .nav-item[data-view="' + view + '"]' + (filter ? '[data-filter="' + filter + '"]' : ''));
    if (active) active.classList.add('active');
    renderAll();
    if (view === 'settings') fillSettings();
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    // 导航（窄屏点完自动收起抽屉）
    $('#navMain').addEventListener('click', function (e) {
      var item = e.target.closest('.nav-item');
      if (!item) return;
      switchView(item.getAttribute('data-view'), item.getAttribute('data-filter'));
      $('.sidebar').classList.remove('open');
    });

    // 窄屏汉堡菜单
    $('#btnMenu').addEventListener('click', function () {
      $('.sidebar').classList.toggle('open');
    });

    // 搜索：防抖，避免逐字触发全量检索；清空后自动退回「最近」排序
    var si = $('#searchInput');
    var searchTimer = null;
    var applyQuery = function (v) {
      state.query = v;
      state.limit = PAGE_SIZE;        // 换关键词后重新从第一页看起
      if (state.view !== 'stream') switchView('stream', state.filter);
      else renderStream();
      if (state.query.trim() && state.sort === 'recent') setSort('relevance');
      else if (!state.query.trim() && state.sort === 'relevance') setSort('recent');
    };
    si.addEventListener('input', function () {
      var v = si.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { applyQuery(v); }, 180);
    });
    $('#searchClear').addEventListener('click', function () {
      clearTimeout(searchTimer);
      si.value = ''; applyQuery('');
    });

    // 排序
    $('#sortSeg').addEventListener('click', function (e) {
      var b = e.target.closest('.seg-btn');
      if (!b) return;
      setSort(b.getAttribute('data-sort'));
      renderStream();
    });

    // 标签筛选
    $('#tagCloud').addEventListener('click', function (e) {
      var t = e.target.closest('.tag-chip');
      if (!t) return;
      toggleTag(t.getAttribute('data-tag'));
    });

    $('#filterChips').addEventListener('click', function (e) {
      var u = e.target.closest('[data-untag]');
      if (u) { toggleTag(u.getAttribute('data-untag')); return; }
      if (e.target.closest('[data-unquery]')) {
        state.query = ''; $('#searchInput').value = ''; renderStream(); return;
      }
      if (e.target.closest('[data-onlyopen]')) {
        state.onlyOpen = !state.onlyOpen;
        renderStream();
      }
    });

    // 卡片区事件委托
    $('#cardList').addEventListener('click', onCardClick);
    $('#detailBox').addEventListener('click', onCardClick);

    // 记录
    $('#btnCompose').addEventListener('click', function () { openCompose(); });
    $('#emptyCompose').addEventListener('click', function () { openCompose(); });
    $('#emptyClear').addEventListener('click', clearFilters);
    $('#btnSaveNote').addEventListener('click', saveNote);
    $('#typePicker').addEventListener('click', function (e) {
      var b = e.target.closest('.type-btn');
      if (!b) return;
      $$('#typePicker .type-btn').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
    });
    $('#composeText').addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveNote(); }
    });

    // 批处理
    $('#btnAutoRelate').addEventListener('click', reRelate);
    $('#btnExtract').addEventListener('click', batchExtract);
    $('#btnOrganizeTodos').addEventListener('click', organizeTodos);

    // 洞察
    $('#btnGenerateSummary').addEventListener('click', generateSummary);
    $('#rangeSelect').addEventListener('change', renderInsights);
    $('#btnSaveSummary').addEventListener('click', function () {
      if (!state.lastSummary) { toast('先生成总结'); return; }
      var days = parseInt($('#rangeSelect').value, 10);
      Store.add({
        type: 'summary',
        title: (days ? '近 ' + days + ' 天' : '全部') + '阶段总结 · ' + Engine.todayStr(),
        content: state.lastSummary,
        tags: ['阶段总结'],
        priority: 'medium',
        summary: Engine.extractiveSummary(state.lastSummary.replace(/[#*]/g, ''), 1)
      });
      Engine.relate(Store.all()); Store.saveNotes(); renderAll();
      toast('已保存为记录');
    });
    $('#todoPanel').addEventListener('click', onCardClick);
    $('#topicPanel').addEventListener('click', function (e) {
      var r = e.target.closest('[data-tag]');
      if (r) { toggleTag(r.getAttribute('data-tag')); switchView('stream', state.filter); }
    });

    // 问答
    $('#btnAsk').addEventListener('click', function () { ask($('#chatInput').value); });
    $('#chatInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask($('#chatInput').value); }
    });
    $('#chatSuggest').addEventListener('click', function (e) {
      var c = e.target.closest('.suggest-chip');
      if (c) ask(c.textContent);
    });
    $('#chatLog').addEventListener('click', function (e) {
      var s = e.target.closest('[data-open]');
      if (s) openDetail(s.getAttribute('data-open'));
    });

    // 设置
    $('#cfgProvider').addEventListener('change', function () {
      var p = Store.PROVIDERS[$('#cfgProvider').value];
      if (p) {
        $('#cfgBaseUrl').value = p.baseUrl;
        $('#cfgModel').value = p.model;
      }
    });
    $('#btnTestModel').addEventListener('click', function () {
      readSettings();
      var el = $('#testResult');
      el.className = 'test-result';
      el.textContent = '测试中…';
      if (!AI.ready()) { el.className = 'test-result err'; el.textContent = '请先填写 Base URL、API Key 和模型名'; return; }
      AI.test().then(function (t) {
        el.className = 'test-result ok';
        el.textContent = '连接成功：' + t;
        renderSidebar();
      }).catch(function (err) {
        el.className = 'test-result err';
        el.textContent = err.message;
      });
    });
    $('#btnClearModel').addEventListener('click', function () {
      Store.config.apiKey = '';
      Store.saveConfig();
      fillSettings(); renderSidebar();
      $('#testResult').textContent = '已清除密钥，切换到本地引擎';
      $('#testResult').className = 'test-result';
    });
    $('#btnSavePrefs').addEventListener('click', function () {
      readSettings(); renderSidebar(); toast('已保存');
    });
    $('#cfgUserName').addEventListener('change', readSettings);
    $('#cfgDomains').addEventListener('change', readSettings);
    $('#cfgAutoTag').addEventListener('change', readSettings);

    // 外观：三个控件都即时生效，不需要再点"保存"
    $('#btnTheme').addEventListener('click', toggleTheme);
    $('#cfgTheme').addEventListener('change', function () { readSettings(); toast('主题已更新'); });
    $('#cfgDensity').addEventListener('change', function () { readSettings(); });
    $('#cfgFontSize').addEventListener('input', function () {
      $('#fontSizeLabel').textContent = $('#cfgFontSize').value + ' px';
      readSettings();
    });

    // 分批渲染：按钮 + 滚动到底自动补
    $('#btnLoadMore').addEventListener('click', loadMore);
    if (window.IntersectionObserver) {
      var io = new IntersectionObserver(function (entries) {
        if (entries.some(function (en) { return en.isIntersecting; })) loadMore();
      }, { rootMargin: '240px' });
      io.observe($('#loadMoreWrap'));
    }

    // 命令面板
    initPalette();

    // 数据
    $('#btnExport').addEventListener('click', function () {
      download(Store.exportJSON(), '信息管家备份-' + Engine.todayStr() + '.json', 'application/json');
      toast('已导出 JSON 备份');
    });
    $('#btnExportMd').addEventListener('click', function () {
      if (!Store.all().length) { toast('还没有记录可导出'); return; }
      download(Store.exportMarkdown(), '信息管家-' + Engine.todayStr() + '.md', 'text/markdown;charset=utf-8');
      toast('已导出 Markdown');
    });
    $('#btnExportCsv').addEventListener('click', function () {
      if (!Store.all().length) { toast('还没有记录可导出'); return; }
      download(Store.exportCSV(), '信息管家-' + Engine.todayStr() + '.csv', 'text/csv;charset=utf-8');
      toast('已导出 CSV');
    });
    $('#btnImport').addEventListener('click', function () { $('#importFile').click(); });
    $('#importFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var r = Store.importJSON(String(reader.result));
          Engine.relate(Store.all());
          Store.saveNotes(); renderAll(); fillSettings();
          var parts = ['新增 ' + r.added + ' 条'];
          if (r.duplicated) parts.push('跳过重复 ' + r.duplicated + ' 条');
          if (r.skipped) parts.push('跳过无效 ' + r.skipped + ' 条');
          toast('导入完成：' + parts.join('，'));
        } catch (err) {
          toast('导入失败：' + err.message);
        }
        e.target.value = '';
      };
      reader.readAsText(f);
    });
    $('#btnClearAll').addEventListener('click', function () {
      if (!Store.all().length) { toast('已经是空的'); return; }
      if (!confirm('确定清空全部 ' + Store.all().length + ' 条记录吗？清空后可按 Ctrl+Z 撤销，但仍建议先导出备份。')) return;
      Store.clearAll(); renderAll(); fillSettings();
      toast('已清空', '撤销', function () {
        Store.undo(); Engine.relate(Store.all()); Store.saveNotes();
        renderAll(); fillSettings();
      });
    });

    // 回收站
    $('#trashList').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-trash-act]');
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      var act = btn.getAttribute('data-trash-act');
      if (act === 'restore') {
        if (Store.restore(id)) {
          Engine.relate(Store.all());
          Store.saveNotes();
          renderAll(); fillSettings();
          toast('已恢复');
        } else {
          toast('恢复失败：记录可能已被清理');
        }
        return;
      }
      if (act === 'purge') {
        if (!confirm('彻底删除后无法恢复，确定吗？')) return;
        Store.purge(id);
        renderTrash(); fillSettings();
        toast('已彻底删除');
      }
    });
    $('#btnEmptyTrash').addEventListener('click', function () {
      var n = Store.trash().length;
      if (!n) { toast('回收站已经是空的'); return; }
      if (!confirm('彻底删除回收站里的 ' + n + ' 条记录？此操作不可恢复。')) return;
      Store.emptyTrash();
      renderTrash(); fillSettings();
      toast('回收站已清空');
    });

    /* ---------- 导入文本文档（txt/md/csv/html/rtf/doc/docx/odt 等） ---------- */
    // 超长正文按段落边界切块：每块 ≤ size，避免单条记录被 2 万字上限悄悄截断
    function splitForImport(text, size) {
      if (text.length <= size) return [text];
      var parts = [], i = 0;
      while (i < text.length) {
        var end = Math.min(i + size, text.length);
        if (end < text.length) {
          var nl = text.lastIndexOf('\n', end);
          if (nl > i + size * 0.5) end = nl + 1;   // 优先在换行处断开，至少保留一半
        }
        parts.push(text.slice(i, end));
        i = end;
      }
      return parts;
    }

    $('#btnImportDoc').addEventListener('click', function () { $('#importDocFile').click(); });
    $('#importDocFile').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      e.target.value = '';
      if (!files.length) return;

      var results = { ok: 0, backup: 0, fail: 0, notes: [], bases: [] };
      var next = function (idx) {
        if (idx >= files.length) {
          if (results.ok || results.backup) {
            Engine.relate(Store.all());
            Store.saveNotes(); renderAll(); fillSettings();
          }
          var msg = [];
          if (results.ok) msg.push('成功导入 ' + results.ok + ' 篇文档');
          if (results.backup) msg.push('备份导入 ' + results.backup + ' 份');
          if (results.fail) msg.push(results.fail + ' 个文件失败');
          var line = msg.join('，') || '未导入任何文件';
          var bad = results.notes.filter(function (n) { return /失败|未提取/.test(n); });
          if (bad.length) line += '：' + bad[0].replace(/^[^→]*→\s*/, '');
          toast(line);
          results.notes.forEach(function (n) { console.log('[导入] ' + n); });
          // 导入成功后自动「定位」：切到记录流并预填搜索词，让刚导入的内容立刻可见，
          // 避免用户面对一屏旧记录找不到新内容（检索框可一键清空还原）。
          if (results.bases.length) {
            try {
              switchView('stream');
              var q = [];
              results.bases.forEach(function (b) {
                if (q.indexOf(b) < 0 && (q.join(' ') + ' ' + b).trim().length <= 80) q.push(b);
              });
              si.value = q.join(' ');
              applyQuery(si.value);
            } catch (e2) { /* 定位失败不影响导入结果 */ }
          }
          return;
        }
        var f = files[idx];
        var reader = new FileReader();
        var done = function (r) {
          try {
            if (r.kind === 'backup') {
              try {
                var br = Store.importJSON(r.text);
                results.backup++;
                results.notes.push(f.name + ' → 备份导入 ' + br.added + ' 条');
              } catch (err) {
                results.fail++;
                results.notes.push(f.name + ' → 备份导入失败：' + err.message);
              }
            } else if (r.kind === 'error') {
              results.fail++;
              results.notes.push(f.name + ' → 失败：' + r.error);
            } else if (!r.text.trim()) {
              results.fail++;
              results.notes.push(f.name + ' → 未提取到文字' + (r.warning ? '（' + r.warning + '）' : ''));
            } else {
              var base = f.name.replace(/\.[^.]+$/, '');
              results.bases.push(base);
              var parts = splitForImport(r.text, 19000);   // 单条上限 2 万字，超长文档分段保全内容
              parts.forEach(function (part, pi) {
                Store.add({
                  type: 'material',
                  title: parts.length > 1 ? base + '（' + (pi + 1) + '/' + parts.length + '）' : base,
                  content: part,
                  tags: ['导入', DocImport.extOf(f.name)].concat(parts.length > 1 ? ['分段'] : [])
                });
              });
              if (r.warning) toast(f.name + '：' + r.warning);
              results.ok++;
              results.notes.push(f.name + ' → ' + r.format + '，' + r.text.length + ' 字' +
                (parts.length > 1 ? '（自动分为 ' + parts.length + ' 条）' : ''));
            }
          } catch (err) {
            results.fail++;
            results.notes.push(f.name + ' → 处理异常：' + err.message);
          }
          next(idx + 1);
        };
        reader.onload = function () {
          DocImport.extract(f.name, reader.result).then(done).catch(function (err) {
            results.fail++;
            results.notes.push(f.name + ' → 解析异常：' + ((err && err.message) || err));
            next(idx + 1);
          });
        };
        reader.onerror = function () {
          results.fail++;
          results.notes.push(f.name + ' → 文件读取失败');
          next(idx + 1);
        };
        reader.readAsArrayBuffer(f);
      };
      next(0);
    });
    $('#btnSeed').addEventListener('click', function () {
      if (Store.all().length && !confirm('载入示例数据会追加到现有记录，继续？')) return;
      var n = Store.seed();
      Engine.relate(Store.all());
      Store.saveNotes(); renderAll(); fillSettings();
      toast('已载入 ' + n + ' 条示例');
    });

    // 关闭层
    document.addEventListener('click', function (e) {
      var c = e.target.closest('[data-close]');
      if (!c) return;
      if (c.closest('#composeModal')) $('#composeModal').hidden = true;
      if (c.closest('#detailDrawer')) $('#detailDrawer').hidden = true;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!$('#palette').hidden) { closePalette(); return; }
        $('#composeModal').hidden = true;
        $('#detailDrawer').hidden = true;
        return;
      }

      var tag = (e.target && e.target.tagName) || '';
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable);
      var mod = e.ctrlKey || e.metaKey;

      // Ctrl/⌘ + K：命令面板。输入框里也要生效——这是全局入口，不是编辑器快捷键。
      if (mod && String(e.key).toLowerCase() === 'k') {
        e.preventDefault();
        if ($('#palette').hidden) openPalette(); else closePalette();
        return;
      }

      if (typing) return;

      // Ctrl/⌘ + Z 撤销最近一次增删改。
      // 在输入框里要放行浏览器自带的文本撤销，否则打字时按 Ctrl+Z 会误删记录。
      if (mod && !e.shiftKey && String(e.key).toLowerCase() === 'z') {
        if (Store.canUndo()) {
          e.preventDefault();
          Store.undo();
          Engine.relate(Store.all());
          Store.saveNotes();
          renderAll();
          fillSettings();
          toast('已撤销上一步');
        }
        return;
      }

      if (mod || e.altKey) return;

      // 单键快捷键：/ 搜索、n 新建、? 命令面板（已输入 ? 时顺带展示快捷键）
      if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); return; }
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openCompose(); return; }
      if (e.key === '?') { e.preventDefault(); openPalette('快捷键'); }
    });
  }

  function onCardClick(e) {
    var open = e.target.closest('[data-open]');
    if (open && !e.target.closest('[data-act]')) { openDetail(open.getAttribute('data-open')); return; }

    var tag = e.target.closest('[data-tag]');
    if (tag) { toggleTag(tag.getAttribute('data-tag')); return; }

    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    var act = btn.getAttribute('data-act');

    if (act === 'toggle') {
      var n = Store.get(id);
      if (!n) return;
      Store.update(id, { done: !n.done });
      renderAll();
      if (!$('#detailDrawer').hidden) openDetail(id);
      return;
    }
    if (act === 'star') {
      var m = Store.get(id);
      Store.update(id, { pinned: !m.pinned });
      renderAll();
      if (!$('#detailDrawer').hidden) openDetail(id);
      return;
    }
    if (act === 'detail') { openDetail(id); return; }
    if (act === 'edit') {
      $('#detailDrawer').hidden = true;
      openCompose(Store.get(id));
      return;
    }
    if (act === 'retype') {
      var t = btn.getAttribute('data-type');
      Store.update(id, { type: t });
      Engine.relate(Store.all(), [id]);
      Store.saveNotes();
      renderAll();
      openDetail(id);
      toast('已归类为「' + typeLabel(t) + '」');
      return;
    }
    if (act === 'copy') {
      var c = Store.get(id);
      if (c) copyText(c.content || '');
      return;
    }
    if (act === 'ai') { reAnalyze(id); return; }
    if (act === 'del') {
      var x = Store.get(id);
      if (!x) return;
      if (!confirm('删除「' + (x.title || '这条记录') + '」？会先移入回收站，可随时恢复。')) return;
      Store.remove(id);
      $('#detailDrawer').hidden = true;
      renderAll();
      fillSettings();
      toast('已移入回收站', '撤销', function () {
        if (Store.restore(id)) {
          Engine.relate(Store.all());
          Store.saveNotes();
          renderAll(); fillSettings();
          toast('已恢复');
        } else {
          toast('恢复失败：记录可能已过期清理');
        }
      });
      return;
    }
  }

  function toggleTag(tag) {
    state.limit = PAGE_SIZE;
    var i = state.tags.indexOf(tag);
    if (i >= 0) state.tags.splice(i, 1);
    else state.tags.push(tag);
    // 保留当前类型筛选：在「待办」下点标签不该跳回「全部」
    if (state.view !== 'stream') switchView('stream', state.filter);
    else renderAll();
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    // 存储写入失败（最常见是配额写满）必须让用户看到，不能静默丢失
    Store.onError = function (msg) { toast(msg); };

    // 容量预警：同一条提示 5 分钟内只弹一次，否则每次保存都弹会很烦
    var lastQuotaWarn = 0;
    Store.onQuotaWarn = function (msg) {
      var now = Date.now();
      if (now - lastQuotaWarn < 5 * 60000) return;
      lastQuotaWarn = now;
      toast(msg, '去设置', function () {
        state.view = 'settings';
        renderAll();
      });
    };

    Store.load();
    Engine.relate(Store.all());
    Store.saveNotes();
    applyTheme();

    // 跟随系统时，系统切主题要立刻反映过来，否则要刷新才生效
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      var onChange = function () {
        if ((Store.config.theme || 'auto') === 'auto') applyTheme();
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
    bind();
    renderSuggest();
    renderAll();

    if (!Store.all().length) {
      $('#emptyState').hidden = false;
    }
    console.log('[信息管家] 已启动，记录数：' + Store.all().length + '，大模型：' + (AI.ready() ? '已接入' : '本地引擎'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /**
   * 调试/基准接口。
   * 内部函数都在闭包里，压测与自动化验证需要一个稳定入口；
   * 只暴露只读或幂等的能力，不提供"直接改数据"的后门。
   */
  window.__infoButler = {
    state: state,
    renderAll: function () { renderAll(); },
    renderStream: function () { renderStream(); },
    switchView: function (v, f) { switchView(v, f); },
    openPalette: function (q) { openPalette(q); },
    applyTheme: function () { applyTheme(); },
    version: '1.1.0'
  };
})();
