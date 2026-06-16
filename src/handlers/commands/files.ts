/**
 * File-related command handlers.
 *
 * /cd, /file, /image, /pdf, /docx, /html, /bookmarks
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { Context } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import { isBookmarked, loadBookmarks, resolvePath } from "../../bookmarks";
import { MESSAGE_EFFECTS, TELEGRAM_MESSAGE_LIMIT } from "../../config";
import { escapeHtml } from "../../formatting";
import { isPathAllowed } from "../../security";
import { sessionManager } from "../../session";
import { effectFor } from "../../utils";
import { checkCommandAuth } from "./utils";

// Text/code file extensions that should be displayed inline
const TEXT_EXTENSIONS = [
	".txt",
	".md",
	".json",
	".xml",
	".yaml",
	".yml",
	".toml",
	".ini",
	".env",
	".js",
	".ts",
	".jsx",
	".tsx",
	".py",
	".rb",
	".go",
	".rs",
	".java",
	".c",
	".cpp",
	".h",
	".hpp",
	".cs",
	".php",
	".sh",
	".bash",
	".zsh",
	".fish",
	".sql",
	".css",
	".scss",
	".sass",
	".less",
	".html",
	".vue",
	".svelte",
	".dart",
	".kt",
	".swift",
	".m",
	".mm",
	".r",
	".lua",
	".pl",
	".ex",
	".exs",
	".clj",
	".scala",
	".gradle",
	".cmake",
	".make",
	".dockerfile",
];

const IMAGE_EXTENSIONS = [
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".bmp",
	".tiff",
	".tif",
	".svg",
	".heic",
	".heif",
	".avif",
];
const PDF_EXTENSIONS = [".pdf"];
const DOCX_EXTENSIONS = [".docx"];
const HTML_EXTENSIONS = [".html", ".htm"];

const FILE_LIST_SAFE_LIMIT = Math.max(1000, TELEGRAM_MESSAGE_LIMIT - 200);

/**
 * Send a single file to the user. Returns error message or null on success.
 * For small text/code files, displays content inline with syntax highlighting.
 * For large or binary files, sends as document download.
 */
async function sendFile(
	ctx: Context,
	filePath: string,
	workingDir: string,
): Promise<string | null> {
	const { readFileSync } = await import("node:fs");

	// Resolve relative paths from current working directory
	const resolvedPath = resolvePath(filePath, workingDir);

	// Validate path exists
	if (!existsSync(resolvedPath)) {
		return `File not found: ${resolvedPath}`;
	}

	const stats = statSync(resolvedPath);
	if (stats.isDirectory()) {
		return `Cannot send directory: ${resolvedPath}`;
	}

	// Check if path is allowed
	if (!isPathAllowed(resolvedPath)) {
		return `Access denied: ${resolvedPath}`;
	}

	const filename = resolvedPath.split("/").pop() || "file";
	const ext = extname(filename).toLowerCase();
	const isTextFile = TEXT_EXTENSIONS.includes(ext);

	// For small text/code files, display inline with syntax highlighting
	const INLINE_SIZE_LIMIT = 4096; // Telegram message limit
	if (isTextFile && stats.size < INLINE_SIZE_LIMIT) {
		try {
			const content = readFileSync(resolvedPath, "utf-8");

			// Escape HTML special chars
			const escaped = content
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");

			// Truncate if too long for Telegram message
			const maxLen = 3800; // Leave room for header and formatting
			const truncated =
				escaped.length > maxLen
					? `${escaped.slice(0, maxLen)}...\n\n(truncated, use /file to download full file)`
					: escaped;

			await ctx.reply(
				`\u{1F4C4} <b>${escapeHtml(filename)}</b>\n\n<pre><code class="language-${ext.slice(1)}">${truncated}</code></pre>`,
				{ parse_mode: "HTML" },
			);
			return null;
		} catch (error) {
			// If inline display fails, fall through to file download
			console.debug("Failed to display inline, falling back to file:", error);
		}
	}

	// Check file size (Telegram limit is 50MB for bots)
	const MAX_FILE_SIZE = 50 * 1024 * 1024;
	if (stats.size > MAX_FILE_SIZE) {
		const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
		return `File too large: ${resolvedPath} (${sizeMB}MB, max 50MB)`;
	}

	// Send as file download
	try {
		await ctx.replyWithDocument(new InputFile(resolvedPath, filename));
		return null;
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		return `Failed to send: ${errMsg}`;
	}
}

function collectFilesByExtensions(
	rootDir: string,
	extensions: string[],
): string[] {
	const results: string[] = [];
	const extensionSet = new Set(extensions.map((ext) => ext.toLowerCase()));

	const walk = (dir: string): void => {
		if (!isPathAllowed(dir)) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.isFile()) {
				const ext = extname(entry.name).toLowerCase();
				if (extensionSet.has(ext) && isPathAllowed(fullPath)) {
					results.push(fullPath);
				}
			}
		}
	};

	walk(rootDir);
	return results.sort();
}

