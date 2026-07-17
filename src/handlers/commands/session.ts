/**
 * Session-related command handlers.
 *
 * /start, /new, /stop, /status, /pending, /resume, /retry, /handoff, /undo
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { MESSAGE_EFFECTS } from "../../config";
import { escapeHtml } from "../../formatting";
import { sessionManager } from "../../session";
import { effectFor, startTypingIndicator } from "../../utils";
import { checkCommandAuth } from "./utils";

/**
 * /start - Show welcome message and status.
 */
export async function handleStart(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;
	if (!chatId || !userId) return;

	const session = sessionManager.getSession(chatId);
	const status = session.isActive ? "Active session" : "No active session";
	const workDir = session.workingDir;

	// Check launch mode and show appropriate badge
	const isCtb = !!process.env.CTB_INSTANCE_DIR;
	let modeInfo = "";
	if (isCtb) {
		try {
			// Read package.json for version
			const packageJsonPath = new URL("../../../package.json", import.meta.url)
				.pathname;
			const packageJson = await Bun.file(packageJsonPath).json();
			const version = packageJson.version || "unknown";
			modeInfo = ` v${version}`;
		} catch {
			// Ignore version read errors
		}
	} else {
		// Development mode (bun run start)
		modeInfo = " \u{1F468}\u200D\u{1F4BB} \u958B\u767C\u6A21\u5F0F";
	}

	await ctx.reply(
		`\u{1F916} <b>Claude Telegram Bot${modeInfo}</b>

Status: ${status}
Working directory: <code>${workDir}</code>

<b>Session:</b>
/new - Start fresh session
/stop - Stop current query (or /kill)
/status - Show detailed status
/resume - Resume last session
/retry - Retry last message
/handoff - Carry response to new session
/pending - Show queued messages

<b>Model:</b>
/model - Switch model (sonnet/opus/haiku/fable)
/provider - Switch agent provider
/think - Force extended thinking
/plan - Toggle planning mode
/compact - Trigger context compaction
/cost - Show token usage

<b>Files:</b>
/cd - Change working directory
/worktree - Create and enter a git worktree
/branch - Switch to a branch worktree
/merge - Merge current branch into main
/diff - View uncommitted changes
/file - Download a file
/image - List image files
/pdf - List PDF files
/docx - List DOCX files
/html - List HTML files
/undo - Revert file changes
/skill - Invoke Claude Code skill
/bookmarks - Directory bookmarks
/restart - Restart the bot

<b>Tips:</b>
\u2022 <code>!cmd</code> - Run shell command
\u2022 <code>!!msg</code> - Interrupt and send
\u2022 Send photos, voice, or documents`,
		{ parse_mode: "HTML" },
	);
}

/**
 * /new - Start a fresh session.
 */
export async function handleNew(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	// Stop any running query
	if (session.isRunning) {
		const result = await session.stop();
		if (result) {
			await Bun.sleep(100);
			session.clearStopRequested();
		}
	}

	// Clear session
	await session.kill();

	// Get context info
	const username = process.env.USER || process.env.USERNAME || "unknown";
	const workDir = session.workingDir;

	// Format date as yyyy-mm-dd (Wed) HH:MM GMT+X
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const weekday = now.toLocaleDateString("en-US", { weekday: "short" });
	const hours = String(now.getHours()).padStart(2, "0");
	const minutes = String(now.getMinutes()).padStart(2, "0");
	const timezoneOffset = -now.getTimezoneOffset() / 60;
	const timezone =
		timezoneOffset >= 0 ? `GMT+${timezoneOffset}` : `GMT${timezoneOffset}`;
	const dateStr = `${year}-${month}-${day} (${weekday}) ${hours}:${minutes} ${timezone}`;

	// Get uname info (system name and hostname)
	const { execSync } = await import("node:child_process");
	let unameInfo = "";
	try {
		const system = execSync("uname -s", { encoding: "utf-8" }).trim();
		const hostname = execSync("uname -n", { encoding: "utf-8" }).trim();
		unameInfo = `${system} ${hostname}`;
	} catch (_e) {
		unameInfo = "N/A";
	}

	await ctx.reply(
		`\u{1F195} Session cleared. Next message starts fresh.\n\n\u{1F464} ${username}\n\u{1F4C1} <code>${workDir}</code>\n\u{1F550} ${dateStr}\n\u{1F4BB} <code>${unameInfo}</code>`,
		{ parse_mode: "HTML" },
	);
}

/**
 * /stop - Stop the current query (silently).
 */
export async function handleStop(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	if (session.isRunning) {
		const result = await session.stop();
		if (result) {
			// Wait for the abort to be processed, then clear stopRequested so next message can proceed
			await Bun.sleep(100);
			session.clearStopRequested();
		}
		// Silent stop - no message shown
	}
	// If nothing running, also stay silent
}

/**
 * /status - Show detailed status.
 */
