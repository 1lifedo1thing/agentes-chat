import { useMe } from "@agenteschat/client";
import { paidLine, planHeldNext } from "@agenteschat/client/lib/billing";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useRevealed } from "@/features/launch/launched";
import { useOpenDm } from "@/features/new/useOpenDm";
import { useDirectory } from "@/features/shared/hooks";
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
 * The plan just turned on: the team hops up happy on its sky, the purchase in one line, and the first conversation,
 * with the right hand, as the one way on.
 */
export function PaidMomentSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory();
  const openDm = useOpenDm();
  const lead = rightHandOf(dir.agents);
  return (
    <SheetScreen fit>
      <TeamSkyEmpty
        celebrate
        title={t(isPersonal(org) ? "paidMoment.titlePersonal" : "paidMoment.title")}
        text={paidLine(t, null, undefined)}
        action={
          lead ? (
            <Button
              variant="primary"
              wide
              label={t("paidMoment.next.talk", { name: lead.name })}
              onPress={() => {
                onClose();
                void openDm({ agentId: lead.id });
              }}
            />
          ) : undefined
        }
      />
    </SheetScreen>
  );
}