function buildFileListMessages(
	title: string,
	rootDir: string,
	lines: string[],
): string[] {
	const messages: string[] = [];
	const header = `${title} (${lines.length})\n\u{1F4C1} <code>${escapeHtml(rootDir)}</code>\n\n`;
	const contHeader = `${title} (cont.)\n\n`;
	let current = header;

	for (const line of lines) {
		const addition = `${line}\n`;
		if (current.length + addition.length > FILE_LIST_SAFE_LIMIT) {
			messages.push(current.trimEnd());
			current = `${contHeader}${addition}`;
		} else {
			current += addition;
		}
	}

	if (current.trim().length > 0) {
		messages.push(current.trimEnd());
	}

	return messages;
}

async function handleListFilesByExtensions(
	ctx: Context,
	label: string,
	emoji: string,
	extensions: string[],
): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);
	const rootDir = session.workingDir;
	if (!isPathAllowed(rootDir)) {
		await ctx.reply(
			`\u274C Access denied: <code>${escapeHtml(rootDir)}</code>`,
			{
				parse_mode: "HTML",
			},
		);
		return;
	}

	const files = collectFilesByExtensions(rootDir, extensions);
	if (files.length === 0) {
		await ctx.reply(
			`${emoji} No ${label.toLowerCase()} found in <code>${escapeHtml(rootDir)}</code>.`,
			{ parse_mode: "HTML" },
		);
		return;
	}

	const lines = files.map((filePath) => `<code>${escapeHtml(filePath)}</code>`);
	const title = `${emoji} <b>${label}</b>`;
	const messages = buildFileListMessages(title, rootDir, lines);

	for (const message of messages) {
		await ctx.reply(message, { parse_mode: "HTML" });
	}
}

/**
 * /cd - Change working directory.
 */
export async function handleCd(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	// Get the path argument from command
	const text = ctx.message?.text || "";
	const match = text.match(/^\/cd\s+(.+)$/);

	if (!match) {
		await ctx.reply(
			`\u{1F4C1} Current directory: <code>${session.workingDir}</code>\n\nUsage: <code>/cd /path/to/directory</code>`,
			{ parse_mode: "HTML" },
		);
		return;
	}

	const inputPath = (match[1] ?? "").trim();
	// Resolve relative paths from current working directory
	const resolvedPath = resolvePath(inputPath, session.workingDir);

	// Validate path exists and is a directory
	if (!existsSync(resolvedPath)) {
		await ctx.reply(
			`\u274C Path does not exist: <code>${resolvedPath}</code>`,
			{
				parse_mode: "HTML",
			},
		);
		return;
	}

	const stats = statSync(resolvedPath);
	if (!stats.isDirectory()) {
		await ctx.reply(
			`\u274C Path is not a directory: <code>${resolvedPath}</code>`,
			{
				parse_mode: "HTML",
			},
		);
		return;
	}

	// Check if path is allowed
	if (!isPathAllowed(resolvedPath)) {
		await ctx.reply(
			`\u274C Access denied: <code>${resolvedPath}</code>\n\nPath must be in allowed directories.`,
			{ parse_mode: "HTML" },
		);
		return;
	}

	// Check if other sessions are using the same directory
	const conflictingChats = sessionManager.getOtherSessionsUsingDirectory(
		resolvedPath,
		chatId,
	);

	// Change directory
	session.setWorkingDir(resolvedPath);

	// Build inline keyboard
	const keyboard = new InlineKeyboard();
	if (isBookmarked(resolvedPath)) {
		keyboard.text("\u2B50 Already bookmarked", "bookmark:noop");
	} else {
		keyboard.text("\u2795 Add to bookmarks", `bookmark:add:${resolvedPath}`);
	}

	// Build response message. Per-directory memory: if this dir has a prior
	// session it is resumed; otherwise it starts fresh.
	const resumed = session.sessionId !== null;
	let message = `\u{1F4C1} Changed to: <code>${resolvedPath}</code>\n\n${
		resumed
			? "Resumed this directory's previous session memory."
			: "No prior memory here — next message starts fresh."
	}`;

	// Add warning if other sessions use same directory
	if (conflictingChats.length > 0) {
		const chatList = conflictingChats.map((id) => `#${id}`).join(", ");
		message += `\n\n\u26A0\uFE0F <b>Warning:</b> Chat ${chatList} also uses this directory.\nSimultaneous edits may cause conflicts. Consider using <code>/worktree</code> to create an isolated branch.`;
	}

	await ctx.reply(message, {
		parse_mode: "HTML",
		reply_markup: keyboard,
	});
}

