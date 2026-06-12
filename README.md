# diet-coach-bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.0+-black.svg)](https://bun.sh/)

> **Fork notice**: This is a fork of [htlin222/claude-telegram-bot](https://github.com/htlin222/claude-telegram-bot) hardened
> for the [diet-coach](https://github.com/didiowen/diet-coach) deployment, where one host (the vault owner) shares a single
> Telegram bot with a small number of trusted friends. The general-purpose ctb features below are still available; this fork
> adds the following diet-coach-specific behaviors on top:
>
> - **Multi-tenant sandboxing** — host gets full vault access; each friend's chat is sandboxed to its own per-chat working
>   directory (`CTB_HOST_CHAT_IDS` opts the host out of the sandbox). Friends cannot read host paths.
> - **Auto-load diet-coach skill** — every session's system prompt injects a pointer to `.claude/skills/diet-coach/SKILL.md`
>   in the working directory, so food-related messages always run through the diet skill without explicit `/skill` invocation.
> - **`WELCOME.md` first-message** — if `WELCOME.md` exists in the working directory, the bot's very first reply in a fresh
>   session is the verbatim file contents (used for friend onboarding / disclosure).
> - **Symlink-resolved per-session path bypass** — Read / Write / Edit / Bash paths under `realpath(working_dir)` are allowed
>   in addition to global `ALLOWED_PATHS`, so `~/.claude/skills/*` symlinks into the vault work transparently.
> - **Codex provider alongside Claude** — switch with `/provider`; Codex worker uses `@openai/codex-sdk` and respects the
>   same per-session cwd bypass.
> - **Aborted-query session auto-clear** — if a query is interrupted before the SDK emits `result`, the session pointer is
>   dropped so the next message starts fresh instead of resuming a corrupt jsonl that short-circuits to `in=0 out=0` (see
>   PR [#3](https://github.com/didiowen/diet-coach-bot/pull/3)).
> - **Cosmetic trims** — Telegram menu reduced to 10 diet-coach commands; token-usage footer (`Done | XK→YK 🎉`) and inline
>   action keyboard removed to keep the chat clean.
> - **Latest Claude model IDs** — `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5` (upstream may lag).
>
> Install: `npm install -g github:didiowen/diet-coach-bot` (requires Bun ≥ 1.0). Everything else (commands, security model,
> group chat, file index) is inherited from upstream and documented below.

**Repository description:** A Telegram bot that runs a personal Claude Code (or Codex) coach against a host vault, with
optional sandboxed access for trusted friends. Diet-tracking is the canonical use case; the underlying ctb is general-purpose.

**中文說明**: [README.zh.md](README.zh.md)

## Overview

`diet-coach-bot` connects Telegram → Claude Code (or Codex) and streams responses (including tool status) back to your chat.
It is built on Bun + grammY and the official `@anthropic-ai/claude-agent-sdk`. The fork adds a multi-tenant host/friend
sandbox model, an auto-loaded diet-coach skill, and a verbatim first-message onboarding flow — see the fork notice above
and the [Diet-coach mode](#diet-coach-mode) section for details.

## Diet-coach mode

The diet-coach-specific behaviors are always active in this fork (there is no on/off switch — they layer on top of ctb).

### Host vs. friend

| Aspect | Host (vault owner) | Friend (sandboxed) |
|---|---|---|
| Telegram authorization | `TELEGRAM_ALLOWED_USERS` includes them | Same |
| Working directory | Bot's `WORKING_DIR` (typically the vault root) | Per-chat sandbox dir, pre-populated in `/tmp/ctb-*/sessions/<chat>.json` before the friend's first DM |
| File access | Global `ALLOWED_PATHS` + the vault | Their own sandbox dir only (no vault access) |
| `WELCOME.md` shown on first message | Optional | Recommended — used for onboarding / disclosure |
| `CTB_HOST_CHAT_IDS` env | Set to the host's chat IDs | Not listed |

Setting `CTB_HOST_CHAT_IDS=<chat_id>,<chat_id>` is what marks specific chats as the host's. Friends' chats are not listed
there and are sandboxed automatically.

### `.claude/skills/diet-coach/SKILL.md`

The system prompt sent to every Claude session ends with:

> *"This bot is dedicated to diet tracking. For ANY user message about food (photos, descriptions, nutrition queries), or
> any food-related question, use the diet-coach skill at `.claude/skills/diet-coach/SKILL.md` in your working directory."*

So you provision each working directory (host vault and each friend sandbox) with a `.claude/skills/diet-coach/SKILL.md` —
this is what the bot reads on every turn. The canonical skill lives in the
[diet-coach](https://github.com/didiowen/diet-coach) repo; symlink it into each working dir.

### `WELCOME.md`

If `WELCOME.md` exists in the working directory, the bot's first reply in a fresh session must be the verbatim file
contents (no edits, no paraphrasing). Subsequent turns proceed normally. This is the recommended way to deliver onboarding
text / disclosure language to friends without writing custom code.

### Aborted-query auto-clear

If a query is interrupted before the SDK emits its `result` event (e.g. the user fires a second message while the first is
still streaming), the session jsonl ends with a dangling `[Request interrupted by user]` user turn. Resuming that session
causes the Agent SDK to short-circuit with a synthetic `"No response requested."` reply and `in=0 out=0` tokens — every
subsequent message hangs forever, even across `ctb` restarts. This fork detects the aborted-without-`result` case in the
session's `finally` block and drops both the in-memory `sessionId` and the on-disk `/tmp/ctb-*/sessions/<chat>.json`
pointer, so the next message starts a fresh session instead of resuming the corrupt one. PR
[#3](https://github.com/didiowen/diet-coach-bot/pull/3).

## Features

- 🥗 **Diet-coach mode** (this fork): host/friend sandboxing, auto-loaded SKILL.md, verbatim WELCOME.md — see [above](#diet-coach-mode)
- 🤖 **Dual provider**: Claude (default) or Codex — switch per-session with `/provider`
- 💬 Text, 🎤 voice (with transcript editing), 📸 photos, 📄 documents
- ⚡ Streaming responses with live tool status
- 📨 Message queueing while Claude is busy
- 🔘 Inline action buttons via `ask_user` MCP
- 🧠 Thinking/plan/compact modes
- 🧵 Session persistence and `/resume`
- 📁 Git worktrees, `/diff`, `/undo`, `/file`
- 🗂️ File listing helpers: `/image`, `/pdf`, `/docx`, `/html`
- ✏️ Voice transcript confirmation and editing before sending to Claude
- 🔄 Smart `/restart` with TTY mode detection and confirmation dialog
- 👥 **Group chat support**: Add bot to groups, require @mention to respond (v1.4.3+)
- 🛡️ Safety layers: allowlist, rate limits, path checks, command guardrails, audit log
- 🗂️ Per-chat sessions: each Telegram chat has its own independent Claude session

## API Docs

`https://htlin222.github.io/claude-telegram-bot/`

## Quick Start

### Prerequisites

- **Bun 1.0+**
- **Telegram Bot Token** from @BotFather
- **Claude Code CLI** (recommended, for SDK CLI auth)
- **OpenAI API Key** (optional, for voice transcription)

### Install from GitHub (Recommended)

Install this fork directly via the GitHub URL (the upstream `ctb` package on npm is the unforked version):

```bash
npm install -g github:didiowen/diet-coach-bot

# Show setup tutorial
ctb tut

# Run in your vault / working directory
cd ~/vault
ctb
```

On first run, `ctb` will prompt for your Telegram bot token and allowed user IDs, then optionally save them to `.env`.

### Install from Source

```bash
git clone https://github.com/didiowen/diet-coach-bot
cd diet-coach-bot

cp .env.example .env
# Edit .env with your credentials

bun install
bun run start
```

### Configure Environment

```bash
# Required
TELEGRAM_BOT_TOKEN=1234567890:ABC-DEF...
TELEGRAM_ALLOWED_USERS=123456789

# Optional
CLAUDE_WORKING_DIR=/path/to/your/folder    # Fallback working directory
OPENAI_API_KEY=sk-...                      # For voice transcription

# Diet-coach mode (fork-specific)
CTB_HOST_CHAT_IDS=123456789                # Chat IDs that get the host's full vault access.
                                           # Any allowed chat NOT listed here is sandboxed to
                                           # its own per-chat working dir (friend mode).
ALLOWED_PATHS=~/vault,~/.claude/skills     # Extra paths the host may read/write. `~` is
                                           # expanded; friends are still capped to their
                                           # per-session working dir on top of this.
```

### Working Directory

The bot determines the working directory in this order:

1. **CLI `--dir` flag**: `ctb --dir ~/my-project`
2. **Current directory**: Where you run `ctb` (most common)
3. **`CLAUDE_WORKING_DIR`**: Environment variable fallback
4. **`$HOME`**: Last resort default

**Typical usage:**

```bash
cd ~/my-project
ctb              # Working dir = ~/my-project
```

**Claude SDK authentication (recommended):**

- This bot uses `@anthropic-ai/claude-agent-sdk`.
- Prefer **CLI auth**: run `claude` once and sign in. This uses your Claude Code subscription and is typically more cost-effective.
- Use `ANTHROPIC_API_KEY` only if you cannot use CLI auth (headless/CI environments).

## Group Chat Support

Add the bot to Telegram groups for collaborative debugging! 👥

### How It Works

- **@mention required**: Bot only responds when mentioned with `@bot_username` in groups
- **Private chats unchanged**: No mention needed in direct messages
- **Authorization**: Only `TELEGRAM_ALLOWED_USERS` can control the bot
- **Visibility**: Authorized users' conversations are visible to all group members
- **Privacy**: Unauthorized users get private notifications (not visible to group)

### Usage Example

```
Alice (authorized): @mybot what's the current git status?
Bot: [Shows git status to everyone]

Bob (unauthorized): @mybot help me debug
Bot: [Sends private message to Bob: "You are not authorized..."]

Alice: Let's fix this bug together
[No @mention, bot ignores - normal group chat]

Alice: @mybot check the logs
Bot: [Responds to Alice, everyone sees the response]
```

### Setup

1. Add bot to group via @BotFather settings
2. Configure `TELEGRAM_ALLOWED_USERS` with authorized user IDs
3. Group members @mention the bot to interact
4. Bot maintains per-chat session (each group has independent context)

**Perfect for pair programming, code reviews, and team debugging!**

## Commands

### Session

- `/start` `/new` `/resume` `/stop` `/status` `/retry` `/handoff` `/pending` `/restart`
- `/sessions` - List all active sessions across chats

### Model & Reasoning

- `/model` `/provider` `/think` `/plan` `/compact` `/cost`

### Files & Worktrees

- `/cd` `/worktree` `/branch` `/diff` `/file` `/undo` `/bookmarks`
- File listing: `/image` `/pdf` `/docx` `/html`
- **File search**: `/search <filename>` - Lightning-fast SQLite-powered search
  - 1 file found → Auto-sends the file
  - 2-3 files → Shows download buttons
  - 4+ files → Shows compact list
- **File indexing**: `/rebuild_index` `/index_stats` - Manage file index
- **Auto file send**: Just say "把檔案給我看" or "send me the file" after Claude mentions files, and the bot will automatically detect and send them!

### Shell

Prefix a message with `!` to run it in the working directory:

```
!ls -la
!git status
```

## Per-Chat Sessions

Each Telegram chat maintains its own independent Claude session:

- **Multiple projects**: Work on different projects in separate Telegram chats
- **Independent history**: Each chat has its own conversation context
- **Separate working dirs**: Use `/cd` in each chat to set different directories
- **Session persistence**: Sessions survive bot restarts

**Example workflow:**

```
Chat A: /cd ~/frontend    → Frontend development
Chat B: /cd ~/backend     → Backend API work
Chat C: /cd ~/docs        → Documentation
```

Use `/sessions` to view all active sessions across chats.

## File Indexing & Search

The bot includes a high-performance file indexing system powered by SQLite:

### Features

- **Lightning-fast search**: 50-200x faster than filesystem scanning (<10ms vs 500-2000ms)
- **Real-time updates**: File watcher automatically updates index on file add/change/delete
- **Smart auto-send**:
  - 1 file found → Automatically sends the file
  - 2-3 files → Shows download buttons for quick access
  - 4+ files → Shows compact list with file details
- **Recent access tracking**: Search results prioritized by recent usage

### Commands

- `/search <filename>` - Search for files (e.g., `/search config.ts`)
- `/index_stats` - View index statistics and watcher status
- `/rebuild_index` - Manually rebuild the index (usually not needed)

### How It Works

1. **Startup**: Bot automatically builds file index in background
2. **Monitoring**: File watcher tracks changes in real-time
3. **Search**: SQLite index enables instant file lookups
4. **Auto-send**: Single result? File is sent immediately

### Performance

| Operation   | Before (No Index) | After (With Index)    |
| ----------- | ----------------- | --------------------- |
| File search | ~500-2000ms       | <10ms                 |
| New file    | Manual scan       | Auto-indexed (<100ms) |
| File change | Manual scan       | Auto-updated (<50ms)  |
| File delete | Manual scan       | Auto-removed (<10ms)  |

## Best Practices

- Run `ctb` from your project directory to auto-set the working directory.
- Use `ALLOWED_PATHS` to explicitly scope where Claude can read/write.
- Use `/worktree` for risky changes and `/diff` before `/commit`.
- Prefer `/new` before unrelated tasks to keep context clean.
- Use separate Telegram chats for different projects (per-chat sessions).
- Use `/image`/`/pdf`/`/docx`/`/html` to quickly locate files for `/file`.
- Enable CLI auth for the Claude SDK to reduce cost and avoid API-key throttling.

## Security

This bot intentionally bypasses interactive permission prompts for speed. Review the model and safeguards here:

- `SECURITY.md`

## License

MIT
