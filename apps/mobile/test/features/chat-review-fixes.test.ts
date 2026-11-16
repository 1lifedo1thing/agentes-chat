import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INLINE_HEIGHT } from "../../src/features/blocks/logic";
import { keptHeightAfter } from "../../src/features/chat/kept-sizes";
import { type Inline, tableColumnWidths, tableResolvesLate } from "../../src/features/chat/logic";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("a sheet that never shows can't leave the conversation's sheet host open", () => {
  test("every step presents as it mounts, so the system waits out a sheet still leaving", () => {
    const host = src("features/shared/SheetHost.tsx");
    expect(host).toContain("presentOnMount: true });");
    expect(host).not.toContain("presentOnMount: !first");
    // The keyboard leaves when a new sheet starts, after the listeners (the conversation reads it still up).
    const start = host.slice(host.indexOf("const start = "), host.indexOf("return {\n      open: start,"));
    const fresh = start.slice(start.indexOf("} else {"));
    expect(fresh).toContain("Keyboard.dismiss();");
    expect(start.indexOf("for (const l of listeners.current) l(true);")).toBeLessThan(start.indexOf("Keyboard.dismiss();"));
  });

  test("open turning false still dismisses a sheet presented on mount; a failed present ends as a dismissal", () => {
    const sheet = src("ui/Sheet.tsx");
    const props = sheet.slice(sheet.indexOf("export function useSheetProps("));
    expect(props).not.toContain("if (presentOnMount) return;");
    expect(props).not.toContain("void ref.current?.present();");
    expect(props).toMatch(
      /void ref\.current\?\.present\(\)\.catch\(\(\) => \{\s*shown\.current = false;\s*if \(openRef\.current\) closeRef\.current\(\);\s*goneRef\.current\?\.\(\);/,
    );
    // An auto-present that lands after the owner closed the sheet goes away again.
    expect(props).toMatch(/onDidPresent: \(\) => \{\s*if \(!openRef\.current\) void ref\.current\?\.dismiss\(\);/);
  });
});

describe("answering an agent that waits: 'pensando…' comes once, not twice", () => {
  test("the server's answer drops the guess only when a steered run has its own row here", () => {
    const chat = src("features/chat/ChatScreen.tsx");
    const sent = chat.slice(chat.indexOf("onSent: (message, local) => {"), chat.indexOf("onFailed: (error,"));
    expect(sent).toContain(
      "if (live.runs.some((r) => !r.provisional && steered.includes(r.runId))) live.forget(message.id, false);",
    );
    expect(sent).not.toContain("steeredRunIds.length > 0");
  });
});

describe("a reply that fit is never judged again over the keyboard", () => {
  test("the keyboard coming up, and going to the end, drop the reply waiting to be read from the top", () => {
    const chat = src("features/chat/ChatScreen.tsx");
    expect(chat).toMatch(
      /KeyboardEvents\.addListener\("keyboardWillShow", \(\) => \{\s*toReadRef\.current = null;\s*\}\);/,
    );
    const toEnd = chat.slice(chat.indexOf("const toEnd = useCallback(() => {"));
    expect(toEnd.slice(0, toEnd.indexOf("}, [letGo]);"))).toContain("toReadRef.current = null;");
  });
});

describe("a table's columns never go back to the letters' guess, and follow cells that load later", () => {
  const cell = (text: string, kind: "text" | "bold" = "text"): Inline[] => [{ kind, text }];
  test("a table holding a pill, a channel or a mention keeps measuring; words alone measure once", () => {
    const header = [cell("Arquivo"), cell("Status")];
    expect(tableResolvesLate(header, [[cell("Relatório"), cell("ok", "bold")]])).toBe(false);
    const file: Inline[] = [{ kind: "link", text: "x", href: "https://example.test/f/1" }];
    expect(tableResolvesLate(header, [[file, cell("ok")]])).toBe(true);
    const id: Inline[] = [{ kind: "id", text: "0193", id: "0193" }];
    expect(tableResolvesLate(header, [[cell("a"), id]])).toBe(true);
    const channel: Inline[] = [{ kind: "channel", text: "#geral", name: "geral" }];
    expect(tableResolvesLate([channel, cell("b")], [])).toBe(true);
    expect(tableResolvesLate(header, [[[{ kind: "mention", text: "@ada" }], cell("c")]])).toBe(true);
  });

  test("new cells draw at the widths measured last, not at the guess", () => {
    const header = [cell("Valor")];
    const rows = [[cell("R$ 1.234.567.890,00")]];
    // The guess by letters is far from the 120 measured last, which is what new cells draw at until measured.
    expect(tableColumnWidths(header, rows, {})[0]).not.toBe(121);
    expect(tableColumnWidths(header, rows, { 0: 120 })[0]).toBe(121);
    const spans = src("features/chat/MessageSpans.tsx");
    expect(spans).toContain("const widths = tableColumnWidths(header, rows, { ...measured.before, ...drawn }, fontScale);");
    // The copy's own measures keep what was measured before (`...m`), and a copy per content says every column.
    expect(spans).toContain("m.key !== columnsKey || m.columns[col] === w ? m : { ...m, columns: { ...m.columns, [col]: w } },");
    expect(spans).toMatch(/\{unmeasured \|\| late \? \(\s*<View\s*key=\{columnsKey\}/);
  });
});

describe("words set from the composer leave nothing selected", () => {
  const composer = src("ui/Composer.tsx");
  const between = (from: string, to: string) => composer.slice(composer.indexOf(from), composer.indexOf(to));
  test("sending (and a pick) forget the selection: no formatting bar over the emptied field", () => {
    expect(composer).toMatch(
      /const unselect = \(\) => \{\s*if \(!selectingRef\.current\) return;\s*selectingRef\.current = false;\s*setSelecting\(false\);/,
    );
    expect(between("const clear = () => {", "const send = ")).toContain("unselect();");
    expect(between("const put = (next: string", "const clear = () => {")).toContain("unselect();");
  });

  test("words handed back (a draft to fix, a take that didn't go) move the caret and the '@' token with them", () => {
    const prefill = between("const handed = prefill.text;", "useEffect(() => {\n    if (focusAt)");
    expect(prefill).toContain("put(next);");
    expect(prefill).not.toContain("setText(next);");
    expect(composer).toContain("if (!sent && value) put(joinDrafts(value, textRef.current));");
  });
});

describe("a live block that gets shorter while cut takes its real height", () => {
  test("a reading under the cut can't be a clamped one: it lowers the height, and the cut goes", () => {
    // Details opened: 520 whole, cut at the card's height. Closed again, the parts read 300 under the cut.
    expect(keptHeightAfter(520, 300, true, INLINE_HEIGHT)).toBe(300);
    // A long text clamped by the cut reads the whole room: still the rule that only raises.
    expect(keptHeightAfter(520, INLINE_HEIGHT, true, INLINE_HEIGHT)).toBeNull();
    expect(keptHeightAfter(520, 600, true, INLINE_HEIGHT)).toBe(600);
    // Without a cap (a message's words) nothing changes.
    expect(keptHeightAfter(520, 300, true)).toBeNull();
  });

  test("no loop: once under the cut, the uncut reading is the same height", () => {
    let kept = 520;
    for (let i = 0; i < 4; i++) {
      const cut = kept > INLINE_HEIGHT;
      kept = keptHeightAfter(kept, 300, cut, INLINE_HEIGHT) ?? kept;
    }
    expect(kept).toBe(300);
  });

  test("its kept height is its own version's (and width's and text size's)", () => {
    const spec = src("features/blocks/SpecBlock.tsx");
    expect(spec).toContain("if (sized.key !== sizeKey) setSized({ key: sizeKey, height: keptSize(sizeKey) ?? 0 });");
    expect(spec).toContain("setSized((now) => (now.key === sizeKey ? { key: sizeKey, height: next } : now));");
  });
});
