/**
 * Configuration command handlers.
 *
 * /model, /provider, /think, /plan, /compact, /cost
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import {
	AGENT_PROVIDERS,
	type AgentProviderId,
	MESSAGE_EFFECTS,
} from "../../config";
import { sessionManager } from "../../session";
import { effectFor } from "../../utils";
import { checkCommandAuth } from "./utils";

/**
 * /model - Switch between models.
 */
export async function handleModel(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	const text = ctx.message?.text || "";
	const match = text.match(/^\/model\s+(\w+)$/i);

	if (!match) {
		const current = session.currentModel;
		await ctx.reply(
			`\u{1F916} <b>Model Selection</b>\n\nCurrent: <b>${current}</b>\n\nUsage: <code>/model &lt;name&gt;</code>\n\nAvailable:\n\u2022 <code>/model sonnet</code> - Fast, balanced\n\u2022 <code>/model opus</code> - Powerful, capable\n\u2022 <code>/model haiku</code> - Fastest, cheapest\n\u2022 <code>/model fable</code> - Most capable, premium`,
			{ parse_mode: "HTML" },
		);
		return;
	}

	const modelName = match[1]?.toLowerCase();
	if (
		modelName !== "sonnet" &&
		modelName !== "opus" &&
		modelName !== "haiku" &&
		modelName !== "fable"
	) {
		await ctx.reply(
			`\u274C Unknown model: ${modelName}\n\nUse: sonnet, opus, haiku, or fable`,
		);
		return;
	}

	session.currentModel = modelName;
	await ctx.reply(`\u{1F916} Switched to <b>${modelName}</b>`, {
		parse_mode: "HTML",
	});
}

/**
 * /provider - Switch between agent providers.
 */
export async function handleProvider(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	const text = ctx.message?.text || "";
	const match = text.match(/^\/provider\s+(\w+)$/i);

	if (!match) {
		const current = session.currentProvider;
		const keyboard = new InlineKeyboard();
		for (const provider of AGENT_PROVIDERS) {
			const label =
				provider === current
					? `\u2705 ${provider}`
					: `\u26AA\uFE0F ${provider}`;
			keyboard.text(label, `provider:set:${provider}`).row();
		}

		await ctx.reply(
			`\u{1F500} <b>Provider Selection</b>\n\nCurrent: <b>${current}</b>\n\nChoose a provider below:`,
			{ parse_mode: "HTML", reply_markup: keyboard },
		);
		return;
	}

	const providerName = match[1]?.toLowerCase() as AgentProviderId | undefined;
	if (!providerName || !AGENT_PROVIDERS.includes(providerName)) {
		await ctx.reply(
			`\u274C Unknown provider: ${providerName}\n\nAvailable: ${AGENT_PROVIDERS.join(
				", ",
			)}`,
		);
		return;
	}

	const [success, message] = await session.setProvider(providerName);
	await ctx.reply(success ? `\u{1F500} ${message}` : `\u274C ${message}`, {
		parse_mode: "HTML",
	});
}

/**
 * /think - Force extended thinking for next message.
 */
export async function handleThink(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	const text = ctx.message?.text || "";
	const match = text.match(/^\/think\s+(\w+)$/i);

	let tokens: number;
	let label: string;

	if (!match) {
		// Default to deep thinking
		tokens = 50000;
		label = "deep (50K tokens)";
	} else {
		const level = match[1]?.toLowerCase();
		if (level === "off" || level === "0") {
			tokens = 0;
			label = "off";
		} else if (level === "normal" || level === "10k") {
			tokens = 10000;
			label = "normal (10K tokens)";
		} else if (level === "deep" || level === "50k") {
			tokens = 50000;
			label = "deep (50K tokens)";
		} else {
			await ctx.reply(
				`\u274C Unknown level: ${level}\n\nUse: off, normal, deep`,
			);
			return;
		}
	}

	session.forceThinking = tokens;
	await ctx.reply(`\u{1F9E0} Next message will use <b>${label}</b> thinking`, {
		parse_mode: "HTML",
	});
}

/**
 * /plan - Toggle planning mode.
 */
export async function handlePlan(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	session.planMode = !session.planMode;

	if (session.planMode) {
		await ctx.reply(
			"\u{1F4CB} <b>Plan mode ON</b>\n\n" +
				"Claude will analyze and plan without executing tools.\n" +
				"Use <code>/plan</code> again to exit.",
			{ parse_mode: "HTML" },
		);
	} else {
		await ctx.reply("\u{1F4CB} Plan mode OFF - Normal execution resumed");
	}
}

/**
 * /compact - Trigger SDK context compaction.
 */
export async function handleCompact(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	if (!session.isActive) {
		await ctx.reply("\u274C No active session to compact.", {
			message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.THUMBS_DOWN),
		});
		return;
	}

	// Send "/compact" to Claude SDK to trigger manual compaction
	const { handleText } = await import("../text");
	const fakeCtx = {
		...ctx,
		message: {
			...ctx.message,
			text: "/compact",
		},
	} as Context;

	await handleText(fakeCtx);
}

/**
 * /cost - Show token usage and estimated cost.
 */
export async function handleCost(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	const cost = session.estimateCost();
	const formatNum = (n: number) => n.toLocaleString();
	const formatCost = (n: number) => `$${n.toFixed(4)}`;

	await ctx.reply(
		`\u{1F4B0} <b>Session Usage</b>\n\nModel: <b>${session.currentModel}</b>\n\n<b>Tokens:</b>\n\u2022 Input: ${formatNum(session.totalInputTokens)}\n\u2022 Output: ${formatNum(session.totalOutputTokens)}\n\u2022 Cache read: ${formatNum(session.totalCacheReadTokens)}\n\n<b>Estimated Cost:</b>\n\u2022 Input: ${formatCost(cost.inputCost)}\n\u2022 Output: ${formatCost(cost.outputCost)}\n\u2022 Total: <b>${formatCost(cost.total)}</b>`,
		{ parse_mode: "HTML" },
	);
}
