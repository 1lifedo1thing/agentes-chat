import {
  type GenerateImagesInput,
  type ImageAspect,
  type ImageModelOption,
  MAX_IMAGES_PER_REQUEST,
  useImageModels,
} from "@agenteschat/client";
import { formatUsd } from "@agenteschat/client/lib/format";
import type { ShapeView } from "@agenteschat/live/canvas";
import {
  Button,
  Icon,
  modKey,
  ProviderLogo,
  Segmented,
  Select,
  type SelectOption,
  Skeleton,
  Textarea,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

/**
 * "Generate image" on a canvas (ADR 0195): the dock grows into a prompt bar with the model, the picture's shape, how
 * many, and the pictures to start from (the chosen ones). Gerar asks the server, which puts a frame named with the
 * prompt and one placeholder per picture on the canvas at once, near the middle of what this person sees; each picture
 * takes its placeholder's place as it comes. With no key for any image model, the bar says how to connect one.
 */

/** The shapes a picture can take here, in the order the bar offers them (each model says which it makes). */
export const BAR_ASPECTS: readonly ImageAspect[] = ["1:1", "3:2", "2:3", "16:9", "9:16"];

export interface GenerateDraft {
  prompt?: string;
  references?: string[];
}

export function GenerateBar({
  orgId,
  images,
  selectedImages,
  draft,
  offline,
  pending,
  onGenerate,
  onClose,
  assetUrl,
}: {
  orgId: string;
  /** The canvas's pictures by shape id (what references can be). */
  images: ReadonlyMap<string, ShapeView>;
  /** The pictures chosen now ("Use selection as reference"). */
  selectedImages: readonly ShapeView[];
  /** What the bar opens with (Variations, Edit with AI). */
  draft: GenerateDraft | null;
  offline: boolean;
  pending: boolean;
  onGenerate(input: Omit<GenerateImagesInput, "at">): Promise<boolean>;
  onClose(): void;
  assetUrl(assetId: string): string;
}) {
  const { t, i18n } = useTranslation();
  const models = useImageModels(orgId);
  const list = models.data ?? [];
  const [modelId, setModelId] = useState<string | undefined>(undefined);
  const model: ImageModelOption | undefined = list.find((m) => m.id === modelId) ?? list[0];
  const aspects = BAR_ASPECTS.filter((a) => !model || model.aspects.includes(a));
  const [aspect, setAspect] = useState<ImageAspect>("1:1");
  const [count, setCount] = useState(1);
  const [prompt, setPrompt] = useState(draft?.prompt ?? "");
  const [refs, setRefs] = useState<string[]>(() => draft?.references ?? selectedImages.slice(0, 4).map((s) => s.id));
  const box = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();

  // A new draft (Variations or Edit with AI on another picture) replaces what the bar held.
  useEffect(() => {
    if (!draft) return;
    if (draft.prompt !== undefined) setPrompt(draft.prompt);
    if (draft.references) setRefs(draft.references);
    box.current?.focus();
  }, [draft]);

  useEffect(() => {
    box.current?.focus();
  }, []);

  const maxCount = Math.max(1, Math.min(MAX_IMAGES_PER_REQUEST, model?.maxCount ?? MAX_IMAGES_PER_REQUEST));
  const shownCount = Math.min(count, maxCount);
  const shownAspect = aspects.includes(aspect) ? aspect : (aspects[0] ?? "1:1");
  const usesRefs = model?.refs ?? true;
  const references = usesRefs ? refs.filter((id) => images.has(id)) : [];
  const unused = selectedImages.filter((s) => !references.includes(s.id));
  const ready = prompt.trim().length > 0 && !!model && !offline && !pending;
  const hint = offline ? t("live.images.offline") : !usesRefs && selectedImages.length ? t("live.images.noRefs") : "";

  const submit = async () => {
    if (!ready || !model) return;
    const ok = await onGenerate({
      prompt: prompt.trim(),
      count: shownCount,
      aspect: shownAspect,
      model: model.id,
      ...(references.length ? { references } : {}),
    });
    if (ok) setRefs([]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
    // The canvas's own keys (tools, delete) never fire from inside the bar.
    e.stopPropagation();
  };

  const modelOptions: SelectOption[] = useMemo(
    () =>
      list.map((m) => ({
        value: m.id,
        label: m.label,
        leading: <ProviderLogo id={m.provider} size="xs" />,
      })),
    [list],
  );

  let body: ReactNode;
  if (models.isPending) {
    body = (
      <div className="cnv-gen__loading" role="status" aria-label={t("live.images.loadingModels")}>
        <Skeleton height={56} />
        <Skeleton width="60%" />
      </div>
    );
  } else if (models.isError) {
    body = (
      <p className="cnv-gen__note ac-actline">
        <span>{t("live.images.modelsFailed")}</span>
        <Button size="sm" onClick={() => void models.refetch()}>
          {t("live.images.tryAgain")}
        </Button>
      </p>
    );
  } else if (!list.length) {
    body = (
      <p className="cnv-gen__note ac-actline">
        <span>{t("live.images.noKey")}</span>
        <Button size="sm" asChild>
          <Link to="/org/$orgId/settings/$section" params={{ orgId, section: "usage" }} search={{}}>
            {t("live.images.connect")}
          </Link>
        </Button>
      </p>
    );
  } else {
    const price = model?.pricePerImage;
    body = (
      <>
        {references.length > 0 && (
          <ul className="cnv-gen__refs" aria-label={t("live.images.references")}>
            {references.map((id) => {
              const s = images.get(id);
              return (
                <li key={id} className="cnv-gen__ref">
                  {s?.asset && <img src={assetUrl(s.asset)} alt="" />}
                  <button
                    type="button"
                    className="cnv-gen__unref"
                    aria-label={t("live.images.removeReference")}
                    title={t("live.images.removeReference")}
                    onClick={() => setRefs((r) => r.filter((x) => x !== id))}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <Textarea
          ref={box}
          className="cnv-gen__prompt"
          rows={2}
          autoGrow
          value={prompt}
          placeholder={references.length ? t("live.images.promptEdit") : t("live.images.prompt")}
          aria-label={t("live.images.promptLabel")}
          aria-describedby={hint ? hintId : undefined}
          maxLength={4000}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="cnv-gen__row">
          {list.length > 1 ? (
            <Select
              size="sm"
              className="cnv-gen__model"
              aria-label={t("live.images.model")}
              value={model?.id}
              options={modelOptions}
              onValueChange={setModelId}
            />
          ) : (
            model && (
              <span className="cnv-gen__one-model small muted ac-iconline">
                <ProviderLogo id={model.provider} size="xs" />
                {model.label}
              </span>
            )
          )}
          {aspects.length > 1 && (
            <Segmented
              size="sm"
              label={t("live.images.aspect")}
              value={shownAspect}
              onValueChange={setAspect}
              options={aspects.map((a) => {
                const [w = 1, h = 1] = a.split(":").map(Number);
                return {
                  value: a,
                  title: a,
                  label: (
                    <>
                      <span
                        className="cnv-gen__ratio"
                        aria-hidden="true"
                        style={{ "--rw": w >= h ? 1 : w / h, "--rh": h >= w ? 1 : h / w } as CSSProperties}
                      />
                      <span className="ac-visually-hidden">{a}</span>
                    </>
                  ),
                };
              })}
            />
          )}
          {maxCount > 1 && (
            <Segmented
              size="sm"
              label={t("live.images.count")}
              value={String(shownCount)}
              onValueChange={(v) => setCount(Number(v))}
              options={Array.from({ length: maxCount }, (_, i) => ({
                value: String(i + 1),
                label: String(i + 1),
              }))}
            />
          )}
          <span className="cnv-gen__go">
            {price !== undefined && price > 0 && (
              <span className="cnv-gen__price small muted tabular">
                {t("live.images.price", { price: formatUsd(i18n.language, price * shownCount) })}
              </span>
            )}
            <Button
              variant="agent"
              size="sm"
              icon="sparkle"
              loading={pending}
              disabled={!ready && !pending}
              title={`${t("live.images.generate")} (${modKey()}↵)`}
              onClick={() => void submit()}
            >
              {t("live.images.generate")}
            </Button>
          </span>
        </div>
        {hint && (
          <p id={hintId} className="cnv-gen__hint small muted">
            {hint}
          </p>
        )}
        {usesRefs && unused.length > 0 && references.length < 4 && (
          <Button
            variant="link"
            className="cnv-gen__use"
            onClick={() => setRefs((r) => [...r, ...unused.map((s) => s.id)].slice(0, 4))}
          >
            {t("live.images.useSelection")}
          </Button>
        )}
      </>
    );
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a bar of controls named as one, not a form's fieldset
    <div className="cnv-gen ac-glass" role="group" aria-label={t("live.images.title")} onKeyDown={onKeyDown}>
      <div className="cnv-gen__head">
        <span className="cnv-gen__title ac-iconline">
          <Icon name="sparkle" size={16} />
          {t("live.images.title")}
        </span>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="close"
          aria-label={t("live.images.close")}
          title={`${t("live.images.close")} (Esc)`}
          onClick={onClose}
        />
      </div>
      {body}
    </div>
  );
}
