/**
 * The picture viewer's numbers and the math behind its gestures (`ImageViewer`, `ZoomPicture`): pure, so it runs on
 * the UI thread (each function is a worklet) and in tests.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A double tap zooms in at least this far, or as far as it takes for the picture to fill the screen. */
export const DOUBLE_TAP_ZOOM = 2;
/** Zooming stops at twice the picture's own pixels (past its sharpness, never mush), and never past 10×. */
const PIXELS_ZOOM = 2;
const ZOOM_CAP = 10;
/** A slow pull closes the viewer past this far (in finger travel). */
export const DISMISS_DISTANCE = 100;
/** A release faster than this (pt/s) is decided by its direction: a flick away closes, one back toward the middle stays. */
export const DISMISS_VELOCITY = 200;
/** Pulled half a screen away, the picture is this small. */
export const DISMISS_MIN_SCALE = 0.75;
/** How closely the picture follows the finger at the start of a pull; then less and less, as a scroll's edge does. */
const FOLLOW = 0.8;

export function clamp(value: number, min: number, max: number): number {
  "worklet";
  return Math.min(Math.max(value, min), max);
}

/** How far a picture may zoom in: `pixelWidth` is its own width in pixels (unknown until it loads). */
export function maxZoom(pixelWidth: number | undefined, screenWidth: number): number {
  "worklet";
  if (!pixelWidth || screenWidth <= 0) return DOUBLE_TAP_ZOOM;
  return clamp((pixelWidth / screenWidth) * PIXELS_ZOOM, DOUBLE_TAP_ZOOM, ZOOM_CAP);
}

/** The picture whole on the screen at 1×: as wide as the screen or as tall, its own shape kept. */
export function fitted(aspect: number | null, screen: Size): Size {
  "worklet";
  if (!aspect || !Number.isFinite(aspect)) return screen;
  return aspect > screen.width / screen.height
    ? { width: screen.width, height: screen.width / aspect }
    : { width: screen.height * aspect, height: screen.height };
}

/** The zoom a double tap goes to: enough to fill the screen (no black bars), at least `DOUBLE_TAP_ZOOM`, at most `max`. */
export function doubleTapZoom(picture: Size, screen: Size, max: number): number {
  "worklet";
  const fill = Math.max(screen.width / picture.width, screen.height / picture.height);
  return Math.min(max, Math.max(DOUBLE_TAP_ZOOM, fill));
}

/**
 * Where a double tap at `at` (a point on the screen) zooms in, for iOS's own zoom: the part of the picture to show, in
 * the picture's points at 1× (it sits centered there). The tapped spot stays under the finger; on an axis where the
 * zoomed picture still doesn't fill the screen, it stays centered.
 */
export function zoomInRect(picture: Size, screen: Size, at: Point, max: number): Size & Point {
  "worklet";
  const zoom = doubleTapZoom(picture, screen, max);
  const width = screen.width / zoom;
  const height = screen.height / zoom;
  const spotX = at.x - (screen.width - picture.width) / 2;
  const spotY = at.y - (screen.height - picture.height) / 2;
  const x = picture.width <= width ? (picture.width - width) / 2 : clamp(spotX - at.x / zoom, 0, picture.width - width);
  const y =
    picture.height <= height ? (picture.height - height) / 2 : clamp(spotY - at.y / zoom, 0, picture.height - height);
  return { x, y, width, height };
}

/** How far a picture zoomed to `scale` may move each way and still cover the screen (0 on an axis where it fits). */
export function panRoom(picture: Size, scale: number, screen: Size): Point {
  "worklet";
  return {
    x: Math.max(0, (picture.width * scale - screen.width) / 2),
    y: Math.max(0, (picture.height * scale - screen.height) / 2),
  };
}

/**
 * Where a double tap at `focal` (from the screen's center) leaves a picture at 1× zoomed in, for Android's zoom of
 * ours: the tapped spot under the finger, the picture still over the whole screen.
 */
export function zoomInAt(picture: Size, screen: Size, focal: Point, max: number): { scale: number } & Point {
  "worklet";
  const scale = doubleTapZoom(picture, screen, max);
  const room = panRoom(picture, scale, screen);
  return {
    scale,
    x: clamp(focal.x * (1 - scale), -room.x, room.x),
    y: clamp(focal.y * (1 - scale), -room.y, room.y),
  };
}

/** Whether letting go of a pull closes the viewer: a fast release by its direction, a slow one by how far it went. */
export function pullCloses(translationY: number, velocityY: number): boolean {
  "worklet";
  return Math.abs(velocityY) > DISMISS_VELOCITY
    ? velocityY * translationY >= 0
    : Math.abs(translationY) > DISMISS_DISTANCE;
}

/** Which way a closing pull leaves: where it was flung, else where it was pulled. */
export function pullDirection(translationY: number, velocityY: number): 1 | -1 {
  "worklet";
  const toward = Math.abs(velocityY) > DISMISS_VELOCITY ? velocityY : translationY;
  return toward < 0 ? -1 : 1;
}

/** A pull's progress, 0 at rest to 1 half a screen away: the black fades and the picture shrinks with it. */
export function pullProgress(translationY: number, screenHeight: number): number {
  "worklet";
  return Math.min(Math.abs(translationY) / (screenHeight / 2), 1);
}

/**
 * Damps a drag: it starts at `FOLLOW` times the finger and tapers off, never reaching `limit` (a scroll view's edge
 * has the same feel).
 */
export function rubberBand(distance: number, limit: number): number {
  "worklet";
  const damped = (1 - 1 / ((Math.abs(distance) * FOLLOW) / limit + 1)) * limit;
  return Math.sign(distance) * damped;
}

/** Where the picture sits for a pull of the finger: following it, more loosely sideways, a little smaller as it goes. */
export function pulledPlacement(translationX: number, translationY: number, screen: Size): Point & { scale: number } {
  "worklet";
  return {
    x: rubberBand(translationX, screen.width / 2),
    y: rubberBand(translationY, screen.height),
    scale: 1 - (1 - DISMISS_MIN_SCALE) * pullProgress(translationY, screen.height),
  };
}
