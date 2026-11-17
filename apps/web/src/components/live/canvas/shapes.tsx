import type { ImageFailure } from "@agenteschat/client";
import { useArtifact } from "@agenteschat/client";
import type { ShapeView } from "@agenteschat/live/canvas";
import { Button, Icon, PixelSpinner, Tip } from "@agenteschat/ui";
import { type CSSProperties, memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, PersonAvatar } from "@/components/AgentAvatar";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { HtmlFrame } from "@/components/artifacts/HtmlFrame";
import { useOrg } from "@/components/org-context";
import { colorOf, ImageSky } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { useCanvasEnv } from "./context";
import { arrowHead } from "./edit-math";
import { fillStyle } from "./palette";
import { CanvasRich } from "./text";

/**
 * The shapes of a canvas as the plane draws them (ADR 0194 §2, ADR 0195), each in world units inside the plane's
 * moving layer: pictures, notes, text, frames, shapes with their label, a Drive file's card, an agent's page (a picture
 * of it until someone presses Interact), and the placeholder of a picture being made. Arrows are drawn apart
 * (`ArrowShape`), from their ends.
 */

export interface ShapeBodyProps {
  shape: ShapeView;
  /** Its text box is open for typing. */
  editing: boolean;
  /** A page that takes the pointer now. */
  interacting: boolean;
  /** A picture that just replaced its placeholder: it fades in. */
  fresh: boolean;
}

/** The box a shape takes in the world, turned around its center. */
function boxStyle(s: ShapeView): CSSProperties {
  return {
    left: s.x,
    top: s.y,
    width: s.w,
    height: s.h,
    ...(s.rot ? { transform: `rotate(${s.rot}deg)` } : {}),
  };
}

export const ShapeBody = memo(function ShapeBody({ shape, editing, interacting, fresh }: ShapeBodyProps) {
  return (
    <div
      className="cnv-shape"
      data-shape={shape.id}
      data-type={shape.type}
      data-locked={shape.locked || undefined}
      data-editing={editing || undefined}
      style={boxStyle(shape)}
    >
      <ShapeInside shape={shape} editing={editing} interacting={interacting} fresh={fresh} />
    </div>
  );
});

function ShapeInside({ shape, editing, interacting, fresh }: ShapeBodyProps) {
  switch (shape.type) {
    case "image":
      return <ImageShape shape={shape} fresh={fresh} />;
    case "note":
      return (
        <div className="cnv-note" data-color={shape.color ?? "yellow"}>
          <CanvasRich shape={shape} editing={editing} className="cnv-note__text" />
        </div>
      );
    case "text":
      return (
        <CanvasRich
          shape={shape}
          editing={editing}
          className="cnv-text"
          style={{
            ...(shape.style?.size ? { fontSize: shape.style.size } : {}),
            ...(shape.style?.color ? { color: shape.style.color } : {}),
            ...(shape.style?.weight ? { fontWeight: shape.style.weight } : {}),
            ...(shape.style?.align ? { textAlign: shape.style.align } : {}),
          }}
        />
      );
    case "frame":
      return <div className="cnv-frame" style={shape.fill ? fillStyle(shape.fill) : undefined} />;
    case "shape":
      return <GeometricShape shape={shape} editing={editing} />;
    case "html":
      return <PageShape shape={shape} interacting={interacting} />;
    case "file":
      return <FileShape shape={shape} />;
    case "pending":
      return <PendingShape shape={shape} />;
    default:
      return null;
  }
}

function ImageShape({ shape, fresh }: { shape: ShapeView; fresh: boolean }) {
  const { t } = useTranslation();
  const env = useCanvasEnv();
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  if (!shape.asset) return <div className="cnv-img cnv-img--missing" />;
  const alt = shape.alt ?? shape.gen?.prompt ?? t("live.canvas.kinds.image");
  return (
    <div className="cnv-img" data-state={state}>
      {state === "failed" ? (
        <span className="cnv-img__failed small muted ac-iconline">
          <Icon name="image" size={16} />
          {t("live.canvas.imageFailed")}
        </span>
      ) : (
        <img
          src={env.assetUrl(shape.asset)}
          alt={alt}
          draggable={false}
          decoding="async"
          data-fresh={fresh || undefined}
          onLoad={() => setState("ready")}
          onError={() => setState("failed")}
        />
      )}
    </div>
  );
}

