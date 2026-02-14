/**
 * RLM termination parser.
 *
 * Parses FINAL() and FINAL_VAR() markers from assistant messages
 * to determine when RLM iteration should terminate.
 *
 * Precedence rules:
 * 1. Prefer the last fenced ```rlm block in the message
 *    - Within it, use the last FINAL:/FINAL_VAR: line
 * 2. If no rlm fence, scan raw text for top-level FINAL(...)/FINAL_VAR(...)
 *    outside any code fence (first match wins)
 * 3. Ignore matches inside non-rlm fences and inside quoted strings
 */

export interface TerminationResult {
	/** Whether termination was detected. */
	terminated: boolean;
	/** If FINAL(answer), the extracted answer text. */
	answer?: string;
	/** If FINAL_VAR(name), the variable name to resolve. */
	varName?: string;
}

/** Regex to match fenced code blocks: ```lang\n...\n``` */
const FENCE_REGEX = /```(\w*)\n([\s\S]*?)```/g;

/** Regex to match FINAL: or FINAL_VAR: in rlm fence (colon syntax) */
const FINAL_LINE_REGEX = /^\s*FINAL:\s*(.+)$/m;
/** Variable names must start with letter/underscore, then word chars */
const FINAL_VAR_LINE_REGEX = /^\s*FINAL_VAR:\s*([a-zA-Z_]\w*)\s*$/m;

/** Regex to match FINAL(...) or FINAL_VAR(...) function-call syntax */
const FINAL_FUNC_REGEX = /FINAL\(([^)]+)\)/;
/** Variable names must start with letter/underscore, then word chars */
const FINAL_VAR_FUNC_REGEX = /FINAL_VAR\(([a-zA-Z_]\w*)\)/;

interface FenceBlock {
	lang: string;
	content: string;
	start: number;
	end: number;
}

/**
 * Extract all fenced code blocks from text.
 * Returns array of { lang, content, start, end } for each block.
 */
function extractFencedBlocks(text: string): FenceBlock[] {
	const blocks: FenceBlock[] = [];

	// Use matchAll to avoid assignment in loop condition
	for (const match of text.matchAll(FENCE_REGEX)) {
		blocks.push({
			lang: match[1] ?? "",
			content: match[2] ?? "",
			start: match.index,
			end: match.index + match[0].length,
		});
	}

	return blocks;
}

/**
 * Check if a position is inside a quoted string.
 * Simple heuristic: count unescaped quotes before the position.
 */
function isInsideQuotedString(text: string, position: number): boolean {
	const before = text.slice(0, position);

	// Count unescaped double quotes
	const doubleQuotes = (before.match(/(?<![\\])"(?![\\])/g) || []).length;
	if (doubleQuotes % 2 === 1) return true;

	// Count unescaped single quotes
	const singleQuotes = (before.match(/(?<![\\])'(?![\\])/g) || []).length;
	if (singleQuotes % 2 === 1) return true;

	return false;
}

/**
 * Check if a position is inside any fenced code block.
 */
function isInsideFence(blocks: Array<{ start: number; end: number }>, position: number): boolean {
	return blocks.some(block => position >= block.start && position < block.end);
}

/**
 * Parse termination from an rlm fenced block.
 * Returns the last FINAL or FINAL_VAR found in the block.
 */
function parseRlmBlock(content: string): TerminationResult | null {
	const lines = content.split("\n");
	let result: TerminationResult | null = null;

	for (const line of lines) {
		// Check for FINAL_VAR: (colon syntax)
		const varMatch = FINAL_VAR_LINE_REGEX.exec(line);
		if (varMatch) {
			result = { terminated: true, varName: varMatch[1] };
		}

		// Check for FINAL: (colon syntax)
		const finalMatch = FINAL_LINE_REGEX.exec(line);
		if (finalMatch) {
			result = { terminated: true, answer: finalMatch[1]?.trim() };
		}

		// Check for FINAL_VAR(name) (function syntax)
		const varFuncMatch = FINAL_VAR_FUNC_REGEX.exec(line);
		if (varFuncMatch) {
			result = { terminated: true, varName: varFuncMatch[1] };
		}

		// Check for FINAL(...) (function syntax)
		const funcMatch = FINAL_FUNC_REGEX.exec(line);
		if (funcMatch) {
			result = { terminated: true, answer: funcMatch[1]?.trim() };
		}
	}

	return result;
}

/**
 * Parse termination markers from assistant message content.
 *
 * Precedence:
 * 1. Last ```rlm block → last FINAL/FINAL_VAR within it
 * 2. Top-level FINAL(...)/FINAL_VAR(...) outside fences → first match
 *
 * @param content - The assistant message content to parse
 * @returns Termination result with answer or variable name
 */
export function parseRLMTermination(content: string): TerminationResult {
	const blocks = extractFencedBlocks(content);

	// Strategy 1: Look for rlm fenced blocks (last one wins)
	const rlmBlocks = blocks.filter(b => b.lang === "rlm");
	if (rlmBlocks.length > 0) {
		const lastRlmBlock = rlmBlocks[rlmBlocks.length - 1]!;
		const result = parseRlmBlock(lastRlmBlock.content);
		if (result) {
			return result;
		}
	}

	// Strategy 2: Scan for top-level FINAL/FINAL_VAR outside any fence
	// Try FINAL_VAR first (more specific), then FINAL

	// Look for FINAL_VAR(name) outside fences
	// Variable names must start with letter/underscore
	const varFuncRegex = /FINAL_VAR\(([a-zA-Z_]\w*)\)/g;
	for (const match of content.matchAll(varFuncRegex)) {
		const pos = match.index;
		if (!isInsideFence(blocks, pos) && !isInsideQuotedString(content, pos)) {
			return { terminated: true, varName: match[1] };
		}
	}

	// Look for FINAL(...) outside fences
	// Use a more permissive regex that handles multiline content
	const funcRegex = /FINAL\(([^)]+)\)/g;
	for (const match of content.matchAll(funcRegex)) {
		const pos = match.index;
		if (!isInsideFence(blocks, pos) && !isInsideQuotedString(content, pos)) {
			return { terminated: true, answer: match[1]?.trim() };
		}
	}

	return { terminated: false };
}
