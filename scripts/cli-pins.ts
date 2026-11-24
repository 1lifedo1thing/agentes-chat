#!/usr/bin/env bun
/**
 * Rewrites the coding CLIs' pins (`packages/providers/src/cli-pins.ts`, ADR 0228 §6) from each vendor's latest stable
 * release: the version, and each system's build with its hash. The vendor's own hash where it publishes one (Claude
 * Code's manifest, Codex's and OpenCode's release assets); otherwise the build is downloaded and hashed here (Cursor's,
 * Grok Build's). The Antigravity CLI keeps its pin: its builds' addresses carry a build number its channel doesn't
 * name, so it moves by hand. Prints what changed; with nothing new it leaves the file as it is. The `cli-pins`
 * workflow runs it daily and opens a pull request with the change, never merged by itself.
 *
 *   bun scripts/cli-pins.ts            rewrite the file
 *   bun scripts/cli-pins.ts --check    say what is new, change nothing (exit 1 when something is)
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLI_PINS, type CliBuild, type CliPin, type PinCli, type PinPlatform } from "../packages/providers/src/cli-pins";

const FILE = path.join(import.meta.dir, "../packages/providers/src/cli-pins.ts");
const GITHUB = "https://api.github.com/repos";

const headers = (): Record<string, string> =>
  process.env.GITHUB_TOKEN
    ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json" }
    : { accept: "application/vnd.github+json" };

async function text(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.text()).trim();
}

async function json<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000), ...init });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** A build downloaded and hashed here (sha256), streamed: nothing is kept. */
async function sha256Of(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const hash = createHash("sha256");
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) hash.update(chunk);
  return hash.digest("hex");
}

const sha256 = (value: string) => ({ algorithm: "sha256" as const, value });

/** A GitHub release's assets with their sha256 (`digest: "sha256:…"`). */
async function release(repo: string): Promise<{ tag: string; assets: Map<string, { url: string; sha256: string }> }> {
  const r = await json<{
    tag_name: string;
    assets: { name: string; browser_download_url: string; digest?: string | null }[];
  }>(`${GITHUB}/${repo}/releases/latest`, { headers: headers() });
  const assets = new Map<string, { url: string; sha256: string }>();
  for (const a of r.assets) {
    const d = /^sha256:([0-9a-f]{64})$/.exec(a.digest ?? "");
    if (d?.[1]) assets.set(a.name, { url: a.browser_download_url, sha256: d[1] });
  }
  return { tag: r.tag_name, assets };
}

async function claude(): Promise<CliPin> {
  const base = "https://downloads.claude.ai/claude-code-releases";
  const version = await text(`${base}/stable`);
  const manifest = await json<{ platforms: Record<string, { checksum: string }> }>(`${base}/${version}/manifest.json`);
  const builds: CliPin["builds"] = {};
  for (const platform of Object.keys(CLI_PINS.claude.builds) as PinPlatform[]) {
    const checksum = manifest.platforms[platform]?.checksum;
    if (!checksum) continue;
    const exe = platform.startsWith("win32") ? "claude.exe" : "claude";
    builds[platform] = { url: `${base}/${version}/${platform}/${exe}`, hash: sha256(checksum), archive: "file", executable: exe };
  }
  return { version, builds };
}

/** Codex's packages per system (its Linux ones are musl builds, which run on any libc). */
const CODEX_TARGETS: Record<string, PinPlatform[]> = {
  "aarch64-apple-darwin": ["darwin-arm64"],
  "x86_64-apple-darwin": ["darwin-x64"],
  "x86_64-unknown-linux-musl": ["linux-x64", "linux-x64-musl"],
  "aarch64-unknown-linux-musl": ["linux-arm64", "linux-arm64-musl"],
  "x86_64-pc-windows-msvc": ["win32-x64"],
  "aarch64-pc-windows-msvc": ["win32-arm64"],
};

async function codex(): Promise<CliPin> {
  const r = await release("openai/codex");
  const version = r.tag.replace(/^rust-v/, "");
  const builds: CliPin["builds"] = {};
  for (const [target, platforms] of Object.entries(CODEX_TARGETS)) {
    const asset = r.assets.get(`codex-package-${target}.tar.gz`);
    if (!asset) continue;
    const exe = target.includes("windows") ? "bin/codex.exe" : "bin/codex";
    for (const p of platforms) {
      builds[p] = { url: asset.url, hash: sha256(asset.sha256), archive: "tar.gz", executable: exe };
    }
  }
  return { version, builds };
}

const OPENCODE_ASSETS: Record<PinPlatform, string> = {
  "darwin-arm64": "opencode-darwin-arm64.zip",
  "darwin-x64": "opencode-darwin-x64.zip",
  "linux-x64": "opencode-linux-x64.tar.gz",
  "linux-arm64": "opencode-linux-arm64.tar.gz",
  "linux-x64-musl": "opencode-linux-x64-musl.tar.gz",
  "linux-arm64-musl": "opencode-linux-arm64-musl.tar.gz",
  "win32-x64": "opencode-windows-x64.zip",
  "win32-arm64": "opencode-windows-arm64.zip",
};

