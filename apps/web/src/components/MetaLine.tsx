import { Fragment, type ReactNode } from "react";

const SEP = " · ";

/**
 * A header's meta line under its title ("#eng · entre agentes · 4 mensagens"): one "·" between parts, every gap the
 * line's own. A part's text that carries its own " · " (a translated "#{{channel}} · …") splits into parts too, or that
 * dot would sit a space's width from its words instead of the line's gap. The `where` parts shorten first and go on a
 * narrow panel (`.thread-head__where`), the rest never shorten.
 */
export function MetaLine({ where, parts = [] }: { where?: string | null; parts?: ReactNode[] }) {
  const items: [ReactNode, boolean][] = [
    ...(where ? where.split(SEP).map((w): [ReactNode, boolean] => [w, true]) : []),
    ...parts.flatMap((p): [ReactNode, boolean][] =>
      typeof p === "string" ? p.split(SEP).map((s) => [s, false]) : p == null || p === false ? [] : [[p, false]],
    ),
  ];
  return (
    <span className="channel__topic thread-head__meta">
      {items.map(([item, isWhere], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one line, in a fixed order
        <Fragment key={i}>
          {i > 0 && <span aria-hidden="true">·</span>}
          {typeof item === "string" ? <span className={isWhere ? "thread-head__where" : undefined}>{item}</span> : item}
        </Fragment>
      ))}
    </span>
  );
}
