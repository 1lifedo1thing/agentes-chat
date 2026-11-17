import { formatPercent } from "@agenteschat/client/lib/format";
import { type CanvasShapeKind, NOTE_COLORS, type NoteColor, type ShapeView } from "@agenteschat/live/canvas";
import { Button, cx, type IconName, Menu, MenuItem, MenuSeparator } from "@agenteschat/ui";
import { type CSSProperties, type KeyboardEvent, useRef } from "react";
import { useTranslation } from "react-i18next";
import { CAMERA_MAX, CAMERA_MIN } from "./camera";
import { SOFT, softName } from "./palette";

/**
 * The canvas's floating controls (ADR 0191 §2): the tools dock at the bottom, the zoom island at the bottom right, and
 * the small bar over a chosen note, text, shape, frame or arrow. Glass, over the plane, out of the way of the shapes.
 */

export type Tool = "select" | "hand" | "note" | "text" | "shape" | "arrow" | "frame";

interface ToolDef {
  tool: Tool | "image";
  icon: IconName;
  key: string;
}

/** The tools in the dock, with their keys (single letters: the desktop app keeps the ⌘ ones). */
export const TOOLS: readonly ToolDef[] = [
  { tool: "select", icon: "pointerTool", key: "V" },
  { tool: "hand", icon: "hand", key: "H" },
  { tool: "note", icon: "sticky", key: "N" },
  { tool: "text", icon: "textTool", key: "T" },
  { tool: "shape", icon: "shape", key: "R" },
  { tool: "arrow", icon: "arrowTool", key: "A" },
  { tool: "frame", icon: "frame", key: "F" },
  { tool: "image", icon: "image", key: "I" },
];

/** Arrow keys move along a toolbar's buttons (one tab stop for the whole bar). */
export function rovingKeys(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])")];
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? items.length - 1
        : (at + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}

export function Dock({
  tool,
  readOnly,
  canGenerate,
  onTool,
  onImage,
  onGenerate,
}: {
  tool: Tool;
  readOnly: boolean;
  /** Whether "Generate image" shows (it explains itself when there is no key). */
  canGenerate: boolean;
  onTool(tool: Tool): void;
  onImage(): void;
  onGenerate(): void;
}) {
  const { t } = useTranslation();
  const tools = readOnly ? TOOLS.filter((d) => d.tool === "select" || d.tool === "hand") : TOOLS;
  return (
    <div className="cnv-dock ac-glass" role="toolbar" aria-label={t("live.canvas.tools.label")} onKeyDown={rovingKeys}>
      {tools.map((d) => {
        const name = t(`live.canvas.tools.${d.tool}`);
        const active = d.tool === tool;
        return (
          <Button
            key={d.tool}
            variant="ghost"
            iconOnly
            icon={d.icon}
            className="cnv-dock__tool"
            aria-label={name}
            title={`${name} (${d.key})`}
            aria-pressed={d.tool === "image" ? undefined : active}
            data-active={active || undefined}
            tabIndex={active || (d.tool === "select" && tool === "hand" && readOnly) ? 0 : -1}
            onClick={() => (d.tool === "image" ? onImage() : onTool(d.tool))}
          />
        );
      })}
      {!readOnly && canGenerate && (
        <>
          <span className="cnv-dock__divider" aria-hidden="true" />
          <Button
            variant="agent"
            icon="sparkle"
            className="cnv-dock__gen"
            title={`${t("live.canvas.tools.generate")} (G)`}
            tabIndex={-1}
            onClick={onGenerate}
          >
            <span className="cnv-dock__gen-words">{t("live.canvas.tools.generate")}</span>
          </Button>
        </>
      )}
    </div>
  );
}

