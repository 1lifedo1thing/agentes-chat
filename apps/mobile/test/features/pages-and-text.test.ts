import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileInfo, textChunks } from "../../src/features/files/logic";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

test("a page opens as a page: an HTML file or an agent's page, never its source", () => {
  const file = (name: string, contentType: string) =>
    fileInfo({ kind: "file", title: name, content: { kind: "file", name, contentType, size: 1 } } as never);
  expect(file("painel.html", "text/html").view).toBe("html");
  expect(file("painel.htm", "application/octet-stream").view).toBe("html");
  expect(file("notes.txt", "text/plain").view).toBe("text");
  expect(fileInfo({ kind: "html", title: "Painel", content: { kind: "html", html: "<p>x</p>" } } as never).view).toBe(
    "html",
  );
  const viewer = src("features/files/DocumentViewer.tsx");
  expect(viewer).toContain('info.view === "html" ? (\n          <HtmlPage detail={detail} />');
  // Apart from the app, as every page an agent writes: the blocks' isolated web view, the network cut off.
  expect(viewer).toContain("isolatedPage(html, PAGE_HEAD)");
  expect(viewer).toContain("{...ISOLATED_WEB_VIEW}");
  expect(src("features/blocks/LiveBlock.tsx")).toContain("{...ISOLATED_WEB_VIEW}");
});

test("a long text shows in pieces the phone can draw, nothing lost", () => {
  const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
  const pieces = textChunks(text);
  expect(pieces.length).toBeGreaterThan(5);
  expect(pieces.join("\n")).toBe(text);
  expect(textChunks("")).toEqual([""]);
  expect(textChunks("a\nb")).toEqual(["a\nb"]);
  const long = "x".repeat(20_000);
  expect(textChunks(`${long}\n${long}`)).toEqual([long, long]);
});
