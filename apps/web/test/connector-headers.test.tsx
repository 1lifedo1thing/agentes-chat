import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, type CustomConnectStart } from "@agenteschat/client";
import { MAX_REQUEST_HEADERS } from "@agenteschat/client/lib/request-headers";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { openConnected, pick, rowMenu } from "./catalog";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle, showIn } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const snapshot = () => (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
/** The request headers' disclosure: the second one, under the key's. */
const disclosure = () => flow().querySelectorAll("details.cflow__more")[1] as HTMLDetailsElement;
const nameField = (n: number) => within(flow()).getByLabelText(`Nome do cabeçalho ${n}`) as HTMLInputElement;
const valueField = (n: number) => within(flow()).getByLabelText(`Valor do cabeçalho ${n}`) as HTMLInputElement;
const add = () => within(flow()).getByRole("button", { name: "Adicionar cabeçalho" }) as HTMLButtonElement;
const header = async (n: number, name: string, value: string) => {
  await type(nameField(n), name);
  await type(valueField(n), value);
};
const connectCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "customConnectors.connect").map((c) => c.args[1] as Record<string, unknown>);

const ADDRESS = "https://mcp.example.com/mcp";
/** "Adicionar MCP" with an address and a name typed, the headers open. */
async function openForm(state = seedState(), api = createFakeApi(state)) {
  const app = await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
  await settle(8);
  await click(within(screen().getByRole("region", { name: "MCPs" })).getByRole("button", { name: "Adicionar MCP" }));
  await type(within(flow()).getByLabelText("Endereço do servidor MCP"), ADDRESS);
  await type(within(flow()).getByLabelText("Nome"), "Suporte");
  expect(disclosure().hasAttribute("open")).toBe(false);
  await click(within(flow()).getByText("Cabeçalhos da requisição"));
  return { state, api, app };
}
/** Conectores with "Suporte" connected by headers alone, and its Reconectar open. */
async function openReconnect(names = ["X-API-Key", "X-Tenant"]) {
  const state = seedState();
  const api = createFakeApi(state);
  const res = await api.customConnectors.connect(ORG_ID, {
    serverUrl: ADDRESS,
    label: "Suporte",
    headers: names.map((name) => ({ name, value: "fake-value" })),
    returnTo: "/",
  });
  if (res.status !== "connected") throw new Error("expected connected");
  state.calls.length = 0;
  const app = await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
  await settle(8);
  const reconnect = async () => {
    await click(within(await rowMenu("Suporte")).getByRole("menuitem", { name: "Reconectar" }));
    await settle(2);
  };
  return { state, api, app, server: res.server, reconnect };
}