async function opencode(): Promise<CliPin> {
  const r = await release("sst/opencode");
  const builds: CliPin["builds"] = {};
  for (const [platform, name] of Object.entries(OPENCODE_ASSETS) as [PinPlatform, string][]) {
    const asset = r.assets.get(name);
    if (!asset) continue;
    builds[platform] = {
      url: asset.url,
      hash: sha256(asset.sha256),
      archive: name.endsWith(".zip") ? "zip" : "tar.gz",
      executable: platform.startsWith("win32") ? "opencode.exe" : "opencode",
    };
  }
  return { version: r.tag.replace(/^v/, ""), builds };
}

async function cursor(): Promise<CliPin> {
  const script = await text("https://cursor.com/install");
  const version = /downloads\.cursor\.com\/lab\/([\w.-]+)\//.exec(script)?.[1];
  if (!version) throw new Error("cursor: no version in its installer");
  if (version === CLI_PINS.cursor.version) return CLI_PINS.cursor;
  const builds: CliPin["builds"] = {};
  const systems: [PinPlatform, string][] = [
    ["darwin-arm64", "darwin/arm64"],
    ["darwin-x64", "darwin/x64"],
    ["linux-x64", "linux/x64"],
    ["linux-arm64", "linux/arm64"],
  ];
  for (const [platform, where] of systems) {
    const url = `https://downloads.cursor.com/lab/${version}/${where}/agent-cli-package.tar.gz`;
    builds[platform] = { url, hash: sha256(await sha256Of(url)), archive: "tar.gz", strip: 1, executable: "cursor-agent" };
  }
  return { version, builds };
}

async function grok(): Promise<CliPin> {
  const version = (await text("https://x.ai/cli/stable")).split("\n")[0]?.trim() ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`grok: unexpected version "${version}"`);
  if (version === CLI_PINS.grok.version) return CLI_PINS.grok;
  const builds: CliPin["builds"] = {};
  const systems: [PinPlatform, string, string][] = [
    ["darwin-arm64", "macos-aarch64", "grok"],
    ["darwin-x64", "macos-x86_64", "grok"],
    ["linux-x64", "linux-x86_64", "grok"],
    ["linux-arm64", "linux-aarch64", "grok"],
    ["win32-x64", "windows-x86_64.exe", "grok.exe"],
    ["win32-arm64", "windows-aarch64.exe", "grok.exe"],
  ];
  for (const [platform, name, exe] of systems) {
    const url = `https://x.ai/cli/grok-${version}-${name}`;
    builds[platform] = { url, hash: sha256(await sha256Of(url)), archive: "file", executable: exe };
  }
  return { version, builds };
}

/** One CLI's entry as the file writes it. */
function render(cli: PinCli, pin: CliPin): string {
  const build = (p: string, b: CliBuild) =>
    [
      `      ${JSON.stringify(p)}: {`,
      `        url: ${JSON.stringify(b.url)},`,
      `        hash: ${b.hash.algorithm}(${JSON.stringify(b.hash.value)}),`,
      `        archive: ${JSON.stringify(b.archive)},`,
      ...(b.strip ? [`        strip: ${b.strip},`] : []),
      `        executable: ${JSON.stringify(b.executable)},`,
      "      },",
    ].join("\n");
  const builds = Object.entries(pin.builds)
    .map(([p, b]) => build(p, b as CliBuild))
    .join("\n");
  return `  ${cli}: {\n    version: ${JSON.stringify(pin.version)},\n    builds: {\n${builds}\n    },\n  },`;
}

const FETCHERS: Partial<Record<PinCli, () => Promise<CliPin>>> = { claude, codex, cursor, opencode, grok };

const check = process.argv.includes("--check");
let source = readFileSync(FILE, "utf8");
const changed: string[] = [];
for (const [cli, fetchPin] of Object.entries(FETCHERS) as [PinCli, () => Promise<CliPin>][]) {
  let next: CliPin;
  try {
    next = await fetchPin();
  } catch (err) {
    console.error(`${cli}: kept ${CLI_PINS[cli].version} (${err instanceof Error ? err.message : String(err)})`);
    continue;
  }
  if (JSON.stringify(next) === JSON.stringify(CLI_PINS[cli])) continue;
  changed.push(`${cli} ${CLI_PINS[cli].version} → ${next.version}`);
  // Each entry starts at `  <cli>: {` and ends at the first `  },` at its own depth.
  const start = source.indexOf(`\n  ${cli}: {\n`);
  const end = source.indexOf("\n  },", start + 1);
  if (start < 0 || end < 0) throw new Error(`${cli}: its entry isn't where it should be`);
  source = `${source.slice(0, start + 1)}${render(cli, next)}${source.slice(end + "\n  },".length)}`;
}
// The address constants above the list stay as they were; the entries carry their own.
if (changed.length) {
  console.log(changed.join("\n"));
  if (check) process.exit(1);
  writeFileSync(FILE, source);
} else console.log("every pin is current");
