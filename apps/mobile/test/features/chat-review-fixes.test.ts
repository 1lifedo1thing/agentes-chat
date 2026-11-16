import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("a sheet that never shows can't leave the conversation's sheet host open", () => {
  test("every step presents as it mounts, so the system waits out a sheet still leaving", () => {
    const host = src("features/shared/SheetHost.tsx");
    expect(host).toContain("presentOnMount: true });");
    expect(host).not.toContain("presentOnMount: !first");
    // The keyboard leaves when a new sheet starts, after the listeners (the conversation reads it still up).
    const start = host.slice(host.indexOf("const start = "), host.indexOf("return {\n      open: start,"));
    const fresh = start.slice(start.indexOf("} else {"));
    expect(fresh).toContain("Keyboard.dismiss();");
    expect(start.indexOf("for (const l of listeners.current) l(true);")).toBeLessThan(start.indexOf("Keyboard.dismiss();"));
  });

  test("open turning false still dismisses a sheet presented on mount; a failed present ends as a dismissal", () => {
    const sheet = src("ui/Sheet.tsx");
    const props = sheet.slice(sheet.indexOf("export function useSheetProps("));
    expect(props).not.toContain("if (presentOnMount) return;");
    expect(props).not.toContain("void ref.current?.present();");
    expect(props).toMatch(
      /void ref\.current\?\.present\(\)\.catch\(\(\) => \{\s*shown\.current = false;\s*if \(openRef\.current\) closeRef\.current\(\);\s*goneRef\.current\?\.\(\);/,
    );
    // An auto-present that lands after the owner closed the sheet goes away again.
    expect(props).toMatch(/onDidPresent: \(\) => \{\s*if \(!openRef\.current\) void ref\.current\?\.dismiss\(\);/);
  });
});