describe("request headers for a server by address", () => {
  test("closed until asked for; a name and a secret value per row; headers alone connect", async () => {
    const { state } = await openForm();
    expect(disclosure().hasAttribute("open")).toBe(true);
    expect(disclosure().textContent).toContain(
      "Para uma chave que vai em outro cabeçalho, ou um gateway na frente do servidor. A maioria dos servidores não precisa.",
    );
    expect(nameField(1).placeholder).toBe("X-API-Key");
    expect([valueField(1).type, valueField(1).autocomplete, nameField(1).autocomplete]).toEqual([
      "password",
      "off",
      "off",
    ]);
    await header(1, "X-API-Key", "fake-value");
    await click(add());
    await header(2, "X-Tenant", "acme");
    // A row left blank is no header.
    await click(add());
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(connectCalls(state)).toEqual([
      expect.objectContaining({
        serverUrl: ADDRESS,
        apiKey: undefined,
        headers: [
          { name: "X-API-Key", value: "[redacted]" },
          { name: "X-Tenant", value: "[redacted]" },
        ],
      }),
    ]);
    expect(screen().getByRole("dialog", { name: "Suporte conectado" })).toBe(flow());
  });

  test("with a key the two go together; the headers' own row goes with Remover", async () => {
    const { state } = await openForm();
    await header(1, "X-Tenant", "acme");
    await click(add());
    await header(2, "X-Wrong", "nope");
    await click(within(flow()).getByRole("button", { name: "Remover cabeçalho 2" }));
    expect(within(flow()).queryByLabelText("Nome do cabeçalho 2")).toBeNull();
    await click(within(flow()).getByText("Conectar com uma chave de API"));
    // No key yet: the headers alone would go.
    expect(within(flow()).queryByRole("button", { name: "Conectar com a chave" })).toBeNull();
    await type(within(flow()).getByLabelText("Chave de API"), "test-key-1");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    await settle(4);
    expect(connectCalls(state)).toEqual([
      expect.objectContaining({ apiKey: "[redacted]", headers: [{ name: "X-Tenant", value: "[redacted]" }] }),
    ]);
  });

  test("ten at most: the button that adds one turns off and says why", async () => {
    await openForm();
    for (let n = 2; n <= MAX_REQUEST_HEADERS; n++) {
      expect(add().disabled).toBe(false);
      await click(add());
    }
    expect(nameField(MAX_REQUEST_HEADERS)).toBeTruthy();
    expect(add().disabled).toBe(true);
    expect(disclosure().textContent).toContain(
      "Um servidor aceita no máximo 10 cabeçalhos. Remova um para adicionar outro.",
    );
    expect(add().getAttribute("aria-describedby")).toBe("cflow-headers-full");
    const fourth = within(flow()).getByRole("button", { name: "Remover cabeçalho 4" });
    fourth.focus();
    await click(fourth);
    expect(add().disabled).toBe(false);
    expect(disclosure().textContent).not.toContain("no máximo");
    // The removed row's button is gone: the focus is on the one that adds a row, not lost to the page.
    expect(document.activeElement).toBe(add());
  });

  test("the server's refusal shows on its row, in plain words, once; it goes when the headers change", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const connect = api.customConnectors.connect;
    api.customConnectors.connect = async (orgId, input) => {
      const index = input.headers?.findIndex((h) => h.name.toLowerCase() === "host") ?? -1;
      if (index >= 0)
        throw new ApiError(400, "connector.header_reserved", "Host is set for every request", {
          header: "Host",
          index,
        });
      const empty = input.headers?.findIndex((h) => h.value.trim() === "") ?? -1;
      if (empty >= 0)
        throw new ApiError(400, "connector.header_value", "X-Tenant needs a value", {
          header: "X-Tenant",
          index: empty,
        });
      return connect(orgId, input);
    };
    await openForm(state, api);
    // The first row stays blank: the server's second header is the third row.
    await click(add());
    await header(2, "X-API-Key", "fake-value");
    await click(add());
    await header(3, "Host", "example.com");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    const said = "Host já é enviado em toda requisição e não dá para trocar. Remova este cabeçalho.";
    const rows = () => [...flow().querySelectorAll(".cflow__hrows > li")];
    expect(rows().map((row) => row.querySelector('[role="alert"]')?.textContent ?? null)).toEqual([null, null, said]);
    expect([nameField(3), valueField(3), nameField(2)].map((el) => el.getAttribute("aria-invalid"))).toEqual([
      "true",
      null,
      null,
    ]);
    expect(nameField(3).getAttribute("aria-describedby")).toBe(rows()[2]?.querySelector('[role="alert"]')?.id ?? "");
    // On the row alone: no toast says it again.
    expect(document.body.textContent?.split(said)).toHaveLength(2);
    expect(disclosure().hasAttribute("open")).toBe(true);
    snapshot();

    await header(3, "X-Tenant", "");
    expect(flow().querySelector('[role="alert"]')).toBeNull();
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(rows()[2]?.querySelector('[role="alert"]')?.textContent).toBe(
      "Digite um valor para X-Tenant: até 2.000 caracteres em uma linha, sem acentos nem emojis.",
    );
    expect([nameField(3), valueField(3)].map((el) => el.getAttribute("aria-invalid"))).toEqual([null, "true"]);
  });

  test("a server that asks for a sign-in, or says no: under the rows, with the way out", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const connect = api.customConnectors.connect;
    let refuse = false;
    api.customConnectors.connect = async (orgId, input): Promise<CustomConnectStart> =>
      refuse ? { status: "needs_key" } : connect(orgId, input);
    await openForm(state, api);
    await header(1, "X-API-Key", "fake-value");
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "https://oauth.example.com/mcp");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    const said =
      "Este servidor pede login, e o login ainda não leva cabeçalhos. Remova os cabeçalhos para entrar, ou conecte com uma chave de API.";
    expect(disclosure().querySelector(':scope > .cflow__headers > [role="alert"]')?.textContent).toBe(said);
    expect(document.body.textContent?.split(said)).toHaveLength(2);

    refuse = true;
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), ADDRESS);
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(flow().textContent).toContain(
      "O servidor não aceitou esses cabeçalhos. Confira os valores, ou conecte com uma chave de API.",
    );
    expect(flow().textContent).not.toContain("não aceita OAuth");
    // The key's form opened, and without a key the headers still go alone.
    expect(within(flow()).getByRole("button", { name: "Conectar" })).toBeTruthy();
  });

  test("while it connects, every field and button of the headers is off", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    api.customConnectors.connect = () => new Promise(() => {});
    await openForm(state, api);
    await header(1, "X-API-Key", "fake-value");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(2);
    const controls = [
      nameField(1),
      valueField(1),
      add(),
      within(flow()).getByRole("button", { name: "Remover cabeçalho 1" }),
    ];
    expect(controls.map((el) => el.closest("fieldset[disabled]") !== null)).toEqual([true, true, true, true]);
  });

  test("a catalog connector has none", async () => {
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api: createFakeApi(seedState({ connections: [] })) });
    await settle(8);
    await click(screen().getByRole("button", { name: "Adicionar conector" }));
    await pick(screen().getByRole("dialog", { name: "Adicionar conector" }), "Linear");
    expect(flow().textContent).toContain("Conectar Linear");
    expect(flow().textContent).not.toContain("Cabeçalhos da requisição");
  });
});

