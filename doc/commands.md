# Bot Command Reference

## Session Control

| Command    | Aliases              | Description                       |
| ---------- | -------------------- | --------------------------------- |
| `/start`   |                      | Show status and user ID           |
| `/new`     |                      | Start a fresh Claude session      |
| `/stop`    | `/c`, `/kill`, `/dc` | Interrupt current query           |
| `/resume`  |                      | Resume last saved session         |
| `/restart` |                      | Restart the bot process           |
| `/retry`   |                      | Retry last message                |
| `/status`  |                      | Check what Claude is doing        |
| `/pending` | `/q`                 | View and execute queued messages  |
| `/compact` |                      | Trigger SDK context compaction    |
| `/handoff` |                      | Carry response into a new session |

## Model & Provider

| Command     | Description                               |
| ----------- | ----------------------------------------- |
| `/model`    | Switch model (sonnet/opus/haiku/fable)    |
| `/provider` | Switch agent provider (claude/codex)      |
| `/think`    | Set extended thinking level (off/on/deep) |
| `/plan`     | Toggle planning mode                      |
| `/cost`     | Show token usage for current session      |

## File & Directory

| Command      | Description                            |
| ------------ | -------------------------------------- |
| `/cd`        | Change Claude's working directory      |
| `/file`      | Download a file from the server        |
| `/image`     | List image files in working directory  |
| `/pdf`       | List PDF files                         |
| `/docx`      | List Word documents                    |
| `/html`      | List HTML files                        |
| `/bookmarks` | Manage directory bookmarks             |
| `/undo`      | Revert file changes (checkpoint-based) |

## Git & Worktree

| Command     | Description                            |
| ----------- | -------------------------------------- |
| `/worktree` | Create a git worktree in `.worktrees/` |
| `/branch`   | List branches and switch via worktree  |
| `/merge`    | Merge current branch into main         |
| `/diff`     | View uncommitted changes               |
| `/skill`    | Invoke a Claude Code skill             |

## Text Shortcuts

| Prefix      | Description                                      |
| ----------- | ------------------------------------------------ |
| `!!message` | Interrupt current query and send new message     |
| `!command`  | Execute shell command (with confirmation prompt) |
