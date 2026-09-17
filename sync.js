/* =========================================================
 * sync.js — Supabase 云同步（邮箱魔法链接 / 同步码 两种模式）
 * 依赖：@supabase/supabase-js v2（运行时从 CDN 动态加载，未配置则不加载）
 * 对外接口：window.IELTS_SYNC
 *    init(hooks)  markDirty()  push()  pull()  sync()  paint()  state
 * hooks 由 app.js 注入：collect / apply / conflict / toast / refresh / settings
 * ========================================================= */
window.IELTS_SYNC = (function () {
  var CDN = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
    'https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.min.js'
  ];
  var H = null;                 // app.js 注入的钩子
  var client = null;            // supabase client
  var loading = null;           // 脚本加载 Promise
  var timer = null, loopTimer = null;

  var state = {
    mode: 'off',                // off | email | code
    status: 'off',              // off | idle | dirty | syncing | ok | error | needlogin | noconf
    msg: '',
    lastSyncAt: 0,
    cloudAt: 0,
    user: null,
    online: navigator.onLine !== false
  };

  function now() { return Date.now(); }
  function fmt(ts) {
    if (!ts) return '—';
    var d = new Date(ts), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function toast(m) { if (H && H.toast) H.toast(m); }
  function cfg() {
    var s = (H && H.settings) ? H.settings() : {};
    var d = window.IELTS_DEFAULT_CONFIG || {};
    if (!s.sbUrl && d.sbUrl) { s = Object.assign({}, s, { sbUrl: d.sbUrl, sbKey: d.sbKey }); }
    return s;
  }
  function save(k, v) { if (H && H.saveSetting) return H.saveSetting(k, v); }
  function setStatus(s, m) { state.status = s; state.msg = m || ''; paint(); }
  function touch() { state.lastSyncAt = now(); if (H && H.saveSetting) { try { H.saveSetting('lastSyncAt', state.lastSyncAt); } catch (e) { } } }

  /* ---------- 加载 supabase-js ---------- */
  function loadScript(i) {
    i = i || 0;
    if (window.supabase && window.supabase.createClient) return Promise.resolve();
    if (i >= CDN.length) return Promise.reject(new Error('Supabase SDK 加载失败（网络被拦截？）'));
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = CDN[i]; s.async = true;
      s.onload = function () { window.supabase && window.supabase.createClient ? res() : rej(new Error('SDK 内容异常')); };
      s.onerror = function () { rej(new Error('加载失败')); };
      document.head.appendChild(s);
    }).catch(function () { return loadScript(i + 1); });
  }
  function ensureClient() {
    var c = cfg();
    if (!c.sbUrl || !c.sbKey) return Promise.reject(new Error('未配置 Supabase URL / anon key'));
    if (client) return Promise.resolve(client);
    if (!loading) loading = loadScript(0);
    return loading.then(function () {
      var opts = { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } };
      client = window.supabase.createClient(String(c.sbUrl).trim(), String(c.sbKey).trim(), opts);
      try {
        client.auth.onAuthStateChange(function (ev, sess) {
          state.user = (sess && sess.user) || null;
          if (ev === 'SIGNED_IN') { toast('登录成功，正在同步…'); sync(true); }
          if (ev === 'SIGNED_OUT') { setStatus('idle', '已退出登录'); }
          paint();
        });
      } catch (e) { }
      return client;
    });
  }

  /* ---------- 行定位 ---------- */
  function myKey(c) {
    // 返回 {table, match}
    if (state.mode === 'email') {
      var u = state.user;
      if (!u) return null;
      return { table: 'ielts_user_data', match: { user_id: u.id } };
    }
    var code = (c.syncCode || '').trim();
    if (code.length < 8) return null;
    return { table: 'ielts_sync_code', match: { sync_code: code } };
  }
  function deviceId() {
    try {
      var k = 'wb_ielts_device';
      var v = localStorage.getItem(k);
      if (!v) { v = 'd' + Math.random().toString(36).slice(2, 10); localStorage.setItem(k, v); }
      return v;
    } catch (e) { return 'd' + Math.random().toString(36).slice(2, 10); }
  }

  /* ---------- 读云端 ---------- */
  function readCloud() {
    var c = cfg();
    return ensureClient().then(function (sb) {
      var loc = myKey(c);
      if (!loc) {
        if (state.mode === 'email') { setStatus('needlogin', '请先登录'); return null; }
        setStatus('error', '同步码至少 8 位'); return null;
      }
      var q = sb.from(loc.table).select('*');
      for (var k in loc.match) q = q.eq(k, loc.match[k]);
      return q.maybeSingle().then(function (r) {
        if (r.error) throw new Error(r.error.message || '读取失败');
        return r.data;
      });
    });
  }
  /* ---------- 写云端 ---------- */
  function writeCloud(payload, ts) {
    var c = cfg();
    return ensureClient().then(function (sb) {
      var loc = myKey(c);
      if (!loc) {
        if (state.mode === 'email') { setStatus('needlogin', '请先登录'); return false; }
        setStatus('error', '同步码至少 8 位'); return false;
      }
      var row = { data: payload, updated_at: new Date(ts).toISOString() };
      for (var k in loc.match) row[k] = loc.match[k];
      if (loc.table === 'ielts_sync_code') row.device_id = deviceId();
      return sb.from(loc.table).upsert(row, { onConflict: Object.keys(loc.match)[0] }).then(function (r) {
        if (r.error) throw new Error(r.error.message || '写入失败');
        state.cloudAt = ts; touch();
        setStatus('ok', '已上传');
        return true;
      });
    });
  }

  /* ---------- 对外操作 ---------- */
  function markDirty() {
    var c = cfg();
    state.mode = c.syncMode || 'off';
    if (state.mode === 'off') { paint(); return; }
    setStatus('dirty', '有改动待同步');
    if (c.autoSync === false) { paint(); return; }
    clearTimeout(timer);
    timer = setTimeout(function () { push(); }, 2000);
  }
  function push() {
    var c = cfg();
    state.mode = c.syncMode || 'off';
    if (state.mode === 'off') { setStatus('off', '未开启云同步'); return Promise.resolve(false); }
    if (!state.online) { setStatus('error', '离线，稍后自动重试'); return Promise.resolve(false); }
    setStatus('syncing', '上传中…');
    var ts = Date.now();
    var payload = H.collect(ts);
    return writeCloud(payload, ts).catch(function (e) {
      setStatus('error', '上传失败：' + e.message);
      return false;
    });
  }
  function pull() {
    var c = cfg();
    state.mode = c.syncMode || 'off';
    if (state.mode === 'off') { setStatus('off', '未开启云同步'); return Promise.resolve(false); }
    if (!state.online) { setStatus('error', '离线，稍后自动重试'); return Promise.resolve(false); }
    setStatus('syncing', '下载中…');
    return readCloud().then(function (row) {
      if (row === null) return false;
      if (!row) {
        // 云端无数据 → 把本地传上去
        setStatus('idle', '云端暂无数据，自动上传本地');
        return push();
      }
      var cloudAt = row.updated_at ? Date.parse(row.updated_at) : 0;
      var localAt = c.dataUpdatedAt || 0;
      state.cloudAt = cloudAt;
      if (cloudAt > localAt + 1500) {
        // 冲突：云端更新
        if (localAt === 0) { return applyCloud(row.data, cloudAt); }
        return H.conflict(localAt, cloudAt).then(function (choice) {
          if (choice === 'cloud') return applyCloud(row.data, cloudAt);
          if (choice === 'local') return push();
          setStatus('idle', '已取消，本地与云端均未改动');
          return false;
        });
      }
      if (localAt > cloudAt + 1500) {
        setStatus('idle', '本地更新，自动上传');
        return push();
      }
      touch();
      setStatus('ok', '两端已一致');
      return true;
    }).catch(function (e) {
      setStatus('error', '下载失败：' + e.message);
      return false;
    });
  }
  function applyCloud(data, cloudAt) {
    return Promise.resolve(H.apply(data)).then(function () {
      save('dataUpdatedAt', cloudAt);
      touch();
      setStatus('ok', '已用云端数据覆盖本地');
      if (H.refresh) H.refresh();
      return true;
    }).catch(function (e) {
      setStatus('error', '应用云端数据失败：' + e.message);
      return false;
    });
  }
  function sync(silent) {
    var c = cfg();
    state.mode = c.syncMode || 'off';
    if (state.mode === 'off') { setStatus('off', '未开启云同步'); return Promise.resolve(false); }
    if (!c.sbUrl || !c.sbKey) { setStatus('noconf', '请先填写 Supabase URL 与 anon key'); return Promise.resolve(false); }
    if (state.mode === 'email' && !state.user) {
      return ensureClient().then(function (sb) {
        return sb.auth.getSession().then(function (r) {
          state.user = (r.data && r.data.session && r.data.session.user) || null;
          paint();
          if (!state.user) { setStatus('needlogin', '请先登录邮箱'); return false; }
          return pull();
        });
      }).catch(function (e) { setStatus('error', e.message); return false; });
    }
    return pull();
  }

  /* ---------- 登录 ---------- */
  function sendMagic(email) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('邮箱格式不正确'); return Promise.resolve(false); }
    return ensureClient().then(function (sb) {
      return sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.href.split('#')[0] } });
    }).then(function (r) {
      if (r.error) throw new Error(r.error.message || '发送失败');
      toast('魔法链接已发送，请到邮箱点击链接（可能需查看垃圾邮件）');
      setStatus('needlogin', '等待邮箱确认…');
      return true;
    }).catch(function (e) { toast('登录失败：' + e.message); setStatus('error', e.message); return false; });
  }
  function logout() {
    if (!client) { state.user = null; setStatus('idle', '已退出'); return Promise.resolve(); }
    return client.auth.signOut().then(function () {
      state.user = null; setStatus('idle', '已退出登录');
    }).catch(function (e) { toast('退出失败：' + e.message); });
  }

  /* ---------- 状态渲染 ---------- */
  var TXT = {
    off: '未开启', idle: '待同步', dirty: '有改动', syncing: '同步中',
    ok: '已同步', error: '异常', needlogin: '需登录', noconf: '未配置'
  };
  function paint() {
    var c = cfg();
    state.mode = c.syncMode || 'off';
    var el = document.getElementById('syncStatus');
    if (el) {
      var color = state.status === 'ok' ? 'ok' : (state.status === 'error' ? 'danger' : (state.status === 'syncing' ? 'cat' : 'warn'));
      el.innerHTML = '<span class="tag ' + color + '">' + (TXT[state.status] || state.status) + '</span>' +
        (state.msg ? ' <span class="muted small">' + esc(state.msg) + '</span>' : '');
    }
    var l = document.getElementById('syncLast');
    if (l) l.textContent = state.lastSyncAt ? fmt(state.lastSyncAt) : '—';
    var cl = document.getElementById('syncCloudAt');
    if (cl) cl.textContent = state.cloudAt ? fmt(state.cloudAt) : '—';
    var u = document.getElementById('syncUser');
    if (u) u.textContent = state.user ? (state.user.email || state.user.id) : (state.mode === 'email' ? '未登录' : '同步码模式');
    var chip = document.getElementById('syncChip');
    if (chip) {
      chip.className = 'chip' + (state.status === 'ok' ? ' ok' :
        (state.status === 'error' ? ' danger' : (state.status === 'off' ? ' muted' : ' warn')));
      chip.innerHTML = svgCloud() + '<span>' + (state.mode === 'off' ? '云同步未开启' : (TXT[state.status] || '')) + '</span>';
      chip.title = '云同步状态' + (state.msg ? '：' + state.msg : '');
    }
  }
  function svgCloud() {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><path d="M18 17a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.3 10.2A3.5 3.5 0 0 0 7 17z"/></svg>';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  /* ---------- 自动循环 & 网络 ---------- */
  function startLoop() {
    clearInterval(loopTimer);
    loopTimer = setInterval(function () {
      var c = cfg();
      if ((c.syncMode || 'off') === 'off' || c.autoSync === false) return;
      if (document.hidden) return;
      if (now() - state.lastSyncAt < 25000) return;
      sync(true);
    }, 30000);
    window.addEventListener('online', function () { state.online = true; paint(); sync(true); });
    window.addEventListener('offline', function () { state.online = false; setStatus('error', '已离线，联网后自动同步'); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && cfg().autoSync !== false && (cfg().syncMode || 'off') !== 'off') {
        if (now() - state.lastSyncAt > 15000) sync(true);
      }
    });
  }

  function init(hooks) {
    H = hooks;
    var c = cfg();
    state.mode = c.syncMode || 'off';
    state.lastSyncAt = c.lastSyncAt || 0;
    startLoop();
    paint();
    if (state.mode !== 'off' && c.sbUrl && c.sbKey) {
      setTimeout(function () { sync(true); }, 800);
    }
  }

  return {
    init: init, markDirty: markDirty, push: push, pull: pull, sync: sync,
    sendMagic: sendMagic, logout: logout, paint: paint, state: state,
    resetClient: function () { client = null; loading = null; }
  };
})();
