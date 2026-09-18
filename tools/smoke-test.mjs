#!/usr/bin/env node
/* =========================================================
 * smoke-test.mjs — 无头冒烟测试（jsdom + fake-indexeddb）
 * 用途：验证词库、例句分片、各视图渲染是否正常，不依赖浏览器。
 *
 * 准备依赖（任选一种）：
 *   npm i jsdom fake-indexeddb
 *   # 或已装在其他目录时：
 *   JSDOM_PATH=C:/path/to/node_modules/jsdom node tools/smoke-test.mjs
 *
 * 运行：node tools/smoke-test.mjs
 * ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  const alt = process.env.JSDOM_PATH;
  if (!alt) { console.error('缺少 jsdom：请先 npm i jsdom fake-indexeddb，或设置 JSDOM_PATH'); process.exit(2); }
  ({ JSDOM } = createRequire('file:///' + String(alt).replace(/\\/g, '/') + '/')('jsdom'));
}
try {
  await import('fake-indexeddb/auto');
} catch {
  const alt = process.env.JSDOM_PATH;
  if (alt) await import('file:///' + String(alt).replace(/\\/g, '/').replace(/\/jsdom\/?$/, '') + '/fake-indexeddb/auto/index.mjs');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://wwu69266.github.io/ielts-vocab/', pretendToBeVisual: true });
const { window } = dom;
window.indexedDB = globalThis.indexedDB;
window.IDBKeyRange = globalThis.IDBKeyRange;
window.IDBTransaction = globalThis.IDBTransaction;
if (!window.speechSynthesis) window.speechSynthesis = { speak() { }, cancel() { } };
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() { }, removeEventListener() { } }));

for (const f of ['data.js', 'data-ext.js', 'config.js', 'sync.js', 'app.js']) {
  window.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
}
console.log('词库：内置 ' + (window.RAW_WORDS || []).length + ' + 扩展 ' + (window.RAW_WORDS_EXT || []).length);
/* 不要手动派发 DOMContentLoaded：jsdom 自己会触发，再派发一次会导致 init 跑两遍 */
await sleep(2500);
ok(!!((window.document.getElementById('bankList') || {}).innerHTML), '应用初始化完成');

/* 例句分片（按需加载） */
ok(window.IELTS_EX === undefined, '初始未加载例句分片（按需加载生效）');
const shardDir = path.join(ROOT, 'examples');
const shards = fs.existsSync(shardDir) ? fs.readdirSync(shardDir).filter(f => f.endsWith('.js')) : [];
for (const f of shards) window.eval(fs.readFileSync(path.join(shardDir, f), 'utf8'));
const EX = window.IELTS_EX || {};
ok(Object.keys(EX).length > 1500, '例句分片载入词数 = ' + Object.keys(EX).length);
ok(!!(EX['environment'] && EX['environment'].length), 'environment 有例句');
ok(EX['environment'] && EX['environment'][0].source === 'tatoeba', '例句带 source 字段');

/* 用真实点击驱动（app.js 是 IIFE，内部变量取不到） */
const click = el => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); return el; };
const nav = v => click(window.document.querySelector('.nav-btn[data-view="' + v + '"]'));
const htmlOf = id => ((window.document.getElementById(id) || {}).innerHTML || '');

nav('study');
await sleep(400);
const revealBtn = window.document.querySelector('#studyArea [data-act="reveal"]');
ok(!!revealBtn, '学习卡片有「显示释义」按钮');
if (revealBtn) click(revealBtn);
await sleep(400);
const studyHTML = htmlOf('studyArea');
ok(studyHTML.indexOf('ex-src') >= 0, '学习卡片显示例句来源标签');
ok(studyHTML.indexOf('ex-hl') >= 0, '学习卡片高亮目标词');
const mSrc = studyHTML.match(/class="ex-src">([^<]+)</);
console.log('  例句来源：', mSrc && mSrc[1]);

nav('bank');
await sleep(400);
ok(htmlOf('bankList').indexOf('ex-src') >= 0, '词库列表显示例句');

const addBtn = window.document.querySelector('#bankList [data-act="toggleNb"]');
if (addBtn) { click(addBtn); await sleep(400); }
nav('notebook');
await sleep(400);
ok(htmlOf('nbList').indexOf('ex-src') >= 0, '生词本显示例句');

console.log('\n结果：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
