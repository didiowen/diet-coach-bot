/**
 * Git-related callback handlers for Claude Telegram Bot.
 * Handles branch, merge, diff, and file sending callbacks.
 */

import { type Context, InlineKeyboard } from "grammy";
import { resolvePath } from "../../bookmarks";
import { MESSAGE_EFFECTS } from "../../config";
import { escapeHtml } from "../../formatting";
import { queryQueue } from "../../query-queue";
import { isPathAllowed } from "../../security";
import { sessionManager } from "../../session";
import { auditLog, effectFor, startTypingIndicator } from "../../utils";
import { logNonCriticalError } from "../../utils/error-logging";
import {
	createOrReuseWorktree,
	getCombinedDiff,
	getGitDiff,
	getMergeInfo,
	revertAllChanges,
} from "../../git";
import { createStatusCallback, StreamingState } from "../streaming";

/**
 * Handle branch switch callbacks.
 * Format: branch:switch:{base64}
 */
export async function handleBranchCallback(
	ctx: Context,
	userId: number,
	chatId: number,
	callbackData: string,
): Promise<void> {
	const session = sessionManager.getSession(chatId);

	const prefix = "branch:switch:";
	if (!callbackData.startsWith(prefix)) {
		await ctx.answerCallbackQuery({ text: "Invalid branch action" });
		return;
	}

	let branch = "";
	try {
		const encoded = callbackData.slice(prefix.length);
		branch = Buffer.from(encoded, "base64").toString("utf-8");
	} catch {
		await ctx.answerCallbackQuery({ text: "Invalid branch data" });
		return;
	}

	if (!branch) {
		await ctx.answerCallbackQuery({ text: "Invalid branch" });
		return;
	}

	if (session.isRunning) {
		await ctx.answerCallbackQuery({ text: "Stop the current query first." });
		return;
	}

	const result = await createOrReuseWorktree(session.workingDir, branch);
	if (!result.success) {
		await ctx.answerCallbackQuery({ text: result.message });
		return;
	}

	if (!isPathAllowed(result.path)) {
		await ctx.answerCallbackQuery({
			text: "Worktree path is not in allowed directories.",
		});
		try {
			await ctx.reply(
				`❌ Worktree path is not in allowed directories:\n<code>${escapeHtml(result.path)}</code>\n\nUpdate ALLOWED_PATHS and try again.`,
				{ parse_mode: "HTML" },
			);
		} catch (error) {
			logNonCriticalError("branch allowlist reply", error);
		}
		return;
	}

	// Save current session before switching
	session.flushSession();
	session.setWorkingDir(result.path);
	await session.kill();
	session.clearWorktreeRequest(userId, chatId);

	try {
		await ctx.editMessageText(
			`✅ Switched to worktree:\n<code>${escapeHtml(result.path)}</code>\n\nBranch: <code>${escapeHtml(result.branch)}</code>`,
			{ parse_mode: "HTML" },
		);
	} catch {
		await ctx.reply(
			`✅ Switched to worktree:\n<code>${escapeHtml(result.path)}</code>\n\nBranch: <code>${escapeHtml(result.branch)}</code>`,
			{ parse_mode: "HTML" },
		);
	}

	await ctx.answerCallbackQuery({ text: `Switched to ${result.branch}` });
}

/**
 * Handle file sending callbacks.
 * Format: sendfile:base64encodedpath
 */
export async function handleSendFileCallback(
	ctx: Context,
	callbackData: string,
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;
	const session = sessionManager.getSession(chatId);

	const { existsSync } = await import("node:fs");
	const { basename } = await import("node:path");
	const { InputFile } = await import("grammy");

	// Decode the file path (base64 encoded to handle special chars)
	const encodedPath = callbackData.slice("sendfile:".length);
	let filePath: string;
	try {
		filePath = Buffer.from(encodedPath, "base64").toString("utf-8");
	} catch {
		await ctx.answerCallbackQuery({ text: "Invalid file path" });
		return;
	}

	const resolvedPath = resolvePath(filePath, session.workingDir);

	// Check file exists
	if (!existsSync(resolvedPath)) {
		await ctx.answerCallbackQuery({ text: "File not found" });
		return;
	}

	if (!isPathAllowed(resolvedPath)) {
		await ctx.answerCallbackQuery({ text: "Access denied" });
		await ctx.reply(
			`❌ Access denied: <code>${escapeHtml(resolvedPath)}</code>`,
			{ parse_mode: "HTML" },
		);
		return;
	}

	// Send the file
	try {
		await ctx.answerCallbackQuery({ text: "Sending file..." });
		const fileName = basename(resolvedPath);
		await ctx.replyWithDocument(new InputFile(resolvedPath, fileName));
	} catch (error) {
		console.error("Failed to send file:", error);
		await ctx.reply(`❌ Failed to send file: ${String(error).slice(0, 100)}`, {
			message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.THUMBS_DOWN),
		});
	}
}