/**
 * /file - Send a file to the user.
 * Without arguments: auto-detect file paths from last bot response.
 */
export async function handleFile(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	// Get the path argument from command
	const text = ctx.message?.text || "";
	const match = text.match(/^\/file\s+(.+)$/);

	// If no argument, try to auto-detect from last bot response
	if (!match) {
		if (!session.lastBotResponse) {
			await ctx.reply(
				"\u{1F4CE} <b>Download File</b>\n\n" +
					"Usage: <code>/file &lt;filepath&gt;</code>\n" +
					"Or just <code>/file</code> to send files from the last response.\n\n" +
					"No recent response to extract files from.",
				{ parse_mode: "HTML" },
			);
			return;
		}

		// Extract paths from <code> tags (response is HTML)
		const codeMatches = session.lastBotResponse.matchAll(
			/<code>([^<]+)<\/code>/g,
		);
		const candidates: string[] = [];
		for (const m of codeMatches) {
			const content = m[1]?.trim();
			// Must have file extension (contains . followed by letters)
			if (content && /\.[a-zA-Z0-9]+$/.test(content)) {
				candidates.push(content);
			}
		}

		// Deduplicate
		const detected = [...new Set(candidates)];

		if (detected.length === 0) {
			await ctx.reply(
				"\u{1F4CE} No file paths found in <code>&lt;code&gt;</code> tags.\n\n" +
					"Usage: <code>/file &lt;filepath&gt;</code>",
				{ parse_mode: "HTML" },
			);
			return;
		}

		// Send each detected file
		const errors: string[] = [];
		let sent = 0;
		for (const filePath of detected) {
			const error = await sendFile(ctx, filePath, session.workingDir);
			if (error) {
				errors.push(`${filePath}: ${error}`);
			} else {
				sent++;
			}
		}

		// Report any errors
		if (errors.length > 0) {
			await ctx.reply(`\u26A0\uFE0F Some files failed:\n${errors.join("\n")}`, {
				parse_mode: "HTML",
			});
		}

		if (sent === 0 && errors.length > 0) {
			// All failed, already reported above
		} else if (sent > 0) {
			// Success message optional, files speak for themselves
		}

		return;
	}

	// Explicit path provided
	const inputPath = (match[1] ?? "").trim();
	const error = await sendFile(ctx, inputPath, session.workingDir);
	if (error) {
		await ctx.reply(`\u274C ${error}`, {
			parse_mode: "HTML",
			message_effect_id: effectFor(ctx, MESSAGE_EFFECTS.THUMBS_DOWN),
		});
	}
}

/**
 * /image - List all image files under working directory.
 */
export async function handleImage(ctx: Context): Promise<void> {
	await handleListFilesByExtensions(
		ctx,
		"Images",
		"\u{1F5BC}\uFE0F",
		IMAGE_EXTENSIONS,
	);
}

/**
 * /pdf - List all PDF files under working directory.
 */
export async function handlePdf(ctx: Context): Promise<void> {
	await handleListFilesByExtensions(ctx, "PDFs", "\u{1F4C4}", PDF_EXTENSIONS);
}

/**
 * /docx - List all DOCX files under working directory.
 */
export async function handleDocx(ctx: Context): Promise<void> {
	await handleListFilesByExtensions(ctx, "DOCX", "\u{1F4DD}", DOCX_EXTENSIONS);
}

/**
 * /html - List all HTML files under working directory.
 */
export async function handleHtml(ctx: Context): Promise<void> {
	await handleListFilesByExtensions(ctx, "HTML", "\u{1F310}", HTML_EXTENSIONS);
}

/**
 * /bookmarks - List and manage bookmarks.
 */
export async function handleBookmarks(ctx: Context): Promise<void> {
	if (!(await checkCommandAuth(ctx))) return;

	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	const bookmarks = loadBookmarks();

	if (bookmarks.length === 0) {
		await ctx.reply(
			"\u{1F4DA} No bookmarks yet.\n\n" +
				"Use <code>/cd /path/to/dir</code> and click 'Add to bookmarks'.",
			{ parse_mode: "HTML" },
		);
		return;
	}

	// Build message and keyboards
	let message = "\u{1F4DA} <b>Bookmarks</b>\n\n";

	const keyboard = new InlineKeyboard();
	for (const bookmark of bookmarks) {
		message += `\u{1F4C1} <code>${bookmark.path}</code>\n`;

		// Each bookmark gets two buttons on the same row
		keyboard
			.text(`\u{1F195} ${bookmark.name}`, `bookmark:new:${bookmark.path}`)
			.text("\u{1F5D1}\uFE0F", `bookmark:remove:${bookmark.path}`)
			.row();
	}

	await ctx.reply(message, {
		parse_mode: "HTML",
		reply_markup: keyboard,
	});
}
