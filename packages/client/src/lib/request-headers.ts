import { ApiError } from "../api/http";
import type { RequestHeader } from "../api/types";

/** Mirror: `MAX_REQUEST_HEADERS` in packages/engine/src/connectors/request-headers.ts. */
export const MAX_REQUEST_HEADERS = 10;

/** Mirror: the most characters `NAME` takes in packages/engine/src/connectors/request-headers.ts. */
export const MAX_HEADER_NAME = 64;

/** A header's name as an example in its field: a name is the same in every language. */
export const HEADER_NAME_EXAMPLE = "X-API-Key";

/** The rows that say something: one left blank is no header. */
export const typedHeaders = <T extends RequestHeader>(rows: readonly T[]): T[] =>
  rows.filter((row) => row.name.trim() !== "" || row.value.trim() !== "");

/**
 * What a connect request says about headers: the typed ones (they replace the saved ones), `[]` to send none any
 * more, or nothing, which keeps what the account has.
 */
export const headersToSend = (rows: readonly RequestHeader[], dropSaved: boolean): RequestHeader[] | undefined => {
  const typed = typedHeaders(rows).map(({ name, value }) => ({ name: name.trim(), value }));
  return typed.length > 0 ? typed : dropSaved ? [] : undefined;
};

/**
 * A server's refusal of the headers sent to it (`connector.header_*`, `connector.headers_*`), else null. `index`: the
 * refused header's place in the list sent, or in the saved names when none was sent. Null when it is about them all.
 * `field`: which of the two it is about.
 */
export function headerRefusal(error: unknown): { index: number | null; field: "name" | "value" } | null {
  if (!(error instanceof ApiError) || !/^connector\.headers?_/.test(error.code)) return null;
  const index = error.params?.index;
  return {
    index: typeof index === "number" ? index : null,
    field: error.code === "connector.header_value" ? "value" : "name",
  };
}

/** A row of the request headers form. `id` keeps its fields and its refusal with it when another row goes. */
export interface HeaderRow extends RequestHeader {
  id: number;
}
export const BLANK_HEADER: HeaderRow = { id: 0, name: "", value: "" };

/** The server's refusal of a header: on the row it names (`row`, its id), else under them all. */
export interface HeaderRefused {
  row: number | null;
  field: "name" | "value";
  error: unknown;
}

/**
 * Where a failed connect shows when it is the server refusing the request headers, else null. `sent`: the list the
 * request carried, or none when the saved ones were kept. A typed header is refused on its own row. One of the saved
 * ones, or all of them together, under the rows.
 */
export function headerRefused(
  rows: readonly HeaderRow[],
  sent: readonly RequestHeader[] | undefined,
  error: unknown,
): HeaderRefused | null {
  const refusal = headerRefusal(error);
  if (!refusal) return null;
  const row = sent?.length && refusal.index !== null ? typedHeaders(rows)[refusal.index]?.id : undefined;
  return { row: row ?? null, field: refusal.field, error };
}
