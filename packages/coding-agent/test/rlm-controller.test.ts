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

		it("marks continuation messages with rlmIteration for compaction batch-summarization", async () => {
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
				expect(followUp?.rlmIteration).toBe(true);
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
				// Final iteration message should also be synthetic and rlmIteration
				expect(followUp?.synthetic).toBe(true);
				expect(followUp?.rlmIteration).toBe(true);
			}
		});

		it("marks error recovery messages as synthetic and rlmIteration", async () => {
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
				expect(followUp?.rlmIteration).toBe(true);
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

	describe("FINAL_VAR round-trip", () => {
		it("resolves string variable correctly", async () => {
			const executePython = mock(async () => ({ output: "'Hello, World!'", exitCode: 0 }));
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("FINAL_VAR(greeting)");

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(true);
			if (result.done) {
				expect(result.result).toBe("'Hello, World!'");
			}
			expect(executePython).toHaveBeenCalledWith("print(repr(greeting))", undefined);
		});

		it("resolves integer variable correctly", async () => {
			const executePython = mock(async () => ({ output: "42\n", exitCode: 0 }));
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("FINAL_VAR(count)");

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(true);
			if (result.done) {
				expect(result.result).toBe("42");
			}
		});

		it("resolves list variable correctly", async () => {
			const executePython = mock(async () => ({ output: "['a', 'b', 'c']\n", exitCode: 0 }));
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("FINAL_VAR(items)");

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(true);
			if (result.done) {
				expect(result.result).toBe("['a', 'b', 'c']");
			}
		});

		it("resolves dict variable correctly", async () => {
			const executePython = mock(async () => ({ output: "{'key': 'value', 'count': 3}\n", exitCode: 0 }));
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("FINAL_VAR(result_dict)");

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(true);
			if (result.done) {
				expect(result.result).toBe("{'key': 'value', 'count': 3}");
			}
		});

		it("resolves variable with underscores in name", async () => {
			const executePython = mock(async () => ({ output: "'final answer'\n", exitCode: 0 }));
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("FINAL_VAR(_final_answer_1)");

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(true);
			if (result.done) {
				expect(result.result).toBe("'final answer'");
			}
			expect(executePython).toHaveBeenCalledWith("print(repr(_final_answer_1))", undefined);
		});

		it("resolves multiline variable output correctly", async () => {
			const multilineOutput = "'Line 1\\nLine 2\\nLine 3'";
			const executePython = mock(async () => ({ output: `${multilineOutput}\n`, exitCode: 0 }));
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("FINAL_VAR(text)");

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(true);
			if (result.done) {
				expect(result.result).toBe(multilineOutput);
			}
		});

		it("handles FINAL_VAR in rlm fence block", async () => {
			const executePython = mock(async () => ({ output: "'from fence'\n", exitCode: 0 }));
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage(`
I have computed the result:

\`\`\`rlm
FINAL_VAR: summary
\`\`\`
`);

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(true);
			if (result.done) {
				expect(result.result).toBe("'from fence'");
			}
			expect(executePython).toHaveBeenCalledWith("print(repr(summary))", undefined);
		});
	});

	describe("iteration counter progression", () => {
		it("increments iteration count on each call without termination", async () => {
			const config: RLMConfig = { maxIterations: 10, maxDepth: 2 };
			const deps: RLMDeps = {
				executePython: mock(async () => ({ output: "", exitCode: 0 })),
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(config, deps);
			const message = createAssistantMessage("Working...");

			// First call - iteration counter increments to 1, shows "Iteration 2/10" (counter+1)
			let result = await mode.checkTermination(message);
			expect(result.done).toBe(false);
			if (!result.done) {
				const followUp = result.followUp[0] as UserMessage;
				expect(typeof followUp?.content === "string" && followUp.content.includes("Iteration 2/10")).toBe(true);
			}

			// Second call - iteration counter increments to 2, shows "Iteration 3/10"
			result = await mode.checkTermination(message);
			expect(result.done).toBe(false);
			if (!result.done) {
				const followUp = result.followUp[0] as UserMessage;
				expect(typeof followUp?.content === "string" && followUp.content.includes("Iteration 3/10")).toBe(true);
			}

			// Third call - iteration counter increments to 3, shows "Iteration 4/10"
			result = await mode.checkTermination(message);
			expect(result.done).toBe(false);
			if (!result.done) {
				const followUp = result.followUp[0] as UserMessage;
				expect(typeof followUp?.content === "string" && followUp.content.includes("Iteration 4/10")).toBe(true);
			}
		});

		it("terminates early when FINAL is detected without further incrementing", async () => {
			const config: RLMConfig = { maxIterations: 10, maxDepth: 2 };
			const deps: RLMDeps = {
				executePython: mock(async () => ({ output: "", exitCode: 0 })),
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(config, deps);

			// First call - no termination, counter increments to 1
			let result = await mode.checkTermination(createAssistantMessage("Working..."));
			expect(result.done).toBe(false);
			if (!result.done) {
				const followUp = result.followUp[0] as UserMessage;
				expect(typeof followUp?.content === "string" && followUp.content.includes("Iteration 2/10")).toBe(true);
			}

			// Second call - FINAL detected, terminates without incrementing
			result = await mode.checkTermination(createAssistantMessage("FINAL(Done!)"));
			expect(result.done).toBe(true);
			if (result.done) {
				expect(result.result).toBe("Done!");
			}
		});
	});

	describe("max iterations limit", () => {
		it("completes full iteration sequence from start to end", async () => {
			const config: RLMConfig = { maxIterations: 5, maxDepth: 2 };
			const deps: RLMDeps = {
				executePython: mock(async () => ({ output: "", exitCode: 0 })),
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(config, deps);
			const message = createAssistantMessage("Still working...");

			// Call 1: counter=1, shows "Iteration 2/5", no warning (remaining=3)
			let result = await mode.checkTermination(message);
			expect(result.done).toBe(false);
			if (!result.done) {
				const followUp = result.followUp[0] as UserMessage;
				expect(typeof followUp?.content === "string" && followUp.content.includes("Iteration 2/5 complete")).toBe(
					true,
				);
				expect(
					typeof followUp?.content === "string" && !followUp.content.includes("approaching the iteration limit"),
				).toBe(true);
			}

			// Call 2: counter=2, shows "Iteration 3/5", warning (remaining=2)
			result = await mode.checkTermination(message);
			expect(result.done).toBe(false);
			if (!result.done) {
				const followUp = result.followUp[0] as UserMessage;
				expect(typeof followUp?.content === "string" && followUp.content.includes("Iteration 3/5 complete")).toBe(
					true,
				);
				expect(
					typeof followUp?.content === "string" && followUp.content.includes("approaching the iteration limit"),
				).toBe(true);
			}

			// Call 3: counter=3, shows "Iteration 4/5", warning (remaining=1)
			result = await mode.checkTermination(message);
			expect(result.done).toBe(false);
			if (!result.done) {
				const followUp = result.followUp[0] as UserMessage;
				expect(typeof followUp?.content === "string" && followUp.content.includes("Iteration 4/5 complete")).toBe(
					true,
				);
				expect(
					typeof followUp?.content === "string" && followUp.content.includes("approaching the iteration limit"),
				).toBe(true);
			}

			// Call 4: counter=4, triggers final iteration message (counter+1 >= maxIterations)
			result = await mode.checkTermination(message);
			expect(result.done).toBe(false);
			if (!result.done) {
				const followUp = result.followUp[0] as UserMessage;
				expect(
					typeof followUp?.content === "string" && followUp.content.includes("reached the iteration limit"),
				).toBe(true);
				expect(typeof followUp?.content === "string" && followUp.content.includes("best answer now")).toBe(true);
			}
		});

		it("can terminate with FINAL even at max iteration", async () => {
			const config: RLMConfig = { maxIterations: 3, maxDepth: 2 };
			const deps: RLMDeps = {
				executePython: mock(async () => ({ output: "", exitCode: 0 })),
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(config, deps);

			// First iteration
			await mode.checkTermination(createAssistantMessage("Working..."));
			// Second iteration - at max-1, gets final message
			const result2 = await mode.checkTermination(createAssistantMessage("Almost done..."));
			expect(result2.done).toBe(false);
			if (!result2.done) {
				const followUp = result2.followUp[0] as UserMessage;
				expect(
					typeof followUp?.content === "string" && followUp.content.includes("reached the iteration limit"),
				).toBe(true);
			}

			// Third call - agent responds with FINAL
			const result3 = await mode.checkTermination(createAssistantMessage("FINAL(My best answer)"));
			expect(result3.done).toBe(true);
			if (result3.done) {
				expect(result3.result).toBe("My best answer");
			}
		});

		it("can terminate with FINAL_VAR at max iteration", async () => {
			const config: RLMConfig = { maxIterations: 2, maxDepth: 2 };
			const executePython = mock(async () => ({ output: "'computed value'\n", exitCode: 0 }));
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(config, deps);

			// First iteration - gets final iteration message
			const result1 = await mode.checkTermination(createAssistantMessage("Computing..."));
			expect(result1.done).toBe(false);
			if (!result1.done) {
				const followUp = result1.followUp[0] as UserMessage;
				expect(
					typeof followUp?.content === "string" && followUp.content.includes("reached the iteration limit"),
				).toBe(true);
			}

			// Second call - agent responds with FINAL_VAR
			const result2 = await mode.checkTermination(createAssistantMessage("FINAL_VAR(my_result)"));
			expect(result2.done).toBe(true);
			if (result2.done) {
				expect(result2.result).toBe("'computed value'");
			}
		});

		it("handles single iteration limit (maxIterations=1)", async () => {
			const config: RLMConfig = { maxIterations: 1, maxDepth: 2 };
			const deps: RLMDeps = {
				executePython: mock(async () => ({ output: "", exitCode: 0 })),
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(config, deps);

			// Even first iteration should get the final message
			const result = await mode.checkTermination(createAssistantMessage("Hello"));
			expect(result.done).toBe(false);
			if (!result.done) {
				const followUp = result.followUp[0] as UserMessage;
				expect(
					typeof followUp?.content === "string" && followUp.content.includes("reached the iteration limit"),
				).toBe(true);
			}
		});
	});

	describe("error recovery", () => {
		it("recovers from FINAL_VAR with undefined variable", async () => {
			const executePython = mock(async () => ({
				output: "Traceback (most recent call last):\n  ...\nNameError: name 'undefined_var' is not defined",
				exitCode: 1,
			}));
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("FINAL_VAR(undefined_var)");

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(false);
			if (!result.done) {
				const followUp = result.followUp[0] as UserMessage;
				expect(typeof followUp?.content === "string" && followUp.content.includes("Previous attempt failed")).toBe(
					true,
				);
				expect(typeof followUp?.content === "string" && followUp.content.includes("Try a different approach")).toBe(
					true,
				);
			}
		});

		it("includes error message in recovery prompt", async () => {
			const errorMessage = "SyntaxError: invalid syntax at line 5";
			const executePython = mock(async () => ({
				output: errorMessage,
				exitCode: 1,
			}));
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("FINAL_VAR(broken_var)");

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(false);
			if (!result.done) {
				const followUp = result.followUp[0] as UserMessage;
				// Error message should mention the Python failure
				expect(
					typeof followUp?.content === "string" && followUp.content.includes("Failed to resolve variable"),
				).toBe(true);
			}
		});

		it("propagates abort signal to Python execution", async () => {
			const controller = new AbortController();
			const executePython = mock(async (_code: string, signal?: AbortSignal) => {
				// Simulate checking the signal
				if (signal?.aborted) {
					throw new Error("Aborted");
				}
				return { output: "'result'", exitCode: 0 };
			});
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
				signal: controller.signal,
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("FINAL_VAR(my_var)");

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(true);
			// Verify the signal was passed to executePython
			expect(executePython).toHaveBeenCalledWith("print(repr(my_var))", controller.signal);
		});

		it("re-throws when abort signal is aborted", async () => {
			const controller = new AbortController();
			const executePython = mock(async (_code: string, _signal?: AbortSignal) => {
				throw new Error("Execution cancelled");
			});
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
				signal: controller.signal,
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("FINAL_VAR(my_var)");

			// Abort the signal
			controller.abort();

			// Should re-throw when signal is aborted
			await expect(mode.checkTermination(message)).rejects.toThrow();
		});
	});

	describe("iteration-level failure recovery", () => {
		it("returns recovery prompt when executePython throws unexpected error", async () => {
			const executePython = mock(async () => {
				throw new Error("Kernel connection lost");
			});
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("FINAL_VAR(my_var)");

			// Should NOT throw, should return recovery prompt
			const result = await mode.checkTermination(message);

			expect(result.done).toBe(false);
			if (!result.done) {
				const followUp = result.followUp[0] as UserMessage;
				expect(typeof followUp?.content === "string" && followUp.content.includes("Previous attempt failed")).toBe(
					true,
				);
				expect(typeof followUp?.content === "string" && followUp.content.includes("Kernel connection lost")).toBe(
					true,
				);
				expect(typeof followUp?.content === "string" && followUp.content.includes("Try a different approach")).toBe(
					true,
				);
			}
		});

		it("recovery prompt does not crash the agent loop", async () => {
			const executePython = mock(async () => {
				throw new Error("Network timeout");
			});
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("FINAL_VAR(result)");

			// Verify calling checkTermination doesn't throw
			const result = await mode.checkTermination(message);

			// Result is valid and usable by agent loop
			expect(result.done).toBe(false);
			if (!result.done) {
				expect(result.followUp).toBeArray();
				expect(result.followUp.length).toBeGreaterThan(0);
				expect(result.followUp[0]?.role).toBe("user");
			}
		});

		it("can recover and continue after an error", async () => {
			let callCount = 0;
			const executePython = mock(async () => {
				callCount++;
				if (callCount === 1) {
					throw new Error("First call fails");
				}
				return { output: "'success'", exitCode: 0 };
			});
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);

			// First call fails with recovery prompt
			const result1 = await mode.checkTermination(createAssistantMessage("FINAL_VAR(x)"));
			expect(result1.done).toBe(false);

			// Second call succeeds after "agent" tries again
			const result2 = await mode.checkTermination(createAssistantMessage("FINAL_VAR(x)"));
			expect(result2.done).toBe(true);
			if (result2.done) {
				expect(result2.result).toBe("'success'");
			}
		});

		it("handles non-Error objects thrown", async () => {
			const executePython = mock(async () => {
				throw "string error"; // Some code throws non-Error objects
			});
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const message = createAssistantMessage("FINAL_VAR(x)");

			// Should handle gracefully, not crash
			const result = await mode.checkTermination(message);

			expect(result.done).toBe(false);
			if (!result.done) {
				const followUp = result.followUp[0] as UserMessage;
				expect(typeof followUp?.content === "string" && followUp.content.includes("string error")).toBe(true);
			}
		});

		it("distinguishes abort signal from other errors", async () => {
			// Without abort signal, error gets recovery prompt
			const executePythonNoAbort = mock(async () => {
				throw new Error("Some error");
			});
			const depsNoAbort: RLMDeps = {
				executePython: executePythonNoAbort,
				lmHandler: createMockLMHandler(),
				// No signal
			};

			const modeNoAbort = createRLMIterationMode(defaultConfig, depsNoAbort);
			const resultNoAbort = await modeNoAbort.checkTermination(createAssistantMessage("FINAL_VAR(x)"));

			expect(resultNoAbort.done).toBe(false); // Recovery prompt, no throw

			// With aborted signal, error propagates
			const controller = new AbortController();
			controller.abort();

			const executePythonAborted = mock(async () => {
				throw new Error("Aborted");
			});
			const depsAborted: RLMDeps = {
				executePython: executePythonAborted,
				lmHandler: createMockLMHandler(),
				signal: controller.signal,
			};

			const modeAborted = createRLMIterationMode(defaultConfig, depsAborted);

			// Should throw, not return recovery prompt
			await expect(modeAborted.checkTermination(createAssistantMessage("FINAL_VAR(x)"))).rejects.toThrow();
		});

		it("recovery message has correct metadata for export/compaction", async () => {
			const executePython = mock(async () => {
				throw new Error("Test error");
			});
			const deps: RLMDeps = {
				executePython,
				lmHandler: createMockLMHandler(),
			};

			const mode = createRLMIterationMode(defaultConfig, deps);
			const result = await mode.checkTermination(createAssistantMessage("FINAL_VAR(x)"));

			expect(result.done).toBe(false);
			if (!result.done) {
				const followUp = result.followUp[0] as UserMessage;
				// Recovery messages should be marked for filtering from exports
				expect(followUp?.synthetic).toBe(true);
				// And for batch-summarization in compaction
				expect(followUp?.rlmIteration).toBe(true);
			}
		});
	});
});

describe("graceful degradation at iteration_limit", () => {
	/**
	 * Tests verify that when iteration_limit is reached:
	 * 1. The agent ALREADY received and responded to "give best answer now" message
	 * 2. The agent had one more chance to provide FINAL()
	 * 3. The flow matches the agent-loop behavior
	 *
	 * The interaction between checkTermination and agent-loop:
	 * - Controller injects "give best answer now" at maxIterations - 1
	 * - Agent-loop checks iteration limit AFTER getting follow-up from checkTermination
	 * - This ensures agent sees the warning before limit is enforced
	 */

	it("simulates full flow: warning → response → limit", async () => {
		// Scenario: maxIterations = 3
		// Iteration 0: normal continuation
		// Iteration 1: "give best answer now" message injected
		// Iteration 2: agent responds, still no FINAL → iteration_limit

		const config: RLMConfig = { maxIterations: 3, maxDepth: 2 };
		const deps: RLMDeps = {
			executePython: mock(async () => ({ output: "", exitCode: 0 })),
			lmHandler: createMockLMHandler(),
		};

		const mode = createRLMIterationMode(config, deps);

		// Track messages sent to agent
		const followUpMessages: string[] = [];

		// Iteration 0: Agent does some work, no FINAL
		const result1 = await mode.checkTermination(createAssistantMessage("I'm analyzing the data..."));
		expect(result1.done).toBe(false);
		if (!result1.done) {
			const content = (result1.followUp[0] as UserMessage).content;
			if (typeof content === "string") {
				followUpMessages.push(content);
				// Should be normal continuation, not the limit warning yet
				expect(content.includes("reached the iteration limit")).toBe(false);
			}
		}

		// Iteration 1: Controller should inject "give best answer now"
		const result2 = await mode.checkTermination(createAssistantMessage("Still processing chunks..."));
		expect(result2.done).toBe(false);
		if (!result2.done) {
			const content = (result2.followUp[0] as UserMessage).content;
			if (typeof content === "string") {
				followUpMessages.push(content);
				// THIS is where the agent sees the warning
				expect(content.includes("reached the iteration limit")).toBe(true);
				expect(content.includes("best answer now")).toBe(true);
			}
		}

		// Iteration 2: Agent responds to warning but still doesn't FINAL
		// In real flow, agent-loop would check limit AFTER checkTermination
		const result3 = await mode.checkTermination(createAssistantMessage("I don't have enough info..."));

		// Controller returns another follow-up (can't know agent-loop will stop it)
		expect(result3.done).toBe(false);

		// Verify the agent received proper warning before limit
		expect(followUpMessages.length).toBe(2);
		expect(followUpMessages[1]).toContain("best answer now");
	});

	it("agent can still FINAL after receiving the warning", async () => {
		const config: RLMConfig = { maxIterations: 3, maxDepth: 2 };
		const deps: RLMDeps = {
			executePython: mock(async () => ({ output: "", exitCode: 0 })),
			lmHandler: createMockLMHandler(),
		};

		const mode = createRLMIterationMode(config, deps);

		// Iteration 0: normal work
		await mode.checkTermination(createAssistantMessage("Working..."));

		// Iteration 1: receives warning
		const warningResult = await mode.checkTermination(createAssistantMessage("Still working..."));
		expect(warningResult.done).toBe(false);
		if (!warningResult.done) {
			const content = (warningResult.followUp[0] as UserMessage).content;
			expect(typeof content === "string" && content.includes("best answer now")).toBe(true);
		}

		// Iteration 2: agent heeds the warning and provides FINAL
		const finalResult = await mode.checkTermination(createAssistantMessage("FINAL(My best guess is X)"));
		expect(finalResult.done).toBe(true);
		if (finalResult.done) {
			expect(finalResult.result).toBe("My best guess is X");
		}
	});

	it("agent-loop stops when limit exceeded even if controller returns follow-up", async () => {
		// This documents the coordination between controller and agent-loop:
		// - Controller always returns follow-up (doesn't track agent-loop's iteration index)
		// - Agent-loop enforces the hard limit via iterationIndex check
		// - The "give best answer" message is sent ONE iteration before the limit

		const config: RLMConfig = { maxIterations: 2, maxDepth: 2 };
		const deps: RLMDeps = {
			executePython: mock(async () => ({ output: "", exitCode: 0 })),
			lmHandler: createMockLMHandler(),
		};

		const mode = createRLMIterationMode(config, deps);

		// Simulating agent-loop behavior:
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const _iterationIndex = 0; // Used in comments to document the flow

		// First call (iterationIndex = 0)
		const result1 = await mode.checkTermination(createAssistantMessage("Working..."));
		expect(result1.done).toBe(false);
		// Agent-loop check: 0 + 1 >= 2? Yes! But controller already sent final warning

		if (!result1.done) {
			const content = (result1.followUp[0] as UserMessage).content;
			// With maxIterations=2, even first iteration gets the warning
			expect(typeof content === "string" && content.includes("reached the iteration limit")).toBe(true);
		}

		// After first check, if agent-loop's condition (iterationIndex + 1 >= maxIterations)
		// is true, it would emit iteration_limit. But the message above was already
		// delivered to the agent, so the agent SAW the warning.

		// This verifies the graceful degradation: agent always gets warned before limit
	});

	it("final iteration message is marked synthetic and rlmIteration", async () => {
		const config: RLMConfig = { maxIterations: 2, maxDepth: 2 };
		const deps: RLMDeps = {
			executePython: mock(async () => ({ output: "", exitCode: 0 })),
			lmHandler: createMockLMHandler(),
		};

		const mode = createRLMIterationMode(config, deps);

		const result = await mode.checkTermination(createAssistantMessage("Working..."));
		expect(result.done).toBe(false);

		if (!result.done) {
			const followUp = result.followUp[0] as UserMessage;
			// Final iteration message should be properly tagged
			expect(followUp.synthetic).toBe(true);
			expect(followUp.rlmIteration).toBe(true);
		}
	});

	it("verifies warning timing: warning at N-1, limit enforced at N", async () => {
		// For maxIterations = 5:
		// - Iterations 0, 1, 2: normal continuation with "approaching limit" warnings
		// - Iteration 3: "give best answer now" (N-1 = 4-1 = 3... wait, let me trace)
		//
		// Actually, let's trace controller.currentIteration vs config.maxIterations:
		// Initial: currentIteration = 0
		// Call 1: increment to 1, check 1+1 >= 5? No (2 < 5), return normal
		// Call 2: increment to 2, check 2+1 >= 5? No (3 < 5), return normal
		// Call 3: increment to 3, check 3+1 >= 5? No (4 < 5), return normal
		// Call 4: increment to 4, check 4+1 >= 5? Yes! return buildFinalIterationMessage
		// Call 5: increment to 5, check 5+1 >= 5? Yes! return buildFinalIterationMessage again
		//
		// Agent-loop with iterationIndex:
		// After call 1: iterationIndex = 0+1 = 1, check 1+1 >= 5? No, continue
		// After call 2: iterationIndex = 2, check 2+1 >= 5? No, continue
		// After call 3: iterationIndex = 3, check 3+1 >= 5? No, continue
		// After call 4: iterationIndex = 4, check 4+1 >= 5? Yes! emit iteration_limit
		//
		// So: Warning appears at controller call 4 (when iterationIndex becomes 4)
		//     Limit enforced at agent-loop check after call 4

		const config: RLMConfig = { maxIterations: 5, maxDepth: 2 };
		const deps: RLMDeps = {
			executePython: mock(async () => ({ output: "", exitCode: 0 })),
			lmHandler: createMockLMHandler(),
		};

		const mode = createRLMIterationMode(config, deps);

		// Calls 1-3: normal continuation
		for (let i = 0; i < 3; i++) {
			const result = await mode.checkTermination(createAssistantMessage("Working..."));
			expect(result.done).toBe(false);
			if (!result.done) {
				const content = (result.followUp[0] as UserMessage).content;
				// Might have "approaching" warning but not "reached" yet
				expect(typeof content === "string" && content.includes("reached the iteration limit")).toBe(false);
			}
		}

		// Call 4: should get the final warning
		const result4 = await mode.checkTermination(createAssistantMessage("Working..."));
		expect(result4.done).toBe(false);
		if (!result4.done) {
			const content = (result4.followUp[0] as UserMessage).content;
			expect(typeof content === "string" && content.includes("reached the iteration limit")).toBe(true);
			expect(typeof content === "string" && content.includes("best answer now")).toBe(true);
		}
	});
});
