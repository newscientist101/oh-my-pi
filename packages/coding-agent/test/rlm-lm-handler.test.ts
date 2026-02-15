import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { EventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { LMHandler, type LMHandlerDeps, type StreamFn } from "../src/rlm/lm-handler";

/** Type for JSON responses from LMHandler. */
interface LMHandlerResponse {
	content?: string;
	contents?: string[];
	error?: string;
	retryable?: boolean;
}

/**
 * Create a mock stream function that returns a predetermined response.
 */
function createMockStreamFn(responses: Map<string, string | Error>): StreamFn {
	return (model, context, _options) => {
		const prompt = context.messages[0]?.content;
		const promptKey = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
		const responseOrError = responses.get(promptKey) ?? "default response";

		// Create a mock event stream
		const stream = new EventStream<{ type: "message_complete"; message: AssistantMessage }, AssistantMessage>(
			event => event.type === "message_complete",
			event => event.message,
		);

		if (responseOrError instanceof Error) {
			// Simulate error by rejecting the stream
			setTimeout(() => {
				stream.end();
			}, 0);
			// We need to handle this differently - throw synchronously would be caught
			// Instead, we'll handle errors at a higher level
			const errorStream = new EventStream<{ type: "message_complete"; message: AssistantMessage }, AssistantMessage>(
				event => event.type === "message_complete",
				event => event.message,
			);
			// Override result() to throw
			errorStream.result = () => Promise.reject(responseOrError);
			return errorStream as unknown as ReturnType<StreamFn>;
		}

		// Simulate successful response
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

/** Create a mock model for testing. */
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

describe("LMHandler", () => {
	let handler: LMHandler;
	const responses = new Map<string, string | Error>();

	beforeEach(() => {
		responses.clear();
		const deps: LMHandlerDeps = {
			getModel: (_depth: number) => createMockModel(),
			getApiKey: async (_provider: string) => "test-api-key",
			streamFn: createMockStreamFn(responses),
		};
		handler = new LMHandler(deps);
		handler.start();
	});

	afterEach(() => {
		handler.stop();
	});

	describe("lifecycle", () => {
		it("starts and assigns a port", () => {
			expect(handler.isRunning).toBe(true);
			expect(handler.port).toBeGreaterThan(0);
			expect(handler.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		});

		it("generates a unique token", () => {
			expect(handler.token).toMatch(/^[0-9a-f-]{36}$/);
		});

		it("handles double start gracefully", () => {
			const port = handler.port;
			handler.start(); // Should be no-op
			expect(handler.port).toBe(port);
		});

		it("handles double stop gracefully", () => {
			handler.stop();
			expect(handler.isRunning).toBe(false);
			handler.stop(); // Should be no-op
			expect(handler.isRunning).toBe(false);
		});
	});

	describe("authentication", () => {
		it("rejects requests without Authorization header", async () => {
			const response = await fetch(handler.url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "test" }),
			});

			expect(response.status).toBe(401);
			const body = (await response.json()) as LMHandlerResponse;
			expect(body.error).toBe("Unauthorized");
		});

		it("rejects requests with wrong token", async () => {
			const response = await fetch(handler.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer wrong-token",
				},
				body: JSON.stringify({ prompt: "test" }),
			});

			expect(response.status).toBe(401);
			const body = (await response.json()) as LMHandlerResponse;
			expect(body.error).toBe("Unauthorized");
		});

		it("accepts requests with correct token", async () => {
			responses.set("hello", "world");

			const response = await fetch(handler.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${handler.token}`,
				},
				body: JSON.stringify({ prompt: "hello" }),
			});

			expect(response.status).toBe(200);
		});
	});

	describe("HTTP methods and routes", () => {
		it("rejects GET requests", async () => {
			const response = await fetch(handler.url, {
				method: "GET",
				headers: { Authorization: `Bearer ${handler.token}` },
			});

			expect(response.status).toBe(405);
			const body = (await response.json()) as LMHandlerResponse;
			expect(body.error).toBe("Method not allowed");
		});

		it("rejects requests to wrong paths", async () => {
			const response = await fetch(`${handler.url}/other`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${handler.token}`,
				},
				body: JSON.stringify({ prompt: "test" }),
			});

			expect(response.status).toBe(404);
			const body = (await response.json()) as LMHandlerResponse;
			expect(body.error).toBe("Not found");
		});
	});

	describe("single requests", () => {
		it("returns content for single prompt", async () => {
			responses.set("What is 2+2?", "The answer is 4");

			const response = await fetch(handler.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${handler.token}`,
				},
				body: JSON.stringify({ prompt: "What is 2+2?" }),
			});

			expect(response.status).toBe(200);
			const body = (await response.json()) as LMHandlerResponse;
			expect(body.content).toBe("The answer is 4");
		});

		it("accepts depth parameter", async () => {
			const getModel = mock((_depth: number) => createMockModel());
			const deps: LMHandlerDeps = {
				getModel,
				getApiKey: async () => "test-key",
				streamFn: createMockStreamFn(responses),
			};
			const customHandler = new LMHandler(deps);
			customHandler.start();

			try {
				responses.set("test", "response");

				await fetch(customHandler.url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${customHandler.token}`,
					},
					body: JSON.stringify({ prompt: "test", depth: 2 }),
				});

				expect(getModel).toHaveBeenCalledWith(2);
			} finally {
				customHandler.stop();
			}
		});

		it("defaults depth to 0", async () => {
			const getModel = mock((_depth: number) => createMockModel());
			const deps: LMHandlerDeps = {
				getModel,
				getApiKey: async () => "test-key",
				streamFn: createMockStreamFn(responses),
			};
			const customHandler = new LMHandler(deps);
			customHandler.start();

			try {
				responses.set("test", "response");

				await fetch(customHandler.url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${customHandler.token}`,
					},
					body: JSON.stringify({ prompt: "test" }),
				});

				expect(getModel).toHaveBeenCalledWith(0);
			} finally {
				customHandler.stop();
			}
		});
	});

	describe("batched requests", () => {
		it("returns contents for batched prompts", async () => {
			responses.set("Question 1", "Answer 1");
			responses.set("Question 2", "Answer 2");
			responses.set("Question 3", "Answer 3");

			const response = await fetch(handler.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${handler.token}`,
				},
				body: JSON.stringify({
					prompts: ["Question 1", "Question 2", "Question 3"],
					batched: true,
				}),
			});

			expect(response.status).toBe(200);
			const body = (await response.json()) as LMHandlerResponse;
			expect(body.contents).toEqual(["Answer 1", "Answer 2", "Answer 3"]);
		});

		it("passes depth to batched requests", async () => {
			const getModel = mock((_depth: number) => createMockModel());
			const deps: LMHandlerDeps = {
				getModel,
				getApiKey: async () => "test-key",
				streamFn: createMockStreamFn(responses),
			};
			const customHandler = new LMHandler(deps);
			customHandler.start();

			try {
				responses.set("p1", "r1");
				responses.set("p2", "r2");

				await fetch(customHandler.url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${customHandler.token}`,
					},
					body: JSON.stringify({
						prompts: ["p1", "p2"],
						batched: true,
						depth: 3,
					}),
				});

				// Each prompt in the batch should call getModel with the same depth
				expect(getModel).toHaveBeenCalledTimes(2);
				expect(getModel).toHaveBeenCalledWith(3);
			} finally {
				customHandler.stop();
			}
		});

		it("limits concurrency to prevent rate limiting", async () => {
			// Track concurrent executions
			let maxConcurrent = 0;
			let currentConcurrent = 0;
			const { promise: allStarted, resolve: resolveAllStarted } = Promise.withResolvers<void>();
			let started = 0;

			// Create a custom stream function that tracks concurrency
			const customStreamFn: StreamFn = model => {
				currentConcurrent++;
				started++;
				maxConcurrent = Math.max(maxConcurrent, currentConcurrent);

				// Signal when all prompts have started (to verify limit)
				if (started === LMHandler.BATCH_CONCURRENCY) {
					resolveAllStarted();
				}

				const stream = new EventStream<{ type: "message_complete"; message: AssistantMessage }, AssistantMessage>(
					event => event.type === "message_complete",
					event => event.message,
				);

				// Override result() to include delay and track concurrency
				const originalResult = stream.result.bind(stream);
				stream.result = async () => {
					await Bun.sleep(10);
					currentConcurrent--;
					return originalResult();
				};

				// Push response async
				setTimeout(() => {
					stream.push({
						type: "message_complete",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "response" }],
							api: "anthropic-messages",
							provider: "anthropic",
							model: model.id,
							usage: {
								input: 10,
								output: 5,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 15,
								cost: { total: 0.001, input: 0.0005, output: 0.0005, cacheRead: 0, cacheWrite: 0 },
							},
							stopReason: "stop",
							timestamp: Date.now(),
						},
					});
				}, 0);

				return stream as unknown as ReturnType<StreamFn>;
			};

			const deps: LMHandlerDeps = {
				getModel: () => createMockModel(),
				getApiKey: async () => "test-key",
				streamFn: customStreamFn,
			};
			const customHandler = new LMHandler(deps);
			customHandler.start();

			try {
				// Send more prompts than the concurrency limit
				const numPrompts = LMHandler.BATCH_CONCURRENCY * 2;
				const prompts = Array.from({ length: numPrompts }, (_, i) => `prompt${i}`);

				const responsePromise = fetch(customHandler.url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${customHandler.token}`,
					},
					body: JSON.stringify({ prompts, batched: true }),
				});

				// Wait for the concurrency limit to be reached
				await allStarted;

				// At this point, maxConcurrent should equal BATCH_CONCURRENCY, not numPrompts
				expect(maxConcurrent).toBeLessThanOrEqual(LMHandler.BATCH_CONCURRENCY);

				// Complete the request
				const response = await responsePromise;
				expect(response.status).toBe(200);

				const body = (await response.json()) as LMHandlerResponse;
				expect(body.contents).toHaveLength(numPrompts);

				// Verify max concurrency was respected throughout
				expect(maxConcurrent).toBe(LMHandler.BATCH_CONCURRENCY);
			} finally {
				customHandler.stop();
			}
		});

		it("preserves order of results with concurrency limiting", async () => {
			// Use varying response times to verify order is preserved
			const delays = [50, 10, 30, 20, 40]; // Deliberately non-sequential
			let callIndex = 0;

			const customStreamFn: StreamFn = model => {
				const myIndex = callIndex++;
				const delay = delays[myIndex % delays.length];

				const stream = new EventStream<{ type: "message_complete"; message: AssistantMessage }, AssistantMessage>(
					event => event.type === "message_complete",
					event => event.message,
				);

				// Override result() to include varying delays
				const originalResult = stream.result.bind(stream);
				stream.result = async () => {
					await Bun.sleep(delay);
					return originalResult();
				};

				// Push response async
				setTimeout(() => {
					stream.push({
						type: "message_complete",
						message: {
							role: "assistant",
							content: [{ type: "text", text: `response-${myIndex}` }],
							api: "anthropic-messages",
							provider: "anthropic",
							model: model.id,
							usage: {
								input: 10,
								output: 5,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 15,
								cost: { total: 0.001, input: 0.0005, output: 0.0005, cacheRead: 0, cacheWrite: 0 },
							},
							stopReason: "stop",
							timestamp: Date.now(),
						},
					});
				}, 0);

				return stream as unknown as ReturnType<StreamFn>;
			};

			const deps: LMHandlerDeps = {
				getModel: () => createMockModel(),
				getApiKey: async () => "test-key",
				streamFn: customStreamFn,
			};
			const customHandler = new LMHandler(deps);
			customHandler.start();

			try {
				const response = await fetch(customHandler.url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${customHandler.token}`,
					},
					body: JSON.stringify({
						prompts: ["p0", "p1", "p2", "p3", "p4"],
						batched: true,
					}),
				});

				expect(response.status).toBe(200);
				const body = (await response.json()) as LMHandlerResponse;

				// Results should be in order regardless of completion time
				expect(body.contents).toEqual(["response-0", "response-1", "response-2", "response-3", "response-4"]);
			} finally {
				customHandler.stop();
			}
		});
	});

	describe("error handling", () => {
		it("returns 500 for non-retryable errors", async () => {
			responses.set("fail", new Error("Something went wrong"));

			const response = await fetch(handler.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${handler.token}`,
				},
				body: JSON.stringify({ prompt: "fail" }),
			});

			expect(response.status).toBe(500);
			const body = (await response.json()) as LMHandlerResponse;
			expect(body.error).toBe("Something went wrong");
			expect(body.retryable).toBe(false);
		});

		it("handles invalid JSON in request body", async () => {
			const response = await fetch(handler.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${handler.token}`,
				},
				body: "not json",
			});

			expect(response.status).toBe(500);
			const body = (await response.json()) as LMHandlerResponse;
			expect(body.error).toBeDefined();
		});
	});

	describe("usage tracking", () => {
		it("accumulates usage per model", async () => {
			responses.set("query1", "response1");
			responses.set("query2", "response2");

			// Make two requests
			await fetch(handler.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${handler.token}`,
				},
				body: JSON.stringify({ prompt: "query1" }),
			});

			await fetch(handler.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${handler.token}`,
				},
				body: JSON.stringify({ prompt: "query2" }),
			});

			const usage = handler.getUsage();
			const modelUsage = usage.get("claude-sonnet-4-20250514");

			expect(modelUsage).toBeDefined();
			expect(modelUsage!.input).toBe(20); // 10 + 10
			expect(modelUsage!.output).toBe(40); // 20 + 20
			expect(modelUsage!.calls).toBe(2);
		});

		it("resets usage on resetUsage()", async () => {
			responses.set("query", "response");

			await fetch(handler.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${handler.token}`,
				},
				body: JSON.stringify({ prompt: "query" }),
			});

			expect(handler.getUsage().size).toBe(1);

			handler.resetUsage();

			expect(handler.getUsage().size).toBe(0);
		});

		it("getUsage returns a snapshot (copy)", async () => {
			responses.set("query", "response");

			await fetch(handler.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${handler.token}`,
				},
				body: JSON.stringify({ prompt: "query" }),
			});

			const snapshot1 = handler.getUsage();
			const snapshot2 = handler.getUsage();

			// Should be different map instances
			expect(snapshot1).not.toBe(snapshot2);
			// But same content
			expect(snapshot1.get("claude-sonnet-4-20250514")?.calls).toBe(
				snapshot2.get("claude-sonnet-4-20250514")?.calls,
			);
		});
	});

	describe("multiple models", () => {
		it("tracks usage separately per model", async () => {
			const models = [createMockModel("claude-sonnet-4-20250514"), createMockModel("claude-haiku-3-20240307")];

			const deps: LMHandlerDeps = {
				getModel: (depth: number) => models[depth] ?? models[0]!,
				getApiKey: async () => "test-key",
				streamFn: createMockStreamFn(responses),
			};
			const customHandler = new LMHandler(deps);
			customHandler.start();

			try {
				responses.set("depth0", "r0");
				responses.set("depth1", "r1");

				// Request at depth 0
				await fetch(customHandler.url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${customHandler.token}`,
					},
					body: JSON.stringify({ prompt: "depth0", depth: 0 }),
				});

				// Request at depth 1
				await fetch(customHandler.url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${customHandler.token}`,
					},
					body: JSON.stringify({ prompt: "depth1", depth: 1 }),
				});

				const usage = customHandler.getUsage();
				expect(usage.size).toBe(2);
				expect(usage.get("claude-sonnet-4-20250514")?.calls).toBe(1);
				expect(usage.get("claude-haiku-3-20240307")?.calls).toBe(1);
			} finally {
				customHandler.stop();
			}
		});
	});
});
