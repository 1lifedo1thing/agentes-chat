# 0220. Type, fonts and native layouts in live files

- Status: Proposed
- Date: 2026-11-24
- Amends: 0196 (rich text marks, slide and canvas styles, groups, fonts as file assets), 0200 (document marks and
  fonts)
- Code: `packages/live/src/fonts.ts` (`FONT_CATALOG`, `FontRef`), `packages/live/src/rich/*` (the new marks and
  paragraph spacing), `slides/*`, `canvas/*`, `document/*`; fonts built by `scripts/fonts/build.py` from
  `scripts/fonts/fonts.lock.json` into `FONTS_DIR`, served at `/api/fonts/*`; engine `packages/engine/src/live/layout/*`
  (`add_html`), `live/look.ts` (what an agent sees of its edit), `live/fonts.ts` (fonts from the Drive, embedding
  rights), the exports in `office/*` and `pdf.ts`

## Context

An agent asked to redraw a diagram on a canvas "in our brand" first drew it with the canvas's own shapes, then said
it couldn't match the brand: every text box was in the app's default font, one size and one weight per box, a card's
title as heavy as its body, no room for an icon inside a card, and "1." turned into a numbered list. So it wrote the
diagram as a web page on its computer, took a screenshot with a headless browser and placed the picture on the
canvas. It looked right, but nobody could change a word: the person double-clicked and only zoomed. Each request
after that ("20% wider", "a Soon badge on this card", "rename this column") regenerated the whole picture, 23 versions
in an hour, and every reply said the agent had only seen its picture, never the canvas.