/**
 * Handle merge callbacks.
 * Format: merge:confirm:{base64branch} or merge:cancel
 */
export async function handleMergeCallback(
	ctx: Context,
	userId: number,
	username: string,
	callbackData: string,
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;
	const session = sessionManager.getSession(chatId);

	if (callbackData === "merge:cancel") {
		await ctx.answerCallbackQuery({ text: "Merge cancelled" });
		try {
			await ctx.editMessageText("❌ Merge cancelled.");
		} catch (error) {
			logNonCriticalError("merge cancel edit", error);
		}
		return;
	}

	const prefix = "merge:confirm:";
	if (!callbackData.startsWith(prefix)) {
		await ctx.answerCallbackQuery({ text: "Invalid merge action" });
		return;
	}

	let branchToMerge = "";
	try {
		const encoded = callbackData.slice(prefix.length);
		branchToMerge = Buffer.from(encoded, "base64").toString("utf-8");
	} catch {
		await ctx.answerCallbackQuery({ text: "Invalid branch data" });
		return;
	}

	if (!branchToMerge) {
		await ctx.answerCallbackQuery({ text: "Invalid branch" });
		return;
	}

	if (session.isRunning) {
		await ctx.answerCallbackQuery({ text: "Stop the current query first." });
		return;
	}

	// Get merge info to find main worktree
	const info = await getMergeInfo(session.workingDir);
	if (!info.success) {
		await ctx.answerCallbackQuery({ text: info.message });
		return;
	}

	if (!isPathAllowed(info.mainWorktreePath)) {
		await ctx.answerCallbackQuery({
			text: "Main worktree path is not in allowed directories.",
		});
		await ctx.reply(
			`❌ Main worktree path is not in allowed directories:\n<code>${escapeHtml(info.mainWorktreePath)}</code>\n\nUpdate ALLOWED_PATHS and try again.`,
			{ parse_mode: "HTML" },
		);
		return;
	}

	// Switch to main worktree
	session.flushSession();
	session.setWorkingDir(info.mainWorktreePath);
	await session.kill();

	try {
		await ctx.editMessageText(
			`🔀 Switched to <code>${escapeHtml(info.mainBranch)}</code> worktree.\n\nMerging <code>${escapeHtml(branchToMerge)}</code>...`,
			{ parse_mode: "HTML" },
		);
	} catch (error) {
		logNonCriticalError("merge status edit", error);
	}

	await ctx.answerCallbackQuery({ text: `Merging ${branchToMerge}...` });

	// Send merge command to Claude
	const mergePrompt = `Merge the branch "${branchToMerge}" into "${info.mainBranch}".

Steps:
1. Run \`git merge ${branchToMerge}\`
2. If there are merge conflicts, resolve them intelligently
3. After resolving, stage and commit the merge
4. Show me the result

If the merge is clean, just complete it. If there are conflicts, explain what you're doing to resolve them.`;

	const typing = startTypingIndicator(ctx);
	const state = new StreamingState();
	const statusCallback = createStatusCallback(ctx, state, chatId);

	try {
		const response = await queryQueue.sendMessage(
			session,
			mergePrompt,
			username,
			userId,
			statusCallback,
			chatId,
			ctx,
		);

		await auditLog(userId, username, "MERGE", branchToMerge, response);
	} catch (error) {
		console.error("Merge error:", error);
		await ctx.reply(`❌ Merge failed: ${String(error).slice(0, 200)}`, {
			message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.THUMBS_DOWN),
		});
	} finally {
		typing.stop();
	}
}

/**
 * Handle diff callbacks.
 * Format: diff:view:{base64opts}, diff:commit, diff:revert, diff:revert:confirm
 */
