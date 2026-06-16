/**
 * Action callback handler for Claude Telegram Bot.
 * Handles undo/commit/yes/handoff action buttons.
 */

import type { Context } from "grammy";
import { MESSAGE_EFFECTS } from "../../config";
import { formatUserError } from "../../errors";
import { queryQueue } from "../../query-queue";
import { sessionManager } from "../../session";
import { auditLog, effectFor, startTypingIndicator } from "../../utils";
import { createStatusCallback, StreamingState } from "../streaming";

/**
 * Handle action callbacks (undo/commit/yes/handoff).
 * Format: action:undo, action:commit, action:yes, action:handoff
 */
export async function handleActionCallback(
	ctx: Context,
	userId: number,
	username: string,
	callbackData: string,
): Promise<void> {
	const action = callbackData.split(":")[1];

	const chatId = ctx.chat?.id;
	if (!chatId) return;
	const session = sessionManager.getSession(chatId);

	// Delete the button message first
	try {
		await ctx.deleteMessage();
	} catch {
		// Message may have been deleted
	}

	// Handle handoff separately - it's not a command but a special action
	if (action === "handoff") {
		await ctx.answerCallbackQuery({ text: "Starting handoff..." });
		// Echo user's choice
		await ctx.reply("👆 選擇: Handoff");
		const lastResponse = session.lastBotResponse;

		if (!lastResponse) {
			await ctx.reply("❌ No response to hand off");
			return;
		}

		// Save the response as handoff context
		session.setHandoffContext(lastResponse);

		// Kill session
		await session.kill();

		await ctx.reply(
			"✅ Session compressed. Last response will be used as context in your next message.",
			{ message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.CONFETTI) },
		);
		return;
	}

	// Map action to Claude command
	const commandMap: Record<string, string> = {
		undo: "/undo",
		commit: "stage all and commit",
		yes: "yes",
	};

	const command = commandMap[action || ""];
	if (!command) {
		await ctx.answerCallbackQuery({ text: "Unknown action" });
		return;
	}

	await ctx.answerCallbackQuery({ text: `執行 ${command}...` });

	// Map action to display name
	const actionDisplayMap: Record<string, string> = {
		undo: "Undo",
		commit: "Commit",
		yes: "Yes",
	};
	const displayName = actionDisplayMap[action || ""] || action;

	// Echo user's choice
	await ctx.reply(`👆 選擇: ${displayName}`);

	// Send the command to Claude
	const typing = startTypingIndicator(ctx);
	const state = new StreamingState();
	const statusCallback = createStatusCallback(ctx, state, ctx.chat?.id);

	try {
		const response = await queryQueue.sendMessage(
			session,
			command,
			username,
			userId,
			statusCallback,
			ctx.chat?.id,
			ctx,
		);
		await auditLog(userId, username, "ACTION", command, response);
	} catch (error) {
		console.error("Error executing action:", error);
		const userMessage = formatUserError(
			error instanceof Error ? error : new Error(String(error)),
		);
		await ctx.reply(`❌ 執行失敗: ${userMessage}`, {
			message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.POOP),
		});
	} finally {
		typing.stop();
	}
}
