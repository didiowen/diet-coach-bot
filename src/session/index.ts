/**
 * Session management barrel file.
 * Re-exports everything for backward compatibility.
 */

export { SESSION_VERSION } from "./types";
export {
	getThinkingLevel,
	_getTextFromMessage,
	createProvider,
	resolveProvider,
} from "./thinking";
export { ClaudeSession } from "./claude-session";
export { SessionManager } from "./session-manager";

// Singleton instances
import { SessionManager } from "./session-manager";

// Export singleton SessionManager
export const sessionManager = new SessionManager();
