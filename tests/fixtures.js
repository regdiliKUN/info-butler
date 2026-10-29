'use strict';
/* 测试夹具：用代码现场生成 PDF，避免把二进制样本塞进仓库 */
const zlib = require('node:zlib');

function buildPdf(o) {
  const parts = [];
  let n = 0;
  const add = (body) => { n++; parts.push({ num: n, body }); return n; };

  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  const pages = add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');

  let contentStream;
  if (o.flate) {
    const raw = Buffer.from(o.content, 'latin1');
    const packed = zlib.deflateSync(raw);
    contentStream = { dict: '<< /Length ' + packed.length + ' /Filter /FlateDecode >>', data: packed };
  } else {
    const raw = Buffer.from(o.content, 'latin1');
    contentStream = { dict: '<< /Length ' + raw.length + ' >>', data: raw };
  }

  const fontNum = n + 2;   // 先占位：page=+1, contents=+2, font=+3
  add('<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ' + (n + 3) + ' 0 R >> >> /Contents ' + (n + 2) + ' 0 R >>');

  const contentsNum = add(null);   // 占位，下面回填
  const fontBody = o.fontObj || '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  add(fontBody);
  if (o.extraObjs) {
    o.extraObjs.split('@@').filter(Boolean).forEach((b) => add(b));
  }

  // 回填内容流
  const idx = parts.findIndex((p) => p.num === contentsNum);
  parts[idx] = { num: contentsNum, stream: contentStream };

  let out = '%PDF-1.4\n';
  parts.forEach((p) => {
    out += p.num + ' 0 obj\n';
    if (p.stream) {
      out += p.stream.dict + '\nstream\n';
      out += p.stream.data.toString('latin1');
      out += '\nendstream\n';
    } else {
      out += p.body + '\n';
    }
    out += 'endobj\n';
  });
  out += 'trailer\n<< /Size ' + (parts.length + 1) + ' /Root 1 0 R >>\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

module.exports = { buildPdf };
