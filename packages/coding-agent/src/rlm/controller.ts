/**
 * RLM Controller - IterationMode implementation for RLM.
 *
 * Provides the checkTermination predicate that:
 * - Parses FINAL/FINAL_VAR from assistant messages
 * - Resolves FINAL_VAR by reading Python variables
 * - Builds continuation messages for the next iteration
 * - Handles max iteration limits with graceful degradation
 */

import type { AgentMessage, IterationMode, SubLlmUsage } from "@oh-my-pi/pi-agent-core";
import type { LMHandler } from "./lm-handler";
import { parseRLMTermination } from "./parser";

/**
 * Configuration for creating an RLM iteration mode.
 */
export interface RLMConfig {
	/** Maximum number of autonomous iterations before force-stop. */
	maxIterations: number;
	/** Maximum depth for sub-LLM calls (for future nested RLM support). */
	maxDepth: number;
}

/**
 * Dependencies needed by the RLM controller.
 * Captured via closure when creating the IterationMode.
 */
export interface RLMDeps {
	/** Execute Python code in the kernel to resolve FINAL_VAR. */
	executePython: (code: string, signal?: AbortSignal) => Promise<{ output: string; exitCode: number | undefined }>;
	/** LM handler for sub-LLM usage tracking. */
	lmHandler: LMHandler;
	/** Optional abort signal for cancellation. */
	signal?: AbortSignal;
}

/**
 * Extract text content from an assistant message.
 * Filters out thinking blocks and joins text blocks.
 */
function extractAssistantText(message: AgentMessage): string {
	if (message.role !== "assistant" || !Array.isArray(message.content)) {
		return "";
	}

	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("");
}

/**
 * Resolve a variable's value by executing Python code.
 * Returns the string representation of the variable.
 */
async function resolveVariable(
	varName: string,
	executePython: RLMDeps["executePython"],
	signal?: AbortSignal,
): Promise<string> {
	// Execute Python code to print the variable's repr
	// Using repr() to get a clean string representation
	const code = `print(repr(${varName}))`;

	try {
		const result = await executePython(code, signal);

		if (result.exitCode !== 0) {
			throw new Error(`Failed to resolve variable '${varName}': Python execution failed`);
		}

		// Strip trailing newline from print output
		return result.output.trim();
	} catch (err) {
		if (signal?.aborted) {
			throw new Error("Variable resolution cancelled");
		}
		throw err;
	}
}

/**
 * Build a continuation message for the next iteration.
 *
 * @param iterationIndex - Current iteration index (0-based)
 * @param maxIterations - Maximum allowed iterations
 * @returns User message with continuation prompt
 */
function buildContinuationMessage(iterationIndex: number, maxIterations: number): AgentMessage {
	const remaining = maxIterations - iterationIndex - 1;

	// Warning when approaching the limit
	let limitWarning = "";
	if (remaining <= 2) {
		limitWarning =
			"\n\n⚠️ You are approaching the iteration limit. " +
			"Make sure to use FINAL() or FINAL_VAR() soon to provide your answer.";
	}

	return {
		role: "user",
		content:
			`Iteration ${iterationIndex + 1}/${maxIterations} complete. ` +
			`Continue your analysis or use FINAL()/FINAL_VAR() when ready.${limitWarning}`,
		timestamp: Date.now(),
	};
}

/**
 * Build a final iteration message when max iterations is reached.
 * Instructs the agent to provide its best answer immediately.
 */
function buildFinalIterationMessage(): AgentMessage {
	return {
		role: "user",
		content:
			"You have reached the iteration limit. " +
			"Give your best answer now based on what you have so far. " +
			"Use FINAL(your answer) immediately.",
		timestamp: Date.now(),
	};
}

/**
 * Build an error recovery message when iteration fails.
 */
function buildErrorRecoveryMessage(error: string): AgentMessage {
	return {
		role: "user",
		content:
			`Previous attempt failed with: ${error}\n\n` +
			"Try a different approach. If you have enough information, " +
			"use FINAL() to provide your answer.",
		timestamp: Date.now(),
	};
}

/**
 * Create an IterationMode for RLM.
 *
 * The checkTermination predicate parses FINAL/FINAL_VAR from assistant messages
 * and manages iteration lifecycle. Dependencies are captured via closure.
 *
 * @param config - RLM configuration
 * @param deps - Dependencies (executePython, lmHandler, signal)
 * @returns IterationMode instance
 */
export function createRLMIterationMode(config: RLMConfig, deps: RLMDeps): IterationMode {
	let currentIteration = 0;

	return {
		maxIterations: config.maxIterations,

		async checkTermination(
			message: AgentMessage,
		): Promise<{ done: true; result: unknown } | { done: false; followUp: AgentMessage[] }> {
			try {
				// Extract text content from the assistant message
				const text = extractAssistantText(message);
				const termination = parseRLMTermination(text);

				if (termination.terminated) {
					// FINAL_VAR: resolve the variable value
					if (termination.varName) {
						const value = await resolveVariable(termination.varName, deps.executePython, deps.signal);
						return { done: true, result: value };
					}

					// FINAL: return the answer directly
					return { done: true, result: termination.answer };
				}

				// Not terminated — check if we're at the limit
				// Note: maxIterations check is done by the agent loop,
				// but we provide a warning as we approach it
				currentIteration++;

				// At max-1, give one more chance with urgent message
				if (currentIteration + 1 >= config.maxIterations) {
					return {
						done: false,
						followUp: [buildFinalIterationMessage()],
					};
				}

				// Normal continuation
				return {
					done: false,
					followUp: [buildContinuationMessage(currentIteration, config.maxIterations)],
				};
			} catch (err) {
				// On error, provide a recovery prompt instead of crashing
				const errorMessage = err instanceof Error ? err.message : String(err);

				// If signal was aborted, let it propagate
				if (deps.signal?.aborted) {
					throw err;
				}

				return {
					done: false,
					followUp: [buildErrorRecoveryMessage(errorMessage)],
				};
			}
		},
	};
}

/**
 * Get sub-LLM usage from the LM handler.
 * Used by the agent loop to attach usage to iteration events.
 */
export function getSubLlmUsage(lmHandler: LMHandler): Map<string, SubLlmUsage> {
	return lmHandler.getUsage();
}