describe("Reconectar and the server's row", () => {
  test("the row names what is sent, with Reconectar as the way to change it; nothing for a server with none", async () => {
    const { api } = await openReconnect();
    await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.example.com/mcp",
      label: "Outro",
      returnTo: "/",
    });
    cleanup();
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    await openConnected();
    const rows = [...screen().getByRole("region", { name: "MCPs" }).querySelectorAll(".connected-row")];
    const sends = rows.map((row) => [...row.querySelectorAll(".connected-row__text")].map((el) => el.textContent)[1]);
    expect(sends).toEqual(["Envia também: X-API-Key e X-Tenant. Para mudar, use Reconectar.", undefined]);
    expect(document.body.textContent).not.toContain("fake-value");
  });

  test("the saved names stay unless new ones are typed: untouched, nothing about headers is sent", async () => {
    const { state, reconnect } = await openReconnect();
    await reconnect();
    expect(screen().getByRole("dialog", { name: "Reconectar Suporte" })).toBe(flow());
    expect(disclosure().hasAttribute("open")).toBe(true);
    expect(disclosure().textContent).toContain(
      "Salvos: X-API-Key e X-Tenant. Continuam, a menos que você digite novos.",
    );
    expect(within(flow()).queryByLabelText("Nome do cabeçalho 1")).toBeNull();
    snapshot();
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(connectCalls(state)).toEqual([expect.objectContaining({ serverUrl: ADDRESS, apiKey: undefined })]);
    expect(connectCalls(state)[0]?.headers).toBeUndefined();
    expect(document.body.textContent).toContain("Suporte reconectado.");
  });

  test("Remover sends none any more, Desfazer keeps them; a typed row replaces them all", async () => {
    const { state, reconnect } = await openReconnect(["X-API-Key"]);
    await reconnect();
    expect(disclosure().textContent).toContain("Salvo: X-API-Key. Continua, a menos que você digite novos.");
    await click(within(disclosure()).getByRole("button", { name: "Remover" }));
    expect(disclosure().textContent).toContain("X-API-Key sai ao reconectar.");
    await click(within(disclosure()).getByRole("button", { name: "Desfazer" }));
    expect(disclosure().textContent).toContain("Salvo: X-API-Key.");
    await click(within(disclosure()).getByRole("button", { name: "Remover" }));
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(connectCalls(state).at(-1)).toMatchObject({ headers: [] });
    // With nothing left to send, this server asks for a key.
    expect(flow().textContent).toContain("Este servidor não aceita OAuth. Conecte com uma chave de API.");

    await click(add());
    await header(1, "X-Token", "fake-value");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(connectCalls(state).at(-1)).toMatchObject({ headers: [{ name: "X-Token", value: "[redacted]" }] });
    await openConnected();
    expect(screen().getByRole("region", { name: "MCPs" }).textContent).toContain(
      "Envia também: X-Token. Para mudar, use Reconectar.",
    );
  });

  test("a refusal of a saved header shows under the saved names", async () => {
    const { api, reconnect } = await openReconnect(["Authorization"]);
    api.customConnectors.connect = async () => {
      throw new ApiError(400, "connector.header_and_key", "The key is sent as Authorization", {
        header: "Authorization",
        index: 0,
      });
    };
    await reconnect();
    await click(within(flow()).getByText("Conectar com uma chave de API"));
    await type(within(flow()).getByLabelText("Chave de API"), "test-key-1");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    await settle(4);
    expect(disclosure().querySelector('[role="alert"]')?.textContent).toBe(
      "A chave de API já é enviada como Authorization. Apague a chave ou remova este cabeçalho.",
    );
  });
});

