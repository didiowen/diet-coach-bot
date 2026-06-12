/**
 * SessionManager - manages multiple ClaudeSession instances (one per chat).
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { SESSION_DIR, WORKING_DIR } from "../config";
import type { SessionData } from "../types";
import { ClaudeSession } from "./claude-session";
import { SESSION_VERSION } from "./types";

const IDLE_SESSION_CLEANUP_MS = Number.parseInt(
	process.env.IDLE_SESSION_CLEANUP_MS || String(24 * 60 * 60 * 1000), // 24 hours
	10,
);

/**
 * SessionManager manages multiple ClaudeSession instances (one per chat).
 */
class SessionManager {
	private sessions: Map<number, ClaudeSession> = new Map();

	constructor() {
		this.ensureSessionDir();
	}

	/**
	 * Ensure session directory exists.
	 */
	private ensureSessionDir(): void {
		if (!existsSync(SESSION_DIR)) {
			mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
			console.log(`Created session directory: ${SESSION_DIR}`);
		}
	}

	/**
	 * Get or create session for a chat.
	 */
	getSession(chatId: number): ClaudeSession {
		if (!this.sessions.has(chatId)) {
			const session = new ClaudeSession();

			// Try to load from disk
			const loaded = this.loadSessionFromDisk(chatId, session);

			if (!loaded) {
				// New session: use global default working dir
				{ const hostIds_p13 = String(process.env.CTB_HOST_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean); if (hostIds_p13.length > 0 && !hostIds_p13.includes(String(chatId))) { throw new Error("No session.json for chat " + chatId + ", and CTB_HOST_CHAT_IDS does not include it — refusing fallback to default WORKING_DIR. Run ctb-prepopulate.sh first."); } }
				session.setWorkingDir(WORKING_DIR);
			}

			// Set chat ID
			session.setChatId(chatId);

			// Set session manager reference for save delegation
			session.setSessionManager(this);

			this.sessions.set(chatId, session);
			console.log(`Created session for chat ${chatId}`);
		}
		return this.sessions.get(chatId)!;
	}

	/**
	 * Load session from disk for a specific chat.
	 */
	private loadSessionFromDisk(chatId: number, session: ClaudeSession): boolean {
		const sessionFile = `${SESSION_DIR}/${chatId}.json`;

		try {
			const file = Bun.file(sessionFile);
			if (!file.size) return false;

			const text = readFileSync(sessionFile, "utf-8");
			const data: SessionData = JSON.parse(text);

			if (data.version !== SESSION_VERSION) {
				return false;
			}

			session.sessionId = data.session_id;
			session.lastActivity = new Date();

			if (data.working_dir) {
				session.setWorkingDir(data.working_dir);
			}

			console.log(
				`Loaded session for chat ${chatId}: ${(data.session_id ?? "no-id").slice(0, 8)}...`,
			);
			return true;
		} catch (error) {
			console.warn(`Failed to load session for chat ${chatId}:`, error);
			return false;
		}
	}

	/**
	 * Save session to disk for a specific chat.
	 */
	saveSession(chatId: number): void {
		const session = this.sessions.get(chatId);
		if (!session?.sessionId) return;

		try {
			const sessionFile = `${SESSION_DIR}/${chatId}.json`;
			const data: SessionData = {
				version: SESSION_VERSION,
				chat_id: chatId,
				session_id: session.sessionId,
				saved_at: new Date().toISOString(),
				working_dir: session.workingDir,
			};

			writeFileSync(sessionFile, JSON.stringify(data), { mode: 0o600 });
			console.log(`Saved session for chat ${chatId}`);
		} catch (error) {
			console.warn(`Failed to save session for chat ${chatId}:`, error);
		}
	}

	/**
	 * Clear persisted session pointer for a chat. Used when the prior query
	 * was aborted before completion so the next message starts a fresh session
	 * instead of resuming a corrupt one.
	 */
	clearSession(chatId: number): void {
		try {
			const sessionFile = `${SESSION_DIR}/${chatId}.json`;
			if (existsSync(sessionFile)) {
				unlinkSync(sessionFile);
				console.log(`Cleared session file for chat ${chatId}`);
			}
		} catch (error) {
			console.warn(`Failed to clear session for chat ${chatId}:`, error);
		}
	}

	/**
	 * Load all sessions from disk on startup.
	 */
	loadAllSessions(): void {
		try {
			if (!existsSync(SESSION_DIR)) return;

			const files = readdirSync(SESSION_DIR);
			let loaded = 0;

			for (const file of files) {
				if (!file.endsWith(".json")) continue;

				const chatId = Number.parseInt(file.replace(".json", ""), 10);
				if (Number.isNaN(chatId)) continue;

				const session = new ClaudeSession();
				if (this.loadSessionFromDisk(chatId, session)) {
					session.setChatId(chatId);
					session.setSessionManager(this);
					this.sessions.set(chatId, session);
					loaded++;
				}
			}

			if (loaded > 0) {
				console.log(`Restored ${loaded} session(s) from disk`);
			}
		} catch (error) {
			console.warn("Failed to load sessions:", error);
		}
	}

	/**
	 * Get all active sessions.
	 */
	getAllActiveSessions(): Array<{
		chatId: number;
		session: ClaudeSession;
	}> {
		return Array.from(this.sessions.entries()).map(([chatId, session]) => ({
			chatId,
			session,
		}));
	}

	/**
	 * Clean up idle sessions.
	 */
	cleanupIdleSessions(maxIdleMs: number = IDLE_SESSION_CLEANUP_MS): number {
		const now = Date.now();
		let cleaned = 0;

		for (const [chatId, session] of this.sessions) {
			if (!session.lastActivity) continue;

			const idleMs = now - session.lastActivity.getTime();
			if (idleMs > maxIdleMs) {
				this.sessions.delete(chatId);

				// Delete session file
				try {
					const sessionFile = `${SESSION_DIR}/${chatId}.json`;
					if (existsSync(sessionFile)) {
						unlinkSync(sessionFile);
					}
				} catch (error) {
					console.warn(
						`Failed to delete session file for chat ${chatId}:`,
						error,
					);
				}

				cleaned++;
				console.log(`Cleaned up idle session for chat ${chatId}`);
			}
		}

		return cleaned;
	}

	/**
	 * Flush all sessions to disk (for graceful shutdown).
	 */
	flushAllSessions(): void {
		for (const [chatId, session] of this.sessions) {
			if (session.sessionId) {
				session.flushSession();
				this.saveSession(chatId);
			}
		}
	}

	/**
	 * Get chat IDs of other sessions using the same directory.
	 * Used to warn about potential conflicts when changing working directory.
	 */
	getOtherSessionsUsingDirectory(dir: string, excludeChatId: number): number[] {
		const normalizedDir = dir.replace(/\/+$/, ""); // Remove trailing slashes
		const conflicts: number[] = [];

		for (const [chatId, session] of this.sessions) {
			if (chatId === excludeChatId) continue;

			const sessionDir = session.workingDir.replace(/\/+$/, "");
			if (sessionDir === normalizedDir) {
				conflicts.push(chatId);
			}
		}

		return conflicts;
	}
}

export { SessionManager };
