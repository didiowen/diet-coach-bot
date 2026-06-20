/**
 * Git-related command handlers.
 *
 * /worktree, /branch, /merge, /skill, /diff
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { MESSAGE_EFFECTS } from "../../config";
import { escapeHtml } from "../../formatting";
import { sessionManager } from "../../session";
import { effectFor } from "../../utils";
import {
	getCombinedDiff,
	getGitDiff,
	getMergeInfo,
	getWorkingTreeStatus,
	listBranches,
} from "../../git";
import { BRANCH_LIST_LIMIT, CALLBACK_DATA_LIMIT, checkCommandAuth } from "./utils";

/**
 * /worktree - Create a git worktree and switch into it.
 */
export async function handleWorktree(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;

	if (!userId || !chatId) {
		return;
	}

	const session = sessionManager.getSession(chatId);

	if (session.isRunning) {
		await ctx.reply("\u26A0\uFE0F A query is running. Use /stop first.");
		return;
	}

	const status = await getWorkingTreeStatus(session.workingDir);
	if (!status.success) {
		await ctx.reply(`\u274C ${status.message}`, {
			message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.THUMBS_DOWN),
		});
		return;
	}
	if (status.dirty) {
		await ctx.reply(
			"\u26A0\uFE0F Working tree has uncommitted changes. Commit or stash before creating a worktree.",
		);
		return;
	}

	const pending = session.peekWorktreeRequest(userId, chatId);
	if (pending) {
		const age = Math.floor((Date.now() - pending.createdAt.getTime()) / 1000);
		await ctx.reply(
			`\u26A0\uFE0F Already waiting for a branch name (${age}s ago). Send the branch name or /cancel.`,
		);
		return;
	}

	if (!session.requestWorktree(userId, chatId)) {
		await ctx.reply(
			"\u26A0\uFE0F Already waiting for a branch name. Send the branch name or /cancel.",
		);
		return;
	}

	// Save current session (if any) before switching
	session.flushSession();

	await ctx.reply(
		"\u{1F33F} <b>Worktree Setup</b>\n\n" +
			"Send the branch name to use (e.g. <code>feature/something-new</code>).\n" +
			"Reply with /cancel to abort.",
		{ parse_mode: "HTML" },
	);
}

/**
 * /branch - List branches and switch via worktree.
 */
export async function handleBranch(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	if (session.isRunning) {
		await ctx.reply("\u26A0\uFE0F A query is running. Use /stop first.");
		return;
	}

	const status = await getWorkingTreeStatus(session.workingDir);
	if (!status.success) {
		await ctx.reply(`\u274C ${status.message}`, {
			message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.THUMBS_DOWN),
		});
		return;
	}
	if (status.dirty) {
		await ctx.reply(
			"\u26A0\uFE0F Working tree has uncommitted changes. Commit or stash before switching branches.",
		);
		return;
	}

	const result = await listBranches(session.workingDir);
	if (!result.success) {
		await ctx.reply(`\u274C ${result.message}`, {
			message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.THUMBS_DOWN),
		});
		return;
	}

	if (result.branches.length === 0) {
		await ctx.reply("\u26A0\uFE0F No branches found.");
		return;
	}

	const keyboard = new InlineKeyboard();
	let omittedByLength = 0;
	let omittedByLimit = 0;
	let included = 0;
	for (const branch of result.branches) {
		if (included >= BRANCH_LIST_LIMIT) {
			omittedByLimit++;
			continue;
		}
		const encoded = Buffer.from(branch).toString("base64");
		const callbackData = `branch:switch:${encoded}`;
		if (callbackData.length > CALLBACK_DATA_LIMIT) {
			omittedByLength++;
			continue;
		}
		const label = branch === result.current ? `\u2705 ${branch}` : `\u26AA\uFE0F ${branch}`;
		keyboard.text(label, `branch:switch:${encoded}`).row();
		included++;
	}

	let message = `\u{1F33F} <b>Branches</b>\n\nCurrent: <b>${escapeHtml(result.current ?? "detached")}</b>\n\nSelect a branch to switch:`;
	if (omittedByLength > 0) {
		message += `\n\n<i>Omitted ${omittedByLength} branch${omittedByLength === 1 ? "" : "es"} due to callback length limits.</i>`;
	}
	if (omittedByLimit > 0) {
		message += `\n<i>Showing first ${included} of ${result.branches.length} branches.</i>`;
	}

	if (included === 0) {
		await ctx.reply(
			"\u26A0\uFE0F No branches fit Telegram callback limits. Try shorter branch names.",
		);
		return;
	}

	await ctx.reply(message, {
		parse_mode: "HTML",
		reply_markup: keyboard,
	});
}

/**
 * /merge - Merge current branch into main/master via Claude.
 * Switches to main worktree first so Claude can see and resolve conflicts.
 */
