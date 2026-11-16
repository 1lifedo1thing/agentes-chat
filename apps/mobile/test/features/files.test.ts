import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactDetail } from "@agenteschat/client";
import { pictureRatio } from "@agenteschat/client/lib/files";
import { tileWidth } from "../../src/features/chat/attachment-size";
import {
  decodeFileList,
  driveWebUrl,
  encodeFileList,
  extensionOf,
  extLabel,
  fileInfo,
  pageStep,
  resolveDownloadUrl,
  safeFileName,
  shareSource,
  singleImageBox,
  singleImageHeight,
  utf8Bytes,
  videoClock,
  videoHeight,
  withExtension,
} from "../../src/features/files/logic";
import {
  DISMISS_DISTANCE,
  DISMISS_MIN_SCALE,
  DISMISS_VELOCITY,
  doubleTapZoom,
  fitted,
  maxZoom,
  panRoom,
  pullCloses,
  pullDirection,
  pulledPlacement,
  pullProgress,
  rubberBand,
  zoomInAt,
  zoomInRect,
} from "../../src/features/files/zoom";
import { ICONS } from "../../src/ui/icons.data";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");

type Input = Pick<ArtifactDetail, "kind" | "title" | "content">;
const upload = (name: string, contentType: string, size = 1000, text?: string): Input => ({
  kind: "file",
  title: name,
  content: { kind: "file", name, contentType, size, sha256: "x", ...(text !== undefined ? { text } : {}) },
});

describe("videos", () => {
  test("MP4 and MOV play in the app, as a video; other video types stay a card", () => {
    expect(fileInfo(upload("abertura.mp4", "video/mp4"))).toMatchObject({ view: "video", type: "video", ext: "MP4" });
    expect(fileInfo(upload("story.MOV", "video/quicktime")).view).toBe("video");
    expect(fileInfo(upload("antigo.avi", "video/x-msvideo")).view).toBe("other");
  });

  test("one box in a message whatever its shape, so nothing moves once it loads; its time as a clock", () => {
    expect(videoHeight(320)).toBe(180);
    expect(videoClock(7.9)).toBe("0:07");
    expect(videoClock(725)).toBe("12:05");
    expect(videoClock(3729)).toBe("1:02:09");
    expect(videoClock(Number.NaN)).toBe("0:00");
  });
});

describe("file kind, tile and size", () => {
  test("raster pictures are images; SVG is not", () => {
    expect(fileInfo(upload("home.png", "image/png")).view).toBe("image");
    expect(fileInfo(upload("foto.JPG", "image/jpeg; charset=binary")).view).toBe("image");
    expect(fileInfo(upload("logo.svg", "image/svg+xml")).view).toBe("other");
    expect(fileInfo(upload("logo.svg", "image/svg+xml")).type).toBe("image");
  });

  test("PDF, Markdown and text open in the document screen", () => {
    const pdf = fileInfo(upload("Relatório.pdf", "application/pdf", 2048));
    expect(pdf).toMatchObject({ view: "pdf", type: "pdf", ext: "PDF", size: 2048, name: "Relatório.pdf" });
    expect(fileInfo(upload("notes.md", "application/octet-stream")).view).toBe("markdown");
    expect(fileInfo(upload("notes.md", "text/markdown")).type).toBe("document");
    const csv = fileInfo(upload("vendas.csv", "text/csv"));
    expect(csv).toMatchObject({ view: "text", type: "table", ext: "CSV" });
    expect(fileInfo(upload("log.txt", "text/plain")).type).toBe("text");
  });

  test("other files are cards with their type", () => {
    expect(fileInfo(upload("backup.zip", "application/zip"))).toMatchObject({
      view: "other",
      type: "archive",
      ext: "ZIP",
    });
    expect(fileInfo(upload("sem-extensao", "application/octet-stream"))).toMatchObject({ type: "file", ext: "" });
  });

  test("a document artifact: title with .md, size from its text", () => {
    const doc = fileInfo({
      kind: "document",
      title: "Resumo da home",
      content: { kind: "document", markdown: "Olá é" },
    });
    expect(doc).toMatchObject({ name: "Resumo da home.md", view: "markdown", type: "document", ext: "MD", size: 7 });
    const table = fileInfo({ kind: "table", title: "Vendas", content: { kind: "table", columns: [], rows: [] } });
    expect(table).toMatchObject({ name: "Vendas.csv", view: "other", type: "table", size: null });
  });

  test("helpers", () => {
    expect(extensionOf("a.tar.GZ")).toBe("gz");
    expect(extensionOf("README")).toBe("");
    expect(extLabel("jpeg")).toBe("JPEG");
    expect(extLabel("markdown")).toBe("MARK");
    expect(withExtension("x.md", "md")).toBe("x.md");
    expect(withExtension("x", "md")).toBe("x.md");
    expect(utf8Bytes("a")).toBe(1);
    expect(utf8Bytes("ç")).toBe(2);
    expect(utf8Bytes("€")).toBe(3);
    expect(utf8Bytes("😀")).toBe(4);
  });
});

