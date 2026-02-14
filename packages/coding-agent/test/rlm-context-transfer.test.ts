import { afterEach, describe, expect, it } from "bun:test";
import {
	buildSetupCell,
	type ContextTransferResult,
	getContextType,
	RLM_PRELUDE,
	writeContextToTempFile,
} from "../src/rlm/context-transfer";

describe("RLM Context Transfer", () => {
	describe("getContextType", () => {
		it("returns text type for strings", () => {
			const result = getContextType("hello world");
			expect(result.isText).toBe(true);
			expect(result.extension).toBe(".txt");
		});

		it("returns text type for empty strings", () => {
			const result = getContextType("");
			expect(result.isText).toBe(true);
			expect(result.extension).toBe(".txt");
		});

		it("returns JSON type for objects", () => {
			const result = getContextType({ key: "value" });
			expect(result.isText).toBe(false);
			expect(result.extension).toBe(".json");
		});

		it("returns JSON type for arrays", () => {
			const result = getContextType([1, 2, 3]);
			expect(result.isText).toBe(false);
			expect(result.extension).toBe(".json");
		});

		it("returns JSON type for numbers", () => {
			const result = getContextType(42);
			expect(result.isText).toBe(false);
			expect(result.extension).toBe(".json");
		});

		it("returns JSON type for null", () => {
			const result = getContextType(null);
			expect(result.isText).toBe(false);
			expect(result.extension).toBe(".json");
		});

		it("returns JSON type for boolean", () => {
			const result = getContextType(true);
			expect(result.isText).toBe(false);
			expect(result.extension).toBe(".json");
		});
	});

	describe("writeContextToTempFile", () => {
		let transfers: ContextTransferResult[] = [];

		afterEach(async () => {
			// Clean up all temp files
			for (const transfer of transfers) {
				await transfer.cleanup();
			}
			transfers = [];
		});

		it("writes text context to .txt file", async () => {
			const context = "Hello, world!";
			const result = await writeContextToTempFile(context);
			transfers.push(result);

			expect(result.isText).toBe(true);
			expect(result.extension).toBe(".txt");
			expect(result.contextPath).toMatch(/rlm_ctx_.*\.txt$/);

			// Verify file content
			const content = await Bun.file(result.contextPath).text();
			expect(content).toBe("Hello, world!");
		});

		it("writes JSON context to .json file", async () => {
			const context = { key: "value", num: 42, nested: { arr: [1, 2, 3] } };
			const result = await writeContextToTempFile(context);
			transfers.push(result);

			expect(result.isText).toBe(false);
			expect(result.extension).toBe(".json");
			expect(result.contextPath).toMatch(/rlm_ctx_.*\.json$/);

			// Verify file content is valid JSON
			const content = await Bun.file(result.contextPath).text();
			const parsed = JSON.parse(content);
			expect(parsed).toEqual(context);
		});

		it("cleanup removes temp file", async () => {
			const result = await writeContextToTempFile("test");
			const filePath = result.contextPath;

			// File should exist
			const existsBefore = await Bun.file(filePath).exists();
			expect(existsBefore).toBe(true);

			// Cleanup
			await result.cleanup();

			// File should not exist
			const existsAfter = await Bun.file(filePath).exists();
			expect(existsAfter).toBe(false);
		});

		it("cleanup is idempotent (doesn't throw on double cleanup)", async () => {
			const result = await writeContextToTempFile("test");

			// First cleanup
			await result.cleanup();

			// Second cleanup should not throw
			await expect(result.cleanup()).resolves.toBeUndefined();
		});

		it("generates unique file paths", async () => {
			const result1 = await writeContextToTempFile("test1");
			const result2 = await writeContextToTempFile("test2");
			transfers.push(result1, result2);

			expect(result1.contextPath).not.toBe(result2.contextPath);
		});
	});

	describe("buildSetupCell", () => {
		const handlerUrl = "http://127.0.0.1:12345";
		const token = "test-token-abc";
		const depth = 0;
		const contextPath = "/tmp/rlm_ctx_test.txt";

		it("builds text context setup cell", () => {
			const cell = buildSetupCell(handlerUrl, token, depth, contextPath, true);

			// Should include prelude
			expect(cell).toContain("def llm_query");
			expect(cell).toContain("def _configure");

			// Should configure handler
			expect(cell).toContain(`_configure('http://127.0.0.1:12345'`);
			expect(cell).toContain(`'test-token-abc'`);
			expect(cell).toContain(`depth=0`);
			expect(cell).toContain(`timeout=300`);

			// Should read text file directly
			expect(cell).toContain("context = open");
			expect(cell).toContain(".read()");
			// For text context, the context line should be plain read, not JSON parsing
			expect(cell).toContain("context = open('/tmp/rlm_ctx_test.txt'");
			expect(cell).not.toContain("context = _json.loads");
		});

		it("builds JSON context setup cell", () => {
			const jsonPath = "/tmp/rlm_ctx_test.json";
			const cell = buildSetupCell(handlerUrl, token, depth, jsonPath, false);

			// Should include prelude
			expect(cell).toContain("def llm_query");

			// Should configure handler
			expect(cell).toContain(`_configure('http://127.0.0.1:12345'`);

			// Should parse JSON
			expect(cell).toContain("import json as _json");
			expect(cell).toContain("_json.loads");
			expect(cell).toContain("del _json");
		});

		it("uses custom timeout", () => {
			const cell = buildSetupCell(handlerUrl, token, depth, contextPath, true, 600);
			expect(cell).toContain(`timeout=600`);
		});

		it("escapes special characters in paths", () => {
			const specialPath = "/tmp/path with'quotes/file.txt";
			const cell = buildSetupCell(handlerUrl, token, depth, specialPath, true);
			expect(cell).toContain("\\'quotes");
		});

		it("escapes backslashes in Windows paths", () => {
			const windowsPath = "C:\\Users\\test\\file.txt";
			const cell = buildSetupCell(handlerUrl, token, depth, windowsPath, true);
			// Backslashes should be escaped
			expect(cell).toContain("\\\\");
		});

		it("includes depth parameter", () => {
			const cell = buildSetupCell(handlerUrl, token, 3, contextPath, true);
			expect(cell).toContain("depth=3");
		});
	});

	describe("RLM_PRELUDE", () => {
		it("is exported and non-empty", () => {
			expect(RLM_PRELUDE).toBeDefined();
			expect(typeof RLM_PRELUDE).toBe("string");
			expect(RLM_PRELUDE.length).toBeGreaterThan(0);
		});

		it("contains required functions", () => {
			expect(RLM_PRELUDE).toContain("def llm_query");
			expect(RLM_PRELUDE).toContain("def llm_query_batched");
			expect(RLM_PRELUDE).toContain("def SHOW_VARS");
			expect(RLM_PRELUDE).toContain("def _configure");
			expect(RLM_PRELUDE).toContain("def _lm_request");
		});
	});
});