/**
 * What breaks the form and the row (break-ui): ten headers, each name as long as one may be (64 characters, one
 * unbroken word), a refusal that names one, and the same in English. CI's geometry check lays these out at 1280, 390
 * and 320.
 */
describe("worst cases", () => {
  const LONG = Array.from({ length: MAX_REQUEST_HEADERS }, (_, i) =>
    `X-${String(i).padStart(2, "0")}-${"GatewayTenantRoutingKey".repeat(3)}`.slice(0, 64),
  );

  test("ten rows, the longest names, a refusal that names one", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    api.customConnectors.connect = async (_orgId, input) => {
      throw new ApiError(400, "connector.header_twice", "It is there twice", {
        header: input.headers?.at(-1)?.name ?? "",
        index: (input.headers?.length ?? 1) - 1,
      });
    };
    const { app } = await openForm(state, api);
    for (const [i, name] of LONG.entries()) {
      if (i > 0) await click(add());
      await header(i + 1, name, "v".repeat(2000));
    }
    await click(within(flow()).getByText("Conectar com uma chave de API"));
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(flow().querySelectorAll(".cflow__hrows > li")).toHaveLength(MAX_REQUEST_HEADERS);
    expect(flow().querySelector('.cflow__hrows > li:last-child [role="alert"]')?.textContent).toBe(
      `${LONG.at(-1)} está na lista duas vezes. Remova um deles.`,
    );
    snapshot();
    await showIn(app.services, "en");
    expect(flow().textContent).toContain("A server takes at most 10 headers. Remove one to add another.");
    expect(flow().querySelector('.cflow__hrows [role="alert"]')?.textContent).toBe(
      `${LONG.at(-1)} is in the list twice. Remove one of them.`,
    );
  });

  test("Reconectar and the row of a server with ten long names, removed and not", async () => {
    const { app, reconnect } = await openReconnect(LONG);
    await openConnected();
    snapshot();
    await reconnect();
    expect(disclosure().textContent).toContain(LONG.at(-1) as string);
    snapshot();
    await click(within(disclosure()).getByRole("button", { name: "Remover" }));
    snapshot();
    await showIn(app.services, "en");
    expect(disclosure().textContent).toContain("will be removed when you reconnect.");
  });
});
