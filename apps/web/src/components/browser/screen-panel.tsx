import { Button, Icon, type IconName } from "@agenteschat/ui";
import { createContext } from "react";
import { useTranslation } from "react-i18next";

/**
 * A page that shows the agent's screen in a panel of its own (a code session's Screen, ADR 0208): there the
 * conversation's browser and desktop cards are one line that opens it, and the panel turns to the screen as the agent
 * starts using it.
 */
export const ScreenPanelContext = createContext<{ show: () => void } | null>(null);

/** In such a page, a browser or desktop card's line: what the agent did there last, and the way to the screen. */
export function ScreenLine({ icon, text, onShow }: { icon: IconName; text: string; onShow: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="code-screenline">
      <Icon name={icon} size={16} />
      <span className="code-screenline__t">{text}</span>
      <Button size="sm" variant="ghost" onClick={onShow}>
        {t("codeSessions.screenLine.show")}
      </Button>
    </div>
  );
}
