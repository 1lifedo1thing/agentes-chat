import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { readCanvasGroups, readShapes } from "@agenteschat/live/canvas";
import { readDeck } from "@agenteschat/live/slides";
import type * as Y from "yjs";
import {
  createLiveFileToolSource,
  createLiveImages,
  insertMessage,
  type LiveDocs,
  type LiveImages,
  type ToolContext,
  type ToolOutput,
  type ToolSource,
} from "../src";
import { TextMeasurer } from "../src/fonts/library";
import { htmlToRich, layoutHtml, parseHtml } from "../src/live/layout/html";
import { type Fixture, setup } from "./fixtures";
import { liveDocsFor } from "./live-fixtures";

/**
 * Type and native layouts in live files (ADR 0220): `add_html` turns markup into a slide's or a canvas's own pieces
 * (shapes with their looks, texts with fonts and marks, pictures, groups), never a picture of a page; the style ops,
 * groups and the deck's fonts; and what a read says back.
 */

let f: Fixture;
let docs: LiveDocs;
let images: LiveImages;
let source: ToolSource | null = null;
const lazy: ToolSource = { name: "live-files", tools: async (ctx) => (source ? source.tools(ctx) : []) };

beforeEach(async () => {
  f = await setup({ toolSources: [lazy] });
  docs = liveDocsFor(f, "a");
  images = createLiveImages({ artifacts: f.artifactDeps, live: docs, gateway: f.gateway });
  source = createLiveFileToolSource({ artifacts: f.artifactDeps, live: docs, images });
});
afterEach(async () => {
  source = null;
  await docs.stop();
  await f.close();
});

