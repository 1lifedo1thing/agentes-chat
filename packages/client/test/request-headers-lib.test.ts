import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next from "i18next";
import { ApiError } from "../src/api/http";
import { errorText } from "../src/lib/errors";
import { headerRefusal, headersToSend, typedHeaders } from "../src/lib/request-headers";

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
  });
});