/** A rectangle, an ellipse or a diamond, with its label in the middle. */
function GeometricShape({ shape, editing }: { shape: ShapeView; editing: boolean }) {
  const kind = shape.kind ?? "rect";
  const fill = shape.fill && shape.fill !== "none" ? fillStyle(shape.fill) : undefined;
  return (
    <div
      className="cnv-geo"
      data-kind={kind}
      data-fill={shape.fill ? (shape.fill === "none" ? "none" : "custom") : undefined}
      style={fill}
    >
      <svg className="cnv-geo__svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {kind === "ellipse" ? (
          <ellipse cx="50" cy="50" rx="49" ry="49" vectorEffect="non-scaling-stroke" />
        ) : kind === "diamond" ? (
          <polygon points="50,1 99,50 50,99 1,50" vectorEffect="non-scaling-stroke" />
        ) : (
          <rect x="1" y="1" width="98" height="98" rx="4" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <CanvasRich shape={shape} editing={editing} className="cnv-geo__text" />
    </div>
  );
}

/** An agent's page: a still picture of it until Interact, then the page itself (isolated, ADR 0019). */
function PageShape({ shape, interacting }: { shape: ShapeView; interacting: boolean }) {
  const { t } = useTranslation();
  const env = useCanvasEnv();
  const query = useArtifact(env.orgId, shape.artifact ?? null);
  const a = query.data;
  const html = a?.content.kind === "html" ? a.content.html : null;
  return (
    <div className="cnv-page" data-live={interacting || undefined}>
      {html !== null ? (
        <HtmlFrame html={html} title={a?.title ?? t("live.canvas.kinds.html")} thumbnail={!interacting} />
      ) : (
        <span className="cnv-page__status small muted">
          {query.isError ? t("live.canvas.fileMissing") : t("live.canvas.loadingFile")}
        </span>
      )}
      {html !== null && !interacting && (
        <span className="cnv-page__foot">
          <span className="cnv-page__title">{a?.title}</span>
          <Button size="sm" icon="pointer" onClick={() => env.interact(shape.id)}>
            {t("live.canvas.interact")}
          </Button>
        </span>
      )}
    </div>
  );
}

/** Any Drive file, as the conversation's card for it (opened in the viewer on a double click). */
function FileShape({ shape }: { shape: ShapeView }) {
  if (!shape.artifact) return null;
  return (
    <div className="cnv-file">
      <ArtifactCard artifact={{ id: shape.artifact }} />
    </div>
  );
}

/** Each reason pictures fail for, as its words' key (never `too_many`: i18next reads `_many` as a plural form). */
const FAILURES: Record<ImageFailure, "noKey" | "budget" | "limit" | "blocked" | "provider" | "tooMany"> = {
  no_key: "noKey",
  budget: "budget",
  limit: "limit",
  blocked: "blocked",
  provider: "provider",
  too_many: "tooMany",
};

/** Why pictures failed, in words (an unknown code: the general ones). */
export function failureKey(error: string | undefined) {
  const known = error && Object.hasOwn(FAILURES, error) ? FAILURES[error as ImageFailure] : null;
  return known ? (`live.images.failed.${known}` as const) : ("live.images.failed.other" as const);
}

/**
 * A picture on its way (ADR 0195): the sky forming in the requester's tone (an agent's own, the sky's for a person),
 * who asked and the prompt; failed, why, with Try again for who may edit.
 */
