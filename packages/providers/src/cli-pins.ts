import { cliVersionAtLeast } from "./plans";

/**
 * The one way a computer gets its coding CLIs (ADR 0228 §6): pure data, served by the server to every runner
 * (`clis.pins`, `CLI_COPIES_PROTOCOL`) and built into the runner for an older server or none. For each CLI, one
 * version and each system's build at the vendor's own address, with the vendor's hash of it (or, where the vendor
 * publishes none, the one we took when pinning it). A runner runs the person's own copy at this version or newer;
 * otherwise it fetches this build on demand, checks the hash, keeps it in its own folder and runs that one, never
 * touching the person's. `scripts/cli-pins.ts` rewrites the list from the vendors' latest stable releases (the
 * `cli-pins` workflow, daily, as a pull request).
 */
export type PinCli = "claude" | "codex" | "cursor" | "opencode" | "grok" | "antigravity";

export const PIN_CLIS: readonly PinCli[] = ["claude", "codex", "cursor", "opencode", "grok", "antigravity"];

/** A system the runner fetches for: `<os>-<cpu>`, `-musl` on a Linux with musl's libc. */
export type PinPlatform =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-x64"
  | "linux-arm64"
  | "linux-x64-musl"
  | "linux-arm64-musl"
  | "win32-x64"
  | "win32-arm64";

export const PIN_PLATFORMS: readonly PinPlatform[] = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "linux-x64-musl",
  "linux-arm64-musl",
  "win32-x64",
  "win32-arm64",
];

export interface CliBuild {
  /** The vendor's own https address of this build. */
  url: string;
  hash: { algorithm: "sha256" | "sha512"; value: string };
  /** `file`: the download is the program itself; else an archive unpacked into the copy's folder. */
  archive: "file" | "tar.gz" | "zip";
  /** Leading folders dropped while unpacking (a package whose files sit under one top folder). */
  strip?: number;
  /** The program, relative to the copy's folder (the file's own name for `file`). */
  executable: string;
}

export interface CliPin {
  version: string;
  builds: Partial<Record<PinPlatform, CliBuild>>;
}

export type CliPins = Record<PinCli, CliPin>;

/**
 * What keeps each CLI from updating itself while the runner runs it, set on every process the runner starts: a copy
 * that replaced itself mid-turn would no longer be the one checked, and the person's own updates through its own
 * updater, outside agentes.chat.
 */
export const CLI_NO_SELF_UPDATE: Readonly<Record<string, string>> = {
  DISABLE_AUTOUPDATER: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  GROK_DISABLE_AUTOUPDATER: "1",
  AGY_CLI_DISABLE_AUTO_UPDATE: "true",
};

const sha256 = (value: string) => ({ algorithm: "sha256" as const, value });
const sha512 = (value: string) => ({ algorithm: "sha512" as const, value });


/**
 * Sources: Claude Code's `manifest.json` per version (sha256, what its installer checks); Codex's release
 * `codex-package_SHA256SUMS` (its Linux packages are musl builds, run on any libc); OpenCode's release assets' sha256;
 * Cursor's and Grok's builds, which come with no published hash, hashed when pinned; the Antigravity CLI's manifests
 * per platform (sha512). No build: the runner can't fetch that CLI there and the apps say so (`cli_outdated`,
 * `not_installed`).
 */
