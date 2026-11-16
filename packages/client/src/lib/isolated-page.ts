/**
 * What an agent writes runs apart from the app (ADR 0019): a frame sandboxed with no `allow-same-origin`, so an
 * opaque origin with none of our cookies, storage or DOM, and a page policy that cuts it off from the network. An
 * agent led astray by something it read must not be able to send what it knows out through a page that runs as soon
 * as it shows.
 *
 * The app's own policy adds what a page's can't: `frame-src` on our pages stops a frame navigating itself away, which
 * no policy inside it can (`apps/server/src/app.ts`).
 */

/** `allow-forms` too: without it a browser never fires `submit`, and a page's own form does nothing. */
export const PAGE_SANDBOX = "allow-scripts allow-forms";

export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
  "webrtc 'block'",
].join("; ");

/**
 * The page behind a fixed start, policy first. Nothing in the page can come before it: finding `<head>` to insert
 * after would land inside a comment like `<!-- <head> -->` and leave the page without a policy. The head stays open,
 * so the page's own `<html>` and `<head>` merge into these, and a doctype keeps it out of quirks mode.
 */
export function isolatedPage(html: string, head = ""): string {
  const page = html.replace(/^\s*<!doctype[^>]*>/i, "");
  // No DNS prefetch either: a lookup of a name the page made up is a way out the policy doesn't cover everywhere.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="x-dns-prefetch-control" content="off"><meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">${head}${page}`;
}

/**
 * In-memory stand-ins for `localStorage`, `sessionStorage` and `document.cookie`, for a page run where they throw or
 * are missing (an opaque origin, a web view with no storage): a page that touches them died before drawing anything.
 * A script's source, for a page's `<head>`; whatever the page does after it stays as it wrote it.
 */
export const STORAGE_STANDINS = `function mem(){var d={};return{getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d={}},key:function(i){var k=Object.keys(d)[i];return k===undefined?null:k},get length(){return Object.keys(d).length}}}
["localStorage","sessionStorage"].forEach(function(n){try{void window[n].length}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}});
try{void document.cookie}catch(e){try{Object.defineProperty(document,"cookie",{get:function(){return""},set:function(){},configurable:true})}catch(_){}}`;
