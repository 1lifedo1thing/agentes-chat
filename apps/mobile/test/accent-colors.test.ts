import { describe, expect, test } from "bun:test";
import { accentPalette } from "@agenteschat/tokens/accent";
import { contrastRatio } from "../src/lib/nav";
import { appColors, sheetColors, withAccent } from "../src/ui/palette";

describe("a workspace's accent on the phone (ADR 0192)", () => {
  test("its agent colors take the place of the theme's, in both themes, and nothing else moves", () => {
    for (const scheme of ["light", "dark"] as const) {
      const base = appColors(scheme);
      const painted = withAccent(base, scheme, "#F97316");
      const want = accentPalette("#f97316")[scheme];
      expect([painted.agent, painted.agent2, painted.agentSoft, painted.onAgent]).toEqual([
        want.agent,
        want.agent2,
        want.agentSoft,
        want.onAgent,
      ]);
      expect({ ...painted, agent: "", agent2: "", agentSoft: "", onAgent: "" }).toEqual({
        ...base,
        agent: "",
        agent2: "",
        agentSoft: "",
        onAgent: "",
      });
      // Readable on the phone's own pages and sheets, the native light white included.
      expect(contrastRatio(painted.agent, painted.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(painted.agent, sheetColors(painted, scheme).bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(painted.agent, painted.onAgent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("no accent, or anything not a #rrggbb: the theme's own colors", () => {
    const base = appColors("light");
    expect(withAccent(base, "light", null)).toBe(base);
    expect(withAccent(base, "light", undefined)).toBe(base);
    expect(withAccent(base, "light", "orange")).toBe(base);
  });
});
