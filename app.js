/* =========================================================
 * app.js — 雅思单词工作台
 * 存储：浏览器 IndexedDB（库名 ielts_vocab）
 * 算法：简化版 FSRS（稳定性 S / 难度 D / 可提取性 R）
 * 无外部依赖，全部原生 JS
 * ========================================================= */
(function () {
'use strict';

/* ---------------- 基础工具 ---------------- */
var DAY = 86400000;
var MIN = 60000;
var LS_QUEUE = 'wb_ielts_queue_v1';
var LS_QUIZ = 'wb_ielts_quiz_v1';

function $(id) { return document.getElementById(id); }
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function today() { return ymd(new Date()); }
function dayOffset(n) { var d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return ymd(d); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function uid(p) { return (p || 'c') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function toast(msg) {
  var t = $('toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._tm); t._tm = setTimeout(function () { t.classList.remove('show'); }, 2000);
}
function shuffle(a) {
  var r = a.slice();
  for (var i = r.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = r[i]; r[i] = r[j]; r[j] = t; }
  return r;
}
function download(name, content, mime) {
  var blob = new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(function () {
    try { if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(a.href); } catch (e) { }
    try { a.remove(); } catch (e) { }
  }, 500);
}

/* ---------------- IndexedDB ---------------- */
var DB = null, DB_NAME = 'ielts_vocab', DB_VER = 1;
var STORES = ['words', 'reviews', 'checkins', 'notebook', 'settings'];

function openDB() {
  return new Promise(function (res, rej) {
    var req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = function (e) {
      var d = e.target.result;
      if (!d.objectStoreNames.contains('words')) d.createObjectStore('words', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('reviews')) d.createObjectStore('reviews', { keyPath: 'wordId' });
      if (!d.objectStoreNames.contains('checkins')) d.createObjectStore('checkins', { keyPath: 'date' });
      if (!d.objectStoreNames.contains('notebook')) d.createObjectStore('notebook', { keyPath: 'wordId' });
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = function (e) { DB = e.target.result; res(DB); };
    req.onerror = function () { rej(req.error); };
  });
}
function idbDo(store, mode, fn) {
  return new Promise(function (res, rej) {
    var t = DB.transaction(store, mode), os = t.objectStore(store), out;
    out = fn(os);
    t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); };
    t.onerror = function () { rej(t.error); };
    t.onabort = function () { rej(t.error); };
  });
}
function idbPut(store, val) { return idbDo(store, 'readwrite', function (os) { return os.put(val); }); }
function idbDel(store, key) { return idbDo(store, 'readwrite', function (os) { return os.delete(key); }); }
function idbClear(store) { return idbDo(store, 'readwrite', function (os) { return os.clear(); }); }
function idbAll(store) { return idbDo(store, 'readonly', function (os) { return os.getAll(); }); }

/* ---------------- 状态 ---------------- */
var S = {
  words: [], wordMap: {}, reviews: {}, checkins: {}, notebook: {}, settings: {},
  view: 'dash', queue: [], qi: 0, revealed: false, studyMode: 'learn',
  bankCat: 'all', bankQuery: '', bankMastery: 'all', bankLimit: 80,
  nbQuery: '', nbTag: '', nbSort: 'time',
  quiz: null, quizStat: { total: 0, correct: 0 }
};
var DEFAULT_SETTINGS = {
  dailyGoal: 60, masteryDays: 21, reminderOn: false, reminderTime: '20:00',
  revealCn: false, makeupOn: false, theme: 'light', oxId: '', oxKey: '', camKey: '', seeded: false,
  syncMode: 'off', sbUrl: '', sbKey: '', syncEmail: '', syncCode: '', autoSync: true,
  dataUpdatedAt: 0, lastSyncAt: 0
};
function goalN() { return S.settings.dailyGoal || 60; }

function newReview(wordId) {
  return {
    wordId: wordId, due: 0, stability: 0, difficulty: 5, reps: 0, lapses: 0,
    state: 'new', lastReviewed: 0, ease: 2.5, interval: 0, history: []
  };
}
function masteryLabel(st) {
  return { new: '新词', learning: '学习中', review: '复习中', mastered: '已掌握' }[st] || '新词';
}
function masteryClass(st) {
  return st === 'mastered' ? 'ok' : (st === 'review' ? 'cat' : (st === 'learning' ? 'warn' : ''));
}

/* ---------------- 解析内置词库 ---------------- */
/* 内置词条 id 由单词本身决定（b_xxx），保证词库扩容后旧数据不会错位 */
function bid(w) { return 'b_' + String(w || '').toLowerCase().replace(/[^a-z0-9]+/g, '_'); }
function parseRaw(a, i) {
  var ex = [];
  if (a[5]) ex.push({ en: a[5], cn: a[6] || '' });
  return {
    id: bid(a[0]), word: a[0], phonetic: a[1] || '', audioUK: '', audioUS: '',
    pos: a[2] || '', meaningCN: a[3] || '', meaningEN: a[4] || '', examples: ex,
    category: a[7] || 'education', tags: (a[8] || '').split('/').filter(Boolean),
    roots: a[9] || '', synonyms: a[10] || '', collocations: a[11] || '',
    ieltsUsage: a[12] || '', difficulty: a[13] || 2, custom: false, createdAt: Date.now()
  };
}

/* ---------------- 载入 / 播种 ---------------- */
function loadAll() {
  return Promise.all([idbAll('words'), idbAll('reviews'), idbAll('checkins'), idbAll('notebook'), idbAll('settings')])
    .then(function (r) {
      var ws = r[0] || [], rv = r[1] || [], ck = r[2] || [], nb = r[3] || [], st = r[4] || [];
      S.words = ws; S.wordMap = {};
      ws.forEach(function (w) { S.wordMap[w.id] = w; });
      S.reviews = {}; rv.forEach(function (x) { S.reviews[x.wordId] = x; });
      S.checkins = {}; ck.forEach(function (x) { S.checkins[x.date] = x; });
      S.notebook = {}; nb.forEach(function (x) { S.notebook[x.wordId] = x; });
      S.settings = {}; for (var k in DEFAULT_SETTINGS) S.settings[k] = DEFAULT_SETTINGS[k];
      st.forEach(function (x) { S.settings[x.key] = x.value; });
    });
}
/* 老版本用的是 w1..wN 序号 id，词库扩容后会错位，这里迁移到 b_单词 形式 */
function migrateIds() {
  if ((S.settings.idVer || 0) >= 2 || typeof RAW_WORDS === 'undefined') return Promise.resolve();
  var map = {}, i;
  for (i = 0; i < RAW_WORDS.length && i < 400; i++) map['w' + (i + 1)] = bid(RAW_WORDS[i][0]);
  var ps = [];
  Object.keys(S.reviews).forEach(function (k) {
    var nk = map[k];
    if (nk && nk !== k && !S.reviews[nk]) {
      var r = S.reviews[k]; r.wordId = nk; delete S.reviews[k]; S.reviews[nk] = r;
      ps.push(idbPut('reviews', r)); ps.push(idbDel('reviews', k));
    }
  });
  Object.keys(S.notebook).forEach(function (k) {
    var nk = map[k];
    if (nk && nk !== k && !S.notebook[nk]) {
      var n = S.notebook[k]; n.wordId = nk; delete S.notebook[k]; S.notebook[nk] = n;
      ps.push(idbPut('notebook', n)); ps.push(idbDel('notebook', k));
    }
  });
  /* 内存中的旧序号词条重排 id */
  var remap = {};
  S.words.forEach(function (w) { if (map[w.id] && map[w.id] !== w.id) { ps.push(idbDel('words', w.id)); remap[w.id] = map[w.id]; } });
  S.words.forEach(function (w) { if (remap[w.id]) { w.id = remap[w.id]; ps.push(idbPut('words', w)); } });
  S.words.forEach(function (w) { S.wordMap[w.id] = w; });
  S.settings.idVer = 2;
  ps.push(idbPut('settings', { key: 'idVer', value: 2 }));
  return Promise.all(ps);
}
/* 播种：只补本地缺失的内置词条，词库扩容后老用户也能拿到新词 */
function seedWords() {
  if (typeof RAW_WORDS === 'undefined') return Promise.resolve();
  return migrateIds().then(function () {
    var have = {};
    S.words.forEach(function (w) { have[w.id] = 1; });
    var add = [];
    RAW_WORDS.forEach(function (a) {
      var w = parseRaw(a);
      if (!have[w.id]) { have[w.id] = 1; add.push(w); }
    });
    var ps = [];
    if (add.length) {
      ps.push(idbDo('words', 'readwrite', function (os) { add.forEach(function (w) { os.put(w); }); return 1; }));
    }
    if (!S.settings.seeded) { S.settings.seeded = true; ps.push(idbPut('settings', { key: 'seeded', value: true })); }
    if (!ps.length) return Promise.resolve();
    return Promise.all(ps);
  });
}

/* ---------------- 保存（带云同步脏标记） ---------------- */
function markDirty() {
  S.settings.dataUpdatedAt = Date.now();
  idbPut('settings', { key: 'dataUpdatedAt', value: S.settings.dataUpdatedAt });
  if (window.IELTS_SYNC) window.IELTS_SYNC.markDirty();
}
function saveReview(r) { markDirty(); return idbPut('reviews', r); }
function saveCheckin(c) { markDirty(); return idbPut('checkins', c); }
function saveNote(n) { markDirty(); return idbPut('notebook', n); }
function saveWord(w) { markDirty(); return idbPut('words', w); }
function delWordStore(id) { markDirty(); return idbDel('words', id); }
function delReviewStore(id) { markDirty(); return idbDel('reviews', id); }
function delNoteStore(id) { markDirty(); return idbDel('notebook', id); }
function saveSetting(k, v) {
  S.settings[k] = v;
  if (k !== 'dataUpdatedAt' && k !== 'lastSyncAt') markDirty();
  return idbPut('settings', { key: k, value: v });
}
function getCheckin(date) {
  return S.checkins[date] || { date: date, completed: false, newCount: 0, reviewCount: 0 };
}

/* ---------------- 记忆算法：简化版 FSRS ---------------- */
/* R(t) = (1 + F·t/S)^C  (F=19/81, C=-0.5) ；D 难度；S 稳定性（天） */
function retin(r, now) {
  if (!r.stability || !r.lastReviewed) return 0;
  var t = (now - r.lastReviewed) / DAY;
  if (t < 0) t = 0;
  return Math.pow(1 + (19 / 81) * (t / r.stability), -0.5);
}
function schedule(r, rating, now) {
  var D0 = 5, S0 = r.stability || 0, D = r.difficulty || D0;
  var R = retin(r, now);
  var D2 = clamp(D - 1.8 * (rating - 3), 1, 10);
  D2 = 0.85 * D2 + 0.15 * D0;
  var S2, interval;
  if (rating === 1) { S2 = Math.max(0.4, S0 * 0.35); interval = 0; }
  else if (S0 <= 0) { S2 = [0, 0.6, 1.6, 3.5, 8][rating]; interval = Math.max(1, Math.round(S2)); }
  else {
    var g = [0, 1 + (1 - R) * 0.6, 1 + (1 - R) * 2.0, 1 + (1 - R) * 3.6][rating];
    S2 = S0 * g; interval = Math.max(1, Math.round(S2));
  }
  S2 = clamp(S2, 0.4, 1095);
  var due = rating === 1 ? now + 10 * MIN : now + interval * DAY;
  var reps = (r.reps || 0) + 1;
  var state;
  if (rating === 1) state = 'learning';
  else if (interval >= (S.settings.masteryDays || 21) && reps >= 3) state = 'mastered';
  else state = 'review';
  var ease = clamp((r.ease || 2.5) + (0.1 - (3 - rating) * (0.08 + (3 - rating) * 0.02)), 1.3, 2.8);
  return { stability: S2, difficulty: D2, interval: interval, due: due, state: state, ease: ease, R: R };
}

/* ---------------- 队列 ---------------- */
function dueList() {
  var now = Date.now(), out = [];
  for (var id in S.reviews) {
    var r = S.reviews[id];
    if (r && r.due <= now && r.state !== 'new' && S.wordMap[id]) out.push(r);
  }
  out.sort(function (a, b) { return a.due - b.due; });
  return out;
}
function newCandidates() {
  var out = [];
  for (var i = 0; i < S.words.length; i++) if (!S.reviews[S.words[i].id]) out.push(S.words[i]);
  return out;
}
function buildQueue(extra) {
  var goal = goalN(), q = [];
  dueList().slice(0, goal).forEach(function (r) { q.push({ id: r.wordId, type: 'review' }); });
  var need = goal - q.length;
  if (need > 0) {
    var news = newCandidates(), byCat = {}, keys = [];
    news.sort(function (a, b) { return (b.difficulty || 2) - (a.difficulty || 2); });
    news.forEach(function (w) { if (!byCat[w.category]) { byCat[w.category] = []; keys.push(w.category); } byCat[w.category].push(w); });
    var picked = [], k = 0, guard = 0;
    while (picked.length < need && picked.length < news.length && guard++ < 5000) {
      var c = keys[k % keys.length];
      if (byCat[c] && byCat[c].length) picked.push(byCat[c].shift());
      k++;
    }
    picked.forEach(function (w) { q.push({ id: w.id, type: 'new' }); });
  }
  if (extra) q = q.concat(extra);
  S.queue = q; S.qi = 0; persistQueue();
}
function notebookQueue() {
  var ids = Object.keys(S.notebook).filter(function (id) { return S.wordMap[id]; });
  var now = Date.now();
  ids.sort(function (a, b) {
    var ra = S.reviews[a], rb = S.reviews[b];
    return (ra ? ra.due : 0) - (rb ? rb.due : 0);
  });
  return ids.map(function (id) { return { id: id, type: S.reviews[id] ? 'review' : 'new' }; });
}
function persistQueue() {
  try { localStorage.setItem(LS_QUEUE, JSON.stringify({ date: today(), q: S.queue, qi: S.qi })); } catch (e) { }
}
function restoreQueue() {
  try {
    var raw = localStorage.getItem(LS_QUEUE); if (!raw) return false;
    var o = JSON.parse(raw);
    if (o.date !== today()) return false;
    S.queue = (o.q || []).filter(function (it) { return S.wordMap[it.id]; });
    S.qi = clamp(o.qi || 0, 0, S.queue.length);
    return S.queue.length > 0;
  } catch (e) { return false; }
}
function loadQuizStat() {
  try { var o = JSON.parse(localStorage.getItem(LS_QUIZ) || '{}'); S.quizStat = { total: o.total || 0, correct: o.correct || 0 }; } catch (e) { }
}
function saveQuizStat() { try { localStorage.setItem(LS_QUIZ, JSON.stringify(S.quizStat)); } catch (e) { } }

/* ---------------- 评分 ---------------- */
function rate(rating) {
  var item = S.queue[S.qi]; if (!item) return;
  var w = S.wordMap[item.id]; if (!w) return;
  var r = S.reviews[item.id] || newReview(item.id);
  var now = Date.now(), out = schedule(r, rating, now);
  r.stability = out.stability; r.difficulty = out.difficulty; r.interval = out.interval;
  r.due = out.due; r.state = out.state; r.ease = out.ease;
  r.reps = (r.reps || 0) + 1; if (rating === 1) r.lapses = (r.lapses || 0) + 1;
  r.lastReviewed = now;
  r.history = r.history || []; r.history.push({ t: now, g: rating, i: out.interval });
  if (r.history.length > 30) r.history.shift();
  S.reviews[item.id] = r; saveReview(r);

  var c = getCheckin(today());
  if (item.type === 'new') c.newCount++; else c.reviewCount++;
  if (c.newCount + c.reviewCount >= goalN()) c.completed = true;
  S.checkins[c.date] = c; saveCheckin(c);

  if (rating === 1) addNotebook(w.id, 'auto');
  S.qi++; S.revealed = false; persistQueue(); refreshAll();
}
function addNotebook(wordId, by) {
  if (S.notebook[wordId]) return;
  var w = S.wordMap[wordId]; if (!w) return;
  var n = { wordId: wordId, word: w.word, addedBy: by || 'manual', note: '', tags: [], createdAt: Date.now() };
  S.notebook[wordId] = n; saveNote(n);
}

/* ---------------- 打卡 ---------------- */
function streak() {
  var n = 0, d = new Date(); d.setHours(12, 0, 0, 0);
  if (!S.checkins[ymd(d)] || !S.checkins[ymd(d)].completed) d.setDate(d.getDate() - 1);
  for (var i = 0; i < 3650; i++) {
    var k = ymd(d);
    if (S.checkins[k] && S.checkins[k].completed) { n++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return n;
}
function todayDone() {
  var c = S.checkins[today()]; return c ? (c.newCount + c.reviewCount) : 0;
}
function overdueCount() {
  return dueList().length;
}
function parseCSV(text) {
  var rows = [], row = [], cur = '', q = false;
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(function (r) { return r.some(function (x) { return String(x).trim() !== ''; }); });
}
function toCSV(rows) {
  return rows.map(function (r) {
    return r.map(function (c) {
      var s = String(c == null ? '' : c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }).join('\n');
}

/* ---------------- 主题 / 视图 ---------------- */
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', t === 'dark' ? '#171a20' : '#ffffff');
  var sel = $('setTheme'); if (sel) sel.value = t;
}
function setView(v) {
  S.view = v;
  var btns = document.querySelectorAll('.nav-btn');
  for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('is-active', btns[i].getAttribute('data-view') === v);
  var secs = document.querySelectorAll('.view');
  for (var j = 0; j < secs.length; j++) secs[j].classList.toggle('is-active', secs[j].id === 'view-' + v);
  refreshAll();
}
function setVal(id, v) {
  var el = $(id); if (!el) return;
  if (document.activeElement === el) return;
  el.value = v;
}
function setChecked(id, v) {
  var el = $(id); if (!el) return;
  if (document.activeElement === el) return;
  el.checked = !!v;
}

/* ---------------- 统一刷新入口（渲染函数之间互不调用） ---------------- */
function refreshAll() {
  renderHeader();
  renderDash();
  renderStudy();
  renderNotebook();
  renderBank();
  renderStats();
  renderSettings();
}
function renderHeader() {
  var chip = $('streakChip');
  if (chip) chip.textContent = '连续 ' + streak() + ' 天';
}

/* ---------------- 活动量（用于热力图/图表） ---------------- */
function activityMap() {
  var m = {};
  for (var id in S.reviews) {
    var h = S.reviews[id].history || [];
    for (var i = 0; i < h.length; i++) {
      var k = ymd(new Date(h[i].t)); m[k] = (m[k] || 0) + 1;
    }
  }
  return m;
}
function levelOf(c) { return c <= 0 ? 0 : (c < 10 ? 1 : (c < 25 ? 2 : (c < 45 ? 3 : 4))); }
function heatSVG(nDays) {
  var cell = 13, gap = 3;
  var end = new Date(); end.setHours(12, 0, 0, 0);
  var start = new Date(end.getTime() - (nDays - 1) * DAY);
  start.setDate(start.getDate() - start.getDay());
  var act = activityMap();
  var weeks = [], wk = [];
  var d = new Date(start.getTime());
  while (d.getTime() <= end.getTime()) {
    wk.push(new Date(d.getTime()));
    if (wk.length === 7) { weeks.push(wk); wk = []; }
    d.setDate(d.getDate() + 1);
  }
  if (wk.length) { while (wk.length < 7) wk.push(null); weeks.push(wk); }
  var w = weeks.length * (cell + gap), h = 7 * (cell + gap);
  var out = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '" preserveAspectRatio="xMinYMin meet">';
  for (var i = 0; i < weeks.length; i++) {
    for (var j = 0; j < 7; j++) {
      var dd = weeks[i][j]; if (!dd) continue;
      var k = ymd(dd), c = act[k] || 0, lv = levelOf(c);
      var ck = S.checkins[k];
      var stroke = ck && ck.completed ? ' stroke="var(--ok)" stroke-width="1.5"' : ' stroke="var(--border)" stroke-width="1"';
      out += '<rect x="' + (i * (cell + gap)) + '" y="' + (j * (cell + gap)) + '" width="' + cell + '" height="' + cell + '" rx="3" class="lv' + lv + '"' + stroke + '><title>' + k + '：' + c + ' 词' + (ck && ck.completed ? '（已打卡）' : '') + '</title></rect>';
    }
  }
  out += '</svg>';
  return out;
}

/* ---------------- 仪表盘 ---------------- */
function ringSVG(done, goal) {
  var p = goal > 0 ? clamp(done / goal, 0, 1) : 0;
  var r = 40, c = 2 * Math.PI * r;
  return '<svg width="104" height="104" viewBox="0 0 104 104">' +
    '<circle cx="52" cy="52" r="' + r + '" fill="none" stroke="var(--border)" stroke-width="10"/>' +
    '<circle cx="52" cy="52" r="' + r + '" fill="none" stroke="var(--primary)" stroke-width="10" stroke-linecap="round" ' +
    'stroke-dasharray="' + (c * p).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 52 52)"/>' +
    '<text x="52" y="50" text-anchor="middle" font-size="20" font-weight="700" fill="var(--text)">' + done + '</text>' +
    '<text x="52" y="68" text-anchor="middle" font-size="11" fill="var(--muted)">/ ' + goal + '</text></svg>';
}
function renderDash() {
  var p = $('todayPanel'); if (!p) return;
  var goal = goalN(), done = todayDone(), due = overdueCount();
  var c = getCheckin(today());
  var html = '<div class="today-title"><h3>今天要处理</h3>' +
    (due > 0 ? '<span class="due-badge">待复习 ' + due + '</span>' : '<span class="tag ok">无到期复习</span>') + '</div>';
  html += '<div class="ring-wrap">' + ringSVG(done, goal) +
    '<div class="nums"><div class="big">' + (c.completed ? '今日已打卡' : '还差 ' + Math.max(0, goal - done) + ' 词') + '</div>' +
    '<div class="muted small">新词 ' + c.newCount + ' · 复习 ' + c.reviewCount + '</div></div></div>';
  if (done >= goal) html += '<div class="notice">今日目标已完成，可以加练或去生词本复习。</div>';
  else if (due > 0) html += '<div class="notice danger">有 ' + due + ' 个单词到期（含昨天没做完自动顺延的），先复习再学新词。</div>';
  html += '<div class="row-actions"><button class="btn primary" data-act="goStudy">' + (done > 0 ? '继续学习' : '开始学习') + '</button>' +
    '<button class="btn" data-act="goQuiz">随机测验</button>' +
    '<button class="btn ghost" data-act="extra10">加练 10 词</button>' +
    (S.settings.makeupOn ? '<button class="btn ghost" data-act="openMakeup">补卡</button>' : '') + '</div>';
  p.innerHTML = html;

  var st = $('dashStats'); if (st) {
    var studied = 0, mastered = 0;
    for (var id in S.reviews) { studied++; if (S.reviews[id].state === 'mastered') mastered++; }
    st.innerHTML = '<div class="card-head"><h3>概览</h3></div>' +
      '<div class="kv"><div><div class="k">连续打卡</div><div class="v">' + streak() + ' 天</div></div>' +
      '<div><div class="k">已学单词</div><div class="v">' + studied + '</div></div>' +
      '<div><div class="k">已掌握</div><div class="v">' + mastered + '</div></div>' +
      '<div><div class="k">生词本</div><div class="v">' + Object.keys(S.notebook).length + '</div></div>' +
      '<div><div class="k">词库总量</div><div class="v">' + S.words.length + '</div></div></div>' +
      '<div class="muted small">完成每日 ' + goal + ' 词即自动打卡；昨天未完成的复习词会自动顺延到今天。</div>';
  }
  var hm = $('heatmap'); if (hm) hm.innerHTML = heatSVG(140);
  var hr = $('heatRange'); if (hr) hr.textContent = '最近 20 周';
  var sc = $('sentenceCard');
  if (sc && typeof DAILY_SENTENCES !== 'undefined') {
    var idx = Math.floor(Date.now() / DAY) % DAILY_SENTENCES.length;
    var s = DAILY_SENTENCES[idx];
    sc.innerHTML = '<div class="card-head"><h3>每日一句</h3><span class="muted small">' + today() + '</span></div>' +
      '<div style="font-size:16px">' + esc(s[0]) + '</div>' +
      '<div class="muted small" style="margin-top:6px">' + esc(s[1]) + '</div>';
  }
}

/* ---------------- 学习页 ---------------- */
function ensureQueue() {
  if (S.studyMode === 'nb') {
    if (!S.nbOn) { S.queue = notebookQueue(); S.qi = 0; S.nbOn = true; S.revealed = false; }
  } else {
    if (S.nbOn) { S.nbOn = false; S.queue = []; S.qi = 0; S.revealed = false; }
    if (S.queue.length === 0) { if (!restoreQueue()) buildQueue(); }
  }
}
function cardHTML(w, item, idx, total) {
  var r = S.reviews[w.id];
  var html = '<div class="flash"><div class="flash-head"><div>' +
    '<div class="word">' + esc(w.word) + '</div>' +
    '<div class="phonetic">' + esc(w.phonetic) + ' &nbsp;<span class="tag">' + esc(w.pos) + '</span> ' +
    '<span class="tag cat">' + catName(w.category) + '</span>' +
    (item.type === 'new' ? ' <span class="tag warn">新词</span>' : ' <span class="tag">复习</span>') +
    '</div></div><div class="speak-group">' +
    '<button class="speak" data-act="speak" data-id="' + w.id + '" data-lang="UK">英音</button>' +
    '<button class="speak" data-act="speak" data-id="' + w.id + '" data-lang="US">美音</button>' +
    '</div></div>';
  if (!S.revealed) {
    html += '<div class="center"><button class="btn primary" data-act="reveal">显示释义（空格）</button>' +
      '<div class="muted small" style="margin-top:8px">先回忆，再评分，记忆效果更好</div></div>';
  } else {
    html += '<div class="sect"><h4>释义</h4><div><b>' + esc(w.meaningCN) + '</b> <span class="muted">（' + esc(w.pos) + '）</span></div>' +
      '<div class="muted small">' + esc(w.meaningEN) + '</div></div>';
    if (w.examples && w.examples.length) {
      html += '<div class="sect"><h4>例句</h4>';
      w.examples.forEach(function (ex) {
        html += '<div class="ex"><div class="en">' + esc(ex.en) + '</div><div class="cn">' + esc(ex.cn || '') + '</div></div>';
      });
      html += '</div>';
    }
    if (w.roots) html += '<div class="sect"><h4>词根词缀</h4><div class="small">' + esc(w.roots) + '</div></div>';
    if (w.synonyms) html += '<div class="sect"><h4>同义替换</h4><div class="small">' + esc(w.synonyms) + '</div></div>';
    if (w.collocations) html += '<div class="sect"><h4>常见搭配</h4><div class="small">' + esc(w.collocations) + '</div></div>';
    if (w.ieltsUsage) html += '<div class="sect"><h4>雅思写作 / 口语关联</h4><div class="small">' + esc(w.ieltsUsage) + '</div></div>';
  }
  html += '<div class="rate-row">' +
    '<button class="rate r1" data-act="rate" data-g="1">忘记<small>10 分钟后再来</small></button>' +
    '<button class="rate r2" data-act="rate" data-g="2">模糊<small>稍后复习</small></button>' +
    '<button class="rate r3" data-act="rate" data-g="3">认识<small>正常间隔</small></button>' +
    '<button class="rate r4" data-act="rate" data-g="4">简单<small>拉长间隔</small></button></div>';
  html += '<div class="muted small" style="margin-top:10px">第 ' + (idx + 1) + ' / ' + total + ' 张 · 剩余 ' + (total - idx - 1) +
    ' · 快捷键 1–4 评分' + (r ? ' · 下次间隔约 ' + (r.interval || 0) + ' 天' : '') + '</div>';
  html += '<div class="row-actions" style="margin-top:10px">' +
    '<button class="btn sm ghost" data-act="toggleNb" data-id="' + w.id + '">' + (S.notebook[w.id] ? '移出生词本' : '加入生词本') + '</button>' +
    '<button class="btn sm ghost" data-act="lookup" data-id="' + w.id + '">在线补全音标/例句</button></div>';
  html += '</div>';
  return html;
}
function renderStudy() {
  var area = $('studyArea'); if (!area) return;
  var tabs = document.querySelectorAll('#studyTabs .tab');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('is-active', tabs[i].getAttribute('data-mode') === S.studyMode);
  if (S.studyMode === 'quiz') { renderQuiz(area); return; }
  ensureQueue();
  var total = S.queue.length, idx = S.qi;
  var meta = $('studyMeta');
  if (meta) meta.textContent = '每日目标 ' + goalN() + ' 词 · 今日已完成 ' + todayDone() + ' 词';
  var bar = $('studyBar');
  if (bar) bar.style.width = (total ? (idx / total * 100) : 0) + '%';
  if (!total || idx >= total) {
    area.innerHTML = '<div class="card center">' +
      '<div style="font-size:32px;margin-bottom:8px">今日队列已完成</div>' +
      '<div class="muted">到期复习词：' + overdueCount() + ' · 待学新词：' + newCandidates().length + '</div>' +
      '<div class="row-actions" style="justify-content:center;margin-top:14px">' +
      '<button class="btn primary" data-act="extra10">加练 10 个新词</button>' +
      '<button class="btn" data-act="goNbStudy">复习生词本</button>' +
      '<button class="btn ghost" data-act="goQuiz">随机测验</button></div></div>';
    return;
  }
  while (idx < S.queue.length && !S.wordMap[S.queue[idx].id]) { idx++; S.qi++; }
  if (idx >= S.queue.length) { persistQueue(); area.innerHTML = '<div class="card center">本轮卡片已完成。</div>'; return; }
  var item = S.queue[idx], w = S.wordMap[item.id];
  if (S.settings.revealCn) S.revealed = true;
  area.innerHTML = cardHTML(w, item, idx, total);
}

/* ---------------- 随机测验 ---------------- */
function buildQuiz(n) {
  var pool = S.words.filter(function (w) { return S.reviews[w.id] || S.notebook[w.id]; });
  if (pool.length < 6) pool = S.words.slice();
  var picks = shuffle(pool).slice(0, n || 10);
  var qs = picks.map(function (w) {
    var wrong = shuffle(S.words.filter(function (x) { return x.id !== w.id && x.meaningCN !== w.meaningCN; })).slice(0, 3);
    var opts = shuffle([{ id: w.id, t: w.meaningCN, ok: true }].concat(wrong.map(function (x) { return { id: x.id, t: x.meaningCN, ok: false }; })));
    return { id: w.id, word: w.word, opts: opts, picked: null };
  });
  S.quiz = { qs: qs, idx: 0, finished: false };
}
function renderQuiz(area) {
  var bar = $('studyBar'); if (bar) bar.style.width = '0%';
  var meta = $('studyMeta'); if (meta) meta.textContent = '随机测验：' + S.quizStat.correct + ' / ' + S.quizStat.total + ' 正确';
  if (!S.quiz) {
    area.innerHTML = '<div class="card center"><div class="muted" style="margin-bottom:12px">从已学和生词本中随机抽 10 题，四选一。</div>' +
      '<button class="btn primary" data-act="quizStart">开始测验</button></div>';
    return;
  }
  var q = S.quiz;
  if (q.finished) {
    var right = q.qs.filter(function (x) { var o = x.opts[x.picked]; return o && o.ok; }).length;
    area.innerHTML = '<div class="card center"><div style="font-size:26px;font-weight:700">得分 ' + right + ' / ' + q.qs.length + '</div>' +
      '<div class="row-actions" style="justify-content:center;margin-top:14px">' +
      '<button class="btn primary" data-act="quizStart">再来一轮</button>' +
      '<button class="btn ghost" data-act="goLearn">回到卡片</button></div></div>';
    return;
  }
  var cur = q.qs[q.idx];
  var html = '<div class="flash"><div class="muted small">第 ' + (q.idx + 1) + ' / ' + q.qs.length + ' 题</div>' +
    '<div class="word" style="margin-top:6px">' + esc(cur.word) + '</div>' +
    '<div class="muted small">选择正确中文释义</div><div class="rate-row" style="grid-template-columns:1fr;margin-top:14px">';
  cur.opts.forEach(function (o, i) {
    var cls = 'rate';
    if (cur.picked !== null) { if (o.ok) cls += ' r4'; else if (cur.picked === i) cls += ' r1'; }
    html += '<button class="' + cls + '" data-act="quizPick" data-i="' + i + '" style="align-items:flex-start;text-align:left;padding:12px 14px">' + esc(o.t) + '</button>';
  });
  html += '</div>';
  if (cur.picked !== null) html += '<div class="row-actions" style="margin-top:14px"><button class="btn primary" data-act="quizNext">' + (q.idx + 1 >= q.qs.length ? '查看结果' : '下一题') + '</button></div>';
  html += '</div>';
  area.innerHTML = html;
}
function quizPick(i) {
  var q = S.quiz; if (!q) return;
  var cur = q.qs[q.idx]; if (cur.picked !== null) return;
  cur.picked = i;
  S.quizStat.total++;
  if (cur.opts[i] && cur.opts[i].ok) S.quizStat.correct++;
  saveQuizStat();
  refreshAll();
}
function quizNext() {
  var q = S.quiz; if (!q) return;
  if (q.idx + 1 >= q.qs.length) { q.finished = true; } else { q.idx++; }
  refreshAll();
}

/* ---------------- 发音 ---------------- */
function speak(w, lang) {
  var url = lang === 'UK' ? w.audioUK : w.audioUS;
  if (url) {
    try { var a = new Audio(url); a.play(); return; } catch (e) { }
  }
  if (!('speechSynthesis' in window)) { toast('当前浏览器不支持语音合成'); return; }
  var u = new SpeechSynthesisUtterance(w.word);
  u.lang = lang === 'UK' ? 'en-GB' : 'en-US';
  u.rate = 0.92;
  var vs = window.speechSynthesis.getVoices() || [];
  var want = u.lang.toLowerCase().replace('_', '-');
  for (var i = 0; i < vs.length; i++) {
    if (vs[i].lang && vs[i].lang.toLowerCase().replace('_', '-').indexOf(want.slice(0, 2)) === 0) { u.voice = vs[i]; break; }
  }
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

/* ---------------- 词典补全（免费 API + 可选官方 key） ---------------- */
function lookupOxford(word) {
  if (!S.settings.oxId || !S.settings.oxKey || typeof fetch !== 'function') return Promise.resolve(null);
  var url = 'https://od-api.oxforddictionaries.com/api/v2/entries/en-gb/' + encodeURIComponent(word) + '?fields=pronunciations,definitions,examples&strictMatch=false';
  return fetch(url, { headers: { app_id: S.settings.oxId, app_key: S.settings.oxKey } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j || !j.results || !j.results[0]) return null;
      var p = {}, les = j.results[0].lexicalEntries || [];
      for (var i = 0; i < les.length; i++) {
        var pr = (les[i].pronunciations || [])[0];
        if (pr) {
          if (pr.phoneticSpelling) p.phonetic = pr.phoneticSpelling;
          if (pr.audioFile) {
            if (/uk|gb|brit/i.test(pr.audioFile)) p.audioUK = pr.audioFile; else p.audioUS = pr.audioUS || pr.audioFile;
          }
          break;
        }
      }
      var en = (les[0] && les[0].entries && les[0].entries[0] && les[0].entries[0].senses || [])[0];
      if (en && en.definitions && en.definitions[0]) p.meaningEN = en.definitions[0];
      p.examples = [];
      if (en && en.examples) en.examples.slice(0, 2).forEach(function (x) { p.examples.push({ en: x.text, cn: '' }); });
      return p;
    }).catch(function () { return null; });
}
function lookupFree(word) {
  if (typeof fetch !== 'function') return Promise.resolve(null);
  var url = 'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word);
  return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    if (!j || !j[0]) return null;
    var p = { examples: [] }, e = j[0];
    var ph = (e.phonetics || []).filter(function (x) { return x.text || x.audio; })[0];
    if (ph) {
      if (ph.text) p.phonetic = ph.text;
      if (ph.audio) { if (/uk|gb/i.test(ph.audio)) p.audioUK = ph.audio; else p.audioUS = ph.audio; }
    }
    (e.phonetics || []).forEach(function (x) {
      if (!x.audio) return;
      if (/uk|gb/i.test(x.audio)) p.audioUK = p.audioUK || x.audio;
      else if (/us/i.test(x.audio)) p.audioUS = p.audioUS || x.audio;
    });
    var m = (e.meanings || [])[0];
    if (m) {
      if (!p.meaningEN && m.definitions && m.definitions[0]) p.meaningEN = m.definitions[0].definition;
      (m.definitions || []).forEach(function (d) {
        if (p.examples.length < 2 && d.example) p.examples.push({ en: d.example, cn: '' });
      });
    }
    return p;
  }).catch(function () { return null; });
}
function lookupAny(w) {
  return lookupOxford(w.word).then(function (p) {
    if (p && (p.phonetic || p.audioUK || p.audioUS || (p.examples && p.examples.length))) return p;
    return lookupFree(w.word);
  });
}
function applyLookup(w, p) {
  if (!p) { toast('在线词典不可用，已保留内置数据'); return; }
  var changed = [];
  if (p.phonetic && !w.phonetic) { w.phonetic = p.phonetic; changed.push('音标'); }
  if (p.audioUK) { w.audioUK = p.audioUK; changed.push('英音'); }
  if (p.audioUS) { w.audioUS = p.audioUS; changed.push('美音'); }
  if (p.meaningEN && !w.meaningEN) { w.meaningEN = p.meaningEN; changed.push('英文释义'); }
  if (p.examples && p.examples.length) {
    p.examples.forEach(function (ex) {
      var dup = w.examples.some(function (x) { return x.en === ex.en; });
      if (!dup && w.examples.length < 3) { w.examples.push({ en: ex.en, cn: '' }); changed.push('例句'); }
    });
  }
  if (!changed.length) { toast('没有新增内容'); return; }
  saveWord(w).then(function () { toast('已补全：' + changed.filter(function (v, i, a) { return a.indexOf(v) === i; }).join('、')); refreshAll(); });
}

function catName(id) {
  for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i].name;
  return id || '未分类';
}

/* ---------------- 生词本 ---------------- */
function nbListFiltered() {
  var q = S.nbQuery.trim().toLowerCase();
  var out = Object.keys(S.notebook).map(function (id) {
    var n = S.notebook[id], w = S.wordMap[id] || {};
    return { n: n, w: w };
  }).filter(function (x) {
    if (S.nbTag && (x.n.tags || []).indexOf(S.nbTag) < 0) return false;
    if (!q) return true;
    var w = x.w;
    return (w.word || '').toLowerCase().indexOf(q) >= 0 ||
      (w.meaningCN || '').toLowerCase().indexOf(q) >= 0 ||
      (x.n.note || '').toLowerCase().indexOf(q) >= 0 ||
      (x.n.tags || []).join(' ').toLowerCase().indexOf(q) >= 0;
  });
  out.sort(function (a, b) {
    if (S.nbSort === 'word') return (a.w.word || '').localeCompare(b.w.word || '');
    if (S.nbSort === 'due') {
      var ra = S.reviews[a.n.wordId], rb = S.reviews[b.n.wordId];
      return (ra ? ra.due : 0) - (rb ? rb.due : 0);
    }
    return (b.n.createdAt || 0) - (a.n.createdAt || 0);
  });
  return out;
}
function renderNotebook() {
  var box = $('nbList'); if (!box) return;
  var cnt = $('nbCount'); if (cnt) cnt.textContent = '（' + Object.keys(S.notebook).length + ' 条）';
  var sel = $('nbTag'), tags = {};
  Object.keys(S.notebook).forEach(function (id) { (S.notebook[id].tags || []).forEach(function (t) { tags[t] = 1; }); });
  if (sel) {
    var cur = S.nbTag;
    sel.innerHTML = '<option value="">全部标签</option>' + Object.keys(tags).map(function (t) {
      return '<option value="' + esc(t) + '">' + esc(t) + '</option>';
    }).join('');
    sel.value = cur;
  }
  var items = nbListFiltered();
  if (!items.length) { box.innerHTML = '<div class="empty">生词本是空的。学习时点「忘记」会自动加入，也可以在词库里手动添加。</div>'; return; }
  box.innerHTML = items.map(function (x) {
    var w = x.w, n = x.n, r = S.reviews[n.wordId];
    return '<div class="item">' +
      '<div class="item-head"><div><span class="item-word">' + esc(w.word) + '</span>' +
      '<span class="item-ph">' + esc(w.phonetic) + '</span></div>' +
      '<span class="tag ' + (masteryClass(r ? r.state : 'new')) + '">' + masteryLabel(r ? r.state : 'new') + '</span></div>' +
      '<div class="item-cn">' + esc(w.meaningCN) + '</div>' +
      '<div class="item-meta">' +
      '<span class="tag cat">' + esc(catName(w.category)) + '</span>' +
      (n.addedBy === 'auto' ? '<span class="tag warn">答错自动加入</span>' : '<span class="tag">手动添加</span>') +
      (r && r.due ? '<span class="tag">下次 ' + ymd(new Date(r.due)).slice(5) + '</span>' : '') +
      (n.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') +
      '</div>' +
      '<div class="note-box"><textarea class="note-ta" data-id="' + n.wordId + '" placeholder="笔记：易错点 / 自己的例句 / 助记法">' + esc(n.note || '') + '</textarea></div>' +
      '<div class="item-actions">' +
      '<button class="btn sm" data-act="speak" data-id="' + n.wordId + '" data-lang="UK">英音</button>' +
      '<button class="btn sm" data-act="speak" data-id="' + n.wordId + '" data-lang="US">美音</button>' +
      '<button class="btn sm ghost" data-act="nbTagEdit" data-id="' + n.wordId + '">标签</button>' +
      '<button class="btn sm ghost" data-act="removeNb" data-id="' + n.wordId + '">移出生词本</button>' +
      '</div></div>';
  }).join('');
}

/* ---------------- 词库 ---------------- */
function renderBank() {
  var box = $('bankList'), cats = $('bankCats');
  if (!box) return;
  var cnt = $('bankCount'); if (cnt) cnt.textContent = '（' + S.words.length + ' 条）';
  if (cats) {
    cats.innerHTML = '<button class="chip-btn' + (S.bankCat === 'all' ? ' is-active' : '') + '" data-act="cat" data-cat="all">全部</button>' +
      CATEGORIES.map(function (c) {
        return '<button class="chip-btn' + (S.bankCat === c.id ? ' is-active' : '') + '" data-act="cat" data-cat="' + c.id + '">' + esc(c.name) + '</button>';
      }).join('');
  }
  var q = S.bankQuery.trim().toLowerCase();
  var list = S.words.filter(function (w) {
    if (S.bankCat !== 'all' && w.category !== S.bankCat) return false;
    if (S.bankMastery !== 'all') {
      var r = S.reviews[w.id];
      var st = r ? r.state : 'new';
      if (st !== S.bankMastery) return false;
    }
    if (!q) return true;
    return (w.word || '').toLowerCase().indexOf(q) >= 0 || (w.meaningCN || '').indexOf(q) >= 0 ||
      (w.meaningEN || '').toLowerCase().indexOf(q) >= 0 || (w.tags || []).join(' ').toLowerCase().indexOf(q) >= 0 ||
      (w.collocations || '').toLowerCase().indexOf(q) >= 0;
  });
  var lim = S.bankLimit || 80;
  var shown = list.slice(0, lim);
  if (!list.length) { box.innerHTML = '<div class="empty">没有匹配的单词。</div>'; return; }
  box.innerHTML = shown.map(function (w) {
    var r = S.reviews[w.id];
    return '<div class="item"><div class="item-head"><div><span class="item-word">' + esc(w.word) + '</span>' +
      '<span class="item-ph">' + esc(w.phonetic) + '</span> <span class="muted small">' + esc(w.pos) + '</span></div>' +
      '<span class="tag ' + masteryClass(r ? r.state : 'new') + '">' + masteryLabel(r ? r.state : 'new') + '</span></div>' +
      '<div class="item-cn">' + esc(w.meaningCN) + '</div>' +
      '<div class="item-meta"><span class="tag cat">' + esc(catName(w.category)) + '</span>' +
      (w.difficulty ? '<span class="tag">难度 ' + w.difficulty + '</span>' : '') +
      (r && r.due ? '<span class="tag">下次 ' + ymd(new Date(r.due)).slice(5) + '</span>' : '') +
      (w.custom ? '<span class="tag warn">自定义</span>' : '') + '</div>' +
      '<div class="item-actions">' +
      '<button class="btn sm" data-act="speak" data-id="' + w.id + '" data-lang="UK">英音</button>' +
      '<button class="btn sm" data-act="speak" data-id="' + w.id + '" data-lang="US">美音</button>' +
      '<button class="btn sm ghost" data-act="editWord" data-id="' + w.id + '">编辑</button>' +
      '<button class="btn sm ghost" data-act="lookup" data-id="' + w.id + '">在线补全</button>' +
      '<button class="btn sm ghost" data-act="toggleNb" data-id="' + w.id + '">' + (S.notebook[w.id] ? '移出生词本' : '加入生词本') + '</button>' +
      (w.custom ? '<button class="btn sm ghost" data-act="delWord" data-id="' + w.id + '">删除</button>' : '') +
      '</div></div>';
  }).join('') + (list.length > shown.length ?
    '<div class="row-actions" style="padding:8px"><span class="muted small">已显示 ' + shown.length + ' / ' + list.length + ' 条</span>' +
    '<button class="btn sm" data-act="bankMore">再显示 80 条</button></div>' : '');
}

/* ---------------- 统计 ---------------- */
function statsData() {
  var st = { new: 0, learning: 0, review: 0, mastered: 0, total: S.words.length };
  var ratings = { good: 0, all: 0 };
  for (var id in S.reviews) {
    var r = S.reviews[id];
    st[r.state] = (st[r.state] || 0) + 1;
    (r.history || []).forEach(function (h) { ratings.all++; if (h.g >= 3) ratings.good++; });
  }
  return { st: st, ratings: ratings };
}
function barHTML(rows) {
  var max = 1;
  rows.forEach(function (r) { max = Math.max(max, r.v); });
  return rows.map(function (r) {
    var pct = (r.v / max * 100).toFixed(1);
    return '<div style="display:flex;align-items:center;gap:10px;margin:10px 0">' +
      '<div style="width:56px;font-size:13px;color:var(--muted)">' + esc(r.k) + '</div>' +
      '<div style="flex:1;height:12px;background:var(--border);border-radius:6px;overflow:hidden">' +
      '<div style="width:' + pct + '%;height:100%;background:' + (r.c || 'var(--primary)') + '"></div></div>' +
      '<div style="width:44px;text-align:right;font-size:13px;font-weight:600">' + r.v + '</div></div>';
  }).join('');
}
function dailyChartSVG(n) {
  var days = [], i;
  for (i = n - 1; i >= 0; i--) days.push(dayOffset(-i));
  var max = 1;
  days.forEach(function (d) { var c = S.checkins[d]; var v = c ? c.newCount + c.reviewCount : 0; max = Math.max(max, v); });
  var w = days.length * 26, h = 120;
  var out = '<svg viewBox="0 0 ' + w + ' ' + (h + 16) + '" width="100%" height="' + (h + 16) + '" preserveAspectRatio="xMinYMin meet">';
  days.forEach(function (d, idx) {
    var c = S.checkins[d], nv = c ? c.newCount : 0, rv = c ? c.reviewCount : 0, tv = nv + rv;
    var bh = (tv / max) * (h - 24);
    var x = idx * 26 + 4;
    out += '<rect x="' + x + '" y="' + (h - bh - 12) + '" width="18" height="' + Math.max(2, bh * (rv / (tv || 1))) + '" rx="2" fill="var(--muted)" opacity="0.55"/>';
    out += '<rect x="' + x + '" y="' + (h - bh - 12 - Math.max(2, bh * (rv / (tv || 1)))) + '" width="18" height="' + Math.max(2, bh * (nv / (tv || 1))) + '" rx="2" fill="var(--primary)"/>';
    out += '<text x="' + (x + 9) + '" y="' + (h + 2) + '" font-size="8" text-anchor="middle" fill="var(--muted)">' + d.slice(8) + '</text>';
  });
  out += '</svg>';
  return out;
}
function accChartSVG(n) {
  var map = {}, i;
  for (i = n - 1; i >= 0; i--) map[dayOffset(-i)] = { g: 0, a: 0 };
  for (var id in S.reviews) {
    (S.reviews[id].history || []).forEach(function (h) {
      var k = ymd(new Date(h.t)); if (!map[k]) return;
      map[k].a++; if (h.g >= 3) map[k].g++;
    });
  }
  var keys = Object.keys(map).sort();
  var w = keys.length * 14, h = 90;
  var out = '<svg viewBox="0 0 ' + w + ' ' + (h + 16) + '" width="100%" height="' + (h + 16) + '" preserveAspectRatio="xMinYMin meet">';
  keys.forEach(function (k, idx) {
    var v = map[k].a ? map[k].g / map[k].a : 0;
    var bh = Math.max(1, v * (h - 20));
    out += '<rect x="' + (idx * 14 + 2) + '" y="' + (h - bh) + '" width="10" height="' + bh + '" rx="2" fill="' + (v >= 0.8 ? 'var(--ok)' : (v >= 0.6 ? 'var(--primary)' : 'var(--warn)')) + '"/>';
    if (idx % 3 === 0) out += '<text x="' + (idx * 14 + 7) + '" y="' + (h + 12) + '" font-size="7" text-anchor="middle" fill="var(--muted)">' + k.slice(5) + '</text>';
  });
  out += '</svg>';
  return out;
}
function renderStats() {
  var cards = $('statCards'); if (!cards) return;
  var sd = statsData();
  var acc = sd.ratings.all ? Math.round(sd.ratings.good / sd.ratings.all * 100) : 0;
  var checkDays = Object.keys(S.checkins).filter(function (k) { return S.checkins[k].completed; }).length;
  var totalActs = 0;
  for (var id in S.reviews) totalActs += (S.reviews[id].history || []).length;
  var items = [
    ['累计学习词次', totalActs], ['已掌握单词', sd.st.mastered || 0],
    ['平均正确率', acc + '%'], ['连续打卡', streak() + ' 天'],
    ['累计打卡天数', checkDays], ['生词本', Object.keys(S.notebook).length],
    ['词库总量', S.words.length], ['今日完成', todayDone() + ' / ' + goalN()]
  ];
  cards.innerHTML = items.map(function (it) {
    return '<div class="card" style="margin:0"><div class="stat-num">' + esc(it[1]) + '</div><div class="stat-label">' + esc(it[0]) + '</div></div>';
  }).join('');

  var mc = $('masteryChart');
  if (mc) mc.innerHTML = barHTML([
    { k: '已掌握', v: sd.st.mastered || 0, c: 'var(--ok)' },
    { k: '复习中', v: sd.st.review || 0, c: 'var(--primary)' },
    { k: '学习中', v: sd.st.learning || 0, c: 'var(--warn)' },
    { k: '新词', v: Math.max(0, sd.st.total - Object.keys(S.reviews).length), c: 'var(--muted)' }
  ]) + '<div class="muted small" style="margin-top:8px">共 ' + sd.st.total + ' 词，已开始 ' + Object.keys(S.reviews).length + ' 词</div>';

  var dc = $('dailyChart'); if (dc) dc.innerHTML = dailyChartSVG(14);
  var ac = $('accChart'); if (ac) ac.innerHTML = accChartSVG(30);
  var sh = $('statHeat'); if (sh) sh.innerHTML = heatSVG(365);

  var cal = $('checkinCal');
  if (cal) {
    var d = new Date(), y = d.getFullYear(), m = d.getMonth();
    var first = new Date(y, m, 1), days = new Date(y, m + 1, 0).getDate();
    var html = '<div class="cal-head">' + ['一', '二', '三', '四', '五', '六', '日'].map(function (x) { return '<div>' + x + '</div>'; }).join('') + '</div><div class="cal">';
    var lead = (first.getDay() + 6) % 7;
    for (var i = 0; i < lead; i++) html += '<div class="d" style="border:0;background:transparent"></div>';
    for (var dd = 1; dd <= days; dd++) {
      var k = y + '-' + pad(m + 1) + '-' + pad(dd);
      var ck = S.checkins[k];
      html += '<div class="d' + (ck && ck.completed ? ' done' : '') + (k === today() ? ' today' : '') + '">' + dd + '</div>';
    }
    html += '</div>';
    cal.innerHTML = html;
  }
}

/* ---------------- 设置 ---------------- */
function renderSettings() {
  setVal('setGoal', S.settings.dailyGoal);
  setVal('setMastery', S.settings.masteryDays);
  setVal('setRemindTime', S.settings.reminderTime);
  setChecked('setRemindOn', S.settings.reminderOn);
  setChecked('setRevealCn', S.settings.revealCn);
  setChecked('setMakeupOn', S.settings.makeupOn);
  setVal('setTheme', S.settings.theme);
  setVal('setOxId', S.settings.oxId);
  setVal('setOxKey', S.settings.oxKey);
  setVal('setCamKey', S.settings.camKey);
  renderSync();
}
function saveSettingsFromForm() {
  var g = parseInt($('setGoal').value, 10) || 60;
  var md = parseInt($('setMastery').value, 10) || 21;
  S.settings.dailyGoal = clamp(g, 10, 300);
  S.settings.masteryDays = clamp(md, 7, 90);
  S.settings.reminderOn = $('setRemindOn').checked;
  S.settings.reminderTime = $('setRemindTime').value || '20:00';
  S.settings.revealCn = $('setRevealCn').checked;
  S.settings.makeupOn = $('setMakeupOn').checked;
  S.settings.oxId = ($('setOxId').value || '').trim();
  S.settings.oxKey = ($('setOxKey').value || '').trim();
  S.settings.camKey = ($('setCamKey').value || '').trim();
  var ps = [];
  ['dailyGoal', 'masteryDays', 'reminderOn', 'reminderTime', 'revealCn', 'makeupOn', 'oxId', 'oxKey', 'camKey'].forEach(function (k) {
    ps.push(idbPut('settings', { key: k, value: S.settings[k] }));
  });
  return Promise.all(ps).then(function () {
    if (S.settings.reminderOn && 'Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch (e) { }
    }
    toast('设置已保存');
    refreshAll();
  });
}

/* ---------------- 云同步（Supabase） ---------------- */
function renderSync() {
  setVal('setSyncMode', S.settings.syncMode || 'off');
  var dflt = window.IELTS_DEFAULT_CONFIG || {};
  setVal('setSbUrl', S.settings.sbUrl || dflt.sbUrl || '');
  setVal('setSbKey', S.settings.sbKey || dflt.sbKey || '');
  setVal('setSyncEmail', S.settings.syncEmail);
  setVal('setSyncCode', S.settings.syncCode);
  setChecked('setAutoSync', S.settings.autoSync !== false);
  var m = S.settings.syncMode || 'off';
  var eb = $('syncEmailBox'), cb = $('syncCodeBox');
  if (eb) eb.style.display = (m === 'email') ? '' : 'none';
  if (cb) cb.style.display = (m === 'code') ? '' : 'none';
  if (window.IELTS_SYNC) window.IELTS_SYNC.paint();
}
function saveSyncForm() {
  var pu = S.settings.sbUrl, pk = S.settings.sbKey;
  S.settings.syncMode = ($('setSyncMode') && $('setSyncMode').value) || 'off';
  S.settings.sbUrl = (($('setSbUrl') && $('setSbUrl').value) || '').trim();
  S.settings.sbKey = (($('setSbKey') && $('setSbKey').value) || '').trim();
  S.settings.syncEmail = (($('setSyncEmail') && $('setSyncEmail').value) || '').trim();
  S.settings.syncCode = (($('setSyncCode') && $('setSyncCode').value) || '').trim();
  S.settings.autoSync = !!($('setAutoSync') && $('setAutoSync').checked);
  var ks = ['syncMode', 'sbUrl', 'sbKey', 'syncEmail', 'syncCode', 'autoSync'];
  var ps = ks.map(function (k) { return idbPut('settings', { key: k, value: S.settings[k] }); });
  return Promise.all(ps).then(function () {
    if (window.IELTS_SYNC) {
      if (S.settings.sbUrl !== pu || S.settings.sbKey !== pk) window.IELTS_SYNC.resetClient();
      window.IELTS_SYNC.paint();
      if (S.settings.syncMode !== 'off') window.IELTS_SYNC.sync();
    }
    renderSync();
    toast('同步设置已保存');
  });
}
/* 组装上传数据：只传自定义单词，内置词库不上传 */
function syncCollect(ts) {
  var revs = [];
  for (var k in S.reviews) {
    var r = S.reviews[k];
    revs.push({
      wordId: r.wordId, due: r.due, stability: r.stability, difficulty: r.difficulty,
      reps: r.reps, lapses: r.lapses, state: r.state, lastReviewed: r.lastReviewed,
      ease: r.ease, interval: r.interval,
      history: (r.history || []).slice(-20)
    });
  }
  var set = {};
  for (var s in S.settings) {
    if (s === 'dataUpdatedAt' || s === 'syncEmail') continue;
    set[s] = S.settings[s];
  }
  return {
    v: 2, app: 'ielts-vocab', updatedAt: ts || Date.now(),
    words: S.words.filter(function (w) { return w.custom; }),
    reviews: revs,
    checkins: Object.keys(S.checkins).map(function (d) { return S.checkins[d]; }),
    notebook: Object.keys(S.notebook).map(function (i) { return S.notebook[i]; }),
    settings: set,
    quizStat: S.quizStat
  };
}
/* 应用云端数据：按「更新的那条胜出」合并 */
function syncApply(data) {
  if (!data) return Promise.resolve();
  var ps = [];
  (data.words || []).forEach(function (w) {
    if (!w || !w.id) return;
    if (S.wordMap[w.id]) return;
    var dup = null;
    for (var i = 0; i < S.words.length; i++) { if (S.words[i].word === w.word) { dup = S.words[i]; break; } }
    if (dup) return;
    S.words.push(w); S.wordMap[w.id] = w; ps.push(idbPut('words', w));
  });
  (data.reviews || []).forEach(function (r) {
    if (!r || !r.wordId) return;
    var cur = S.reviews[r.wordId];
    if (!cur || (r.lastReviewed || 0) >= (cur.lastReviewed || 0)) { S.reviews[r.wordId] = r; ps.push(idbPut('reviews', r)); }
  });
  (data.checkins || []).forEach(function (c) {
    if (!c || !c.date) return;
    var cur = S.checkins[c.date];
    var cn = (c.newCount || 0) + (c.reviewCount || 0);
    var ln = cur ? (cur.newCount || 0) + (cur.reviewCount || 0) : -1;
    if (!cur || (c.completed && !cur.completed) || cn > ln) { S.checkins[c.date] = c; ps.push(idbPut('checkins', c)); }
  });
  (data.notebook || []).forEach(function (n) {
    if (!n || !n.wordId) return;
    var cur = S.notebook[n.wordId];
    if (!cur || (n.updatedAt || n.createdAt || 0) >= (cur.updatedAt || cur.createdAt || 0)) {
      S.notebook[n.wordId] = n; ps.push(idbPut('notebook', n));
    }
  });
  if (data.settings) {
    for (var k in data.settings) {
      if (k === 'dataUpdatedAt' || k === 'syncEmail') continue;
      S.settings[k] = data.settings[k];
      ps.push(idbPut('settings', { key: k, value: data.settings[k] }));
    }
  }
  if (data.quizStat) { S.quizStat = data.quizStat; saveQuizStat(); }
  return Promise.all(ps).then(function () { applyTheme(S.settings.theme || 'light'); });
}
/* 冲突选择：返回 Promise<'cloud'|'local'|'cancel'> */
function syncConflict(localAt, cloudAt) {
  return new Promise(function (resolve) {
    var f = function (d) { return new Date(d).toLocaleString('zh-CN'); };
    window.__conflictResolve = resolve;
    openModal('云端数据更新',
      '<div class="notice">云端数据比本机更新。<br>本机更新时间：' + f(localAt) + '<br>云端更新时间：' + f(cloudAt) + '</div>' +
      '<p class="muted small">选择「用云端覆盖本地」会把本机的复习/打卡/生词本替换为云端版本；选择「用本地覆盖云端」会把本机数据上传到云端。两者都会覆盖另一端，不可撤销。</p>',
      '<button class="btn" data-act="conflictCancel">取消</button>' +
      '<button class="btn" data-act="conflictLocal">用本地覆盖云端</button>' +
      '<button class="btn primary" data-act="conflictCloud">用云端覆盖本地</button>');
  });
}
function resolveConflict(choice) {
  var r = window.__conflictResolve; window.__conflictResolve = null;
  closeModal();
  if (r) r(choice);
}
function syncHooks() {
  return {
    settings: function () { return S.settings; },
    saveSetting: function (k, v) { return saveSetting(k, v); },
    collect: function (ts) { return syncCollect(ts); },
    apply: function (d) { return syncApply(d); },
    conflict: function (a, b) { return syncConflict(a, b); },
    toast: function (m) { toast(m); },
    refresh: function () { return loadAll().then(function () { refreshAll(); }); }
  };
}

/* ---------------- 弹窗 ---------------- */
function openModal(title, body, foot) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = body;
  $('modalFoot').innerHTML = foot || '<button class="btn" data-act="closeModal">关闭</button>';
  $('modal').classList.remove('hidden');
}
function closeModal() { $('modal').classList.add('hidden'); }
function wordForm(w) {
  w = w || {};
  var ex = (w.examples && w.examples[0]) || {};
  var opts = CATEGORIES.map(function (c) {
    return '<option value="' + c.id + '"' + (w.category === c.id ? ' selected' : '') + '>' + c.name + '</option>';
  }).join('');
  return '<div class="form"><div class="grid-form">' +
    '<label class="field"><span>单词 *</span><input id="fWord" value="' + esc(w.word || '') + '" placeholder="例如 curriculum"></label>' +
    '<label class="field"><span>音标</span><input id="fPh" value="' + esc(w.phonetic || '') + '" placeholder="/kəˈrɪkjələm/"></label>' +
    '<label class="field"><span>词性</span><input id="fPos" value="' + esc(w.pos || '') + '" placeholder="n. / v. / adj."></label>' +
    '<label class="field"><span>场景分类</span><select id="fCat">' + opts + '</select></label>' +
    '<label class="field"><span>中文释义 *</span><input id="fCn" value="' + esc(w.meaningCN || '') + '"></label>' +
    '<label class="field"><span>英文释义</span><input id="fEn" value="' + esc(w.meaningEN || '') + '"></label>' +
    '</div>' +
    '<label class="field"><span>例句（英文）</span><input id="fEx" value="' + esc(ex.en || '') + '"></label>' +
    '<label class="field"><span>例句（中文）</span><input id="fExCn" value="' + esc(ex.cn || '') + '"></label>' +
    '<div class="grid-form">' +
    '<label class="field"><span>标签（/ 分隔）</span><input id="fTags" value="' + esc((w.tags || []).join('/')) + '"></label>' +
    '<label class="field"><span>难度 1-3</span><input id="fDiff" type="number" min="1" max="3" value="' + (w.difficulty || 2) + '"></label>' +
    '</div>' +
    '<label class="field"><span>词根词缀</span><input id="fRoots" value="' + esc(w.roots || '') + '"></label>' +
    '<label class="field"><span>同义替换（; 分隔）</span><input id="fSyn" value="' + esc(w.synonyms || '') + '"></label>' +
    '<label class="field"><span>常见搭配（; 分隔）</span><input id="fCol" value="' + esc(w.collocations || '') + '"></label>' +
    '<label class="field"><span>雅思写作 / 口语关联</span><input id="fIelts" value="' + esc(w.ieltsUsage || '') + '"></label>' +
    '</div>';
}
function saveWordForm(id) {
  var word = ($('fWord').value || '').trim();
  var cn = ($('fCn').value || '').trim();
  if (!word || !cn) { toast('单词和中文释义必填'); return; }
  var w = id ? S.wordMap[id] : null;
  var isNew = !w;
  if (isNew) w = { id: uid('c'), custom: true, createdAt: Date.now(), audioUK: '', audioUS: '', examples: [] };
  w.word = word; w.phonetic = ($('fPh').value || '').trim(); w.pos = ($('fPos').value || '').trim();
  w.category = $('fCat').value; w.meaningCN = cn; w.meaningEN = ($('fEn').value || '').trim();
  var en = ($('fEx').value || '').trim();
  w.examples = en ? [{ en: en, cn: ($('fExCn').value || '').trim() }] : [];
  w.tags = ($('fTags').value || '').split('/').filter(Boolean);
  w.difficulty = clamp(parseInt($('fDiff').value, 10) || 2, 1, 3);
  w.roots = ($('fRoots').value || '').trim();
  w.synonyms = ($('fSyn').value || '').trim();
  w.collocations = ($('fCol').value || '').trim();
  w.ieltsUsage = ($('fIelts').value || '').trim();
  saveWord(w).then(function () {
    if (isNew) { S.words.push(w); S.wordMap[w.id] = w; }
    closeModal(); toast('已保存'); refreshAll();
  });
}

/* ---------------- 导入导出 ---------------- */
function exportAll() {
  var data = {
    app: 'ielts-vocab-workspace', version: 1, exportedAt: new Date().toISOString(),
    words: S.words, reviews: Object.keys(S.reviews).map(function (k) { return S.reviews[k]; }),
    checkins: Object.keys(S.checkins).map(function (k) { return S.checkins[k]; }),
    notebook: Object.keys(S.notebook).map(function (k) { return S.notebook[k]; }),
    settings: S.settings, quizStat: S.quizStat
  };
  download('ielts-backup-' + today() + '.json', JSON.stringify(data, null, 2), 'application/json');
  toast('已导出全部数据');
}
function exportWordsCSV() {
  var rows = [['word', 'phonetic', 'pos', 'meaningCN', 'meaningEN', 'exampleEN', 'exampleCN', 'category', 'tags', 'roots', 'synonyms', 'collocations', 'ieltsUsage', 'difficulty']];
  S.words.forEach(function (w) {
    rows.push([w.word, w.phonetic, w.pos, w.meaningCN, w.meaningEN,
      (w.examples && w.examples[0]) ? w.examples[0].en : '', (w.examples && w.examples[0]) ? w.examples[0].cn : '',
      w.category, (w.tags || []).join('/'), w.roots, w.synonyms, w.collocations, w.ieltsUsage, w.difficulty]);
  });
  download('ielts-words-' + today() + '.csv', '\ufeff' + toCSV(rows), 'text/csv');
}
function exportNbCSV() {
  var rows = [['word', 'pos', 'meaningCN', 'note', 'tags', 'addedBy', 'mastery', 'due', 'createdAt']];
  Object.keys(S.notebook).forEach(function (id) {
    var n = S.notebook[id], w = S.wordMap[id] || {}, r = S.reviews[id];
    rows.push([w.word || '', w.pos || '', w.meaningCN || '', n.note || '', (n.tags || []).join('/'), n.addedBy,
      r ? r.state : 'new', r && r.due ? new Date(r.due).toISOString() : '', n.createdAt ? new Date(n.createdAt).toISOString() : '']);
  });
  download('ielts-notebook-' + today() + '.csv', '\ufeff' + toCSV(rows), 'text/csv');
}
function exportNbJSON() {
  download('ielts-notebook-' + today() + '.json', JSON.stringify(Object.keys(S.notebook).map(function (k) { return S.notebook[k]; }), null, 2), 'application/json');
}
function importWordsCSV(text) {
  var rows = parseCSV(text);
  if (rows.length < 2) { toast('CSV 内容为空'); return; }
  var head = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var hasHead = head.indexOf('word') >= 0;
  var body = hasHead ? rows.slice(1) : rows;
  var idx = function (name, fallback) { var i = head.indexOf(name); return i >= 0 ? i : fallback; };
  var n = 0;
  /* 分批写入，避免大文件卡死页面 */
  var BATCH = 300, i0 = 0;
  function chunk() {
    var end = Math.min(body.length, i0 + BATCH);
    for (; i0 < end; i0++) makeOne(body[i0]);
    if (i0 < body.length) {
      toast('导入中… ' + i0 + '/' + body.length);
      setTimeout(chunk, 0);
    } else {
      if (n) markDirty();
      toast('已导入 ' + n + ' 个单词'); refreshAll();
    }
  }
  function makeOne(r) {
    var word = (r[idx('word', 0)] || '').trim();
    var cn = (r[idx('meaningcn', 3)] || '').trim();
    if (!word || !cn) return;
    var id = uid('c');
    var w = {
      id: id, word: word, phonetic: (r[idx('phonetic', 1)] || '').trim(), audioUK: '', audioUS: '',
      pos: (r[idx('pos', 2)] || '').trim(), meaningCN: cn, meaningEN: (r[idx('meaningen', 4)] || '').trim(),
      examples: [], category: (r[idx('category', 7)] || 'education').trim(),
      tags: (r[idx('tags', 8)] || '').split('/').filter(Boolean),
      roots: (r[idx('roots', 9)] || '').trim(), synonyms: (r[idx('synonyms', 10)] || '').trim(),
      collocations: (r[idx('collocations', 11)] || '').trim(), ieltsUsage: (r[idx('ieltsusage', 12)] || '').trim(),
      difficulty: clamp(parseInt(r[idx('difficulty', 13)], 10) || 2, 1, 3), custom: true, createdAt: Date.now()
    };
    var en = (r[idx('exampleen', 5)] || '').trim();
    if (en) w.examples.push({ en: en, cn: (r[idx('examplecn', 6)] || '').trim() });
    S.words.push(w); S.wordMap[w.id] = w; idbPut('words', w); n++;
  }
  chunk();
}
function importBackup(obj) {
  if (!obj || !obj.words) { toast('文件格式不正确'); return; }
  var ps = [idbClear('words'), idbClear('reviews'), idbClear('checkins'), idbClear('notebook')];
  Promise.all(ps).then(function () {
    var batch = [];
    obj.words.forEach(function (w) { batch.push(idbPut('words', w)); });
    (obj.reviews || []).forEach(function (r) { batch.push(idbPut('reviews', r)); });
    (obj.checkins || []).forEach(function (c) { batch.push(idbPut('checkins', c)); });
    (obj.notebook || []).forEach(function (n) { batch.push(idbPut('notebook', n)); });
    var sp = [];
    if (obj.settings) {
      Object.keys(obj.settings).forEach(function (k) { sp.push(idbPut('settings', { key: k, value: obj.settings[k] })); });
    }
    return Promise.all(batch.concat(sp));
  }).then(loadAll).then(function () {
    applyTheme(S.settings.theme || 'light');
    markDirty();
    toast('导入完成'); refreshAll();
  });
}
function resetProgress() {
  Promise.all([idbClear('reviews'), idbClear('checkins'), idbClear('notebook')]).then(function () {
    S.reviews = {}; S.checkins = {}; S.notebook = {}; S.queue = []; S.qi = 0;
    try { localStorage.removeItem(LS_QUEUE); } catch (e) { }
    markDirty();
    toast('学习进度已重置（词库保留）'); refreshAll();
  });
}

/* ---------------- 提醒 ---------------- */
function startReminder() {
  setInterval(function () {
    if (!S.settings.reminderOn) return;
    var d = new Date(), cur = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (cur !== S.settings.reminderTime) return;
    var k = 'wb_ielts_remind_' + today();
    try { if (localStorage.getItem(k)) return; localStorage.setItem(k, '1'); } catch (e) { }
    var left = Math.max(0, goalN() - todayDone());
    var msg = left > 0 ? ('该背单词了，今天还剩 ' + left + ' 词') : '今天的单词任务已完成，很棒！';
    toast(msg);
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification('雅思单词工作台', { body: msg }); } catch (e) { }
    }
  }, 30000);
}

/* ---------------- 事件绑定 ---------------- */
function bindStatic() {
  var nav = $('nav');
  if (nav) nav.addEventListener('click', function (e) {
    var b = e.target.closest('.nav-btn'); if (!b) return;
    setView(b.getAttribute('data-view'));
  });
  var th = $('themeBtn');
  if (th) th.addEventListener('click', function () {
    var t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    S.settings.theme = t; applyTheme(t); idbPut('settings', { key: 'theme', value: t });
  });
  var st = $('setTheme');
  if (st) st.addEventListener('change', function () {
    S.settings.theme = st.value; applyTheme(st.value); idbPut('settings', { key: 'theme', value: st.value });
  });
  var vs = document.getElementById('view-settings');
  if (vs) vs.addEventListener('change', function () { saveSettingsFromForm(); });
  var save = $('setSave'); if (save) save.addEventListener('click', saveSettingsFromForm);

  /* —— 云同步按钮 —— */
  var bs = $('btnSyncSave'); if (bs) bs.addEventListener('click', function () { saveSyncForm(); });
  var bp = $('btnPush'); if (bp) bp.addEventListener('click', function () {
    if (!window.IELTS_SYNC) return;
    saveSyncForm().then(function () { return window.IELTS_SYNC.push(); }).then(function (ok) { if (ok) toast('已上传到云端'); });
  });
  var bl = $('btnPull'); if (bl) bl.addEventListener('click', function () {
    if (!window.IELTS_SYNC) return;
    saveSyncForm().then(function () { return window.IELTS_SYNC.pull(); }).then(function (ok) { if (ok) toast('已从云端拉取'); });
  });
  var bm = $('btnMagic'); if (bm) bm.addEventListener('click', function () {
    var e = ($('setSyncEmail') && $('setSyncEmail').value || '').trim();
    if (!e) { toast('请先填写邮箱'); return; }
    S.settings.syncEmail = e; idbPut('settings', { key: 'syncEmail', value: e });
    window.IELTS_SYNC.sendMagic(e);
  });
  var bo = $('btnLogout'); if (bo) bo.addEventListener('click', function () { if (window.IELTS_SYNC) window.IELTS_SYNC.logout(); });
  var sm = $('setSyncMode'); if (sm) sm.addEventListener('change', function () { renderSync(); });

  var nbS = $('nbSearch'); if (nbS) nbS.addEventListener('input', function () { S.nbQuery = nbS.value; renderNotebook(); });
  var nbT = $('nbTag'); if (nbT) nbT.addEventListener('change', function () { S.nbTag = nbT.value; renderNotebook(); });
  var nbO = $('nbSort'); if (nbO) nbO.addEventListener('change', function () { S.nbSort = nbO.value; renderNotebook(); });
  var bkS = $('bankSearch'); if (bkS) bkS.addEventListener('input', function () { S.bankQuery = bkS.value; S.bankLimit = 80; renderBank(); });
  var bkM = $('bankMastery'); if (bkM) bkM.addEventListener('change', function () { S.bankMastery = bkM.value; renderBank(); });

  var nbC = $('nbExportCsv'); if (nbC) nbC.addEventListener('click', exportNbCSV);
  var nbJ = $('nbExportJson'); if (nbJ) nbJ.addEventListener('click', exportNbJSON);
  var bAdd = $('bankAdd'); if (bAdd) bAdd.addEventListener('click', function () {
    openModal('添加单词', wordForm(null), '<button class="btn" data-act="closeModal">取消</button><button class="btn primary" data-act="saveWordForm">保存</button>');
  });
  var bEj = $('bankExportJson'); if (bEj) bEj.addEventListener('click', exportAll);
  var bEc = $('bankExportCsv'); if (bEc) bEc.addEventListener('click', exportWordsCSV);
  var bImp = $('bankImport'); if (bImp) bImp.addEventListener('click', function () { $('impFile').click(); });
  var ea = $('expAll'); if (ea) ea.addEventListener('click', exportAll);
  var ew = $('expWordsCsv'); if (ew) ew.addEventListener('click', exportWordsCSV);
  var ib = $('impBtn'); if (ib) ib.addEventListener('click', function () { $('impFile').click(); });
  var rs = $('resetBtn');
  if (rs) rs.addEventListener('click', function () {
    openModal('重置学习进度', '<div class="notice danger">这会清空所有复习记录、打卡记录和生词本，词库会保留。此操作不可撤销。</div>' +
      '<label class="field"><span>请输入「重置」以确认</span><input id="resetConfirm" placeholder="重置"></label>',
      '<button class="btn" data-act="closeModal">取消</button><button class="btn danger" data-act="doReset">确认重置</button>');
  });
  var imp = $('impFile');
  if (imp) imp.addEventListener('change', function () {
    var f = imp.files && imp.files[0]; if (!f) return;
    var fr = new FileReader();
    fr.onload = function () {
      var text = String(fr.result || '');
      if (/\.csv$/i.test(f.name)) { importWordsCSV(text); }
      else {
        var obj; try { obj = JSON.parse(text); } catch (e) { toast('JSON 解析失败'); return; }
        openModal('导入备份', '<div class="notice">将用备份覆盖当前全部数据（词库、复习记录、打卡、生词本、设置）。<br>备份时间：' + esc(obj.exportedAt || '未知') + '<br>单词数：' + ((obj.words || []).length) + '</div>',
          '<button class="btn" data-act="closeModal">取消</button><button class="btn primary" data-act="doImport">覆盖导入</button>');
        window.__pendingImport = obj;
      }
      imp.value = '';
    };
    fr.readAsText(f, 'utf-8');
  });
  var mc = $('modalClose'); if (mc) mc.addEventListener('click', closeModal);
  var mm = $('modal');
  if (mm) mm.addEventListener('click', function (e) { if (e.target === mm) closeModal(); });

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]'); if (!t) return;
    var act = t.getAttribute('data-act'), id = t.getAttribute('data-id');
    switch (act) {
      case 'goStudy': S.studyMode = 'learn'; setView('study'); break;
      case 'goQuiz': S.studyMode = 'quiz'; setView('study'); break;
      case 'goNbStudy': S.studyMode = 'nb'; setView('study'); break;
      case 'goLearn': S.studyMode = 'learn'; refreshAll(); break;
      case 'mode': S.studyMode = t.getAttribute('data-mode') || 'learn'; S.revealed = false; refreshAll(); break;
      case 'reveal': S.revealed = true; refreshAll(); break;
      case 'rate': rate(parseInt(t.getAttribute('data-g'), 10)); break;
      case 'speak': { var w = S.wordMap[id]; if (w) speak(w, t.getAttribute('data-lang')); break; }
      case 'toggleNb':
        if (S.notebook[id]) { delete S.notebook[id]; idbDel('notebook', id); markDirty(); toast('已移出生词本'); }
        else { addNotebook(id, 'manual'); toast('已加入生词本'); }
        refreshAll(); break;
      case 'removeNb': delete S.notebook[id]; idbDel('notebook', id); markDirty(); refreshAll(); break;
      case 'nbTagEdit': {
        var n = S.notebook[id]; if (!n) break;
        openModal('编辑标签', '<label class="field"><span>标签（用 / 分隔）</span><input id="tagInput" value="' + esc((n.tags || []).join('/')) + '" placeholder="易混/写作/听力"></label>',
          '<button class="btn" data-act="closeModal">取消</button><button class="btn primary" data-act="saveTag" data-id="' + id + '">保存</button>');
        break;
      }
      case 'saveTag': {
        var nn = S.notebook[t.getAttribute('data-id')];
        if (nn && $('tagInput')) { nn.tags = ($('tagInput').value || '').split('/').filter(Boolean); saveNote(nn); }
        closeModal(); refreshAll(); break;
      }
      case 'extra10':
        buildQueue(newCandidates().slice(0, 10).map(function (w) { return { id: w.id, type: 'new' }; }));
        S.studyMode = 'learn'; S.nbOn = false; S.qi = 0; setView('study'); toast('已加入 10 个新词'); break;
      case 'quizStart': buildQuiz(10); refreshAll(); break;
      case 'quizPick': quizPick(parseInt(t.getAttribute('data-i'), 10)); break;
      case 'quizNext': quizNext(); break;
      case 'cat': S.bankCat = t.getAttribute('data-cat'); S.bankLimit = 80; renderBank(); break;
      case 'bankMore': S.bankLimit = (S.bankLimit || 80) + 80; renderBank(); break;
      case 'editWord': {
        var ww = S.wordMap[id]; if (!ww) break;
        openModal('编辑单词', wordForm(ww), '<button class="btn" data-act="closeModal">取消</button><button class="btn primary" data-act="saveWordForm" data-id="' + id + '">保存</button>');
        break;
      }
      case 'saveWordForm': saveWordForm(t.getAttribute('data-id') || null); break;
      case 'delWord': {
        var dw = S.wordMap[id]; if (!dw) break;
        openModal('删除单词', '<div class="notice danger">确定删除「' + esc(dw.word) + '」？相关复习记录和生词本条目也会移除。</div>',
          '<button class="btn" data-act="closeModal">取消</button><button class="btn danger" data-act="doDelWord" data-id="' + id + '">删除</button>');
        break;
      }
      case 'doDelWord': {
        var did = t.getAttribute('data-id');
        delete S.wordMap[did];
        S.words = S.words.filter(function (x) { return x.id !== did; });
        delete S.reviews[did]; delete S.notebook[did];
        idbDel('words', did); idbDel('reviews', did); idbDel('notebook', did); markDirty();
        closeModal(); refreshAll(); break;
      }
      case 'lookup': {
        var lw = S.wordMap[id]; if (!lw) break;
        toast('正在获取…');
        lookupAny(lw).then(function (p) { applyLookup(lw, p); });
        break;
      }
      case 'openMakeup': {
        var days = [], i;
        for (i = 1; i <= 7; i++) {
          var k = dayOffset(-i), ck = S.checkins[k];
          days.push('<div class="item"><div class="item-head"><div class="item-word">' + k + '</div>' +
            (ck && ck.completed ? '<span class="tag ok">已打卡</span>' : '<span class="tag warn">未打卡</span>') + '</div>' +
            '<div class="muted small">当日完成 ' + (ck ? (ck.newCount + ck.reviewCount) : 0) + ' 词</div>' +
            (ck && ck.completed ? '' : '<div class="item-actions"><button class="btn sm primary" data-act="doMakeup" data-date="' + k + '">补卡</button></div>') +
            '</div>');
        }
        openModal('补卡（最近 7 天）', '<div class="list">' + days.join('') + '</div><p class="muted small" style="margin-top:10px">补卡只补齐打卡记录，不改变单词的复习安排。</p>',
          '<button class="btn" data-act="closeModal">关闭</button>');
        break;
      }
      case 'doMakeup': {
        var dk = t.getAttribute('data-date'), ck2 = getCheckin(dk);
        ck2.completed = true;
        S.checkins[dk] = ck2; saveCheckin(ck2);
        closeModal(); toast(dk + ' 已补卡'); refreshAll();
        break;
      }
      case 'closeModal': closeModal(); break;
      case 'doReset': {
        var v = ($('resetConfirm') && $('resetConfirm').value || '').trim();
        if (v !== '重置') { toast('请输入「重置」'); break; }
        closeModal(); resetProgress(); break;
      }
      case 'doImport': {
        var obj = window.__pendingImport; window.__pendingImport = null;
        closeModal(); if (obj) importBackup(obj);
        break;
      }
      case 'conflictCloud': resolveConflict('cloud'); break;
      case 'conflictLocal': resolveConflict('local'); break;
      case 'conflictCancel': resolveConflict('cancel'); break;
    }
  });

  document.addEventListener('input', function (e) {
    var ta = e.target.closest('.note-ta'); if (!ta) return;
    var id = ta.getAttribute('data-id'), n = S.notebook[id]; if (!n) return;
    n.note = ta.value;
    clearTimeout(ta._tm);
    ta._tm = setTimeout(function () { saveNote(n); }, 600);
  });

  document.addEventListener('keydown', function (e) {
    if (S.view !== 'study' || !$('modal') || !$('modal').classList.contains('hidden')) return;
    var ae = document.activeElement;
    if (ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return;
    if (S.studyMode !== 'learn') return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!S.revealed) { S.revealed = true; refreshAll(); }
      return;
    }
    if (/^[1-4]$/.test(e.key) && S.revealed) rate(parseInt(e.key, 10));
  });
}

/* ---------------- 启动 ---------------- */
function init() {
  applyTheme(S.settings.theme || 'light');
  loadQuizStat();
  if ('speechSynthesis' in window) { try { window.speechSynthesis.getVoices(); } catch (e) { } }
  bindStatic();
  setView('dash');
  startReminder();
  if (window.IELTS_SYNC) {
    window.IELTS_SYNC.init(syncHooks());
    /* 魔法链接回调后清理 URL 上的 token */
    if (location.hash && /access_token|refresh_token|type=/.test(location.hash)) {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
    }
  }
}
document.addEventListener('DOMContentLoaded', function () {
  openDB().then(loadAll).then(seedWords).then(loadAll).then(init).catch(function (e) {
    var m = $('main');
    if (m) m.innerHTML = '<div class="card"><h3>初始化失败</h3><p class="muted small">' + esc((e && e.message) || String(e)) +
      '</p><p class="muted small">请确认浏览器支持 IndexedDB（不要用「无痕模式 + 禁用存储」的环境），或换 Chrome / Edge 打开本文件。</p></div>';
  });
});

})();
