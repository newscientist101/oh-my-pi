/**
 * LM Handler - HTTP server for Python prelude llm_query() calls.
 *
 * Provides a local HTTP endpoint that the Python REPL can call to make
 * sub-LLM queries during RLM iterations. Uses session token auth.
 *
 * ## Security Model
 *
 * **Token Scope & Lifetime:**
 * - Token is generated per-session via `crypto.randomUUID()` in the constructor
 * - Token is stored only in memory (never persisted to disk or logs)
 * - Token is invalidated when `LMHandler.stop()` is called
 * - Session end, `/new` command, and cleanup all trigger `stop()`
 * - No token rotation within a session; relies on short session lifetime
 *
 * **Network Binding:**
 * - Server binds exclusively to `127.0.0.1` (localhost only)
 * - URL is constructed internally from the bound port (no external input)
 * - Python prelude validates that the URL hostname is loopback before accepting
 *
 * **Authorization:**
 * - All requests must include `Authorization: Bearer <token>` header
 * - Invalid/missing tokens return HTTP 401 Unauthorized
 * - Token is passed to Python prelude via `_configure()` call
 */

import type { SubLlmUsage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { isRetryableError, streamSimple } from "@oh-my-pi/pi-ai";

/** Type for the stream function signature (defaults to streamSimple from @oh-my-pi/pi-ai). */
export type StreamFn = (model: Model, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;

export interface LMHandlerDeps {
	/** Get the model to use for a given depth level. */
	getModel: (depth: number) => Model;
	/** Resolve API key for a provider (goes through full auth pipeline). */
	getApiKey: (provider: string) => Promise<string | undefined>;
	/** Optional stream function for testing (defaults to streamSimple). */
	streamFn?: StreamFn;
}

interface SingleRequest {
	prompt: string;
	model?: string;
	depth?: number;
}

interface BatchedRequest {
	prompts: string[];
	model?: string;
	depth?: number;
	batched: true;
}

type LMRequest = SingleRequest | BatchedRequest;

/**
 * HTTP server for sub-LLM calls from Python prelude.
 *
 * ## Lifecycle
 *
 * 1. **Construction**: Token generated, server not yet running
 * 2. **start()**: Server binds to localhost:0, begins accepting requests
 * 3. **stop()**: Server stops, token invalidated, all pending requests cancelled
 *
 * Multiple calls to start()/stop() are safe (idempotent).
 *
 * ## Token Security
 *
 * The session token (`crypto.randomUUID()`) is:
 * - Generated once per LMHandler instance (constructor)
 * - Valid only while the server is running
 * - Required on every request via `Authorization: Bearer <token>`
 * - Never persisted, logged, or transmitted outside the local process
 *
 * ## Network Security
 *
 * - Binds exclusively to 127.0.0.1 (localhost)
 * - Port is auto-assigned by the OS (port 0)
 * - URL is constructed from the bound port (no user input)
 * - Python prelude validates URL hostname is loopback before use
 */
export class LMHandler {
	#server: Bun.Server<unknown> | null = null;
	#token = crypto.randomUUID();
	#usage = new Map<string, SubLlmUsage>();
	#deps: LMHandlerDeps;

	constructor(deps: LMHandlerDeps) {
		this.#deps = deps;
	}

	/** Port the server is listening on (0 if not started). */
	get port(): number {
		return this.#server?.port ?? 0;
	}

	/** URL of the handler (e.g., "http://127.0.0.1:12345"). */
	get url(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/** Session token for Authorization header. */
	get token(): string {
		return this.#token;
	}

	/** Whether the server is currently running. */
	get isRunning(): boolean {
		return this.#server !== null;
	}

	/**
	 * Get a snapshot of per-model usage statistics.
	 * Returns a shallow copy of the usage map.
	 */
	getUsage(): Map<string, SubLlmUsage> {
		return new Map(this.#usage);
	}

	/** Reset accumulated usage counters. */
	resetUsage(): void {
		this.#usage.clear();
	}

	/**
	 * Start the HTTP server.
	 * Safe to call multiple times (no-op if already running).
	 */
	start(): void {
		if (this.#server) return;

		this.#server = Bun.serve({
			port: 0, // auto-assign
			hostname: "127.0.0.1", // localhost only
			fetch: req => this.#handleRequest(req),
		});
	}

	/**
	 * Stop the HTTP server.
	 * Safe to call multiple times (no-op if not running).
	 */
	stop(): void {
		this.#server?.stop();
		this.#server = null;
	}

	async #handleRequest(req: Request): Promise<Response> {
		// Only accept POST to /
		if (req.method !== "POST") {
			return Response.json({ error: "Method not allowed" }, { status: 405 });
		}

		const url = new URL(req.url);
		if (url.pathname !== "/") {
			return Response.json({ error: "Not found" }, { status: 404 });
		}

		// Auth check
		const auth = req.headers.get("Authorization");
		if (auth !== `Bearer ${this.#token}`) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		try {
			const body = (await req.json()) as LMRequest;

			// Propagate request.signal — when Python disconnects (KeyboardInterrupt),
			// Bun aborts this signal, which cancels the in-flight sub-LLM API call.
			const result =
				"batched" in body && body.batched
					? await this.#handleBatched(body, req.signal)
					: await this.#handleSingle(body as SingleRequest, req.signal);

			return Response.json(result);
		} catch (e) {
			// Client disconnected
			if (req.signal.aborted) {
				return Response.json({ error: "Client disconnected" }, { status: 499 });
			}

			const message = e instanceof Error ? e.message : String(e);
			const retryable = isRetryableError(e);
			const status = retryable ? 503 : 500;

			return Response.json({ error: message, retryable }, { status });
		}
	}

	async #handleSingle(request: SingleRequest, signal?: AbortSignal): Promise<{ content: string }> {
		const depth = request.depth ?? 0;
		const model = this.#deps.getModel(depth);
		const apiKey = await this.#deps.getApiKey(model.provider);

		const messages = [{ role: "user" as const, content: request.prompt, timestamp: Date.now() }];

		// Pass signal through to sub-LLM call — aborts when Python client disconnects
		const doStream = this.#deps.streamFn ?? streamSimple;
		const stream = doStream(model, { systemPrompt: "", messages, tools: [] }, { apiKey, signal });
		const result = await stream.result();

		// Accumulate usage per model
		this.#accumulateUsage(model.id, result.usage);

		// Extract text content from response
		const content = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("");

		return { content };
	}

	async #handleBatched(request: BatchedRequest, signal?: AbortSignal): Promise<{ contents: string[] }> {
		// NOTE: This is a simple parallel implementation, not true batching.
		// TODO: Add concurrency limits or true provider batch support.
		const results = await Promise.all(
			request.prompts.map(prompt =>
				this.#handleSingle({ prompt, model: request.model, depth: request.depth }, signal),
			),
		);
		return { contents: results.map(r => r.content) };
	}

	#accumulateUsage(
		modelId: string,
		usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } },
	): void {
		const prev = this.#usage.get(modelId) ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			calls: 0,
		};

		prev.input += usage.input;
		prev.output += usage.output;
		prev.cacheRead += usage.cacheRead;
		prev.cacheWrite += usage.cacheWrite;
		prev.cost += usage.cost.total;
		prev.calls += 1;

		this.#usage.set(modelId, prev);
	}
}
