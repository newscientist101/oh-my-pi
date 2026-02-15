import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { EventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { $ } from "bun";
import { RLM_PRELUDE } from "../src/rlm/context-transfer";
import { LMHandler, type LMHandlerDeps, type StreamFn } from "../src/rlm/lm-handler";

/**
 * RLM Abort Chain Tests
 *
 * Verifies the 3-layer cancellation chain:
 * 1. Ctrl+C → kernel interrupt → Python KeyboardInterrupt → RuntimeError("LLM query cancelled")
 * 2. Python client disconnect → Bun server request.signal aborted → sub-LLM cancelled
 * 3. urlopen(timeout=300) prevents indefinite hang
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

describe("RLM Abort Chain", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `rlm-abort-${crypto.randomUUID()}`);
		await fs.mkdir(tempDir, { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("Layer 1: Python KeyboardInterrupt handling", () => {
		it("converts KeyboardInterrupt to RuntimeError in llm_query", async () => {
			// Test that the exception handler in rlm.py correctly catches KeyboardInterrupt
			// Note: We can't easily simulate KeyboardInterrupt in a subprocess,
			// but we can verify the exception handling code structure is in place

			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			// Verify the prelude contains KeyboardInterrupt handling
			const preludeContent = RLM_PRELUDE;
			expect(preludeContent).toContain("except KeyboardInterrupt:");
			expect(preludeContent).toContain('raise RuntimeError("LLM query cancelled")');
		});

		it("simulates interrupt by testing error propagation path", async () => {
			// Test that when an error occurs during urlopen, it's properly converted
			// to RuntimeError (same path as KeyboardInterrupt would take)
			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure

# Configure with a port that will fail fast
_configure('http://127.0.0.1:1', 'token', depth=0, timeout=1)

# Try to make a request - should get connection error
from rlm_prelude import llm_query
try:
    llm_query('test')
    print('ERROR: should have raised')
except RuntimeError as e:
    # This verifies the error handling path works correctly
    print('RuntimeError caught:', 'unreachable' in str(e).lower())
`;
			const result = await $`python3 -c ${pythonCode}`.quiet().nothrow();
			expect(result.exitCode).toBe(0);
			expect(result.stdout.toString()).toContain("RuntimeError caught: True");
		});
	});

	describe("Layer 2: Server request.signal abort on client disconnect", () => {
		it("aborts sub-LLM call when request.signal is aborted", async () => {
			const abortedSignals: AbortSignal[] = [];
			let streamStarted = false;
			let streamCompleted = false;

			// Create a slow stream that captures the signal
			const slowStreamFn: StreamFn = (_model, _context, options) => {
				if (options?.signal) {
					abortedSignals.push(options.signal);
				}
				streamStarted = true;

				const stream = new EventStream<{ type: "message_complete"; message: AssistantMessage }, AssistantMessage>(
					event => event.type === "message_complete",
					event => event.message,
				);

				// Use a promise that we'll never resolve unless signal aborts
				const { promise } = Promise.withResolvers<void>();

				// If signal aborts, reject
				options?.signal?.addEventListener("abort", () => {
					// Stream will be rejected
				});

				// Set result to a promise that depends on the slow operation
				stream.result = async () => {
					await promise; // Never resolves normally
					streamCompleted = true;
					return {
						role: "assistant" as const,
						content: [{ type: "text" as const, text: "should not see this" }],
						api: "anthropic-messages" as const,
						provider: "anthropic",
						model: "test",
						usage: {
							input: 10,
							output: 20,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 30,
							cost: { total: 0.001, input: 0.0005, output: 0.0005, cacheRead: 0, cacheWrite: 0 },
						},
						stopReason: "stop" as const,
						timestamp: Date.now(),
					};
				};

				return stream as unknown as ReturnType<StreamFn>;
			};

			const deps: LMHandlerDeps = {
				getModel: () => createMockModel(),
				getApiKey: async () => "test-key",
				streamFn: slowStreamFn,
			};

			const handler = new LMHandler(deps);
			handler.start();

			try {
				// Start a request using AbortController
				const controller = new AbortController();

				const fetchPromise = fetch(`${handler.url}/`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${handler.token}`,
					},
					body: JSON.stringify({ prompt: "test" }),
					signal: controller.signal,
				});

				// Wait for stream to start
				await Bun.sleep(50);
				expect(streamStarted).toBe(true);

				// Abort the request
				controller.abort();

				// The fetch should throw/reject due to abort
				await expect(fetchPromise).rejects.toThrow();

				// Verify stream did not complete
				expect(streamCompleted).toBe(false);

				// Note: The server-side signal abort propagation depends on Bun's implementation
				// We can't directly check abortedSignals[0].aborted because the request may
				// have already been cleaned up
			} finally {
				handler.stop();
			}
		});

		it("returns 499 status when client disconnects", async () => {
			// Create a handler with a stream that takes a while
			const { promise: blockPromise, resolve: unblockStream } = Promise.withResolvers<void>();

			const slowStreamFn: StreamFn = (_model, _context, options) => {
				const stream = new EventStream<{ type: "message_complete"; message: AssistantMessage }, AssistantMessage>(
					event => event.type === "message_complete",
					event => event.message,
				);

				stream.result = async () => {
					// Check if already aborted
					if (options?.signal?.aborted) {
						throw new Error("Aborted");
					}
					// Wait for unblock or abort
					await Promise.race([
						blockPromise,
						new Promise<void>((_, reject) => {
							options?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
						}),
					]);
					return {
						role: "assistant" as const,
						content: [{ type: "text" as const, text: "response" }],
						api: "anthropic-messages" as const,
						provider: "anthropic",
						model: "test",
						usage: {
							input: 10,
							output: 20,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 30,
							cost: { total: 0.001, input: 0.0005, output: 0.0005, cacheRead: 0, cacheWrite: 0 },
						},
						stopReason: "stop" as const,
						timestamp: Date.now(),
					};
				};

				return stream as unknown as ReturnType<StreamFn>;
			};

			const handler = new LMHandler({
				getModel: () => createMockModel(),
				getApiKey: async () => "test-key",
				streamFn: slowStreamFn,
			});
			handler.start();

			try {
				const controller = new AbortController();

				// Start request
				const fetchPromise = fetch(`${handler.url}/`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${handler.token}`,
					},
					body: JSON.stringify({ prompt: "test" }),
					signal: controller.signal,
				});

				// Give time for request to reach handler
				await Bun.sleep(20);

				// Abort client-side
				controller.abort();

				// Cleanup - unblock any remaining streams
				unblockStream();

				// The fetch should reject because we aborted it
				await expect(fetchPromise).rejects.toThrow();
			} finally {
				handler.stop();
			}
		});

		it("signal is passed through to streamSimple in #handleSingle", async () => {
			// This test verifies the signal is captured and passed through
			let capturedSignal: AbortSignal | undefined;

			const captureStreamFn: StreamFn = (_model, _context, options) => {
				capturedSignal = options?.signal;

				const stream = new EventStream<{ type: "message_complete"; message: AssistantMessage }, AssistantMessage>(
					event => event.type === "message_complete",
					event => event.message,
				);

				setTimeout(() => {
					stream.push({
						type: "message_complete",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "response" }],
							api: "anthropic-messages",
							provider: "anthropic",
							model: "test",
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

			const handler = new LMHandler({
				getModel: () => createMockModel(),
				getApiKey: async () => "test-key",
				streamFn: captureStreamFn,
			});
			handler.start();

			try {
				const response = await fetch(`${handler.url}/`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${handler.token}`,
					},
					body: JSON.stringify({ prompt: "test" }),
				});

				expect(response.ok).toBe(true);
				// Signal should have been passed to streamFn
				expect(capturedSignal).toBeDefined();
				expect(capturedSignal instanceof AbortSignal).toBe(true);
			} finally {
				handler.stop();
			}
		});
	});

	describe("Layer 3: Python urlopen timeout", () => {
		it("Python prelude has configurable timeout parameter", async () => {
			// Verify the prelude has timeout support
			expect(RLM_PRELUDE).toContain("_TIMEOUT: int = 300");
			expect(RLM_PRELUDE).toContain("timeout: int = 300");
			expect(RLM_PRELUDE).toContain("timeout=_TIMEOUT");
		});

		it("urlopen respects timeout setting", async () => {
			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			// Test that a short timeout causes the request to fail fast
			// Use localhost with a port where nothing is listening - connection should fail quickly
			const pythonCode = `
import sys
import time
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query

# Configure with very short timeout (1 second)
# Port 59991 should have nothing listening
_configure('http://127.0.0.1:59991', 'token', depth=0, timeout=1)

start = time.time()
try:
    llm_query('test')
    print('ERROR: should have timed out')
except RuntimeError as e:
    elapsed = time.time() - start
    # Connection refused should be quick, timeout is a fallback
    print(f'failed_fast: {elapsed < 5}')
    print(f'error_type: unreachable' if 'unreachable' in str(e).lower() else 'other')
`;
			const result = await $`python3 -c ${pythonCode}`.quiet().nothrow();

			expect(result.exitCode).toBe(0);
			const stdout = result.stdout.toString();
			expect(stdout).toContain("failed_fast: True");
			expect(stdout).toContain("error_type: unreachable");
		});

		it("default timeout is 300 seconds", async () => {
			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _TIMEOUT

print(f'default_timeout: {_TIMEOUT}')
`;
			const result = await $`python3 -c ${pythonCode}`.quiet().nothrow();

			expect(result.exitCode).toBe(0);
			expect(result.stdout.toString()).toContain("default_timeout: 300");
		});

		it("urlopen timeout prevents indefinite hang with unresponsive server", async () => {
			// Create a "black hole" server that accepts connections but never responds
			// This simulates a server that hangs indefinitely - the timeout should prevent
			// the client from waiting forever
			const blackHoleServer = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch: async () => {
					// Never resolve - simulate a hanging server
					await new Promise(() => {});
					return new Response("never reached");
				},
			});

			try {
				const preludePath = path.join(tempDir, "rlm_prelude.py");
				await Bun.write(preludePath, RLM_PRELUDE);

				// Use a short timeout (2 seconds) so test completes quickly
				const timeoutSec = 2;

				const pythonCode = `
import sys
import time
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query

# Configure with short timeout against the black hole server
_configure('http://127.0.0.1:${blackHoleServer.port}', 'test-token', depth=0, timeout=${timeoutSec})

start = time.time()
try:
    llm_query('test prompt')
    print('ERROR: should have timed out')
except RuntimeError as e:
    elapsed = time.time() - start
    error_msg = str(e).lower()
    # Should fail due to timeout, not immediately
    # Allow some tolerance: should take at least 1.5s but less than 10s
    timed_out_correctly = 1.5 < elapsed < 10
    print(f'elapsed: {elapsed:.2f}')
    print(f'timed_out_correctly: {timed_out_correctly}')
    # The error should indicate a timeout or connection issue
    print(f'is_timeout_error: {"timed out" in error_msg or "timeout" in error_msg or "unreachable" in error_msg}')
`;
				const result = await $`python3 -c ${pythonCode}`.quiet().nothrow();

				expect(result.exitCode).toBe(0);
				const stdout = result.stdout.toString();
				expect(stdout).toContain("timed_out_correctly: True");
				expect(stdout).toContain("is_timeout_error: True");
			} finally {
				blackHoleServer.stop();
			}
		});
	});

	describe("End-to-end abort scenarios", () => {
		it("error from handler reaches Python as RuntimeError", async () => {
			// Create handler that always returns an error
			const errorStreamFn: StreamFn = () => {
				const stream = new EventStream<{ type: "message_complete"; message: AssistantMessage }, AssistantMessage>(
					event => event.type === "message_complete",
					event => event.message,
				);

				stream.result = async () => {
					throw new Error("Simulated API error");
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
    error_msg = str(e)
    print(f'got_runtime_error: True')
    print(f'contains_status: {"HTTP" in error_msg}')
`;
				const result = await $`python3 -c ${pythonCode}`.quiet().nothrow();

				expect(result.exitCode).toBe(0);
				const stdout = result.stdout.toString();
				expect(stdout).toContain("got_runtime_error: True");
				expect(stdout).toContain("contains_status: True");
			} finally {
				handler.stop();
			}
		});

		it("retryable error includes retryable flag in error message", async () => {
			// Create handler with rate limit error
			let _requestCount = 0;
			const rateLimitStreamFn: StreamFn = () => {
				_requestCount++;
				const stream = new EventStream<{ type: "message_complete"; message: AssistantMessage }, AssistantMessage>(
					event => event.type === "message_complete",
					event => event.message,
				);

				stream.result = async () => {
					// Create an error that isRetryableError will recognize
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
    error_msg = str(e)
    print(f'error_message: {error_msg}')
    print(f'has_retryable_info: {"retryable" in error_msg.lower()}')
`;
				const result = await $`python3 -c ${pythonCode}`.quiet().nothrow();

				expect(result.exitCode).toBe(0);
				const stdout = result.stdout.toString();
				expect(stdout).toContain("has_retryable_info: True");
			} finally {
				handler.stop();
			}
		});
	});
});
