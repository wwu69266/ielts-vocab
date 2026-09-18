#!/usr/bin/env node
/* =========================================================
 * build-examples.mjs — 批量补全雅思词库例句
 *
 * 来源优先级：Tatoeba(CC-BY 2.0) > dictionaryapi.dev(CC BY-SA 3.0/Wiktionary)
 *             > ECDICT(本地 csv 可选) > generated(模板兜底)
 * 严禁抓取牛津 / 剑桥网页。
 *
 * 用法：
 *   node tools/build-examples.mjs index    # 构建 Tatoeba 索引（需要 _corpus 语料）
 *   node tools/build-examples.mjs dict     # 拉取 dictionaryapi.dev 例句
 *   node tools/build-examples.mjs mt       # MyMemory 免费翻译补中译（有额度限制）
 *   node tools/build-examples.mjs build    # 生成分片数据 + 报告
 *   node tools/build-examples.mjs all      # 依次执行（默认）
 * 所有阶段都有缓存，中断后重跑自动跳过已处理的词（断点续跑）。
 * ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');          // ielts-vocab/
const CORPUS = path.resolve(ROOT, '..', '_corpus');
const OUTDIR = path.join(ROOT, 'examples');

const C_TATOEBA = path.join(CORPUS, 'tatoeba.json');
const C_DICT = path.join(CORPUS, 'dapi.json');
const C_MT = path.join(CORPUS, 'mt.json');
const F_REPORT = path.join(CORPUS, 'report.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* 繁转简之后仍需手工修正的少数词（只替换这些固定搭配，避免误伤「土著 / 著名」） */
const T2S_FIX = [['随著', '随着'], ['接著', '接着'], ['跟著', '跟着'], ['试著', '试着'],
  ['凭著', '凭着'], ['忙著', '忙着'], ['放著', '放着'], ['住著', '住着'],
  ['坐著', '坐着'], ['顶著', '顶着'], ['站著', '站着'], ['拿著', '拿着']];

/* 可选依赖：opencc-js（繁体→简体）。未安装时自动跳过，不影响主流程。
 * 安装：npm i opencc-js   —— 或通过 OPENCC_PATH 指向 dist/esm/full.js */
let T2S = null;
{
  const cands = ['opencc-js'];
  if (process.env.OPENCC_PATH) cands.push('file:///' + String(process.env.OPENCC_PATH).replace(/\\/g, '/'));
  cands.push('file:///C:/Users/wby/.workbuddy/binaries/node/workspace/node_modules/opencc-js/dist/esm/full.js');
  for (const spec of cands) {
    try {
      const m = await import(spec);
      const C = m.Converter || (m.default && m.default.Converter);
      if (C) { T2S = C({ from: 't', to: 'cn' }); break; }
    } catch { /* 忽略 */ }
  }
}

/* ---------------- 小工具 ---------------- */
function readJSON(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}
function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
}
function log(...a) { console.log('[build-examples]', ...a); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await fn(items[idx], idx); } catch { /* ignore */ }
    }
  });
  await Promise.all(workers);
}

/* ---------------- 读取词库 ---------------- */
function loadWords() {
  const out = [];
  const files = [
    [path.join(ROOT, 'data.js'), 'RAW_WORDS'],
    [path.join(ROOT, 'data-ext.js'), 'RAW_WORDS_EXT']
  ];
  for (const [f] of files) {
    if (!fs.existsSync(f)) continue;
    const txt = fs.readFileSync(f, 'utf8');
    // 逐行取形如 ["word","phonetic",...] 的第一项，避免 eval 整个大文件
    const re = /^\s*\[\s*"([^"]+)"/gm;
    let m;
    while ((m = re.exec(txt))) out.push(m[1].toLowerCase());
  }
  // 去重，保序
  const seen = new Set();
  return out.filter(w => { if (seen.has(w)) return false; seen.add(w); return true; });
}

