/**
 * RLM (Recursive Language Model) integration module.
 *
 * Provides:
 * - LMHandler: HTTP server for Python prelude llm_query() calls
 * - (future) controller: IterationMode implementation
 * - (future) parser: FINAL/FINAL_VAR parsing
 */
export { LMHandler, type LMHandlerDeps } from "./lm-handler";
