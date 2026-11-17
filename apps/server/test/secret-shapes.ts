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

/** What a text shows of `HIDDEN`, and what it lacks of what stays. */
export const shownIn = (text: string, stays: string[]) => ({
  shows: HIDDEN.filter((value) => text.includes(value)),
  lacks: stays.filter((value) => !text.includes(value)),
});
