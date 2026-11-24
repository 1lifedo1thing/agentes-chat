import type { Agent } from "@agenteschat/client";
import { type PaidReturn, paidLine } from "@agenteschat/client/lib/billing";
import { WORKSPACE_COMPUTER_KIND } from "@agenteschat/client/lib/computer";
import { firstName } from "@agenteschat/client/lib/format";
import { rightHandOf, sceneTeam } from "@agenteschat/client/lib/right-hand";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { Button, Chip, ComputerPortrait, cx, Dialog, DialogFooter, useDawn } from "@agenteschat/ui";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { usePlanOffer } from "@/lib/plan-offer";
import { type SceneAgent, TeamScene } from "./TeamScene";
import "./arrival.css";

/** How far into the dawn the computer turns on, and the team gets up (then greets). */
const COMPUTER_ON = 0.3;
const TEAM_UP = 0.6;

/**
 * Right after a paid Checkout (ADR 0079): night turns to day over the team, the workspace's computer turns on, the
 * agents get up one after another and greet the person who paid. Decorative, as every sky is: the words beside it
 * say the same. With reduced motion it is day at once.
 */
export function PaidScene({
  agents,
  name,
  className,
}: {
  agents: readonly (SceneAgent & Pick<Agent, "builtin">)[];
  /** The person who paid, greeted by their first name. */
  name: string | null | undefined;
  className?: string;
}) {
  const { t } = useTranslation();
  const [on, setOn] = useState(false);
  // The first frame is the night the team slept in: the dawn starts from it.
  useEffect(() => setOn(true), []);
  const day = useDawn(on);
  const lead = rightHandOf(agents);
  const team = sceneTeam(agents, lead).slice(0, 3);
  const up = day >= TEAM_UP;
  const first = firstName(name ?? "");
  return (
    <TeamScene
      className={cx("paid-scene", className)}
      agents={team}
      lead={lead?.id}
      asleep={!up}
      day={day}
      expression="happy"
    >
      <ComputerPortrait kind={WORKSPACE_COMPUTER_KIND} state={day >= COMPUTER_ON ? "online" : "paused"} />
      <Chip className="sky-chip paid-scene__hello" data-on={up ? "" : undefined}>
        {first ? t("paidMoment.hello", { first }) : t("paidMoment.hi")}
      </Chip>
    </TeamScene>
  );
}

/** The plan's name for what a paid return says it bought, and whether that is still being read. */
function usePaidLine(moment: PaidReturn) {
  const { t, i18n } = useTranslation();
  const named = usePlanOffer(i18n.language, { key: moment.plan, enabled: Boolean(moment.plan) });
  return { line: paidLine(t, named.offer?.name, moment.period), loading: named.loading };
}

/** The moment's title: a team's, or a personal workspace's. */
function useTitle() {
  const { t } = useTranslation();
  const { org } = useOrg();
  return t(isPersonal(org) ? "paidMoment.titlePersonal" : "paidMoment.title");
}

/**
 * The moment in full, where the workspace opens right after its onboarding (`?paid&arrival`): before the beta notice,
 * never over it. Every way out goes on (`onContinue`).
 */
export function PaidDialog({ moment, onContinue }: { moment: PaidReturn; onContinue: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const title = useTitle();
  const { line, loading } = usePaidLine(moment);
  const go = useRef<HTMLButtonElement>(null);
  // The plan's name comes with the dialog, never a line that changes under the person.
  if (loading) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onContinue()}
      title={title}
      closeLabel={t("common.close")}
      width={480}
      bare
      initialFocus={go}
      className="arrival arrival-paid"
    >
      <div className="arrival-hero">
        <PaidScene agents={dir.agents} name={me.user.name} />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          className="arrival-hero__close"
          aria-label={t("common.close")}
          onClick={onContinue}
        />
      </div>
      {/* The dialog's name is its hidden title; this is the same sentence, drawn. */}
      <div className="arrival-lede">
        <p className="arrival-lede__title" aria-hidden="true">
          {title}
        </p>
        <p className="arrival-lede__text">{line}</p>
      </div>
      <DialogFooter>
        <Button ref={go} variant="primary" kbd={["↵"]} onClick={onContinue}>
          {t("common.continue")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The moment's lighter form, anywhere else a paid return lands (Plan and billing in Settings, the hold's banner): a
 * card in the window's corner that leaves the page as it is, with the team waking on its band, the purchase in one
 * line and the one way on (`next`), until it is closed or used.
 */
export function PaidCard({
  moment,
  next,
  onClose,
}: {
  moment: PaidReturn;
  next: { label: string; run: () => void } | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const title = useTitle();
  const titleId = useId();
  const { line, loading } = usePaidLine(moment);
  if (loading) return null;
  // Over the page, outside the shell's own layers: the next dialog stacks above it, as a later portal.
  return createPortal(
    // Polite: read out as it comes, never over what is being read.
    <section className="paid-card" aria-labelledby={titleId} aria-live="polite">
      <div className="paid-card__band">
        <PaidScene agents={dir.agents} name={me.user.name} />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          className="arrival-hero__close"
          aria-label={t("common.close")}
          onClick={onClose}
        />
      </div>
      <div className="paid-card__body">
        <h2 id={titleId} className="paid-card__title">
          {title}
        </h2>
        <p className="paid-card__line">{line}</p>
        {next && (
          <Button
            variant="primary"
            size="sm"
            className="paid-card__go"
            title={next.label}
            onClick={() => {
              next.run();
              onClose();
            }}
          >
            {next.label}
          </Button>
        )}
      </div>
    </section>,
    document.body,
  );
}
