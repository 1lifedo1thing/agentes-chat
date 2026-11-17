/** Canvases (ADR 0191 §2, ADR 0192): shapes, frames, arrows, placement, edits, preview and text. */
export { canvasPreview, canvasText, replaceCanvas, validateCanvas } from "./content";
export {
  arrowPath,
  type Box,
  center,
  containsPoint,
  type Guide,
  hitTest,
  isBox,
  isBoxEnd,
  isPoint,
  type Point,
  rectsIntersect,
  rotatedBounds,
  snapLines,
  union,
} from "./geometry";
export {
  addShape,
  arrange,
  arrange as arrangeShapes,
  arrowEnds,
  defaultSize,
  deleteShapes,
  fillPending,
  initCanvas,
  moveShapes,
  resizeShape,
  setCanvasBackground,
  setParent,
  shapesById,
  shapeTextFragment,
  updateShape,
} from "./ops";
export { contentBounds, FRAME_LABEL, frameAt, placeBoxes } from "./place";
export {
  ancestorsOf,
  CANVAS_COORD_MAX,
  canvasBackground,
  descendantsOf,
  readShape,
  readShapeById,
  readShapes,
  resolveEnd,
  shapeBounds,
  shapeIndex,
  shapesMapOf,
  TEXT_TYPES,
  TYPE_PROPS,
} from "./store";
export * from "./types";
