/**
 * User-friendly error message formatting.
 */

import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";

const ERROR_PATTERNS: { pattern: RegExp; message: string }[] = [
	{
		pattern: /timeout/i,
		message:
			"The operation took too long. Try a simpler request or break it into smaller steps.",
	},
	{
		pattern: /too many requests|rate limit|retry after/i,
		message: "Claude is busy right now. Please wait a moment and try again.",
	},
	{
		// Anthropic overload (HTTP 529 / overloaded_error). Non-standard status,
		// so it must be matched before the generic 5xx rule below.
		pattern: /overloaded|server_error|\b529\b/i,
		message:
			"Claude is overloaded right now. Please wait a moment and resend your message.",
	},
	{
		pattern: /api_error|internal server error|request_id|status code 5\d\d|http 5\d\d|500|502|503|504/i,
		message: "Service is temporarily unavailable. Please try again in a moment.",
	},
	{
		pattern: /etimedout|econnreset|enotfound/i,
		message: "Connection issue. Please check your network and try again.",
	},
	{
		pattern: /cancelled|aborted/i,
		message: "Request was cancelled.",
	},
	{
		pattern: /unsafe command|blocked/i,
		message: "That operation isn't allowed for safety reasons.",
	},
	{
		pattern: /file access|outside allowed paths/i,
		message: "Claude can't access that file location.",
	},
	{
		pattern: /authentication|unauthorized|401/i,
		message: "Authentication issue. Please check your credentials.",
	},
];

/**
 * Convert technical errors to user-friendly messages.
 */
export function formatUserError(error: Error): string {
	const errorStr = error.message || String(error);

	for (const { pattern, message } of ERROR_PATTERNS) {
		if (pattern.test(errorStr)) {
			return message;
		}
	}

	// Generic fallback with truncation
	const truncated =
		errorStr.length > 200 ? errorStr.slice(0, 200) + "..." : errorStr;
	return `Error: ${truncated || "An unexpected error occurred"}`;
}

/**
 * Map a typed assistant-message API error (from the Agent SDK's
 * `SDKAssistantMessage.error` field) to a friendly, user-facing message.
 *
 * The SDK surfaces transient API failures (e.g. HTTP 529 overloaded ->
 * `server_error`) as an assistant message whose text content is the raw
 * `API Error: 529 {...}` JSON. Use this to show a clean message instead of
 * leaking that JSON to the chat.
 */
export function apiErrorMessage(error: SDKAssistantMessageError): string {
	switch (error) {
		case "rate_limit":
		case "server_error":
			return "⚠️ Claude 暫時過載或忙線中，請稍候再傳一次。";
		case "authentication_failed":
			return "⚠️ API 認證失敗，請檢查 Anthropic 憑證設定。";
		case "billing_error":
			return "⚠️ Anthropic 帳戶帳務異常，請檢查方案或額度。";
		case "invalid_request":
			return "⚠️ 這則請求無法處理，請換個說法再試一次。";
		default:
			return "⚠️ Claude 處理時發生錯誤，請稍候再試一次。";
	}
}
