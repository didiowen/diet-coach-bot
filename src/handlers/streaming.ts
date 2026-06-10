/**
 * Shared streaming callback for Claude Telegram Bot handlers.
 *
 * Provides a reusable status callback for streaming Claude responses.
 */

import type { Context } from "grammy";
import { GrammyError, InlineKeyboard } from "grammy";
import type { Message } from "grammy/types";
import {
	BUTTON_LABEL_MAX_LENGTH,
	MESSAGE_EFFECTS,
	STREAMING_THROTTLE_MS,
	TELEGRAM_MESSAGE_LIMIT,
	TELEGRAM_SAFE_LIMIT,
	TOKEN_WARNING_THRESHOLD,
} from "../config";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";
import { safeTelegramCall, withRetry } from "../telegram-api";
import { sessionManager } from "../session";
import { effectFor } from "../utils";
import type { StatusCallback } from "../types";
import {
	telegramMessageQueue,
	MessagePriority,
	MessageType,
} from "../telegram-message-queue";
import { telegramRateLimiter } from "../telegram-rate-limiter";

/**
 * Create inline keyboard for ask_user options.
 */
export function createAskUserKeyboard(
	requestId: string,
	options: string[],
): InlineKeyboard {
	const keyboard = new InlineKeyboard();
	for (let idx = 0; idx < options.length; idx++) {
		const option = options[idx]!;
		// Truncate long options for button display
		const display =
			option.length > BUTTON_LABEL_MAX_LENGTH
				? `${option.slice(0, BUTTON_LABEL_MAX_LENGTH)}...`
				: option;
		const callbackData = `askuser:${requestId}:${idx}`;
		keyboard.text(display, callbackData).row();
	}
	return keyboard;
}

/**
 * Check for pending ask-user requests and send inline keyboards.
 */
export async function checkPendingAskUserRequests(
	ctx: Context,
	chatId: number,
): Promise<boolean> {
	const glob = new Bun.Glob("ask-user-*.json");
	let buttonsSent = false;

	for await (const filename of glob.scan({ cwd: "/tmp", absolute: false })) {
		const filepath = `/tmp/${filename}`;
		try {
			const file = Bun.file(filepath);
			const text = await file.text();
			const data = JSON.parse(text);

			// Only process pending requests for this chat
			if (data.status !== "pending") continue;
			if (String(data.chat_id) !== String(chatId)) continue;

			const question = data.question || "Please choose:";
			const options = data.options || [];
			const requestId = data.request_id || "";

			if (options.length > 0 && requestId) {
				const keyboard = createAskUserKeyboard(requestId, options);
				await ctx.reply(`❓ ${question}`, { reply_markup: keyboard });
				buttonsSent = true;

				// Mark as sent
				data.status = "sent";
				await Bun.write(filepath, JSON.stringify(data));
			}
		} catch (error) {
			console.warn(`Failed to process ask-user file ${filepath}:`, error);
		}
	}

	return buttonsSent;
}

// Spinner frames for tool animation
const SPINNER_FRAMES = ["", ".", "..", "...", "....", "....."];
const TOOL_SPINNER_INTERVAL_MS = Number.parseInt(
	process.env.TOOL_SPINNER_INTERVAL_MS || "1500",
	10,
); // Update every 1.5 seconds

/**
 * Tracks state for streaming message updates.
 */
export class StreamingState {
	textMessages = new Map<number, Message>(); // segment_id -> telegram message
	toolMessages: Message[] = []; // ephemeral tool status messages
	lastEditTimes = new Map<number, number>(); // segment_id -> last edit time
	lastContent = new Map<number, string>(); // segment_id -> last sent content
	toolStartTime: number | null = null; // timestamp when current tool started
	hasToolExecution = false; // track if any tools were executed

	// Tool spinner state
	currentToolMsg: Message | null = null;
	currentToolContent = "";
	toolSpinnerInterval: ReturnType<typeof setInterval> | null = null;
	spinnerIndex = 0;

	// Track current tool for completion
	currentToolName: string | null = null;
	currentToolEmoji: string | null = null;

