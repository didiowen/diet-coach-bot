# diet-coach-bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.0+-black.svg)](https://bun.sh/)

> **Fork 說明**：本專案是 [htlin222/claude-telegram-bot](https://github.com/htlin222/claude-telegram-bot) 的 fork，
> 針對 [diet-coach](https://github.com/didiowen/diet-coach) 的多租戶場景強化 —— 一位 host（vault 擁有者）跟少數信任的朋友
> 共用同一個 Telegram bot。下方所有 upstream ctb 通用功能仍可用，本 fork 在其上加入下列 diet-coach 專屬行為：
>
> - **多租戶 sandbox** —— host 享有完整 vault 存取；每位朋友的聊天室會被沙箱到自己的 per-chat 工作目錄
>   （用 `CTB_HOST_CHAT_IDS` 把 host 排除在沙箱外），朋友看不到 host 的檔案。
> - **自動載入 diet-coach skill** —— 每個 session 的 system prompt 都會注入指向 `.claude/skills/diet-coach/SKILL.md` 的
>   pointer，飲食相關訊息一律走這個 skill，不需要顯式 `/skill`。
> - **`WELCOME.md` 首訊息** —— 若工作目錄裡有 `WELCOME.md`，新 session 的第一則回覆會 verbatim 輸出檔案內容（朋友 onboarding /
>   免責聲明）。
> - **Symlink-resolved per-session 路徑放行** —— `realpath(working_dir)` 底下的 Read/Write/Edit/Bash 路徑會額外被放行，
>   所以 `~/.claude/skills/*` symlink 進 vault 也能直接用。Codex worker 也 patch 過，同樣套用 per-session cwd 放行。
> - **中斷 query 自動清掉 session** —— 若 SDK 還沒 emit `result` 之前 query 被打斷（例如回覆還在串流就送下一條），
>   session pointer 會被丟掉，下一條訊息開新 session，避免 resume 壞掉的 jsonl 觸發 `in=0 out=0` synthetic 短路
>   （PR [#3](https://github.com/didiowen/diet-coach-bot/pull/3)）。
> - **降噪** —— Telegram menu 精簡到 10 個 diet-coach 常用 commands；移除 token-usage footer（`Done | XK→YK 🎉`）與
>   inline action keyboard。
> - **最新 Claude model IDs** —— `claude-sonnet-4-6`、`claude-opus-4-7`、`claude-haiku-4-5`（upstream 可能落後）。
>
> 安裝：`npm install -g github:didiowen/diet-coach-bot`（需 Bun ≥ 1.0）。其他功能、安全模型、群組聊天、檔案索引等
> 完全沿用 upstream，文件如下。

**Repo 描述：** 在 host vault 上跑個人化 Claude Code（或 Codex）coach 的 Telegram bot，可選擇性開放沙箱給信任朋友。
飲食追蹤是 canonical 用途；底層 ctb 是通用的。

## 總覽

`diet-coach-bot` 把 Telegram 接到 Claude Code（或 Codex），把回覆與工具狀態即時串流回聊天室。底層用 Bun + grammY 跟
官方 `@anthropic-ai/claude-agent-sdk`。fork 在其上加了 host/friend 沙箱、auto-load 的 diet-coach skill、verbatim
WELCOME.md 首訊息 —— 參見上方 fork 說明與下方 [Diet-coach 模式](#diet-coach-模式) 章節。

## Diet-coach 模式

下列 diet-coach 專屬行為在本 fork 中永遠啟用（沒有開關 —— 它們疊加在 ctb 之上）。

### Host 與朋友

| 項目 | Host（vault 擁有者）| 朋友（沙箱）|
|---|---|---|
| Telegram 授權 | `TELEGRAM_ALLOWED_USERS` 列入 | 同樣列入 |
| 工作目錄 | bot 的 `WORKING_DIR`（通常是 vault root）| Per-chat 沙箱目錄，朋友首次 DM 前先 pre-populate 到 `/tmp/ctb-*/sessions/<chat>.json` |
| 檔案存取 | 全域 `ALLOWED_PATHS` + vault | 只能讀寫自己的沙箱目錄 |
| 首訊息顯示 `WELCOME.md` | 可選 | 建議 —— 用來做 onboarding／免責聲明 |
| `CTB_HOST_CHAT_IDS` 環境變數 | 把 host 的 chat ID 填進去 | 不列入 |

`CTB_HOST_CHAT_IDS=<chat_id>,<chat_id>` 是用來「標記哪些 chat 屬於 host」的開關。沒列在裡面的朋友 chat 會自動進入沙箱。

### `.claude/skills/diet-coach/SKILL.md`

每個 Claude session 的 system prompt 結尾固定加上：

> *"This bot is dedicated to diet tracking. For ANY user message about food (photos, descriptions, nutrition queries), or
> any food-related question, use the diet-coach skill at `.claude/skills/diet-coach/SKILL.md` in your working directory.
> Default behavior is diet logging; only deviate when the user explicitly requests something non-diet-related."*

所以你要在每個工作目錄（host vault 和每位朋友的沙箱目錄）放好 `.claude/skills/diet-coach/SKILL.md`。bot 每一輪都會讀它。
canonical skill 放在 [diet-coach](https://github.com/didiowen/diet-coach) repo，symlink 到每個工作目錄即可。

### `WELCOME.md`

若工作目錄存在 `WELCOME.md`，新 session 第一則回覆必須 verbatim 輸出檔案內容（不修改、不改寫、不額外評論）。
之後的對話正常進行。這是把 onboarding 文字 / 免責聲明遞給朋友的推薦做法，不需要寫額外程式碼。

### 中斷 query 自動清 session

如果一條 query 在 SDK emit `result` 之前被中斷（例如使用者在前一條還在串流時就送下一條），session jsonl 會以一個
懸空的 `[Request interrupted by user]` user turn 收尾。下次 resume 這條 session 時，Agent SDK 會直接短路成
synthetic 的 `"No response requested."` 加 `in=0 out=0` —— 之後每條訊息都會「卡住」，連 `ctb` 重啟都救不了。
本 fork 在 session 的 `finally` 區塊偵測「沒收到 `result` 就結束」的情境，把記憶體裡的 `sessionId` 跟磁碟上的
`/tmp/ctb-*/sessions/<chat>.json` pointer 一起丟掉，下次訊息會自然開新 session 而非 resume 壞掉的那條。
PR [#3](https://github.com/didiowen/diet-coach-bot/pull/3)。

## 功能

- 🥗 **Diet-coach 模式**（本 fork）：host/friend 沙箱、自動載入 SKILL.md、verbatim WELCOME.md —— 見[上方](#diet-coach-模式)
- 🤖 **雙 provider**：Claude（預設）或 Codex —— 用 `/provider` 切換
- 💬 文字、🎤 語音（支援轉錄編輯）、📸 圖片、📄 文件
- ⚡ 串流回覆與工具狀態
- 📨 Claude 忙碌時自動排隊訊息
- 🔘 透過 `ask_user` MCP 的按鈕互動
- 🧠 thinking / plan / compact 模式
- 🧵 Session 持久化與 `/resume`
- 📁 Git worktree、`/diff`、`/undo`、`/file`
- 🗂️ 快速列檔：`/image`、`/pdf`、`/docx`、`/html`
- ✏️ 語音轉錄確認與編輯功能，送給 Claude 前可先檢查與補充
- 🔄 智慧型 `/restart` 指令，支援 TTY 模式偵測與確認對話框
- 👥 **群組聊天支援**：將機器人加入群組，需 @提及才會回應（v1.4.3+）
- 🛡️ 安全層：白名單、限流、路徑檢查、指令保護、稽核紀錄
- 🗂️ 分聊天室 Session：每個 Telegram 聊天室擁有獨立的 Claude session

## API 文件

`https://htlin222.github.io/claude-telegram-bot/`

## 快速開始

### 需求

- **Bun 1.0+**
- **Telegram Bot Token**（向 @BotFather 申請）
- **Claude Code CLI**（建議，供 SDK CLI 登入）
- **OpenAI API Key**（可選，用於語音轉文字）

### 從 GitHub 安裝（建議）

直接透過 GitHub URL 安裝本 fork（npm 上的 `ctb` 是未 fork 的 upstream 版本）：

```bash
npm install -g github:didiowen/diet-coach-bot

# 顯示設定教學
ctb tut

# 在 vault / 工作目錄啟動
cd ~/vault
ctb
```

首次執行時，`ctb` 會提示輸入 Telegram Bot Token 與允許的使用者 ID，並可選擇寫入 `.env`。

### 從原始碼安裝

```bash
git clone https://github.com/didiowen/diet-coach-bot
cd diet-coach-bot

cp .env.example .env
# 編輯 .env

bun install
bun run start
```

### 環境設定

```bash
# 必填
TELEGRAM_BOT_TOKEN=1234567890:ABC-DEF...
TELEGRAM_ALLOWED_USERS=123456789

# 選填
CLAUDE_WORKING_DIR=/path/to/your/folder    # 備用工作目錄
OPENAI_API_KEY=sk-...                      # 語音轉文字

# Diet-coach 模式（本 fork 專屬）
CTB_HOST_CHAT_IDS=123456789                # 標記為 host 的 chat ID（可讀寫整個 vault）。
                                           # 已授權但沒列在這裡的 chat 會被沙箱成朋友模式。
ALLOWED_PATHS=~/vault,~/.claude/skills     # host 額外可讀寫的路徑。`~` 會展開；
                                           # 朋友仍會被限制到自己的 per-session 工作目錄。
```

### 工作目錄

Bot 依以下順序決定工作目錄：

1. **CLI `--dir` 參數**：`ctb --dir ~/my-project`
2. **當前目錄**：執行 `ctb` 時所在的目錄（最常見）
3. **`CLAUDE_WORKING_DIR`**：環境變數備用
4. **`$HOME`**：最後預設值

**常見用法：**

```bash
cd ~/my-project
ctb              # 工作目錄 = ~/my-project
```

**Claude SDK 認證（建議）：**

- 本專案使用 `@anthropic-ai/claude-agent-sdk`。
- 優先使用 **CLI 登入**：執行一次 `claude` 並登入。這會使用 Claude Code 訂閱，通常成本較低。
- 只有在無法 CLI 登入（如 CI/無頭環境）時才使用 `ANTHROPIC_API_KEY`。

## 群組聊天支援

將機器人加入 Telegram 群組，實現協作除錯！👥

### 運作方式

- **需要 @提及**：在群組中必須 `@bot_username` 提及機器人才會回應
- **私聊不變**：私人訊息不需要提及
- **授權控制**：只有 `TELEGRAM_ALLOWED_USERS` 中的用戶可以操作機器人
- **可見性**：授權用戶的對話所有群組成員都看得到
- **隱私保護**：未授權用戶會收到私訊通知（群組中不顯示）

### 使用範例

```
小明（已授權）：@mybot 目前的 git 狀態是什麼？
機器人：[顯示 git status 給所有人看]

小華（未授權）：@mybot 幫我除錯
機器人：[私訊小華：「您未被授權使用此機器人...」]

小明：我們一起修這個 bug 吧
[沒有 @提及，機器人忽略 - 正常群組聊天]

小明：@mybot 檢查一下日誌
機器人：[回應小明，所有人都看得到回覆]
```

### 設定步驟

1. 透過 @BotFather 設定將機器人加入群組
2. 在 `TELEGRAM_ALLOWED_USERS` 中設定授權用戶 ID
3. 群組成員使用 @提及與機器人互動
4. 機器人為每個聊天室維護獨立 session（每個群組有獨立的對話上下文）

**非常適合結對編程、程式碼審查和團隊除錯！**

## 指令

### Session

- `/start` `/new` `/resume` `/stop` `/status` `/retry` `/handoff` `/pending` `/restart`
- `/sessions` - 列出所有聊天室的 session

### 模型與推理

- `/model` `/provider` `/think` `/plan` `/compact` `/cost`

### 檔案與 Worktree

- `/cd` `/worktree` `/branch` `/diff` `/file` `/undo` `/bookmarks`
- 列檔：`/image` `/pdf` `/docx` `/html`
- **檔案搜尋**：`/search <檔名>` - SQLite 索引極速搜尋
  - 找到 1 個檔案 → 自動傳送檔案
  - 找到 2-3 個 → 顯示下載按鈕
  - 找到 4+ 個 → 顯示精簡列表
- **索引管理**：`/rebuild_index` `/index_stats` - 管理檔案索引
- **自動傳檔**：當 Claude 提到檔案後，只要說「把檔案給我看」或 "send me the file"，bot 就會自動偵測並傳送檔案！

### Shell

訊息前綴 `!` 會在工作目錄執行：

```
!ls -la
!git status
```

## 分聊天室 Session

每個 Telegram 聊天室擁有獨立的 Claude session：

- **多專案並行**：在不同聊天室處理不同專案
- **獨立歷史紀錄**：每個聊天室有自己的對話上下文
- **獨立工作目錄**：每個聊天室用 `/cd` 設定不同目錄
- **Session 持久化**：Bot 重啟後自動恢復

**使用範例：**

```
聊天室 A: /cd ~/frontend    → 前端開發
聊天室 B: /cd ~/backend     → 後端 API
聊天室 C: /cd ~/docs        → 文件撰寫
```

用 `/sessions` 查看所有聊天室的 session 狀態。

## 檔案索引與搜尋

Bot 內建 SQLite 驅動的高效能檔案索引系統：

### 功能特色

- **極速搜尋**：比檔案系統掃描快 50-200 倍（<10ms vs 500-2000ms）
- **即時更新**：檔案監控器自動更新索引（新增/修改/刪除）
- **智慧自動傳檔**：
  - 找到 1 個檔案 → 自動傳送
  - 找到 2-3 個 → 顯示下載按鈕
  - 找到 4+ 個 → 顯示精簡列表
- **最近存取追蹤**：搜尋結果依使用頻率排序

### 指令

- `/search <檔名>` - 搜尋檔案（例：`/search config.ts`）
- `/index_stats` - 查看索引統計與監控狀態
- `/rebuild_index` - 手動重建索引（通常不需要）

### 運作原理

1. **啟動**：Bot 自動在背景建立檔案索引
2. **監控**：檔案監控器即時追蹤變化
3. **搜尋**：SQLite 索引實現瞬間查詢
4. **自動傳送**：只有一個結果？立即傳送檔案

### 效能比較

| 操作     | 之前（無索引） | 之後（有索引）     |
| -------- | -------------- | ------------------ |
| 檔案搜尋 | ~500-2000ms    | <10ms              |
| 新增檔案 | 需手動掃描     | 自動索引（<100ms） |
| 修改檔案 | 需手動掃描     | 自動更新（<50ms）  |
| 刪除檔案 | 需手動掃描     | 自動移除（<10ms）  |

## 最佳實務

- 從專案目錄執行 `ctb`，自動設定工作目錄。
- 用 `ALLOWED_PATHS` 明確限制可讀寫範圍。
- 有風險的變更先用 `/worktree`，並在 `/commit` 前用 `/diff`。
- 任務切換前用 `/new` 清理上下文。
- 不同專案用不同 Telegram 聊天室（分聊天室 session）。
- 先用 `/image`/`/pdf`/`/docx`/`/html` 找檔，再用 `/file` 下載。
- 建議啟用 Claude SDK 的 CLI 認證，降低成本並避免 API key 限額問題。

## 安全性

本機器人刻意略過互動式權限確認以提升速度。請閱讀安全模型與保護機制：

- `SECURITY.zh.md`

## License

MIT
