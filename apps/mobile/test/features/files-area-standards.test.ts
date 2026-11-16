import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("presses in the files, the blocks and the Drive are the kit's", () => {
  test("a file, a picture or a video opened from a message or the Drive gives under the finger, with no tap", () => {
    for (const file of [
      "features/files/AttachmentTile.tsx",
      "features/files/MessageFiles.tsx",
      "features/files/VideoPlayer.tsx",
      "features/drive/DriveCard.tsx",
    ]) {
      const s = src(file);
      expect({ file, kit: s.includes("<PressScale") && s.includes("haptic={false}") }).toEqual({ file, kit: true });
      // No pressed look of its own, no haptic added by hand on navigation.
      expect({ file, own: /pressed && styles\.pressed|tapHaptic\(\)/.test(s) }).toEqual({ file, own: false });
    }
  });

  test("a vote's and a choice's options press as the kit does; the choice card's buttons are the kit's buttons", () => {
    for (const file of ["features/blocks/PollCard.tsx", "features/blocks/ChoicesCard.tsx"]) {
      const s = src(file);
      expect({ file, kit: s.includes("<PressScale") }).toEqual({ file, kit: true });
      expect({ file, own: s.includes("<Pressable") || s.includes("tapHaptic") }).toEqual({ file, own: false });
    }
    const choices = src("features/blocks/ChoicesCard.tsx");
    expect(choices).toContain('<IconButton icon="x" label={t("mobile.choices.close")}');
    expect(choices).toMatch(/<Button\s+variant="ghost"\s+size="sm"\s+label=\{t\("mobile\.choices\.back"\)\}/);
    expect(choices).toMatch(/<Button\s+variant="ghost"\s+size="sm"\s+label=\{t\("mobile\.choices\.next"\)\}/);
  });

  test("a block's buttons give one tap each (the kit's), its disclosure is a button with a chevron", () => {
    for (const file of ["features/blocks/SpecBlock.tsx", "features/blocks/LiveBlock.tsx"])
      expect({ file, double: src(file).includes("tapHaptic") }).toEqual({ file, double: false });
    const spec = src("features/blocks/SpecBlock.tsx");
    expect(spec).not.toContain("▸");
    expect(spec).toContain('icon={open ? "chev" : "right"}');
    // A drawn value comes in on the app's ease-out, no bounce; the success tap only on the phone of who drew it.
    expect(spec).toContain("if (change?.by === meId) haptics.success();");
    expect(spec).not.toContain("withSpring(0, { stiffness: 260, damping: 14 })");
  });

  test("a block's field is the app's text field, never one drawn by the block", () => {
    const spec = src("features/blocks/SpecBlock.tsx");
    expect(spec).toContain("<TextArea");
    expect(spec).not.toContain("<TextInput");
  });

  test("a deck of pictures let go of settles on the app's snap", () => {
    const stack = src("features/files/ImageStack.tsx");
    expect(stack).toContain("const SETTLE = { ...motion.snap };");
    expect(stack).not.toContain("stiffness: 190");
  });
});

describe("the Vault's screens", () => {
  test("New item is the bar's +, so the tabs never move when another tab shows", () => {
    const vault = src("features/vault/VaultScreen.tsx");
    expect(vault).toContain(
      'actions: [{ icon: "plus", sf: "plus", label: t("mobile.vault.newItem"), onPress: create }]',
    );
    expect(vault).not.toContain("tabEmpty");
    expect(vault.indexOf("<Segmented")).toBeLessThan(vault.indexOf("<Items"));
  });

  test("a page that didn't load offers to try again", () => {
    for (const file of [
      "features/vault/VaultScreen.tsx",
      "features/vault/VaultItemScreen.tsx",
      "features/vault/VaultAccessScreen.tsx",
      "features/vault/VaultConnectScreen.tsx",
      "features/vault/VaultConnectionScreen.tsx",
    ]) {
      const s = src(file);
      expect({ file, retry: s.includes("<LoadFailed onRetry=") }).toEqual({ file, retry: true });
      expect({ file, bare: s.includes('<Note icon="x">{t("common.loadFailed")}') }).toEqual({ file, bare: false });
    }
  });

  test("leaving a form with changes not saved asks first, and a finished save or delete doesn't", () => {
    for (const file of [
      "features/vault/VaultItemScreen.tsx",
      "features/vault/VaultAccessScreen.tsx",
      "features/vault/VaultEnvScreen.tsx",
      "features/vault/VaultNewScreen.tsx",
    ]) {
      const s = src(file);
      expect({ file, guard: s.includes("useUnsavedGuard(") }).toEqual({ file, guard: true });
      expect({ file, leave: s.includes("leave();") }).toEqual({ file, leave: true });
    }
  });
});

describe("Compartilhar com…", () => {
  test("the line to send is the app's text field, the sheet keeps a sheet's margins", () => {
    const share = src("features/share/ShareScreen.tsx");
    expect(share).toContain("<TextArea");
    expect(share).not.toContain("<TextInput");
    expect(share).toContain("content: { paddingHorizontal: SHEET_X, paddingTop: 8 },");
    expect(share).toContain("bar: { paddingHorizontal: SHEET_X, paddingTop: 12 },");
  });
});

describe("the search tab", () => {
  test("opens with the keyboard down: the field takes the focus only when the person taps it", () => {
    const search = src("features/search/SearchScreen.tsx");
    expect(search).not.toContain("FOCUS_DELAY_MS");
    // The only focus left is the one a filter word asks for (a tap on the screen already open).
    expect(search.match(/field\.current\?\.focus\(\)/g)?.length).toBe(1);
    expect(search.slice(search.indexOf("const startOp"))).toContain("field.current?.focus();");
  });

  test("a pull asks for the conversations and every search again", () => {
    const search = src("features/search/SearchScreen.tsx");
    expect(search).toContain("qc.refetchQueries({ queryKey: searchQueryRoot(orgId), type: \"active\" })");
    expect(search).toContain("pull={pull}");
  });

  test("a search that failed says so with a retry, never as nothing found", () => {
    const results = src("features/search/SearchResults.tsx");
    expect(results).toContain("const failed = words && hits.isError && !hits.data;");
    expect(results).toContain("{failed ? <LoadFailed onRetry={() => void hits.refetch()} /> : null}");
    expect(results).toContain("{words && !failed && isEmpty(r) && !hits.isFetching ? (");
  });

  test("taking the filters off is the kit's button, not a press drawn by hand", () => {
    const filters = src("features/search/SearchFilters.tsx");
    expect(filters).not.toContain("<Pressable");
    expect(filters).not.toContain("styles.pressed");
    expect(filters).toMatch(/<Button\s+variant="ghost"\s+size="sm"\s+icon="x"\s+label=\{t\("searchPage\.filtersApplied"/);
  });
});