export function ZoomIsland({
  zoom,
  onStep,
  onActual,
  onFit,
  canFit,
}: {
  zoom: number;
  onStep(dir: 1 | -1): void;
  onActual(): void;
  onFit(): void;
  canFit: boolean;
}) {
  const { t, i18n } = useTranslation();
  const percent = formatPercent(i18n.language, Math.round(zoom * 100));
  return (
    <div className="cnv-zoom ac-glass" role="toolbar" aria-label={t("live.canvas.zoom.label")} onKeyDown={rovingKeys}>
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="dash"
        aria-label={t("live.canvas.zoom.out")}
        title={`${t("live.canvas.zoom.out")} (-)`}
        disabled={zoom <= CAMERA_MIN + 1e-3}
        onClick={() => onStep(-1)}
      />
      <Button
        size="sm"
        variant="ghost"
        className="cnv-zoom__level tabular"
        aria-label={t("live.canvas.zoom.actual")}
        title={t("live.canvas.zoom.actual")}
        tabIndex={-1}
        onClick={onActual}
      >
        {percent}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="plus"
        aria-label={t("live.canvas.zoom.in")}
        title={`${t("live.canvas.zoom.in")} (=)`}
        tabIndex={-1}
        disabled={zoom >= CAMERA_MAX - 1e-3}
        onClick={() => onStep(1)}
      />
      <Button
        size="sm"
        variant="ghost"
        tabIndex={-1}
        disabled={!canFit}
        title={`${t("live.canvas.zoom.fitAll")} (⇧1)`}
        onClick={onFit}
      >
        {t("live.canvas.zoom.fit")}
      </Button>
    </div>
  );
}

/** Text sizes a text box offers (world units). */
export const TEXT_SIZES = [
  { size: 16, key: "s" },
  { size: 24, key: "m" },
  { size: 40, key: "l" },
  { size: 64, key: "xl" },
] as const;

export type ShapeBarAction =
  | { kind: "color"; color: NoteColor }
  | { kind: "fill"; color: NoteColor | null }
  | { kind: "size"; size: number }
  | { kind: "shapeKind"; shapeKind: CanvasShapeKind }
  | { kind: "dashed"; dashed: boolean }
  | { kind: "label" }
  | { kind: "rename" }
  | { kind: "arrange"; how: "front" | "forward" | "backward" | "back" }
  | { kind: "duplicate" }
  | { kind: "lock"; locked: boolean }
  | { kind: "delete" };

/**
 * The small bar over a chosen shape (or a few of one type): a note's color, a text's size, a shape's form and fill,
 * an arrow's line and words, a frame's name; then the stacking menu and delete.
 */
