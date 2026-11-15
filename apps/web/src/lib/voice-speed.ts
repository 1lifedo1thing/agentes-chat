import { voiceSpeedOf } from "@agenteschat/client/lib/voice";
import { useSyncExternalStore } from "react";
import { STORAGE_KEYS, storage } from "./storage";

/**
 * The speed voice messages play at, picked on any of them, for all of them, kept in this browser. Also held in memory
 * so blocked storage still shares it for as long as the page is open.
 */
const CHANGE_EVENT = "agentes:voice-speed";
let picked: string | null = null;

export const voiceSpeed = () => voiceSpeedOf(storage.get(STORAGE_KEYS.voiceSpeed) ?? picked);

export function setVoiceSpeed(speed: number) {
  picked = String(speed);
  storage.set(STORAGE_KEYS.voiceSpeed, picked);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

const onVoiceSpeedChange = (cb: () => void) => {
  window.addEventListener(CHANGE_EVENT, cb);
  return () => window.removeEventListener(CHANGE_EVENT, cb);
};

export const useVoiceSpeed = () => useSyncExternalStore(onVoiceSpeedChange, voiceSpeed, voiceSpeed);
