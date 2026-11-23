import { durations, motion } from "@agenteschat/tokens";
import { type CSSProperties, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { cx } from "./cx";
import { prefersReducedMotion } from "./sky/engine";

/*
 * Things that change size where they stand (a card turning into its answer, a notice opening on top of the page): the
 * box keeps its old height and glides to the new one (`--dur-morph`, `--move`), what it showed fades out where it was
 * with a 2px blur and the new content fades in 70ms later. A change landing mid-way glides on from where the box is.
 * Under reduced motion nothing moves or resizes: a state change only cross-fades in 120ms. Web Animations, so the
 * keyframes stay out of the stylesheet's motion rules (opacity and transform only there).
 */

const MOVE = `cubic-bezier(${motion.move.join(", ")})`;
const OUT = `cubic-bezier(${motion.out.join(", ")})`;
/** A change still seen under reduced motion: a cross-fade, nothing else. */
const CALM_MS = 120;
/** The new content waits this long after the old one starts fading. */
const FADE_IN_DELAY_MS = 70;

const glides = new WeakMap<HTMLElement, { anim: Animation; from: number; to: number; ms: number }>();

const animates = (el: Element) => typeof el.animate === "function";

/**
 * Glides `el`'s height from `from` to its height now. One gliding already starts from where it is; one gliding to the
 * same height just goes on. Returns the height it glides to (its own, with nothing holding it).
 */
export function glideHeight(el: HTMLElement, from: number, ms: number = durations.morph): number {
  const running = glides.get(el);
  let start = from;
  if (running) {
    start = el.getBoundingClientRect().height;
    running.anim.cancel();
  }
  const to = el.getBoundingClientRect().height;
  if (!animates(el) || prefersReducedMotion() || Math.abs(start - to) < 0.5) return to;
  const frames = (a: number, b: number) => [
    { height: `${a}px`, overflow: "clip" },
    { height: `${b}px`, overflow: "clip" },
  ];
  const same = running && Math.abs(running.to - to) < 0.5 ? running : null;
  const base = same ?? { from: start, ms };
  const anim = el.animate(frames(base.from, to), { duration: base.ms, easing: MOVE });
  if (same) anim.currentTime = same.anim.currentTime;
  glides.set(el, { anim, from: base.from, to, ms: base.ms });
  const end = () => {
    if (glides.get(el)?.anim === anim) glides.delete(el);
  };
  anim.addEventListener("finish", end);
  anim.addEventListener("cancel", end);
  return to;
}

/**
 * A state change: `old`, a copy of how `el` looked, fades out on top of it where it was (inert, 140ms, 2px blur) while
 * what `el` shows now fades in 70ms later.
 */
export function crossFade(el: HTMLElement, old: HTMLElement) {
  // Not drawn (hidden, or a test's DOM with no layout): nothing to see fade.
  const box = el.getBoundingClientRect();
  if (!animates(el) || box.width === 0) return;
  const calm = prefersReducedMotion();
  const blur = calm ? "none" : "blur(2px)";
  for (const child of Array.from(el.children))
    child.animate(
      [
        { opacity: 0, filter: blur },
        { opacity: 1, filter: "none" },
      ],
      {
        duration: calm ? CALM_MS : durations.base,
        delay: calm ? 0 : FADE_IN_DELAY_MS,
        easing: OUT,
        fill: "backwards",
      },
    );
  old.inert = true;
  old.setAttribute("aria-hidden", "true");
  old.dataset.morphGhost = "";
  for (const node of [old, ...Array.from(old.querySelectorAll("[id]"))]) node.removeAttribute("id");
  Object.assign(old.style, {
    position: "absolute",
    top: `${-el.clientTop}px`,
    left: `${-el.clientLeft}px`,
    width: `${box.width}px`,
    margin: "0",
    pointerEvents: "none",
    zIndex: "1",
  });
  const placed = getComputedStyle(el).position !== "static";
  if (!placed) el.style.position = "relative";
  el.append(old);
  const out = old.animate(
    [
      { opacity: 1, filter: "none" },
      { opacity: 0, filter: blur },
    ],
    {
      duration: calm ? CALM_MS : durations.fast,
      easing: OUT,
      fill: "forwards",
    },
  );
  // A taller copy never hangs over what follows while it fades with no glide to clip it.
  if (calm) el.animate([{ overflow: "clip" }, { overflow: "clip" }], { duration: CALM_MS });
  const done = () => {
    old.remove();
    if (!placed) el.style.position = "";
  };
  out.addEventListener("finish", done);
  out.addEventListener("cancel", done);
}

/** `.ac-arrive`'s place in a sequence: it starts `ms` after the click, one place at a time. */
export const arriveAfter = (ms: number) => ({ "--arrive-delay": `${ms}ms` }) as CSSProperties;

/** Each element's last draw, by `useMorph`'s key (or the hook's own instance). */
const draws = new Map<unknown, { height: number; copy: HTMLElement | null; owner: object }>();

/**
 * Glides the element's height from its last draw to this one, after every render. `key` carries that height to
 * another instance drawn in its place (a waiting request's card replaced by its answered one). `live`: this draw can
 * still become another state (a request waiting on someone): a copy of it is kept, and the first draw that isn't live
 * cross-fades from it.
 */
export function useMorph(
  ref: RefObject<HTMLElement | null>,
  { key, live = false }: { key?: string; live?: boolean } = {},
) {
  const owner = useRef({}).current;
  const id = key ?? owner;
  // No dependency list: the height is read after every draw.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const last = draws.get(id);
    if (last?.copy && !live) crossFade(el, last.copy);
    const height = last ? glideHeight(el, last.height) : el.getBoundingClientRect().height;
    let copy: HTMLElement | null = null;
    if (live) {
      copy = el.cloneNode(true) as HTMLElement;
      for (const ghost of Array.from(copy.querySelectorAll("[data-morph-ghost]"))) ghost.remove();
    }
    draws.set(id, { height, copy, owner });
  });
  // After the commit: an instance drawn in its place has taken the key over by then.
  useEffect(
    () => () => {
      if (draws.get(id)?.owner === owner) draws.delete(id);
    },
    [id, owner],
  );
}

/**
 * Room that glides open and shut as what is inside comes and goes (a notice on top of the page, the cards under a
 * decision), whichever part inside re-renders. `enter`: it opens from nothing when it mounts. `pace`: `panel` for the
 * page gliding under a notice. Empty, it takes no room and no gap (`.ac-morph`). Its inner box holds its parts'
 * margins, so what is measured is what it takes.
 */
export function MorphRoom({
  enter = false,
  pace = "morph",
  className,
  children,
}: {
  enter?: boolean;
  pace?: "morph" | "panel";
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: set up once; `enter` and `pace` only matter on mount
  useLayoutEffect(() => {
    const el = ref.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const ms = durations[pace];
    let last = inner.getBoundingClientRect().height;
    if (enter && last > 0) glideHeight(el, 0, ms);
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => {
      const now = inner.getBoundingClientRect().height;
      if (Math.abs(now - last) < 0.5) return;
      const from = last;
      last = now;
      glideHeight(el, from, ms);
    });
    watch.observe(inner);
    return () => watch.disconnect();
  }, []);
  return (
    <div ref={ref} className={cx("ac-morph", className)}>
      <div className="ac-morph__in">{children}</div>
    </div>
  );
}
