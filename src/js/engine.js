/* ===========================================================
 * engine.js —— 本地智能引擎
 * 完全离线：分词、关键词抽取、分类、关联、检索、摘要、总结。
 * 有大模型时由 ai.js 接管；无大模型时这里是全部智能来源。
 * =========================================================== */
(function (global) {
  'use strict';

  var STOP = ('的 了 是 在 我 有 和 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会 着 没有 看 好 自己 这 那 我们 他们 什么 怎么 可以 因为 所以 但是 而且 还是 这个 那个 一些 这样 那样 时候 现在 已经 可能 应该 需要 觉得 感觉 如果 虽然 然后 另外 或者 对于 关于 通过 进行 实现 使用 以及 之后 之前 里面 出来 起来 一下 一些 一点 一直 非常 真的 只是 就是 不是 还有 再 把 被 给 让 从 向 对 与 及 等 以 为 之 其 此 该 各 每 某 几 多 少 更 最 太 挺 超 别 嗯 哦 啊 吧 呢 吗 嘛 哈哈 一个 这种 那种 一种 部分 方面 问题 东西 事情 情况 方式 内容 相关 有关 目前 当前 今天 昨天 明天 本周 本月 之前 之后 另外 例如 比如 其中 这些 那些 它们 它们 我们 你们 他们 它们 自己 大家 个人 有点 有点 比较 相对 直接 主要 重要 一般 特别 尤其 甚至 几乎 差不多 好像 似乎 大概 也许 或许 一定 必须 当然 其实 实际上 总之 因此 于是 接着 其次 最后 首先 开始 结束 完成 已经 尚未 无法 不能 能够 应该 可能').split(/\s+/);
  var STOPSET = {};
  STOP.forEach(function (w) { if (w) STOPSET[w] = true; });

  /**
   * 虚词单字。二元组兜底会产生大量跨词边界的碎片（"的投" "图不" "要只"），
   * 它们既是噪声，又会让两条无关记录因为共享"的投"而显得相关。
   * 含虚词的二元组一律不参与索引；词典成词不受影响（词典词先命中，走不到这条分支）。
   */
  var FUNC_CHAR = '的了着得地是在和与就也都很不没要会能把被让给从向对为之其此该这那些什么但而且还又再才只已呢吗吧啊';
  var FUNCSET = {};
  for (var _fi = 0; _fi < FUNC_CHAR.length; _fi++) FUNCSET[FUNC_CHAR.charAt(_fi)] = true;

  function isJunkBigram(g) {
    return g.length !== 2 || FUNCSET[g.charAt(0)] || FUNCSET[g.charAt(1)];
  }

  /* 分类信号分档。
   * 早期版本把「做 / 约 / 买」这类单字也算信号，又给「短句」无条件加 0.7 分，
   * 结果一句 40 字的观点（"路线图不要只列功能，要写清楚…"）会被判成待办。
   * 现在短句不再自动加分：只有出现动作指令、或「有动作 + 有明确时间」才判待办。 */
  var TODO_STRONG = ['记得', '别忘了', '别忘', '待办', 'todo', 'deadline', '提交', '回复', '联系', '跟进',
    '确认', '安排', '准备', '整理', '修复', '上线', '发布', '排期', '推进', '预约', '报名', '缴费', '报销',
    '签字', '发给', '交给', '转给', '抄送', '对齐', '开会', '拉个会', '复盘', '催一下', '打电话', '发邮件'];
  var TODO_WEAK = ['计划', '需要', '优化', '处理', '完成', '检查', '核对', '更新', '补充', '调研', '评估',
    '审批', '打款', '付款', '发货', '退货'];
  /* 句首出现这些词，多半是在下指令（"把 X 发给 Y" / "整理一下 Z"）。
   * 单字动词（做/约/买）只在句首才算信号——放在任意位置会把
   * "再交给模型总结"、"今日必做" 这类描述句误判成待办。 */
  var IMPERATIVE_HEAD = /^(请|帮我|帮忙|记得|别忘|把|给|去|来|做|买|写|发|打|约|查|看|读|改|删|加|找|问|订|付|交|整理|确认|联系|安排|准备|提交|修复|优化|上线|排期|推进|补充|更新|检查|核对)/;

  /* 句首时间状语。「明天交周报」要先剥掉"明天"才看得到动词"交"，
   * 否则句首判断永远失效，这类最典型的待办反而被归成想法。 */
  var LEAD_TIME = new RegExp(
    '^(?:(?:今天|明天|后天|大后天|本周|这周|下周|上周|周末|月底|月初|月初|上午|下午|中午|晚上|早上|' +
    '周[一二三四五六日天]|星期[一二三四五六日天]|' +
    '\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}月\\d{1,2}[日号]|\\d{1,2}[:：]\\d{2}|\\d+\\s*天内|' +
    '[\\d一二三四五六七八九十]+\\s*(?:点|时)(?:半)?)[前后]?\\s*)+'
  );
  var IDEA_STRONG = ['我觉得', '我认为', '感觉', '或许', '也许', '可能', '会不会', '是不是', '如果',
    '假设', '设想', '灵感', '突然想到', '想法', '观点', '反思', '思考', '值得', '不如', '要不要', '是否', '希望'];
  var MATERIAL_STRONG = ['摘自', '摘录', '引用', '来源', '作者', '提到', '原文', '读书', '论文', '报告',
    '数据显示', '研究', '统计', '调研', '链接', 'http', 'www.', '《', '》',
    '文章', '文档', '报道', '资讯', '教程', '博客', '专栏', '书中'];
  var HIGH_SIGNAL = ['紧急', '立刻', '马上', '今天', 'asap', '重要', '关键', '务必', '优先', '必须', '尽快', 'deadline'];
  var LOW_SIGNAL = ['有空', '以后', '将来', '或许', '随缘', '不急', '慢慢'];

  /* ---------------- 基础文本处理 ---------------- */

  /** 类型中文名的唯一来源：界面徽章与离线问答都引用它，避免两处各写一份而走样 */
  var TYPE_CN = { idea: '想法', material: '资料', todo: '待办', summary: '总结' };

  /**
   * 中文分词：词典正向最大匹配 + 未登录词用字符二元组兜底。
   *
   * 为什么要二元组兜底：词典只有几百个常用词，一旦遇到没收录的词
   * （"路线图""投入产出比"），旧实现会把这些字直接丢掉。
   * 结果是「明天下午三点前把 Q4 路线图发给张总…」整句只抽出 `q4` 一个词，
   * 检索和关联全废。中文检索里用字符二元组建索引是成熟做法，
   * 对短文本尤其有效，代价是词表变大（IDF 会把噪声压下去）。
   *
   * @param {string} text
   * @param {object} [opts]
   * @param {boolean} [opts.bigramFallback=true] false 时只用词典词（标签抽取用，避免碎片）
   */
  function tokenize(text, opts) {
    if (!text) return [];
    var bigramFallback = !opts || opts.bigramFallback !== false;
    var s = String(text).toLowerCase();
    var out = [];

    // 英文 / 数字串整体成词，保留连字符：否则 GPT-4 会被切成 gpt，搜「gpt-4」永远不命中
    var en = s.match(/[a-z][a-z0-9+#.]*(?:-[a-z0-9.]+)*/g);
    if (en) out = out.concat(en.filter(function (w) { return w.length > 1 && !STOPSET[w]; }));

    var segs = s.match(/[\u4e00-\u9fa5]+/g) || [];

    // 全篇 2-gram 频次：重复出现过的二元组大概率是真词，比随机碎片可信
    var bi = {};
    segs.forEach(function (seg) {
      for (var j = 0; j + 1 < seg.length; j++) {
        var b = seg.substr(j, 2);
        if (STOPSET[b]) continue;
        bi[b] = (bi[b] || 0) + 1;
      }
    });

    segs.forEach(function (seg) {
      if (seg.length <= 1) return;
      var i = 0;
      while (i < seg.length) {
        var matched = null;
        var maxLen = Math.min(4, seg.length - i);
        for (var len = maxLen; len >= 2; len--) {
          var w = seg.substr(i, len);
          if (DICTSET[w]) { matched = w; break; }
        }
        if (matched) {
          if (!STOPSET[matched]) out.push(matched);
          i += matched.length;
          continue;
        }
        var g = seg.substr(i, 2);
        var isBigram = g.length === 2 && !STOPSET[g] && !isJunkBigram(g);
        if (isBigram && (bi[g] >= 2 || bigramFallback)) out.push(g);
        i += 1;                       // 逐字滑动，保证二元组全覆盖
      }
    });
    return out;
  }

  /** 只取词典成词：给标签用，避免「入产」这类跨词边界的碎片污染标签云 */
  function tokenizeWords(text) {
    return tokenize(text, { bigramFallback: false });
  }

  function termFreq(text) {
    var toks = tokenize(text);
    var tf = {};
    toks.forEach(function (t) {
      if (t.length < 2) return;
      tf[t] = (tf[t] || 0) + 1;
    });
    return tf;
  }

  function termFreqWords(text) {
    var toks = tokenizeWords(text);
    var tf = {};
    toks.forEach(function (t) {
      if (t.length < 2) return;
      tf[t] = (tf[t] || 0) + 1;
    });
    return tf;
  }

  function splitSentences(text) {
    if (!text) return [];
    return String(text)
      .split(/[\n\r]+|[。！？；;!?]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  /**
   * IDF 平滑。
   *
   * 教科书版 log(N/df) 在"只有两条记录"时会退化成 0：两条记录都含有的词 df=N，
   * 权重被压到零，于是「这两条讲的是同一件事」这个最重要的信号反而消失了。
   * log(1 + N/(df+0.5)) 永远为正，且 df=N 时仍保留约 0.59 的权重，
   * 小语料下可用，大语料下排序与经典 IDF 基本一致。
   */
  function idfOf(df, N) {
    return Math.log(1 + N / ((df || 0) + 0.5));
  }

  /** 计算语料库的文档频率 */
  function docFreq(notes) {
    var df = {};
    notes.forEach(function (n) {
      var tf = termFreq((n.title || '') + ' ' + (n.content || ''));
      Object.keys(tf).forEach(function (t) { df[t] = (df[t] || 0) + 1; });
    });
    return df;
  }

  /** TF-IDF 向量化（返回 {term: weight}，已做 L2 归一化） */
  function vectorize(text, df, N) {
    var tf = termFreq(text);
    var vec = {};
    var norm = 0;
    Object.keys(tf).forEach(function (t) {
      var w = (1 + Math.log(tf[t])) * idfOf(df[t], N);
      vec[t] = w;
      norm += w * w;
    });
    norm = Math.sqrt(norm) || 1;
    Object.keys(vec).forEach(function (t) { vec[t] = vec[t] / norm; });
    return vec;
  }

  function cosine(a, b) {
    var s = 0;
    for (var k in a) { if (b[k]) s += a[k] * b[k]; }
    return s;
  }

  /* ---------------- 语料索引缓存 ----------------
   * docFreq + 全量向量化是 O(记录数 × 词数)，而搜索框每敲一个字都会触发一次检索，
   * 不做缓存时输入越长越卡。这里按「记录条数 + 最后更新时间」生成签名缓存整份索引，
   * 内容没变就完全复用；新增 / 编辑 / 删除都会改变签名从而自动失效。
   */
  var __idx = { sig: null, df: null, N: 0, vs: {}, vr: {} };

  /**
   * 索引签名。
   *
   * 旧实现是「条数 | 最后更新时间 | 首条 id」，看起来够用，实际有两个坑：
   * 1) 导入一批新数据、条数恰好相同且时间戳相同（同一秒导入）时，会复用上一批的索引；
   * 2) 删一条再加一条（条数不变、首条 id 不变）时同样感知不到。
   * 现在对所有记录的 id + updatedAt 做 FNV-1a 累积哈希，成本 O(n)，
   * 相比 O(n × 词数) 的建索引可以忽略。
   */
  function indexSignature(notes) {
    var h = 0x811c9dc5;
    var last = 0;
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      var u = n.updatedAt || n.createdAt || 0;
      if (u > last) last = u;
      var s = (n.id || '') + ':' + u + ':' + ((n.content || '').length) + ':' + ((n.title || '').length);
      for (var j = 0; j < s.length; j++) {
        h ^= s.charCodeAt(j);
        h = (h * 0x01000193) >>> 0;
      }
    }
    return notes.length + '|' + last + '|' + h.toString(36);
  }

  function buildIndex(notes) {
    var sig = indexSignature(notes);
    if (__idx.sig === sig) return __idx;

    var df = docFreq(notes);
    var N = notes.length || 1;
    var vs = {}, vr = {};
    notes.forEach(function (n) {
      var base = (n.title || '') + ' ' + (n.content || '') + ' ' + (n.tags || []).join(' ');
      vs[n.id] = vectorize(base, df, N);
      // 关联用的向量把标签再拼一次：标签一致比正文偶发同词更能说明「相关」
      vr[n.id] = vectorize(base + ' ' + (n.tags || []).join(' '), df, N);
    });
    __idx = { sig: sig, df: df, N: N, vs: vs, vr: vr };
    return __idx;
  }

  function clearIndex() { __idx = { sig: null, df: null, N: 0, vs: {}, vr: {} }; }

  /** 关键词抽取（TF-IDF topN，长词优先，过滤垃圾） */
  function keywords(text, df, N, topN) {
    // 标签要"像词"：优先只用词典成词，词典没命中时才退回二元组
    var tf = termFreqWords(text);
    if (Object.keys(tf).length < 2) tf = termFreq(text);

    var scored = Object.keys(tf).map(function (t) {
      var lenBonus = t.length >= 3 ? 1.25 : (t.length === 2 ? 1.0 : 0.4);
      var dfPenalty = (df[t] || 0) > Math.max(3, N * 0.6) ? 0.35 : 1;
      return { term: t, score: (1 + Math.log(tf[t])) * idfOf(df[t], N) * lenBonus * dfPenalty };
    });
    scored.sort(function (x, y) { return y.score - x.score; });

    var picked = [];
    for (var i = 0; i < scored.length && picked.length < topN; i++) {
      var t = scored[i].term;
      var dup = picked.some(function (p) {
        // 包含关系（"知识管理" 与 "知识"）
        if (p.indexOf(t) >= 0 || t.indexOf(p) >= 0) return true;
        // 两个二字词共享一个字，多半是同一处文字滑动出来的碎片（"路线" / "线图"）
        return t.length === 2 && p.length === 2 &&
          (t.charAt(0) === p.charAt(0) || t.charAt(1) === p.charAt(1));
      });
      if (!dup) picked.push(t);
    }
    return picked;
  }

  /* ---------------- 结构信息抽取 ---------------- */

  function makeTitle(text) {
    var s = splitSentences(String(text || ''));
    var t = (s[0] || String(text || '')).trim();
    t = t.replace(/^[#\-\*\s]+/, '').trim();
    if (t.length > 34) t = t.slice(0, 34) + '…';
    return t || '（无标题）';
  }

  /**
   * 类型打分。把分数暴露出来（classifyScore）有两个用处：
   * 1) 单元测试能断言「为什么」判成待办，而不只是断言结论；
   * 2) 以后调权重时能直接看出是哪条规则把结果带偏了。
   */
  function classifyScore(text) {
    var s = String(text || '');
    var lower = s.toLowerCase();
    var score = { idea: 0.5, material: 0, todo: 0 };

    // 待办：强指令词权重高，弱动词权重低
    var todoStrong = 0, todoWeak = 0;
    TODO_STRONG.forEach(function (w) { if (lower.indexOf(w) >= 0) todoStrong++; });
    TODO_WEAK.forEach(function (w) { if (lower.indexOf(w) >= 0) todoWeak++; });
    score.todo += Math.min(todoStrong * 1.0, 2.0);
    score.todo += Math.min(todoWeak * 0.35, 1.05);

    // 句首（剥掉时间状语后）是祈使动词 → 更像待办
    var body = s.trim().replace(LEAD_TIME, '');
    if (IMPERATIVE_HEAD.test(body) || /^要(?!不)/.test(body)) score.todo += 0.8;

    // 只有「已经像待办」且截止日在未来时，明确时间才算加强项。
    // 否则"今天读到一个有意思的观点"会被误判成待办。
    var due = detectDueDate(s);
    if (due && score.todo > 0 && due > todayStr()) score.todo += 1.3;

    // 资料
    MATERIAL_STRONG.forEach(function (w) { if (lower.indexOf(String(w).toLowerCase()) >= 0) score.material += 0.8; });
    score.material = Math.min(score.material, 2.4);
    if (/https?:\/\/|www\./.test(lower)) score.material += 1.2;
    if (/《[^》]+》/.test(s)) score.material += 0.6;
    if (s.length > 220) score.material += 0.5;

    // 想法
    IDEA_STRONG.forEach(function (w) { if (lower.indexOf(w) >= 0) score.idea += 0.7; });
    score.idea = Math.min(score.idea, 2.4);
    if (/[？?]\s*$/.test(s)) score.idea += 0.5;
    if (/(吗|呢|吧)\s*[。！!？?]?\s*$/.test(s)) score.idea += 0.3;
    if (/不要|别把|应该|最好|不如|宁可/.test(s)) score.idea += 0.4;

    return score;
  }

  function classify(text) {
    var score = classifyScore(text);
    var best = 'idea', bestV = -1;
    // 固定顺序遍历，分数相同时优先 idea（默认归类比误判成待办安全）
    ['idea', 'material', 'todo'].forEach(function (k) {
      if (score[k] > bestV) { bestV = score[k]; best = k; }
    });
    return best;
  }

  function detectPriority(text, dueDate) {
    var s = String(text || '').toLowerCase();
    var hit = 0;
    HIGH_SIGNAL.forEach(function (w) { if (s.indexOf(w.toLowerCase()) >= 0) hit++; });
    if (hit > 0) return 'high';
    for (var i = 0; i < LOW_SIGNAL.length; i++) {
      if (s.indexOf(LOW_SIGNAL[i]) >= 0) return 'low';
    }

    if (dueDate) {
      var d = new Date(dueDate + 'T23:59:59');
      var diff = (d.getTime() - Date.now()) / 86400000;
      if (diff <= 2) return 'high';
      if (diff <= 7) return 'medium';
      return 'low';
    }
    return 'medium';
  }

  /* 常用词词典：用于正向最大匹配，保证抽取出的标签是成词的 */
  var DICT = ('知识 管理 笔记 记录 想法 资料 待办 总结 阶段 目标 计划 项目 产品 需求 设计 开发 测试 上线 发布 版本 迭代 优化 修复 问题 风险 方案 架构 系统 模块 功能 交互 界面 原型 体验 用户 客户 市场 运营 增长 数据 指标 分析 报告 调研 竞品 商业 模式 收入 成本 利润 预算 报价 合同 会议 沟通 协作 团队 同事 领导 汇报 排期 进度 里程碑 交付 验收 复盘 决策 结论 建议 行动 执行 落地 推进 跟进 确认 安排 准备 提交 审核 反馈 评价 改进 提升 效率 时间 日程 清单 任务 事项 重点 关键 紧急 重要 优先级 截止 期限 延迟 逾期 完成 结束 开始 启动 暂停 取消 继续 学习 课程 阅读 书籍 文章 论文 研究 理论 方法 技巧 工具 框架 模型 算法 代码 程序 接口 数据库 服务 服务器 部署 配置 环境 性能 安全 权限 账号 密码 文档 文件 资料 链接 资源 素材 图片 视频 音频 文本 内容 信息 知识库 搜索引擎 检索 查询 排序 分类 标签 关联 相似度 向量 嵌入 大模型 智能 助手 提示 上下文 训练 推理 生成 摘要 提取 识别 检测 预测 推荐 个性化 自动化 流程 规则 策略 机制 结构 逻辑 关系 网络 图谱 节点 路径 场景 案例 示例 经验 教训 心得 思考 反思 灵感 创意 创新 突破 机会 挑战 困难 障碍 瓶颈 解决 处理 应对 调整 变化 趋势 发展 成长 进步 成果 收获 价值 意义 影响 作用 效果 质量 数量 比例 速度 频率 周期 节奏 习惯 坚持 纪律 自律 健康 运动 健身 饮食 睡眠 休息 放松 情绪 压力 焦虑 状态 精力 专注 注意力 记忆 理解 掌握 熟练 精通 入门 进阶 实践 练习 训练 复习 回顾 整理 归纳 演绎 抽象 具体 细节 整体 全局 局部 层次 维度 角度 视野 认知 观念 理念 原则 标准 规范 流程 制度 文化 氛围 环境 条件 因素 变量 参数 属性 特征 特点 优势 劣势 机会 威胁 投资 理财 基金 股票 债券 资产 负债 现金 储蓄 消费 支出 收入 税务 保险 养老 教育 家庭 朋友 社交 关系 人脉 沟通 表达 演讲 写作 编辑 排版 发布 分享 传播 影响 品牌 形象 声誉 信任 合作 谈判 协商 妥协 共识 冲突 分歧 协调 平衡 取舍 权衡 选择 判断 决策 执行 监督 评估 考核 激励 奖励 惩罚 反馈 改进').split(/\s+/);
  var DICTSET = {};
  DICT.forEach(function (w) { if (w && w.length >= 2) DICTSET[w] = true; });

  var WEEK_MAP = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };

  function detectDueDate(text) {
    var s = String(text || '');
    var today = new Date();
    var m;

    function fmt(d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    // Date 会把 2026-13-45 静默溢出成 2027-02-14，必须回读校验，避免解析出错误日期
    function mkDate(y, mo, d) {
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
      var dt = new Date(y, mo - 1, d);
      if (dt.getMonth() !== mo - 1 || dt.getDate() !== d || dt.getFullYear() !== y) return null;
      return dt;
    }

    if ((m = s.match(/(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})/))) {
      var d1 = mkDate(+m[1], +m[2], +m[3]);
      if (d1) return fmt(d1);
    }
    if (/今天/.test(s)) return fmt(today);
    if (/明天/.test(s)) return fmt(new Date(today.getTime() + 86400000));
    if (/后天/.test(s)) return fmt(new Date(today.getTime() + 2 * 86400000));
    if ((m = s.match(/(\d{1,2})月(\d{1,2})[日号]/))) {
      var y = today.getFullYear();
      var d = mkDate(y, +m[1], +m[2]);
      if (!d) return null;                       // 如「13月45日」这类非法输入直接放弃
      if (d.getTime() < today.getTime() - 86400000) {
        d = mkDate(y + 1, +m[1], +m[2]);         // 已过去的日期按明年理解
        if (!d) return null;
      }
      return fmt(d);
    }
    if ((m = s.match(/(下?)\s*(?:周|星期)([一二三四五六日天])/))) {
      var target = WEEK_MAP[m[2]];
      var cur = today.getDay();
      var delta = (target - cur + 7) % 7;
      if (delta === 0) delta = 7;
      if (m[1] === '下') delta += 7;
      return fmt(new Date(today.getTime() + delta * 86400000));
    }
    if ((m = s.match(/(\d+)\s*天内/))) return fmt(new Date(today.getTime() + (+m[1]) * 86400000));
    return null;
  }

  /** 抽取式摘要 */
  function extractiveSummary(text, n) {
    var sents = splitSentences(text);
    if (!sents.length) return '';
    if (sents.length === 1) return sents[0].length > 52 ? sents[0].slice(0, 52) + '…' : sents[0];

    var df = docFreq([{ title: '', content: text }]);
    var vec = vectorize(text, df, 1);
    var scored = sents.map(function (s, i) {
      var tf = termFreq(s);
      var sc = 0;
      Object.keys(tf).forEach(function (t) { if (vec[t]) sc += vec[t] * tf[t]; });
      sc = sc / Math.sqrt(s.length + 1);
      if (i === 0) sc *= 1.35;
      if (s.length < 8) sc *= 0.4;
      if (s.length > 120) sc *= 0.7;
      return { s: s, sc: sc, i: i };
    });
    scored.sort(function (a, b) { return b.sc - a.sc; });
    return scored.slice(0, n || 1)
      .sort(function (a, b) { return a.i - b.i; })
      .map(function (x) { return x.s; })
      .join('。') + '。';
  }

  /** 重点提取：高信息密度短句 */
  function keyPoints(text, n) {
    var sents = splitSentences(text);
    if (!sents.length) return [];
    var df = docFreq([{ title: '', content: text }]);
    var vec = vectorize(text, df, 1);
    var scored = sents.map(function (s, i) {
      var tf = termFreq(s);
      var sc = 0;
      Object.keys(tf).forEach(function (t) { if (vec[t]) sc += vec[t]; });
      sc = sc / Math.pow(s.length + 1, 0.42);
      if (i === 0) sc *= 1.2;
      if (/\d/.test(s)) sc *= 1.15;
      if (/应该|需要|必须|建议|关键|注意|结论|因此|目标|计划/.test(s)) sc *= 1.25;
      if (s.length < 6) sc *= 0.35;
      return { s: s, sc: sc };
    });
    scored.sort(function (a, b) { return b.sc - a.sc; });
    return scored.slice(0, n || 3).map(function (x) {
      return x.s.length > 60 ? x.s.slice(0, 60) + '…' : x.s;
    });
  }

  /** 从一段文本中识别可执行行动项 */
  function actionItems(text) {
    return splitSentences(text).filter(function (s) {
      if (s.length < 6 || s.length > 90) return false;
      return TODO_SIGNAL.some(function (w) { return s.indexOf(w) >= 0; });
    }).slice(0, 5);
  }

  /* ---------------- 检索 ---------------- */

  /* 查询意图：语义化提问（"还没做的事"）也要能命中，不能只靠字面重合 */
  var INTENTS = [
    { key: 'todo', re: /待办|要做|未完成|还没|没做|未做|待处理|todo|任务|事项|遗留|没来得及/i },
    { key: 'summary', re: /总结|回顾|复盘|梳理|沉淀/ },
    { key: 'key', re: /重点|关键|重要|核心|主要/ },
    { key: 'recent', re: /最近|近期|这段时间|这一阶段|本月|本周|这几天|最近几天/ },
    { key: 'idea', re: /想法|灵感|点子|思考|念头/ },
    { key: 'material', re: /资料|摘录|文章|书|链接|读过|收藏/ }
  ];

  function detectIntent(q) {
    var out = {};
    INTENTS.forEach(function (it) { if (it.re.test(q)) out[it.key] = true; });
    return out;
  }

  function search(notes, query) {
    var q = String(query || '').trim();
    if (!q) return notes.map(function (n) { return { note: n, score: 0, hits: [] }; });

    var intent = detectIntent(q);
    var idx = buildIndex(notes);
    var df = idx.df, N = idx.N;
    var qtf = termFreq(q);
    var qvec = {};
    Object.keys(qtf).forEach(function (t) {
      qvec[t] = (1 + Math.log(qtf[t])) * idfOf(df[t], N);
    });
    // 短语命中用于高亮与精确加权，长度阈值放宽到 1 以支持单字检索（如「钱」「会」）
    var phrases = q.split(/\s+/).filter(function (w) { return w.length >= 1; });
    if (!phrases.length) phrases = [q];

    var res = notes.map(function (n) {
      var text = (n.title || '') + ' ' + (n.content || '') + ' ' + (n.tags || []).join(' ');
      var vec = idx.vs[n.id] || vectorize(text, df, N);
      var score = cosine(qvec, vec) * 12;
      var hits = [];

      phrases.forEach(function (p) {
        var re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        var cnt = (text.match(re) || []).length;
        if (cnt > 0) {
          score += Math.min(cnt, 4) * 1.6;
          hits.push(p);
        }
      });
      (n.tags || []).forEach(function (t) {
        if (q.indexOf(t) >= 0 || t.indexOf(q) >= 0) score += 2.2;
      });
      if ((n.title || '').indexOf(q) >= 0) score += 3;
      if (n.pinned) score += 0.25;

      score += intentBoost(n, intent);

      return { note: n, score: score, hits: unique(hits) };
    });

    var out = res.filter(function (r) { return r.score > 0.35; }).sort(function (a, b) { return b.score - a.score; });

    // 纯意图型提问（字面几乎不重合）时，按意图兜底召回
    if (!out.length) {
      out = res.filter(function (r) { return intentBoost(r.note, intent) > 0; })
        .sort(function (a, b) { return b.score - a.score; });
    }
    out.intent = intent;
    return out;
  }

  function intentBoost(n, intent) {
    var s = 0;
    if (intent.todo) {
      if (n.type === 'todo') s += n.done ? 0.6 : 3.6;
      else if (/需要|记得|安排|计划|跟进|确认|提交|整理/.test(n.content || '')) s += 0.5;
    }
    if (intent.summary && n.type === 'summary') s += 3.2;
    if (intent.key) {
      if (n.pinned) s += 2.4;
      if (n.priority === 'high') s += 1.4;
    }
    if (intent.idea && n.type === 'idea') s += 2.2;
    if (intent.material && n.type === 'material') s += 2.2;
    if (intent.recent) {
      var days = (Date.now() - (n.createdAt || 0)) / 86400000;
      s += Math.max(0, 1.6 - days * 0.05);
    }
    return s;
  }

  /** 问答取上下文：命中结果 + 意图补齐（如问待办时把全部未完成项带上） */
  function pickContext(notes, question, limit) {
    var hits = search(notes, question);
    var intent = hits.intent || {};
    var seen = {};
    var out = hits.slice(0, limit || 6);
    out.forEach(function (h) { seen[h.note.id] = true; });

    if (intent.todo) {
      // 待办意图要把"所有未完成项"都带上，不能只取前 6 条——否则回答里"还有 N 项待办"的 N 会和实际不符
      notes.filter(function (n) { return n.type === 'todo' && !n.done && !seen[n.id]; })
        .sort(function (a, b) {
          var pa = a.priority === 'high' ? 3 : a.priority === 'medium' ? 2 : 1;
          var pb = b.priority === 'high' ? 3 : b.priority === 'medium' ? 2 : 1;
          return (pb - pa) || ((a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1);
        })
        .slice(0, 30)
        .forEach(function (n) { out.push({ note: n, score: 1, hits: [] }); seen[n.id] = true; });
    }
    if (intent.recent) {
      notes.filter(function (n) { return !seen[n.id]; })
        .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); })
        .slice(0, 4)
        .forEach(function (n) { out.push({ note: n, score: 0.8, hits: [] }); seen[n.id] = true; });
    }
    // 待办意图不受 8 条上限约束；其余意图取 max(limit, 16) 以容纳更多上下文
    var cap = intent.todo ? out.length : Math.max(limit || 6, 16);
    var final = out.slice(0, cap);
    final.intent = intent;
    return final;
  }

  function unique(arr) {
    var m = {};
    return arr.filter(function (x) { if (m[x]) return false; m[x] = 1; return true; });
  }

  /* ---------------- 关联 ---------------- */

  var REL_MIN = 0.16;   // 低于此相似度不展示为「相关内容」
  var REL_MAX = 4;      // 每条最多展示 4 个关联

  function vecSum(v) {
    var s = 0;
    for (var k in v) s += v[k];
    return s;
  }

  /** 纯内容相似度（不看标签、类型、时间），用于关联打分与重复检测 */
  function contentSim(va, vb) {
    var cos = cosine(va, vb);
    var sharedW = 0, sharedCount = 0;
    for (var k in va) {
      if (vb[k]) { sharedCount++; sharedW += Math.min(va[k], vb[k]); }
    }
    var denom = Math.min(vecSum(va), vecSum(vb)) || 1;
    var contain = Math.min(1, sharedW / denom) * Math.min(1, sharedCount / 3);
    return { cos: cos, contain: contain };
  }

  /**
   * 一对记录的相关度。
   *
   * 只用余弦的问题：它会被长度差异惩罚，两条各 30 字的短笔记哪怕讲的是同一件事，
   * 相似度也常常掉到 0.16 以下，于是「相关内容」永远是空的。
   * 这里补一个**包含度**：短文本的词有多大比例被另一条覆盖（用 TF-IDF 权重加权），
   * 再用「共享词数」打折，避免仅靠一个高频词就误判为相关。
   *
   * 最终 = 余弦 0.35 + 包含度 0.55 + 共享标签(每个 0.08，最多 3 个)
   *      + 同类型 0.04 + 三天内 0.03（只用于打破平局）
   */
  function pairScore(a, b, va, vb) {
    var sim = contentSim(va, vb);
    // 短文之间"互相覆盖"比"方向一致"更能说明相关，所以包含度权重高于余弦
    var score = sim.cos * 0.35 + sim.contain * 0.55;

    var shared = (a.tags || []).filter(function (t) { return (b.tags || []).indexOf(t) >= 0; });
    score += Math.min(shared.length, 3) * 0.08;
    if (a.type === b.type) score += 0.04;
    var dt = Math.abs((a.createdAt || 0) - (b.createdAt || 0)) / 86400000;
    if (dt < 3) score += 0.03;
    return { score: Math.min(0.98, score), shared: shared };
  }

  /**
   * 找与目标记录高度相似的已有记录（重复检测）。
   *
   * 与「相关内容」不同，这里只看正文：标签相同、类型相同都不该让两条
   * 内容不同的记录被判成重复。阈值默认 0.82 —— 低于这个值多半只是同主题，
   * 高于这个值基本就是同一条内容记了两遍。
   */
  function findSimilar(notes, target, minScore, limit) {
    if (!notes || !notes.length || !target) return [];
    var idx = buildIndex(notes);
    var tv = vectorize(
      (target.title || '') + ' ' + (target.content || '') + ' ' + (target.tags || []).join(' '),
      idx.df, idx.N
    );
    var floor = minScore || 0.82;
    var out = [];
    notes.forEach(function (n) {
      if (n.id === target.id) return;
      var v = idx.vr[n.id];
      if (!v) return;
      var sim = contentSim(tv, v);
      var score = sim.cos * 0.5 + sim.contain * 0.5;
      if (score >= floor) out.push({ note: n, score: score });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, limit || 3);
  }

  /**
   * 计算内容关联。
   *
   * 全量两两比较是 O(n²)：2000 条记录 = 200 万对，实测 4.3 秒，
   * 而这段代码在每次启动时都会跑一遍，等于开屏必卡 4 秒。
   *
   * 改成倒排索引召回候选：先用「有区分度的词」把可能相关的记录捞出来，
   * 只对候选集做精确打分。共享词少于 2 个的直接跳过——
   * 这种配对即使打分也几乎不可能越过阈值。
   *
   * @param {Array} notes      全部记录
   * @param {Array} [onlyIds]  只重算这些 id 的关联（保存单条时用），
   *                            其余条目的关联表会同步合并这些 id，保持双向一致。
   */
  var REL_CAND_MIN_W = 0.08;   // 低于此权重（多为常见词）不参与候选召回
  var REL_POSTING_MAX = 80;    // 单个词的倒排表长度上限，防止常见词把候选集撑爆
  var REL_CAND_MAX = 40;       // 每条记录最多精算多少个候选

  function buildInverted(notes, vecs) {
    var inv = Object.create(null);
    notes.forEach(function (n) {
      var v = vecs[n.id];
      if (!v) return;
      for (var t in v) {
        if (v[t] < REL_CAND_MIN_W) continue;
        var arr = inv[t] || (inv[t] = []);
        if (arr.length < REL_POSTING_MAX) arr.push(n.id);
      }
    });
    return inv;
  }

  function candidatesOf(id, vecs, inv) {
    var v = vecs[id];
    if (!v) return [];
    var cnt = Object.create(null);
    for (var t in v) {
      if (v[t] < REL_CAND_MIN_W) continue;
      var arr = inv[t];
      if (!arr) continue;
      for (var i = 0; i < arr.length; i++) {
        var oid = arr[i];
        if (oid === id) continue;
        cnt[oid] = (cnt[oid] || 0) + 1;
      }
    }
    var ids = [];
    for (var k in cnt) if (cnt[k] >= 2) ids.push(k);
    ids.sort(function (a, b) { return cnt[b] - cnt[a]; });
    return ids.slice(0, REL_CAND_MAX);
  }

  function relate(notes, onlyIds) {
    var idx = buildIndex(notes);
    var vecs = idx.vr;
    var inv = buildInverted(notes, vecs);
    var byId = {};
    notes.forEach(function (n) { byId[n.id] = n; });

    var vecOf = function (n) {
      return vecs[n.id] || vectorize((n.title || '') + ' ' + (n.content || '') + ' ' + (n.tags || []).join(' '), idx.df, idx.N);
    };

    var collect = function (n) {
      var list = [];
      var cands = candidatesOf(n.id, vecs, inv);
      for (var i = 0; i < cands.length; i++) {
        var m = byId[cands[i]];
        if (!m) continue;
        var r = pairScore(n, m, vecOf(n), vecOf(m));
        if (r.score > REL_MIN) list.push({ id: m.id, score: r.score, shared: r.shared });
      }
      list.sort(function (a, b) { return b.score - a.score; });
      return list.slice(0, REL_MAX);
    };

    if (!onlyIds || !onlyIds.length) {
      notes.forEach(function (n) { n.related = collect(n); });
      return notes;
    }

    var idset = {};
    onlyIds.forEach(function (id) { idset[id] = true; });

    onlyIds.forEach(function (id) {
      var n = byId[id];
      if (n) n.related = collect(n);
    });

    // 其余条目：先剔除指向这些 id 的旧结果，再重新并入，保证双向一致
    notes.forEach(function (m) {
      if (idset[m.id]) return;
      var list = (m.related || []).filter(function (r) { return !idset[r.id] && byId[r.id]; });
      onlyIds.forEach(function (tid) {
        var t = byId[tid];
        if (!t || t.id === m.id) return;
        var r = pairScore(m, t, vecOf(m), vecOf(t));
        if (r.score > REL_MIN) list.push({ id: t.id, score: r.score, shared: r.shared });
      });
      list.sort(function (a, b) { return b.score - a.score; });
      m.related = list.slice(0, REL_MAX);
    });

    return notes;
  }

  /* ---------------- 阶段总结 ---------------- */

  function stats(rangeNotes, allNotes) {
    var byType = { idea: 0, material: 0, todo: 0, summary: 0 };
    rangeNotes.forEach(function (n) { byType[n.type] = (byType[n.type] || 0) + 1; });
    var todos = allNotes.filter(function (n) { return n.type === 'todo'; });
    var doneTodos = todos.filter(function (n) { return n.done; });
    var overdue = todos.filter(function (n) { return !n.done && n.dueDate && n.dueDate < todayStr(); });

    var tagCount = {};
    rangeNotes.forEach(function (n) {
      (n.tags || []).forEach(function (t) { tagCount[t] = (tagCount[t] || 0) + 1; });
    });
    var topTags = Object.keys(tagCount).map(function (t) { return { tag: t, count: tagCount[t] }; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 10);

    return {
      total: rangeNotes.length,
      byType: byType,
      starred: rangeNotes.filter(function (n) { return n.pinned; }).length,
      todoTotal: todos.length,
      todoDone: doneTodos.length,
      todoOpen: todos.length - doneTodos.length,
      overdue: overdue,
      topTags: topTags
    };
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /** 生成阶段总结（Markdown） */
  function buildSummary(rangeNotes, allNotes, days) {
    var st = stats(rangeNotes, allNotes);
    var label = days ? ('近 ' + days + ' 天') : '全部时间';
    var out = [];

    out.push('## 一、概览');
    out.push(label + '共记录 **' + st.total + '** 条内容：想法 ' + st.byType.idea + ' 条、资料 ' +
      st.byType.material + ' 条、待办 ' + st.byType.todo + ' 条' +
      (st.byType.summary ? ('、阶段总结 ' + st.byType.summary + ' 条') : '') + '。');
    out.push('待办整体完成率 **' + (st.todoTotal ? Math.round(st.todoDone / st.todoTotal * 100) : 0) + '%**' +
      '（已完成 ' + st.todoDone + ' / 共 ' + st.todoTotal + '），' +
      (st.todoOpen > 0 ? ('仍有 **' + st.todoOpen + '** 项未完成') : '全部待办已清空') + '。');
    if (st.overdue.length) out.push('⚠️ 其中 **' + st.overdue.length + '** 项已逾期，需要优先处理。');

    out.push('');
    out.push('## 二、主要关注主题');
    if (st.topTags.length) {
      st.topTags.slice(0, 6).forEach(function (t) {
        var items = rangeNotes.filter(function (n) { return (n.tags || []).indexOf(t.tag) >= 0; });
        var done = items.filter(function (n) { return n.done; }).length;
        out.push('- **' + t.tag + '**（' + t.count + ' 条）' +
          (done ? ('：已完成 ' + done + ' 项') : '') + '。' + brief(items));
      });
    } else {
      out.push('- 这段时间标签较少，建议在记录时补充领域标签，便于后续聚类回顾。');
    }

    out.push('');
    out.push('## 三、重点内容回顾');
    var highlights = rangeNotes
      .filter(function (n) { return n.type !== 'todo'; })
      .map(function (n) {
        var v = (n.pinned ? 3 : 0) + (n.priority === 'high' ? 2 : n.priority === 'medium' ? 1 : 0) +
          (n.keyPoints && n.keyPoints.length ? 1 : 0) + Math.min((n.content || '').length / 260, 1.2);
        return { n: n, v: v };
      })
      .sort(function (a, b) { return b.v - a.v; })
      .slice(0, 5);
    if (highlights.length) {
      highlights.forEach(function (h) {
        out.push('- **' + h.n.title + '**' + (h.n.tags && h.n.tags.length ? '（#' + h.n.tags.join(' #') + '）' : '') +
          '：' + (h.n.summary || firstLine(h.n.content)));
      });
    } else {
      out.push('- 暂无内容。');
    }

    out.push('');
    out.push('## 四、待办与进展');
    var openTodos = allNotes.filter(function (n) { return n.type === 'todo' && !n.done; })
      .sort(function (a, b) {
        var pa = rankPrio(a), pb = rankPrio(b);
        if (pa !== pb) return pb - pa;
        return (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1;
      });
    var recentDone = allNotes.filter(function (n) { return n.type === 'todo' && n.done; }).slice(0, 6);
    if (recentDone.length) {
      out.push('已完成：');
      recentDone.forEach(function (n) { out.push('- ✓ ' + n.title); });
    }
    if (openTodos.length) {
      out.push('未完成（按优先级排序）：');
      openTodos.slice(0, 8).forEach(function (n) {
        out.push('- ☐ ' + n.title + (n.dueDate ? '（截止 ' + n.dueDate + '）' : '') +
          (n.priority === 'high' ? ' — 高优先级' : ''));
      });
    } else {
      out.push('当前没有未完成的待办。');
    }

    out.push('');
    out.push('## 五、后续行动建议');
    var adv = advice(st, rangeNotes, allNotes);
    adv.forEach(function (a, i) { out.push((i + 1) + '. ' + a); });

    return { markdown: out.join('\n'), stats: st };
  }

  function rankPrio(n) { return n.priority === 'high' ? 3 : n.priority === 'medium' ? 2 : 1; }

  function brief(items) {
    if (!items.length) return '';
    var t = items[0].title;
    return '代表内容：' + t + (items.length > 1 ? ' 等' : '');
  }

  function firstLine(text) {
    var s = splitSentences(text);
    if (!s.length) return '';
    return s[0].length > 60 ? s[0].slice(0, 60) + '…' : s[0];
  }

  function advice(st, rangeNotes, allNotes) {
    var list = [];

    if (st.overdue.length) {
      list.push('先清掉 ' + st.overdue.length + ' 项逾期任务（' +
        st.overdue.slice(0, 3).map(function (n) { return '「' + short(n.title) + '」'; }).join('、') +
        '），逾期项会持续占用注意力，建议今天内给出明确结论：做、推迟还是删掉。');
    }

    var highOpen = allNotes.filter(function (n) { return n.type === 'todo' && !n.done && n.priority === 'high'; });
    if (highOpen.length) {
      list.push('把 ' + highOpen.length + ' 项高优先级待办排进日历，给出具体时间段，而不是停留在清单里。');
    }

    if (st.topTags.length) {
      var top = st.topTags[0];
      list.push('「' + top.tag + '」是这段时间的主线（' + top.count + ' 条），可以专门沉淀一篇阶段笔记，把零散想法整理成可复用的结论。');
    }

    var stale = allNotes.filter(function (n) {
      return !n.done && (Date.now() - (n.updatedAt || n.createdAt || 0)) > 14 * 86400000;
    });
    if (stale.length) {
      list.push('有 ' + stale.length + ' 条内容超过两周未回顾，挑其中 2-3 条重新读一遍：要么推进，要么归档，避免清单无限膨胀。');
    }

    var noDue = allNotes.filter(function (n) { return n.type === 'todo' && !n.done && !n.dueDate; });
    if (noDue.length >= 3) {
      list.push('还有 ' + noDue.length + ' 项待办没有截止日期，给它们补上时间点，否则很容易一直往后拖。');
    }

    if (st.byType.idea >= 3 && st.byType.todo === 0) {
      list.push('这段时间想法很多但没有落成行动，挑 1-2 个最有价值的想法，拆成下周可执行的具体步骤。');
    }

    if (!list.length) {
      list.push('当前节奏健康：待办没有积压，想法与资料在同步积累。可以给自己设一个新的输入目标，比如每周固定读两篇长文并摘录要点。');
    }

    list.push('把这份总结里最重要的一件事设为本周唯一目标，其余都排在它后面。');
    return list.slice(0, 6);
  }

  function short(s) { return s && s.length > 18 ? s.slice(0, 18) + '…' : s; }

  /* ---------------- 离线问答 ---------------- */

  function offlineAnswer(question, hits) {
    var q = String(question || '').trim();
    var intent = (hits && hits.intent) || detectIntent(q);
    var list = (hits || []).slice();
    var out = [];

    var todoState = function (n) {
      return n.type === 'todo' ? (n.done ? '已完成' : '待处理' + (n.dueDate ? '，截止 ' + n.dueDate : '')) : TYPE_CN[n.type];
    };

    if (intent.todo) {
      var open = list.filter(function (h) { return h.note.type === 'todo' && !h.note.done; });
      var done = list.filter(function (h) { return h.note.type === 'todo' && h.note.done; });
      out.push('你还有 **' + open.length + '** 项未完成的事：');
      out.push('');
      if (open.length) {
        open.forEach(function (h) {
          var n = h.note;
          out.push('- ☐ **' + n.title + '**' +
            (n.dueDate ? ('（截止 ' + n.dueDate + '）') : '') +
            (n.priority === 'high' ? ' — 高优先级' : ''));
        });
      } else {
        out.push('- 没有未完成的待办，当前清单是干净的。');
      }
      if (done.length) {
        out.push('');
        out.push('近期已完成 ' + done.length + ' 项：' + done.slice(0, 4).map(function (h) { return h.note.title; }).join('、') + '。');
      }
    } else if (intent.summary || intent.recent) {
      out.push('这段时间你的记录主要围绕这些：');
      out.push('');
      list.slice(0, 6).forEach(function (h) {
        var n = h.note;
        out.push('- **' + n.title + '**（' + todoState(n) +
          (n.tags && n.tags.length ? '，#' + n.tags.join(' #') : '') + '）：' + (n.summary || firstLine(n.content)));
      });
    } else if (intent.key) {
      out.push('被你标记为重点 / 高优先级的内容：');
      out.push('');
      list.slice(0, 6).forEach(function (h) {
        var n = h.note;
        out.push('- **' + n.title + '**（' + (n.pinned ? '重点' : '高优先级') + '）：' + (n.summary || firstLine(n.content)));
      });
    } else {
      out.push('在你的记录里找到了这些内容：');
      out.push('');
      list.slice(0, 6).forEach(function (h, i) {
        var n = h.note;
        out.push((i + 1) + '. **' + n.title + '**' +
          (n.tags && n.tags.length ? '（#' + n.tags.join(' #') + '）' : '') +
          ' — ' + (n.summary || firstLine(n.content)) +
          (n.type === 'todo' ? ('　[' + todoState(n) + ']') : ''));
      });
    }

    if (!list.length) {
      return '没有在记录里找到相关内容。换个说法试试，或者先记一条相关内容。';
    }

    out.push('');
    out.push('> 未配置大模型，以上是本地检索结果。在「设置」里填入 API Key 后可得到带推理的自然语言回答。');
    return out.join('\n');
  }

  global.Engine = {
    TYPE_CN: TYPE_CN,
    buildIndex: buildIndex,
    clearIndex: clearIndex,
    tokenize: tokenize,
    tokenizeWords: tokenizeWords,
    termFreq: termFreq,
    termFreqWords: termFreqWords,
    splitSentences: splitSentences,
    keywords: keywords,
    docFreq: docFreq,
    vectorize: vectorize,
    cosine: cosine,
    makeTitle: makeTitle,
    classify: classify,
    classifyScore: classifyScore,
    detectPriority: detectPriority,
    detectDueDate: detectDueDate,
    extractiveSummary: extractiveSummary,
    keyPoints: keyPoints,
    actionItems: actionItems,
    search: search,
    pickContext: pickContext,
    detectIntent: detectIntent,
    relate: relate,
    findSimilar: findSimilar,
    stats: stats,
    buildSummary: buildSummary,
    offlineAnswer: offlineAnswer,
    todayStr: todayStr
  };
})(window);