	/**
	 * Stop the tool spinner animation.
	 */
	stopToolSpinner(): void {
		if (this.toolSpinnerInterval) {
			clearInterval(this.toolSpinnerInterval);
			this.toolSpinnerInterval = null;
		}
		this.currentToolMsg = null;
		this.currentToolContent = "";
		this.spinnerIndex = 0;
	}
}

/**
 * Create a status callback for streaming updates.
 */
export function createStatusCallback(
	ctx: Context,
	state: StreamingState,
	chatId?: number,
): StatusCallback {
	return async (
		statusType: string,
		content: string,
		segmentId?: number,
		usage?,
	) => {
		try {
			if (statusType === "thinking") {
				// Enqueue thinking message (LOW priority, may be hidden by config)
				const preview =
					content.length > 500 ? `${content.slice(0, 500)}...` : content;
				const escaped = escapeHtml(preview);

				await telegramMessageQueue.enqueue(
					ctx,
					MessageType.THINKING,
					MessagePriority.LOW,
					`🧠 <i>${escaped}</i>`,
					async () => {
						const msg = await withRetry(() =>
							ctx.reply(`🧠 <i>${escaped}</i>`, {
								parse_mode: "HTML",
							}),
						);
						state.toolMessages.push(msg);
						return msg;
					},
				);
			} else if (statusType === "tool") {
				// Mark previous tool as done before starting new one
				if (state.currentToolName && state.currentToolEmoji && chatId) {
					await telegramMessageQueue.enqueue(
						ctx,
						MessageType.TOOL_STATUS,
						MessagePriority.LOW,
						state.currentToolEmoji,
						async () => ctx.reply("", { parse_mode: "HTML" }),
						{
							toolName: state.currentToolName,
							toolStatus: "done",
						},
					);
				}

				// Stop previous tool spinner if any
				state.stopToolSpinner();
				state.hasToolExecution = true;

				state.toolStartTime = Date.now();
				state.currentToolContent = content;
				state.spinnerIndex = 0;

				// Extract tool name and emoji from content (format: "emoji tool_name")
				const match = content.match(/^(.+?)\s+(.+)$/);
				const emoji = match?.[1] || "🔧";
				const toolName = match?.[2] || "Tool";

				// Save current tool for later completion
				state.currentToolName = toolName;
				state.currentToolEmoji = emoji;

				// Enqueue tool status (will be merged with other tools)
				await telegramMessageQueue.enqueue(
					ctx,
					MessageType.TOOL_STATUS,
					MessagePriority.LOW,
					emoji,
					async () => ctx.reply(content, { parse_mode: "HTML" }),
					{ toolName, toolStatus: "running" },
				);

				// Note: We no longer use individual tool messages with spinners
				// Tools are now displayed in a merged overview message
			} else if (statusType === "text" && segmentId !== undefined) {
				// Mark current tool as done when text starts (tool finished)
				if (state.currentToolName && state.currentToolEmoji && chatId) {
					await telegramMessageQueue.enqueue(
						ctx,
						MessageType.TOOL_STATUS,
						MessagePriority.LOW,
						state.currentToolEmoji,
						async () => ctx.reply("", { parse_mode: "HTML" }),
						{
							toolName: state.currentToolName,
							toolStatus: "done",
						},
					);
					state.currentToolName = null;
					state.currentToolEmoji = null;
				}
				// New text segment means tool finished, stop spinner
				state.stopToolSpinner();
				const now = Date.now();
				const lastEdit = state.lastEditTimes.get(segmentId) || 0;

				if (!state.textMessages.has(segmentId)) {
					// New segment - create message (HIGH priority)
					const display =
						content.length > TELEGRAM_SAFE_LIMIT
							? `${content.slice(0, TELEGRAM_SAFE_LIMIT)}...`
							: content;
					const formatted = convertMarkdownToHtml(display);

					await telegramMessageQueue.enqueue(
						ctx,
						MessageType.TEXT_UPDATE,
						MessagePriority.HIGH,
						formatted,
						async () => {
							await telegramRateLimiter.acquireSlot(ctx.chat?.id);
							try {
								const msg = await withRetry(() =>
									ctx.reply(formatted, { parse_mode: "HTML" }),
								);
								state.textMessages.set(segmentId, msg);
								state.lastContent.set(segmentId, formatted);
								return msg;
							} catch (htmlError) {
								if (
									htmlError instanceof GrammyError &&
									htmlError.error_code === 400
								) {
									console.debug(
										"HTML parse rejected by Telegram, using plain text:",
										htmlError.description,
									);
									const msg = await withRetry(() => ctx.reply(display));
									state.textMessages.set(segmentId, msg);
									state.lastContent.set(segmentId, display);
									return msg;
								}
								console.error(
									"Failed to send segment message after retries:",
									htmlError,
								);
								throw htmlError;
							}
						},
						{ segmentId },
					);
					state.lastEditTimes.set(segmentId, now);
				} else if (now - lastEdit > STREAMING_THROTTLE_MS) {
					// Update existing segment message (NORMAL priority, throttled and batched)
					const msg = state.textMessages.get(segmentId)!;
					const display =
						content.length > TELEGRAM_SAFE_LIMIT
							? `${content.slice(0, TELEGRAM_SAFE_LIMIT)}...`
							: content;
					const formatted = convertMarkdownToHtml(display);

					// Skip if content unchanged
					if (formatted === state.lastContent.get(segmentId)) {
						return;
					}

					await telegramMessageQueue.enqueue(
						ctx,
						MessageType.TEXT_UPDATE,
						MessagePriority.NORMAL,
						formatted,
						async () => {
							await telegramRateLimiter.acquireSlot(ctx.chat?.id);
							try {
								await ctx.api.editMessageText(
									msg.chat.id,
									msg.message_id,
									formatted,
									{ parse_mode: "HTML" },
								);
								state.lastContent.set(segmentId, formatted);
								return msg;
							} catch (htmlError) {
								console.debug(
									"HTML edit failed, trying plain text:",
									htmlError,
								);
								await ctx.api.editMessageText(
									msg.chat.id,
									msg.message_id,
									formatted,
								);
								state.lastContent.set(segmentId, formatted);
								return msg;
							}
						},
						{ segmentId, messageId: msg.message_id },
					);

					state.lastEditTimes.set(segmentId, now);
				}
			} else if (statusType === "segment_end" && segmentId !== undefined) {
				if (state.textMessages.has(segmentId) && content) {
					const msg = state.textMessages.get(segmentId)!;
					const formatted = convertMarkdownToHtml(content);

					// Skip if content unchanged
					if (formatted === state.lastContent.get(segmentId)) {
						return;
					}

					if (formatted.length <= TELEGRAM_MESSAGE_LIMIT) {
						await telegramRateLimiter.acquireSlot(ctx.chat?.id);
						await safeTelegramCall("editFinalMessage", () =>
							ctx.api.editMessageText(msg.chat.id, msg.message_id, formatted, {
								parse_mode: "HTML",
							}),
						);
					} else {
						// Too long - delete and split
						try {
							await telegramRateLimiter.acquireSlot(ctx.chat?.id);
							await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
						} catch (error) {
							console.debug("Failed to delete message for splitting:", error);
						}
						for (let i = 0; i < formatted.length; i += TELEGRAM_SAFE_LIMIT) {
							const chunk = formatted.slice(i, i + TELEGRAM_SAFE_LIMIT);
							await telegramRateLimiter.acquireSlot(ctx.chat?.id);
							try {
								await withRetry(() => ctx.reply(chunk, { parse_mode: "HTML" }));
							} catch (htmlError) {
								if (
									htmlError instanceof GrammyError &&
									htmlError.error_code === 400
								) {
									console.debug(
										"HTML chunk rejected, using plain text:",
										htmlError.description,
									);
									await withRetry(() => ctx.reply(chunk));
								} else {
									console.error(
										"Failed to send chunk after retries:",
										htmlError,
									);
								}
							}
						}
					}
				}
			} else if (statusType === "timeout_check") {
				// Show timeout prompt with inline keyboard (CRITICAL priority)
				const keyboard = new InlineKeyboard()
					.text("✋ 中斷", "timeout:abort")
					.text("▶️ 繼續", "timeout:continue");

				await telegramMessageQueue.enqueue(
					ctx,
					MessageType.BUTTON,
					MessagePriority.CRITICAL,
					content,
					async () => {
						await telegramRateLimiter.acquireSlot(ctx.chat?.id);
						const msg = await withRetry(() =>
							ctx.reply(content, {
								reply_markup: keyboard,
							}),
						);
						state.toolMessages.push(msg);
						return msg;
					},
				);
			} else if (statusType === "queued") {
				// User's query was queued - show position (HIGH priority)
				await telegramMessageQueue.enqueue(
					ctx,
					MessageType.NOTIFICATION,
					MessagePriority.HIGH,
					`⏳ ${content}`,
					async () => {
						await telegramRateLimiter.acquireSlot(ctx.chat?.id);
						const msg = await withRetry(() => ctx.reply(`⏳ ${content}`));
						state.toolMessages.push(msg);
						return msg;
					},
				);
			} else if (statusType === "queue_start") {
				// Queued query is now starting (HIGH priority)
				await telegramMessageQueue.enqueue(
					ctx,
					MessageType.NOTIFICATION,
					MessagePriority.HIGH,
					`🚀 ${content}`,
					async () => {
						await telegramRateLimiter.acquireSlot(ctx.chat?.id);
						const msg = await withRetry(() => ctx.reply(`🚀 ${content}`));
						state.toolMessages.push(msg);
						return msg;
					},
				);
			} else if (statusType === "done") {
				// Stop any running tool spinner
				state.stopToolSpinner();

				// Delete tool overview message if exists
				if (chatId) {
					await telegramMessageQueue.deleteToolOverview(ctx, chatId);
				}

				// Delete tool messages - text messages stay
				for (const toolMsg of state.toolMessages) {
					try {
						await telegramRateLimiter.acquireSlot(ctx.chat?.id);
						await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
					} catch (error) {
						console.debug("Failed to delete tool message:", error);
					}
				}

				// Build usage info string if available
				// Action buttons now always shown (not conditional on hasToolExecution)
				return; /* done footer disabled by patch-ctb.sh */ let doneMessage = "Done";
				if (usage) {
					const inK = Math.round(usage.input_tokens / 1000);
					const outK = Math.round(usage.output_tokens / 1000);
					const cacheK = usage.cache_read_input_tokens
						? Math.round(usage.cache_read_input_tokens / 1000)
						: 0;
					doneMessage += ` | ${inK}K→${outK}K`;
					if (cacheK > 0) {
						doneMessage += ` (⚡${cacheK}K)`;
					}
				}

				// Check session total token usage and add warning if needed
				if (chatId) {
					const session = sessionManager.getSession(chatId);
					const totalTokens =
						session.totalInputTokens + session.totalOutputTokens;

					if (totalTokens > TOKEN_WARNING_THRESHOLD) {
						const totalK = Math.round(totalTokens / 1000);
						doneMessage += ` | ⚠️ ${totalK}K total`;
					}
				}

				// Show action buttons after response completes (CRITICAL priority)
				const actionKeyboard = new InlineKeyboard()
					.text("Undo", "action:undo")
					.text("Commit", "action:commit")
					.text("Yes", "action:yes")
					.text("Handoff", "action:handoff");

				await telegramMessageQueue.enqueue(
					ctx,
					MessageType.BUTTON,
					MessagePriority.CRITICAL,
					doneMessage,
					async () => {
						await telegramRateLimiter.acquireSlot(ctx.chat?.id);
						return await withRetry(() =>
							ctx.reply(doneMessage, {
								/* reply_markup removed by patch-ctb.sh */
								message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.CONFETTI),
							}),
						);
					},
				);
			}
		} catch (error) {
			console.error("Status callback error:", error);
		}
	};
}
