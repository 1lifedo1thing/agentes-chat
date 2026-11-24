import type { OrgStanding } from "@agenteschat/client";
import { isPaidReturn, type PaidReturn, paidReturnOf, standingActive } from "@agenteschat/client/lib/billing";
import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
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
 * A moment shown keeps the same payment from showing it again for this long: the billing service's return opened
 * twice (a second tab, or Back through Checkout to it). A reload or Back inside the app finds no return at all, since
 * the address drops it as the moment shows. Past it, a paid return is a new payment.
 */
export const PAID_MOMENT_ONCE_MS = 30 * 60_000;

const readPending = (key: string): PaidReturn | null => {
  const raw = sessionStore.get(key);
  if (raw === null) return null;
  try {
    return paidReturnOf({ ...(JSON.parse(raw) as Record<string, unknown>), paid: 1 });
  } catch {
    return null;
  }
};

/** The address without a paid return's marks. */
const withoutPaid = ({ paid: _p, plan: _k, period: _d, ...rest }: Record<string, unknown>) => rest;

/**
 * The moment right after a paid Checkout (ADR 0079): what the address said was bought, once the plan is in force.
 * The return is kept for the tab until then (the hold lifts on the billing service's next pass), and shown once per
 * payment: as the plan is found in force, the return is used up (the address and the tab drop it) and this browser
 * notes when, so a reload, Back or the same return again shows nothing. A plain visit has no return to show. `moment`
 * stays until `done`, whatever the address does meanwhile, and only in the workspace it was paid for.
 */
export function usePaidMoment(orgId: string, standing: OrgStanding | undefined) {
  const pendingKey = `${STORAGE_KEYS.paidMoment}.${orgId}`;
  const shownKey = `${STORAGE_KEYS.paidMomentShown}.${orgId}`;
  const search = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>;
  const navigate = useNavigate();
  const [shown, setShown] = useState<{ orgId: string; moment: PaidReturn } | null>(null);
  const seen = Number(storage.get(shownKey) ?? 0) > Date.now() - PAID_MOMENT_ONCE_MS;
  const inAddress = paidReturnOf(search) !== null;
  const pending = paidReturnOf(search) ?? readPending(pendingKey);
  const active = standingActive(standing);
  const mine = shown?.orgId === orgId ? shown.moment : null;
  const due = mine === null && !seen && pending !== null && active;
  const pendingJson = pending && JSON.stringify(pending);
  useEffect(() => {
    if (pendingJson === null) return;
    if (!active) {
      sessionStore.set(pendingKey, pendingJson);
      return;
    }
    sessionStore.remove(pendingKey);
    if (due) {
      storage.set(shownKey, String(Date.now()));
      setShown({ orgId, moment: JSON.parse(pendingJson) as PaidReturn });
    }
    if (inAddress) void navigate({ to: ".", replace: true, search: withoutPaid as never });
  }, [active, due, inAddress, navigate, orgId, pendingJson, pendingKey, shownKey]);
  const done = useCallback(() => setShown(null), []);
  return { moment: mine ?? (due ? pending : null), done };
}
