import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { STORAGE_KEYS } from "@/lib/storage";
import { setVoiceSpeed } from "@/lib/voice-speed";
import { createFakeApi, ENG_ID, NOW, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

const voiceMessage = (id: string, minutesAgo: number) => ({
  id,
  channelId: ENG_ID,
  threadId: null,
  author: { type: "person" as const, id: "u-joao" },
  body: "",
  mentionedAgentIds: [],
  agentRunId: null,
  meta: { voice: { clipId: `clip-${id}`, durationMs: 9000, peaks: [0.2, 0.7, 0.4] } },
  createdAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
});

const open = async () => {
  const state = seedState();
  state.messages.push(voiceMessage("m-voice-1", 30), voiceMessage("m-voice-2", 20));
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);
  await act(async () => r.sockets.last().open());
  await settle(2);
};
const speeds = () => [...document.querySelectorAll(".ac-voice__speed")].map((b) => b.textContent);

beforeEach(() => {
  setVoiceSpeed(1);
  localStorage.clear();
});
afterEach(() => cleanup());

describe("voice messages remember the speed picked on this device", () => {
  test("picked on one, every voice message on screen plays at it, and it is kept in this browser", async () => {
    await open();
    expect(speeds()).toEqual(["1×", "1×"]);
    await act(async () => fireEvent.click(document.querySelector(".ac-voice__speed") as HTMLElement));
    expect(speeds()).toEqual(["1.5×", "1.5×"]);
    expect(localStorage.getItem(STORAGE_KEYS.voiceSpeed)).toBe("1.5");
  });

  test("after a reload, voice messages start at the kept speed", async () => {
    localStorage.setItem(STORAGE_KEYS.voiceSpeed, "2");
    await open();
    expect(speeds()).toEqual(["2×", "2×"]);
  });

  test("a kept value the player doesn't offer plays at 1x", async () => {
    localStorage.setItem(STORAGE_KEYS.voiceSpeed, "3");
    await open();
    expect(speeds()).toEqual(["1×", "1×"]);
  });

  test("with storage blocked the players work at 1x and still change speed together", async () => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    const get = spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    const set = spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    try {
      await open();
      expect(speeds()).toEqual(["1×", "1×"]);
      await act(async () => fireEvent.click(document.querySelector(".ac-voice__speed") as HTMLElement));
      expect(speeds()).toEqual(["1.5×", "1.5×"]);
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});
