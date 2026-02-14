import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as pythonExecutor from "@oh-my-pi/pi-coding-agent/ipy/executor";
import type { RLMToolState, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { clearAllRLMInjectionState, clearRLMInjectionState, PythonTool } from "@oh-my-pi/pi-coding-agent/tools/python";
import { Snowflake } from "@oh-my-pi/pi-utils";

function createMockPythonResult(overrides?: Partial<pythonExecutor.PythonResult>): pythonExecutor.PythonResult {
	return {
		output: "ok",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		totalLines: 1,
		totalBytes: 2,
		outputLines: 1,
		outputBytes: 2,
		displayOutputs: [],
		stdinRequested: false,
		...overrides,
	};
}

function createSession(cwd: string, sessionFile: string, rlm?: RLMToolState): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "python.toolMode": "ipy-only" }),
		rlm,
	};
}

describe("python tool RLM injection", () => {
	let testDir: string;
	let sessionFile: string;
	let executeSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `python-rlm-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		sessionFile = path.join(testDir, "session.jsonl");

		// Mock executePython to return success
		executeSpy = vi.spyOn(pythonExecutor, "executePython").mockResolvedValue(createMockPythonResult());
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await clearAllRLMInjectionState();
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	it("does not inject RLM prelude when rlm is not configured", async () => {
		const session = createSession(testDir, sessionFile);
		const pythonTool = new PythonTool(session);

		await pythonTool.execute("tool-call", { cells: [{ code: "print(1)" }] });

		// Should only have one call for the actual code
		expect(executeSpy).toHaveBeenCalledTimes(1);
		expect(executeSpy).toHaveBeenCalledWith("print(1)", expect.anything());
	});

	it("injects RLM prelude on first execution when rlm is configured", async () => {
		const rlm: RLMToolState = {
			handlerUrl: "http://127.0.0.1:12345",
			token: "test-token",
			depth: 0,
			context: "test context",
			timeout: 300,
		};
		const session = createSession(testDir, sessionFile, rlm);
		const pythonTool = new PythonTool(session);

		await pythonTool.execute("tool-call", { cells: [{ code: "print(1)" }] });

		// Should have two calls: setup cell + actual code
		expect(executeSpy).toHaveBeenCalledTimes(2);

		// First call should be the RLM setup
		const firstCall = executeSpy.mock.calls[0];
		const setupCode = firstCall[0] as string;
		expect(setupCode).toContain("_configure(");
		expect(setupCode).toContain("http://127.0.0.1:12345");
		expect(setupCode).toContain("test-token");
		expect(setupCode).toContain("depth=0");
		expect(setupCode).toContain("timeout=300");
		expect(setupCode).toContain("context = open(");

		// Second call should be the actual code
		expect(executeSpy.mock.calls[1][0]).toBe("print(1)");
	});

	it("does not re-inject RLM prelude on subsequent executions", async () => {
		const rlm: RLMToolState = {
			handlerUrl: "http://127.0.0.1:12345",
			token: "test-token",
			depth: 0,
			context: "test context",
		};
		const session = createSession(testDir, sessionFile, rlm);
		const pythonTool = new PythonTool(session);

		// First execution
		await pythonTool.execute("tool-call-1", { cells: [{ code: "print(1)" }] });
		expect(executeSpy).toHaveBeenCalledTimes(2); // setup + code

		// Second execution
		await pythonTool.execute("tool-call-2", { cells: [{ code: "print(2)" }] });
		expect(executeSpy).toHaveBeenCalledTimes(3); // no additional setup, just new code
		expect(executeSpy.mock.calls[2][0]).toBe("print(2)");
	});

	it("re-injects RLM prelude when reset=true", async () => {
		const rlm: RLMToolState = {
			handlerUrl: "http://127.0.0.1:12345",
			token: "test-token",
			depth: 0,
			context: "test context",
		};
		const session = createSession(testDir, sessionFile, rlm);
		const pythonTool = new PythonTool(session);

		// First execution
		await pythonTool.execute("tool-call-1", { cells: [{ code: "print(1)" }] });
		expect(executeSpy).toHaveBeenCalledTimes(2); // setup + code

		// Second execution with reset
		await pythonTool.execute("tool-call-2", { cells: [{ code: "print(2)" }], reset: true });

		// Should have setup again (setup + code)
		expect(executeSpy).toHaveBeenCalledTimes(4);

		// The third call should be a new setup
		const thirdCall = executeSpy.mock.calls[2];
		const setupCode = thirdCall[0] as string;
		expect(setupCode).toContain("_configure(");
	});

	it("uses JSON context for non-string data", async () => {
		const rlm: RLMToolState = {
			handlerUrl: "http://127.0.0.1:12345",
			token: "test-token",
			depth: 0,
			context: { data: [1, 2, 3] },
		};
		const session = createSession(testDir, sessionFile, rlm);
		const pythonTool = new PythonTool(session);

		await pythonTool.execute("tool-call", { cells: [{ code: "print(context)" }] });

		// Setup code should use JSON parsing
		const firstCall = executeSpy.mock.calls[0];
		const setupCode = firstCall[0] as string;
		expect(setupCode).toContain("import json as _json");
		expect(setupCode).toContain("_json.loads(");
		expect(setupCode).toContain("del _json");
	});

	it("throws error when RLM setup fails", async () => {
		// Make setup fail
		executeSpy.mockResolvedValueOnce(
			createMockPythonResult({
				exitCode: 1,
				output: "SyntaxError: invalid syntax",
			}),
		);

		const rlm: RLMToolState = {
			handlerUrl: "http://127.0.0.1:12345",
			token: "test-token",
			depth: 0,
			context: "test context",
		};
		const session = createSession(testDir, sessionFile, rlm);
		const pythonTool = new PythonTool(session);

		await expect(pythonTool.execute("tool-call", { cells: [{ code: "print(1)" }] })).rejects.toThrow(
			"RLM setup failed",
		);
	});

	it("clearRLMInjectionState clears state for specific session", async () => {
		const rlm: RLMToolState = {
			handlerUrl: "http://127.0.0.1:12345",
			token: "test-token",
			depth: 0,
			context: "test context",
		};
		const session = createSession(testDir, sessionFile, rlm);
		const pythonTool = new PythonTool(session);
		const sessionId = `session:${sessionFile}:cwd:${testDir}`;

		// First execution
		await pythonTool.execute("tool-call-1", { cells: [{ code: "print(1)" }] });
		expect(executeSpy).toHaveBeenCalledTimes(2);

		// Clear state for this session
		await clearRLMInjectionState(sessionId);

		// Next execution should re-inject
		await pythonTool.execute("tool-call-2", { cells: [{ code: "print(2)" }] });
		expect(executeSpy).toHaveBeenCalledTimes(4); // setup + code again
	});
});
