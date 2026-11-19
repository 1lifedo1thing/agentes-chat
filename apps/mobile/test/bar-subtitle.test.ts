import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * A pushed screen's title and its line (the step, the board, the plan, who sent a file) stand together in the bar,
 * centred. On iOS 26 the system's bar holds the line itself (`UINavigationItem.subtitle`), set by the app's own
 * module (the navigator has none); before it, and on Android, `PushedHeader` draws both, kept clear of the wider side
 * so the bar never pushes them against the back button.
 */
const APP = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(APP, path), "utf8");

test("on iOS 26 the system's bar holds the line: a view of no size sets the screen's navigation item", () => {
  const swift = read("modules/nav-subtitle/ios/NavSubtitleModule.swift");
  expect(swift).toContain('Name("NavSubtitle")');
  expect(swift).toContain("if #available(iOS 26.0, *) {");
  expect(swift).toContain("screenController()?.navigationItem.subtitle = subtitle");
  // Older compilers know no subtitle: the module builds and says it can't.
  expect(swift).toContain("#if compiler(>=6.2)");
  expect(JSON.parse(read("modules/nav-subtitle/expo-module.config.json"))).toEqual({
    platforms: ["apple"],
    apple: { modules: ["NavSubtitleModule"] },
  });
  const js = read("src/features/shared/nav-subtitle.ts");
  expect(js).toContain('requireOptionalNativeModule<NavSubtitleNative>("NavSubtitle")');
  expect(js).toMatch(/native\?\.supported\(\)\s*\?\s*requireNativeView\("NavSubtitle"\)\s*:\s*null/);
});

test("PushedHeader: the system's line where there is one, drawn with the title elsewhere", () => {
  const parts = read("src/features/shared/parts.tsx");
  expect(parts).toContain('const nativeLine = NavSubtitle !== null && typeof title === "string";');
  expect(parts).toContain("const line = subtitle && !nativeLine ? subtitle : undefined;");
  // Always there with words for a title, so a line dropped later leaves the bar too.
  expect(parts).toContain(
    '{NavSubtitle && typeof title === "string" ? <NavSubtitle subtitle={subtitle} style={styles.navLine} /> : null}',
  );
  // Drawn: kept clear of the wider side, so iOS centres it.
  expect(parts).toContain(
    "side={line !== undefined ? titleSide(word !== null, rightCount) : word !== null ? 100 : 75}",
  );
  expect(parts).not.toContain("BarNote");
});

test("the screens hand their line to the bar", () => {
  expect(read("src/features/settings/parts.tsx")).toMatch(/<PushedHeader\s+title=\{title\}\s+subtitle=\{subtitle\}/);
  expect(read("src/features/ai/KeyForAllScreen.tsx")).toContain("subtitle={plan?.label}");
  expect(read("src/features/dashboards/ShareScreen.tsx")).toContain("subtitle={board.title}");
  expect(read("src/features/dashboards/OrganizeScreen.tsx")).toContain(
    'subtitle={home ? t("dashboards.home") : board.title}',
  );
  expect(read("src/features/usage/UsageAccountScreen.tsx")).toContain("subtitle={subtitle || undefined}");
  // A live file: "Read-only", or a lasting dropped connection, in the warning's colour where the app draws it.
  const live = read("src/features/live-files/shared/LiveBar.tsx");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the bar's source
  expect(live).toContain("subtitle={status ? t(`mobile.live.status.${status}`) : undefined}");
  expect(live).toContain('subtitleColor={status === "readOnly" ? c.faint : c.warn}');
});

test("General saves as a control moves, as the system's settings do: no Saved flashing under the title", () => {
  const general = read("src/features/settings/GeneralScreen.tsx");
  expect(general).not.toContain("subtitle=");
  expect(general).not.toContain("SAVED_MS");
  // A screen reader still hears that the change stuck.
  expect(general).toContain('onSuccess: () => AccessibilityInfo.announceForAccessibility(t("settings.savedShort")),');
});