describe("pictures in a message", () => {
  test("a lone picture of unknown size has one box whatever its shape, so nothing moves once it loads", () => {
    expect(singleImageHeight(300)).toBe(225);
    expect(singleImageBox(300, undefined)).toEqual({ width: 300, height: 225 });
  });

  test("one whose size the server read has its own shape from the first frame, no taller than 400", () => {
    expect(singleImageBox(300, pictureRatio({ width: 1024, height: 1024 }))).toEqual({ width: 300, height: 300 });
    expect(singleImageBox(300, pictureRatio({ width: 1536, height: 1024 }))).toEqual({ width: 300, height: 200 });
    // A portrait one narrows to stay 400 high.
    expect(singleImageBox(300, pictureRatio({ width: 1024, height: 1536 }))).toEqual({ width: 267, height: 400 });
    expect(pictureRatio({ width: 1024 })).toBeUndefined();
  });
});

describe("shared copies", () => {
  test("safe names: no folders, no refused characters, never empty, extension kept", () => {
    expect(safeFileName("../../etc/passwd")).toBe("-..-etc-passwd");
    expect(safeFileName('a:b*c?"d<e>f|g.png')).toBe("a-b-c--d-e-f-g.png");
    expect(safeFileName("  .hidden. ")).toBe("hidden");
    expect(safeFileName("line\nbreak\u0000.txt")).toBe("linebreak.txt");
    expect(safeFileName("   ")).toBe("file");
    const long = safeFileName(`${"a".repeat(300)}.pdf`);
    expect(long.length).toBe(120);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  test("where the copy comes from", () => {
    expect(shareSource({ kind: "document", title: "Plano", content: { kind: "document", markdown: "# Oi" } })).toEqual({
      from: "text",
      text: "# Oi",
      name: "Plano.md",
      mime: "text/markdown",
    });
    expect(
      shareSource({ kind: "table", title: "Vendas", content: { kind: "table", columns: [], rows: [] } }),
    ).toMatchObject({ from: "export", format: "csv", name: "Vendas.csv" });
    expect(shareSource(upload("home/print.png", "image/png"))).toEqual({
      from: "download",
      name: "home-print.png",
      mime: "image/png",
    });
  });

  test("download links: signed links as they are, ours with the session", () => {
    expect(resolveDownloadUrl("https://app.agentes.chat", "https://bucket.s3/x?sig=1")).toEqual({
      uri: "https://bucket.s3/x?sig=1",
      needsSession: false,
    });
    expect(resolveDownloadUrl("https://app.agentes.chat", "https://app.agentes.chat.attacker.test/file")).toEqual({
      uri: "https://app.agentes.chat.attacker.test/file",
      needsSession: false,
    });
    expect(resolveDownloadUrl("https://app.agentes.chat", "https://app.agentes.chat/file")).toEqual({
      uri: "https://app.agentes.chat/file",
      needsSession: true,
    });
    expect(
      resolveDownloadUrl("https://app.agentes.chat/", "/api/app/organizations/o/artifacts/a/file?version=2"),
    ).toEqual({
      uri: "https://app.agentes.chat/api/app/organizations/o/artifacts/a/file?version=2",
      needsSession: true,
    });
  });

  test("the web Drive at the file", () => {
    expect(driveWebUrl("https://app.agentes.chat/", "org1", "a1")).toBe(
      "https://app.agentes.chat/org/org1/drive?artifact=a1",
    );
    expect(driveWebUrl("https://app.agentes.chat", "org1", "a1", 3)).toBe(
      "https://app.agentes.chat/org/org1/drive?artifact=a1&v=3",
    );
  });
});

describe("viewer", () => {
  test("the route's file list round-trips and drops junk", () => {
    const list = [{ id: "a-1", version: 2 }, { id: "b_2" }];
    expect(decodeFileList(encodeFileList(list))).toEqual(list);
    expect(decodeFileList("a@0,../x,b@x,c@3")).toEqual([{ id: "a" }, { id: "b" }, { id: "c", version: 3 }]);
    expect(decodeFileList(undefined)).toEqual([]);
  });

  test("‹ › go one picture at a time and never round past the first or the last", () => {
    expect(pageStep(1, 1, 4)).toBe(2);
    expect(pageStep(1, -1, 4)).toBe(0);
    expect(pageStep(0, -1, 4)).toBeNull();
    expect(pageStep(3, 1, 4)).toBeNull();
    expect(pageStep(0, 1, 1)).toBeNull();
  });

  test("several pictures: 2 de 4 in the head, ‹ › on the sides (gone while zoomed) slide the pager as a swipe", () => {
    const viewer = src("features/files/ImageViewer.tsx");
    expect(viewer).toContain(
      'files.length > 1 ? t("mobile.files.place", { index: index + 1, count: files.length }) : ""',
    );
    expect(viewer).toContain("[place, author, savedWhen(savedAt(detail))].filter(Boolean)");
    expect(viewer).toContain(
      '<Round icon="left" label={t("mobile.files.previous")} plate={SCRIM} onPress={() => turn(prev)} />',
    );
    expect(viewer).toContain(
      '<Round icon="right" label={t("mobile.files.next")} plate={SCRIM} onPress={() => turn(next)} />',
    );
    expect(viewer).toContain("visible={chrome && !zoomed}");
    expect(viewer).toContain("else pager.current?.setPage(to);");
    // The count took the dots' place: one place says where you are.
    expect(viewer).not.toContain("styles.dots");
  });

  test("‹ and › are one chevron mirrored, on a dark plate that reads on a light picture", () => {
    // `back` (7×14) is a size larger than `right` (6×12) and half a unit off center: `left` is `right` mirrored.
    expect(ICONS.left).toEqual([{ t: "path", d: "m15 6-6 6 6 6" }]);
    expect(ICONS.right).toEqual([{ t: "path", d: "m9 6 6 6-6 6" }]);
    // The close and ⋯ plates are light (they sit on the black above the picture); ‹ › sit on the picture.
    expect(src("features/files/ImageViewer.tsx")).toContain('const SCRIM = "rgba(0,0,0,0.45)";');
  });

  test("photos, videos and files go up as parts Expo's fetch sends, never React Native's { uri } part", () => {
    // Expo's fetch refuses `{ uri, name, type }` ("Unsupported FormDataPart implementation"): no upload ever left.
    const chat = src("features/chat/ChatScreen.tsx");
    expect(chat).toContain("api.artifacts.upload(orgId, uploadPart(file), {");
    expect(chat).not.toContain("as unknown as Parameters<typeof api.artifacts.upload>[1]");
    expect(src("features/drive/useDriveUpload.ts")).toContain("api.artifacts.upload(orgId, uploadPart(file))");
    expect(src("features/files/upload-part.ts")).toContain("bytes: () => source.bytes()");
  });

  test("what waits in the field: one height, a photo or video in its own shape, a file as a wider card", () => {
    expect(tileWidth({ type: "image/jpeg", width: 4000, height: 3000 })).toBe(96);
    expect(tileWidth({ type: "image/jpeg", width: 1000, height: 4000 })).toBe(54);
    expect(tileWidth({ type: "video/mp4", width: 1920, height: 1080 })).toBe(128);
    expect(tileWidth({ type: "image/png" })).toBe(72);
    expect(tileWidth({ type: "application/pdf" })).toBe(176);
    const strip = src("features/chat/AttachmentStrip.tsx");
    // A video at its first frame with its length; nothing drawn red, no dashed tile.
    expect(strip).toContain("<VideoFirstFrame uri={f.uri} />");
    expect(strip).toContain("videoClock(f.duration)");
    expect(strip).not.toContain("dashed");
    expect(strip).not.toMatch(/rgba\(2\d\d, ?\d{1,2}, ?\d{1,2}/);
    // Inside the field, on a row of its own across it.
    expect(src("ui/Composer.tsx")).toContain(
      "{attachments ? <View style={styles.attachRow}>{attachments}</View> : null}",
    );
  });

  test("sending with files is optimistic: the message shows at once with its files, the field is free", () => {
    const chat = src("features/chat/ChatScreen.tsx");
    // In the conversation at once, under the clientId the real message comes back with.
    expect(chat).toContain(
      "qc.setQueryData<Message[]>(keys.messages(orgId, channelId), (list) => upsertMessage(list, local));",
    );
    expect(chat).toContain("[LOCAL_FILES]: files.map(");
    // Then up, then sent with the same clientId; a failure turns it "Não foi enviada" and retry starts over.
    expect(chat).toContain("clientId: local.clientId ?? newClientId(),");
    expect(chat).toContain('? { ...m, local: "failed" as const, sendFailure: sendFailureOf(failed.reason) }');
    expect(chat).toContain("void deliverFilesRef.current(m);");
    // No more waiting in the field while they upload.
    expect(chat).not.toContain("sendingFiles.current");
    const row = src("features/chat/MessageRow.tsx");
    expect(row).toContain('<LocalFiles files={localFiles} align="end" sending={m.local === "pending"} />');
  });

  test("a video opens where the pictures do, from a message, the Drive or a file's link, and plays there", () => {
    expect(src("features/files/ImageViewer.tsx")).toContain("<ViewerVideo");
    const message = src("features/files/MessageFiles.tsx");
    expect(message).not.toContain('pathname: "/file/[id]"');
    expect(src("features/drive/DriveCard.tsx")).toContain("VIDEO_EXT.has(extensionOf(a.title))");
    expect(src("features/files/DocumentViewer.tsx")).toContain(
      'const media = info?.view === "image" || info?.view === "video";',
    );
    expect(src("features/files/DocumentViewer.tsx")).not.toContain("<VideoPlayer");
  });

  test("the pictures page on the system's pager and zoom with the system's own zoom on iOS", () => {
    const viewer = src("features/files/ImageViewer.tsx");
    expect(viewer).toContain('import PagerView from "react-native-pager-view";');
    expect(viewer).toContain("scrollEnabled={!zoomed}");
    expect(viewer).not.toContain("zoom-toolkit");
    const zoom = src("features/files/ZoomPicture.tsx");
    // iOS: the scroll view's own pinch, bounce and momentum; a double tap zooms through it.
    expect(zoom).toContain("maximumZoomScale={max}");
    expect(zoom).toContain("pinchGestureEnabled");
    expect(zoom).toContain("scroll.current?.scrollResponderZoomTo({ ...rect, animated: true });");
    // Android: a pinch of ours, inside the screen's edges, with a fling that glides.
    expect(zoom).toContain('Platform.OS === "ios" ? <SystemZoom {...zoom} /> : <OwnZoom {...zoom} />');
    expect(zoom).toContain("withDecay({ velocity: e.velocityX, clamp: [-room.x, room.x] })");
    // The pull to close comes first, before the picture's own gestures.
    expect(zoom).toContain("useExclusiveGestures(pull, doubleTap, tap)");
    expect(zoom).toContain("useExclusiveGestures(pull, pinchAndPan, doubleTap, tap)");
  });

  test("the pull to close tracks the finger, can be caught again, and closes once", () => {
    const viewer = src("features/files/ImageViewer.tsx");
    expect(viewer).toContain("pullY.value = from.value.y + e.translationY;");
    expect(viewer).toContain("from.value = { x: pullX.value, y: pullY.value };");
    // A closing picture takes no other pull, and closing is one step back, never two (the conversation went too).
    expect(viewer).toContain("if (leaving.value) return;");
    expect(viewer).toContain("if (closed.current) return;");
    // Only the picture in sight, at 1×, while the pages are still.
    expect(viewer).toContain("enabled: active && !zoomed && !paging,");
  });

  test("a pull closes when flung away or let go far enough; flung back toward the middle it stays", () => {
    // Slow: by distance.
    expect(pullCloses(DISMISS_DISTANCE + 1, 0)).toBe(true);
    expect(pullCloses(-(DISMISS_DISTANCE + 1), 0)).toBe(true);
    expect(pullCloses(DISMISS_DISTANCE - 1, 0)).toBe(false);
    // Fast: by direction, however short.
    expect(pullCloses(20, DISMISS_VELOCITY + 100)).toBe(true);
    expect(pullCloses(-20, -(DISMISS_VELOCITY + 100))).toBe(true);
    expect(pullCloses(300, -(DISMISS_VELOCITY + 100))).toBe(false);
    expect(pullDirection(300, -(DISMISS_VELOCITY + 100))).toBe(-1);
    expect(pullDirection(-150, 0)).toBe(-1);
    expect(pullDirection(150, 0)).toBe(1);
  });

  test("a pulled picture follows the finger loosely, shrinks a little, and the black fades with it", () => {
    const screen = { width: 400, height: 800 };
    expect(pulledPlacement(0, 0, screen)).toEqual({ x: 0, y: 0, scale: 1 });
    const near = pulledPlacement(0, 40, screen);
    // At first close to the finger (0.8 of it), never past it.
    expect(near.y).toBeGreaterThan(30);
    expect(near.y).toBeLessThan(40);
    // Half a screen away: three quarters of its size, the black gone.
    expect(pulledPlacement(0, 400, screen).scale).toBeCloseTo(DISMISS_MIN_SCALE);
    expect(pullProgress(400, 800)).toBe(1);
    expect(pullProgress(-200, 800)).toBe(0.5);
    // Sideways it follows more loosely than down.
    expect(Math.abs(pulledPlacement(100, 0, screen).x)).toBeLessThan(pulledPlacement(0, 100, screen).y);
    expect(rubberBand(-100, 800)).toBeCloseTo(-rubberBand(100, 800));
  });

  test("a picture fits whole, zooms up to twice its own pixels, and a double tap zooms in at the spot", () => {
    const screen = { width: 400, height: 800 };
    // A wide picture is as wide as the screen; a tall one as tall.
    expect(fitted(2, screen)).toEqual({ width: 400, height: 200 });
    expect(fitted(0.25, screen)).toEqual({ width: 200, height: 800 });
    expect(fitted(null, screen)).toEqual(screen);
    expect(maxZoom(undefined, 400)).toBe(2);
    expect(maxZoom(1200, 400)).toBe(6);
    expect(maxZoom(100_000, 400)).toBe(10);
    // A wide picture zooms in enough to fill the screen's height.
    const wide = { width: 400, height: 200 };
    expect(doubleTapZoom(wide, screen, 10)).toBe(4);
    expect(doubleTapZoom(wide, screen, 3)).toBe(3);
    // iOS: the part to show keeps the tapped spot under the finger, inside the picture.
    const rect = zoomInRect(wide, screen, { x: 100, y: 400 }, 10);
    expect(rect.width).toBe(100);
    expect(rect.height).toBe(200);
    expect(rect.x).toBe(75);
    expect(rect.y).toBe(0);
    // Android: the same spot stays under the finger, the picture over the whole screen.
    const at = zoomInAt(wide, screen, { x: -100, y: 0 }, 10);
    expect(at.scale).toBe(4);
    expect(at.x).toBe(300);
    expect(at.y).toBeCloseTo(0);
    expect(panRoom(wide, 4, screen)).toEqual({ x: 600, y: 0 });
    expect(panRoom(wide, 1, screen)).toEqual({ x: 0, y: 0 });
  });

  test("a video plays in the system's player with its controls, never controls of ours over it", () => {
    const player = src("features/files/VideoPlayer.tsx");
    // In full screen the platform's controls are the only way back out: they are always on where it plays.
    expect(player).toContain("nativeControls\n");
    expect(player).not.toContain("enterFullscreen");
    expect(player).not.toContain("<Glass");
  });
});

describe("a document's head", () => {
  test("the bar keeps ×, Copiar texto and ⋯; the name and its line take a row of their own under it, never cut", () => {
    const viewer = readFileSync(join(import.meta.dir, "../../src/features/files/DocumentViewer.tsx"), "utf8");
    const bar = viewer.slice(
      viewer.indexOf("<View style={[styles.top,"),
      viewer.indexOf("<View style={styles.heading}>"),
    );
    expect(bar).not.toContain("info?.name");
    expect(bar).not.toContain("styles.balance");
    const heading = viewer.slice(
      viewer.indexOf("<View style={styles.heading}>"),
      viewer.indexOf("<View style={styles.body}>"),
    );
    expect(heading).toContain("numberOfLines={3}");
    expect(heading).toContain("{info?.name");
    expect(heading).not.toContain("numberOfLines={1}");
  });

  test("a picture's head too: × and ⋯ on the first row, the name and its line on the row under them", () => {
    const viewer = readFileSync(join(import.meta.dir, "../../src/features/files/ImageViewer.tsx"), "utf8");
    const top = viewer.slice(viewer.indexOf("style={[styles.top,"), viewer.indexOf("</Chrome>"));
    expect(top.indexOf('icon="more"')).toBeLessThan(top.indexOf("{info?.name"));
    expect(top).toContain("numberOfLines={3}");
    expect(top).not.toContain("numberOfLines={1}");
    expect(viewer).toContain('title: { flexBasis: "100%", gap: 2 }');
  });

  test("among files a picture is only the picture, two to a row; a file takes the row, its name whole", () => {
    const tile = src("features/files/AttachmentTile.tsx");
    // The foot (icon, name, kind and size) only under a file; a picture's name and size are what VoiceOver says.
    expect(tile).toMatch(/\{picture \? null : \(\s*<View style=\{styles\.foot\}>/);
    expect(tile).toMatch(/accessibilityLabel=\{`\$\{name\}, \$\{meta\}`\}/);
    // Known to be a picture by its name before it loads, so it never sheds a foot once it does.
    expect(tile).toContain('const picture = info ? info.view === "image" : seen;');
    const foot = tile.slice(tile.indexOf("<View style={styles.foot}>"), tile.indexOf("function fileIconOf("));
    expect(foot).not.toContain("numberOfLines");
    expect(foot).toContain('<LineIcon name={icon} size={14} color={c.faint} variant="footnote" />');
    const files = src("features/files/MessageFiles.tsx");
    expect(files).toContain("width={picture ? halfWidth : blockWidth}");
    expect(files).toContain("...images.map((i) => ({ ...i, failed: false, picture: true }))");
  });

  test("the line under a file's name breaks between its facts, never inside one", () => {
    const files = readFileSync(join(import.meta.dir, "../../src/features/files/MessageFiles.tsx"), "utf8");
    expect(files.slice(files.indexOf("export function useFileLine("))).toMatch(
      /\]\s*\.map\(keepWhole\)\s*\.join\(" · "\)/,
    );
    const image = readFileSync(join(import.meta.dir, "../../src/features/files/ImageViewer.tsx"), "utf8");
    expect(image).toContain('[place, author, savedWhen(savedAt(detail))].filter(Boolean).map(keepWhole).join(" · ")');
  });

  test("a chart opened whole: × alone on the bar, its title on a row of its own under it, never cut", () => {
    const chart = readFileSync(join(import.meta.dir, "../../src/features/chat/ChartCard.tsx"), "utf8");
    // The task sheets' bar with no title: × alone.
    const bar = chart.slice(chart.indexOf("<SheetBar"), chart.indexOf("{chart.spec.title}"));
    expect(bar).toStartWith("<SheetBar onClose={() => router.back()} />");
    expect(bar).not.toContain("title=");
    expect(bar).not.toContain("numberOfLines");
    expect(chart).not.toContain("sheetSpacer");
    // The scroll view is the sheet's first child, the bar pinned in it: a form sheet sizes its first scroll view to
    // the whole sheet, and a bar standing before it was drawn over the chart.
    const sheet = chart.slice(
      chart.indexOf("export function ChartSheet()"),
      chart.indexOf("export function ChartView("),
    );
    expect(sheet.slice(sheet.lastIndexOf("return (")).trimStart()).toMatch(/^return \(\s*<ScrollView\b/);
    expect(sheet).toContain("stickyHeaderIndices={[0]}");
  });

  test("a browser profile's sign-in screen keeps its name and line whole beside ×", () => {
    const screen = readFileSync(join(import.meta.dir, "../../src/features/browser/ProfileLoginScreen.tsx"), "utf8");
    const top = screen.slice(screen.indexOf("<View style={[styles.top,"), screen.indexOf("<ScrollView"));
    expect(top).not.toContain("numberOfLines");
  });
});
