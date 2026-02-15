import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { EventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { $ } from "bun";
import { RLM_PRELUDE } from "../src/rlm/context-transfer";
import { LMHandler, type StreamFn } from "../src/rlm/lm-handler";

/**
 * RLM Error Recovery Tests
 *
 * Verifies that sub-LLM failures surface correctly to Python:
 * 1. Errors become RuntimeError (not HTTP exceptions)
 * 2. Error message includes HTTP status code
 * 3. Error message includes retryable flag
 * 4. Retryable is true for 429/5xx, false for permanent errors
 */

function createMockModel(id = "claude-sonnet-4-20250514"): Model {
	return {
		id,
		name: "Test Model",
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	} as Model;
}

describe("RLM Error Recovery: sub-LLM failures surface to Python", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `rlm-error-${crypto.randomUUID()}`);
		await fs.mkdir(tempDir, { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("Non-retryable errors (permanent failures)", () => {
		it("surfaces 500 error with retryable=False and descriptive message", async () => {
			// Create a handler that throws a permanent error (no status code = treated as non-retryable)
			const errorStreamFn: StreamFn = () => {
				const stream = new EventStream<{ type: "message_complete"; message: AssistantMessage }, AssistantMessage>(
					event => event.type === "message_complete",
					event => event.message,
				);

				stream.result = async () => {
					throw new Error("Invalid API key");
				};

				return stream as unknown as ReturnType<StreamFn>;
			};

			const handler = new LMHandler({
				getModel: () => createMockModel(),
				getApiKey: async () => "test-key",
				streamFn: errorStreamFn,
			});
			handler.start();

			try {
				const preludePath = path.join(tempDir, "rlm_prelude.py");
				await Bun.write(preludePath, RLM_PRELUDE);

				const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query

_configure('${handler.url}', '${handler.token}', depth=0)
try:
    llm_query('test')
    print('ERROR: should have raised')
except RuntimeError as e:
    msg = str(e)
    print(f'type: RuntimeError')
    print(f'has_http_status: {"HTTP 500" in msg}')
    print(f'retryable_false: {"retryable=False" in msg}')
    print(f'has_error_message: {"Invalid API key" in msg}')
    print(f'full_message: {msg}')
`;
				const result = await $`python3 -c ${pythonCode}`.quiet().nothrow();

				expect(result.exitCode).toBe(0);
				const stdout = result.stdout.toString();
				expect(stdout).toContain("type: RuntimeError");
				expect(stdout).toContain("has_http_status: True");
				expect(stdout).toContain("retryable_false: True");
				expect(stdout).toContain("has_error_message: True");
			} finally {
				handler.stop();
			}
		});

		it("surfaces 400 error with retryable=False", async () => {
			// Simulate a bad request error (400)
			const badRequestStreamFn: StreamFn = () => {
				const stream = new EventStream<{ type: "message_complete"; message: AssistantMessage }, AssistantMessage>(
					event => event.type === "message_complete",
					event => event.message,
				);

				stream.result = async () => {
					const error = new Error("Bad request: prompt too long");
					(error as Error & { status?: number }).status = 400;
					throw error;
				};

				return stream as unknown as ReturnType<StreamFn>;
			};

			const handler = new LMHandler({
				getModel: () => createMockModel(),
				getApiKey: async () => "test-key",
				streamFn: badRequestStreamFn,
			});
			handler.start();

			try {
				const preludePath = path.join(tempDir, "rlm_prelude.py");
				await Bun.write(preludePath, RLM_PRELUDE);

				const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query

_configure('${handler.url}', '${handler.token}', depth=0)
try:
    llm_query('test')
    print('ERROR: should have raised')
except RuntimeError as e:
    msg = str(e)
    print(f'type: RuntimeError')
    # 400 is non-retryable, server returns 500 (non-retryable)
    print(f'retryable_false: {"retryable=False" in msg}')
`;
				const result = await $`python3 -c ${pythonCode}`.quiet().nothrow();

				expect(result.exitCode).toBe(0);
				const stdout = result.stdout.toString();
				expect(stdout).toContain("type: RuntimeError");
				expect(stdout).toContain("retryable_false: True");
			} finally {
				handler.stop();
			}
		});
	});

	describe("Retryable errors (temporary failures)", () => {
		it("surfaces 429 rate limit error with retryable=True", async () => {
			// Simulate a rate limit error
			const rateLimitStreamFn: StreamFn = () => {
				const stream = new EventStream<{ type: "message_complete"; message: AssistantMessage }, AssistantMessage>(
					event => event.type === "message_complete",
					event => event.message,
				);

				stream.result = async () => {
					const error = new Error("Rate limit exceeded");
					(error as Error & { status?: number }).status = 429;
					throw error;
				};

				return stream as unknown as ReturnType<StreamFn>;
			};

			const handler = new LMHandler({
				getModel: () => createMockModel(),
				getApiKey: async () => "test-key",
				streamFn: rateLimitStreamFn,
			});
			handler.start();

			try {
				const preludePath = path.join(tempDir, "rlm_prelude.py");
				await Bun.write(preludePath, RLM_PRELUDE);

				const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query

_configure('${handler.url}', '${handler.token}', depth=0)
try:
    llm_query('test')
    print('ERROR: should have raised')
except RuntimeError as e:
    msg = str(e)
    print(f'type: RuntimeError')
    print(f'has_http_status: {"HTTP 503" in msg}')  # Server responds with 503 for retryable
    print(f'retryable_true: {"retryable=True" in msg}')
    print(f'has_error_message: {"Rate limit" in msg}')
    print(f'full_message: {msg}')
`;
				const result = await $`python3 -c ${pythonCode}`.quiet().nothrow();

				expect(result.exitCode).toBe(0);
				const stdout = result.stdout.toString();
				expect(stdout).toContain("type: RuntimeError");
				expect(stdout).toContain("has_http_status: True");
				expect(stdout).toContain("retryable_true: True");
				expect(stdout).toContain("has_error_message: True");
			} finally {
				handler.stop();
			}
		});

		it("surfaces 5xx server error with retryable=True", async () => {
			// Simulate a 503 service unavailable error
			const serverErrorStreamFn: StreamFn = () => {
				const stream = new EventStream<{ type: "message_complete"; message: AssistantMessage }, AssistantMessage>(
					event => event.type === "message_complete",
					event => event.message,
				);

				stream.result = async () => {
					const error = new Error("Service temporarily unavailable");
					(error as Error & { status?: number }).status = 503;
					throw error;
				};

				return stream as unknown as ReturnType<StreamFn>;
			};

			const handler = new LMHandler({
				getModel: () => createMockModel(),
				getApiKey: async () => "test-key",
				streamFn: serverErrorStreamFn,
			});
			handler.start();

			try {
				const preludePath = path.join(tempDir, "rlm_prelude.py");
				await Bun.write(preludePath, RLM_PRELUDE);

				const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query

_configure('${handler.url}', '${handler.token}', depth=0)
try:
    llm_query('test')
    print('ERROR: should have raised')
except RuntimeError as e:
    msg = str(e)
    print(f'type: RuntimeError')
    print(f'has_http_status: {"HTTP 503" in msg}')
    print(f'retryable_true: {"retryable=True" in msg}')
    print(f'full_message: {msg}')
`;
				const result = await $`python3 -c ${pythonCode}`.quiet().nothrow();

				expect(result.exitCode).toBe(0);
				const stdout = result.stdout.toString();
				expect(stdout).toContain("type: RuntimeError");
				expect(stdout).toContain("has_http_status: True");
				expect(stdout).toContain("retryable_true: True");
			} finally {
				handler.stop();
			}
		});

		it("surfaces 529 overloaded error with retryable=True", async () => {
			// Simulate Anthropic's overloaded error
			const overloadedStreamFn: StreamFn = () => {
				const stream = new EventStream<{ type: "message_complete"; message: AssistantMessage }, AssistantMessage>(
					event => event.type === "message_complete",
					event => event.message,
				);

				stream.result = async () => {
					const error = new Error("API is overloaded");
					(error as Error & { status?: number }).status = 529;
					throw error;
				};

				return stream as unknown as ReturnType<StreamFn>;
			};

			const handler = new LMHandler({
				getModel: () => createMockModel(),
				getApiKey: async () => "test-key",
				streamFn: overloadedStreamFn,
			});
			handler.start();

			try {
				const preludePath = path.join(tempDir, "rlm_prelude.py");
				await Bun.write(preludePath, RLM_PRELUDE);

				const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query

_configure('${handler.url}', '${handler.token}', depth=0)
try:
    llm_query('test')
    print('ERROR: should have raised')
except RuntimeError as e:
    msg = str(e)
    print(f'type: RuntimeError')
    print(f'has_http_status: {"HTTP 503" in msg}')  # Server responds 503 for retryable
    print(f'retryable_true: {"retryable=True" in msg}')
    print(f'full_message: {msg}')
`;
				const result = await $`python3 -c ${pythonCode}`.quiet().nothrow();

				expect(result.exitCode).toBe(0);
				const stdout = result.stdout.toString();
				expect(stdout).toContain("type: RuntimeError");
				expect(stdout).toContain("has_http_status: True");
				expect(stdout).toContain("retryable_true: True");
			} finally {
				handler.stop();
			}
		});
	});

	describe("Error message format", () => {
		it("error message format is: LLM query failed (HTTP <status>, retryable=<bool>): <message>", async () => {
			const errorStreamFn: StreamFn = () => {
				const stream = new EventStream<{ type: "message_complete"; message: AssistantMessage }, AssistantMessage>(
					event => event.type === "message_complete",
					event => event.message,
				);

				stream.result = async () => {
					throw new Error("Test error message");
				};

				return stream as unknown as ReturnType<StreamFn>;
			};

			const handler = new LMHandler({
				getModel: () => createMockModel(),
				getApiKey: async () => "test-key",
				streamFn: errorStreamFn,
			});
			handler.start();

			try {
				const preludePath = path.join(tempDir, "rlm_prelude.py");
				await Bun.write(preludePath, RLM_PRELUDE);

				const pythonCode = `
import sys
import re
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query

_configure('${handler.url}', '${handler.token}', depth=0)
try:
    llm_query('test')
    print('ERROR: should have raised')
except RuntimeError as e:
    msg = str(e)
    # Expected format: "LLM query failed (HTTP 500, retryable=False): Test error message"
    pattern = r'LLM query failed \\(HTTP \\d+, retryable=(True|False)\\): .+'
    matches_format = bool(re.match(pattern, msg))
    print(f'matches_format: {matches_format}')
    print(f'full_message: {msg}')
`;
				const result = await $`python3 -c ${pythonCode}`.quiet().nothrow();

				expect(result.exitCode).toBe(0);
				const stdout = result.stdout.toString();
				expect(stdout).toContain("matches_format: True");
			} finally {
				handler.stop();
			}
		});
	});
});