export function ShapeBar({
  shapes,
  style,
  onAction,
}: {
  shapes: ShapeView[];
  style: CSSProperties;
  onAction(action: ShapeBarAction): void;
}) {
  const { t } = useTranslation();
  const bar = useRef<HTMLDivElement>(null);
  const first = shapes[0];
  if (!first) return null;
  const same = shapes.every((s) => s.type === first.type);
  const type = same ? first.type : null;
  const locked = shapes.every((s) => s.locked);
  const swatches = (current: NoteColor | null, pick: (c: NoteColor) => void, label: string) => (
    <div className="cnv-bar__swatches" role="radiogroup" aria-label={label}>
      {NOTE_COLORS.map((c) => (
        // biome-ignore lint/a11y/useSemanticElements: a swatch button in a radio group
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={current === c}
          aria-label={t(`live.canvas.colors.${c}`)}
          title={t(`live.canvas.colors.${c}`)}
          className="cnv-bar__swatch"
          data-color={c}
          style={{ "--swatch": SOFT[c].light, "--swatch-dark": SOFT[c].dark } as CSSProperties}
          onClick={() => pick(c)}
        />
      ))}
    </div>
  );
  return (
    <div
      ref={bar}
      className="cnv-bar ac-glass"
      role="toolbar"
      aria-label={t("live.canvas.bar.title")}
      style={style}
      onKeyDown={rovingKeys}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {type === "note" &&
        swatches(
          same && shapes.every((s) => s.color === first.color) ? (first.color ?? "yellow") : null,
          (c) => onAction({ kind: "color", color: c }),
          t("live.canvas.bar.color"),
        )}
      {type === "shape" && (
        <>
          {(["rect", "ellipse", "diamond"] as const).map((k) => (
            <Button
              key={k}
              size="sm"
              variant="ghost"
              iconOnly
              className="cnv-bar__kind"
              aria-label={t(`live.canvas.shapeKinds.${k}`)}
              title={t(`live.canvas.shapeKinds.${k}`)}
              aria-pressed={shapes.every((s) => (s.kind ?? "rect") === k)}
              onClick={() => onAction({ kind: "shapeKind", shapeKind: k })}
            >
              <KindGlyph kind={k} />
            </Button>
          ))}
          <span className="cnv-bar__divider" aria-hidden="true" />
          {swatches(softName(first.fill), (c) => onAction({ kind: "fill", color: c }), t("live.canvas.bar.fill"))}
        </>
      )}
      {type === "text" && (
        <div className="cnv-bar__sizes" role="radiogroup" aria-label={t("live.canvas.bar.size")}>
          {TEXT_SIZES.map((s) => (
            // biome-ignore lint/a11y/useSemanticElements: a size button in a radio group
            <button
              key={s.key}
              type="button"
              role="radio"
              className="cnv-bar__size"
              aria-checked={shapes.every((sh) => (sh.style?.size ?? 24) === s.size)}
              aria-label={t(`live.canvas.sizes.${s.key}`)}
              title={t(`live.canvas.sizes.${s.key}`)}
              onClick={() => onAction({ kind: "size", size: s.size })}
            >
              {t(`live.canvas.sizes.short.${s.key}`)}
            </button>
          ))}
        </div>
      )}
      {type === "arrow" && (
        <>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={shapes.every((s) => s.dashed)}
            onClick={() => onAction({ kind: "dashed", dashed: !shapes.every((s) => s.dashed) })}
          >
            {t("live.canvas.bar.dashed")}
          </Button>
          {shapes.length === 1 && (
            <Button size="sm" variant="ghost" onClick={() => onAction({ kind: "label" })}>
              {t("live.canvas.bar.label")}
            </Button>
          )}
        </>
      )}
      {type === "frame" && shapes.length === 1 && (
        <Button size="sm" variant="ghost" icon="edit" onClick={() => onAction({ kind: "rename" })}>
          {t("live.canvas.bar.rename")}
        </Button>
      )}
      {type && type !== "arrow" && <span className="cnv-bar__divider" aria-hidden="true" />}
      <Menu
        label={t("live.canvas.arrange.label")}
        align="end"
        trigger={
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="layers"
            aria-label={t("live.canvas.arrange.label")}
            title={t("live.canvas.arrange.label")}
          />
        }
      >
        <MenuItem onSelect={() => onAction({ kind: "arrange", how: "front" })}>
          {t("live.canvas.arrange.front")}
        </MenuItem>
        <MenuItem onSelect={() => onAction({ kind: "arrange", how: "forward" })}>
          {t("live.canvas.arrange.forward")}
        </MenuItem>
        <MenuItem onSelect={() => onAction({ kind: "arrange", how: "backward" })}>
          {t("live.canvas.arrange.backward")}
        </MenuItem>
        <MenuItem onSelect={() => onAction({ kind: "arrange", how: "back" })}>{t("live.canvas.arrange.back")}</MenuItem>
        <MenuSeparator />
        <MenuItem icon="copy" onSelect={() => onAction({ kind: "duplicate" })}>
          {t("live.canvas.actions.duplicate")}
        </MenuItem>
        <MenuItem icon="lock" onSelect={() => onAction({ kind: "lock", locked: !locked })}>
          {locked ? t("live.canvas.actions.unlock") : t("live.canvas.actions.lock")}
        </MenuItem>
      </Menu>
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="trash"
        className={cx("cnv-bar__delete")}
        aria-label={t("live.canvas.actions.delete")}
        title={t("live.canvas.actions.delete")}
        onClick={() => onAction({ kind: "delete" })}
      />
    </div>
  );
}

/** A shape's form as a glyph in the icons' grid (20, stroke 1.6). */
function KindGlyph({ kind }: { kind: CanvasShapeKind }) {
  return (
    <svg className="ac-icon" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      {kind === "ellipse" ? (
        <ellipse cx="10" cy="10" rx="6.5" ry="5.5" />
      ) : kind === "diamond" ? (
        <path d="M10 3.5 16.5 10 10 16.5 3.5 10z" />
      ) : (
        <rect x="3.5" y="5" width="13" height="10" rx="1.75" />
      )}
    </svg>
  );
}
