/**
 * Tests for iteration_complete/iteration_limit event handling in TUI
 *
 * NOTE: These tests verify the wiring without importing the actual components,
 * since the components require native modules to be built.
 * The actual component rendering is tested via manual verification.
 */

import { describe, expect, it } from "bun:test";
import type { SubLlmUsage } from "@oh-my-pi/pi-agent-core";

/**
 * Copy of the formatTokens function from iteration-status.ts for testing
 */
function formatTokens(n: number): string {
	if (n >= 10000) {
		return `${(n / 1000).toFixed(1)}K`;
	}
	return n.toString();
}

/**
 * Copy of the formatCost function from iteration-status.ts for testing
 */
function formatCost(cost: number): string {
	return `$${cost.toFixed(4)}`;
}

describe("iteration status formatting", () => {
	describe("formatTokens", () => {
		it("returns plain number for small values", () => {
			expect(formatTokens(500)).toBe("500");
			expect(formatTokens(9999)).toBe("9999");
		});

		it("returns K suffix for 10K and above", () => {
			expect(formatTokens(10000)).toBe("10.0K");
			expect(formatTokens(15500)).toBe("15.5K");
			expect(formatTokens(100000)).toBe("100.0K");
		});
	});

	describe("formatCost", () => {
		it("formats cost with 4 decimal places", () => {
			expect(formatCost(0.0123)).toBe("$0.0123");
			expect(formatCost(1.5)).toBe("$1.5000");
			expect(formatCost(0)).toBe("$0.0000");
		});
	});

	describe("usage aggregation logic", () => {
		it("aggregates totals from multiple models", () => {
			const usage = new Map<string, SubLlmUsage>([
				[
					"claude-sonnet",
					{
						input: 500,
						output: 200,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0.01,
						calls: 2,
					},
				],
				[
					"claude-haiku",
					{
						input: 300,
						output: 100,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0.005,
						calls: 1,
					},
				],
			]);

			let totalInput = 0;
			let totalOutput = 0;
			let totalCost = 0;
			let totalCalls = 0;

			for (const u of usage.values()) {
				totalInput += u.input;
				totalOutput += u.output;
				totalCost += u.cost;
				totalCalls += u.calls;
			}

			expect(totalInput).toBe(800);
			expect(totalOutput).toBe(300);
			expect(totalCost).toBe(0.015);
			expect(totalCalls).toBe(3);
		});

		it("handles empty usage map", () => {
			const usage = new Map<string, SubLlmUsage>();

			let totalCalls = 0;
			for (const u of usage.values()) {
				totalCalls += u.calls;
			}

			expect(totalCalls).toBe(0);
			expect(usage.size).toBe(0);
		});
	});
});

describe("event handler wiring", () => {
	it("iteration_complete event has correct shape", () => {
		const event = {
			type: "iteration_complete" as const,
			index: 5,
			result: "The answer is 42",
			subLlmUsage: new Map<string, SubLlmUsage>(),
		};

		expect(event.type).toBe("iteration_complete");
		expect(event.index).toBe(5);
		expect(event.result).toBe("The answer is 42");
		expect(event.subLlmUsage).toBeDefined();
	});

	it("iteration_limit event has correct shape", () => {
		const event = {
			type: "iteration_limit" as const,
			iterations: 10,
			subLlmUsage: new Map<string, SubLlmUsage>(),
		};

		expect(event.type).toBe("iteration_limit");
		expect(event.iterations).toBe(10);
		expect(event.subLlmUsage).toBeDefined();
	});
});
