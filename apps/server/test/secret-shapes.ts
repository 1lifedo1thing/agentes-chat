/**
 * Records that hold a credential below their top level, where JSON writes a line end, a tab and a quote as
 * backslashes and a rule for text reads one long word. Wherever such a record is read out as text, `HIDDEN` is gone
 * and what the shape names stays.
 */
export const HIDDEN = ["fake-first-value", "fake-second-value"] as const;
const [first, second] = HIDDEN;

export const SECRET_SHAPES: [shape: string, record: Record<string, unknown>, stays: string[]][] = [
  [
    "a file's lines",
    { file: { path: "config.yml", content: `token: ${first}\npassword: ${second}\nport: 1` } },
    ['"path":"config.yml"', String.raw`"content":"token: ***\npassword: ***\nport: 1"`],
  ],
  [
    "headers as one text",
    { req: { raw: `x-api-key: ${first}\r\nx-auth-token: ${second}\r\n` } },
    [String.raw`"x-api-key: ***\r\nx-auth-token: ***\r\n"`],
  ],
  [
    "a tab between two",
    { req: { raw: `token: ${first}\tpassword: ${second}` } },
    [String.raw`"token: ***\tpassword: ***`],
  ],
  [
    "an env file in a list",
    { files: [{ path: ".env", content: `API_TOKEN = ${first}\nDB_PASSWORD = ${second}\n` }] },
    ['"path":".env"', String.raw`"content":"API_TOKEN = ***\nDB_PASSWORD = ***\n"`],
  ],
  ["an option's value", { exec: { args: `--password ${first} -u ana` } }, ["--password *** -u ana"]],
  [
    "an option's quoted value",
    { exec: { command: `mysql --password "${first} ${second}" -u ana` } },
    ["mysql --password *** -u ana"],
  ],
  // A written line end between a name and its value hides the value from a rule that reads the record as JSON.
  [
    "a value on the line after its name",
    { config: { yaml: `password:\n  ${first}\nport: 1` } },
    [String.raw`"yaml":"password:\n  ***\nport: 1"`],
  ],
  // A text that holds a record of its own and is not one: each of its strings ends at its closing quote.
  [
    "a log line that quotes a record",
    {
      path: "app.log",
      content: `12:00:01 INFO sent {"lines":["token: ${first}","password: ${second}"]}\n12:00:02 INFO ok\n`,
    },
    ["token: ***", "password: ***", "12:00:02 INFO ok"],
  ],
  [
    "a command that sends a record",
    { command: `curl -d '{"a":"token: ${first}","b":"password: ${second}"}' https://example.com` },
    ["token: ***", "password: ***", "https://example.com"],
  ],
  // A number after an option named in the plural sets a count; any other text there is a credential.
  [
    "a count given as an option",
    {
      command: `llm --max-tokens 4096 --tokens ${first} -m x`,
      argv: ["llm", "--max-tokens", "4096", "--api-keys", second],
    },
    ["llm --max-tokens 4096 --tokens *** -m x", '"--max-tokens","4096","--api-keys","***"'],
  ],
  // Three shapes only a record can tell.
  [
    "a list of arguments",
    { argv: ["mysql", "--password", first, "--verbose", "-u", "ana"] },
    ['"--password","***","--verbose","-u","ana"'],
  ],
  [
    "a pair of name and value",
    {
      headers: [
        ["x-api-key", first],
        ["accept", "text/plain"],
      ],
    },
    ['["x-api-key","***"],["accept","text/plain"]'],
  ],
  // A list of two texts is a name and its value only in a list of such lists: alone it is two names.
  [
    "lists of names",
    {
      required: ["password", "email"],
      sort: ["token", "asc"],
      labels: ["secret", "ops"],
      allowedHeaders: ["Authorization", "Content-Type"],
    },
    ['["password","email"]', '["token","asc"]', '["secret","ops"]', '["Authorization","Content-Type"]'],
  ],
  [
    "a table's columns",
    {
      columns: [
        ["password", "character varying"],
        ["api_key", "text"],
      ],
    },
    ['[["password","***"],["api_key","***"]]'],
  ],
  [
    "a record that names its value",
    {
      headers: [
        { name: "Authorization", value: first },
        { key: "Cookie", value: second },
        { name: "Accept", value: "text/plain" },
      ],
    },
    ['"name":"Authorization","value":"***"', '"key":"Cookie","value":"***"', '"name":"Accept","value":"text/plain"'],
  ],
];

/**
 * Text that holds a record and can't be opened as one: a message quoting it, a result with words before it, a result
 * cut off. An unquoted value in one of its strings ends at that string's closing quote, and the next string's is
 * read on its own.
 */
export const UNOPENED: [shape: string, text: string, stays: string[]][] = [
  [
    "an edit, quoted",
    `it sent {"path":"config.yml","old_string":"password: ${first}","new_string":"password: ${second}"} and failed`,
    ['"old_string":"password: ***","new_string":"password: ***"} and failed'],
  ],
  [
    "a list of arguments, quoted",
    `ran ["curl","-H","X-Api-Key: ${first}","-H","X-Auth-Token: ${second}","https://example.com"]`,
    ['"-H","X-Api-Key: ***","-H","X-Auth-Token: ***","https://example.com"]'],
  ],
  [
    // A step keeps a tool's result as text, its first 4,000 characters: a long one that is JSON ends before its end.
    "a result cut off",
    JSON.stringify({
      matches: [
        { file: "config/a.yml", line: `password: ${first}` },
        { file: "config/b.yml", line: `token: ${second}` },
        ...Array.from({ length: 80 }, (_, n) => ({ file: `config/${n}.yml`, line: `port: ${n} of the lines found` })),
      ],
    }).slice(0, 4000),
    ['"line":"password: ***"},{"file":"config/b.yml","line":"token: ***"},{"file":"config/0.yml"'],
  ],
  [
    "a result with words before it",
    `exit 0\n{"stdout":"token: ${first}","stderr":"password: ${second}"}`,
    ['{"stdout":"token: ***","stderr":"password: ***"}'],
  ],
];

/** What a text shows of `HIDDEN`, and what it lacks of what stays. */
export const shownIn = (text: string, stays: string[]) => ({
  shows: HIDDEN.filter((value) => text.includes(value)),
  lacks: stays.filter((value) => !text.includes(value)),
});
