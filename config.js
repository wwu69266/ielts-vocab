/* =========================================================
 * config.js — 可选的默认云同步配置
 * 把 Supabase 的 Project URL 与 anon key 填在这里，
 * 所有设备打开页面即自带配置（设置页仍可覆盖）。
 * 不填则完全离线使用，页面不会加载任何云端 SDK。
 * ========================================================= */
window.IELTS_DEFAULT_CONFIG = {
  sbUrl: '',   // 例如 https://abcdefgh.supabase.co
  sbKey: ''    // anon public key（本来就允许放在前端，安全靠 RLS）
};