export const CLI_PINS: CliPins = {
  claude: {
    version: "2.1.325",
    builds: {
      "darwin-arm64": {
        url: "https://downloads.claude.ai/claude-code-releases/2.1.325/darwin-arm64/claude",
        hash: sha256("84590fefe6338be9087f5814b61f9a54c5f21524163a4c127cb5a808e31009f2"),
        archive: "file",
        executable: "claude",
      },
      "darwin-x64": {
        url: "https://downloads.claude.ai/claude-code-releases/2.1.325/darwin-x64/claude",
        hash: sha256("af9760c59f947044e2a0d5072343de563f31efb68bd18ccee4f43c5240570de7"),
        archive: "file",
        executable: "claude",
      },
      "linux-x64": {
        url: "https://downloads.claude.ai/claude-code-releases/2.1.325/linux-x64/claude",
        hash: sha256("0dc4f4a9a165fc60746d7ae8489712e5fc352f1e7ad4eb22e7141bd0812eb0cf"),
        archive: "file",
        executable: "claude",
      },
      "linux-arm64": {
        url: "https://downloads.claude.ai/claude-code-releases/2.1.325/linux-arm64/claude",
        hash: sha256("7b6e484b1989a5a14a4b354709ccc8672518a3ec5b9ccd7981fc6254327fde67"),
        archive: "file",
        executable: "claude",
      },
      "linux-x64-musl": {
        url: "https://downloads.claude.ai/claude-code-releases/2.1.325/linux-x64-musl/claude",
        hash: sha256("a5e3bd36dce97db0429705aa5c3573eea346a77938a89104b9c28fce409b20cd"),
        archive: "file",
        executable: "claude",
      },
      "linux-arm64-musl": {
        url: "https://downloads.claude.ai/claude-code-releases/2.1.325/linux-arm64-musl/claude",
        hash: sha256("14dc17cd958f62d82fb2ff6276368fc611a88be303e0ae1a8cca580495964efe"),
        archive: "file",
        executable: "claude",
      },
      "win32-x64": {
        url: "https://downloads.claude.ai/claude-code-releases/2.1.325/win32-x64/claude.exe",
        hash: sha256("87e0cb6ae0f4775da388cd3043f4d8097ef961dcddbf55fe90bc61ffc3f57a30"),
        archive: "file",
        executable: "claude.exe",
      },
      "win32-arm64": {
        url: "https://downloads.claude.ai/claude-code-releases/2.1.325/win32-arm64/claude.exe",
        hash: sha256("45c1d546a0048dcdde3433ada6c10f7f23bd71a96868b9d75e28f1ac266f1a25"),
        archive: "file",
        executable: "claude.exe",
      },
    },
  },
  codex: {
    version: "0.172.0",
    builds: {
      "darwin-arm64": {
        url: "https://github.com/openai/codex/releases/download/rust-v0.172.0/codex-package-aarch64-apple-darwin.tar.gz",
        hash: sha256("0970016d48209a09c4039139629ed79b4a31c5e3d864e792c043419d98fa6466"),
        archive: "tar.gz",
        executable: "bin/codex",
      },
      "darwin-x64": {
        url: "https://github.com/openai/codex/releases/download/rust-v0.172.0/codex-package-x86_64-apple-darwin.tar.gz",
        hash: sha256("b5e94828f45171f13d81de2b96cae05c0b7e6a7f2f7d3c9d4e748be3d3906c02"),
        archive: "tar.gz",
        executable: "bin/codex",
      },
      "linux-x64": {
        url: "https://github.com/openai/codex/releases/download/rust-v0.172.0/codex-package-x86_64-unknown-linux-musl.tar.gz",
        hash: sha256("63e3b00065ed7f62166d0522e17f663cb866a31d80d03e63365482ed34a1d991"),
        archive: "tar.gz",
        executable: "bin/codex",
      },
      "linux-arm64": {
        url: "https://github.com/openai/codex/releases/download/rust-v0.172.0/codex-package-aarch64-unknown-linux-musl.tar.gz",
        hash: sha256("faf17b8071927f33346a805dc8cb45de4e08c0d75cf0e5e68cecddca28b8861e"),
        archive: "tar.gz",
        executable: "bin/codex",
      },
      "linux-x64-musl": {
        url: "https://github.com/openai/codex/releases/download/rust-v0.172.0/codex-package-x86_64-unknown-linux-musl.tar.gz",
        hash: sha256("63e3b00065ed7f62166d0522e17f663cb866a31d80d03e63365482ed34a1d991"),
        archive: "tar.gz",
        executable: "bin/codex",
      },
      "linux-arm64-musl": {
        url: "https://github.com/openai/codex/releases/download/rust-v0.172.0/codex-package-aarch64-unknown-linux-musl.tar.gz",
        hash: sha256("faf17b8071927f33346a805dc8cb45de4e08c0d75cf0e5e68cecddca28b8861e"),
        archive: "tar.gz",
        executable: "bin/codex",
      },
      "win32-x64": {
        url: "https://github.com/openai/codex/releases/download/rust-v0.172.0/codex-package-x86_64-pc-windows-msvc.tar.gz",
        hash: sha256("b723674d7caf26a3f55121a02d6cad8f3ac8ddf5860747a6edde1c904cf593af"),
        archive: "tar.gz",
        executable: "bin/codex.exe",
      },
      "win32-arm64": {
        url: "https://github.com/openai/codex/releases/download/rust-v0.172.0/codex-package-aarch64-pc-windows-msvc.tar.gz",
        hash: sha256("6aa686d9ac16cc171b8207273ac20eb9321bf3963f2801722045e906c00ea804"),
        archive: "tar.gz",
        executable: "bin/codex.exe",
      },
    },
  },
  cursor: {
    version: "2026.11.22-e9042b2",
    builds: {
      "darwin-arm64": {
        url: "https://downloads.cursor.com/lab/2026.11.22-e9042b2/darwin/arm64/agent-cli-package.tar.gz",
        hash: sha256("92f39e448218897538bd801cdb01d69106ab37a86aaf3dc0e6b55159c79b75e2"),
        archive: "tar.gz",
        strip: 1,
        executable: "cursor-agent",
      },
      "darwin-x64": {
        url: "https://downloads.cursor.com/lab/2026.11.22-e9042b2/darwin/x64/agent-cli-package.tar.gz",
        hash: sha256("16cc7314128243b24d74575cae5f7e1a215656d48115d55084e2d6725ef7c542"),
        archive: "tar.gz",
        strip: 1,
        executable: "cursor-agent",
      },
      "linux-x64": {
        url: "https://downloads.cursor.com/lab/2026.11.22-e9042b2/linux/x64/agent-cli-package.tar.gz",
        hash: sha256("7663b1c5d1b56e095ef8e23bef38d66df6cfd665c4873470214e0e411f0f97b3"),
        archive: "tar.gz",
        strip: 1,
        executable: "cursor-agent",
      },
      "linux-arm64": {
        url: "https://downloads.cursor.com/lab/2026.11.22-e9042b2/linux/arm64/agent-cli-package.tar.gz",
        hash: sha256("7b7dd0020fb9a2a9e1e7e3f39e2f9f512d1dd9577174ecda8aa82ac31dbc9565"),
        archive: "tar.gz",
        strip: 1,
        executable: "cursor-agent",
      },
    },
  },
  opencode: {
    version: "2.4.1",
    builds: {
      "darwin-arm64": {
        url: "https://github.com/sst/opencode/releases/download/v2.4.1/opencode-darwin-arm64.zip",
        hash: sha256("95a101eda95108478f1db43cff8fcbd4811f6c0e79af1e167301843c6a48d731"),
        archive: "zip",
        executable: "opencode",
      },
      "darwin-x64": {
        url: "https://github.com/sst/opencode/releases/download/v2.4.1/opencode-darwin-x64.zip",
        hash: sha256("a7a4c758a32488138531ab2d82be86e2a1438c35c017664f83daa1d5b63bb82c"),
        archive: "zip",
        executable: "opencode",
      },
      "linux-x64": {
        url: "https://github.com/sst/opencode/releases/download/v2.4.1/opencode-linux-x64.tar.gz",
        hash: sha256("9ddd18e3faf64eaeccf6a0fcbc96a5c7a14520ae5fd5b61e5be51d894f478b47"),
        archive: "tar.gz",
        executable: "opencode",
      },
      "linux-arm64": {
        url: "https://github.com/sst/opencode/releases/download/v2.4.1/opencode-linux-arm64.tar.gz",
        hash: sha256("cb28cf94541aeb62a4b2ea5997a99b5dd6bae595a772f36fbe279299f2032a4f"),
        archive: "tar.gz",
        executable: "opencode",
      },
      "linux-x64-musl": {
        url: "https://github.com/sst/opencode/releases/download/v2.4.1/opencode-linux-x64-musl.tar.gz",
        hash: sha256("3d8d0ba66d33e1631ebe61b5539cd2ef971a724ff68eb286554093bf55ba5c9f"),
        archive: "tar.gz",
        executable: "opencode",
      },
      "linux-arm64-musl": {
        url: "https://github.com/sst/opencode/releases/download/v2.4.1/opencode-linux-arm64-musl.tar.gz",
        hash: sha256("814d92dc6ce172a382090797df7072b7fe0f2840f2440838228196789c0e352f"),
        archive: "tar.gz",
        executable: "opencode",
      },
      "win32-x64": {
        url: "https://github.com/sst/opencode/releases/download/v2.4.1/opencode-windows-x64.zip",
        hash: sha256("831e00806531fabb184533ef85fead96eb92287cab2d0f21db7daaa494e75083"),
        archive: "zip",
        executable: "opencode.exe",
      },
      "win32-arm64": {
        url: "https://github.com/sst/opencode/releases/download/v2.4.1/opencode-windows-arm64.zip",
        hash: sha256("03ccc3d6a9b46ab082cbf7f5f86ff07c4bfcd7b802dbafe1614c257b1a96df8e"),
        archive: "zip",
        executable: "opencode.exe",
      },
    },
  },
  grok: {
    version: "1.0.92",
    builds: {
      "darwin-arm64": {
        url: "https://x.ai/cli/grok-1.0.92-macos-aarch64",
        hash: sha256("8b5f67b24f2cc9a4341d8e2eb7f67e3228d7d647ed04752a4f932f7133e5ab08"),
        archive: "file",
        executable: "grok",
      },
      "darwin-x64": {
        url: "https://x.ai/cli/grok-1.0.92-macos-x86_64",
        hash: sha256("66b7a3ef1d647280ac649b68d89b5a3d4800b1ae9df76707c011e2d400858ea9"),
        archive: "file",
        executable: "grok",
      },
      "linux-x64": {
        url: "https://x.ai/cli/grok-1.0.92-linux-x86_64",
        hash: sha256("add4d201dbf2c0bd6077a36feb55a76939de30bae48dbb06f16b2307d38ceacb"),
        archive: "file",
        executable: "grok",
      },
      "linux-arm64": {
        url: "https://x.ai/cli/grok-1.0.92-linux-aarch64",
        hash: sha256("8c74f1dc6cdc1befff6b9faada06bec4cf6759d04f2a60cdc28ece5ff696b44f"),
        archive: "file",
        executable: "grok",
      },
      "win32-x64": {
        url: "https://x.ai/cli/grok-1.0.92-windows-x86_64.exe",
        hash: sha256("060e51f93743b540e59c5cf9c81c0ce7b48b61c263f09235d981a6ababb1c9d7"),
        archive: "file",
        executable: "grok.exe",
      },
      "win32-arm64": {
        url: "https://x.ai/cli/grok-1.0.92-windows-aarch64.exe",
        hash: sha256("5fe563f7edb357a81d7f42022f5a23a471f43efbc62c5d595c592e0fe1c0b2f4"),
        archive: "file",
        executable: "grok.exe",
      },
    },
  },
  antigravity: {
    version: "1.5.14",
    builds: {
      "darwin-arm64": {
        url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/darwin-arm/cli_mac_arm64.tar.gz",
        hash: sha512(
          "26830fd46bfb9200d073cf3e71bf94b707552557b4380ec01afd6e99f3a2b030e65422dab1867f77318078692defc859a7547d17ec4b0b1e9369f13c9c3caea6",
        ),
        archive: "tar.gz",
        executable: "antigravity",
      },
      "darwin-x64": {
        url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/darwin-x64/cli_mac_x64.tar.gz",
        hash: sha512(
          "1b6a1fc6dbe46ba6d9d0405d1b6095189f35ebfc4c3c33ceb1fd1b6d0c9fd702b52ac10b64b8b52aed0d8d71ae02c5df3cffd5e3e3d37549c2daffcce2a853c7",
        ),
        archive: "tar.gz",
        executable: "antigravity",
      },
      "linux-x64": {
        url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/linux-x64/cli_linux_x64.tar.gz",
        hash: sha512(
          "83311d3f354567612dc16c1ae2ea9b503d6f6833aa4e138d39aa229da3f3bb99b0e4d7cca0bce4796b0060d6a51d8113eb7449ed5dc0e7900bf217107ea5bff9",
        ),
        archive: "tar.gz",
        executable: "antigravity",
      },
      "linux-arm64": {
        url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/linux-arm/cli_linux_arm64.tar.gz",
        hash: sha512(
          "c9b29bba475f63a1a80161ae93ba72b221c7a586d9851e4d0061546704bab66d6b2760b25d716d191724fc7564f3246456ee151e28aa37af48dbcd72bdc6c463",
        ),
        archive: "tar.gz",
        executable: "antigravity",
      },
      "linux-x64-musl": {
        url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/linux-x64-musl/cli_linux_x64_musl.tar.gz",
        hash: sha512(
          "1da24922727c5b4e84369d0843575d7d6f180a1946e2dc4289171ad1e3ca92594e687724d1902a7d83e407f98f0a8d3b7c3e976f03680fd80dbed2d2da00c0ed",
        ),
        archive: "tar.gz",
        executable: "antigravity",
      },
      "linux-arm64-musl": {
        url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/linux-arm-musl/cli_linux_arm64_musl.tar.gz",
        hash: sha512(
          "f6e35fc3dab2cd49fd4296ddee0841b9cc4c7020b6c6aaea6452c5b3452b0ad8d66451c9098e418ad6b2f6eabcc81cdf13105ed043903248b11d6fb24ae709ab",
        ),
        archive: "tar.gz",
        executable: "antigravity",
      },
    },
  },
};

