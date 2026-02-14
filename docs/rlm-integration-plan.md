# Deep Integration: RLM into oh-my-pi

This document outlines the plan to integrate the Recursive Language Model (RLM) paradigm from [alexzhang13/rlm](https://github.com/alexzhang13/rlm) directly into oh-my-pi's core agent architecture.

## Overview

**Goal:** Enable oh-my-pi to handle near-infinite context by giving the LLM a REPL environment where it can programmatically examine, decompose, and recursively call sub-LLMs.

**Approach:** Deep integration - weave RLM directly into the agent loop, Python tool, and prompting system rather than creating a separate tool.

## Core Changes

| Component | Change |
|-----------|--------|
| **Agent Loop** | Add RLM iteration mode with FINAL detection |
| **Python Tool** | Inject `llm_query()`, `context`, `FINAL()` natively |
| **System Prompt** | RLM instructions as configurable layer |
| **Session** | Track RLM state (iterations, context, depth) |

---

## Implementation

### 1. Extend Agent Loop for RLM Mode

**File:** `packages/agent/src/agent-loop.ts`

```typescript
export interface AgentLoopConfig {
  // ... existing fields ...
  
  /** RLM mode configuration */
  rlm?: {
    enabled: boolean;
    maxIterations: number;
    maxDepth: number;
    currentDepth: number;
  };
}

// In runLoop(), add RLM termination detection:
async function runLoop(
  currentContext: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
  streamFn?: StreamFn,
): Promise<void> {
  let iterationCount = 0;
  
  while (true) {
    // ... existing tool call loop ...
    
    // RLM: Check for FINAL() or FINAL_VAR() in assistant response
    if (config.rlm?.enabled) {
      const rlmResult = parseRLMTermination(message.content);
      if (rlmResult.terminated) {
        stream.push({ 
          type: "rlm_complete", 
          answer: rlmResult.answer,
          iterations: iterationCount,
        });
        break;
      }
      
      iterationCount++;
      if (iterationCount >= config.rlm.maxIterations) {
        // Force final answer
        stream.push({ type: "rlm_max_iterations", iterations: iterationCount });
        break;
      }
    }
    
    // ... rest of loop ...
  }
}
```

---

### 2. RLM Python Prelude

**File:** `packages/coding-agent/src/ipy/prelude/rlm.py`

```python
"""
RLM functions injected into IPython kernel when RLM mode is active.
"""
import json
import socket
import struct
from typing import Any

_LM_HANDLER_ADDRESS: tuple[str, int] | None = None
_CONTEXT_STORE: dict[str, Any] = {}
_DEPTH: int = 0

def _set_lm_handler(host: str, port: int):
    global _LM_HANDLER_ADDRESS
    _LM_HANDLER_ADDRESS = (host, port)

def _set_context(payload: Any, index: int = 0):
    global _CONTEXT_STORE
    _CONTEXT_STORE[f"context_{index}"] = payload
    if index == 0:
        _CONTEXT_STORE["context"] = payload

def _set_depth(depth: int):
    global _DEPTH
    _DEPTH = depth

def _send_lm_request(prompt: str | list, model: str | None = None) -> str:
    """Send request to oh-my-pi's LM handler."""
    if _LM_HANDLER_ADDRESS is None:
        raise RuntimeError("LM handler not configured")
    
    request = json.dumps({
        "prompt": prompt,
        "model": model,
        "depth": _DEPTH,
    }).encode()
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect(_LM_HANDLER_ADDRESS)
    sock.sendall(struct.pack(">I", len(request)) + request)
    
    # Read response
    length_data = sock.recv(4)
    length = struct.unpack(">I", length_data)[0]
    response_data = b""
    while len(response_data) < length:
        response_data += sock.recv(length - len(response_data))
    sock.close()
    
    result = json.loads(response_data)
    if "error" in result:
        raise RuntimeError(result["error"])
    return result["content"]

def llm_query(prompt: str, model: str = None) -> str:
    """
    Query a sub-LM from within the REPL.
    
    The sub-LM can handle ~500K characters of context.
    Use this to analyze chunks of your context variable.
    
    Args:
        prompt: The prompt to send (can include data from context)
        model: Optional model override (default uses configured sub-model)
    
    Returns:
        The LLM's response as a string
    """
    return _send_lm_request(prompt, model)

def llm_query_batched(prompts: list[str], model: str = None) -> list[str]:
    """
    Query multiple prompts concurrently.
    
    Much faster than sequential llm_query() calls when you have
    multiple independent queries.
    
    Args:
        prompts: List of prompts to send
        model: Optional model override
    
    Returns:
        List of responses in same order as prompts
    """
    request = json.dumps({
        "prompts": prompts,
        "model": model,
        "depth": _DEPTH,
        "batched": True,
    }).encode()
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect(_LM_HANDLER_ADDRESS)
    sock.sendall(struct.pack(">I", len(request)) + request)
    
    length_data = sock.recv(4)
    length = struct.unpack(">I", length_data)[0]
    response_data = b""
    while len(response_data) < length:
        response_data += sock.recv(length - len(response_data))
    sock.close()
    
    result = json.loads(response_data)
    return result["contents"]

def SHOW_VARS() -> dict:
    """
    Show all variables in the current REPL session.
    
    Use this to check what variables exist before using FINAL_VAR().
    """
    from IPython import get_ipython
    ip = get_ipython()
    user_ns = ip.user_ns
    
    # Filter to user-defined variables
    skip = {'In', 'Out', 'get_ipython', 'exit', 'quit', 'open', 
            'llm_query', 'llm_query_batched', 'SHOW_VARS', 'context',
            '_', '__', '___', '_i', '_ii', '_iii'}
    
    return {k: type(v).__name__ for k, v in user_ns.items() 
            if not k.startswith('_') and k not in skip and not callable(v)}

# Expose context variables
context = property(lambda self: _CONTEXT_STORE.get("context"))
context_0 = property(lambda self: _CONTEXT_STORE.get("context_0"))
```

---

### 3. LM Handler Server

**File:** `packages/coding-agent/src/rlm/lm-handler.ts`

```typescript
import { createServer, type Server, type Socket } from "net";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { ModelConfig } from "@oh-my-pi/pi-ai";

export class LMHandler {
  private server: Server;
  private _port: number = 0;

  constructor(
    private readonly getModel: (depth: number) => ModelConfig,
    private readonly getApiKey: (provider: string) => Promise<string>,
  ) {}

  get port(): number { return this._port; }
  get address(): [string, number] { return ["127.0.0.1", this._port]; }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((socket) => this.handleConnection(socket));
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address();
        this._port = typeof addr === "object" ? addr!.port : 0;
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
  }

  private async handleConnection(socket: Socket): Promise<void> {
    const chunks: Buffer[] = [];
    
    socket.on("data", (data) => chunks.push(data));
    socket.on("end", async () => {
      const buffer = Buffer.concat(chunks);
      const length = buffer.readUInt32BE(0);
      const request = JSON.parse(buffer.subarray(4, 4 + length).toString());
      
      try {
        const response = request.batched
          ? await this.handleBatched(request)
          : await this.handleSingle(request);
        
        const responseData = Buffer.from(JSON.stringify(response));
        const responseBuffer = Buffer.alloc(4 + responseData.length);
        responseBuffer.writeUInt32BE(responseData.length, 0);
        responseData.copy(responseBuffer, 4);
        socket.end(responseBuffer);
      } catch (e) {
        const error = { error: e instanceof Error ? e.message : String(e) };
        const errorData = Buffer.from(JSON.stringify(error));
        const errorBuffer = Buffer.alloc(4 + errorData.length);
        errorBuffer.writeUInt32BE(errorData.length, 0);
        errorData.copy(errorBuffer, 4);
        socket.end(errorBuffer);
      }
    });
  }

  private async handleSingle(request: {
    prompt: string | object[];
    model?: string;
    depth?: number;
  }): Promise<{ content: string }> {
    const model = this.getModel(request.depth ?? 0);
    const apiKey = await this.getApiKey(model.provider);
    
    const messages = typeof request.prompt === "string"
      ? [{ role: "user" as const, content: request.prompt }]
      : request.prompt;
    
    const stream = await streamSimple(model, { messages }, { apiKey });
    const result = await stream.result();
    
    const content = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map(c => c.text)
      .join("");
    
    return { content };
  }

  private async handleBatched(request: {
    prompts: string[];
    model?: string;
    depth?: number;
  }): Promise<{ contents: string[] }> {
    const results = await Promise.all(
      request.prompts.map(prompt => 
        this.handleSingle({ prompt, model: request.model, depth: request.depth })
      )
    );
    return { contents: results.map(r => r.content) };
  }
}
```

---

### 4. RLM Session Controller

**File:** `packages/coding-agent/src/rlm/controller.ts`

```typescript
import { LMHandler } from "./lm-handler";
import type { ToolSession } from "../tools";

export interface RLMConfig {
  maxIterations: number;
  maxDepth: number;
  subModel: string;  // Model for llm_query() calls
}

export interface RLMState {
  context: unknown;
  depth: number;
  iterations: number;
  lmHandler: LMHandler;
}

export async function startRLMSession(
  session: ToolSession,
  context: unknown,
  config: RLMConfig,
): Promise<RLMState> {
  const lmHandler = new LMHandler(
    (depth) => {
      // depth 0 = main model, depth 1+ = sub model
      if (depth === 0) {
        return session.currentModel;
      }
      return session.modelRegistry.getModel(config.subModel) 
        ?? session.modelRegistry.getSmolModel();
    },
    (provider) => session.authStorage.getApiKey(provider),
  );
  
  await lmHandler.start();
  
  return {
    context,
    depth: 0,
    iterations: 0,
    lmHandler,
  };
}

export function parseRLMTermination(content: string): {
  terminated: boolean;
  answer?: string;
  varName?: string;
} {
  // Check for FINAL(...)
  const finalMatch = content.match(/FINAL\(([^)]+)\)/);
  if (finalMatch) {
    return { terminated: true, answer: finalMatch[1].trim() };
  }
  
  // Check for FINAL_VAR(...)
  const finalVarMatch = content.match(/FINAL_VAR\((\w+)\)/);
  if (finalVarMatch) {
    return { terminated: true, varName: finalVarMatch[1] };
  }
  
  return { terminated: false };
}
```

---

### 5. RLM System Prompt

**File:** `packages/coding-agent/src/prompts/rlm-system.ts`

```typescript
export const RLM_SYSTEM_PROMPT_ADDITION = `
## RLM Mode

You have access to a persistent Python REPL with special capabilities:

### Available in REPL:
- \`context\` - Your input data (check type and structure first)
- \`llm_query(prompt)\` - Query a sub-LLM (~500K char context)
- \`llm_query_batched(prompts)\` - Parallel queries (faster for multiple)
- \`SHOW_VARS()\` - List all your variables

### Strategy:
1. First, examine \`context\` - check its type, length, structure
2. Plan a chunking strategy based on the data
3. Use \`llm_query()\` to analyze chunks, save results to variables
4. Aggregate results and produce final answer

### Termination:
When done, use ONE of:
- \`FINAL(your answer here)\` - Direct answer
- \`FINAL_VAR(variable_name)\` - Return a variable's value

⚠️ FINAL_VAR requires the variable to EXIST. Create it in a \`\`\`repl\`\`\` block first!

### Example:
\`\`\`repl
# Check context
print(type(context), len(context) if hasattr(context, '__len__') else 'N/A')
\`\`\`

\`\`\`repl
# Process in chunks
chunk_size = len(context) // 5
results = []
for i in range(5):
    chunk = context[i*chunk_size:(i+1)*chunk_size]
    answer = llm_query(f"Summarize: {chunk}")
    results.append(answer)
final = llm_query(f"Combine these summaries: {results}")
\`\`\`

FINAL_VAR(final)
`;

export function buildRLMSystemPrompt(basePrompt: string, contextMeta: {
  type: string;
  length: number;
  preview?: string;
}): string {
  const meta = `
Context loaded: ${contextMeta.type} with ${contextMeta.length} characters
${contextMeta.preview ? `Preview: ${contextMeta.preview.slice(0, 200)}...` : ''}
`;
  return basePrompt + RLM_SYSTEM_PROMPT_ADDITION + meta;
}
```

---

### 6. Slash Command: `/rlm`

**File:** `packages/coding-agent/src/modes/interactive/commands/rlm.ts`

```typescript
import { startRLMSession } from "../../../rlm/controller";
import { buildRLMSystemPrompt } from "../../../prompts/rlm-system";

export const rlmCommand: SlashCommand = {
  name: "rlm",
  description: "Start RLM mode with context",
  usage: "/rlm <@file|url|text> [question]",
  
  async execute(args: string[], ctx: CommandContext): Promise<string | void> {
    const { session } = ctx;
    
    // Parse args: first is context source, rest is prompt
    const [contextSource, ...promptParts] = args;
    const prompt = promptParts.join(" ");
    
    // Load context
    let context: unknown;
    if (contextSource.startsWith("@")) {
      const filePath = contextSource.slice(1);
      const content = await Bun.file(filePath).text();
      context = filePath.endsWith(".json") ? JSON.parse(content) : content;
    } else if (contextSource.startsWith("http")) {
      const response = await fetch(contextSource);
      context = await response.text();
    } else {
      context = contextSource;
    }
    
    // Start RLM session
    const rlmState = await startRLMSession(session, context, {
      maxIterations: 30,
      maxDepth: 1,
      subModel: "smol",
    });
    
    // Store in session
    session.rlmState = rlmState;
    
    // Augment system prompt
    const contextMeta = {
      type: typeof context === "string" ? "string" : Array.isArray(context) ? "array" : "object",
      length: JSON.stringify(context).length,
      preview: typeof context === "string" ? context.slice(0, 200) : undefined,
    };
    session.systemPrompt = buildRLMSystemPrompt(session.baseSystemPrompt, contextMeta);
    
    // Enable RLM mode in agent loop config
    session.agentConfig.rlm = {
      enabled: true,
      maxIterations: 30,
      maxDepth: 1,
      currentDepth: 0,
    };
    
    // Return prompt to send to agent
    return prompt || "Examine the context and help me understand it.";
  },
};
```

---

### 7. Python Tool Integration

**File:** `packages/coding-agent/src/tools/python.ts` (modifications)

```typescript
export interface PythonToolOptions {
  proxyExecutor?: PythonProxyExecutor;
  rlm?: {
    enabled: boolean;
    lmHandler: LMHandler;
    context: unknown;
    depth: number;
  };
}

// In execute(), before running code:
if (this.options?.rlm?.enabled) {
  // Inject RLM prelude
  const setupCode = `
from rlm_prelude import _set_lm_handler, _set_context, _set_depth
_set_lm_handler("127.0.0.1", ${this.options.rlm.lmHandler.port})
_set_context(${JSON.stringify(this.options.rlm.context)})
_set_depth(${this.options.rlm.depth})

# Make context available
context = ${JSON.stringify(this.options.rlm.context)}
`;
  await executePython(setupCode, { ...executorOptions, silent: true });
}
```

---

## File Structure

```
packages/
├── agent/src/
│   ├── agent-loop.ts      # Add RLM iteration + termination
│   └── types.ts           # Add RLM event types
│
├── coding-agent/src/
│   ├── rlm/
│   │   ├── index.ts       # Public exports
│   │   ├── controller.ts  # Session management
│   │   ├── lm-handler.ts  # Socket server for llm_query
│   │   └── parser.ts      # FINAL/FINAL_VAR parsing
│   ├── ipy/
│   │   └── prelude/
│   │       └── rlm.py     # Python prelude
│   ├── prompts/
│   │   └── rlm-system.ts  # System prompt additions
│   └── modes/interactive/commands/
│       └── rlm.ts         # /rlm command
```

---

## Usage

```bash
# From CLI
omp --rlm @large-book.txt "Summarize each chapter"
omp --rlm @data.json "Find all users who..."

# Interactive
omp
> /rlm @context.json What patterns do you see?
```

The agent will:
1. Load context into Python kernel as `context` variable
2. Augment system prompt with RLM instructions
3. Iterate with ```repl``` blocks, using `llm_query()` for sub-calls
4. Terminate when `FINAL()` or `FINAL_VAR()` is detected
5. Track iterations and enforce max limits

---

## Timeline

| Phase | Task | Duration |
|-------|------|----------|
| 1 | LM Handler + Python prelude | 2 days |
| 2 | Agent loop modifications | 1-2 days |
| 3 | Python tool integration | 1 day |
| 4 | System prompt + /rlm command | 1 day |
| 5 | Testing + iteration | 2-3 days |

**Total: ~7-9 days**

---

## References

- [RLM Paper (arXiv)](https://arxiv.org/abs/2512.24601)
- [RLM Blogpost](https://alexzhang13.github.io/blog/2025/rlm/)
- [RLM Repository](https://github.com/alexzhang13/rlm)
- [oh-my-pi Repository](https://github.com/can1357/oh-my-pi)
