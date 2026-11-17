/**
 * Live files (ADR 0191): what the server, the web, the desktop app and the phone must agree on about spreadsheets,
 * presentations and canvases edited together: the documents' shape, formulas, number formats, rich text, the sync
 * protocol and presence. Pure TypeScript: no DOM, no React, no Node built-ins.
 *
 * Presentations and canvases both have an `arrange`: here it is the slides' (also `arrangeElements`), and the canvas's
 * is `arrangeShapes` (each is plain `arrange` in its own entry, "./slides" and "./canvas").
 */
export * from "./awareness";
export * from "./base64";
export * from "./canvas";
export * from "./colors";
export * from "./errors";
export * from "./fractional";
export * from "./ids";
export * from "./kinds";
export * from "./origins";
export * from "./protocol";
export * from "./restore";
export * from "./rich";
export * from "./slides";
export { arrange } from "./slides";
export * from "./spreadsheet";
