import type { ImageAspect, ImageModelOption } from "@agenteschat/client";

/**
 * The choices of "Gerar imagem" on the phone (ADR 0192): the model (the workspace's default first), the shapes it
 * offers (the five the canvas offers, as far as the model makes them) and how many pictures (up to what it allows).
 */

/** The shapes the canvas offers, in its order: square, landscape, portrait, wide, tall. */
export const ASPECT_ORDER: readonly ImageAspect[] = ["1:1", "3:2", "2:3", "16:9", "9:16"];

/** The model in use: the one picked, else the workspace's default (the first), or null when there is none. */
export function pickModel(models: readonly ImageModelOption[], id: string | null): ImageModelOption | null {
  return (id ? models.find((m) => m.id === id) : undefined) ?? models[0] ?? null;
}

/** The shapes a model makes, among the canvas's; all of them when it doesn't say, square when it makes none of them. */
export function aspectChoices(model: Pick<ImageModelOption, "aspects"> | null): ImageAspect[] {
  if (!model || model.aspects.length === 0) return [...ASPECT_ORDER];
  const made = ASPECT_ORDER.filter((a) => model.aspects.includes(a));
  return made.length > 0 ? made : ["1:1"];
}

/** How many pictures a request may ask for: 1 up to the model's limit and the canvas's (`max`). */
export function countChoices(model: Pick<ImageModelOption, "maxCount"> | null, max: number): number[] {
  const n = Math.max(1, Math.min(max, Math.floor(model?.maxCount ?? max) || 1));
  return Array.from({ length: n }, (_, i) => i + 1);
}
