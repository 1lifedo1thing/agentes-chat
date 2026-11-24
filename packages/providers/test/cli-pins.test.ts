import { expect, test } from "bun:test";
import { CLI_PINS, ownCopyServes, PIN_CLIS, parseCliPins, pinPlatformOf } from "../src/cli-pins";

/* The coding CLIs' pins (ADR 0228 §6): one version and each system's build per CLI, checked as the runner takes it. */

test("every CLI is pinned, each build at https with a hash of its algorithm's size and a program inside", () => {
  expect(Object.keys(CLI_PINS).sort()).toEqual([...PIN_CLIS].sort());
  for (const pin of Object.values(CLI_PINS)) {
    expect(Object.keys(pin.builds).length).toBeGreaterThan(0);
    for (const b of Object.values(pin.builds)) {
      expect(b?.url.startsWith("https://")).toBe(true);
      expect(b?.hash.value).toMatch(b?.hash.algorithm === "sha512" ? /^[0-9a-f]{128}$/ : /^[0-9a-f]{64}$/);
      expect(b?.executable).not.toContain("..");
    }
  }
  // As the runner gets them from the wire: nothing is lost.
  expect(parseCliPins(JSON.parse(JSON.stringify(CLI_PINS)))).toEqual(CLI_PINS);
});

test("from the wire: only https, a well-formed hash and a program path inside the copy's folder", () => {
  const good = {
    url: "https://x.example/c",
    hash: { algorithm: "sha256", value: "a".repeat(64) },
    archive: "file",
    executable: "c",
  };
  const parsed = parseCliPins({
    claude: { version: "1.2.3", builds: { "linux-x64": good, "darwin-arm64": { ...good, url: "http://x.example/c" } } },
    codex: { version: "1.2.3", builds: { "linux-x64": { ...good, executable: "../../bin/sh" } } },
    grok: { version: "1.2.3", builds: { "linux-x64": { ...good, hash: { algorithm: "md5", value: "a" } } } },
    opencode: { version: "1.2.3", builds: { "linux-x64": { ...good, strip: 9 } } },
  });
  expect(Object.keys(parsed ?? {}).sort()).toEqual(["claude", "opencode"]);
  expect(Object.keys(parsed?.claude?.builds ?? {})).toEqual(["linux-x64"]);
  expect(parsed?.opencode?.builds["linux-x64"]?.strip).toBeUndefined();
  expect(parseCliPins("nope")).toBeNull();
  expect(parseCliPins({ claude: { version: "x" } })).toBeNull();
});

test("this system's name in the pins", () => {
  expect(pinPlatformOf("darwin", "arm64", false)).toBe("darwin-arm64");
  expect(pinPlatformOf("linux", "x64", false)).toBe("linux-x64");
  expect(pinPlatformOf("linux", "arm64", true)).toBe("linux-arm64-musl");
  expect(pinPlatformOf("win32", "x64", false)).toBe("win32-x64");
  expect(pinPlatformOf("freebsd", "x64", false)).toBeNull();
  expect(pinPlatformOf("linux", "ia32", false)).toBeNull();
});

test("the person's own copy runs at the pinned version or newer; a line with no version never does", () => {
  const pin = { version: "2.1.325", builds: {} };
  expect(ownCopyServes(pin, "2.1.325 (Claude Code)")).toBe(true);
  expect(ownCopyServes(pin, "2.2.0 (Claude Code)")).toBe(true);
  expect(ownCopyServes(pin, "2.1.300 (Claude Code)")).toBe(false);
  expect(ownCopyServes(pin, "unknown")).toBe(false);
});
