import { describe, expect, it, mock } from "bun:test";
import type { AssistantMessage, ThinkingContent, UserMessage } from "@oh-my-pi/pi-ai";
import { createRLMIterationMode, type RLMConfig, type RLMDeps } from "../src/rlm/controller";
import type { LMHandler } from "../src/rlm/lm-handler";

// Mock LMHandler
function createMockLMHandler(): LMHandler {
	return {
		getUsage: () => new Map(),
		resetUsage: () => {},
		port: 12345,
		url: "http://127.0.0.1:12345",
		token: "test-token",
		isRunning: true,
		start: () => {},
		stop: () => {},
	} as unknown as LMHandler;
}

// Helper to create an assistant message
function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("createRLMIterationMode", () => {
	const defaultConfig: RLMConfig = {
		maxIterations: 10,
		maxDepth: 2,
	};

	describe("FINAL detection", () => {
		it("returns done with answer on FINAL()", async () => {
			const deps: RLMDeps = {
				executePython: mock(async () => ({ output: "", exitCode: 0 })),
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("After analysis, FINAL(The answer is 42)");

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(true);
			if (result.done) {
				expect(result.result).toBe("The answer is 42");
			}
		});

		it("returns done with answer on FINAL: in rlm fence", async () => {
			const deps: RLMDeps = {
				executePython: mock(async () => ({ output: "", exitCode: 0 })),
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage(`
Here is my analysis:

\`\`\`rlm
FINAL: Climate change is the main theme
\`\`\`
`);

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(true);
			if (result.done) {
				expect(result.result).toBe("Climate change is the main theme");
			}
		});
	});

	describe("FINAL_VAR detection", () => {
		it("resolves variable via Python execution", async () => {
			const executePython = mock(async () => ({ output: "'resolved value'\n", exitCode: 0 }));
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("FINAL_VAR(my_result)");

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(true);
			if (result.done) {
				expect(result.result).toBe("'resolved value'");
			}
			expect(executePython).toHaveBeenCalledWith("print(repr(my_result))", undefined);
		});

		it("handles Python execution failure with error recovery", async () => {
			const executePython = mock(async () => ({ output: "NameError: name 'x' is not defined", exitCode: 1 }));
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("FINAL_VAR(nonexistent)");

			const result = await mode.checkTermination(message);

			// Should return error recovery message, not crash
			expect(result.done).toBe(false);
			if (!result.done) {
				expect(result.followUp.length).toBe(1);
				const followUp = result.followUp[0] as UserMessage;
				expect(followUp?.role).toBe("user");
				expect(typeof followUp?.content === "string" && followUp.content.includes("Previous attempt failed")).toBe(
					true,
				);
			}
		});
	});

	describe("continuation messages", () => {
		it("returns follow-up message when no termination marker", async () => {
			const deps: RLMDeps = {
				executePython: mock(async () => ({ output: "", exitCode: 0 })),
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("Just some analysis without a final marker.");

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(false);
			if (!result.done) {
				expect(result.followUp.length).toBe(1);
				const followUp = result.followUp[0] as UserMessage;
				expect(followUp?.role).toBe("user");
				expect(typeof followUp?.content === "string" && followUp.content.includes("Iteration")).toBe(true);
			}
		});

		it("marks continuation messages as synthetic for export filtering", async () => {
			const deps: RLMDeps = {
				executePython: mock(async () => ({ output: "", exitCode: 0 })),
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("Analysis in progress.");

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(false);
			if (!result.done) {
				const followUp = result.followUp[0] as UserMessage;
				expect(followUp?.synthetic).toBe(true);
			}
		});

		it("includes warning when approaching iteration limit", async () => {
			const config: RLMConfig = { maxIterations: 5, maxDepth: 2 };
			const deps: RLMDeps = {
				executePython: mock(async () => ({ output: "", exitCode: 0 })),
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(config, deps);
			const message = createAssistantMessage("No marker here.");

			// Iterate a few times to approach the limit
			await mode.checkTermination(message);
			await mode.checkTermination(message);
			const result = await mode.checkTermination(message);

			expect(result.done).toBe(false);
			if (!result.done) {
				const followUp = result.followUp[0] as UserMessage;
				expect(
					typeof followUp?.content === "string" && followUp.content.includes("approaching the iteration limit"),
				).toBe(true);
			}
		});

		it("sends final iteration message at max-1", async () => {
			const config: RLMConfig = { maxIterations: 3, maxDepth: 2 };
			const deps: RLMDeps = {
				executePython: mock(async () => ({ output: "", exitCode: 0 })),
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(config, deps);
			const message = createAssistantMessage("No marker.");

			// First iteration
			await mode.checkTermination(message);
			// Second iteration - should trigger final message
			const result = await mode.checkTermination(message);

			expect(result.done).toBe(false);
			if (!result.done) {
				const followUp = result.followUp[0] as UserMessage;
				expect(
					typeof followUp?.content === "string" && followUp.content.includes("reached the iteration limit"),
				).toBe(true);
				expect(typeof followUp?.content === "string" && followUp.content.includes("best answer now")).toBe(true);
				// Final iteration message should also be synthetic
				expect(followUp?.synthetic).toBe(true);
			}
		});

		it("marks error recovery messages as synthetic", async () => {
			const executePython = mock(async () => ({ output: "NameError: name 'x' is not defined", exitCode: 1 }));
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("FINAL_VAR(nonexistent)");

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(false);
			if (!result.done) {
				const followUp = result.followUp[0] as UserMessage;
				expect(followUp?.synthetic).toBe(true);
			}
		});
	});

	describe("edge cases", () => {
		it("handles non-assistant messages", async () => {
			const deps: RLMDeps = {
				executePython: mock(async () => ({ output: "", exitCode: 0 })),
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message: UserMessage = {
				role: "user",
				content: "FINAL(ignored)",
				timestamp: Date.now(),
			};

			const result = await mode.checkTermination(message);

			// Should not detect FINAL in user message
			expect(result.done).toBe(false);
		});

		it("filters out thinking blocks from content", async () => {
			const deps: RLMDeps = {
				executePython: mock(async () => ({ output: "", exitCode: 0 })),
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const thinkingBlock: ThinkingContent = {
				type: "thinking",
				thinking: "FINAL(in thinking - should be ignored)",
			};
			const message: AssistantMessage = {
				role: "assistant",
				content: [thinkingBlock, { type: "text", text: "FINAL(in text - should be detected)" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(true);
			if (result.done) {
				expect(result.result).toBe("in text - should be detected");
			}
		});

		it("exposes maxIterations from config", () => {
			const config: RLMConfig = { maxIterations: 15, maxDepth: 3 };
			const deps: RLMDeps = {
				executePython: mock(async () => ({ output: "", exitCode: 0 })),
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(config, deps);

			expect(mode.maxIterations).toBe(15);
		});

		it("provides getUsage that delegates to lmHandler", () => {
			const mockUsage = new Map([
				["claude-sonnet-4-20250514", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, calls: 2 }],
			]);
			const mockHandler = {
				...createMockLMHandler(),
				getUsage: () => mockUsage,
			} as unknown as LMHandler;

			const deps: RLMDeps = {
				executePython: mock(async () => ({ output: "", exitCode: 0 })),
				lmHandler: mockHandler,
			};

			const mode = createRLMIterationMode(defaultConfig, deps);

			expect(mode.getUsage).toBeDefined();
			const usage = mode.getUsage!();
			expect(usage.size).toBe(1);
			const modelUsage = usage.get("claude-sonnet-4-20250514");
			expect(modelUsage?.input).toBe(100);
			expect(modelUsage?.output).toBe(50);
			expect(modelUsage?.calls).toBe(2);
		});
	});
});
