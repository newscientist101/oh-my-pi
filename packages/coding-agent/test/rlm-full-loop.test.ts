/**
 * Integration test: full RLM loop (context load → iterations → FINAL)
 *
 * Tests the complete RLM flow:
 * 1. Context loading (text or JSON)
 * 2. Python kernel setup with RLM prelude
 * 3. Multiple iterations with checkTermination
 * 4. Termination via FINAL() or FINAL_VAR()
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { EventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { $ } from "bun";
import { RLM_PRELUDE } from "../src/rlm/context-transfer";
import { createRLMIterationMode, type RLMConfig, type RLMDeps } from "../src/rlm/controller";
import { LMHandler, type LMHandlerDeps, type StreamFn } from "../src/rlm/lm-handler";

// Helper to create assistant messages
function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { total: 0.001, input: 0.0005, output: 0.0005, cacheRead: 0, cacheWrite: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
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
			stream.result = () => Promise.reject(responseOrError);
			return stream as unknown as ReturnType<StreamFn>;
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

async function runPython(code: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const result = await $`python3 -c ${code}`.quiet().nothrow();
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

describe("RLM Full Loop Integration", () => {
	let handler: LMHandler;
	let tempDir: string;
	const responses = new Map<string, string | Error>();

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `rlm-full-loop-${crypto.randomUUID()}`);
		await fs.mkdir(tempDir, { recursive: true });

		responses.clear();
		const deps: LMHandlerDeps = {
			getModel: () => createMockModel(),
			getApiKey: async () => "test-api-key",
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
			// Ignore
		}
	});

	describe("context loading", () => {
		it("loads text context into Python namespace", async () => {
			const contextContent = "Hello, this is my text context for analysis.";
			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			const contextPath = path.join(tempDir, "context.txt");
			await Bun.write(contextPath, contextContent);

			const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure

_configure('${handler.url}', '${handler.token}', depth=0)
context = open('${contextPath}', 'r', encoding='utf-8').read()
print(context, end='')
`;
			const result = await runPython(pythonCode);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe(contextContent);
		});

		it("loads JSON context into Python namespace", async () => {
			const contextObj = { items: ["a", "b", "c"], count: 3 };
			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			const contextPath = path.join(tempDir, "context.json");
			await Bun.write(contextPath, JSON.stringify(contextObj));

			const pythonCode = `
import sys
import json
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure

_configure('${handler.url}', '${handler.token}', depth=0)
context = json.loads(open('${contextPath}', 'r', encoding='utf-8').read())
print(context['count'], end='')
`;
			const result = await runPython(pythonCode);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("3");
		});
	});

	describe("iteration with llm_query", () => {
		it("performs sub-LLM query during iteration", async () => {
			responses.set("Summarize: chunk1", "Summary of chunk1");

			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query

_configure('${handler.url}', '${handler.token}', depth=0)
result = llm_query('Summarize: chunk1')
print(result, end='')
`;
			const result = await runPython(pythonCode);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("Summary of chunk1");
		});

		it("performs multiple iterations with batched queries", async () => {
			responses.set("Analyze: part1", "Analysis1");
			responses.set("Analyze: part2", "Analysis2");
			responses.set("Analyze: part3", "Analysis3");

			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			const pythonCode = `
import sys
import json
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query_batched

_configure('${handler.url}', '${handler.token}', depth=0)
results = llm_query_batched(['Analyze: part1', 'Analyze: part2', 'Analyze: part3'])
print(json.dumps(results), end='')
`;
			const result = await runPython(pythonCode);

			expect(result.exitCode).toBe(0);
			const analyses = JSON.parse(result.stdout) as string[];
			expect(analyses).toEqual(["Analysis1", "Analysis2", "Analysis3"]);
		});
	});

	describe("termination via FINAL()", () => {
		it("checkTermination returns done on FINAL()", async () => {
			const config: RLMConfig = { maxIterations: 10, maxDepth: 1 };
			const deps: RLMDeps = {
				executePython: mock(async () => ({ output: "", exitCode: 0 })),
				lmHandler: handler,
			};

			const mode = createRLMIterationMode(config, deps);
			// Note: Avoid contractions like "I've" as the parser's quote detection
			// treats the apostrophe as starting a quoted string
			const message = createAssistantMessage("I analyzed the data. FINAL(The answer is 42)");

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(true);
			if (result.done) {
				expect(result.result).toBe("The answer is 42");
			}
		});

		it("checkTermination handles FINAL in rlm fence", async () => {
			const config: RLMConfig = { maxIterations: 10, maxDepth: 1 };
			const deps: RLMDeps = {
				executePython: mock(async () => ({ output: "", exitCode: 0 })),
				lmHandler: handler,
			};

			const mode = createRLMIterationMode(config, deps);
			// Note: FINAL: colon syntax captures to end of line only
			const message = createAssistantMessage(`
After analysis:
\`\`\`rlm
FINAL: The complete analysis result
\`\`\`
`);

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(true);
			if (result.done) {
				expect(result.result).toBe("The complete analysis result");
			}
		});
	});

	describe("termination via FINAL_VAR()", () => {
		it("resolves variable via Python execution", async () => {
			const config: RLMConfig = { maxIterations: 10, maxDepth: 1 };
			const executePython = mock(async (code: string) => {
				if (code.includes("print(repr(my_result))")) {
					return { output: "'computed answer'", exitCode: 0 };
				}
				return { output: "", exitCode: 0 };
			});
			const deps: RLMDeps = { executePython, lmHandler: handler };

			const mode = createRLMIterationMode(config, deps);
			const message = createAssistantMessage("FINAL_VAR(my_result)");

			const result = await mode.checkTermination(message);

			expect(result.done).toBe(true);
			if (result.done) {
				expect(result.result).toBe("'computed answer'");
			}
			expect(executePython).toHaveBeenCalledWith("print(repr(my_result))", undefined);
		});
	});

	describe("full loop simulation", () => {
		it("simulates multi-iteration loop with sub-LLM calls ending in FINAL", async () => {
			// Set up mock LLM responses for sub-queries
			responses.set("Summarize part 1", "Part 1 summary");
			responses.set("Summarize part 2", "Part 2 summary");
			responses.set("Combine summaries", "Combined result");

			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			// Create iteration mode
			const config: RLMConfig = { maxIterations: 5, maxDepth: 1 };
			const executePython = async (code: string): Promise<{ output: string; exitCode: number }> => {
				// Execute actual Python for llm_query calls
				const fullCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query
_configure('${handler.url}', '${handler.token}', depth=0)
${code}
`;
				const result = await runPython(fullCode);
				return { output: result.stdout, exitCode: result.exitCode };
			};
			const deps: RLMDeps = { executePython, lmHandler: handler };
			const mode = createRLMIterationMode(config, deps);

			// Iteration 1: Agent analyzes and makes sub-LLM calls
			const msg1 = createAssistantMessage(`
I'll analyze the context in parts.
\`\`\`repl
part1 = llm_query('Summarize part 1')
part2 = llm_query('Summarize part 2')
print(f"Got: {part1}, {part2}")
\`\`\`
`);
			const result1 = await mode.checkTermination(msg1);
			expect(result1.done).toBe(false);
			if (!result1.done) {
				expect(result1.followUp).toHaveLength(1);
				expect(result1.followUp[0].role).toBe("user");
			}

			// Iteration 2: Agent combines and provides final answer
			const msg2 = createAssistantMessage(`
Now I have both summaries. Let me combine them.
FINAL(The analysis shows that Part 1 summary and Part 2 summary together reveal the answer.)
`);
			const result2 = await mode.checkTermination(msg2);
			expect(result2.done).toBe(true);
			if (result2.done) {
				expect(result2.result).toContain("Part 1 summary");
				expect(result2.result).toContain("Part 2 summary");
			}
		});

		it("tracks sub-LLM usage across iterations", async () => {
			responses.set("*", "mock response");

			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			// Make several sub-LLM calls via Python
			const pythonCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query

_configure('${handler.url}', '${handler.token}', depth=0)
llm_query('query1')
llm_query('query2')
llm_query('query3')
print('done', end='')
`;
			const result = await runPython(pythonCode);
			expect(result.exitCode).toBe(0);

			// Create iteration mode and check usage via getUsage
			const config: RLMConfig = { maxIterations: 5, maxDepth: 1 };
			const deps: RLMDeps = {
				executePython: async () => ({ output: "", exitCode: 0 }),
				lmHandler: handler,
			};
			const mode = createRLMIterationMode(config, deps);

			// getUsage should return accumulated usage from handler
			const usage = mode.getUsage?.();
			expect(usage).toBeDefined();
			const modelUsage = usage?.get("claude-sonnet-4-20250514");
			expect(modelUsage).toBeDefined();
			expect(modelUsage!.calls).toBe(3);
			expect(modelUsage!.input).toBe(30); // 10 * 3
			expect(modelUsage!.output).toBe(60); // 20 * 3
		});

		it("handles max iterations gracefully", async () => {
			const config: RLMConfig = { maxIterations: 2, maxDepth: 1 };
			const deps: RLMDeps = {
				executePython: async () => ({ output: "", exitCode: 0 }),
				lmHandler: handler,
			};
			const mode = createRLMIterationMode(config, deps);

			// First iteration - no FINAL, continues
			const msg1 = createAssistantMessage("Still working on it...");
			const result1 = await mode.checkTermination(msg1);
			expect(result1.done).toBe(false);
			if (!result1.done) {
				// At iteration 1 with max 2, should get final iteration message
				const content = result1.followUp[0];
				if (content.role === "user" && typeof content.content === "string") {
					expect(content.content).toContain("iteration limit");
					expect(content.content).toContain("best answer");
				}
			}
		});

		it("handles error recovery during iteration", async () => {
			const config: RLMConfig = { maxIterations: 5, maxDepth: 1 };
			const executePython = mock(async (code: string) => {
				if (code.includes("undefined_var")) {
					return { output: "NameError: name 'undefined_var' is not defined", exitCode: 1 };
				}
				return { output: "", exitCode: 0 };
			});
			const deps: RLMDeps = { executePython, lmHandler: handler };
			const mode = createRLMIterationMode(config, deps);

			// Agent tries FINAL_VAR with undefined variable
			const msg = createAssistantMessage("FINAL_VAR(undefined_var)");
			const result = await mode.checkTermination(msg);

			// Should return recovery prompt instead of crashing
			expect(result.done).toBe(false);
			if (!result.done) {
				const content = result.followUp[0];
				if (content.role === "user" && typeof content.content === "string") {
					expect(content.content).toContain("failed");
					expect(content.content).toContain("different approach");
				}
			}
		});
	});

	describe("end-to-end with actual Python", () => {
		it("complete flow: context → llm_query → FINAL_VAR", async () => {
			responses.set("Summarize: Hello World", "This is a greeting");

			const preludePath = path.join(tempDir, "rlm_prelude.py");
			await Bun.write(preludePath, RLM_PRELUDE);

			// Simulate the agent's Python execution
			const executePython = async (code: string): Promise<{ output: string; exitCode: number }> => {
				const fullCode = `
import sys
sys.path.insert(0, '${tempDir}')
from rlm_prelude import _configure, llm_query
_configure('${handler.url}', '${handler.token}', depth=0)

# Simulate context
context = "Hello World"

# Create the variable that FINAL_VAR will reference
result = llm_query(f"Summarize: {context}")

# Now execute the actual code from checkTermination
${code}
`;
				const res = await runPython(fullCode);
				return { output: res.stdout, exitCode: res.exitCode };
			};

			const config: RLMConfig = { maxIterations: 5, maxDepth: 1 };
			const deps: RLMDeps = { executePython, lmHandler: handler };
			const mode = createRLMIterationMode(config, deps);

			// Agent message with FINAL_VAR
			const msg = createAssistantMessage("FINAL_VAR(result)");
			const checkResult = await mode.checkTermination(msg);

			expect(checkResult.done).toBe(true);
			if (checkResult.done) {
				// The result should be the repr of "This is a greeting"
				expect(checkResult.result).toBe("'This is a greeting'");
			}
		});
	});
});
