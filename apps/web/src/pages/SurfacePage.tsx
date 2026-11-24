import {
  type SurfacePage as Page,
  useDecideSurfacePage,
  useForgotSurfacePin,
  useSurfacePage,
} from "@agenteschat/client";
import { approvalTitle } from "@agenteschat/client/lib/approval-words";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { Button, Icon, Input, Locked } from "@agenteschat/ui";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthShell } from "@/components/AuthLayout";

const PIN = /^\d{6}$/;

/**
 * A page the outside chat surface linked to (ADR 0226): one action the person confirms with their PIN, in the sign-in
 * screen's calm style. Opened by posting its token (a chat app's preview only loads the page), it stays this
 * browser's for an hour. The first approval chooses the PIN, typed twice; it is never sent in the chat.
 */
export function SurfacePage({ token }: { token?: string }) {
  const { t } = useTranslation();
  const page = useSurfacePage(token);
  const view = page.data;
  const shown = view?.approval ?? null;
  const ended = !token || page.isError || (view && (!shown || view.kind !== "confirm"));

  if (!view && !ended) {
    return (
      <AuthShell>
        <div className="auth__form">
          <header className="auth__ask">
            <AgentAvatar name="agentes.chat" size="lg" state="writing" />
            <div className="auth__bubble" aria-live="polite">
              <h1 className="auth__title">{t("surface.page.opening")}</h1>
            </div>
          </header>
        </div>
      </AuthShell>
    );
  }
  if (!view || !shown || ended) {
    const lead = page.isError ? errorText(t, page.error) : t("errors.surface.pageGone");
    return <Said title={t("surface.page.gone")} lead={lead} />;
  }
  const title = approvalTitle(t, { tool: shown.tool, title: shown.title, params: shown.params, email: null });
  if (shown.status !== "pending") {
    const decided =
      shown.status === "approved"
        ? t("surface.page.approved")
        : shown.status === "refused"
          ? t("surface.page.refused")
          : t("surface.page.expired");
    return (
      <Said
        title={decided}
        lead={t("surface.page.back", { surface: view.surface })}
        happy={shown.status === "approved"}
      />
    );
  }
  if (!shown.canDecide) {
    const lead = shown.approverLabel
      ? t("surface.page.notYours", { who: shown.approverLabel })
      : t("surface.page.notYoursSomeone");
    return <Said title={title} lead={lead} />;
  }
  return <Confirm token={token ?? ""} view={view} title={title} />;
}

function Said({ title, lead, happy }: { title: string; lead: string; happy?: boolean }) {
  return (
    <AuthShell>
      <div className="auth__form">
        <header className="auth__ask">
          <AgentAvatar name="agentes.chat" size="lg" expression={happy ? "happy" : undefined} />
          <div className="auth__bubble" key={title} aria-live="polite">
            <h1 className="auth__title">{title}</h1>
            <p className="auth__lead">{lead}</p>
          </div>
        </header>
      </div>
    </AuthShell>
  );
}

function Confirm({ token, view, title }: { token: string; view: Page; title: string }) {
  const { t } = useTranslation();
  const decide = useDecideSurfacePage(token);
  const forgot = useForgotSurfacePin(token);
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [focus, setFocus] = useState(false);
  const choosing = !view.pin.set;
  const mismatch = choosing && again.length === 6 && again !== pin;
  const locked = view.pin.lockedUntil !== null || errorCode(decide.error) === "surface.pin_locked";
  const ready = PIN.test(pin) && (!choosing || again === pin) && !locked;
  const busy = decide.isPending || forgot.isPending;
  const digits = (set: (v: string) => void) => (e: { target: { value: string } }) =>
    set(e.target.value.replace(/\D/g, "").slice(0, 6));
  const approve = (e: FormEvent) => {
    e.preventDefault();
    if (ready && !busy) decide.mutate({ decision: "approve", pin }, { onError: () => setPin("") });
  };
  const error = mismatch
    ? t("surface.page.mismatch")
    : locked
      ? t("errors.surface.pinLocked")
      : decide.isError
        ? errorText(t, decide.error)
        : forgot.isError
          ? errorText(t, forgot.error)
          : null;

  return (
    <AuthShell>
      <form className="auth__form" onSubmit={approve} noValidate>
        <header className="auth__ask">
          <AgentAvatar
            name="agentes.chat"
            size="lg"
            state={busy ? "writing" : undefined}
            expression={focus ? "closed" : undefined}
          />
          <div className="auth__bubble" aria-live="polite">
            <h1 className="auth__title">{title}</h1>
            <p className="auth__lead">
              {choosing ? t("surface.page.leadFirst", { surface: view.surface }) : t("surface.page.lead")}
            </p>
            {view.approval?.why && <p className="auth__lead">{view.approval.why}</p>}
          </div>
        </header>
        <div className="auth__step">
          <Locked when={busy}>
            <div className="auth__field">
              <Input
                className="auth__big"
                type="password"
                inputMode="numeric"
                autoComplete={choosing ? "new-password" : "current-password"}
                maxLength={6}
                aria-label={choosing ? t("surface.page.choosePin") : t("surface.page.pin")}
                placeholder={choosing ? t("surface.page.choosePin") : t("surface.page.pin")}
                value={pin}
                onChange={digits(setPin)}
                onFocus={() => setFocus(true)}
                onBlur={() => setFocus(false)}
                disabled={locked}
                autoFocus
              />
            </div>
            {choosing && (
              <div className="auth__field">
                <Input
                  className="auth__big"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  maxLength={6}
                  aria-label={t("surface.page.repeatPin")}
                  placeholder={t("surface.page.repeatPin")}
                  value={again}
                  onChange={digits(setAgain)}
                  aria-invalid={mismatch || undefined}
                  disabled={locked}
                />
              </div>
            )}
            {error && (
              <p className="auth__error ac-iconline" role="alert">
                <Icon name="alert" size={14} />
                {error}
              </p>
            )}
            {forgot.isSuccess && (
              <p className="auth__lead" role="status">
                {t("surface.page.emailed")}
              </p>
            )}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              block
              kbd={["↵"]}
              loading={decide.isPending}
              disabled={!ready}
            >
              {t("surface.page.approve")}
            </Button>
            <Button
              type="button"
              variant="default"
              size="lg"
              block
              onClick={() => decide.mutate({ decision: "refuse" })}
            >
              {t("surface.page.refuse")}
            </Button>
            {!choosing && view.pin.resetByEmail && !forgot.isSuccess && (
              <Button type="button" variant="ghost" size="sm" onClick={() => forgot.mutate()}>
                {t("surface.page.forgot")}
              </Button>
            )}
          </Locked>
        </div>
      </form>
    </AuthShell>
  );
}
