import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

test("on iOS 26 the composer wears the system's Liquid Glass; the raised pill and its ring before it, and on Android", () => {
  const composer = src("ui/Composer.tsx");
  // One rule for the field, a voice take's bar and the formatting bar: the glass where iOS has it, else the pill.
  expect(composer).toContain(
    "const raisedGround = (raised: string, shadow: string) =>\n  liquidHere ? null : { backgroundColor: raised, boxShadow: shadow };",
  );
  expect(composer).toContain("raisedGround(colors.raised, FIELD_SHADOW(colors.line2))");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the composer's own template, read as source text
  expect(composer).toContain("raisedGround(colors.raised, `${shadows.e1}, ${shadows.top}`)");
  expect(composer).not.toContain("backgroundColor: colors.raised,\n              boxShadow: FIELD_SHADOW");
  // Under everything the field holds (its first child), the field's whole size as it grows; never answering a touch.
  const field = composer.slice(composer.indexOf("styles.field,"), composer.indexOf("styles.attachRow"));
  expect(field).toContain("{liquidHere ? <Glass liquid interactive={false} style={styles.fieldGlass} /> : null}");
  expect(composer.match(/<Glass liquid interactive=\{false\} style=\{styles\.fieldGlass\} \/>/g)).toHaveLength(2);
  expect(composer).toContain("{liquidHere ? <Glass liquid interactive={false} style={styles.formatGlass} /> : null}");
  expect(composer).toContain("fieldGlass: { ...StyleSheet.absoluteFill, borderRadius: FIELD / 2 },");
  // The "+" beside it: the same glass, one press (the kit's scale), its ring only where it is the blur.
  expect(composer).toContain("<Glass liquid interactive={false} style={styles.plusGlass} intensity={50}>");
  expect(composer).toContain(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the composer's own template, read as source text
    "style={[styles.plus, liquidHere ? null : { boxShadow: `0px 0px 0px 0.5px ${colors.line2}, ${shadows.top}` }]}",
  );
});

test("what floats over the composer wears its glass: a take's labels, the way back to the latest messages", () => {
  const voice = src("features/voice/useVoiceComposer.tsx");
  expect(voice).toContain("<Glass liquid interactive={false} style={styles.capsule} intensity={50}>");
  expect(voice).toContain("<Glass liquid interactive={false} style={styles.lineGlass} intensity={50}>");
  const chat = src("features/chat/ChatScreen.tsx");
  expect(chat).toContain("{liquidHere ? <Glass liquid interactive={false} style={styles.jumpGlass} /> : null}");
  expect(chat).toContain(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the screen's own template, read as source text
    "liquidHere ? null : { backgroundColor: colors.raised, boxShadow: `${shadows.e2}, ${shadows.top}` },",
  );
});