async function runFor() {
  const msg = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "@dev do it",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

type Run = Awaited<ReturnType<typeof runFor>>;

const ctxOf = (run: Run): ToolContext => ({
  db: f.db,
  orgId: f.org.id,
  agentId: f.agent.id,
  runId: run.id,
  channelId: run.channelId,
  threadRootId: run.threadRootId,
  triggerMessageId: run.triggerMessageId,
});

async function call(run: Run, name: string, input: Record<string, unknown>): Promise<ToolOutput> {
  const r = await f.tools?.invoke(ctxOf(run), { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
  if (r?.type !== "result") throw new Error(`expected a result, got ${r?.type}`);
  return r.output;
}

async function ok(run: Run, name: string, input: Record<string, unknown>) {
  const out = await call(run, name, input);
  if (out.isError) throw new Error(`${name} failed: ${out.content}`);
  return out;
}

const artifactOf = (out: ToolOutput) => out.data?.artifact as { id: string };

async function headOf<T>(fileId: string, read: (doc: Y.Doc) => T): Promise<T> {
  const { doc } = await docs.read(f.org.id, fileId);
  try {
    return read(doc);
  } finally {
    doc.destroy();
  }
}

const CARDS = `
<style>
  .cards { display: flex; gap: 24px; padding: 40px; font-family: Onest, sans-serif; }
  .card { flex: 1; background: #ffffff; border: 3px solid #b9d4f7; border-radius: 20px; padding: 24px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08); }
  .label { font-family: "Martian Mono"; font-size: 16px; letter-spacing: 0.12em; text-transform: uppercase;
           color: #0063d1; margin-bottom: 8px; }
  .title { display: flex; align-items: center; gap: 12px; font-family: "Funnel Display"; font-size: 36px;
           font-weight: 300; color: #0e1a2b; }
  .badge { background: #0063d1; color: #fff; font-size: 16px; font-weight: 700; padding: 4px 10px;
           border-radius: 999px; }
  p { font-size: 24px; color: #4c5a6c; margin: 12px 0 0; }
</style>
<div class="cards" data-name="O que acorda o agente">
  <div class="card" data-name="Webhook">
    <div class="label">Gatilho</div>
    <div class="title"><svg width="32" height="32" viewBox="0 0 24 24"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" fill="#0063d1"/></svg> Webhook <span class="badge">Soon</span></div>
    <p>Um sistema de fora avisa o agente quando <b>algo</b> acontece.</p>
  </div>
  <div class="card" data-name="Rotina">
    <div class="title">Rotina</div>
    <p>Horário, e-mail chegando, PR aberto.</p>
  </div>
</div>`;

describe("add_html on a slide", () => {
  test("cards become shapes, texts with the brand's fonts, an icon and a badge, grouped by the markup", async () => {
    const run = await runFor();
    const deck = artifactOf(await ok(run, "create_presentation", { title: "Anatomia", slides: [{ layout: "blank" }] }));
    const out = await ok(run, "edit_presentation", {
      file: deck.id,
      ops: [{ op: "add_html", slide: 1, html: CARDS, box: { x: 0, y: 200, w: 1920, h: 600 } }],
    });
    expect(out.content).toContain("laid out HTML on slide 1");
    expect(out.content).not.toContain("picture of");

    await headOf(deck.id, (doc) => {
      const slide = readDeck(doc).slides[0];
      if (!slide) throw new Error("no slide");
      const shapes = slide.elements.filter((e) => e.type === "shape");
      const texts = slide.elements.filter((e) => e.type === "text");
      // Two cards and the badge (a shape holding its own label).
      expect(shapes).toHaveLength(3);
      const card = shapes.find((e) => e.style?.stroke === "#b9d4f7");
      expect(card?.style).toMatchObject({ fill: "#ffffff", strokeWidth: 3, radius: 20 });
      expect(card?.style?.shadow).toBeDefined();
      const badge = shapes.find((e) => e.style?.fill === "#0063d1");
      expect(JSON.stringify(badge?.text)).toContain("Soon");
      expect(badge?.style).toMatchObject({ weight: 700, color: "#ffffff", align: "center" });
      // Fonts from the catalog, by the names the CSS gave.
      const label = texts.find((e) => JSON.stringify(e.text).includes("Gatilho"));
      expect(label?.style).toMatchObject({ font: "martian-mono", size: 16, tracking: 120, caps: true, color: "#0063d1" });
      const title = texts.find((e) => JSON.stringify(e.text).includes("Webhook"));
      expect(title?.style).toMatchObject({ font: "funnel-display", weight: 300, size: 36 });
      // A word in bold is a mark on the run, the paragraph keeps its own look.
      const body = texts.find((e) => JSON.stringify(e.text).includes("Um sistema"));
      expect(body?.style).toMatchObject({ font: "onest", size: 24, color: "#4c5a6c" });
      expect(body?.text?.[0]?.runs.find((r) => r.text === "algo")?.weight).toBe(700);
      // The icon is a picture of the file (the sanitized SVG), placed where the markup put it.
      const icon = slide.elements.find((e) => e.type === "image");
      expect(icon?.asset).toBeTruthy();
      expect(icon?.w).toBe(32);
      // Everything sits in the box given.
      for (const e of slide.elements) expect(e.y).toBeGreaterThanOrEqual(200);
      // The cards and the row are groups, named as the markup named them.
      const names = (slide.groups ?? []).map((g) => g.name);
      expect(names).toEqual(expect.arrayContaining(["O que acorda o agente", "Webhook", "Rotina"]));
      const webhook = slide.groups?.find((g) => g.name === "Webhook");
      const row = slide.groups?.find((g) => g.name === "O que acorda o agente");
      expect(webhook?.parent).toBe(row?.id);
      expect(card?.group).toBeTruthy();
    });

    const read = await ok(run, "read_presentation", { file: deck.id });
    expect(read.content).toContain('"Webhook"');
    expect(read.content).toContain("text Martian Mono");
    expect(read.content).toContain("caps");
    expect(read.content).toContain("font-weight:700");
  });

  test("style, move and fonts: a group restyled and moved as one, the deck's own fonts, text from HTML", async () => {
    const run = await runFor();
    const deck = artifactOf(await ok(run, "create_presentation", { title: "Deck", slides: [{ layout: "title" }] }));
    await ok(run, "edit_presentation", {
      file: deck.id,
      ops: [
        { op: "add_html", slide: 1, html: CARDS, box: { x: 0, y: 300, w: 1920, h: 500 } },
        { op: "style", slide: 1, group: "Webhook", style: { color: "#ff0000" } },
        { op: "move", slide: 1, group: "Rotina", x: 1000, y: 900 },
        { op: "set_fonts", fonts: { heading: "Funnel Display", body: "Inter" } },
        {
          op: "set_text",
          slide: 1,
          role: "title",
          html: 'Anatomia <span style="font-weight:300;color:#0063d1">de um agente</span>',
        },
        { op: "add_shape", slide: 1, shape: "rect", text: "Soon", box: { x: 40, y: 40, w: 120, h: 40 }, style: { fill: "#0063d1", radius: 20, color: "#ffffff", weight: 700, padding: 6 } },
      ],
    });
    await headOf(deck.id, (doc) => {
      const view = readDeck(doc);
      expect(view.fonts).toEqual({ heading: "funnel-display", body: "inter" });
      const slide = view.slides[0];
      if (!slide) throw new Error("no slide");
      const webhook = slide.groups?.find((g) => g.name === "Webhook");
      const inWebhook = slide.elements.filter((e) => e.group === webhook?.id);
      expect(inWebhook.length).toBeGreaterThan(1);
      for (const e of inWebhook) expect(e.style?.color).toBe("#ff0000");
      const rotina = slide.groups?.find((g) => g.name === "Rotina");
      const moved = slide.elements.filter((e) => e.group === rotina?.id);
      expect(Math.min(...moved.map((e) => e.x))).toBe(1000);
      expect(Math.min(...moved.map((e) => e.y))).toBe(900);
      const title = slide.elements.find((e) => e.role === "title");
      const run = title?.text?.[0]?.runs.find((r) => r.text === "de um agente");
      expect(run).toMatchObject({ weight: 300, color: "#0063d1" });
      const pill = slide.elements.find((e) => e.type === "shape" && e.x === 40 && e.y === 40);
      expect(JSON.stringify(pill?.text)).toContain("Soon");
      expect(pill?.style).toMatchObject({ fill: "#0063d1", radius: 20, color: "#ffffff", weight: 700, padding: 6 });
    });
  });

  test("a font nobody ships is named, and the text falls back to the file's", async () => {
    const run = await runFor();
    const deck = artifactOf(await ok(run, "create_presentation", { title: "Deck", slides: [{ layout: "blank" }] }));
    const out = await ok(run, "edit_presentation", {
      file: deck.id,
      ops: [{ op: "add_html", slide: 1, html: '<p style="font-family: Helvetica Neue; font-size: 48px">Olá</p>' }],
    });
    expect(out.content).toContain("Helvetica Neue");
    const bad = await call(run, "edit_presentation", {
      file: deck.id,
      ops: [{ op: "set_fonts", fonts: { body: "Comic Sans" } }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('no font "Comic Sans"');
  });
});

describe("add_html on a canvas", () => {
  test("in a frame: shapes with their looks and labels, texts, and the groups the markup makes", async () => {
    const run = await runFor();
    const board = artifactOf(await ok(run, "create_canvas", { title: "Anatomia" }));
    await ok(run, "edit_canvas", {
      file: board.id,
      ops: [
        { op: "add_frame", ref: "f", name: "Marca", x: 0, y: 0, w: 1600, h: 800 },
        { op: "add_html", html: CARDS, x: 40, y: 60, w: 1400, frame: "f", name: "Diagrama" },
      ],
    });
    await headOf(board.id, (doc) => {
      const shapes = readShapes(doc);
      const frame = shapes.find((s) => s.type === "frame");
      const cards = shapes.filter((s) => s.type === "shape" && s.stroke === "#b9d4f7");
      expect(cards).toHaveLength(2);
      expect(cards[0]).toMatchObject({ fill: "#ffffff", strokeWidth: 3, radius: 20, parent: frame?.id });
      expect(cards[0]?.shadow).toBeDefined();
      const badge = shapes.find((s) => s.type === "shape" && s.fill === "#0063d1");
      expect(badge?.style).toMatchObject({ weight: 700, color: "#ffffff", align: "center" });
      const label = shapes.find((s) => s.type === "text" && JSON.stringify(s.text).includes("Gatilho"));
      expect(label?.style).toMatchObject({ font: "martian-mono", tracking: 120, caps: true });
      expect(label?.x).toBeGreaterThanOrEqual(40);
      const groups = readCanvasGroups(doc);
      expect(groups.map((g) => g.name)).toEqual(expect.arrayContaining(["Webhook", "Rotina", "O que acorda o agente"]));
    });

    await ok(run, "edit_canvas", {
      file: board.id,
      ops: [{ op: "move", group: "Webhook", x: 2000, y: 0 }],
    });
    await headOf(board.id, (doc) => {
      const webhook = readCanvasGroups(doc).find((g) => g.name === "Webhook");
      const inside = readShapes(doc).filter((s) => s.group === webhook?.id);
      expect(Math.min(...inside.map((s) => s.x))).toBe(2000);
    });
    const read = await ok(run, "read_canvas", { file: board.id });
    expect(read.content).toContain("Groups:");
    expect(read.content).toContain("text Martian Mono");
  });
});

describe("the layout itself", () => {
  const layout = (html: string, width = 800) => {
    const parsed = parseHtml(html);
    return layoutHtml(parsed, {
      width,
      base: { font: "source-sans-3", size: 20 },
      fontNamed: () => null,
      measurer: new TextMeasurer(),
      pictures: new Map(parsed.pictures.map((p) => [p.key, { w: 24, h: 24 }])),
      tables: true,
    });
  };

  test("a flex row shares its width; padding, gap and margins land where CSS puts them", () => {
    const r = layout(
      '<div style="display:flex;gap:20px;padding:10px"><div style="flex:1;background:#eee;height:50px"></div><div style="flex:1;background:#ddd;height:50px"></div></div>',
      420,
    );
    const boxes = r.pieces.filter((p) => p.kind === "box");
    expect(boxes.map((b) => b.box)).toEqual([
      { x: 10, y: 10, w: 190, h: 50 },
      { x: 220, y: 10, w: 190, h: 50 },
    ]);
  });

  test("a list is one text box of list paragraphs; plain paragraphs too, with their room between", () => {
    const list = layout("<ul><li>One</li><li>Two <b>bold</b></li></ul>");
    const text = list.pieces.filter((p) => p.kind === "text");
    expect(text).toHaveLength(1);
    expect(text[0]?.kind === "text" && text[0].text.map((p) => p.list)).toEqual(["bullet", "bullet"]);
    const paras = layout('<div><p style="margin:0 0 16px">A</p><p style="margin:0">B</p></div>');
    const one = paras.pieces.find((p) => p.kind === "text");
    expect(one?.kind === "text" && one.text[0]?.spaceAfter).toBe(16);
  });

  test("words wrap at the width they are given, and a long text grows its box", () => {
    const short = layout('<p style="margin:0;width:200px">one two three four five six seven eight nine ten</p>');
    const tall = short.pieces.find((p) => p.kind === "text");
    expect(tall?.box.h).toBeGreaterThan(40);
  });

  test("what isn't taken is said: scripts, grid, transforms, outside fonts", () => {
    const r = layout(
      '<script>alert(1)</script><div style="display:grid;transform:rotate(3deg);font-family:Papyrus">x</div>',
    );
    expect(r.notes.join(" ")).toContain("script");
    expect(r.notes.join(" ")).toContain("grid");
    expect(r.notes.join(" ")).toContain("transform");
    expect(r.notes.join(" ")).toContain("Papyrus");
  });

  test("htmlToRich keeps a paragraph per block and the inline looks as marks", () => {
    const rich = htmlToRich(parseHtml('<p>A <i>b</i></p><ul><li>c</li></ul>'), { size: 20 });
    expect(rich.map((p) => p.list ?? null)).toEqual([null, "bullet"]);
    expect(rich[0]?.runs.find((r) => r.text === "b")?.italic).toBe(true);
  });

  test("markup too big is refused before anything is parsed", () => {
    expect(() => parseHtml(`<p>${"x".repeat(210_000)}</p>`)).toThrow("split it");
  });
});
