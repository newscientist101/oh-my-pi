/**
 * RLM Context Transfer - Handles transferring context to Python kernel.
 *
 * Context is transferred out-of-band via temp file to avoid:
 * - Size blowups from inline stringification
 * - Escaping errors with special characters
 * - Large setup cell strings
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import rlmPrelude from "../ipy/prelude/rlm.py" with { type: "text" };

/** Context type: string → plain text, anything else → JSON */
export type RLMContext = unknown;

export interface ContextTransferResult {
	/** Path to the temp file containing the context */
	contextPath: string;
	/** File extension (.txt or .json) */
	extension: ".txt" | ".json";
	/** Whether context is text (true) or JSON (false) */
	isText: boolean;
	/** Cleanup function to remove temp file */
	cleanup: () => Promise<void>;
}

/**
 * Determines the context type and returns the appropriate file extension.
 *
 * @param context - The context to transfer
 * @returns Object with isText flag and extension
 */
export function getContextType(context: RLMContext): { isText: boolean; extension: ".txt" | ".json" } {
	const isText = typeof context === "string";
	return {
		isText,
		extension: isText ? ".txt" : ".json",
	};
}

/**
 * Writes context to a temporary file.
 *
 * Uses `Bun.write()` which auto-creates parent directories.
 * The temp file is placed in the system temp directory with a unique name.
 *
 * @param context - The context to write (string for text, anything else for JSON)
 * @returns Transfer result with path, extension, and cleanup function
 */
export async function writeContextToTempFile(context: RLMContext): Promise<ContextTransferResult> {
	const { isText, extension } = getContextType(context);

	// Generate unique temp file path
	const tempDir = os.tmpdir();
	const uniqueId = crypto.randomUUID();
	const contextPath = path.join(tempDir, `rlm_ctx_${uniqueId}${extension}`);

	// Write content based on type
	const content = isText ? (context as string) : JSON.stringify(context);
	await Bun.write(contextPath, content);

	// Create cleanup function
	const cleanup = async (): Promise<void> => {
		try {
			await fs.rm(contextPath, { force: true });
		} catch {
			// Ignore cleanup errors - file may already be deleted
		}
	};

	return {
		contextPath,
		extension,
		isText,
		cleanup,
	};
}

/**
 * Builds the setup cell string to inject into IPython kernel.
 *
 * The setup cell is small and deterministic — no inline user data.
 * It:
 * 1. Executes the RLM prelude code
 * 2. Calls _configure() with handler URL, token, and depth
 * 3. Loads context from the temp file
 *
 * @param handlerUrl - LM handler URL (e.g., "http://127.0.0.1:12345")
 * @param token - Session token for authorization
 * @param depth - Current recursion depth
 * @param contextPath - Path to the temp file containing context
 * @param isText - Whether context is plain text (true) or JSON (false)
 * @param timeout - Request timeout in seconds (default: 300)
 * @returns Python code string to execute
 */
export function buildSetupCell(
	handlerUrl: string,
	token: string,
	depth: number,
	contextPath: string,
	isText: boolean,
	timeout = 300,
): string {
	// Escape special characters in paths and strings for Python
	const escapedPath = contextPath.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
	const escapedUrl = handlerUrl.replace(/'/g, "\\'");
	const escapedToken = token.replace(/'/g, "\\'");

	if (isText) {
		// Text context: read as plain string
		return `${rlmPrelude}

_configure('${escapedUrl}', '${escapedToken}', depth=${depth}, timeout=${timeout})
context = open('${escapedPath}', 'r', encoding='utf-8').read()
`;
	}

	// JSON context: parse as JSON
	return `${rlmPrelude}

_configure('${escapedUrl}', '${escapedToken}', depth=${depth}, timeout=${timeout})
import json as _json
context = _json.loads(open('${escapedPath}', 'r', encoding='utf-8').read())
del _json
`;
}

/**
 * RLM prelude content for direct injection or testing.
 */
export const RLM_PRELUDE = rlmPrelude;