Presentations are tighter still: two fonts (the theme's heading and body), weights 400, 600 and 700, no free text
box, shape, move or style through `edit_presentation`. Documents have the same marks as slides and no font of their
own.

The fix is not a better picture: it is letting the native files hold what the picture held, and letting the agent
build it the way it already knows how.

## Decision

### 1. Fonts the server ships

A catalog of 44 families ships with the server (`FONT_CATALOG`, plain data every app reads: id, family, category,
weights, italics, scripts):

- Sans: Source Sans 3, Onest, Inter, Geist, Manrope, DM Sans, Plus Jakarta Sans, Outfit, Figtree, Work Sans,
  Roboto, Open Sans, Montserrat, Poppins, Nunito, Rubik, Space Grotesk, Sora, Instrument Sans.
- Serif: Fraunces, Source Serif 4, Newsreader, EB Garamond, Literata, Crimson Pro, Instrument Serif, Roboto Slab.
- Display: Funnel Display, Bricolage Grotesque, Syne, Anton, Bebas Neue, Archivo Black, Unbounded, Oswald, Doto.
- Mono: JetBrains Mono, Martian Mono, Geist Mono, Fira Code, Space Mono, DM Mono, Roboto Mono.
- Handwriting: Caveat.

**Licenses.** Every family is under the SIL Open Font License 1.1 with no Reserved Font Name, except Roboto Slab
(Apache 2.0) and Source Sans 3 (OFL with the reserved name "Source"). Both licenses allow bundling with any software,
serving to browsers and embedding in documents; the fonts stay under their own license beside the AGPL code (and
beside the commercial license of ADR 0180). A family with a reserved name may only be shipped as its authors' own
files, so Source Sans 3 goes as Adobe's files, unchanged; the others are subset and converted freely. Families
with a reserved name were left out for that reason (among them Lato, Lora, Merriweather, Playfair Display, Raleway,
Libre Baskerville, Lexend, IBM Plex and DM Serif Display), as were licenses that aren't OFL or Apache. Each family's
license text ships beside its files and in `NOTICE`.

**Files.** `scripts/fonts/build.py` (Python with fontTools, run in the image build) downloads each family from a
pinned commit of the `google/fonts` repository (Source Sans 3 from Adobe's release), checks every file against the
SHA-256 in `fonts.lock.json`, and writes to `FONTS_DIR`: a variable WOFF2 per family and style for browsers, static
TrueType instances (400, 600, 700 and italic 400) for the server's measuring, pictures and PDFs and for the phone,
and `catalog.json`. About 40 MB. The server serves them at `/api/fonts/<id>/<file>` with a year's immutable cache;
they hold no workspace data, so they need no session. Without `FONTS_DIR` (tests, development) the catalog still
lists them and every app falls back to its system fonts. Chinese, Japanese and Korean text falls back to the system's
fonts, as today.

### 2. A workspace's own fonts come from the Drive

A person or an agent uploads a `.ttf`, `.otf`, `.woff` or `.woff2` to the Drive like any file. The upload is checked
before it is kept: at most 10 MB, a font the server can parse, its tables within bounds. A font in the Drive the
reader can see shows in the font picker beside the catalog, under its family name.

Using one in a live file copies it into the file's assets (ADR 0196 §8), under the reader's check that they can read
it, like a picture from the Drive: the file refers to it as `asset:<id>`, so whoever opens the file draws it right,
also when the font sits in one person's private Drive, and the font goes away with the file. The apps load it through
the file's asset route, with `nosniff` and the font's own type.

Exports respect the font's embedding rights (`OS/2.fsType`): a font marked restricted is never embedded in a PDF,
PowerPoint or Word file; that text falls back to the theme's font and the export says so. The upload says, in one
line, that the workspace needs the right to use that font on the web and in documents.

### 3. What the files hold

All in `@agenteschat/live`, read and written the same way by the web, the phone and the server. A font is a
`FontRef`: a catalog id (`inter`), a file's font (`asset:<id>`) or a theme role (`heading`, `body`).

- **Rich text** (slides, canvas, the document's paragraphs) gains marks: `font`, `size`, `weight` (100 to 900),
  `highlight` (a background color), `tracking` (letter spacing, in thousandths of the size) and `caps`. Paragraphs
  gain `lineHeight` and `spaceAfter`. An app that doesn't know a mark leaves it out when it reads, so older apps keep
  opening newer files.
- **Slides.** A deck may set its own fonts over the theme's (`fonts: { heading, body }`). An element's style gains
  `font` as any `FontRef`, any weight, `lineHeight`, `tracking`, `caps`, `padding`, `shadow`, `gradient` (two colors
  and an angle) and `dash`. Elements may share a `group`: they select, move and scale together, and a group may sit
  in a group.
- **Canvas.** Every shape that holds text (text, note, shape, frame title) takes the same text style: font, size,
  weight, color, alignment, vertical alignment, padding, line height, tracking, caps. Shapes gain `shadow`,
  `gradient` and `dash`, and may share a `group` like slide elements (frames still contain, groups only hold
  together).
- **Documents** gain the same marks and a document's own fonts for headings and body (`meta.fonts`).

The limits and the server's rules of shape (`validate*`, `LIVE_LIMITS`) cover the new fields like the old ones.

### 4. Agents build natively, in the language they write best

The edit tools take the new fields as ops (`style`, `group`, `ungroup`, `add_text`, `add_shape` on slides), and each
takes `add_html`: a fragment of HTML and CSS the server lays out and turns into native pieces, never a picture.

- Layout is CSS flexbox and block flow computed with Yoga (MIT) and the fonts' real metrics, so a line wraps where
  a browser would wrap it.
- Each box with a background, border, radius or shadow becomes a shape; each run of text a text box with its marks;
  each `<img>` (a Drive picture or the file's own) and inline `<svg>` (sanitized as ADR 0196 §8) a picture; icons
  are SVG pictures. What one box held becomes one group, named after its `id` or `data-name`, so "the Webhook card"
  can be found and changed later.
- On slides, `add_html` fills a box (the whole slide when none is given); on a canvas it goes at a point, in a frame;
  in a document it becomes blocks (headings, paragraphs with their marks, pictures, tables).
- CSS it doesn't support (grid, floats, absolute positioning past one box, transforms, filters, animations, web
  fonts by address) is ignored, and the result says what was left out. Fonts are `font-family` names from the
  catalog or the file's fonts.

### 5. Agents see what they built

Every edit's result carries a picture of what changed: the slide, or the region of the canvas around the shapes it
touched, drawn by the server from the native document with the same fonts (an SVG from the model, rasterized with
resvg as in ADR 0196 §8). The agent checks cut text and alignment before it says it is done, instead of saying it
only saw its own picture.

### 6. The prompt

Placing a picture of text, a screenshot of a page or a rendered slide in a live file is what the tools tell agents
not to do: a live file is built from its own pieces. When the workspace has its own fonts in the Drive, an agent
asked for the brand uses them.

### 7. Exports

PDF embeds each font and weight a file uses, as subsets (the static instances, the file's own fonts when their rights
allow). PowerPoint names each run's typeface and embeds the fonts it may; Word names each run's font. Shadows,
gradients and dashes go into PowerPoint as its own effects.

### 8. The apps

The web and the desktop app load a font when a file uses it (`@font-face` from `/api/fonts` or the file's asset
route); the phone loads the static files with `expo-font`. People change fonts and the new text styles from the
toolbars of slides, canvases and documents; those controls are designed with a prototype before they are built.

## Consequences

- An agent can match a brand with pieces people can edit one by one, and sees its result.
- The image grows by about 40 MB and its build needs network access and fontTools; development and tests need
  neither.
- A workspace's own font may be one it has no right to serve on the web; the upload says so, and exports respect
  what the font itself allows.
- `add_html` is a subset of CSS: layouts past it come out simpler than in a browser, and the tool says what it left
  out.
