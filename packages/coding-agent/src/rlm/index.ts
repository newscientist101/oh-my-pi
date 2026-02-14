/**
 * RLM (Recursive Language Model) integration module.
 *
 * Provides:
 * - LMHandler: HTTP server for Python prelude llm_query() calls
 * - controller: IterationMode implementation for RLM
 * - parser: FINAL/FINAL_VAR parsing
 * - context-transfer: Helpers for transferring context to Python kernel
 */

export {
	buildSetupCell,
	type ContextTransferResult,
	getContextType,
	RLM_PRELUDE,
	type RLMContext,
	writeContextToTempFile,
} from "./context-transfer";
export {
	createRLMIterationMode,
	getSubLlmUsage,
	type RLMConfig,
	type RLMDeps,
} from "./controller";
export { LMHandler, type LMHandlerDeps } from "./lm-handler";
export { parseRLMTermination, type TerminationResult } from "./parser";
