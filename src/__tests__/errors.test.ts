/**
 * Unit tests for error formatting.
 */

import { describe, expect, test } from "bun:test";
import { apiErrorMessage, formatUserError } from "../errors";

describe("formatUserError", () => {
	test("formats timeout error", () => {
		const msg = formatUserError(new Error("Query timeout (180s > 180s limit)"));
		expect(msg).toContain("took too long");
		expect(msg).not.toContain("timeout");
	});

	test("formats rate limit error", () => {
		const msg = formatUserError(new Error("Too Many Requests: retry after 5"));
		expect(msg).toContain("busy");
	});

	test("formats API 500 error", () => {
		const msg = formatUserError(
			new Error(
				'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_011CXmZh6HsBtB7WE8bYrakG"}',
			),
		);
		expect(msg).toContain("temporarily unavailable");
	});

	test("formats API 529 overloaded error", () => {
		const msg = formatUserError(
			new Error(
				'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011Cc7vUPG7jieAPw6HkiZFq"}',
			),
		);
		expect(msg).toContain("overloaded");
	});

	test("formats network error", () => {
		const msg = formatUserError(new Error("ETIMEDOUT"));
		expect(msg.toLowerCase()).toContain("connection");
	});

	test("formats generic error with truncation", () => {
		const longError = "A".repeat(300);
		const msg = formatUserError(new Error(longError));
		expect(msg.length).toBeLessThan(250);
	});

	test("formats cancelled/aborted error", () => {
		const msg = formatUserError(new Error("Request was cancelled by user"));
		expect(msg).toContain("cancelled");
	});

	test("formats unsafe command error", () => {
		const msg = formatUserError(new Error("unsafe command detected"));
		expect(msg).toContain("safety");
	});

	test("formats file access error", () => {
		const msg = formatUserError(new Error("outside allowed paths"));
		expect(msg).toContain("file location");
	});

	test("formats authentication error", () => {
		const msg = formatUserError(new Error("401 unauthorized"));
		expect(msg).toContain("Authentication");
	});

	test("formats ECONNRESET error", () => {
		const msg = formatUserError(new Error("ECONNRESET"));
		expect(msg).toContain("Connection");
	});

	test("handles error with empty message", () => {
		const msg = formatUserError(new Error(""));
		expect(msg).toContain("Error");
	});
});

describe("apiErrorMessage", () => {
	test("maps transient overload (server_error) to a retry message", () => {
		expect(apiErrorMessage("server_error")).toContain("過載");
	});

	test("maps rate_limit to a retry message", () => {
		expect(apiErrorMessage("rate_limit")).toContain("過載");
	});

	test("maps authentication_failed to a credentials message", () => {
		expect(apiErrorMessage("authentication_failed")).toContain("認證");
	});

	test("maps billing_error to a billing message", () => {
		expect(apiErrorMessage("billing_error")).toContain("帳務");
	});

	test("never leaks raw API Error JSON", () => {
		// Whatever the typed error, the message must be friendly, not raw JSON.
		for (const e of [
			"server_error",
			"rate_limit",
			"authentication_failed",
			"billing_error",
			"invalid_request",
			"unknown",
		] as const) {
			expect(apiErrorMessage(e)).not.toContain("API Error");
			expect(apiErrorMessage(e)).not.toContain("{");
		}
	});
});
