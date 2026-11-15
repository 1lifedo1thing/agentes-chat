import {
  type CountedPointer,
  CURSOR_FLIP_AT,
  type CursorSpot,
  type PointerView,
  pointerShare,
} from "@agenteschat/client";
import { fitScale, type Size } from "./screen-view";

/** What the agent's arrow does for one gesture: where it goes, its rings, only its face while typing, the name turned. */
export function pointerStep(p: CountedPointer): { to: CursorSpot; presses: 0 | 1 | 2; quiet: boolean; flip: boolean } {
  const to = pointerShare(p);
  return {
    to,
    presses: p.act === "double" ? 2 : p.act === "click" ? 1 : 0,
    quiet: p.act === "type",
    flip: to.x > CURSOR_FLIP_AT,
  };
}

/** The browser card's view of the desktop: the whole screen scaled to fit, pinned at the box's top left. */
export const watchView = (box: Size, desk: Size): PointerView => ({ s: fitScale(box, desk), x: 0, y: 0, ...desk });