export async function handleStatus(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	const lines: string[] = ["\u{1F4CA} <b>Bot Status</b>\n"];

	// Session status
	if (session.isActive) {
		lines.push(`\u2705 Session: Active (${session.sessionId?.slice(0, 8)}...)`);
	} else {
		lines.push("\u26AA Session: None");
	}

	// Provider status
	lines.push(`\u{1F916} Provider: <b>${session.currentProvider}</b>`);

	// Query status
	if (session.isRunning) {
		const elapsed = session.queryStarted
			? Math.floor((Date.now() - session.queryStarted.getTime()) / 1000)
			: 0;
		lines.push(`\u{1F504} Query: Running (${elapsed}s)`);
		if (session.currentTool) {
			lines.push(`   \u2514\u2500 ${session.currentTool}`);
		}
	} else {
		lines.push("\u26AA Query: Idle");
		if (session.lastTool) {
			lines.push(`   \u2514\u2500 Last: ${session.lastTool}`);
		}
	}

	// Last activity
	if (session.lastActivity) {
		const ago = Math.floor(
			(Date.now() - session.lastActivity.getTime()) / 1000,
		);
		lines.push(`\n\u23F1\uFE0F Last activity: ${ago}s ago`);
	}

	// Usage stats
	if (session.lastUsage) {
		const usage = session.lastUsage;
		lines.push(
			"\n\u{1F4C8} Last query usage:",
			`   Input: ${usage.input_tokens?.toLocaleString() || "?"} tokens`,
			`   Output: ${usage.output_tokens?.toLocaleString() || "?"} tokens`,
		);
		if (usage.cache_read_input_tokens) {
			lines.push(
				`   Cache read: ${usage.cache_read_input_tokens.toLocaleString()}`,
			);
		}
	}

	// Error status
	if (session.lastError) {
		const ago = session.lastErrorTime
			? Math.floor((Date.now() - session.lastErrorTime.getTime()) / 1000)
			: "?";
		lines.push(
			`\n\u26A0\uFE0F Last error (${ago}s ago):`,
			`   ${session.lastError}`,
		);
	}

	// Working directory
	lines.push(`\n\u{1F4C1} Working dir: <code>${session.workingDir}</code>`);

	await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/**
 * /pending - Show and manage pending messages queue.
 */
export async function handlePending(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	const pending = session.getPendingMessages();

	if (pending.length === 0) {
		await ctx.reply("\u{1F4ED} No pending messages.");
		return;
	}

	// Build message with inline keyboard
	let text = `\u{1F4CB} <b>Pending Messages</b> (${pending.length})\n\n`;
	const keyboard = new InlineKeyboard();

	for (const msg of pending) {
		const preview =
			msg.text.length > 40 ? `${msg.text.slice(0, 40)}...` : msg.text;
		const ago = Math.floor((Date.now() - msg.timestamp.getTime()) / 1000);
		text += `\u2022 <code>${preview}</code> (${ago}s ago)\n`;

		// Button with truncated text
		const btnLabel =
			msg.text.length > 25 ? `${msg.text.slice(0, 25)}...` : msg.text;
		keyboard.text(btnLabel, `pending:exec:${msg.id}`).row();
	}

	keyboard.text("\u{1F5D1} Clear All", "pending:clear");

	await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}

/**
 * /resume - Resume the last session.
 */
export async function handleResume(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	if (session.isActive) {
		await ctx.reply("Session already active. Use /new to start fresh first.");
		return;
	}

	const [success, message] = session.resumeLast();
	if (success) {
		await ctx.reply(`\u2705 ${message}`);
	} else {
		await ctx.reply(`\u274C ${message}`, {
			message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.THUMBS_DOWN),
		});
	}
}

/**
 * /retry - Retry the last message (resume session and re-send).
 */
export async function handleRetry(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	// Check if there's a message to retry
	if (!session.lastMessage) {
		await ctx.reply("\u274C No message to retry.", {
			message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.THUMBS_DOWN),
		});
		return;
	}

	// Check if something is already running
	if (session.isRunning) {
		await ctx.reply("\u23F3 A query is already running. Use /stop first.");
		return;
	}

	const message = session.lastMessage;
	await ctx.reply(
		`\u{1F504} Retrying: "${message.slice(0, 50)}${message.length > 50 ? "..." : ""}"`,
	);

	// Simulate sending the message again by emitting a fake text message event
	// We do this by directly calling the text handler logic
	const { handleText } = await import("../text");

	// Create a modified context with the last message
	const fakeCtx = {
		...ctx,
		message: {
			...ctx.message,
			text: message,
		},
	} as Context;

	await handleText(fakeCtx);
}

/**
 * /handoff - Start fresh session with last response as context.
 */
export async function handleHandoff(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	const lastResponse = session.lastBotResponse;

	if (!lastResponse) {
		await ctx.reply(
			"\u274C No previous response to carry forward.\nUse /new for a fresh start.",
		);
		return;
	}

	// Preview what will be carried forward (truncated)
	const preview =
		lastResponse.length > 500
			? `${lastResponse.slice(0, 500)}...`
			: lastResponse;

	const keyboard = new InlineKeyboard()
		.text("\u2705 Handoff & Continue", "handoff:go")
		.text("\u274C Cancel", "handoff:cancel");

	await ctx.reply(
		`\u{1F4E6} <b>Context Handoff</b>\n\nThis will:\n1. Clear current session\n2. Start fresh with last response as context\n\n<b>Last response preview:</b>\n<code>${escapeHtml(preview)}</code>`,
		{ parse_mode: "HTML", reply_markup: keyboard },
	);
}

/**
 * /undo - Revert file changes to last checkpoint.
 */
export async function handleUndo(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	if (!session.isActive) {
		await ctx.reply("\u274C No active session.", {
			message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.THUMBS_DOWN),
		});
		return;
	}

	if (!session.canUndo) {
		await ctx.reply(
			"\u274C No checkpoints available.\n\n" +
				"Checkpoints are created when you send messages.",
		);
		return;
	}

	// Show progress
	const typing = startTypingIndicator(ctx);
	const statusMsg = await ctx.reply("\u23EA Reverting files...");

	try {
		const [success, message] = await session.undo();

		const chatId = ctx.chat?.id;
		if (!chatId) {
			await ctx.reply("\u274C Unable to determine chat ID.", {
				message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.THUMBS_DOWN),
			});
			return;
		}

		// Update status message with result
		await ctx.api.editMessageText(
			chatId,
			statusMsg.message_id,
			success ? message : `\u274C ${message}`,
			{ parse_mode: "HTML" },
		);
	} finally {
		typing.stop();
	}
}
