import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next from "i18next";
import { ApiError } from "../src/api/http";
import { errorText } from "../src/lib/errors";
import {
  BLANK_HEADER,
  type HeaderRow,
  headerRefusal,
  headerRefused,
  headersToSend,
  typedHeaders,
} from "../src/lib/request-headers";

const ptBR = i18next.createInstance();
void ptBR.init({ lng: "pt-BR", fallbackLng: "en", resources, initAsync: false });

describe("the request headers a connect form sends", () => {
  const blank = { name: " ", value: "" };
  const key = { name: " X-API-Key ", value: " fake-value " };

  test("a row left blank is no header; a row with only one of the two still goes, for the server to refuse", () => {
    expect(typedHeaders([blank, key, { name: "", value: "v" }, { name: "X-Tenant", value: "" }])).toHaveLength(3);
  });

  test("typed ones go (names trimmed, values as typed), else none any more, else nothing is said", () => {
    expect(headersToSend([blank, key], false)).toEqual([{ name: "X-API-Key", value: " fake-value " }]);
    expect(headersToSend([blank, key], true)).toEqual([{ name: "X-API-Key", value: " fake-value " }]);
    expect(headersToSend([blank], true)).toEqual([]);
    expect(headersToSend([blank], false)).toBeUndefined();
  });
});

describe("a server's refusal of a header", () => {
  const refusal = (code: string, params?: Record<string, unknown>) => new ApiError(400, code, "refused", params);

  test("which header, and which of its two fields", () => {
    expect(headerRefusal(refusal("connector.header_value", { header: "X-Tenant", index: 2 }))).toEqual({
      index: 2,
      field: "value",
    });
    expect(headerRefusal(refusal("connector.header_twice", { header: "X-Tenant", index: 0 }))).toEqual({
      index: 0,
      field: "name",
    });
    expect(headerRefusal(refusal("connector.headers_with_sign_in"))).toEqual({ index: null, field: "name" });
  });

  test("any other failure is not one", () => {
    expect(headerRefusal(refusal("connector.key_too_short"))).toBeNull();
    expect(headerRefusal(new Error("offline"))).toBeNull();
  });

  test("it shows on the row it names, counted among the rows that say something", () => {
    const rows: HeaderRow[] = [
      BLANK_HEADER,
      { id: 3, name: "X-API-Key", value: "fake-value" },
      { id: 5, name: "X-Tenant", value: "" },
    ];
    const sent = headersToSend(rows, false);
    expect(sent).toEqual([
      { name: "X-API-Key", value: "fake-value" },
      { name: "X-Tenant", value: "" },
    ]);
    const empty = refusal("connector.header_value", { header: "X-Tenant", index: 1 });
    expect(headerRefused(rows, sent, empty)).toEqual({ row: 5, field: "value", error: empty });
    const twice = refusal("connector.header_twice", { header: "X-API-Key", index: 0 });
    expect(headerRefused(rows, sent, twice)).toEqual({ row: 3, field: "name", error: twice });
    // About them all: under the rows.
    const signIn = refusal("connector.headers_with_sign_in");
    expect(headerRefused(rows, sent, signIn)).toEqual({ row: null, field: "name", error: signIn });
  });

  test("Reconectar with the saved ones kept: a refusal of one of them goes under the rows, on no typed row", () => {
    // Untouched, the request carries no list, so the saved ones stay.
    expect(headersToSend([], false)).toBeUndefined();
    expect(headersToSend([BLANK_HEADER], false)).toBeUndefined();
    expect(headersToSend([], true)).toEqual([]);
    const reserved = refusal("connector.header_reserved", { header: "Host", index: 0 });
    expect(headerRefused([BLANK_HEADER], undefined, reserved)?.row).toBeNull();
    // The saved ones couldn't be read at all: about them all, under the rows.
    const unreadable = refusal("connector.headers_unreadable");
    expect(headerRefused([], undefined, unreadable)).toEqual({ row: null, field: "name", error: unreadable });
    expect(headerRefused([BLANK_HEADER], undefined, refusal("connector.unavailable"))).toBeNull();
    expect(headerRefused([BLANK_HEADER], undefined, new Error("offline"))).toBeNull();
  });

  test("each code in the person's words, with the header's name and the way out", () => {
    const said = (code: string, params?: Record<string, unknown>) => errorText(ptBR.t, refusal(code, params), "pt-BR");
    expect(said("connector.header_reserved", { header: "Host", index: 0 })).toBe(
      "Host já é enviado em toda requisição e não dá para trocar. Remova este cabeçalho.",
    );
    expect(said("connector.headers_too_many", { max: 10 })).toBe(
      "Um servidor aceita no máximo 10 cabeçalhos. Remova um para adicionar outro.",
    );
    expect(said("connector.header_name", { header: "X Key", index: 0 })).toBe(
      "Use só letras, números e hífens no nome do cabeçalho, como em X-API-Key.",
    );
    expect(said("connector.headers_unreadable")).toBe(
      "Não deu para ler os cabeçalhos salvos. Digite de novo, ou remova.",
    );
  });
});
