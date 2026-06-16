/**
 * Download a Telegram file (photo / voice / document) to a local path, with
 * retry on transient failures.
 *
 * Both `getFile()` and the subsequent file fetch can fail on Telegram's side
 * with a 504 Gateway Timeout, or drop the connection (ECONNRESET / socket
 * closed). A single attempt surfaces these as a hard "download failed" to the
 * user even though a retry a moment later almost always succeeds. So we retry
 * transient errors with exponential backoff, and leave permanent errors
 * (e.g. a 4xx for a bad file_id) to fail fast.
 */

import type { Context } from "grammy";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500; // backoff: 500ms, then 1s

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Decide whether an error is worth retrying. Telegram 5xx (notably 504 on
 * getFile) and network resets/timeouts are transient; 4xx are not.
 */
function isTransient(err: unknown): boolean {
	// grammY's GrammyError carries the HTTP status as `error_code`.
	const code = (err as { error_code?: number })?.error_code;
	if (typeof code === "number") return code >= 500;

	const msg = err instanceof Error ? err.message : String(err);
	return /\b5\d\d\b|gateway timeout|econnreset|etimedout|socket connection|network request/i.test(
		msg,
	);
}

/**
 * Resolve and download the file attached to `ctx` into `destPath`.
 * Returns `destPath` on success; throws the last error after all retries.
 */
export async function downloadTelegramFile(
	ctx: Context,
	destPath: string,
): Promise<string> {
	let lastErr: unknown;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const file = await ctx.getFile();
			const response = await fetch(
				`https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`,
			);
			if (!response.ok) {
				// Don't write an error page into the file — treat as a failure so
				// a 5xx here is retried like a getFile 504.
				throw new Error(`file fetch failed: HTTP ${response.status}`);
			}
			await Bun.write(destPath, await response.arrayBuffer());
			return destPath;
		} catch (err) {
			lastErr = err;
			if (attempt === MAX_ATTEMPTS || !isTransient(err)) break;
			await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
		}
	}

	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