export async function handleDiffCallback(
	ctx: Context,
	userId: number,
	username: string,
	callbackData: string,
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;
	const session = sessionManager.getSession(chatId);

	const parts = callbackData.split(":");
	const action = parts[1];

	if (action === "view") {
		// Decode options
		const encodedOpts = parts.slice(2).join(":");
		let opts = "all";
		try {
			opts = Buffer.from(encodedOpts, "base64").toString("utf-8");
		} catch {
			// Default to all
		}

		// Parse options
		const isStaged = opts === "staged";
		const file = opts.startsWith("file:") ? opts.slice(5) : undefined;

		// Get diff
		const result = isStaged
			? await getGitDiff(session.workingDir, { staged: true })
			: file
				? await getCombinedDiff(session.workingDir, { file })
				: await getCombinedDiff(session.workingDir);

		if (!result.success) {
			await ctx.answerCallbackQuery({ text: result.message });
			return;
		}

		if (!result.hasChanges) {
			await ctx.answerCallbackQuery({ text: "No changes to show" });
			return;
		}

		const diffLines = result.fullDiff.split("\n").length;
		const DIFF_LINE_THRESHOLD = 50;

		if (diffLines > DIFF_LINE_THRESHOLD) {
			// Send as file
			await ctx.answerCallbackQuery({ text: "Sending diff file..." });

			const { InputFile } = await import("grammy");
			const diffBuffer = Buffer.from(result.fullDiff, "utf-8");
			const MAX_DIFF_SIZE = 50 * 1024 * 1024;
			if (diffBuffer.length > MAX_DIFF_SIZE) {
				await ctx.answerCallbackQuery({ text: "Diff file too large" });
				await ctx.reply("❌ Diff is too large to send as a file.", {
					message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.THUMBS_DOWN),
				});
				return;
			}
			const filename = file
				? `${file.replace(/\//g, "_")}.diff`
				: "changes.diff";
			try {
				await ctx.replyWithDocument(new InputFile(diffBuffer, filename));
			} catch (error) {
				console.error("Failed to send diff file:", error);
				await ctx.reply(
					`❌ Failed to send diff file: ${String(error).slice(0, 100)}`,
				);
			}
		} else {
			// Send as HTML pre block
			await ctx.answerCallbackQuery({ text: "Showing diff..." });

			const escapedDiff = result.fullDiff
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");

			// Truncate if too long for Telegram message
			const maxLen = 4000;
			const truncated =
				escapedDiff.length > maxLen
					? `${escapedDiff.slice(0, maxLen)}...(truncated)`
					: escapedDiff;

			await ctx.reply(`<pre>${truncated}</pre>`, { parse_mode: "HTML" });
		}
		return;
	}

	if (action === "commit") {
		await ctx.answerCallbackQuery({ text: "Starting commit flow..." });

		// Delete the diff message
		try {
			await ctx.deleteMessage();
		} catch {
			// Message may have been deleted
		}

		// Send commit command to Claude
		const typing = startTypingIndicator(ctx);
		const state = new StreamingState();
		const statusCallback = createStatusCallback(ctx, state, chatId);

		try {
			const response = await queryQueue.sendMessage(
				session,
				"/commit",
				username,
				userId,
				statusCallback,
				chatId,
				ctx,
			);

			await auditLog(userId, username, "DIFF_COMMIT", "/commit", response);
		} catch (error) {
			console.error("Commit error:", error);
			await ctx.reply(`❌ Commit failed: ${String(error).slice(0, 200)}`, {
				message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.THUMBS_DOWN),
			});
		} finally {
			typing.stop();
		}
		return;
	}

	if (action === "revert") {
		const subAction = parts[2];

		if (subAction === "cancel") {
			await ctx.answerCallbackQuery({ text: "Cancelled" });
			try {
				await ctx.deleteMessage();
			} catch {
				// Message may have been deleted
			}
			return;
		}

		if (subAction === "confirm") {
			// Execute revert
			await ctx.answerCallbackQuery({ text: "Reverting..." });

			const result = await revertAllChanges(session.workingDir);

			try {
				await ctx.editMessageText(
					result.success ? "✅ All changes reverted." : `❌ ${result.message}`,
				);
			} catch {
				await ctx.reply(
					result.success ? "✅ All changes reverted." : `❌ ${result.message}`,
				);
			}

			await auditLog(
				userId,
				username,
				"DIFF_REVERT",
				"revert all",
				result.message,
			);
			return;
		}

		// Show confirmation dialog (no subAction)
		await ctx.answerCallbackQuery({ text: "Confirm revert?" });

		const keyboard = new InlineKeyboard()
			.text("⚠️ Yes, Revert All", "diff:revert:confirm")
			.text("Cancel", "diff:revert:cancel");

		try {
			await ctx.editMessageText(
				"⚠️ <b>Confirm Revert</b>\n\nThis will discard ALL uncommitted changes (staged and unstaged).\n\n<b>This action cannot be undone!</b>",
				{ parse_mode: "HTML", reply_markup: keyboard },
			);
		} catch {
			await ctx.reply(
				"⚠️ <b>Confirm Revert</b>\n\nThis will discard ALL uncommitted changes.\n\n<b>This action cannot be undone!</b>",
				{ parse_mode: "HTML", reply_markup: keyboard },
			);
		}
		return;
	}

	await ctx.answerCallbackQuery({ text: "Unknown action" });
}
