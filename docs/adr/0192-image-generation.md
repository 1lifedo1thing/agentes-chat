# 0192. Image generation through the Model Gateway

- Status: Accepted
- Date: 2026-11-17
- Amends: 0012 (a usage kind `image`), 0018 (providers: images beside text)
- Code: `packages/providers/src/images.ts` (`IMAGE_CATALOG`, `ImageRequest`, `ImageResult`, costs) and each adapter's
  `generateImage` (`openai.ts`, `gemini.ts`, `openrouter.ts`, `custom.ts`, the fake in `fake.ts`), engine
  `gateway.ts` (`generateImages`), `packages/engine/src/live/images.ts` (requests, the `live.image` job, placement),
  the `generate_image` tool, routes `apps/server/src/routes/app/images.ts`; migration adding `usage_kind` `image`

## Context

People ask agents for images all the time, and the only images made today come from Codex's own tool on a
computer, billed to a ChatGPT plan and invisible to the workspace's budget. A canvas that groups generated images
(ADR 0191) needs images made on request, by people from the canvas and by any agent from a conversation, priced
and limited like every other model call.

## Decision

**One catalog of image models, apart from the chat models.** `IMAGE_CATALOG` lists each model with its provider,
the sizes and aspect ratios it takes, how many images one call returns, whether it takes reference images (edits,
variations) and its price, per image or per token as its maker bills it, checked against each maker's price page.
It never enters `MODEL_CATALOG`, so image models never show up in model pickers, the router or Automático.

- Google Gemini (Nano Banana 2.1, Nano Banana 2, Nano Banana Pro, Nano Banana 2 Lite) through the Interactions API
  the Gemini adapter already speaks, with an image `response_format` and reference images as inline parts.
- OpenAI's GPT Image models through `/v1/images/generations` and `/v1/images/edits`.
- OpenRouter's image models through `/api/v1/images`, which report their own cost.
- A workspace's own OpenAI-compatible endpoint (ADR 0146) when it serves `/images/generations`, priced by the
  workspace (zero by default), which is how a self-hosted server uses a local image model.

A workspace can generate images when it has a key (its own, or the platform's) for one of those providers. Which
models each workspace may pick is `GET …/images/models`; the default is the first one available in that order.

**Every image goes through the gateway.** `generateImages` mirrors `stream`: the workspace's standing, the agent's
budget reserved at the model's worst case before the call (or the person's own limit, ADR 0141, when a person asks
from the canvas), the key resolved for the image model's provider (never an agent's chat credential of another
provider), the call, and one `usage_records` row of the new kind `image` with the cost the provider reported or the
catalog's, the run, the agent or the person. Readers of "what an agent's budget paid" count `agent` and `image`.
A failed call is settled at what the provider billed, usually nothing.

**Images land on a canvas.** A request names a canvas (the one it was made from) or none, and then the
conversation's own canvas is used, made on first use ("Imagens", in that conversation, so it has the
conversation's audience). The request first places a frame titled with the prompt and one placeholder per image
in the canvas, so everyone in it sees what is coming and who asked; a job (`live.image`, ADR 0005) calls the
gateway, stores each image as an asset of the canvas (ADR 0191 §8) and turns each placeholder into the image, with
its prompt, model, who asked and the images it started from. A failure leaves the placeholder saying why, with
Try again. Variations and edits send the selected images as references.

**People and agents.** People generate from the canvas (`POST …/artifacts/{id}/images`: a person who may upload
files, at most 30 requests an hour, four images a request). Agents call `generate_image` (`drive:write`), which
waits for the images (at most two minutes), answers with the canvas as the reply's card, and hands the images to a
model that can see them. In Codex's turns both tools exist; the prompt says ours puts the images on the canvas and
counts them in the budget.

## Consequences

- Image spend shows in Usage with its own kind, and budgets stop it like any other spend.
- Prices change often: they are dated in the catalog like text models' (ADR 0018), each call priced at its time.
- A workspace with only an Anthropic key can't generate images, and the canvas says so instead of offering it.
