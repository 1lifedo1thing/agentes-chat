import { type CSSProperties, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePageRoom } from "@/components/live/room";
import { CodeGutter, useStoredSize } from "./CodeGutter";
import { CodeList } from "./CodeList";
import "./code.css";

/**
 * The room a session needs beside the list: its conversation and its panel at a comfortable width each. Under it, the
 * app's sidebar folds to its rail, as beside a live file's conversation.
 */
const SESSION_ROOM_MIN = 860;

/**
 * The Code page (ADR 0208): the list of the sessions I take part in, and beside it the home (start one) or a session.
 * Surfaces on the app's background; the gutter after the list drags its width. A session squeezed by the window folds
 * the app's sidebar until the room comes back (`usePageRoom`).
 */
export function CodePage({ activeId, children }: { activeId: string | null; children: ReactNode }) {
  const { t } = useTranslation();
  const list = useStoredSize("code:listWidth", 220, 460, 296);
  const [main, setMain] = useState<HTMLElement | null>(null);
  usePageRoom(main, activeId !== null, SESSION_ROOM_MIN);
  return (
    <main className="shell__main shell__main--chat code-page">
      <div className="code" style={{ "--code-list": `${list.size}px` } as CSSProperties}>
        <CodeList activeId={activeId} />
        <CodeGutter label={t("codeSessions.list.resize")} size={list} />
        <section className="code-main" ref={setMain}>
          {children}
        </section>
      </div>
    </main>
  );
}
