import { expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { highlightedCode } from "@/components/CodeBlock";
import { parsedMarkdown } from "@/lib/markdown";

test("a text drawn again is parsed and highlighted once: the same blocks come back", () => {
  const text = "# Plano\n\n- um\n- dois\n\n```ts\nconst a = 1;\n```";
  expect(parsedMarkdown(text, true)).toBe(parsedMarkdown(text, true));
  // A message's line breaks and a document's are different readings.
  expect(parsedMarkdown(text, false)).not.toBe(parsedMarkdown(text, true));
  expect(highlightedCode("const a = 1;", "ts")).toBe(highlightedCode("const a = 1;", "ts"));
  expect(highlightedCode("const a = 1;", "ts")).not.toBe(highlightedCode("const a = 1;", "js"));
});
