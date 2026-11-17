import { useApi } from "@agenteschat/client";
import type { CanvasPreview, CanvasPreviewShape, NoteColor } from "@agenteschat/live/canvas";
import { NOTE_COLORS } from "@agenteschat/live/canvas";
import { useDarkTheme } from "@agenteschat/ui";
import { useOrgIfAny } from "@/components/org-context";
import { SOFT } from "./palette";
import "./canvas.css";

/**
 * A canvas drawn small, for its cards (the Drive, a message, Ask an agent's context) from the preview the server
 * keeps (ADR 0191 §7: the bounds and up to 40 of the biggest shapes): frames, notes in their color, pictures (when
 * the card says which file they belong to), text as lines, shapes, arrows. Decoration: the card's words name it.
 */
export function CanvasMini({ preview, fileId }: { preview: CanvasPreview; fileId?: string }) {
  const api = useApi();
  const org = useOrgIfAny();
  const dark = useDarkTheme();
  const bounds = preview.bounds;
  if (!bounds || !preview.shapes.length) {
    return <div className="cnv-mini cnv-mini--empty" data-bg={preview.bg} aria-hidden="true" />;
  }
  const pad = Math.max(bounds.w, bounds.h) * 0.06 + 8;
  const box = { x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + 2 * pad, h: bounds.h + 2 * pad };
  const url = (asset: string) => (org && fileId ? api.live.assetUrl(org.org.id, fileId, asset) : null);
  // Frames first, then the rest as the preview lists them (the biggest first): what is inside frames shows on them.
  const shapes = [...preview.shapes].sort((a, b) => Number(b.type === "frame") - Number(a.type === "frame"));
  return (
    <div className="cnv-mini" data-bg={preview.bg} aria-hidden="true">
      <svg
        className="cnv-mini__svg"
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="presentation"
      >
        {shapes.map((s) => (
          <MiniShape key={s.id} shape={s} dark={dark} url={s.asset ? url(s.asset) : null} unit={box.w / 240} />
        ))}
      </svg>
    </div>
  );
}

function noteFill(color: string | undefined, dark: boolean): string {
  const name = (NOTE_COLORS as readonly string[]).includes(color ?? "") ? (color as NoteColor) : "yellow";
  return dark ? SOFT[name].dark : SOFT[name].light;
}

function MiniShape({
  shape: s,
  dark,
  url,
  unit,
}: {
  shape: CanvasPreviewShape;
  dark: boolean;
  url: string | null;
  /** About a pixel of the card, in world units. */
  unit: number;
}) {
  const turn = s.rot ? `rotate(${s.rot} ${s.x + s.w / 2} ${s.y + s.h / 2})` : undefined;
  switch (s.type) {
    case "frame":
      return (
        <rect
          className="cnv-mini__frame"
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          rx={Math.min(12, s.w / 8)}
          vectorEffect="non-scaling-stroke"
        />
      );
    case "note":
      return <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={6} fill={noteFill(s.color, dark)} transform={turn} />;
    case "image":
      return url ? (
        <image
          href={url}
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          preserveAspectRatio="xMidYMid slice"
          transform={turn}
        />
      ) : (
        <rect className="cnv-mini__picture" x={s.x} y={s.y} width={s.w} height={s.h} rx={8} transform={turn} />
      );
    case "pending":
      return <rect className="cnv-mini__pending" x={s.x} y={s.y} width={s.w} height={s.h} rx={8} />;
    case "text": {
      // Words as lines: as many as the box holds, at least one.
      const line = Math.max(unit * 3, Math.min(24, s.h / 2));
      const rows = Math.max(1, Math.min(4, Math.floor(s.h / (line * 1.6))));
      return (
        <g transform={turn}>
          {Array.from({ length: rows }, (_, i) => (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: lines of one box, fixed
              key={i}
              className="cnv-mini__words"
              x={s.x}
              y={s.y + i * line * 1.6}
              width={i === rows - 1 && rows > 1 ? s.w * 0.6 : s.w}
              height={line}
              rx={line / 2}
            />
          ))}
        </g>
      );
    }
    case "arrow":
      return s.line ? (
        <line
          className="cnv-mini__arrow"
          x1={s.line.x1}
          y1={s.line.y1}
          x2={s.line.x2}
          y2={s.line.y2}
          vectorEffect="non-scaling-stroke"
        />
      ) : null;
    case "shape":
      return (
        <rect
          className="cnv-mini__shape"
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          rx={4}
          style={s.color ? { fill: dark ? undefined : s.color } : undefined}
          transform={turn}
          vectorEffect="non-scaling-stroke"
        />
      );
    default:
      return (
        <rect
          className="cnv-mini__card"
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          rx={10}
          transform={turn}
          vectorEffect="non-scaling-stroke"
        />
      );
  }
}
