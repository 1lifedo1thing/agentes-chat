import { Button } from "@agenteschat/ui";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

/**
 * The browser's page hands the person back to the desktop app through the app's `link` (the browser asks the first
 * time), once. The tab then tries to close as the app comes forward: browsers refuse it for a tab the system opened
 * that has moved on since (a provider's round trip), so the page also says so and keeps `OpenAppButton`. Not before
 * the window loses focus, or the closing tab would take the browser's "Open the app?" question with it.
 */
export function useBackToApp(link: string | null) {
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!link || sent.current === link) return;
    sent.current = link;
    window.location.assign(link);
    const close = () => window.close();
    window.addEventListener("blur", close, { once: true });
    return () => window.removeEventListener("blur", close);
  }, [link]);
}

/** The same link by hand, for a browser that didn't ask or a question the person dismissed. */
export function OpenAppButton({ link }: { link: string }) {
  const { t } = useTranslation();
  return (
    <Button asChild size="lg" block>
      <a href={link}>{t("auth.desktop.openApp")}</a>
    </Button>
  );
}