/** This system's name in the pins (`darwin-arm64`, `linux-x64-musl`…); null: a system no CLI is pinned for. */
export function pinPlatformOf(platform: string, arch: string, musl: boolean): PinPlatform | null {
  const cpu = arch === "x64" || arch === "amd64" ? "x64" : arch === "arm64" || arch === "aarch64" ? "arm64" : null;
  if (!cpu) return null;
  if (platform === "darwin") return `darwin-${cpu}`;
  if (platform === "linux") return musl ? `linux-${cpu}-musl` : `linux-${cpu}`;
  if (platform === "win32") return `win32-${cpu}`;
  return null;
}

/** The person's own copy runs when it is at the pinned version or newer (a line with no version never does). */
export const ownCopyServes = (pin: CliPin, versionLine: string | null | undefined) =>
  cliVersionAtLeast(versionLine, pin.version) === true;

const HEX = { sha256: /^[0-9a-f]{64}$/, sha512: /^[0-9a-f]{128}$/ } as const;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SAFE_PATH = /^(?!\/)(?!.*\.\.)[\w.@/-]{1,120}$/;

/**
 * A pin list as the runner takes it from the wire: https addresses only, a well-formed hash, a relative program path
 * with no `..`. A CLI or build that doesn't pass is left out; null when nothing does.
 */