/* 从内置词库里取出该词的原例句（兜底用） */
function loadBuiltinExamples() {
  const map = {};
  for (const f of [path.join(ROOT, 'data.js'), path.join(ROOT, 'data-ext.js')]) {
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*\[\s*"([^"]+)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/);
      if (!m) continue;
      const w = m[1].toLowerCase();
      const en = m[6], cn = m[7];
      if (en && !(w in map)) map[w] = { en, cn };
    }
  }
  return map;
}

/* ---------------- 词形变化 ---------------- */
function forms(w) {
  const s = new Set([w]);
  const add = x => { if (x && x.length > 2 && /^[a-z]+$/.test(x)) s.add(x); };
  const isVowel = c => 'aeiou'.includes(c);
  // 复数 / 三单
  if (/[^aeiou]y$/.test(w)) add(w.slice(0, -1) + 'ies');
  else if (/(s|x|z|ch|sh|o)$/.test(w)) add(w + 'es');
  add(w + 's');
  // 过去式
  if (/e$/.test(w)) add(w + 'd');
  else if (/[^aeiou]y$/.test(w)) add(w.slice(0, -1) + 'ied');
  add(w + 'ed');
  add(w.replace(/y$/, 'i') + 'ed');
  // 进行时
  add(w.replace(/e$/, '') + 'ing');
  if (w.length > 3 && !isVowel(w.at(-1)) && !isVowel(w.at(-2)) && isVowel(w.at(-3)) && !/[wxy]/.test(w.at(-1))) {
    add(w + w.at(-1) + 'ing');
  }
  // 比较级
  add(w + 'er'); add(w + 'est');
  add(w.replace(/e$/, '') + 'er'); add(w.replace(/e$/, '') + 'est');
  if (/[^aeiou]y$/.test(w)) { add(w.slice(0, -1) + 'ier'); add(w.slice(0, -1) + 'iest'); }
  // 常见派生
  for (const suf of ['ly', 'ment', 'tion', 'sion', 'ance', 'ence', 'ive', 'al', 'ful', 'less', 'ness', 'ity', 'able', 'ible', 'ism', 'ist', 'ous', 'ize', 'ise', 'ation']) {
    add(w + suf);
    add(w.replace(/e$/, '') + suf);
    if (/[^aeiou]y$/.test(w)) add(w.slice(0, -1) + 'i' + suf);
  }
  return [...s];
}

/* ---------------- Tatoeba ---------------- */
const BAD_RE = /\b(tatoeba|sentence|sentences|wikitrans|wikipedia|cc-by|cc by)\b/i;

