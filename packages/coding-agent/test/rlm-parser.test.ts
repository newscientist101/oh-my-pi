import { describe, expect, it } from "bun:test";
import { parseRLMTermination } from "../src/rlm/parser";

describe("parseRLMTermination", () => {
	describe("happy path - basic termination", () => {
		it("detects FINAL() in plain text", () => {
			const result = parseRLMTermination("After analysis, FINAL(The answer is 42)");
			expect(result.terminated).toBe(true);
			expect(result.answer).toBe("The answer is 42");
			expect(result.varName).toBeUndefined();
		});

		it("detects FINAL_VAR() in plain text", () => {
			const result = parseRLMTermination("I stored the result. FINAL_VAR(summary)");
			expect(result.terminated).toBe(true);
			expect(result.varName).toBe("summary");
			expect(result.answer).toBeUndefined();
		});

		it("detects FINAL: in rlm fence", () => {
			const content = `
Here is my analysis:

\`\`\`rlm
FINAL: The book is about climate change
\`\`\`
`;
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(true);
			expect(result.answer).toBe("The book is about climate change");
		});

		it("detects FINAL_VAR: in rlm fence", () => {
			const content = `
\`\`\`rlm
FINAL_VAR: analysis_result
\`\`\`
`;
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(true);
			expect(result.varName).toBe("analysis_result");
		});

		it("returns not terminated when no markers present", () => {
			const result = parseRLMTermination("Just some regular text with no markers.");
			expect(result.terminated).toBe(false);
			expect(result.answer).toBeUndefined();
			expect(result.varName).toBeUndefined();
		});
	});

	describe("precedence rules", () => {
		it("prefers last rlm fence over plain text", () => {
			const content = `
FINAL(wrong answer)

\`\`\`rlm
FINAL: correct answer
\`\`\`
`;
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(true);
			expect(result.answer).toBe("correct answer");
		});

		it("uses last rlm fence when multiple present", () => {
			const content = `
\`\`\`rlm
FINAL: first answer
\`\`\`

Some middle text.

\`\`\`rlm
FINAL: second answer
\`\`\`
`;
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(true);
			expect(result.answer).toBe("second answer");
		});

		it("uses last marker within rlm fence", () => {
			const content = `
\`\`\`rlm
FINAL: first answer
FINAL_VAR: my_var
FINAL: last answer
\`\`\`
`;
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(true);
			expect(result.answer).toBe("last answer");
		});

		it("uses first match in plain text when no rlm fence", () => {
			const content = "FINAL(first answer) and then FINAL(second answer)";
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(true);
			expect(result.answer).toBe("first answer");
		});

		it("FINAL_VAR takes precedence over FINAL when first in plain text", () => {
			const content = "FINAL_VAR(result) and FINAL(ignored)";
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(true);
			expect(result.varName).toBe("result");
		});
	});

	describe("false positive rejection", () => {
		it("ignores FINAL inside python fence", () => {
			const content = `
\`\`\`python
FINAL(this should be ignored)
\`\`\`
`;
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(false);
		});

		it("ignores FINAL inside repl fence", () => {
			const content = `
Let me run some code:

\`\`\`repl
print("FINAL(not a termination)")
\`\`\`
`;
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(false);
		});

		it("ignores FINAL inside generic code fence", () => {
			const content = `
\`\`\`
FINAL(inside unnamed fence)
\`\`\`
`;
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(false);
		});

		it("ignores FINAL inside double-quoted string", () => {
			const content = `He said "FINAL(this is quoted)" and left.`;
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(false);
		});

		it("ignores FINAL inside single-quoted string", () => {
			const content = `The output was 'FINAL(quoted)' which means nothing.`;
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(false);
		});

		it("still detects FINAL after quoted string ends", () => {
			const content = `He said "hello" and then FINAL(the real answer).`;
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(true);
			expect(result.answer).toBe("the real answer");
		});

		it("detects termination outside fence when fence has no markers", () => {
			const content = `
\`\`\`python
print("hello")
\`\`\`

FINAL(actual answer)
`;
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(true);
			expect(result.answer).toBe("actual answer");
		});
	});

	describe("edge cases", () => {
		it("handles FINAL with whitespace in answer", () => {
			const result = parseRLMTermination("FINAL(  spaced answer  )");
			expect(result.terminated).toBe(true);
			expect(result.answer).toBe("spaced answer");
		});

		it("handles FINAL: with leading whitespace", () => {
			const content = `
\`\`\`rlm
   FINAL: indented answer
\`\`\`
`;
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(true);
			expect(result.answer).toBe("indented answer");
		});

		it("handles FINAL_VAR with underscores in name", () => {
			const result = parseRLMTermination("FINAL_VAR(my_long_variable_name)");
			expect(result.terminated).toBe(true);
			expect(result.varName).toBe("my_long_variable_name");
		});

		it("handles empty content", () => {
			const result = parseRLMTermination("");
			expect(result.terminated).toBe(false);
		});

		it("handles content with only whitespace", () => {
			const result = parseRLMTermination("   \n\t\n  ");
			expect(result.terminated).toBe(false);
		});

		it("handles rlm fence with no termination markers", () => {
			const content = `
\`\`\`rlm
just some text without markers
\`\`\`
`;
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(false);
		});

		it("handles mixed function and colon syntax in rlm fence", () => {
			const content = `
\`\`\`rlm
FINAL(function style)
FINAL: colon style wins
\`\`\`
`;
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(true);
			expect(result.answer).toBe("colon style wins");
		});

		it("handles FINAL with special characters in answer", () => {
			const result = parseRLMTermination("FINAL(Answer: $100 & 50% off!)");
			expect(result.terminated).toBe(true);
			expect(result.answer).toBe("Answer: $100 & 50% off!");
		});

		it("FINAL_VAR only accepts valid identifiers", () => {
			// Should not match - has spaces
			const result1 = parseRLMTermination("FINAL_VAR(not valid)");
			expect(result1.terminated).toBe(false);

			// Should not match - starts with number
			const result2 = parseRLMTermination("FINAL_VAR(123abc)");
			expect(result2.terminated).toBe(false);

			// Should match - valid identifier
			const result3 = parseRLMTermination("FINAL_VAR(valid_name123)");
			expect(result3.terminated).toBe(true);
			expect(result3.varName).toBe("valid_name123");
		});
	});

	describe("realistic examples", () => {
		it("handles typical RLM completion message", () => {
			const content = `
I've analyzed the document and found the main themes.

Let me summarize my findings:

\`\`\`repl
summary = "The document discusses three main topics: A, B, and C."
print(summary)
\`\`\`

Based on my analysis:

\`\`\`rlm
FINAL_VAR: summary
\`\`\`
`;
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(true);
			expect(result.varName).toBe("summary");
		});

		it("handles message with multiple code blocks and inline FINAL", () => {
			const content = `
\`\`\`python
# Some analysis code
result = analyze(data)
\`\`\`

\`\`\`json
{"status": "complete"}
\`\`\`

FINAL(The analysis shows positive trends)
`;
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(true);
			expect(result.answer).toBe("The analysis shows positive trends");
		});

		it("handles assistant explaining FINAL syntax without triggering it", () => {
			const content = `
To complete your task, you should use the FINAL() syntax like this:

\`\`\`python
# When done, output:
# FINAL(your answer here)
\`\`\`

This will signal completion.
`;
			const result = parseRLMTermination(content);
			expect(result.terminated).toBe(false);
		});
	});
});
