'use strict';
/* ===========================================================
 * docimport.js —— 文本文档导入：格式识别与正文提取（零依赖）
 *
 * 支持：
 *   .txt/.log/.markdown/.md   纯文本（自动识别 UTF-8 / GBK / UTF-16 编码）
 *   .csv/.tsv                 转 Markdown 表格
 *   .json                     信息管家备份（含 notes 数组时走备份导入）
 *   .html/.htm                提取正文文本
 *   .rtf                      RTF 控制词解析（支持中文 ansicpg936）
 *   .docx/.xlsx/.odt...       ZIP + XML（docx=Word，xlsx=Excel，odt/ods=OpenDocument）
 *   .doc                      旧版二进制 Word（OLE2/CFB + 分片表 CLX，Word 97-2003）
 *   .xls                      旧版二进制 Excel（OLE2/CFB + BIFF8 记录，Excel 97-2003）
 *
 * 导出：DocImport.extract(fileOrName, arrayBuffer) -> Promise<{
 *   kind: 'text' | 'backup',
 *   text: string,            // 提取的正文
 *   format: string,          // 人类可读格式名
 *   warning?: string         // 尽力解析等提示
 * }>
 * =========================================================== */

(function (global) {

  // 单文件上限：整体按 20MB 兜底，防止把整段文本解码进内存卡死页面。
  // .doc 例外：只按索引读取 WordDocument / 表流，内嵌图片所在的 Data 流不会被展开，
  // 所以「几十 MB 但文字很少的 Word 文档」也能处理（现实中这类文档非常常见）。
  var MAX_BYTES = 20 * 1024 * 1024;
  var MAX_BYTES_DOC = 300 * 1024 * 1024;

  /* ---------------- 公共工具 ---------------- */

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function decodeEntities(s) {
    return String(s || '')
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); })
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'").replace(/&amp;/gi, '&');
  }

  function tidy(s) {
    return String(s || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n').trim();
  }

  /** 多编码尝试解码：UTF-8 → GBK → UTF-16LE → latin1，取乱码最少者 */
  function decodeSmart(bytes) {
    var candidates = ['utf-8', 'gbk', 'utf-16le', 'windows-1252'];
    var best = null, bestBad = Infinity;
    for (var i = 0; i < candidates.length; i++) {
      var enc = candidates[i];
      var text;
      try { text = new TextDecoder(enc).decode(bytes); } catch (e) { continue; }
      var bad = 0, ufffd = text.split('\uFFFD').length - 1;
      // 控制字符（除常见空白）也视为乱码
      for (var j = 0; j < text.length; j++) {
        var c = text.charCodeAt(j);
        if (c < 9 || (c > 13 && c < 32)) bad++;
      }
      bad += ufffd;
      if (bad < bestBad) { bestBad = bad; best = text; }
      if (bad === 0 && enc === 'utf-8') break; // UTF-8 完美命中，直接用
    }
    return best == null ? '' : best;
  }

  /* ---------------- ZIP 读取（docx / odt） ---------------- */

  var u16 = function (b, o) { return b[o] | (b[o + 1] << 8); };
  var u32 = function (b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; };

  function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持解压（DecompressionStream），请换新版 Chrome/Edge');
    var ds = new DecompressionStream('deflate-raw');
    var buffer = data;
    // 兼容 Buffer/ArrayBuffer
    if (!(buffer instanceof ArrayBuffer) && buffer.buffer instanceof ArrayBuffer) {
      buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
    var blob = new Blob([buffer]);
    var stream = blob.stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }

  /** 解析 ZIP（仅支持 stored / deflate），返回 {name: Uint8Array|Promise}
   *  only 给出时只解压命中的条目（精确名，或以 "/" 结尾的前缀），
   *  避免把 docx/xlsx 里几十 MB 的内嵌图片/媒体也搬进内存。 */
  function readZip(bytes, only) {
    var want = null;
    if (only && only.length) {
      want = {};
      for (var wi = 0; wi < only.length; wi++) want[only[wi]] = 1;
    }
    function wantedName(n) {
      if (!want) return true;
      if (want[n]) return true;
      for (var o in want) {
        if (o.charAt(o.length - 1) === '/' && n.indexOf(o) === 0) return true;
      }
      return false;
    }
    // 找 EOCD（从尾部向前扫注释区）
    var i = bytes.length - 22, eocd = -1;
    while (i >= Math.max(0, bytes.length - 22 - 65535)) {
      if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
      i--;
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP/DOCX/ODT 文件');
    var count = u16(bytes, eocd + 10);
    var cdOff = u32(bytes, eocd + 16);
    var out = {};
    var p = cdOff;
    for (var k = 0; k < count; k++) {
      if (u32(bytes, p) !== 0x02014b50) break;
      var method = u16(bytes, p + 10);
      var csize = u32(bytes, p + 20);
      var nameLen = u16(bytes, p + 28);
      var extraLen = u16(bytes, p + 30);
      var cmtLen = u16(bytes, p + 32);
      var lho = u32(bytes, p + 42);
      var name = '';
      for (var c = 0; c < nameLen; c++) name += String.fromCharCode(bytes[p + 46 + c]);
      if (!wantedName(name)) { p += 46 + nameLen + extraLen + cmtLen; continue; }
      // 从本地文件头取真实数据位置（本地头的 extra 长度可能与中央目录不同）
      var dNameLen = u16(bytes, lho + 26), dExtraLen = u16(bytes, lho + 28);
      var dStart = lho + 30 + dNameLen + dExtraLen;
      var raw = bytes.subarray(dStart, dStart + csize);
      if (method === 0) {
        out[name] = raw;
      } else if (method === 8) {
        out[name] = inflateRaw(raw); // Promise
      } else {
        out[name] = null; // 不支持的压缩方式
      }
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return out;
  }

  /** 把 map 中尚未解压的 Promise 条目全部兑现，并用结果替换回原位 */
  function resolveMaybePromises(map) {
    var names = Object.keys(map);
    return Promise.all(names.map(function (n) {
      return Promise.resolve(map[n]).then(function (v) { map[n] = v; });
    })).then(function () { return map; });
  }

  /* ---------------- XML 正文提取（docx / odt 通用骨架） ---------------- */

  /** 按块标签切段，块内拼接文本节点；tags 形如 'w:p|w:h' */
  function xmlParagraphs(xml, blockTags, tabTag, brTag) {
    var blocks = [];
    var re = new RegExp('<(?:' + blockTags + ')(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/(?:' + blockTags + ')>', 'gi');
    var m;
    while ((m = re.exec(xml))) {
      var body = m[1];
      body = body.replace(new RegExp('<' + tabTag + '\\s*/?>', 'gi'), '\t')
                 .replace(new RegExp('<' + brTag + '\\s*/?>', 'gi'), '\n');
      var text = '';
      // 取所有文本节点（标签外的内容）
      var parts = body.split(/<[^>]+>/);
      for (var i = 0; i < parts.length; i++) text += parts[i];
      text = decodeEntities(text);
      if (text.trim()) blocks.push(text);
    }
    if (!blocks.length) {
      // 极端情况：没有块结构，整段剥标签
      var flat = decodeEntities(xml.replace(/<[^>]+>/g, ' '));
      if (flat.trim()) blocks.push(flat);
    }
    return blocks.join('\n');
  }

  function extractDocx(xml) {
    return tidy(xmlParagraphs(xml, 'w:p', 'w:tab', 'w:br'));
  }

  function extractOdt(xml) {
    return tidy(xmlParagraphs(xml, 'text:p|text:h', 'text:tab', 'text:line-break'));
  }

  /* ---------------- HTML ---------------- */

  function extractHtml(html) {
    var s = String(html);
    s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
         .replace(/<!--[\s\S]*?-->/g, ' ');
    // 块级标签转换行
    s = s.replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|pre|table)>/gi, '\n')
         .replace(/<(br|hr)\s*\/?>/gi, '\n')
         .replace(/<li[^>]*>/gi, '· ')
         .replace(/<t[dh][^>]*>/gi, ' | ');
    var text = decodeEntities(s.replace(/<[^>]+>/g, ''));
    return tidy(text);
  }

  /* ---------------- RTF ---------------- */

  function extractRtf(rtfText) {
    var bytes = [];                 // \'hh 十六进制字节累积
    var ansiPg = 1252;              // 默认
    var ucSkip = 1;                 // \ucN：\u 后回退字符个数（中文 RTF 常为 2）
    var out = '';
    var i = 0, n = rtfText.length;
    var groupSkipDepth = -1;        // 跳过 fonttbl 等目标组
    var depth = 0;

    function flushBytes() {
      if (!bytes.length) return;
      var enc = (ansiPg === 936 || ansiPg === 10008) ? 'gbk'
        : (ansiPg === 950 || ansiPg === 10002) ? 'big5' : 'windows-1252';
      try { out += new TextDecoder(enc).decode(new Uint8Array(bytes)); }
      catch (e) { for (var k = 0; k < bytes.length; k++) out += String.fromCharCode(bytes[k]); }
      bytes = [];
    }

    while (i < n) {
      var ch = rtfText[i];
      if (ch === '{') { flushBytes(); depth++; i++; continue; }
      if (ch === '}') {
        flushBytes();
        if (groupSkipDepth === depth) groupSkipDepth = -1;
        depth--; i++; continue;
      }
      if (ch === '\\' && groupSkipDepth < 0) {
        var m = /^\\([a-z]+)(-?\d+)? ?/i.exec(rtfText.slice(i, i + 40));
        if (m) {
          var word = m[1].toLowerCase(), param = m[2];
          if (word === 'ansicpg' && param) ansiPg = parseInt(param, 10);
          else if (word === 'uc' && param) ucSkip = parseInt(param, 10);
          else if (word === 'par' || word === 'sect' || word === 'page' || word === 'row' || word === 'cell') { flushBytes(); out += word === 'cell' ? ' | ' : '\n'; }
          else if (word === 'line') { flushBytes(); out += '\n'; }
          else if (word === 'tab') { flushBytes(); out += '\t'; }
          else if (word === 'u' && param) {
            flushBytes();
            var cp = parseInt(param, 10); if (cp < 0) cp += 65536;
            out += String.fromCharCode(cp);
            // 跳过 ucSkip 个回退字符（\'hh 或单字符）
            var pos = 0, consumed = 0;
            while (consumed < ucSkip) {
              var rest = rtfText.slice(i + m[0].length + pos);
              var hh2 = /^\\'([0-9a-f]{2})/i.exec(rest);
              if (hh2) { pos += 4; consumed++; continue; }
              if (rest[0] === ' ') { pos++; continue; }
              if (rest[0] === '\\' || rest[0] === '{' || rest[0] === '}' || rest[0] === undefined) break;
              pos++; consumed++;
            }
            i += m[0].length + pos;   // 指针移到回退序列之后
            continue;                  // 已自行推进，跳过后面的统一推进
          }
          else if (word === 'fonttbl' || word === 'colortbl' || word === 'stylesheet' || word === 'info' ||
                   word === 'pict' || word === 'object' || word === 'header' || word === 'footer' ||
                   word === 'themedata' || word === 'xmlnstbl' || word === 'listtable' || word === 'listoverridetable') {
            groupSkipDepth = depth;
          }
          i += m[0].length;
          continue;
        }
        var h = /^\\'([0-9a-f]{2})/i.exec(rtfText.slice(i, i + 4));
        if (h) { bytes.push(parseInt(h[1], 16)); i += 4; continue; }
        if (rtfText[i + 1] === '*') { i += 2; groupSkipDepth = depth; continue; } // \* 忽略目标
        if (rtfText[i + 1] === '\\' || rtfText[i + 1] === '{' || rtfText[i + 1] === '}') {
          if (bytes.length) flushBytes();   // 先落地挂起的 \'hh 字节，否则字序会乱
          out += rtfText[i + 1]; i += 2; continue;
        }
        i += 2; continue;
      }
      if (groupSkipDepth < 0) {
        if (ch !== '\n' && ch !== '\r') {
          if (bytes.length) flushBytes();   // 同上：ASCII 与 \'hh 混排时必须按原序输出
          out += ch;
        }
      }
      i++;
    }
    flushBytes();
    return tidy(out);
  }

  /* ---------------- CSV / TSV → Markdown 表格 ---------------- */

  function parseDelimited(text, delim) {
    var rows = [], row = [], cell = '', inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
        else cell += c;
      } else if (c === '"') inQ = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c === '\r') { /* skip */ }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.length > 1 || (r[0] || '').trim() !== ''; });
  }

  function csvToMarkdown(rows) {
    var width = 0;
    rows.forEach(function (r) { if (r.length > width) width = r.length; });
    var esc = function (s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' '); };
    var lines = [];
    rows.forEach(function (r, i) {
      var cells = [];
      for (var c = 0; c < width; c++) cells.push(esc(r[c] || ''));
      lines.push('| ' + cells.join(' | ') + ' |');
      if (i === 0) {
        var sep = [];
        for (var k = 0; k < width; k++) sep.push('---');
        lines.push('| ' + sep.join(' | ') + ' |');
      }
    });
    return lines.join('\n');
  }

  /* ---------------- 旧版 .doc（OLE2/CFB + Word 二进制） ---------------- */

  var ENDOFCHAIN = 0xFFFFFFFE, FREESECT = 0xFFFFFFFF;

  /**
   * 解析 OLE2/CFB 容器，返回 { 流名: Uint8Array }。
   * only 给出时只实体化这些流——大 .doc 里往往有几十 MB 的内嵌图片（Data 流），
   * 回调正文根本用不到，跳过它们能省下绝大部分内存与耗时。
   */
  function cfbStreams(bytes, only) {
    if (bytes.length < 512 || bytes[0] !== 0xD0 || bytes[1] !== 0xCF) throw new Error('不是 OLE2 文件');
    var wanted = null;
    if (only && only.length) {
      wanted = {};
      for (var w = 0; w < only.length; w++) wanted[only[w]] = 1;
    }
    function wantedStream(name) { return !wanted || Object.prototype.hasOwnProperty.call(wanted, name); }

    var ssz = 1 << u16(bytes, 30);            // 扇区大小（通常 512）
    var sssz = 1 << u16(bytes, 32);           // 迷你扇区大小（通常 64）
    var dirFirst = u32(bytes, 48);
    var miniCutoff = u32(bytes, 56);
    var numFat = u32(bytes, 44);
    var difat = [], k;
    for (k = 0; k < 109 && k < numFat; k++) difat.push(u32(bytes, 76 + k * 4));

    // 额外 DIFAT（>109 个 FAT 扇区的情况）
    function readSector(sector) {
      var off = (sector + 1) * ssz;
      return bytes.subarray(off, off + ssz);
    }
    // 补齐 DIFAT 链
    var nextDifat = u32(bytes, 68); // 头部字段：第一个扩展 DIFAT 扇区
    while (nextDifat && nextDifat !== ENDOFCHAIN && nextDifat !== FREESECT && difat.length < numFat) {
      var ds = readSector(nextDifat);
      for (k = 0; k < ssz / 4 - 1; k++) {
        var v = u32(ds, k * 4);
        if (v !== FREESECT && v !== ENDOFCHAIN) difat.push(v);
      }
      nextDifat = u32(ds, ssz - 4);
    }

    // FAT
    var fat = [];
    for (k = 0; k < difat.length; k++) {
      var fs = readSector(difat[k]);
      for (var e = 0; e < ssz / 4; e++) fat.push(u32(fs, e * 4));
    }
    function chain(start) {
      var sectors = [], s = start, guard = 0;
      while (s !== ENDOFCHAIN && s !== FREESECT && s < fat.length && guard++ < 1e6) {
        sectors.push(s); s = fat[s];
      }
      return sectors;
    }
    function sectorsToBytes(sectors, sizeLimit) {
      var total = sectors.length * ssz;
      var buf = new Uint8Array(total);
      for (var s = 0; s < sectors.length; s++) {
        buf.set(readSector(sectors[s]), s * ssz);
      }
      return sizeLimit != null ? buf.subarray(0, Math.min(sizeLimit, total)) : buf;
    }

    // 目录
    var dirData = sectorsToBytes(chain(dirFirst));
    var entries = [];
    for (k = 0; k + 128 <= dirData.length; k += 128) {
      var etype = dirData[k + 66];
      if (etype === 0 || etype > 5) continue;
      var nameBuf = dirData.subarray(k, k + 64);
      var name = '';
      for (var ci = 0; ci < 64; ci += 2) {
        var code = u16(nameBuf, ci);
        if (code === 0) break;
        name += String.fromCharCode(code);
      }
      entries.push({
        name: name,
        type: etype,
        start: u32(dirData, k + 116),
        size: u32(dirData, k + 120)
      });
    }
    var root = entries.filter(function (e) { return e.type === 5; })[0];
    var streams = {};

    // 迷你流（root 的小流容器）与 MiniFAT —— 延迟到真正需要时再解，避免白搬数据
    var miniCache = null;
    function miniCtx() {
      if (miniCache) return miniCache;
      var miniStream = null;
      var minifat = [];
      var minifatStarts = entries.filter(function (e) { return e.name === 'MiniFAT' && e.type === 2; });
      if (root && root.size > 0 && minifatStarts.length) {
        var mfData = sectorsToBytes(chain(minifatStarts[0].start), minifatStarts[0].size);
        for (var mk = 0; mk + 4 <= mfData.length; mk += 4) minifat.push(u32(mfData, mk));
        var miniSectors = chain(root.start);
        var miniBuf = new Uint8Array(miniSectors.length * ssz);
        for (var ms = 0; ms < miniSectors.length; ms++) miniBuf.set(readSector(miniSectors[ms]), ms * ssz);
        miniStream = miniBuf;
      }
      miniCache = { miniStream: miniStream, minifat: minifat };
      return miniCache;
    }
    function miniChain(start) {
      var minifat = miniCtx().minifat;
      var offs = [], s = start, guard = 0;
      while (s !== ENDOFCHAIN && s !== FREESECT && s < minifat.length && guard++ < 1e6) {
        offs.push(s); s = minifat[s];
      }
      return offs;
    }

    entries.forEach(function (e) {
      if (e.type !== 2 || e.size === 0) return;
      if (!wantedStream(e.name)) return;
      var miniStream = e.size < miniCutoff ? miniCtx().miniStream : null;
      if (miniStream && e.size < miniCutoff) {
        var offs = miniChain(e.start);
        var buf = new Uint8Array(offs.length * sssz);
        for (var s = 0; s < offs.length; s++) {
          buf.set(miniStream.subarray(offs[s] * sssz, (offs[s] + 1) * sssz), s * sssz);
        }
        streams[e.name] = buf.subarray(0, Math.min(e.size, buf.length));
      } else {
        streams[e.name] = sectorsToBytes(chain(e.start), e.size);
      }
    });
    return streams;
  }

  /** Word 97-2003 正文提取：分片表（CLX/PlcPcd），失败时回退 FIB fcMin..fcMac */
  function extractDoc(wordDoc, table) {
    var flags = u16(wordDoc, 0x0A);
    var useTable1 = (flags & 0x0200) !== 0;         // fWhichTblStm
    var tbl = table || null;
    var fcClx = 0, lcbClx = 0;
    if (wordDoc.length >= 0x1AA) {
      fcClx = u32(wordDoc, 0x01A2);
      lcbClx = u32(wordDoc, 0x01A6);
    }
    var pieces = [];
    if (tbl && lcbClx > 0 && fcClx + lcbClx <= tbl.length) {
      var clx = tbl.subarray(fcClx, fcClx + lcbClx);
      var p = 0;
      // 跳过 Prc（clxt=1）段落，找到 PlcPcd（clxt=2）
      while (p < clx.length) {
        if (clx[p] === 1) {
          var cb = u16(clx, p + 1);
          p += 3 + cb;
        } else if (clx[p] === 2) {
          var lcb = u32(clx, p + 1);
          var plc = clx.subarray(p + 5, p + 5 + lcb);
          var n = Math.floor((plc.length - 4) / 12); // n 个 PCD：(n+1)*4 CP + n*8 PCD
          if (n > 0 && n < 1e6) {
            for (var pi = 0; pi < n; pi++) {
              var cpStart = u32(plc, pi * 4);
              var cpEnd = u32(plc, pi * 4 + 4);
              // PCD 数组紧跟在 (n+1) 个 CP 之后，每项 8 字节
              var pcd = (n + 1) * 4 + pi * 8;
              var fcField = u32(plc, pcd + 2);
              pieces.push({ cpStart: cpStart, cpEnd: cpEnd, fc: fcField });
            }
          }
          break;
        } else break;
      }
    }

    var text = '';
    if (pieces.length) {
      pieces.forEach(function (pc) {
        var nChars = pc.cpEnd - pc.cpStart;
        if (nChars <= 0) return;
        var compressed = (pc.fc & 0x40000000) !== 0;
        var off = pc.fc & 0x3FFFFFFF;
        var slice;
        if (compressed) {
          slice = wordDoc.subarray(off / 2, off / 2 + nChars);
          try { text += new TextDecoder('windows-1252').decode(slice); }
          catch (e) { for (var j = 0; j < slice.length; j++) text += String.fromCharCode(slice[j]); }
        } else {
          slice = wordDoc.subarray(off, off + nChars * 2);
          try { text += new TextDecoder('utf-16le').decode(slice); }
          catch (e) { text += '\uFFFD'; }
        }
      });
    }

    if (!text.trim()) {
      // 回退：fcMin..fcMac
      var fcMin = u32(wordDoc, 0x18), fcMac = u32(wordDoc, 0x1C);
      if (fcMac > fcMin && fcMac <= wordDoc.length) {
        var fExt = (flags & 0x1000) !== 0;
        var seg = wordDoc.subarray(fcMin, fcMac);
        try { text = new TextDecoder(fExt ? 'utf-16le' : 'windows-1252').decode(seg); }
        catch (e) { text = decodeSmart(seg); }
      }
    }
    // Word 控制字符清理
    return tidy(text
      .replace(/\x07/g, '\n')        // 单元格/行结束符
      .replace(/\x0b/g, '\n')        // 软换行
      .replace(/\x1e/g, '-')         // 不可断连字符
      .replace(/\x13|\x14|\x15/g, '')// 域字符
      .replace(/[\x00-\x08\x0e-\x1f]/g, ''));
  }

  /* ---------------- Excel / 电子表格文档（xlsx / xls / ods） ---------------- */

  // 列号 ↔ 字母：0→A, 25→Z, 26→AA
  function colLetters(idx) {
    var s = '';
    idx += 1;
    while (idx > 0) { var m = (idx - 1) % 26; s = String.fromCharCode(65 + m) + s; idx = Math.floor((idx - 1) / 26); }
    return s;
  }
  function colIndex(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }
  function fmtNum(d) {
    if (!isFinite(d)) return '';
    if (d === Math.floor(d) && Math.abs(d) < 1e15) return String(d);
    var s = d.toFixed(10);
    return s.replace(/\.?0+$/, '');
  }

  // 把多工作表网格渲染为 Markdown（便于在「资料」里阅读与检索）
  function sheetsToMarkdown(sheets, maxRows) {
    maxRows = maxRows || 5000;
    var parts = [];
    sheets.forEach(function (sh, si) {
      var grid = sh.grid || [];
      // 去掉完全空白的行，避免大量空行占位
      grid = grid.filter(function (r) { return r && r.length; });
      var name = sh.name || ('Sheet' + (si + 1));
      if (!grid.length) { parts.push('### ' + name + '\n（空白表）'); return; }
      var rows = grid.length, cols = 0;
      for (var r = 0; r < rows; r++) if (grid[r].length > cols) cols = grid[r].length;
      var out = ['### ' + name];
      var head = [];
      for (var c = 0; c < cols; c++) head.push(colLetters(c));
      out.push('| ' + head.join(' | ') + ' |');
      out.push('| ' + new Array(cols + 1).join(' --- | ').replace(/\| $/, '|'));
      var limit = Math.min(rows, maxRows);
      for (r = 0; r < limit; r++) {
        var row = grid[r], line = [];
        for (c = 0; c < cols; c++) {
          var v = row[c] == null ? '' : String(row[c]);
          line.push(v.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').slice(0, 300));
        }
        out.push('| ' + line.join(' | ') + ' |');
      }
      if (rows > limit) out.push('（仅导入前 ' + limit + ' 行，共 ' + rows + ' 行）');
      parts.push(out.join('\n'));
    });
    return parts.join('\n\n');
  }

  function setCell(sheet, rw, col, val) {
    while (sheet.grid.length <= rw) sheet.grid.push([]);
    var row = sheet.grid[rw];
    while (row.length <= col) row.push('');
    row[col] = val;
  }

  /* --- XLSX（Office Open XML，ZIP + XML） --- */

  function parseSharedStrings(xml) {
    var out = [], re = /<si\b[\s\S]*?<\/si>/g, m;
    while ((m = re.exec(xml))) {
      var si = m[0], txt = '', tm, tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      while ((tm = tre.exec(si))) txt += tm[1];
      out.push(decodeEntities(txt));
    }
    return out;
  }

  function cellValueXlsx(type, inner, shared) {
    if (type === 's') {
      var vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
      var idx = vm ? parseInt(vm[1].trim(), 10) : -1;
      return idx >= 0 && shared[idx] != null ? shared[idx] : '';
    }
    if (type === 'inlineStr') {
      var txt = '', tm, tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      while ((tm = tre.exec(inner))) txt += tm[1];
      return decodeEntities(txt);
    }
    if (type === 'b') {
      var bv = /<v>([\s\S]*?)<\/v>/.exec(inner);
      return bv ? (bv[1].trim() === '1' || /true/i.test(bv[1]) ? 'TRUE' : 'FALSE') : '';
    }
    if (type === 'str' || type === '') {
      var v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      return v ? decodeEntities(v[1].trim()) : '';
    }
    var vn = /<v>([\s\S]*?)<\/v>/.exec(inner);
    return vn ? vn[1].trim() : '';
  }

  function parseXlsxSheet(xml, shared) {
    var grid = [], rowRe = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g, rm;
    while ((rm = rowRe.exec(xml))) {
      var rowIdx = parseInt(rm[1], 10) - 1;
      var rowInner = rm[2], rowArr = null;
      var cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g, cm;
      while ((cm = cellRe.exec(rowInner))) {
        var attrs = cm[1], inner = cm[2];
        var refM = /\br="([A-Z]+)(\d+)"/.exec(attrs);
        if (!refM) continue;
        var col = colIndex(refM[1]);
        var tM = /\bt="([^"]*)"/.exec(attrs);
        var type = tM ? tM[1] : '';
        var val = cellValueXlsx(type, inner, shared);
        if (!String(val).trim()) continue; // 跳过空单元格
        if (rowArr === null) rowArr = [];
        while (rowArr.length <= col) rowArr.push('');
        rowArr[col] = val;
      }
      if (rowArr !== null) {
        while (grid.length < rowIdx) grid.push([]);
        grid[rowIdx] = rowArr;
      }
    }
    return grid;
  }

  function extractXlsx(files) {
    var shared = [];
    if (files['xl/sharedStrings.xml']) {
      shared = parseSharedStrings(new TextDecoder('utf-8').decode(files['xl/sharedStrings.xml']));
    }
    var sheetNames = [];
    if (files['xl/workbook.xml']) {
      var wb = new TextDecoder('utf-8').decode(files['xl/workbook.xml']);
      var re = /<sheet\b[^>]*\bname="([^"]*)"/g, mm;
      while ((mm = re.exec(wb))) sheetNames.push(decodeEntities(mm[1]));
    }
    var sheets = [];
    Object.keys(files).forEach(function (n) {
      if (/\.rels$/.test(n)) return;
      if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(n)) return;
      var xml = new TextDecoder('utf-8').decode(files[n]);
      var idx = parseInt((/\/sheet(\d+)\.xml$/.exec(n) || [])[1] || '0', 10);
      sheets.push({ name: sheetNames[idx - 1] || ('Sheet' + idx), grid: parseXlsxSheet(xml, shared) });
    });
    if (!sheets.length) throw new Error('xlsx 中找不到工作表');
    sheets.sort(function (a, b) {
      return (parseInt(String(a.name).replace(/\D/g, ''), 10) || 0) -
             (parseInt(String(b.name).replace(/\D/g, ''), 10) || 0);
    });
    return sheetsToMarkdown(sheets, 5000);
  }

  /* --- ODS / OTS（OpenDocument 表格，ZIP + content.xml） --- */

  function extractOds(xml) {
    var sheets = [];
    var sheetRe = /<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g, sm;
    while ((sm = sheetRe.exec(xml))) {
      var nameM = /\btable:name="([^"]*)"/.exec(sm[1]);
      var name = nameM ? decodeEntities(nameM[1]) : ('Sheet' + (sheets.length + 1));
      var body = sm[2], grid = [];
      var rowRe = /<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g, rm;
      while ((rm = rowRe.exec(body))) {
        var rowInner = rm[1], rowArr = [], cellRe = /<table:table-cell\b[^>]*>([\s\S]*?)<\/table:table-cell>/g, cm;
        while ((cm = cellRe.exec(rowInner))) {
          var inner = cm[1], txt = '', tm, tre = /<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g;
          while ((tm = tre.exec(inner))) txt += tm[1];
          rowArr.push(decodeEntities(txt));
        }
        if (rowArr.length) grid.push(rowArr);
      }
      sheets.push({ name: name, grid: grid });
    }
    if (!sheets.length) throw new Error('ODS 中找不到表格');
    return sheetsToMarkdown(sheets, 5000);
  }

  /* --- XLS（Excel 97-2003，OLE2/CFB + BIFF8 二进制） --- */

  // RK 压缩数值（4 字节）解码为 JS number
  function rkToNum(rk) {
    if (rk & 0x02) {
      // 整数：30 位有符号（bit2..31），bit0 表示除以 100
      var n = rk >> 2;
      if (rk & 0x01) n = n / 100;
      return n;
    }
    // 浮点：RK 的 30 位有效值（bit2..31）直接是 IEEE754 双精度数的高 30 位，
    // 双精度低 34 位（含低 32 位）恒为 0。即：把 (rk & ~3) 放到双精度的 bytes[4..7]。
    var high32 = (rk & 0xFFFFFFFC) >>> 0;
    var buf = new ArrayBuffer(8);
    var dv = new DataView(buf);
    dv.setUint32(0, 0, true);
    dv.setUint32(4, high32, true);
    var d = dv.getFloat64(0, true);
    if (rk & 0x01) d = d / 100;
    return d;
  }

  function extractXls(stream) {
    var len = stream.length;
    var sst = [];
    var sheetNames = [];
    var sheets = [];
    var cur = null, sheetIdx = -1;

    function xlStringAt(base, p) {
      // XLUnicodeString：cch(2) + flags(1) + 字符
      var cch = u16(stream, base + p);
      var flags = stream[base + p + 2];
      var start = base + p + 3;
      var s = '';
      if (flags & 0x01) { // UTF-16LE
        for (var k = 0; k < cch; k++) s += String.fromCharCode(u16(stream, start + k * 2));
      } else {
        try {
          var slice = stream.subarray(start, start + cch);
          s = new TextDecoder('windows-1252').decode(slice);
        } catch (e) { for (var j = 0; j < cch; j++) s += String.fromCharCode(stream[start + j]); }
      }
      return { text: s, next: start + (flags & 0x01 ? cch * 2 : cch) };
    }

    var pos = 0;
    while (pos + 4 <= len) {
      var op = u16(stream, pos);
      var recLen = u16(stream, pos + 2);
      var dataStart = pos + 4;
      if (dataStart + recLen > len) break;

      if (op === 0x0809) { // BOF
        var subtype = u16(stream, dataStart + 2);
        if (subtype === 0x0010) { // worksheet
          sheetIdx++;
          cur = { name: sheetNames[sheetIdx] || ('Sheet' + (sheetIdx + 1)), grid: [] };
          sheets.push(cur);
        } else { cur = null; } // globals / chart / dialog
      }
      else if (op === 0x0085) { // BoundSheet8 —— 工作表名
        var nm = xlStringAt(pos, 10); // lbPlyPos(4)+grbit(1)+itab(1) = 6, 再 +? 实际 stName 从偏移 10 开始
        sheetNames.push(nm.text);
      }
      else if (op === 0x00FC) { // SST —— 共享字符串表
        var p = dataStart + 8; // 跳过 cstTotal(4)+cstUnique(4)
        var cstUnique = u32(stream, dataStart + 4);
        for (var s = 0; s < cstUnique && p + 3 <= dataStart + recLen; s++) {
          var parsed = xlStringAt(dataStart, p - dataStart);
          sst.push(parsed.text);
          p = parsed.next;
        }
      }
      else if (op === 0x00FD && cur) { // LabelSST
        var rw = u16(stream, dataStart), col = u16(stream, dataStart + 2);
        var isst = u32(stream, dataStart + 6);
        setCell(cur, rw, col, sst[isst] != null ? sst[isst] : '');
      }
      else if (op === 0x0203 && cur) { // NUMBER
        var rwN = u16(stream, dataStart), colN = u16(stream, dataStart + 2);
        var dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
        var val = dv.getFloat64(dataStart + 6, true);
        setCell(cur, rwN, colN, fmtNum(val));
      }
      else if (op === 0x027E && cur) { // RK
        var rwR = u16(stream, dataStart), colR = u16(stream, dataStart + 2);
        var rk = u32(stream, dataStart + 6);
        setCell(cur, rwR, colR, fmtNum(rkToNum(rk)));
      }
      else if (op === 0x0204 && cur) { // LABEL（内联字符串）
        var rwL = u16(stream, dataStart), colL = u16(stream, dataStart + 2);
        var parsedL = xlStringAt(dataStart, 6);
        setCell(cur, rwL, colL, parsedL.text);
      }
      else if (op === 0x00D6 && cur) { // RSTRING（带格式字符串）
        var rwS = u16(stream, dataStart), colS = u16(stream, dataStart + 2);
        var parsedS = xlStringAt(dataStart, 6);
        setCell(cur, rwS, colS, parsedS.text);
      }
      else if (op === 0x0205 && cur) { // BOOLERR
        var rwB = u16(stream, dataStart), colB = u16(stream, dataStart + 2);
        var fval = stream[dataStart + 6];
        var isErr = stream[dataStart + 7];
        setCell(cur, rwB, colB, isErr ? 'ERROR' : (fval ? 'TRUE' : 'FALSE'));
      }

      pos = dataStart + recLen;
    }

    if (!sheets.length) throw new Error('xls 中找不到工作表');
    return sheetsToMarkdown(sheets.map(function (sh, i) {
      return { name: sh.name || ('Sheet' + (i + 1)), grid: sh.grid };
    }), 5000);
  }

  /* ---------------- 格式分派 ---------------- */

  var BACKUP_CHECK = /^[\s\r\n]*[\[{]/;

  // 扩展名 → 路由。Office 类以「内容」为准（见 sniffKind），其余按扩展名即可。
  var EXT_ROUTE = {
    doc: 'cfb', dot: 'cfb', wps: 'cfb', wpt: 'cfb', xls: 'cfb', xlt: 'cfb', et: 'cfb',
    docx: 'zip', docm: 'zip', dotx: 'zip',
    xlsx: 'zip', xlsm: 'zip', xltx: 'zip', xltm: 'zip',
    odt: 'zip', ott: 'zip', ods: 'zip', ots: 'zip',
    rtf: 'rtf', html: 'html', htm: 'html', xhtml: 'html',
    csv: 'csv', tsv: 'tsv', json: 'json'
  };

  /**
   * 依据文件头判断真实类型。现实中「扩展名骗人」非常普遍：
   * 用 Word 存成 RTF 却叫 .doc、.docx 改名成 .doc、WPS 输出的 .wps 其实是 OLE2 容器……
   * 只看扩展名会直接解析失败，所以 Office 类一律再验一次内容。
   */
  function sniffKind(bytes) {
    var n = bytes.length;
    if (!n) return 'empty';
    if (n >= 8 && bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0) return 'cfb';
    if (n >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B &&
        (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) return 'zip';
    if (n >= 5 && bytes[0] === 0x7B && bytes[1] === 0x5C && bytes[2] === 0x72 &&
        bytes[3] === 0x74 && bytes[4] === 0x66) return 'rtf';   // {\rtf
    if (n >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return 'text';
    if (n >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return 'text';   // UTF-16LE BOM
    // 采样：出现 NUL 或控制字符比例偏高即视为二进制
    var sample = Math.min(n, 4096), bad = 0;
    for (var i = 0; i < sample; i++) {
      var b = bytes[i];
      if (b === 0) return 'binary';
      if (b < 9 || (b > 13 && b < 32)) bad++;
    }
    return bad / sample > 0.05 ? 'binary' : 'text';
  }

  function extract(name, arrayBuffer) {
    var bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    var ext = extOf(name);

    var route = EXT_ROUTE[ext] || 'text';
    var bigExt = (ext === 'doc' || ext === 'xls' || ext === 'xlsx' || ext === 'xlsm' ||
                  ext === 'xlt' || ext === 'xltx' || ext === 'xltm');
    var limit = (route === 'cfb' || bigExt) ? MAX_BYTES_DOC : MAX_BYTES;
    if (bytes.length > limit) {
      return Promise.resolve({
        kind: 'error',
        error: '文件超过 ' + Math.round(limit / 1024 / 1024) + 'MB，暂不支持'
      });
    }

    var format = '';
    var extraWarning = null;
    var sniffed = sniffKind(bytes);

    // 扩展名声称是 Office 文档时，以文件内容为准
    if (route === 'cfb' || route === 'zip' || route === 'rtf') {
      if (sniffed === 'zip') route = 'zip';
      else if (sniffed === 'cfb') route = 'cfb';
      else if (sniffed === 'rtf') route = 'rtf';
      else if (sniffed === 'empty') route = 'text';
      else if (sniffed === 'text') { route = 'text'; extraWarning = '扩展名与内容不符（实为纯文本），已按文本导入'; }
      else {
        return Promise.resolve({ kind: 'error', error: '文件内容不是可识别的 Word/WPS 文档（可能已损坏或加密）' });
      }
    }
    else if (route === 'text' && (sniffed === 'cfb' || sniffed === 'zip')) {
      // .txt 实际是 Word 文件：照样读得出来
      route = sniffed;
      extraWarning = '扩展名与内容不符（实为 Office 文档），已按文档解析';
    }

    var p;

    // JSON：可能是信息管家备份
    if (route === 'json') {
      var head = '';
      for (var i = 0; i < Math.min(bytes.length, 64); i++) head += String.fromCharCode(bytes[i]);
      if (BACKUP_CHECK.test(head)) {
        var asText = decodeSmart(bytes);
        try {
          var obj = JSON.parse(asText);
          if ((Array.isArray(obj) && obj.length && obj[0] && obj[0].content) ||
              (obj && obj.notes && Array.isArray(obj.notes))) {
            return Promise.resolve({ kind: 'backup', text: asText, format: '信息管家备份' });
          }
        } catch (e) { /* 非 JSON，按文本导入 */ }
      }
      format = 'JSON';
      p = Promise.resolve(decodeSmart(bytes));
    }
    else if (route === 'zip') {
      var zip;
      var isXlsx = (ext === 'xlsx' || ext === 'xlsm' || ext === 'xltx' || ext === 'xltm');
      try {
        zip = readZip(bytes, isXlsx ? ['xl/workbook.xml', 'xl/sharedStrings.xml', 'xl/worksheets/'] : undefined);
      } catch (e) {
        return Promise.resolve({ kind: 'error', error: '压缩结构损坏：' + e.message });
      }
      p = resolveMaybePromises(zip).then(function (files) {
        var docXml = files['word/document.xml'];
        if (docXml) {
          format = 'Word 文档 (docx)';
          return new TextDecoder('utf-8').decode(docXml);
        }
        var hasSheet = files['xl/workbook.xml'] != null;
        if (!hasSheet) {
          for (var kk in files) { if (/^xl\/worksheets\//.test(kk)) { hasSheet = true; break; } }
        }
        if (hasSheet) {
          format = 'Excel 工作簿 (xlsx)';
          return extractXlsx(files);
        }
        var odtXml = files['content.xml'];
        if (odtXml) {
          var isOds = /<table:table\b/.test(new TextDecoder('utf-8').decode(odtXml));
          if (isOds) {
            format = 'OpenDocument 表格 (ods)';
            return extractOds(new TextDecoder('utf-8').decode(odtXml));
          }
          format = 'OpenDocument (odt)';
          return { text: extractOdt(new TextDecoder('utf-8').decode(odtXml)), asOdt: true };
        }
        throw new Error('压缩包中找不到 Word/Excel/ODF 内容');
      }).then(function (res) {
        if (res && res.asOdt) return res.text;
        return extractDocx(res);
      });
    }
    else if (route === 'cfb') {
      p = new Promise(function (resolve) { setTimeout(function () { resolve(0); }, 0); }).then(function () {
        // 只取正文/表格用得到的流；内嵌图片/宏包所在的 Data 等大流一律不展开
        var streams = cfbStreams(bytes, ['WordDocument', 'Workbook', 'Book', '0Table', '1Table']);
        var wordDoc = streams.WordDocument;
        if (wordDoc) {
          format = 'Word 97-2003 (doc)';
          var flags = u16(wordDoc, 0x0A);
          var tblName = (flags & 0x0200) ? '1Table' : '0Table';
          var table = streams[tblName] || streams['1Table'] || streams['0Table'] || null;
          var text = extractDoc(wordDoc, table);
          var warning = text.trim() ? undefined : '未能提取出文本（可能是扫描件或加密文档）';
          return { text: text, warning: warning };
        }
        var book = streams.Workbook || streams.Book;
        if (book) {
          format = 'Excel 97-2003 (xls)';
          return extractXls(book);
        }
        throw new Error('文件中找不到 WordDocument / Workbook 流（可能是 WPS 或加密文档）');
      });
    }
    else if (route === 'rtf') {
      format = 'RTF';
      p = Promise.resolve(extractRtf(decodeSmart(bytes)));
    }
    else if (route === 'html') {
      format = '网页 (html)';
      p = Promise.resolve(extractHtml(decodeSmart(bytes)));
    }
    else if (route === 'csv' || route === 'tsv') {
      format = route === 'csv' ? 'CSV 表格' : 'TSV 表格';
      p = Promise.resolve(function () {
        var rows = parseDelimited(decodeSmart(bytes), route === 'csv' ? ',' : '\t');
        return rows.length ? csvToMarkdown(rows) : '';
      }());
    }
    else {
      // txt / md / xml / 代码 / 字幕 / 配置…… 一切文本都走这里
      format = (ext === 'md' || ext === 'markdown') ? 'Markdown'
        : ext === 'log' ? '日志'
        : (ext === 'txt' || ext === 'text' || !ext) ? '纯文本'
        : (ext.toUpperCase() + ' 文本');
      if (sniffed === 'binary' && (ext === 'txt' || ext === 'text')) {
        return Promise.resolve({ kind: 'error', error: '这是二进制文件，不是文本文件' });
      }
      p = Promise.resolve(decodeSmart(bytes));
    }

    return p.then(function (res) {
      // .doc 分支会返回 { text, warning }，其余分支返回字符串
      var text = typeof res === 'string' ? res : (res && res.text) || '';
      var warning = typeof res === 'string' ? null : (res && res.warning) || null;
      return { kind: 'text', text: tidy(text), format: format, warning: warning || extraWarning };
    }).catch(function (e) {
      if (global.__DEBUG_DOCIMPORT) console.error('[docimport]', e && e.stack);
      return { kind: 'error', error: (e && e.message) || '解析失败' };
    });
  }

  global.DocImport = {
    extract: extract,
    extOf: extOf,
    // 供自动化测试
    _internal: {
      decodeSmart: decodeSmart, readZip: readZip, extractDocx: extractDocx, extractOdt: extractOdt,
      extractHtml: extractHtml, extractRtf: extractRtf, csvToMarkdown: csvToMarkdown,
      cfbStreams: cfbStreams, extractDoc: extractDoc,
      extractXlsx: extractXlsx, extractXls: extractXls, extractOds: extractOds,
      sheetsToMarkdown: sheetsToMarkdown
    }
  };

})(typeof window !== 'undefined' ? window : globalThis);
