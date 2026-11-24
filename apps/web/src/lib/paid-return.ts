import type { OrgStanding } from "@agenteschat/client";
import { isPaidReturn, type PaidReturn, paidReturnOf, standingActive } from "@agenteschat/client/lib/billing";
import { useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { STORAGE_KEYS, sessionStore, storage } from "@/lib/storage";

/**
 * Back from a paid Checkout (`isPaidReturn`), until the hold lifts. Read from the address itself, since only some
 * routes keep `paid` in their search, and kept for the tab, since the first move to another page drops it.
 */
export function usePaidReturn(orgId: string, held: boolean) {
  const key = `${STORAGE_KEYS.paidReturn}.${orgId}`;
  const search = useSearch({ strict: false });
  const inAddress =
    isPaidReturn(search) || isPaidReturn(Object.fromEntries(new URLSearchParams(window.location.search)));
  useEffect(() => {
    if (!held) sessionStore.remove(key);
    else if (inAddress) sessionStore.set(key, "1");
  }, [held, inAddress, key]);
  return held && (inAddress || sessionStore.get(key) === "1");
}

/**
 * A moment shown keeps the same payment from showing it again for this long: a reload, Back or the billing service's
 * return opened twice. Past it, a paid return is a new payment (a plan bought again after it ended).
 */
export const PAID_MOMENT_ONCE_MS = 24 * 60 * 60_000;

const readPending = (key: string): PaidReturn | null => {
  const raw = sessionStore.get(key);
  if (raw === null) return null;
  try {
    return paidReturnOf({ ...(JSON.parse(raw) as Record<string, unknown>), paid: 1 });
  } catch {
    return null;
  }
};

/**
 * The moment right after a paid Checkout (ADR 0079): what the address said was bought, once the plan is in force.
 * The return is kept for the tab until then (the hold lifts on the billing service's next pass), and shown once per
 * payment: as it shows, this browser notes when, so a reload, Back or the same return again shows nothing. A plain
 * visit has no return to show. `moment` stays until `done`, whatever the address does meanwhile.
 */
export function usePaidMoment(orgId: string, standing: OrgStanding | undefined) {
  const pendingKey = `${STORAGE_KEYS.paidMoment}.${orgId}`;
  const shownKey = `${STORAGE_KEYS.paidMomentShown}.${orgId}`;
  const search = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>;
  const [shown, setShown] = useState<PaidReturn | null>(null);
  const seen = Number(storage.get(shownKey) ?? 0) > Date.now() - PAID_MOMENT_ONCE_MS;
  const pending = seen ? null : (paidReturnOf(search) ?? readPending(pendingKey));
  const due = shown === null && pending !== null && standingActive(standing);
  const pendingJson = pending && JSON.stringify(pending);
  useEffect(() => {
    if (pendingJson === null) return;
    if (!due) {
      sessionStore.set(pendingKey, pendingJson);
      return;
    }
    storage.set(shownKey, String(Date.now()));
    sessionStore.remove(pendingKey);
    setShown(JSON.parse(pendingJson) as PaidReturn);
  }, [due, pendingJson, pendingKey, shownKey]);
  const done = useCallback(() => setShown(null), []);
  return { moment: shown ?? (due ? pending : null), done };
}
