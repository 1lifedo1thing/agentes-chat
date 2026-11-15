import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HELP, type HelpBlock } from "@agenteschat/i18n/help";
import type { AppLocale } from "@agenteschat/i18n/locale";
import { desktopStrings } from "../src/i18n";

const REPO = join(import.meta.dir, "..", "..", "..");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const lines = (b: HelpBlock): string[] => (typeof b === "string" ? [b] : "list" in b ? b.list : [b.code]);

/** The folders the app keeps, as the code names them: a guide to deleting them names each one exactly. */
const FOLDERS = [".agentes", ".agentes-runner", "agentes.chat erased", "chat.agentes.desktop", "agentes.chat.plist"];

describe("the help page on starting over and uninstalling", () => {
  test("the folders it names are the ones the code keeps", () => {
    const local = read("apps/desktop/src-tauri/src/local_server.rs");
    expect(local).toContain('const FOLDER: &str = ".agentes";');
    expect(local).toContain('home.join(format!("agentes.chat erased {date}"))');
    expect(read("apps/desktop/src-tauri/src/runners.rs")).toContain('home.join(".agentes-runner").join("orgs")');
    expect(JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")).identifier).toBe("chat.agentes.desktop");
    // The login item is named after the app (`migrate_login_item` in lib.rs).
    expect(JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")).productName).toBe("agentes.chat");
    const selfHosting = read("SELF_HOSTING.md");
    expect(FOLDERS.filter((f) => !selfHosting.includes(f))).toEqual([]);
  });

  for (const [code, pages] of Object.entries(HELP)) {
    test(`${code}: names the app's own buttons and menus, and every folder`, () => {
      const section = pages["run-on-your-computer"]?.sections.find((s) => s.id === "uninstall");
      const text = section?.blocks.flatMap(lines).join("\n") ?? "";
      const d = desktopStrings(code as AppLocale);
      const prefs = d.windowTitle.prefs;
      const names = [
        `**${prefs} › ${d.prefs.nav.servers}**`,
        `**${d.server.erase}**`,
        `**${prefs} › ${d.prefs.nav.general}**`,
        `**${d.prefs.general.launchTitle}**`,
        `**${d.tray.quit}**`,
        ...FOLDERS.map((f) => `\`${f}`),
      ];
      expect({ code, missing: names.filter((n) => !text.includes(n)) }).toEqual({ code, missing: [] });
      // Quitting comes before any deleting.
      const steps = section?.blocks.find((b): b is { list: string[] } => typeof b === "object" && "list" in b);
      expect(steps?.list.findIndex((l) => l.includes(`**${d.tray.quit}**`))).toBe(1);
    });
  }
});
