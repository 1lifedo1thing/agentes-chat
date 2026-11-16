import { expect, test } from "bun:test";
import { errorLineOf, maskSecretFields, redactCommon } from "../src/redact";

test("a crash's error line, without its stack frames or the Node.js version it ends with", () => {
  const crash = [
    "node:internal/modules/cjs/loader:1228",
    "  throw err;",
    "  ^",
    "",
    "Error: Cannot find module '/x/cli.js'",
    "    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)",
    "    at /usr/lib/node_modules/x/cli.js:1:2",
    "    at file:///usr/lib/x.mjs:3:4",
    "",
    "Node.js v22.1.0",
  ].join("\n");
  expect(errorLineOf(crash)).toBe("Error: Cannot find module '/x/cli.js'");
  expect(errorLineOf("TypeError: boom    at f (/a/b.js:1:2)")).toBe("TypeError: boom");
  expect(errorLineOf("just one line\n")).toBe("just one line");
  expect(errorLineOf("")).toBe("");
});

test("output full of spaces is read in linear time", () => {
  const spaces = " ".repeat(200_000);
  const started = performance.now();
  expect(errorLineOf(`${spaces}x${spaces}`)).toBe("x");
  expect(errorLineOf(`Error: late${"\n ".repeat(50_000)}at`)).toBe("Error: late");
  expect(performance.now() - started).toBeLessThan(1000);
});

test("a credential is masked as JSON writes it too, and a field named for one whatever it holds", () => {
  const json = [
    '{"user":"ana","password":"hunter2-fake"}',
    '{"x-api-key": "fake-header-key", "client_secret":"fake \\" secret"}',
    '{"access_token":"fake-access","refresh_token":"fake-refresh","max_tokens":4096}',
    "password=hunter2-fake token: 'a b' tokens: 12",
  ].join("\n");
  expect(redactCommon(json)).toBe(
    [
      '{"user":"ana","password":***}',
      '{"x-api-key": ***, "client_secret":***}',
      '{"access_token":***,"refresh_token":***,"max_tokens":4096}',
      "password=*** token: *** tokens: 12",
    ].join("\n"),
  );
  // In text a value is masked up to its first space: by its field, all of it, at any depth.
  expect(
    maskSecretFields({
      q: "launch",
      password: "correct horse fake",
      auth: { username: "ana", accessToken: { value: "a b" } },
      headers: [{ "x-api-key": "fake-key" }, { Authorization: "fake raw value", Cookie: "session=fake" }],
      env: { AWS_SECRET_ACCESS_KEY: "fake-aws-secret" },
    }),
  ).toEqual({
    q: "launch",
    password: "***",
    auth: { username: "ana", accessToken: "***" },
    headers: [{ "x-api-key": "***" }, { Authorization: "***", Cookie: "***" }],
    env: { AWS_SECRET_ACCESS_KEY: "***" },
  });
  expect(maskSecretFields("password: x")).toBe("password: x");
});
