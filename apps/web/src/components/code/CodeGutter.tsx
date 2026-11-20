import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";

/** A width kept on this device (per person: localStorage), within its bounds. */
export function useStoredWidth(key: string, min: number, max: number, start: number) {
  const read = () => {
    try {
      const v = Number(localStorage.getItem(key));
      return Number.isFinite(v) && v >= min && v <= max ? v : start;
    } catch {
      return start;
    }
  };
  const [width, setWidth] = useState(read);
  const save = (w: number) => {
    try {
      localStorage.setItem(key, String(w));
    } catch {}
  };
  return { width, setWidth, save, min, max, start };
}

/**
 * The drag between two of the Code page's surfaces (ADR 0208): it sets the width of the one on its left. Arrows move
 * it by 24 px, double click puts it back; the width is kept on this device.
 */
export function CodeGutter({
  label,
  size,
}: {
  label: string;
  size: ReturnType<typeof useStoredWidth>;
}) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.max(size.min, Math.min(size.max, w)));
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    start.current = { x: e.clientX, w: size.width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    size.setWidth(clamp(start.current.w + e.clientX - start.current.x));
  };
  const up = () => {
    if (start.current) size.save(size.width);
    start.current = null;
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable separator between two panes, as the live file's grip
    <div
      className="code-gutter"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={size.width}
      aria-valuemin={size.min}
      aria-valuemax={size.max}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => {
        size.setWidth(size.start);
        size.save(size.start);
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const next = clamp(size.width + (e.key === "ArrowLeft" ? -24 : 24));
        size.setWidth(next);
        size.save(next);
      }}
    />
  );
}
