/**
 * Group chat helpers and message interrupt utilities for Claude Telegram Bot.
 *
 * Handles bot mention detection, private messaging, and unauthorized access.
 */

import type { Context } from "grammy";
import { botEvents } from "../events";

// ============== Message Interrupt ==============

export async function checkInterrupt(text: string): Promise<string> {
	if (!text || !text.startsWith("!")) {
		return text;
	}

	const strippedText = text.slice(1).trimStart();

	if (botEvents.getSessionState()) {
		console.log("! prefix - requesting interrupt");
		botEvents.emit("interruptRequested", undefined);
		await Bun.sleep(100);
	}

	return strippedText;
}

// ============== Message Effects ==============

/**
 * Returns effect ID only for private chats; groups don't support message effects.
 */
export function effectFor(ctx: Context, effectId: string): string | undefined {
	return ctx.chat?.type === "private" ? effectId : undefined;
}

// ============== Group Chat Helpers ==============

/**
 * Check if the bot was mentioned in the message.
 * In groups, bot only responds when explicitly mentioned with @bot_username.
 * Exception: If group only has 2 members (user + bot), no mention needed.
 */
export async function isBotMentioned(
	ctx: Context,
	botUsername: string,
): Promise<boolean> {
	const chat = ctx.chat;
	if (!chat) return false;

	console.log(
		`[isBotMentioned] Chat type: ${chat.type}, botUsername: "${botUsername}"`,
	);

	// In private chats, always respond
	if (chat.type === "private") {
		console.log("[isBotMentioned] ✅ Private chat - always respond");
		return true;
	}

	// In groups/supergroups, check if it's just user + bot
	if (chat.type === "group" || chat.type === "supergroup") {
		try {
			const memberCount = await ctx.api.getChatMemberCount(chat.id);
			// If only 2 members (user + bot), no mention needed
			if (memberCount === 2) {
				return true;
			}
		} catch (error) {
			console.error("Failed to get member count:", error);
			// Fall through to mention check on error
		}
	}

	// In groups/supergroups/channels, check for mention
	const message = ctx.message;
	if (!message) return false;

	// Photos/media carry their text + mentions in caption / caption_entities,
	// not text / entities — so @mentioning the bot on a photo is detected too.
	const text = message.text || message.caption || "";
	const entities = message.entities || message.caption_entities || [];

	// Check entities for mentions and bot commands
	for (const entity of entities) {
		// Check regular mentions (@username in text)
		if (entity.type === "mention" || entity.type === "text_mention") {
			const mentionText = text.slice(
				entity.offset,
				entity.offset + entity.length,
			);
			console.log(
				`[isBotMentioned] Found mention entity: "${mentionText}", botUsername: "${botUsername}"`,
			);
			if (mentionText === `@${botUsername}`) {
				console.log("[isBotMentioned] ✅ Matched bot mention");
				return true;
			}
		}

		// Check bot commands with @username (/command@username)
		if (entity.type === "bot_command") {
			const commandText = text.slice(
				entity.offset,
				entity.offset + entity.length,
			);
			console.log(
				`[isBotMentioned] Found bot_command entity: "${commandText}", botUsername: "${botUsername}"`,
			);
			// Command format: /command@username
			if (commandText.includes(`@${botUsername}`)) {
				console.log("[isBotMentioned] ✅ Matched bot command with username");
				return true;
			}
		}
	}

	// Also check if message is a reply to bot's message
	if (message.reply_to_message?.from?.username === botUsername) {
		console.log("[isBotMentioned] ✅ Reply to bot's message");
		return true;
	}

	console.log("[isBotMentioned] ❌ Bot not mentioned - will ignore in group");
	return false;
}

/**
 * Send private message to user (used for unauthorized notifications in groups).
 */
export async function sendPrivateMessage(
	ctx: Context,
	userId: number,
	text: string,
	options?: { parse_mode?: "HTML" | "Markdown" },
): Promise<boolean> {
	try {
		await ctx.api.sendMessage(userId, text, options);
		return true;
	} catch (error) {
		console.error(`Failed to send private message to user ${userId}:`, error);
		return false;
	}
}

/**
 * Handle unauthorized access with appropriate response based on chat type.
 * In groups: sends private message to user.
 * In private chats: replies directly.
 * Returns true if unauthorized (handler should return).
 */
export async function handleUnauthorized(
	ctx: Context,
	userId: number,
): Promise<boolean> {
	const chat = ctx.chat;
	if (chat && chat.type !== "private") {
		// In groups, send private message
		await sendPrivateMessage(
			ctx,
			userId,
			"⚠️ 您未被授權使用此機器人。\n\n如需存取權限，請聯繫機器人擁有者。",
		);
	} else {
		// In private chat, reply directly
		await ctx.reply("Unauthorized. Contact the bot owner for access.");
	}
	return true;
}