function PendingShape({ shape }: { shape: ShapeView }) {
  const { t } = useTranslation();
  const env = useCanvasEnv();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const by = shape.by;
  const agent = by?.kind === "agent" ? dir.anyAgent(by.id) : undefined;
  const name = by
    ? by.kind === "agent"
      ? (agent?.name ?? t("channel.unknownAgent"))
      : (dir.memberById.get(by.id)?.name ?? t("channel.unknownPerson"))
    : "";
  const failed = shape.status === "failed";
  const tone = agent ? colorOf(agent) : "sky";
  return (
    <div className="cnv-pending" data-status={shape.status} role="status">
      {!failed && <ImageSky color={tone} />}
      <div className="cnv-pending__body">
        {failed ? (
          <>
            <span className="cnv-pending__why ac-iconline">
              <Icon name="alert" size={16} />
              {t(failureKey(shape.error))}
            </span>
            {!env.readOnly && shape.request && (
              <Button size="sm" icon="refresh" onClick={() => shape.request && env.retry(shape.request)}>
                {t("live.images.retry")}
              </Button>
            )}
          </>
        ) : (
          <span className="cnv-pending__state ac-iconline">
            <PixelSpinner size={16} color={tone} />
            {shape.status === "running" ? t("live.images.making") : t("live.images.queued")}
          </span>
        )}
        {shape.prompt && (
          <Tip tip={shape.prompt} look="ac-msg__tip">
            <span className="cnv-pending__prompt">{shape.prompt}</span>
          </Tip>
        )}
        {by && (
          <span className="cnv-pending__who">
            {by.kind === "agent" ? (
              <AgentAvatar agentId={by.id} name={name} size="xs" state={failed ? "idle" : "thinking"} />
            ) : (
              <PersonAvatar id={by.id} name={name} size="xs" />
            )}
            <span>{t("live.images.askedBy", { name })}</span>
          </span>
        )}
      </div>
    </div>
  );
}

export interface ArrowLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Room around an arrow's line inside its own drawing (its head and its stroke). */
const ARROW_PAD = 24;

/**
 * An arrow from its line (worked out by the plane from its ends: bound ends follow their shapes), drawn in its own
 * small SVG so it stacks among the shapes by its stacking key; its label on a plate in the middle.
 */
export const ArrowShape = memo(function ArrowShape({
  id,
  line,
  dashed,
  label,
  editingLabel,
}: {
  id: string;
  line: ArrowLine;
  dashed: boolean;
  label: string | undefined;
  editingLabel: boolean;
}) {
  const x = Math.min(line.x1, line.x2) - ARROW_PAD;
  const y = Math.min(line.y1, line.y2) - ARROW_PAD;
  const w = Math.abs(line.x2 - line.x1) + 2 * ARROW_PAD;
  const h = Math.abs(line.y2 - line.y1) + 2 * ARROW_PAD;
  const local = { x1: line.x1 - x, y1: line.y1 - y, x2: line.x2 - x, y2: line.y2 - y };
  const len = Math.hypot(local.x2 - local.x1, local.y2 - local.y1);
  // The line stops at the head's base, so a thick stroke doesn't poke through its tip.
  const head = 14;
  const k = len > head ? (len - head * 0.8) / len : 0;
  const end = { x: local.x1 + (local.x2 - local.x1) * k, y: local.y1 + (local.y2 - local.y1) * k };
  return (
    <div className="cnv-arrow" data-shape={id} data-type="arrow" style={{ left: x, top: y, width: w, height: h }}>
      <svg className="cnv-arrow__svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
        <line
          x1={local.x1}
          y1={local.y1}
          x2={end.x}
          y2={end.y}
          strokeDasharray={dashed ? "8 7" : undefined}
          className="cnv-arrow__line"
        />
        {len > 1 && <polygon className="cnv-arrow__head" points={arrowHead(local, head)} />}
      </svg>
      {label && !editingLabel && (
        <span className="cnv-arrow__label" style={{ left: (local.x1 + local.x2) / 2, top: (local.y1 + local.y2) / 2 }}>
          {label}
        </span>
      )}
    </div>
  );
});
