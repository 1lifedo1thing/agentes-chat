import { useAiStatus, useMe } from "@agenteschat/client";
import { paidLine, planHeldNext } from "@agenteschat/client/lib/billing";
import { mayConnectAi, teamThinks } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { openConnectAi } from "@/features/ai/NoAiCard";
import { useRevealed } from "@/features/launch/launched";
import { useOpenDm } from "@/features/new/useOpenDm";
import { useDirectory, useMeId } from "@/features/shared/hooks";
import { TeamSkyEmpty } from "@/features/shared/TeamSkyEmpty";
import { readValueSync, STORED, writeValueSync } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import { Button, SheetScreen } from "@/ui";
import { router } from "@/ui/navigation";

const heldList = (): string[] => {
  try {
    const v: unknown = JSON.parse(readValueSync(STORED.planHeld) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/**
 * The web's moment right after paying (ADR 0079), on the phone, which never sees the billing service's return: the
 * first time it opens a workspace whose plan turned on since it last looked (`planHeldNext`), the sheet opens once
 * the app is in view. Never on a first look at a workspace.
 */
export function usePlanTurnedOn() {
  const orgs = useMe().data?.organizations;
  const { orgId } = useOrg();
  const revealed = useRevealed();
  useEffect(() => {
    if (!orgs || !revealed) return;
    const before = heldList();
    const next = planHeldNext(before, orgs, orgId);
    if (next.held.join() !== before.join()) writeValueSync(STORED.planHeld, JSON.stringify(next.held));
    if (next.turnedOn) router.push("/paid-moment");
  }, [orgs, orgId, revealed]);
}

/**
 * The plan just turned on: the team hops up happy on its sky, the purchase in one line, and the web's one way on: an
 * AI for the team to think with while it has none and the person may connect one, else the first conversation, with
 * the right hand. The button waits for the AI status, so it never changes under the person.
 */
export function PaidMomentSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { org, orgId } = useOrg();
  const dir = useDirectory();
  const status = useAiStatus(orgId);
  const meId = useMeId();
  const openDm = useOpenDm();
  const lead = rightHandOf(dir.agents);
  const thinks = teamThinks(
    dir.agents.map((a) => a.id),
    status.data,
  );
  const toConnect = thinks === false && (can(org, "create_agents") || mayConnectAi(lead, meId, org));
  const next =
    thinks === undefined
      ? null
      : toConnect
        ? { label: t("paidMoment.next.ai"), run: () => openConnectAi({}) }
        : lead
          ? { label: t("paidMoment.next.talk", { name: lead.name }), run: () => void openDm({ agentId: lead.id }) }
          : null;
  return (
    <SheetScreen fit>
      <TeamSkyEmpty
        celebrate
        title={t(isPersonal(org) ? "paidMoment.titlePersonal" : "paidMoment.title")}
        text={paidLine(t, null, undefined)}
        action={
          next ? (
            <Button
              variant="primary"
              wide
              label={next.label}
              onPress={() => {
                onClose();
                next.run();
              }}
            />
          ) : undefined
        }
      />
    </SheetScreen>
  );
}
