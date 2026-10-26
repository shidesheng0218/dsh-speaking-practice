#!/usr/bin/env node
/**
 * inspect_asar.mjs — 只读解析 /Applications/DeepSeek Harness.app/.../app.asar
 *
 * asar 布局（本机 182MB 包实测）:
 *   u32@0 = 4 ; u32@4 = headerSize ; u32@8 = pickleSize ; u32@12 = jsonLen
 *   JSON 自偏移 16 起；文件数据基址 = 8 + headerSize
 *
 * 用法:
 *   node lab/inspect_asar.mjs                       # 摘要 + Electron/Chromium 版本
 *   node lab/inspect_asar.mjs package.json          # 打印包内某文件
 *   node lab/inspect_asar.mjs --grep sherpa         # 搜索包内路径
 */
import fs from 'node:fs';
import path from 'node:path';

const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const FRAMEWORK = '/Applications/DeepSeek Harness.app/Contents/Frameworks/'
  + 'Electron Framework.framework/Electron Framework';

const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const jb = Buffer.alloc(jsonLen);
fs.readSync(fd, jb, 0, jsonLen, 16);
const header = JSON.parse(jb.toString('utf8'));
const dataBase = 8 + headerSize;

function getNode(p) {
  let cur = { files: header.files };
  for (const seg of p.split('/').filter(Boolean)) {
    if (!cur.files || !cur.files[seg]) return null;
    cur = cur.files[seg];
  }
  return cur;
}
function readNode(n) {
  const b = Buffer.alloc(Number(n.size));
  fs.readSync(fd, b, 0, b.length, dataBase + Number(n.offset));
  return b.toString('utf8');
}
function walk(dir, prefix, depth, pred, out) {
  for (const [k, v] of Object.entries(dir)) {
    const p = prefix ? `${prefix}/${k}` : k;
    if (pred.test(p)) out.push(p + (v.files ? '/ [dir]' : ` [${v.size}B]`));
    if (v.files && depth < 14) walk(v.files, p, depth + 1, pred, out);
  }
  return out;
}

const args = process.argv.slice(2);
if (args[0] === '--grep') {
  console.log(walk(header.files, '', 0, new RegExp(args[1] || '', 'i'), []).join('\n'));
  process.exit(0);
}
if (args[0]) {
  const n = getNode(args[0]);
  console.log(n ? readNode(n) : `not found: ${args[0]}`);
  process.exit(0);
}

const pkgNode = getNode('package.json');
const pkg = pkgNode ? JSON.parse(readNode(pkgNode)) : {};
console.log(JSON.stringify({
  asar: { headerSize, jsonLen, dataBase, fileSize: fs.statSync(ASAR).size },
  app: { name: pkg.name, version: pkg.version, main: pkg.main,
         dependencies: Object.keys(pkg.dependencies || {}) },
  topLevel: Object.keys(header.files),
}, null, 1));

if (fs.existsSync(FRAMEWORK)) {
  const buf = fs.readFileSync(FRAMEWORK).toString('latin1');
  const chrome = [...buf.matchAll(/Chrome\/(\d+\.\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  const electron = [...buf.matchAll(/Electron\/(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  console.log('Electron:', [...new Set(electron)].slice(0, 3).join(', '));
  console.log('Chromium:', [...new Set(chrome)].slice(0, 3).join(', '));
}
const sherpa = walk(header.files, '', 0, /sherpa-onnx-node\/(non-streaming-tts|vad|resampler|offline|types)/i, []);
console.log('sherpa-onnx-node 关键模块:', sherpa.length ? '\n  ' + sherpa.join('\n  ') : '(未找到)');
fs.closeSync(fd);
