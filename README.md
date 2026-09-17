# 雅思单词工作台（IELTS Vocab Workbench）

纯前端单页应用：**HTML + CSS + 原生 JS，零构建、零依赖**。数据默认存本机 IndexedDB；可选接 Supabase 免费版实现**电脑 / 手机自动同步**。

在线地址：https://wwu69266.github.io/ielts-vocab/

> **数据备份（很重要）**：所有学习数据只存在你本机浏览器的 IndexedDB，**不上传任何服务器**。清缓存、换设备、重装浏览器前，务必先点「仪表盘顶部的『备份数据』按钮」或「设置 → 导出全部数据（JSON）」；新设备用「导入备份」恢复。详见第六节。

---

## 一、功能

| 模块 | 说明 |
|---|---|
| 仪表盘 | 今日进度环、打卡状态、连续天数、全年学习热力图、每日一句、快捷开始 |
| 学习 | 单词卡片（音标/发音/词性/中英释义/例句/词根词缀/同义替换/常见搭配/雅思写作口语关联）+ 四档评分（忘记 / 模糊 / 认识 / 简单）+ 随机测验 + 生词本复习 |
| 生词本 | 搜索、标签、笔记、移除、导出 CSV/JSON，答错自动收录，参与复习排队 |
| 词库 | 20 个雅思场景分类、搜索、按掌握度筛选、手动添加、CSV/JSON 导入导出（分批导入不卡死） |
| 统计 | 掌握度分布、近 14 天新学/复习量、近 30 天正确率、打卡日历、全年热力图 |
| 设置 | 每日目标（默认 60）、主题白/黑、每日提醒时间、补卡开关、词典 API、导入导出、重置进度、**云同步** |

记忆算法：**简化版 FSRS**（三参数 S 稳定性 / D 难度 / R 可提取性，`R(t)=(1+19/81·t/S)^-0.5`）。间隔 ≥ 21 天且复习 ≥ 3 次判为「已掌握」。每天先复习到期词（昨天没做完自动顺延并标红），再补新词，凑满目标即打卡。

---

## 二、本地运行

```bash
# 任意静态服务器均可，例如
python -m http.server 8000
# 然后浏览器打开 http://localhost:8000
```

也可以直接双击 `index.html`（file:// 协议下部分浏览器的 IndexedDB 受限，推荐用上面的方式）。

---

## 三、部署到 GitHub Pages（已部署）

1. `git init -b main`
2. `gh repo create ielts-vocab --public`
3. `git add . && git commit -m "..." && git push -u origin main`
4. `gh api -X POST repos/wwu69266/ielts-vocab/pages -f source[branch]=main -f source[path]=/`

Pages 生效后地址：`https://wwu69266.github.io/ielts-vocab/`。所有资源都用相对路径，子路径部署无需改代码。

---

## 四、云同步（Supabase 免费版）

### 1. 建项目（约 2 分钟）
1. 打开 https://supabase.com → Sign in with GitHub → New project（Region 选 Singapore/Tokyo，免费层即可）。
2. 左侧 **SQL Editor** → 粘贴执行 `supabase.sql`（建两张表 + RLS 策略）。
3. 左侧 **Project Settings → API** → 复制 **Project URL** 和 **anon public key**。
4. （邮箱登录模式需要）**Authentication → URL Configuration** → Site URL 填 `https://wwu69266.github.io/ielts-vocab/`，Redirect URLs 加同一地址。

### 2. 在网页里配置
设置页 → 「云同步」卡片：
- 同步模式：`邮箱魔法链接登录` 或 `同步码`
- 填 Project URL / anon key
- 邮箱模式：填邮箱 → 点「发送魔法链接」→ 去邮箱点链接（可能要翻垃圾邮件）→ 回到页面自动登录同步
- 同步码模式：两台设备填**同一个 ≥8 位的同步码**
- 打开「自动同步」，点「立即上传 / 立即下载」验证

两端用同一个邮箱（或同一个同步码）即可看到相同进度。

### 3. 同步规则
- 内容：复习进度、打卡记录、生词本、设置、自定义单词（**内置词库不上传**）。
- 时机：数据变更后 2 秒上传；启动时、每 30 秒、页面重新可见时拉取。
- 冲突：比较 `updated_at`，云端更新则弹窗让你选「用云端覆盖本地」或「用本地覆盖云端」。
- 离线优先：断网照常学习，联网后自动补传；失败只显示状态，不会白屏。

---

## 五、安全注意事项

- `anon key` 是**设计为可公开**的前端密钥，真正的安全边界是 **RLS**：`ielts_user_data` 只允许 `auth.uid() = user_id` 的行读写；请确认两张表都 `enable row level security`（`supabase.sql` 已做）。
- **同步码模式是轻量个人方案**：Postgres RLS 无法阻止他人枚举，知道同步码的人就能读写那份数据。请设置 16 位以上、字母数字混合的随机码，不要用生日/手机号，不要分享给他人。
- 页面部署后是公网可访问的，但**学习数据只存在你自己的浏览器 + 你的 Supabase 项目里**，不会进任何第三方服务器。
- 页面不预填任何真实隐私数据；导出 JSON 里含你的学习记录，自行保管。
- 换设备 / 清缓存前，先「导出全部数据（JSON）」做本地备份。

---

## 六、词库

- 内置 20 个雅思场景分类（教育、环境、科技、健康、工作、旅游、文化、社会、法律、媒体、经济、政府、犯罪、交通、城市、乡村、艺术、体育、家庭、食物），每类 75+ 词，合计 1500+。
- 字段：单词 / 音标 / 英音美音发音 / 词性 / 中文释义 / 英文释义 / 例句+中译 / 场景 / 标签 / 词根词缀 / 同义替换 / 常见搭配 / 雅思写作口语关联 / 难度 / 掌握度。
- 数据来源：
  - 中文释义、音标、词性：**ECDICT** 开源英汉词典（MIT）；
  - 例句：**Tatoeba** 开源双语例句（CC BY 2.0 FR）与 **Datamuse** 语料例句接口；
  - 同义替换、常见搭配：**Datamuse** 免费接口；
  - 词根词缀：ECDICT `wordroot.txt`；
  - 手工编写的 200 条核心词条在 `data.js`，自动生成的大词库在 `data-ext.js`。
  - **不抓取牛津/剑桥等受版权保护的词典网页**。牛津/剑桥官方 API key 可在设置页填写（留空则用免费接口 + 内置数据）。
- 发音：优先词典音频；没有则降级为浏览器 Web Speech API 语音合成。
- 在线补全：词库页每个词都有「在线补全」，用免费词典接口补音标/音频/例句，接口失败自动降级。

### 导入自己的词库
设置页 / 词库页 → 导入 → CSV 或 JSON。CSV 模板见 `templates/words-template.csv`，列名：

```
word,phonetic,pos,meaningCN,meaningEN,exampleEN,exampleCN,category,tags,roots,synonyms,collocations,ieltsUsage,difficulty
```

只有 `word` 和 `meaningCN` 必填。大文件会按 300 条一批写入并显示进度，不会卡死页面。

---

## 七、目录结构

```
index.html      页面结构
style.css       样式（白/黑主题）
data.js         手工编写的核心 200 词 + 每日一句
data-ext.js     自动生成的扩展词库（1300+ 词）
sync.js         Supabase 云同步模块（运行时按需加载 SDK，未配置不加载）
app.js          业务逻辑：间隔重复、打卡、生词本、统计、导入导出
supabase.sql    云端建表 + RLS 策略
templates/      词库导入模板
```
