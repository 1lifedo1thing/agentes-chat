/**
 * Whether anyone can see the app, for everything that moves on its own (skies, agents, the stylesheets' endless
 * loops): `hidden` (the page or the desktop window out of sight), `away` (another window has the focus and the
 * pointer isn't over this one) or `present`. The desktop window keeps running its page hidden and in the background
 * (no throttling there, apps/desktop/src-tauri/src/main_window.rs), where each frame of a loop kept a core and the GPU
 * busy with nobody looking; so what moves on its own stops here rather than waiting for the browser to stop it.
 * `<html data-sight>` carries it to the stylesheets ("away" or "hidden"; absent while present).
 */
export type Sight = "present" | "away" | "hidden";

let current: Sight = "present";
const listeners = new Set<(sight: Sight) => void>();

export const sight = (): Sight => current;

/** Calls `cb` on each change; returns the unsubscribe. */
export function onSight(cb: (sight: Sight) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function setSight(next: Sight) {
  if (next === current) return;
  current = next;
  const root = typeof document === "undefined" ? null : document.documentElement;
  if (root) {
    if (next === "present") delete root.dataset.sight;
    else root.dataset.sight = next;
  }
  for (const cb of [...listeners]) cb(next);
}

/**
 * Follows the page's visibility, the window's focus and the pointer, once at start. The pointer over the window counts
 * as someone looking (a window on a second screen, watched while typing in another). Returns the stop.
 */
export function watchSight(): () => void {
  let pointerIn = false;
  const update = () => setSight(document.hidden ? "hidden" : pointerIn || document.hasFocus() ? "present" : "away");
  const over = () => {
    if (pointerIn) return;
    pointerIn = true;
    update();
  };
  // Leaving the window: the last `pointerout` has nothing it goes to.
  const out = (e: PointerEvent) => {
    if (e.relatedTarget !== null) return;
    pointerIn = false;
    update();
  };
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  document.addEventListener("visibilitychange", update);
  document.addEventListener("pointerover", over, { passive: true });
  document.addEventListener("pointerout", out, { passive: true });
  update();
  return () => {
    window.removeEventListener("focus", update);
    window.removeEventListener("blur", update);
    document.removeEventListener("visibilitychange", update);
    document.removeEventListener("pointerover", over);
    document.removeEventListener("pointerout", out);
    setSight("present");
  };
}