export async function handleMerge(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	if (session.isRunning) {
		await ctx.reply("\u26A0\uFE0F A query is running. Use /stop first.");
		return;
	}

	const status = await getWorkingTreeStatus(session.workingDir);
	if (!status.success) {
		await ctx.reply(`\u274C ${status.message}`, {
			message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.THUMBS_DOWN),
		});
		return;
	}
	if (status.dirty) {
		await ctx.reply(
			"\u26A0\uFE0F Working tree has uncommitted changes. Commit or stash before merging.",
		);
		return;
	}

	const result = await getMergeInfo(session.workingDir);
	if (!result.success) {
		await ctx.reply(`\u274C ${result.message}`, {
			message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.THUMBS_DOWN),
		});
		return;
	}

	const { currentBranch, mainBranch } = result;
	const encodedBranch = Buffer.from(currentBranch).toString("base64");
	const callbackData = `merge:confirm:${encodedBranch}`;
	if (callbackData.length > CALLBACK_DATA_LIMIT) {
		await ctx.reply(
			"\u274C Branch name is too long for Telegram callbacks. Try a shorter branch name.",
		);
		return;
	}

	const keyboard = new InlineKeyboard()
		.text("Merge", callbackData)
		.text("Cancel", "merge:cancel");

	await ctx.reply(
		`\u{1F500} <b>Merge Branch</b>\n\nMerge <code>${escapeHtml(currentBranch)}</code> \u2192 <code>${escapeHtml(mainBranch)}</code>\n\nThis will:\n1. Switch to <code>${escapeHtml(mainBranch)}</code> worktree\n2. Ask Claude to merge and resolve any conflicts`,
		{ parse_mode: "HTML", reply_markup: keyboard },
	);
}

/**
 * /skill - Invoke a Claude Code skill.
 */
export async function handleSkill(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	// Get the skill name and args from command
	const text = ctx.message?.text || "";
	const match = text.match(/^\/skill\s+(\S+)(?:\s+(.*))?$/);

	if (!match) {
		await ctx.reply(
			"\u{1F3AF} <b>Invoke Skill</b>\n\n" +
				"Usage: <code>/skill &lt;name&gt; [args]</code>\n\n" +
				"Examples:\n" +
				"\u2022 <code>/skill commit</code>\n" +
				"\u2022 <code>/skill review-pr 123</code>\n" +
				"\u2022 <code>/skill map</code>",
			{ parse_mode: "HTML" },
		);
		return;
	}

	const skillName = match[1] ?? "";
	const skillArgs = match[2] || "";

	// Build the skill command (Claude Code format: /skill_name args)
	const skillCommand = skillArgs
		? `/${skillName} ${skillArgs}`
		: `/${skillName}`;

	// Send to Claude via handleText
	const { handleText } = await import("../text");
	const fakeCtx = {
		...ctx,
		message: {
			...ctx.message,
			text: skillCommand,
		},
	} as Context;

	await handleText(fakeCtx);
}

/**
 * /diff - Show uncommitted changes with interactive buttons.
 * Variants:
 *   /diff - Show all uncommitted changes (staged + unstaged)
 *   /diff staged - Show only staged changes
 *   /diff <file> - Show diff for specific file
 */
export async function handleDiff(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	// Parse arguments
	const text = ctx.message?.text || "";
	const match = text.match(/^\/diff(?:\s+(.+))?$/);
	const arg = match?.[1]?.trim();

	const isStaged = arg === "staged";
	const file = arg && arg !== "staged" ? arg : undefined;

	// Get diff based on arguments
	const result = isStaged
		? await getGitDiff(session.workingDir, { staged: true })
		: file
			? await getCombinedDiff(session.workingDir, { file })
			: await getCombinedDiff(session.workingDir);

	if (!result.success) {
		await ctx.reply(`\u274C ${result.message}`, {
			message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.THUMBS_DOWN),
		});
		return;
	}

	if (!result.hasChanges) {
		await ctx.reply("\u2728 No uncommitted changes.");
		return;
	}

	// Build summary message
	let message = "\u{1F4DD} <b>Uncommitted Changes</b>";
	if (isStaged) {
		message += " (staged)";
	} else if (file) {
		message += ` (<code>${escapeHtml(file)}</code>)`;
	}
	message += "\n\n";

	// Add file summary
	for (const item of result.summary) {
		message += `<code>${escapeHtml(item.file)}</code> (+${item.added}, -${item.removed})\n`;
	}

	// Count lines in full diff
	const diffLines = result.fullDiff.split("\n").length;
	const DIFF_LINE_THRESHOLD = 50;

	// Build inline keyboard
	const keyboard = new InlineKeyboard();

	// Encode options for callback
	const opts = isStaged ? "staged" : file ? `file:${file}` : "all";
	const encodedOpts = Buffer.from(opts).toString("base64");

	const diffCallback = `diff:view:${encodedOpts}`;
	if (diffCallback.length <= CALLBACK_DATA_LIMIT) {
		keyboard.text("\u{1F4C4} View Diff", diffCallback);
	} else {
		message +=
			"\n<i>Diff view omitted: file path too long for Telegram callbacks.</i>";
	}
	keyboard.text("\u{1F4BE} Commit", "diff:commit");
	keyboard.row();
	keyboard.text("\u26A0\uFE0F Revert All", "diff:revert");

	// If diff is large, mention it
	if (diffLines > DIFF_LINE_THRESHOLD) {
		message += `\n<i>(${diffLines} lines - will send as file)</i>`;
	}

	await ctx.reply(message, {
		parse_mode: "HTML",
		reply_markup: keyboard,
	});
}
