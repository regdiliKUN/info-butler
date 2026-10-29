'use strict';
/* PDF 文本层提取 —— 用代码现场生成 PDF，不依赖任何外部样本文件 */
const test = require('node:test');
const assert = require('node:assert');
const { createSandbox } = require('./harness');

const sb = createSandbox();
const DocImport = sb.DocImport;

/**
 * 拼一个最小可用的 PDF。
 * @param {object} o
 * @param {string} o.content   内容流源码
 * @param {boolean} [o.flate]  是否用 FlateDecode 压缩内容流
 * @param {string} [o.fontObj] 覆盖字体对象（用于 Type0/Identity-H）
 * @param {string} [o.extraObjs] 追加的对象文本
 */
const { buildPdf } = require('./fixtures');

test('PDF：未压缩内容流 + 简单字体', async () => {
  const pdf = buildPdf({ content: 'BT /F1 12 Tf 72 720 Td (Hello World) Tj ET' });
  const r = await DocImport.extract('a.pdf', pdf);
  assert.strictEqual(r.kind, 'text', '应提取成功，实际：' + JSON.stringify(r));
  assert.ok(r.text.includes('Hello World'), '应包含正文，实际：' + r.text);
  assert.strictEqual(r.format, 'PDF 文档');
});

test('PDF：FlateDecode 压缩的内容流', async () => {
  const pdf = buildPdf({ content: 'BT /F1 12 Tf 72 720 Td (Compressed text works) Tj ET', flate: true });
  const r = await DocImport.extract('b.pdf', pdf);
  assert.strictEqual(r.kind, 'text');
  assert.ok(r.text.includes('Compressed text works'), '解压后应拿到正文，实际：' + r.text);
});

test('PDF：TJ 数组按字距拼回整句', async () => {
  const pdf = buildPdf({ content: 'BT /F1 12 Tf 72 720 Td [(Hello) -300 (World)] TJ ET' });
  const r = await DocImport.extract('c.pdf', pdf);
  assert.ok(/Hello\s*World/.test(r.text), 'TJ 数组应拼成一句，实际：' + JSON.stringify(r.text));
});

test('PDF：Identity-H + ToUnicode 还原中文', async () => {
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    '3 beginbfchar',
    '<0001> <4F60>',
    '<0002> <597D>',
    '<0003> <4E16>',
    'endbfchar',
    'endcmap',
    'end',
    'end'
  ].join('\n');

  const pdf = buildPdf({
    content: 'BT /F1 12 Tf 72 720 Td <000100020003> Tj ET',
    fontObj: '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H ' +
      '/DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    extraObjs: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun >>@@' +
      '<< /Length ' + Buffer.byteLength(cmap, 'latin1') + ' >>\nstream\n' + cmap + '\nendstream'
  });

  const r = await DocImport.extract('cn.pdf', pdf);
  assert.strictEqual(r.kind, 'text', '应提取成功，实际：' + JSON.stringify(r));
  assert.ok(r.text.includes('你好世'), '应还原出中文，实际：' + JSON.stringify(r.text));
});

test('PDF：bfrange 区间映射', async () => {
  const cmap = [
    'begincmap',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    '1 beginbfrange',
    '<0010> <0012> <4E00>',
    'endbfrange',
    'endcmap'
  ].join('\n');

  const pdf = buildPdf({
    content: 'BT /F1 12 Tf 72 720 Td <001000110012> Tj ET',
    fontObj: '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /ToUnicode 6 0 R >>',
    extraObjs: '<< /Length ' + Buffer.byteLength(cmap, 'latin1') + ' >>\nstream\n' + cmap + '\nendstream'
  });
  const r = await DocImport.extract('range.pdf', pdf);
  assert.strictEqual(r.kind, 'text', JSON.stringify(r));
  assert.ok(r.text.includes('一丁丂'), '区间应递增映射，实际：' + JSON.stringify(r.text));
});

test('PDF：没有文字层时明确报错，而不是返回空', async () => {
  const pdf = buildPdf({ content: 'q 100 0 0 100 0 0 cm /Im1 Do Q' });
  const r = await DocImport.extract('scan.pdf', pdf);
  assert.strictEqual(r.kind, 'error');
  assert.ok(/扫描件|OCR|文字层/.test(r.error), '错误文案应说明原因：' + r.error);
});

test('PDF：加密文件给出可操作提示', async () => {
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'latin1'),
    Buffer.from('trailer\n<< /Root 1 0 R /Encrypt 9 0 R >>\n%%EOF\n', 'latin1')
  ]);
  const r = await DocImport.extract('locked.pdf', pdf);
  assert.strictEqual(r.kind, 'error');
  assert.ok(/加密/.test(r.error), '应提示已加密：' + r.error);
});

test('PDF：扩展名写错也能按内容识别', async () => {
  const pdf = buildPdf({ content: 'BT /F1 12 Tf 72 720 Td (mislabeled) Tj ET' });
  const r = await DocImport.extract('伪装成文本.txt', pdf);
  assert.strictEqual(r.kind, 'text', JSON.stringify(r));
  assert.ok(r.text.includes('mislabeled'));
});

test('PDF：转义与八进制字符还原', async () => {
  const pdf = buildPdf({ content: 'BT /F1 12 Tf 72 720 Td (a\\(b\\)c\\101) Tj ET' });
  const r = await DocImport.extract('esc.pdf', pdf);
  assert.ok(r.text.includes('a(b)cA'), '应还原转义字符，实际：' + JSON.stringify(r.text));
});
