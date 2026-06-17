# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Commands

```bash
bun run start      # Run the bot (src/bot.ts)
bun run dev        # Run with auto-reload (--watch)
bun run typecheck  # TypeScript type checking
bun test           # Run tests
bun install        # Install dependencies
```

## Architecture

Telegram bot (~3,300 lines TypeScript) that provides a Claude Code interface via text, voice, photos, and documents. Built with **Bun** and **grammY**.

### Message Flow

```
Telegram → Dedup → Sequentialize → Handler → Auth → Rate limit → Claude session → Streaming response → Audit log
```

### Entry Points

| File               | Purpose                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `src/cli/index.ts` | Main CLI entry (`ctb` command): parses args, loads .env, sets `CTB_INSTANCE_DIR`, imports bot.ts |
| `src/bot.ts`       | Bot setup: handler registration, PID lock, dedup middleware, startup                             |
| `src/index.ts`     | Legacy direct startup (backwards compat)                                                         |

### Key Modules

- **`src/config.ts`** - Environment parsing, instance isolation (`INSTANCE_HASH`), safety prompts
- **`src/session/`** - `ClaudeSession` per chat (`claude-session.ts`), session persistence (`session-manager.ts`), thinking budget (`thinking.ts`), shared types (`types.ts`)
- **`src/security.ts`** - `RateLimiter` (token bucket), `isPathAllowed()`, `checkCommandSafety()`
- **`src/formatting.ts`** - Markdown→HTML for Telegram, tool status emoji formatting
- **`src/git/`** - Git operations: worktree management, merge, diff, exec, shared types
- **`src/cli/`** - CLI entry point: arg parsing (`parser.ts`), help text, env loading, setup
- **`src/utils/`** - Audit logging, voice transcription (OpenAI), typing indicators, group chat detection, error logging, temp cleanup
- **`src/providers/`** - `claude` (Agent SDK) and `codex` (Node.js worker) providers

### Handlers (`src/handlers/`)

- **`text.ts`** - Text messages with `@mention` stripping, `!!` interrupt, `!` shell shortcut
- **`voice.ts`** - Voice→text via OpenAI, then text flow
- **`photo.ts`** - Image analysis with media group buffering
- **`streaming.ts`** - `StreamingState` and `createStatusCallback()` factory
- **`commands/`** - 25+ slash commands split by domain: session, restart, config, files, git, utils (see `doc/commands.md`)
- **`document/`** - PDF extraction (`pdftotext` CLI) and text files: constants, extractor, processor
- **`callbacks/`** - Inline keyboard handlers by type: ask-user, shell, pending, action, session, git, voice

## Security Model

1. **User allowlist** - `TELEGRAM_ALLOWED_USERS` (required)
2. **Path restriction** - `ALLOWED_PATHS` defaults to `WORKING_DIR` only. No `~/Documents`, `~/Desktop` etc.
3. **Command blocking** - 30+ dangerous patterns (rm -rf, fork bomb, chmod 777, curl|bash...)
4. **Rate limiting** - Token bucket per user (20 req/60s default)
5. **Safety prompt** - Injected into Claude: confirm deletions, respect paths
6. **Audit logging** - All actions logged with user/timestamp

## Multi-Instance Isolation

Each bot instance (different `WORKING_DIR`) gets its own temp directory via `INSTANCE_HASH`:

```
/tmp/ctb-{hash}/
├── session.json      # Legacy session file
├── sessions/         # Per-chat session persistence
├── restart.json      # Restart coordination
├── pid.lock          # Single-instance lock
└── downloads/        # Temp files (photos, documents)
```

## Worktrees

Worktrees are stored in `.worktrees/` inside the project (not a sibling directory). This folder is in `.gitignore`. Created via `/worktree` command; switched via `/branch`.

## Group Chat

- **Privacy mode must be disabled** via `@BotFather` → `/setprivacy` → Disable
- Bot must be re-added to existing groups after changing this setting
- 2-member groups (user + bot) auto-respond without `@mention`
- Larger groups require `@botname message` or `/command@botname`

## Patterns

**Adding a command**: Create handler in the appropriate `handlers/commands/*.ts` submodule (session, config, files, git, or restart), register in `bot.ts` with `bot.command("name", handler)`, add to menu commands array.

**Adding a message handler**: Create in `handlers/`, export from `handlers/index.ts`, register in `bot.ts`.

**Streaming pattern**: All handlers use `createStatusCallback()` from `streaming.ts` and `queryQueue.sendMessage()`.

**Skills**: Create in `.claude/skills/skill-name.md` (project-local, not global `~/.claude/skills/`).

## Configuration

All config via `.env` (copy from `.env.example`). See `doc/configuration.md` for full reference.

**Required**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`

## Further Documentation

- `doc/commands.md` - Full command reference
- `doc/configuration.md` - Environment variables and MCP setup
- `doc/deployment.md` - Standalone build, macOS service, PATH requirements
