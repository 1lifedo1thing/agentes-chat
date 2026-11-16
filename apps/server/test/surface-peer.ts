/**
 * A whole server with the chat surface bridge on, for a surface service's end-to-end test (ADR 0187): run it with
 * `bun apps/server/test/surface-peer.ts`. In-memory database, the fake model (the right hand answers
 * "Got it: <the person's last line>"), a fake speech service, and one account (owner@example.com) with a workspace
 * whose right hand has an AI. It prints one JSON line, `{ appUrl, bridgeUrl, token, cookie, orgId }`, then serves
 * until killed, running due jobs every 200 ms. Not a test file: it imports only test helpers.
 */
import { setSurface, surfaceFromConfig } from "@agenteschat/engine";
import { type ModelRequest, textOf } from "@agenteschat/providers";
import { createLogger } from "../src/logger";
import { operatorFetch } from "../src/operator/app";
import { browser, createTestServer, listen, signUp } from "./harness";

// Low entropy on purpose: a test value, never a real deployment's.
const token = process.env.PEER_BRIDGE_TOKEN ?? "surface-peer-test-token-".padEnd(48, "0");

/** The person's last line in the model's view of the conversation. */
const lastLine = (request: ModelRequest) => {
  const last = [...request.messages].reverse().find((m) => m.role === "user");
  const text = last ? textOf(last.content).trim() : "";
  // Without the "[name]: " the conversation puts before each person's line.
  return (text.split("\n").at(-1) ?? "").replace(/^\[[^\]]*\]:\s*/, "").trim();
};

const t = await createTestServer({
  env: {
    ALLOW_SIGNUP: "true",
    SURFACE_BRIDGE_TOKEN: token,
    SURFACE_NAME: "Test chat",
    SURFACE_OPEN_URL: "https://chat.example.com/open?text={text}",
    GROQ_API_KEY: "groq-key-example",
  },
  reply: (request) => ({ chunks: [`Got it: ${lastLine(request)}`] }),
  speechFetch: (async () => Response.json({ text: "A voice note" })) as unknown as typeof fetch,
});
setSurface(surfaceFromConfig(t.config));

const owner = browser(t);
await signUp(owner, "owner@example.com");
const created = await owner("/api/app/organizations", {
  json: { name: "Example Co", context: "Example Co sells tea." },
});
const orgId = ((await created.json()) as { organization: { id: string } }).organization.id;
const credential = await owner(`/api/app/organizations/${orgId}/credentials`, {
  json: { provider: "anthropic", label: "main", apiKey: "sk-ant-api-example-0000" },
});
if (credential.status !== 201) throw new Error(`credential not saved: ${credential.status}`);

const app = listen(t);
const bridgeFetch = operatorFetch({
  db: t.db,
  config: t.config,
  version: "peer",
  log: createLogger("error"),
  surface: t.services,
});
if (!bridgeFetch) throw new Error("the bridge did not start");
const bridge = Bun.serve({ port: 0, hostname: "127.0.0.1", maxRequestBodySize: 101 * 1024 * 1024, fetch: bridgeFetch });

let draining = false;
setInterval(async () => {
  if (draining) return;
  draining = true;
  try {
    await t.drain();
  } catch (error) {
    console.error("drain failed", error);
  } finally {
    draining = false;
  }
}, 200);

console.log(
  JSON.stringify({
    appUrl: `http://127.0.0.1:${app.port}`,
    bridgeUrl: `http://127.0.0.1:${bridge.port}`,
    token,
    cookie: owner.cookie(),
    orgId,
  }),
);
