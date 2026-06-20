#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseArgs } from "./parser";
import { showHelp, showTutorial, VERSION } from "./help";
import { loadEnvFile } from "./env";
import { interactiveSetup, ensureClaudeConfig } from "./setup";

// Re-export everything from submodules for convenience
export { parseArgs, type CliOptions } from "./parser";
export { showHelp, showTutorial, VERSION } from "./help";
export { loadEnvFile, saveEnvFile } from "./env";
export { interactiveSetup, ensureClaudeConfig } from "./setup";

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const options = parseArgs(args);

	if (options.help) {
		showHelp();
		process.exit(0);
	}

	if (options.version) {
		console.log(`ctb version ${VERSION}`);
		process.exit(0);
	}

	if (options.tut) {
		showTutorial();
		process.exit(0);
	}

	// Determine working directory
	const workingDir = options.dir ? resolve(options.dir) : process.cwd();

	// Load .env from working directory
	const envFile = loadEnvFile(workingDir);

	// Merge: CLI args > .env file > process.env
	let token =
		options.token ||
		envFile.TELEGRAM_BOT_TOKEN ||
		process.env.TELEGRAM_BOT_TOKEN ||
		"";
	let users =
		options.users ||
		envFile.TELEGRAM_ALLOWED_USERS ||
		process.env.TELEGRAM_ALLOWED_USERS ||
		"";

	// Interactive setup if missing required vars
	if (!token || !users) {
		const setup = await interactiveSetup(workingDir, envFile);
		token = token || setup.token;
		users = users || setup.users;
	}

	// Set environment variables for the bot
	process.env.TELEGRAM_BOT_TOKEN = token;
	process.env.TELEGRAM_ALLOWED_USERS = users;
	process.env.CLAUDE_WORKING_DIR = workingDir;

	// Pass through other env vars from .env file
	for (const [key, value] of Object.entries(envFile)) {
		if (!(key in process.env)) {
			process.env[key] = value;
		}
	}

	// Set CTB_INSTANCE_DIR for session isolation
	process.env.CTB_INSTANCE_DIR = workingDir;

	// Ensure .claude directory and config exist
	ensureClaudeConfig(workingDir);

	console.log(`\nStarting ctb in ${workingDir}...\n`);

	// Import and start the bot
	await import("../bot.js");
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
