import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
const files = (dir: string, ext: RegExp): string[] =>
  readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => ext.test(f) && !f.includes("node_modules"))
    .map((f) => join(dir, f));
const STYLES = [
  ...files("packages/ui/src", /\.css$/),
  ...files("apps/web/src", /\.css$/),
  ...files("apps/desktop/src", /\.css$/),
];
/** Every rule as [selector, declarations], comments dropped. */
const rules = (path: string) =>
  [
    ...readFileSync(join(ROOT, path), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ].map((m) => [m[1]?.trim() ?? "", m[2] ?? ""] as const);

describe("hover", () => {
  test("no control transitions `all` (a layout or paint property would animate with it)", () => {
    const offenders = STYLES.flatMap((path) =>
      rules(path)
        .filter(([, body]) => /transition(-property)?\s*:[^;]*\ball\b/.test(body))
        .map(([sel]) => `${path}: ${sel}`),
    );
    expect(offenders).toEqual([]);
  });

  test("a button's hover never changes its opacity, so a dimmed or disabled one never lights up under the mouse", () => {
    const offenders = STYLES.flatMap((path) =>
      rules(path).flatMap(([sel, body]) =>
        /(^|[;\s])opacity\s*:/.test(body)
          ? sel
              .split(",")
              .filter((one) => one.includes(".ac-btn") && one.includes(":hover") && !one.includes(":not(:disabled)"))
              .map((one) => `${path}: ${one.trim()}`)
          : [],
      ),
    );
    expect(offenders).toEqual([]);
  });
});
