# 0186. Request headers for a server by address

- Status: Accepted
- Date: 2026-11-14
- Code: engine `packages/engine/src/connectors/request-headers.ts` (`checkRequestHeaders`), `connections.ts`
  (`ConnectionSecret.headers`, `secretHeaders`, `connectionHeaders`), `custom.ts` (`connectCustomServer`,
  `storeCustomConnection`, `CustomServerView.headerNames`), `oauth-mcp.ts` (`probeMcpServer`); schema
  `packages/db/src/schema/connectors.ts` (`header_names`, migration 0274); route
  `apps/server/src/routes/app/connectors-custom.ts`; client `packages/client/src/api/{types,client}.ts`; tests
  `packages/engine/test/connector-headers.test.ts`, `apps/server/test/connectors.test.ts`

## Context

A workspace connects an MCP server by address (ADR 0016) with nothing, with one key sent as
`Authorization: Bearer <key>`, or with the server's own sign-in. That leaves out servers that are otherwise ordinary:
one that wants its key in a header of its own (`X-API-Key`), one that wants another scheme
(`Authorization: Token …`), and one behind a gateway that asks for headers before a request reaches the server at
all. None of them could be connected.

## Decision

An admin may type request headers for a server by address. They are sent with every request to that server.

1. **Where they are kept.** The values live in the connection's sealed secret (`ConnectionSecret.headers`, names as
   typed), beside the key or the tokens, under the same envelope encryption. No API returns them, and no log line,
   error, audit row or tool error holds one. The names alone are also kept readable, in `header_names` on
   `connector_connections`, in the order typed.

   Why the names and not the values: a screen has to say what a server is sent ("also sends: X-API-Key") and what
   Reconectar will keep, and a listing never opens a secret. A header's name says how a server is reached, as its
   address does; its value is the credential. The names go to whoever manages connectors, as the whole address
   does; another member's listing has none.

2. **Where they go.** Only to the connection's own address, on the MCP transport's requests and on the one request
   that asks a server who it is when it is connected without a key. A redirect is followed only while it stays on
   the server's origin (`outboundFetch`'s `ownRedirects` where the address is pinned, the MCP transport's own rule
   where it isn't), so they never reach another host. They never go to a protected resource's or an authorization
   server's metadata, to a client registration, to a token endpoint (the exchange or a refresh), to a server's icon,
   to a provider's own API, or to Composio.

   One function builds what a stored secret sends, `secretHeaders`: the typed headers, then the key's or the
   sign-in's `authorization` on top. Everything that talks to a stored connection goes through it
   (`connectionHeaders`: tool calls, the tool listing, the account a connection reaches, a routine's connector
   event), and so do the two requests made before a connection is stored.

3. **What is accepted.** One validator, `checkRequestHeaders`, in the engine:

   - at most 10 headers;
   - a name is an HTTP token of 1 to 64 characters; a value is 1 to 2,000 characters once the spaces around it are
     cut, of tab and printable ASCII only, so it can't hold a line break;
   - a name can't be there twice, in any case;
   - names the HTTP client or the MCP transport set for every request are refused: `Host`, `Content-Length`,
     `Content-Type`, `Accept`, `Connection`, `Keep-Alive`, `Transfer-Encoding`, `Upgrade`, `TE`, `Trailer`,
     `Proxy-Authorization`, `Proxy-Connection`, `Mcp-Session-Id`, `Mcp-Protocol-Version`, `Last-Event-ID`;
   - `Authorization` may be typed when no key is (another scheme), and is refused beside a key, which is sent as
     that header.

   Each refusal is a 400 with its own code and `params` that name the header (`header`) and its place in the list
   (`index`), never its value: `connector.header_name`, `connector.header_value`, `connector.header_reserved`,
   `connector.header_twice`, `connector.header_and_key`, and `connector.headers_too_many`.

4. **Connecting.** `POST …/connectors/custom` takes `headers: [{ name, value }]`.

   - With a key: both are stored, and the server is not asked first, as before.
   - Without a key: the server is asked with the headers. One that answers is connected by them alone, as
     `api_key` (it holds a secret a person typed, and a later 401 asks for Reconectar the same way). One that
     refuses still answers `needs_key`. One that asks for a sign-in is refused, `connector.headers_with_sign_in`: a
     sign-in's token would be stored in their place, and they would be gone without a word.
   - A service through Composio, and a server that only signs in on the Cloud (ADR 0107), refuse headers as they
     refuse a key (`connector.oauth_only`).
   - Reconectar (`connectionId`): no `headers` keeps the ones the account has, whatever else changes; `[]` removes
     them; a list replaces them all. The account's secret is opened only in the first case, and only when its row
     names headers. An account that keeps an `Authorization` header can't take a key until that header is replaced
     or removed.

5. **What screens get.** `CustomServer.headerNames`, empty when there are none. A value can't be read back: to
   change one, the person types the list again.

## Not built

- Headers together with a server's own sign-in.
- Headers for a catalog connector.
- Headers per agent.
- Values built from templates.

## Consequences

- Connections made before this have no headers and send what they sent. The migration adds one nullable column.
- A token refresh writes the new tokens over the old ones and keeps whatever else the secret holds, so a secret
  with both would keep its headers, though nothing stores one yet.
- The audit log's rows for connecting and reconnecting are as before: they name the server and how it signs in,
  not its headers.
