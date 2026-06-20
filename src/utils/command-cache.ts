/**
 * Command cache for storing long commands that would exceed Telegram callback data limits.
 *
 * Uses HMAC-SHA256 for command verification to prevent tampering.
 */

import { createHmac, randomBytes } from "node:crypto";

// Maximum size for direct base64 encoding (leaves room for callback prefix)
const MAX_INLINE_LENGTH = 32; // bytes, conservative limit for callback data

// Cache entry type
interface CacheEntry {
	command: string;
	userId: number;
	timestamp: number;
	hmac: string;
}

// In-memory cache with expiration
const commandCache = new Map<string, CacheEntry>();

// Secret key for HMAC (regenerated on bot restart)
const HMAC_SECRET = randomBytes(32);

// Cache expiration (5 minutes)
const CACHE_EXPIRATION_MS = 5 * 60 * 1000;

/**
 * Generate HMAC for a command to prevent tampering.
 */
function generateHmac(commandId: string, command: string, userId: number): string {
	const data = `${commandId}:${command}:${userId}`;
	return createHmac("sha256", HMAC_SECRET).update(data).digest("hex");
}

/**
 * Verify HMAC for a cached command.
 */
function verifyHmac(commandId: string, entry: CacheEntry): boolean {
	const expectedHmac = generateHmac(commandId, entry.command, entry.userId);
	return entry.hmac === expectedHmac;
}

/**
 * Store a command and return either inline base64 or cache ID.
 * Returns format: "inline:base64data" or "cache:id"
 */
export function storeCommand(command: string, userId: number): string {
	// Try inline first
	const base64 = Buffer.from(command).toString("base64");
	if (base64.length <= MAX_INLINE_LENGTH) {
		return `inline:${base64}`;
	}

	// Use cache for long commands
	const commandId = randomBytes(16).toString("hex");
	const hmac = generateHmac(commandId, command, userId);

	commandCache.set(commandId, {
		command,
		userId,
		timestamp: Date.now(),
		hmac,
	});

	return `cache:${commandId}`;
}

/**
 * Retrieve a command from storage.
 * Handles both inline and cached formats.
 * Returns null if command is invalid, expired, or tampered with.
 */
export function retrieveCommand(
	encoded: string,
	userId: number,
): string | null {
	// Handle inline format
	if (encoded.startsWith("inline:")) {
		const base64 = encoded.slice(7);
		// Validate base64 format (only contains valid base64 characters)
		if (!/^[A-Za-z0-9+/=]*$/.test(base64)) {
			return null;
		}
		try {
			return Buffer.from(base64, "base64").toString("utf-8");
		} catch {
			return null;
		}
	}

	// Handle cache format
	if (encoded.startsWith("cache:")) {
		const commandId = encoded.slice(6);
		const entry = commandCache.get(commandId);

		if (!entry) {
			return null; // Expired or not found
		}

		// Verify user ID matches
		if (entry.userId !== userId) {
			console.warn(
				`Command cache: user ID mismatch (expected ${entry.userId}, got ${userId})`,
			);
			return null;
		}

		// Verify HMAC
		if (!verifyHmac(commandId, entry)) {
			console.error("Command cache: HMAC verification failed");
			return null;
		}

		// Check expiration
		if (Date.now() - entry.timestamp > CACHE_EXPIRATION_MS) {
			commandCache.delete(commandId);
			return null;
		}

		return entry.command;
	}

	// Unknown format with prefix - not base64
	if (encoded.includes(":")) {
		return null;
	}

	// Legacy format: direct base64 (for backwards compatibility)
	try {
		const decoded = Buffer.from(encoded, "base64").toString("utf-8");
		// Sanity check: decoded string should not contain binary garbage
		// If it contains too many non-printable characters, it's likely invalid
		const nonPrintable = (decoded.match(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/g) || [])
			.length;
		if (nonPrintable > decoded.length * 0.3) {
			// More than 30% non-printable = invalid
			return null;
		}
		return decoded;
	} catch {
		return null;
	}
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): {
	size: number;
	maxAge: number;
} {
	const now = Date.now();
	let maxAge = 0;

	for (const entry of commandCache.values()) {
		const age = now - entry.timestamp;
		if (age > maxAge) {
			maxAge = age;
		}
	}

	return {
		size: commandCache.size,
		maxAge,
	};
}
