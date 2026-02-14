import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { EventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { $ } from "bun";
import { RLM_PRELUDE } from "../src/rlm/context-transfer";
import { LMHandler, type LMHandlerDeps, type StreamFn } from "../src/rlm/lm-handler";

/**
 * Create a mock stream function that returns a predetermined response.
 */
function createMockStreamFn(responses: Map<string, string | Error>): StreamFn {
	return (model, context, _options) => {
		const prompt = context.messages[0]?.content;
		const promptKey = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
		const responseOrError = responses.get(promptKey) ?? responses.get("*") ?? "default response";

		const stream = new EventStream<{ type: "message_complete"; message: AssistantMessage }, AssistantMessage>(
			event => event.type === "message_complete",
			event => event.message,
		);

		if (responseOrError instanceof Error) {
			const errorStream = new EventStream<{ type: "message_complete"; message: AssistantMessage }, AssistantMessage>(
				event => event.type === "message_complete",
				event => event.message,
			);
			errorStream.result = () => Promise.reject(responseOrError);
			return errorStream as unknown as ReturnType<StreamFn>;
		}

		setTimeout(() => {
			stream.push({
				type: "message_complete",
				message: {
					role: "assistant",
					content: [{ type: "text", text: responseOrError }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: model.id,
					usage: {
						input: 10,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 30,
						cost: { total: 0.001, input: 0.0005, output: 0.0005, cacheRead: 0, cacheWrite: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			});
		}, 0);

		return stream as unknown as ReturnType<StreamFn>;
	};
}

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

/**
 * Run Python code and return stdout.
 * Uses subprocess to run actual Python with urllib.request.
 */
async function runPython(code: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const result = await $`python3 -c ${code}`.quiet().nothrow();
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

describe("RLM Integration: Python prelude → LM handler round-trip", () => {
	let handler: LMHandler;
	let tempDir: string;
	const responses = new Map<string, string | Error>();

	beforeEach(async () => {
		// Create temp directory for test files
		tempDir = path.join(os.tmpdir(), `rlm-integration-${crypto.randomUUID()}`);
		await fs.mkdir(tempDir, { recursive: true });

		responses.clear();
		const deps: LMHandlerDeps = {
			getModel: (_depth: number) => createMockModel(),
			getApiKey: async (_provider: string) => "test-api-key",
			streamFn: createMockStreamFn(responses),
		};
		handler = new LMHandler(deps);
		handler.start();
	});

	afterEach(async () => {
		handler.stop();
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("llm_query() single request", () => {
		it("sends request with correct auth and receives response", async () => {
			responses.set("Hello, world!", "Hello from the LLM!");

			// Write prelude to temp file and run Python
			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query

_configure('${handler.url}', '${handler.token}', depth=0)
result = llm_query('Hello, world!')
print(result, end='')
`;
			const result = await runPython(pythonCode);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("Hello from the LLM!");
			expect(result.stderr).toBe("");
		});

		it("passes depth parameter to handler", async () => {
			const getModel = mock((_depth: number) => createMockModel());
			const customHandler = new LMHandler({
				getModel,
				getApiKey: async () => "test-key",
				streamFn: createMockStreamFn(responses),
			});
			customHandler.start();

			try {
				responses.set("test", "response");

				const preludePath = path.join(tempDir, "rlm_prelude.py");
				await Bun.write(preludePath, RLM_PRELUDE);

				const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query

_configure('${customHandler.url}', '${customHandler.token}', depth=3)
result = llm_query('test')
print(result, end='')
`;
				const result = await runPython(pythonCode);

				expect(result.exitCode).toBe(0);
				expect(getModel).toHaveBeenCalledWith(3);
			} finally {
				customHandler.stop();
			}
		});

		it("handles error response from handler", async () => {
			responses.set("fail", new Error("Test error"));

			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query

_configure('${handler.url}', '${handler.token}', depth=0)
try:
    result = llm_query('fail')
except RuntimeError as e:
    print(str(e), end='')
`;
			const result = await runPython(pythonCode);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("LLM query failed");
			expect(result.stdout).toContain("Test error");
		});

		it("rejects wrong auth token", async () => {
			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query

_configure('${handler.url}', 'wrong-token', depth=0)
try:
    result = llm_query('test')
except RuntimeError as e:
    print(str(e), end='')
`;
			const result = await runPython(pythonCode);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("LLM query failed");
			expect(result.stdout).toContain("401");
		});
	});

	describe("llm_query_batched() parallel requests", () => {
		it("sends batched request and receives array of responses", async () => {
			responses.set("Question 1", "Answer 1");
			responses.set("Question 2", "Answer 2");
			responses.set("Question 3", "Answer 3");

			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			const pythonCode = `
import sys
import json
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query_batched

_configure('${handler.url}', '${handler.token}', depth=0)
results = llm_query_batched(['Question 1', 'Question 2', 'Question 3'])
print(json.dumps(results), end='')
`;
			const result = await runPython(pythonCode);

			expect(result.exitCode).toBe(0);
			const answers = JSON.parse(result.stdout) as string[];
			expect(answers).toEqual(["Answer 1", "Answer 2", "Answer 3"]);
		});

		it("passes depth to all batched requests", async () => {
			const getModel = mock((_depth: number) => createMockModel());
			const customHandler = new LMHandler({
				getModel,
				getApiKey: async () => "test-key",
				streamFn: createMockStreamFn(responses),
			});
			customHandler.start();

			try {
				responses.set("*", "response");

				const preludePath = path.join(tempDir, "rlm_prelude.py");
				await Bun.write(preludePath, RLM_PRELUDE);

				const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query_batched

_configure('${customHandler.url}', '${customHandler.token}', depth=2)
results = llm_query_batched(['p1', 'p2', 'p3'])
print(len(results), end='')
`;
				const result = await runPython(pythonCode);

				expect(result.exitCode).toBe(0);
				expect(result.stdout).toBe("3");
				// Each prompt in batch should use depth 2
				expect(getModel).toHaveBeenCalledTimes(3);
				for (const call of getModel.mock.calls) {
					expect(call[0]).toBe(2);
				}
			} finally {
				customHandler.stop();
			}
		});
	});

	describe("SHOW_VARS()", () => {
		it("returns empty dict when no user variables", async () => {
			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			// SHOW_VARS() requires IPython - test that it handles non-IPython gracefully
			const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import SHOW_VARS

result = SHOW_VARS()
print(result, end='')
`;
			const result = await runPython(pythonCode);

			// In non-IPython environment, should return empty dict
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("{}");
		});
	});

	describe("_configure() validation", () => {
		it("accepts loopback URL 127.0.0.1", async () => {
			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure

_configure('http://127.0.0.1:8080', 'token', depth=0)
print('ok', end='')
`;
			const result = await runPython(pythonCode);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("ok");
		});

		it("accepts loopback URL localhost", async () => {
			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure

_configure('http://localhost:8080', 'token', depth=0)
print('ok', end='')
`;
			const result = await runPython(pythonCode);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("ok");
		});

		it("rejects non-loopback URL", async () => {
			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure

try:
    _configure('http://example.com:8080', 'token', depth=0)
except ValueError as e:
    print(str(e), end='')
`;
			const result = await runPython(pythonCode);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("loopback");
			expect(result.stdout).toContain("example.com");
		});
	});

	describe("error handling", () => {
		it("raises RuntimeError when handler not configured", async () => {
			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import llm_query

try:
    llm_query('test')
except RuntimeError as e:
    print(str(e), end='')
`;
			const result = await runPython(pythonCode);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("not configured");
		});

		it("raises RuntimeError when handler unreachable", async () => {
			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			// Use a port that nothing is listening on
			const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query

_configure('http://127.0.0.1:59999', 'token', depth=0, timeout=1)
try:
    llm_query('test')
except RuntimeError as e:
    print(str(e), end='')
`;
			const result = await runPython(pythonCode);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("unreachable");
		});
	});

	describe("usage tracking", () => {
		it("accumulates usage across multiple Python requests", async () => {
			responses.set("*", "response");

			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query

_configure('${handler.url}', '${handler.token}', depth=0)

# Make several requests
llm_query('q1')
llm_query('q2')
llm_query('q3')
print('done', end='')
`;
			const result = await runPython(pythonCode);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("done");

			// Check handler tracked the usage
			const usage = handler.getUsage();
			const modelUsage = usage.get("claude-sonnet-4-20250514");

			expect(modelUsage).toBeDefined();
			expect(modelUsage!.calls).toBe(3);
			expect(modelUsage!.input).toBe(30); // 10 * 3
			expect(modelUsage!.output).toBe(60); // 20 * 3
		});
	});
});
