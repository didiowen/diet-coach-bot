/**
 * Document extraction functions.
 *
 * Handles downloading, text extraction (PDF via pdftotext, text files),
 * archive extraction, and file tree building.
 */

import type { Context } from "grammy";
import { TEMP_DIR } from "../../config";
import { downloadTelegramFile } from "../../utils/telegram-download";
import {
	ARCHIVE_EXTENSIONS,
	MAX_ARCHIVE_CONTENT,
	MAX_EXTRACTED_SIZE,
	TEXT_EXTENSIONS,
} from "./constants";

/**
 * Download a document and return the local path.
 */
export async function downloadDocument(ctx: Context): Promise<string> {
	const doc = ctx.message?.document;
	if (!doc) {
		throw new Error("No document in message");
	}

	const fileName = doc.file_name || `doc_${Date.now()}`;

	// Sanitize filename
	const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
	const docPath = `${TEMP_DIR}/${safeName}`;

	// Download (retry on transient Telegram 504 / reset)
	return downloadTelegramFile(ctx, docPath);
}

/**
 * Extract text from a document.
 */
export async function extractText(
	filePath: string,
	mimeType?: string,
): Promise<string> {
	const fileName = filePath.split("/").pop() || "";
	const extension = `.${(fileName.split(".").pop() || "").toLowerCase()}`;

	// PDF extraction using pdftotext CLI (install: brew install poppler)
	if (mimeType === "application/pdf" || extension === ".pdf") {
		try {
			const result = await Bun.$`pdftotext -layout ${filePath} -`.quiet();
			return result.text();
		} catch (error) {
			console.error("PDF parsing failed:", error);
			return "[PDF parsing failed - ensure pdftotext is installed: brew install poppler]";
		}
	}

	// Text files
	if (TEXT_EXTENSIONS.includes(extension) || mimeType?.startsWith("text/")) {
		const text = await Bun.file(filePath).text();
		// Limit to 100K chars
		return text.slice(0, 100000);
	}

	throw new Error(`Unsupported file type: ${extension || mimeType}`);
}

/**
 * Check if a file extension is an archive.
 */
export function isArchive(fileName: string): boolean {
	const lower = fileName.toLowerCase();
	return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Get archive extension from filename.
 */
export function getArchiveExtension(fileName: string): string {
	const lower = fileName.toLowerCase();
	if (lower.endsWith(".tar.gz")) return ".tar.gz";
	if (lower.endsWith(".tgz")) return ".tgz";
	if (lower.endsWith(".tar")) return ".tar";
	if (lower.endsWith(".zip")) return ".zip";
	return "";
}

/**
 * Calculate total size of files in a directory.
 */
export async function getDirectorySize(dir: string): Promise<number> {
	let totalSize = 0;
	const entries = await Array.fromAsync(
		new Bun.Glob("**/*").scan({ cwd: dir, dot: true }),
	);

	for (const entry of entries) {
		try {
			const file = Bun.file(`${dir}/${entry}`);
			totalSize += file.size;
			// Early exit if already over limit
			if (totalSize > MAX_EXTRACTED_SIZE) {
				return totalSize;
			}
		} catch {
			// Skip files we can't access
		}
	}

	return totalSize;
}

/**
 * Extract an archive to a temp directory.
 * Validates extracted size to prevent decompression bombs.
 */
export async function extractArchive(
	archivePath: string,
	fileName: string,
): Promise<string> {
	const ext = getArchiveExtension(fileName);
	const extractDir = `${TEMP_DIR}/archive_${Date.now()}`;
	await Bun.$`mkdir -p ${extractDir}`;

	try {
		if (ext === ".zip") {
			await Bun.$`unzip -q -o ${archivePath} -d ${extractDir}`.quiet();
		} else if (ext === ".tar" || ext === ".tar.gz" || ext === ".tgz") {
			await Bun.$`tar -xf ${archivePath} -C ${extractDir}`.quiet();
		} else {
			throw new Error(`Unknown archive type: ${ext}`);
		}

		// Check extracted size to prevent decompression bombs
		const extractedSize = await getDirectorySize(extractDir);
		if (extractedSize > MAX_EXTRACTED_SIZE) {
			// Clean up and throw
			await import("node:fs/promises").then((fs) =>
				fs.rm(extractDir, { recursive: true, force: true }),
			);
			throw new Error(
				`Archive too large when extracted (${Math.round(extractedSize / 1024 / 1024)}MB > ${Math.round(MAX_EXTRACTED_SIZE / 1024 / 1024)}MB limit)`,
			);
		}

		return extractDir;
	} catch (error) {
		// Clean up on any error
		try {
			await import("node:fs/promises").then((fs) =>
				fs.rm(extractDir, { recursive: true, force: true }),
			);
		} catch {
			// Ignore cleanup errors
		}
		throw error;
	}
}

/**
 * Build a file tree from a directory.
 */
export async function buildFileTree(dir: string): Promise<string[]> {
	const entries = await Array.fromAsync(
		new Bun.Glob("**/*").scan({ cwd: dir, dot: false }),
	);
	entries.sort();
	return entries.slice(0, 100); // Limit to 100 files
}

/**
 * Extract text content from archive files.
 */
export async function extractArchiveContent(extractDir: string): Promise<{
	tree: string[];
	contents: Array<{ name: string; content: string }>;
}> {
	const tree = await buildFileTree(extractDir);
	const contents: Array<{ name: string; content: string }> = [];
	let totalSize = 0;

	for (const relativePath of tree) {
		const fullPath = `${extractDir}/${relativePath}`;
		const stat = await Bun.file(fullPath).exists();
		if (!stat) continue;

		// Check if it's a directory
		const fileInfo = Bun.file(fullPath);
		const size = fileInfo.size;
		if (size === 0) continue;

		const ext = `.${(relativePath.split(".").pop() || "").toLowerCase()}`;
		if (!TEXT_EXTENSIONS.includes(ext)) continue;

		// Skip large files
		if (size > 100000) continue;

		try {
			const text = await fileInfo.text();
			const truncated = text.slice(0, 10000); // 10K per file max
			if (totalSize + truncated.length > MAX_ARCHIVE_CONTENT) break;
			contents.push({ name: relativePath, content: truncated });
			totalSize += truncated.length;
		} catch {
			// Skip binary or unreadable files
		}
	}

	return { tree, contents };
}
