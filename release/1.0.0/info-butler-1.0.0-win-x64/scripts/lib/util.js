'use strict';
/* 通用工具：文件遍历、复制、哈希、大小格式化 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(target) {
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

/** 清空目录内容但保留目录本身 */
function emptyDir(dir) {
  if (!fs.existsSync(dir)) return ensureDir(dir);
  for (const name of fs.readdirSync(dir)) {
    rmrf(path.join(dir, name));
  }
  return dir;
}

/** 遍历目录，返回相对路径（统一用 / 分隔） */
function walk(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let items = [];
    try {
      items = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const it of items) {
      const relChild = rel ? rel + '/' + it.name : it.name;
      if (it.isDirectory()) stack.push(relChild);
      else if (it.isFile()) out.push(relChild);
    }
  }
  return out.sort();
}

/** 拷贝目录/文件到目标，返回写入的文件数 */
function copyInto(srcRoot, destRoot) {
  let count = 0;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(srcRoot, rel) : srcRoot;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      ensureDir(rel ? path.join(destRoot, rel) : destRoot);
      for (const name of fs.readdirSync(abs)) stack.push(rel ? rel + '/' + name : name);
    } else if (st.isFile()) {
      const dest = rel ? path.join(destRoot, rel) : destRoot;
      ensureDir(path.dirname(dest));
      fs.copyFileSync(abs, dest);
      count++;
    }
  }
  return count;
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function formatBytes(n) {
  if (!isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? String(v) : v.toFixed(1)) + ' ' + units[i];
}

function stamp(d) {
  const t = d || new Date();
  const p = (x) => String(x).padStart(2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) +
    ' ' + p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds());
}

function fileStamp(d) {
  const t = d || new Date();
  const p = (x) => String(x).padStart(2, '0');
  return String(t.getFullYear()) + p(t.getMonth() + 1) + p(t.getDate()) + '-' + p(t.getHours()) + p(t.getMinutes());
}

module.exports = {
  ensureDir, rmrf, emptyDir, walk, copyInto,
  sha256File, sha256Buf, formatBytes, stamp, fileStamp
};
