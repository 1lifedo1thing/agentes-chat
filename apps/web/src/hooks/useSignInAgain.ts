import { useSignOut } from "@/hooks/useSignOut";

/**
 * "Sign in again": a fresh sign-in is what adding a password takes. Out of this session, then to the sign-in page
 * with the address filled in, which comes back to this page as it is now (a dialog kept in the address opens again).
 */
export function useSignInAgain(email: string) {
  const { signOut } = useSignOut();
  // `add`: the sign-in shows even when another of the browser's accounts is the one in now (ADR 0183).
  return () => signOut({ redirect: `${window.location.pathname}${window.location.search}`, email, add: true });
}
