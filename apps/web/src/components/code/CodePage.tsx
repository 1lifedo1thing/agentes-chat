import type { ReactNode } from "react";
import { CodeList } from "./CodeList";
import "./code.css";

/**
 * The Code page (ADR 0208): the list of the sessions I take part in, and beside it the home (start one) or a session.
 * Surfaces on the app's background, with gutters between them.
 */
export function CodePage({ activeId, children }: { activeId: string | null; children: ReactNode }) {
  return (
    <main className="shell__main shell__main--chat code-page">
      <div className="code">
        <CodeList activeId={activeId} />
        <section className="code-main">{children}</section>
      </div>
    </main>
  );
}
