/** How a credential's name ends where a shell or a header writes it (`PASSWORD=`, `x-api-key:`). */
const NAME = "password|passwd|secret|token|api[_-]?key";
/**
 * How a field's own name ends when its value is a credential: `NAME`'s words, and those that are prose anywhere but
 * in a field's name (`Authorization`, `Set-Cookie`). Never a plural, which is how a count is named (`max_tokens`),
 * nor a page cursor (`next_page_token`).
 */
const FIELD = `(?:${[
  "pass(?:word|wd|phrase)",
  "secret(?:[_-]?(?:access[_-]?)?key)?",
  "(?<!(?:page|next|prev(?:ious)?|continuation|cursor|sync)[_-]?)token",
  "api[_-]?key",
  "private[_-]?key",
  "authorization",
  "cookie",
].join("|")})`;
const FIELD_NAME = new RegExp(`${FIELD}$`, "i");

/**
 * A quoted value, whole, however many times the text it sits in was itself written as a JSON string: each time
 * doubles the backslashes before a quote and adds one. So the value ends at the quote with as many backslashes as
 * the one that opened it (or that many and escaped backslashes of its own), or with fewer: the string around it
 * ended first. One with no such end is masked as far as its next quote, an unquoted value up to its first space.
 * `group` is the number of its first capturing group.
 */
function valueAt(group: number) {
  const [slashes, quote] = [`\\${group}`, `\\${group + 1}`];
  const quoted = String.raw`(\\*)(["'])[\s\S]*?(?<!\\)(?:${slashes}(?:${slashes}${slashes}\\\\)*|(?!${slashes})\\*)${quote}`;
  return String.raw`(?:${quoted}|"[^"]*"|'[^']*'|\S+)`;
}

/** What stands between a name and its value: `=` or `:`, also as an address writes them (`%3D`). */
const IS = "(?:[=:]|%(?:25)*3[AD])";
/**
 * `password=…`, `token: …`: the value up to its first space, or a quoted one whole. A name with nothing after it on
 * its line takes the next line as its value, unless that line names a credential of its own: masking that name
 * would leave its value.
 */
const NAMED_VALUE = new RegExp(
  String.raw`((?:${NAME})\s*${IS}(?:[^\S\n]*(?=\S)|\s*(?![\w.-]*(?:${NAME})\s*${IS})))${valueAt(2)}`,
  "gi",
);
/**
 * `"password": "…"`, as JSON, a Python dict or a Ruby hash writes a field: only a text, and never an empty one. A
 * number, `true`, `false` or `null` under such a name is no credential.
 */
const FIELD_VALUE = new RegExp(
  String.raw`(${FIELD}\\*["']\s*(?:=>?|:)\s*)(?=\\*["'])(?!(\\*)(["'])\2\3)${valueAt(4)}`,
  "gi",
);
/** The same field with its quotes written out: percent-encoded in an address, an HTML entity, a log's code point. */
const WRITTEN_QUOTE = String.raw`%(?:25)*2[27]|&(?:amp;)*(?:quot|apos|#0*3[49]|#x0*2[27]);|\\+(?:u00|x)2[27]`;
const WRITTEN_GAP = String.raw`(?:\s|\+|%(?:25)*20)*`;
const WRITTEN_FIELD_VALUE = new RegExp(
  String.raw`(${FIELD}(${WRITTEN_QUOTE})${WRITTEN_GAP}(?::|%(?:25)*3A)${WRITTEN_GAP})\2(?!\2)(?:[\s\S]*?(?<!\\|%(?:25)*5C)\2|\S*)`,
  "gi",
);

/**
 * Masks what looks like a credential in free text that leaves its place (the runner's diagnostics and
 * activity log, the operator API's review block): machine tokens, bearer headers, common API key shapes,
 * `password=`/`token:` values, and a field named for a credential as JSON writes it (`"password": "…"`), at any
 * depth of JSON inside a JSON string. The agent's own secrets are masked by their values (ADR 0027) before this.
 */
export function redactCommon(text: string): string {
  return text
    .replace(/\bagm_[A-Za-z0-9_-]{6,}/g, "agm_***")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
    .replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{12,})/g, "sk-***")
    .replace(/\b(gh[pousr]_[A-Za-z0-9._-]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "gh_***")
    .replace(/\b(xox[abposr]-[A-Za-z0-9-]{10,})/g, "xox-***")
    .replace(/\b(AKIA[0-9A-Z]{16})\b/g, "AKIA***")
    .replace(FIELD_VALUE, "$1***")
    .replace(WRITTEN_FIELD_VALUE, "$1***")
    .replace(NAMED_VALUE, "$1***");
}

/**
 * A value with every text under a field named for a credential masked, at any depth: in text, a value with spaces
 * is masked only up to its first space. A number, `true`, `false` or `null` stays: it is a count or a switch.
 */
export function maskSecretFields(value: unknown, named = false): unknown {
  if (typeof value === "string") return named && value ? "***" : value;
  if (Array.isArray(value)) return value.map((v) => maskSecretFields(v, named));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [key, maskSecretFields(v, named || FIELD_NAME.test(key))]),
  );
}

/** A field holding a service's own credential (`access_token`, a Page's `page_access_token`), never a page cursor. */
const TOKEN_FIELD = /(^|_)(access|refresh)_?token$/i;

/**
 * An answer without its credential fields, at any depth: Facebook lists a person's Pages with each Page's access
 * token, which would let an agent act around its approvals.
 */
export function withoutTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTokens);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, v]) => (TOKEN_FIELD.test(key) ? [] : [[key, withoutTokens(v)]])),
  );
}

/**
 * A crash's stack frame (`at fn (/x/y.js:1:2)`, `at /x/y.js:1:2`) or the Node.js version line it ends with. No
 * leading `\s*`: before a word boundary it backtracks over every run of spaces (quadratic on output full of them),
 * and what it would take is trimmed with the line anyway.
 */
const STACK_FRAME = /\bat (?:async |new )?(?:[^\s()]+ \([^)]*\)|\/\S+|file:\/\/\S+|node:\S+)|\bNode\.js v[\d.]+/g;
/** A line that names what went wrong (`Error: …`, `TypeError: …`, `ENOSPC: …`, `error: …`). */
const ERROR_LINE = /(?:\w*Error|\bE[A-Z]{3,}|\berror)\b:/;

/**
 * The line of a command-line tool's output that says what went wrong: its last line naming an error, else its last
 * line, without the stack frames and the Node.js version a crash ends with. Empty when it said nothing else.
 */
export function errorLineOf(output: string): string {
  const lines = output
    .replace(STACK_FRAME, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.filter((l) => ERROR_LINE.test(l)).at(-1) ?? lines.at(-1) ?? "";
}

/** `text` in at most `max` characters: when longer, cut after its last whole word, with "…". */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "");
  const space = head.lastIndexOf(" ");
  return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
}
