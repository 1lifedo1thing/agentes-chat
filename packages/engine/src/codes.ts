import { randomBytes } from "node:crypto";

/** Unambiguous code alphabet (no I/O/0/1) for codes people read off one screen and type or compare on another. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CONFIRMATION_CODE_LENGTH = 8;

/** A short code of `CODE_ALPHABET` with a dash in the middle (`KQ7M-3XPF`). */
export function newConfirmationCode(): string {
  const bytes = randomBytes(CONFIRMATION_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CONFIRMATION_CODE_LENGTH; i++) {
    if (i === CONFIRMATION_CODE_LENGTH / 2) code += "-";
    // 256 is a multiple of the alphabet's 32 letters, so the modulo picks each one equally often.
    code += CODE_ALPHABET[(bytes[i] ?? 0) % CODE_ALPHABET.length];
  }
  return code;
}
