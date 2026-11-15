import { describe, expect, mock, test } from "bun:test";

// The phone's storage helper over SecureStore, held in memory here: what the app kept when it last closed.
const kept = new Map<string, string>([["agenteschat.voice-speed", "1.5"]]);
mock.module("expo-secure-store", () => ({
  getItem: (key: string) => kept.get(key) ?? null,
  setItem: (key: string, value: string) => void kept.set(key, value),
  getItemAsync: async (key: string) => kept.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void kept.set(key, value),
  deleteItemAsync: async (key: string) => void kept.delete(key),
}));
mock.module("expo-constants", () => ({ default: {} }));

const { STORAGE_PREFIX } = await import("../../src/config");
const { STORED } = await import("../../src/lib/storage");
const { setVoiceSpeed, subscribeVoiceSpeed, voiceSpeed } = await import("../../src/features/voice/speed");

describe("voice messages remember the speed picked on this phone", () => {
  test("the speed kept when the app closed is where every voice message starts", () => {
    expect(`${STORAGE_PREFIX}.${STORED.voiceSpeed}`).toBe("agenteschat.voice-speed");
    expect(voiceSpeed()).toBe(1.5);
  });

  test("a new pick is kept on the phone and reaches every player on screen", async () => {
    let told = 0;
    const stop = subscribeVoiceSpeed(() => told++);
    setVoiceSpeed(2);
    stop();
    expect(voiceSpeed()).toBe(2);
    expect(told).toBe(1);
    await Promise.resolve();
    expect(kept.get("agenteschat.voice-speed")).toBe("2");
  });
});
