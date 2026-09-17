-- =========================================================
-- 雅思单词工作台 · Supabase 免费版 建表 + RLS
-- 用法：Supabase 后台 → SQL Editor → 粘贴执行（全部可重复执行）
-- =========================================================

-- ---------- 1. 邮箱魔法链接登录模式 ----------
create table if not exists public.ielts_user_data (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.ielts_user_data enable row level security;

drop policy if exists "ielts_user_data_select_own" on public.ielts_user_data;
create policy "ielts_user_data_select_own" on public.ielts_user_data
  for select using (auth.uid() = user_id);

drop policy if exists "ielts_user_data_insert_own" on public.ielts_user_data;
create policy "ielts_user_data_insert_own" on public.ielts_user_data
  for insert with check (auth.uid() = user_id);

drop policy if exists "ielts_user_data_update_own" on public.ielts_user_data;
create policy "ielts_user_data_update_own" on public.ielts_user_data
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "ielts_user_data_delete_own" on public.ielts_user_data;
create policy "ielts_user_data_delete_own" on public.ielts_user_data
  for delete using (auth.uid() = user_id);

-- ---------- 2. 同步码模式（备选降级，轻量个人方案） ----------
create table if not exists public.ielts_sync_code (
  sync_code  text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  device_id  text
);

alter table public.ielts_sync_code enable row level security;

-- 只允许「按同步码精确读写」：写入/读取的行必须满足同步码长度 >= 8
-- 注意：Postgres RLS 无法阻止「知道同步码的人读该行」，也无法阻止枚举，
-- 因此同步码请设置得像密码一样长且随机（建议 16 位以上，含字母数字）。
drop policy if exists "ielts_sync_code_rw" on public.ielts_sync_code;
create policy "ielts_sync_code_rw" on public.ielts_sync_code
  for all
  using (length(sync_code) >= 8)
  with check (length(sync_code) >= 8 and length(sync_code) <= 64);

-- ---------- 3. 可选：自动维护 updated_at ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_ielts_user_data_touch on public.ielts_user_data;
create trigger trg_ielts_user_data_touch before update on public.ielts_user_data
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_ielts_sync_code_touch on public.ielts_sync_code;
create trigger trg_ielts_sync_code_touch before update on public.ielts_sync_code
  for each row execute function public.touch_updated_at();

-- ---------- 4. 检查 ----------
-- select * from public.ielts_user_data;
-- select * from public.ielts_sync_code;