function quality(text, hasZh) {
  let s = 0;
  if (hasZh) s += 50;
  const n = text.split(/\s+/).length;
  s += 20 - Math.abs(n - 12);
  if (/^[A-Z]/.test(text)) s += 3;
  if (/[.?!]$/.test(text)) s += 4;
  if (BAD_RE.test(text)) s -= 200;
  if (/["\\{}<>|~#*]/.test(text)) s -= 15;
  if (/\d/.test(text)) s -= 3;
  const caps = (text.match(/\b[A-Z][a-z]{2,}/g) || []).length;
  s -= Math.max(0, caps - 1) * 2;
  return s;
}

async function stepIndex(words) {
  if (fs.existsSync(C_TATOEBA)) { log('Tatoeba 索引已存在，跳过（删除 _corpus/tatoeba.json 可重建）'); return; }
  const engFile = path.join(CORPUS, 'eng_sentences.tsv');
  const cmnFile = path.join(CORPUS, 'cmn_sentences.tsv');
  const linkFile = path.join(CORPUS, 'cmn-eng_links.tsv');
  if (!fs.existsSync(engFile)) { log('缺少 eng_sentences.tsv，跳过 Tatoeba'); writeJSON(C_TATOEBA, {}); return; }

  const formMap = new Map();
  for (const w of words) {
    for (const f of forms(w)) {
      let a = formMap.get(f); if (!a) { a = []; formMap.set(f, a); }
      if (!a.includes(w)) a.push(w);
    }
  }
  log('词形表构建完成，目标词', words.length);

  /* 三档候选池：
   *   candZh    —— 第二遍扫描，只收「有中文对照」的句子（中译覆盖率最高）
   *   candStrict—— 严格档：6–20 词、以句末标点结尾（质量最好）
   *   candRelax —— 宽松档：4–30 词，用于生僻词兜底
   */
  const candZh = new Map(), candStrict = new Map(), candRelax = new Map();
  const CAP = 200, CAP_RELAX = 80, CAP_ZH = 120;
  const hyphenWords = words.filter(w => w.indexOf('-') > 0);

  const collect = (m, w, id, text, cap) => {
    let arr = m.get(w);
    if (!arr) { arr = []; m.set(w, arr); }
    if (arr.length < cap) arr.push([id, text]);
  };

  const scan = async (onLine, onlyIds) => {
    const rs = fs.createReadStream(engFile, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
    let n = 0;
    for await (const line of rl) {
      n++;
      /* 语料为三列：id \t lang \t text */
      const i1 = line.indexOf('\t');
      if (i1 < 0) continue;
      const id = line.slice(0, i1);
      if (onlyIds && !onlyIds.has(id)) continue;
      const i2 = line.indexOf('\t', i1 + 1);
      onLine(id, i2 < 0 ? line.slice(i1 + 1) : line.slice(i2 + 1));
    }
    return n;
  };

  const classify = (text) => {
    if (!/^[\x20-\x7E]+$/.test(text)) return 0;
    if (BAD_RE.test(text)) return 0;
    const toks = text.toLowerCase().match(/[a-z][a-z']*/g);
    if (!toks) return 0;
    const n = toks.length;
    if (text.length >= 24 && text.length <= 130 && n >= 6 && n <= 20 && /[.?!]$/.test(text)) return 1;
    if (text.length >= 15 && text.length <= 240 && n >= 4 && n <= 30) return 2;
    return 0;
  };

  const handle = (id, text, m1, m2, cap1, cap2) => {
    const tier = classify(text);
    if (!tier) return;
    const low = text.toLowerCase();
    const toks = low.match(/[a-z][a-z']*/g) || [];
    const seen = new Set();
    for (const t of toks) {
      if (seen.has(t)) continue;
      seen.add(t);
      const ws = formMap.get(t);
      if (!ws) continue;
      for (const w of ws) collect(tier === 1 ? m1 : m2, w, id, text, tier === 1 ? cap1 : cap2);
    }
    /* 连字符词（high-rise / drop-out）分词会被拆开，单独整串匹配 */
    for (const hw of hyphenWords) {
      if (low.indexOf(hw) >= 0) collect(tier === 1 ? m1 : m2, hw, id, text, tier === 1 ? cap1 : cap2);
    }
  };

  const lines = await scan((id, text) => handle(id, text, candStrict, candRelax, CAP, CAP_RELAX));
  log('第一遍扫描 ' + lines + ' 行：严格档命中 ' + candStrict.size + ' 词，宽松档 ' + candRelax.size + ' 词');

  // engId -> cmnId（全量）
  const eng2cmn = new Map();
  if (fs.existsSync(linkFile)) {
    const rl2 = readline.createInterface({ input: fs.createReadStream(linkFile, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl2) {
      const p = line.split('\t');
      if (p.length < 2) continue;
      eng2cmn.set(p[1], p[0]);
    }
  }
  log('中英句对 ' + eng2cmn.size + ' 条');

  // 第二遍：只扫「有中文对照」的句子，专门提高中译覆盖率
  if (eng2cmn.size) {
    await scan((id, text) => handle(id, text, candZh, candZh, CAP_ZH, CAP_ZH), new Set(eng2cmn.keys()));
    log('第二遍（仅带中译的句）命中 ' + candZh.size + ' 词');
  }

  // cmnId -> 中文（全量）
  const cmnTxt = new Map();
  if (fs.existsSync(cmnFile)) {
    const rl3 = readline.createInterface({ input: fs.createReadStream(cmnFile, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl3) {
      const i1 = line.indexOf('\t');
      if (i1 < 0) continue;
      const i2 = line.indexOf('\t', i1 + 1);
      cmnTxt.set(line.slice(0, i1), i2 < 0 ? line.slice(i1 + 1) : line.slice(i2 + 1));
    }
  }
  log('中文句 ' + cmnTxt.size + ' 条');

  const result = {};
  for (const w of words) {
    const pool = [];
    const add = (arr, bonus) => {
      if (!arr) return;
      for (const [id, text] of arr) {
        const zh = cmnTxt.get(eng2cmn.get(id) || '') || '';
        pool.push({ text, zh, s: quality(text, !!zh) + (bonus || 0) });
      }
    };
    add(candZh.get(w), 0);
    add(candStrict.get(w), 0);
    add(candRelax.get(w), -45);
    if (!pool.length) continue;
    const scored = pool;
    scored.sort((a, b) => b.s - a.s);
    const picked = [];
    const seenTxt = new Set();
    for (const x of scored) {
      const k = x.text.toLowerCase();
      if (seenTxt.has(k)) continue;
      seenTxt.add(k);
      picked.push({ en: x.text, zh: x.zh, source: 'tatoeba' });
      if (picked.length >= 2) break;
    }
    if (picked.length) result[w] = picked;
  }
  writeJSON(C_TATOEBA, result);
  log('Tatoeba 完成，覆盖 ' + Object.keys(result).length + ' 词');
}

/* ---------------- dictionaryapi.dev ---------------- */
function wordCountOK(t, min, max) {
  const n = t.trim().split(/\s+/).length;
  return n >= min && n <= max;
}
async function fetchDictOne(w) {
  const url = 'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w);
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000)
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (!Array.isArray(j) || !j[0] || !Array.isArray(j[0].meanings)) return null;
  const out = [];
  for (const m of j[0].meanings) {
    for (const d of (m.definitions || [])) {
      const e = d && d.example;
      if (!e || typeof e !== 'string') continue;
      const t = e.trim().replace(/\s+/g, ' ');
      if (!wordCountOK(t, 5, 28)) continue;
      if (!/^[A-Za-z]/.test(t)) continue;
      if (out.some(x => x.en.toLowerCase() === t.toLowerCase())) continue;
      out.push({ en: t, zh: '', source: 'dictionaryapi' });
      if (out.length >= 2) return out;
    }
  }
  return out.length ? out : null;
}
/* 词干回退：choreographic -> choreograph、suburbanization -> suburban … */
const STEMS = ['ization', 'isation', 'ically', 'ography', 'ographic', 'ology', 'ical', 'ation', 'ition', 'tion', 'sion', 'ment', 'ness', 'ity', 'ist', 'ism', 'ive', 'ous', 'ful', 'less', 'able', 'ible', 'al', 'ic', 'ly', 'ed', 'ing', 'es', 's', 'er'];
function stemsOf(w) {
  const out = [];
  for (const s of STEMS) if (w.length > s.length + 3 && w.endsWith(s)) out.push(w.slice(0, -s.length));
  return [...new Set(out)];
}
async function fetchDictStem(w) {
  const probe = w.slice(0, Math.max(5, w.length - 3)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let re;
  try { re = new RegExp('\\b' + probe, 'i'); } catch { return null; }
  for (const st of stemsOf(w)) {
    const r = await fetchDictOne(st).catch(() => null);
    if (!r) continue;
    const hit = r.find(x => re.test(x.en));
    if (hit) return [hit];
  }
  return null;
}
async function stepDict(words, tat, cache) {
  const need = words.filter(w => {
    const has = (tat[w] && tat[w].length) || (cache[w] && cache[w].length);
    return !has;
  });
  log('dictionaryapi 待查 ' + need.length + ' 词，并发 ' + DICT_CONC);
  let done = 0, hit = 0, fail = 0;
  await pool(need, DICT_CONC, async (w) => {
    if (cache[w] !== undefined) return;
    try {
      let r = await fetchDictOne(w);
      if (!r) r = await fetchDictStem(w);   // 生僻派生词回退查词干
      if (r) { cache[w] = r; hit++; } else { cache[w] = null; }
    } catch {
      cache[w] = null; fail++;
    }
    done++;
    if (done % 25 === 0) { writeJSON(C_DICT, cache); log('  dict 进度 ' + done + '/' + need.length + ' 命中 ' + hit); }
  });
  writeJSON(C_DICT, cache);
  log('dictionaryapi 完成：命中 ' + hit + '，失败 ' + fail);
}

/* ---------------- MyMemory 免费翻译 ---------------- */
async function translateOne(text) {
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=en%7Czh-CN';
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) return { zh: '', quota: r.status === 429 };
  const j = await r.json();
  const zh = j && j.responseData && j.responseData.translatedText || '';
  const quota = !!(j && j.quotaFinished) || (j && j.responseStatus === 429);
  if (!zh || /MYMEMORY WARNING|QUERY LENGTH LIMIT|invalid/i.test(zh)) return { zh: '', quota };
  return { zh, quota };
}
async function stepMT(examples, budget) {
  const mt = readJSON(C_MT, {});
  const jobs = [];
  for (const w of Object.keys(examples)) {
    for (let i = 0; i < examples[w].length; i++) {
      const ex = examples[w][i];
      if (ex.zh) continue;
      const key = w + '#' + i;
      /* 缓存里同时存原句，句子变了就不会张冠李戴 */
      if (mt[key] !== undefined && mt[key].en === ex.en) {
        if (mt[key].zh) ex.zh = mt[key].zh;
        continue;
      }
      jobs.push({ key, text: ex.en, ex });
    }
  }
  log('待翻译 ' + jobs.length + ' 条，本次预算 ' + budget);
  let n = 0, ok = 0, stop = false;
  await pool(jobs.slice(0, budget), MT_CONC, async (job) => {
    if (stop) return;
    const r = await translateOne(job.text);
    n++;
    if (r.zh) { job.ex.zh = r.zh; mt[job.key] = { en: job.text, zh: r.zh }; ok++; }
    else { mt[job.key] = { en: job.text, zh: '' }; }
    if (r.quota) { stop = true; log('  额度用尽，停止翻译'); }
    if (n % 100 === 0) { writeJSON(C_MT, mt); log('  翻译进度 ' + n + '，成功 ' + ok); }
    await sleep(60);
  });
  writeJSON(C_MT, mt);
  log('翻译完成：尝试 ' + n + '，成功 ' + ok);
}

/* ---------------- 生成分片 ---------------- */
function shardOf(w) {
  const c = (w || '').charAt(0).toLowerCase();
  return /[a-z]/.test(c) ? c : '_';
}
function clean(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').trim();
}
async function stepBuild(words, merged) {
  const final = {};
  const stat = { tatoeba: 0, dictionaryapi: 0, ecdict: 0, generated: 0 };
  const perWord = { tatoeba: 0, dictionaryapi: 0, ecdict: 0, generated: 0, none: 0 };

  for (const w of words) {
    const arr = (merged[w] || []).slice(0, 2);
    if (arr.length) {
      final[w] = arr.slice(0, 2);
      arr.forEach(x => stat[x.source] = (stat[x.source] || 0) + 1);
      const kinds = new Set(arr.map(x => x.source));
      perWord[kinds.has('tatoeba') ? 'tatoeba' : (kinds.has('dictionaryapi') ? 'dictionaryapi' : 'ecdict')]++;
    } else {
      perWord.none++;
    }
  }

  fs.mkdirSync(OUTDIR, { recursive: true });
  const buckets = {};
  for (const w of Object.keys(final)) {
    const s = shardOf(w);
    (buckets[s] = buckets[s] || {})[w] = final[w];
  }
  let files = 0, bytes = 0;
  for (const s of Object.keys(buckets).sort()) {
    const body = Object.keys(buckets[s]).sort().map(w => {
      const items = buckets[s][w].map(x =>
        '{"en":"' + clean(x.en) + '","zh":"' + clean(x.zh || '') + '","source":"' + (x.source || 'generated') + '"}'
      ).join(',');
      return '"' + w + '":[' + items + ']';
    }).join(',\n');
    const code = '/* 例句分片 ' + s + ' — 自动生成，勿手工编辑。来源：Tatoeba(CC-BY 2.0) / dictionaryapi.dev(CC BY-SA 3.0) */\n' +
      'window.IELTS_EX = window.IELTS_EX || {};\n' +
      'Object.assign(window.IELTS_EX, {\n' + body + '\n});\n';
    const p = path.join(OUTDIR, 'ex-' + s + '.js');
    fs.writeFileSync(p, code, 'utf8');
    files++; bytes += Buffer.byteLength(code);
  }

  const report = {
    totalWords: words.length,
    wordsWithRealExamples: Object.keys(final).length,
    wordsWithout: perWord.none,
    exampleCount: Object.values(final).reduce((a, b) => a + b.length, 0),
    bySourceCount: stat,
    byWordPrimary: perWord,
    shards: files,
    bytes
  };
  writeJSON(F_REPORT, report);
  const missing = words.filter(w => !final[w]);
  fs.writeFileSync(path.join(CORPUS, 'missing.txt'), missing.join('\n'), 'utf8');
  log('生成完成：' + JSON.stringify(report, null, 2));
}

/* ---------------- main ---------------- */
const argv = process.argv.slice(2);
const cmd = argv.find(a => !a.startsWith('-')) || 'all';
const budget = Number((argv.find(a => a.startsWith('--budget=')) || '').split('=')[1] || 2000);
/* dictionaryapi.dev 单次请求约 20s（网络延迟大），必须靠并发换取吞吐 */
const DICT_CONC = Number(process.env.DICT_CONC || (argv.find(a => a.startsWith('--conc=')) || '').split('=')[1] || 24);
/* MyMemory 免费翻译：约 6s/条，靠并发换吞吐；匿名额度有限，用完自动停止（缓存可续跑累积） */
const MT_CONC = Number(process.env.MT_CONC || 10);

const words = loadWords();
log('词库总词数 ' + words.length);

const tat = fs.existsSync(C_TATOEBA) ? readJSON(C_TATOEBA, {}) : {};
const dict = fs.existsSync(C_DICT) ? readJSON(C_DICT, {}) : {};

if (cmd === 'index' || cmd === 'all') await stepIndex(words);
const T = fs.existsSync(C_TATOEBA) ? readJSON(C_TATOEBA, {}) : {};
const D = fs.existsSync(C_DICT) ? readJSON(C_DICT, {}) : {};
if (cmd === 'dict' || cmd === 'all') await stepDict(words, T, D);
const T2 = fs.existsSync(C_TATOEBA) ? readJSON(C_TATOEBA, {}) : {};
const D2 = fs.existsSync(C_DICT) ? readJSON(C_DICT, {}) : {};

// 合并（Tatoeba 优先，其次 dictionaryapi）
const merged = {};
for (const w of words) {
  const arr = [];
  if (T2[w]) arr.push(...T2[w].slice(0, 2));
  if (D2[w] && D2[w].length && arr.length < 2) {
    for (const x of D2[w]) { if (arr.length >= 2) break; if (!arr.some(y => y.en.toLowerCase() === x.en.toLowerCase())) arr.push(x); }
  }
  if (arr.length) merged[w] = arr;
}
/* 套用已缓存的机器翻译结果 + 繁体转简体 */
const mtAll = readJSON(C_MT, {});
let t2sApplied = 0;
for (const w of Object.keys(merged)) {
  merged[w].forEach((ex, i) => {
    const k = w + '#' + i;
    if (!ex.zh && mtAll[k] && mtAll[k].en === ex.en && mtAll[k].zh) ex.zh = mtAll[k].zh;
    if (ex.zh && T2S) {
      let c = T2S(ex.zh);
      /* OpenCC 未处理的少数口气助词：随著→随着（注意：土著/著名 等词不在此列，不能全局替换） */
      for (const [a, b] of T2S_FIX) if (c.indexOf(a) >= 0) c = c.split(a).join(b);
      if (c !== ex.zh) t2sApplied++;
      ex.zh = c;
    }
  });
}
if (T2S) log('繁转简处理 ' + t2sApplied + ' 条');

if (cmd === 'mt') await stepMT(merged, budget);
if (cmd === 'build' || cmd === 'all') await stepBuild(words, merged);
log('全部阶段结束');
