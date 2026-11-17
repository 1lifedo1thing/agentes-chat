import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { PRODUCT_SITE_URL } from "@agenteschat/client/lib/about";
import { accentPalette } from "@agenteschat/ui";
import { act, cleanup } from "@testing-library/react";
import { brandTabTitle, createI18n, translateTabTitle } from "@/i18n";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** ADR 0194: on a registered host, the pages before sign-in wear its look; elsewhere, nothing changes. */

const NORTHWIND = { name: "Northwind Studio", accent: "#7c3aed", logoUrl: "/api/host-look/logo?v=abc.png" };

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("style");
});

const agentVar = () => document.documentElement.style.getPropertyValue("--agent");

async function signInPage(host: typeof NORTHWIND | null, social = true) {
  const state = seedState({ me: null });
  state.authConfig = { host, socialProviders: { google: social, github: social } };
  await renderApp("/login", { api: createFakeApi(state) });
}

describe("the sign-in page", () => {
  test("on a registered host: its logo and name, its accent, the powered-by line, no provider buttons", async () => {
    await signInPage(NORTHWIND, false);
    const logo = screen().getByRole("img", { name: "Northwind Studio" });
    expect(logo.getAttribute("src")).toBe(NORTHWIND.logoUrl);
    expect(document.querySelector(".auth--host")).not.toBeNull();
    expect(screen().queryByRole("img", { name: "agentes" })).toBeNull();
    const powered = screen().getByRole("link", { name: "Feito com agentes.chat" });
    expect(powered.getAttribute("href")).toBe(PRODUCT_SITE_URL);
    expect(screen().queryByRole("button", { name: /Continuar com/ })).toBeNull();
    expect(agentVar()).toBe(accentPalette(NORTHWIND.accent).light.agent);
  });

  test("on a registered host with no logo: its name alone in the lockup's place", async () => {
    await signInPage({ ...NORTHWIND, logoUrl: null, accent: null }, false);
    expect(document.querySelector(".auth__host-name")?.textContent).toBe("Northwind Studio");
    expect(document.querySelector(".auth__host-logo")).toBeNull();
    expect(agentVar()).toBe("");
  });

  test("anywhere else: exactly as before", async () => {
    await signInPage(null);
    expect(screen().getByRole("img", { name: "agentes" })).toBeTruthy();
    expect(document.querySelector(".auth--host, .auth__powered")).toBeNull();
    expect(screen().getByRole("button", { name: /Continuar com GitHub/ })).toBeTruthy();
    expect(agentVar()).toBe("");
  });
});

test("inside a workspace the host's accent is gone: the workspace's own or the default", async () => {
  const state = seedState();
  state.authConfig = { host: NORTHWIND };
  await renderApp(`/org/${ORG_ID}/home`, { api: createFakeApi(state) });
  await settle();
  expect(agentVar()).not.toBe(accentPalette(NORTHWIND.accent).light.agent);
});

test("the tab's title names the host where it names the product, in every language and on every page", async () => {
  const i18n = createI18n("en");
  translateTabTitle(i18n);
  expect(document.title).toContain("agentes.chat");
  brandTabTitle("Northwind Studio");
  expect(document.title).toBe("Northwind Studio · Your team and your agents, in the same conversation");
  await act(async () => {
    document.title = "#general · Acme · agentes.chat";
    await Promise.resolve();
  });
  expect(document.title).toBe("#general · Acme · Northwind Studio");
  await act(async () => {
    document.title = "Northwind Studio · Your team and your agents, in the same conversation";
    await i18n.changeLanguage("pt-BR");
  });
  expect(document.title).toBe("Northwind Studio · Seu time e seus agentes, na mesma conversa");
  // A name with "$" is taken as written.
  brandTabTitle("Cash $& Co.");
  await act(async () => {
    document.title = "agentes.chat";
    await Promise.resolve();
  });
  expect(document.title).toBe("Cash $& Co.");
});