export function parseCliPins(v: unknown): Partial<CliPins> | null {
  if (!isObj(v)) return null;
  const out: Partial<CliPins> = {};
  for (const cli of PIN_CLIS) {
    const pin = v[cli];
    if (!isObj(pin) || typeof pin.version !== "string" || !/^[\w.+-]{1,60}$/.test(pin.version)) continue;
    if (!isObj(pin.builds)) continue;
    const builds: CliPin["builds"] = {};
    for (const platform of PIN_PLATFORMS) {
      const b = pin.builds[platform];
      if (!isObj(b) || typeof b.url !== "string" || !b.url.startsWith("https://") || b.url.length > 500) continue;
      const hash = b.hash;
      if (!isObj(hash) || (hash.algorithm !== "sha256" && hash.algorithm !== "sha512")) continue;
      if (typeof hash.value !== "string" || !HEX[hash.algorithm].test(hash.value)) continue;
      if (b.archive !== "file" && b.archive !== "tar.gz" && b.archive !== "zip") continue;
      if (typeof b.executable !== "string" || !SAFE_PATH.test(b.executable)) continue;
      const strip = typeof b.strip === "number" && Number.isInteger(b.strip) && b.strip >= 0 && b.strip <= 3;
      builds[platform] = {
        url: b.url,
        hash: { algorithm: hash.algorithm, value: hash.value },
        archive: b.archive,
        executable: b.executable,
        ...(strip ? { strip: b.strip as number } : {}),
      };
    }
    if (Object.keys(builds).length) out[cli] = { version: pin.version, builds };
  }
  return Object.keys(out).length ? out : null;
}
