import type { SubLlmUsage } from "@oh-my-pi/pi-agent-core";
import { Box, Container, Spacer, Text, truncateToWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";

/**
 * Format token count with K suffix for large numbers.
 */
function formatTokens(n: number): string {
	if (n >= 10000) {
		return `${(n / 1000).toFixed(1)}K`;
	}
	return n.toString();
}

/**
 * Format cost as dollar amount.
 */
function formatCost(cost: number): string {
	return `$${cost.toFixed(4)}`;
}

/**
 * Component that renders an RLM iteration complete notification.
 * Shows when an iteration completes with FINAL/FINAL_VAR.
 */
export class IterationCompleteComponent extends Container {
	#box: Box;

	constructor(
		private readonly index: number,
		private readonly subLlmUsage?: Map<string, SubLlmUsage>,
	) {
		super();

		this.addChild(new Spacer(1));

		// Use success color for completion
		this.#box = new Box(1, 1, t => theme.inverse(theme.fg("success", t)));
		this.addChild(this.#box);

		this.#rebuild();
	}

	#rebuild(): void {
		this.#box.clear();

		const header = `${theme.checkbox.checked} RLM iteration ${this.index + 1} complete`;
		this.#box.addChild(new Text(header, 0, 0));

		// Show sub-LLM usage summary if available
		if (this.subLlmUsage && this.subLlmUsage.size > 0) {
			this.#box.addChild(new Spacer(1));

			let totalInput = 0;
			let totalOutput = 0;
			let totalCost = 0;
			let totalCalls = 0;

			for (const usage of this.subLlmUsage.values()) {
				totalInput += usage.input;
				totalOutput += usage.output;
				totalCost += usage.cost;
				totalCalls += usage.calls;
			}

			const parts: string[] = [];
			if (totalCalls > 0) parts.push(`${totalCalls} sub-LLM call${totalCalls > 1 ? "s" : ""}`);
			if (totalInput > 0) parts.push(`↑${formatTokens(totalInput)}`);
			if (totalOutput > 0) parts.push(`↓${formatTokens(totalOutput)}`);
			if (totalCost > 0) parts.push(formatCost(totalCost));

			if (parts.length > 0) {
				const summary = parts.join(" | ");
				this.#box.addChild(new Text(truncateToWidth(summary, 80), 0, 0));
			}
		}
	}
}

/**
 * Component that renders an RLM iteration limit notification.
 * Shows when the max iteration limit is reached.
 */
export class IterationLimitComponent extends Container {
	#box: Box;

	constructor(
		private readonly iterations: number,
		private readonly subLlmUsage?: Map<string, SubLlmUsage>,
	) {
		super();

		this.addChild(new Spacer(1));

		// Use warning color for limit reached
		this.#box = new Box(1, 1, t => theme.inverse(theme.fg("warning", t)));
		this.addChild(this.#box);

		this.#rebuild();
	}

	#rebuild(): void {
		this.#box.clear();

		const header = `${theme.icon.warning} RLM iteration limit reached (${this.iterations} iterations)`;
		this.#box.addChild(new Text(header, 0, 0));

		// Show sub-LLM usage summary if available
		if (this.subLlmUsage && this.subLlmUsage.size > 0) {
			this.#box.addChild(new Spacer(1));

			let totalInput = 0;
			let totalOutput = 0;
			let totalCost = 0;
			let totalCalls = 0;

			for (const usage of this.subLlmUsage.values()) {
				totalInput += usage.input;
				totalOutput += usage.output;
				totalCost += usage.cost;
				totalCalls += usage.calls;
			}

			const parts: string[] = [];
			if (totalCalls > 0) parts.push(`${totalCalls} sub-LLM call${totalCalls > 1 ? "s" : ""}`);
			if (totalInput > 0) parts.push(`↑${formatTokens(totalInput)}`);
			if (totalOutput > 0) parts.push(`↓${formatTokens(totalOutput)}`);
			if (totalCost > 0) parts.push(formatCost(totalCost));

			if (parts.length > 0) {
				const summary = parts.join(" | ");
				this.#box.addChild(new Text(truncateToWidth(summary, 80), 0, 0));
			}
		}
	}
}
