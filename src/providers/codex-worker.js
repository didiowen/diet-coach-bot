import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { normalize, resolve } from "node:path";
import process from "node:process";

console.log = (...args) => {
	process.stderr.write(`${args.join(" ")}\n`);
};
console.info = console.log;
console.warn = console.log;

let Codex;
try {
	({ Codex } = await import("@openai/codex-sdk"));
} catch (error) {
	process.stderr.write(`Failed to load @openai/codex-sdk: ${error}\n`);
	process.exit(1);
}

const codex = new Codex();

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

let handled = false;
rl.on("line", async (line) => {
	if (handled || !line.trim()) return;
	handled = true;
	try {
		const request = JSON.parse(line);
		const allowedPaths = Array.isArray(request.allowedPaths)
			? request.allowedPaths
			: String(process.env.CODEX_ALLOWED_PATHS || process.env.ALLOWED_PATHS || "")
					.split(",")
					.map((p) => p.trim())
					.filter(Boolean);
		const tempPaths = Array.isArray(request.tempPaths)
			? request.tempPaths
			: String(process.env.CODEX_TEMP_PATHS || "")
					.split(",")
					.map((p) => p.trim())
					.filter(Boolean);

		if (request.cwd) allowedPaths.push(request.cwd);

		const isPathAllowed = (targetPath) => {
			if (!targetPath) return false;
			if (allowedPaths.length === 0 && tempPaths.length === 0) return true;
			const expanded = String(targetPath).replace(
				/^~(?=\/|$)/,
				homedir(),
			);
			const normalized = normalize(expanded);
			const resolved = resolve(normalized);

			for (const tempPath of tempPaths) {
				const tempResolved = resolve(tempPath);
				if (
					resolved === tempResolved ||
					resolved.startsWith(`${tempResolved}/`)
				) {
					return true;
				}
			}

			for (const allowed of allowedPaths) {
				const allowedResolved = resolve(allowed.replace(/^~/, process.env.HOME || ""));
				if (
					resolved === allowedResolved ||
					resolved.startsWith(`${allowedResolved}/`)
				) {
					return true;
				}
			}
			return false;
		};

		if (request.cwd && !isPathAllowed(request.cwd)) {
			throw new Error(
				`Working directory is not allowed: ${request.cwd}. Check ALLOWED_PATHS.`,
			);
		}
		if (request.cwd) {
			process.chdir(request.cwd);
		}

		const prompt = request.prompt;
		if (!prompt) {
			throw new Error("Missing prompt");
		}

		const threadOptions = {
			workingDirectory: request.cwd,
			skipGitRepoCheck: true,
		};
		const thread = request.threadId
			? codex.resumeThread(request.threadId, threadOptions)
			: codex.startThread(threadOptions);

		const { events } = await thread.runStreamed(prompt);
		for await (const event of events) {
			process.stdout.write(`${JSON.stringify(event)}\n`);
		}
		process.exit(0);
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({
				type: "error",
				message: String(error),
			})}\n`,
		);
		process.exit(1);
	}
});
