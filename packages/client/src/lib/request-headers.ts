import { ApiError } from "../api/http";
import type { RequestHeader } from "../api/types";

/** Mirror: `MAX_REQUEST_HEADERS` in packages/engine/src/connectors/request-headers.ts. */
export const MAX_REQUEST_HEADERS = 10;

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
