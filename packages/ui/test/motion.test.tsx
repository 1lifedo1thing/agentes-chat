import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { List, useMorph } from "../src";

afterEach(() => cleanup());

const css = () => Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe("motion", () => {
  test("enters and exits are short and live only inside a no-preference block", async () => {
    const all = await css();
    const section = all.slice(all.indexOf("Motion (2026-10)"));
    expect(section.length).toBeGreaterThan(100);
    const outside = section
      .replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, "")
      .replace(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g, "");
    expect(outside).not.toMatch(/\banimation(-name)?:/);
    // Under reduced motion a change is still seen: a fade in, and nothing else.
    for (const calm of section.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g))
      for (const a of (calm[1] ?? "").matchAll(/animation: ([\w-]+) (\d+)ms/g))
        expect([a[1], a[2]]).toEqual(["ac-fade-in", "120"]);
    // 120–200 ms, opacity and transform only (no layout properties in the keyframes).
    for (const ms of section.matchAll(/animation: [a-z-]+ (\d+)ms/g)) {
      expect(Number(ms[1])).toBeGreaterThanOrEqual(120);
      expect(Number(ms[1])).toBeLessThanOrEqual(200);
    }
    // Exits are faster than entrances; ⌘K, opened by keyboard many times a day, has none.
    expect(section).toContain('.ac-dialog[data-state="closed"]');
    expect(section).toContain('.ac-menu[data-state="closed"]');
    expect(section).toContain(".ac-toast[data-leaving]");
    expect(all).not.toMatch(/\.ac-palette(__scrim)?\[data-state="open"\] \{\s*animation/);
    for (const exit of section.matchAll(/\[data-state="closed"\][^{]*\{\s*animation: [\w-]+ ([^ ]+)/g))
      expect(["var(--dur-fast)", "var(--dur-base)"]).toContain(exit[1] ?? "");
    for (const block of all.matchAll(/@keyframes ([\w-]+) \{([\s\S]*?)\n\}/g)) {
      expect({ name: block[1], layout: /\b(width|height|top|left|margin|padding):/.test(block[2] ?? "") }).toEqual({
        name: block[1],
        layout: false,
      });
    }
  });

  test("a list's first rows show at once; only rows added later rise in", async () => {
    const { container } = render(
      <List>
        <div>Ada</div>
        <div>Atlas</div>
      </List>,
    );
    const list = container.querySelector(".ac-list") as HTMLElement;
    expect(list.classList.contains("ac-list--settled")).toBe(false);
    await wait(50);
    expect(list.classList.contains("ac-list--settled")).toBe(true);
    expect(await css()).not.toContain("ac-list--stagger");
  });

  test("a card changing size glides from its last height, and its old look fades out over the new", () => {
    const calls: { el: Element; frames: Keyframe[] }[] = [];
    const heights = new Map<string, number>([
      ["waiting", 200],
      ["answered", 90],
    ]);
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const { animate, getBoundingClientRect } = proto;
    proto.animate = function (this: Element, frames: Keyframe[]) {
      calls.push({ el: this, frames });
      const anim = new EventTarget() as Animation;
      Object.assign(anim, { cancel() {}, currentTime: 0 });
      return anim;
    };
    proto.getBoundingClientRect = function (this: HTMLElement) {
      return { width: 320, height: heights.get(this.dataset.state ?? "") ?? 0 } as DOMRect;
    };
    function Card({ state }: { state: string }) {
      const ref = useRef<HTMLDivElement>(null);
      useMorph(ref, { key: "card-1", live: state === "waiting" });
      return (
        <div ref={ref} data-state={state}>
          <p>{state}</p>
        </div>
      );
    }
    try {
      const view = render(<Card state="waiting" />);
      expect(calls).toHaveLength(0);
      view.rerender(<Card state="answered" />);
      const card = view.container.firstElementChild as HTMLElement;
      const glide = calls.find((c) => c.el === card);
      expect(glide?.frames.map((f) => f.height)).toEqual(["200px", "90px"]);
      const ghost = card.querySelector("[data-morph-ghost]") as HTMLElement;
      expect(ghost.inert).toBe(true);
      expect(ghost.textContent).toBe("waiting");
      expect(calls.find((c) => c.el === ghost)?.frames.at(-1)?.opacity).toBe(0);
      expect(calls.find((c) => c.el === card.firstElementChild)?.frames[0]?.opacity).toBe(0);
    } finally {
      Object.assign(proto, { animate, getBoundingClientRect });
    }
  });
});
