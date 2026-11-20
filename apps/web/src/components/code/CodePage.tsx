import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CodeGutter, useStoredSize } from "./CodeGutter";
import { CodeList } from "./CodeList";
import "./code.css";

/**
 * The Code page (ADR 0208): the list of the sessions I take part in, and beside it the home (start one) or a session.
 * Surfaces on the app's background; the gutter after the list drags its width.
 */
export function CodePage({ activeId, children }: { activeId: string | null; children: ReactNode }) {
  const { t } = useTranslation();
  const list = useStoredSize("code:listWidth", 220, 460, 296);
  return (
    <main className="shell__main shell__main--chat code-page">
      <div className="code" style={{ "--code-list": `${list.size}px` } as CSSProperties}>
        <CodeList activeId={activeId} />
        <CodeGutter label={t("codeSessions.list.resize")} size={list} />
        <section className="code-main">{children}</section>
      </div>
    </main>
  );
}
