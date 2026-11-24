# 0227. People hear when a computer stops answering, and when it is back

- Status: Accepted
- Date: 2026-11-24
- Amends: ADR 0071 §8 (two kinds in the `computers` notice category), ADR 0106 (a webhook call's next run waits
  a little), ADR 0161 (standby is never told as down)
- Code: db `packages/db/src/schema/machines.ts` (`machines.moving_at`, migration `0343_machine_moving`); engine
  `computer-down.ts` (`outageStart`, `queueDownChecks`, `noticeComputerDown`, `noticeComputerBack`,
  `machine.down_notice`), `machine-hub.ts` (`markOffline` queues the checks, `accept` tells the back, the hello clears
  `moving_at`), `machines.ts` (`setMachineMoving`), `notifications.ts` (`computer_down`, `computer_back`,
  `latest.since`, `runs`, `calls`), `notice-prefs.ts`, `push-messages.ts` + `push/messages/*`, `email.ts` + `email/words/*`
  (`computer_down`), `executor.ts` (`cliRetried`), `routine-hooks.ts` (`HOOK_RETRY_AFTER_MS`), `routine-events.ts`;
  server `operator/machines.ts` (`PUT /orgs/{orgId}/machines/{machineId}/moving`), `routes/app/notifications.ts`;
  client `lib/computer-outage.ts`, `lib/notifications.ts`; web `pages/NotificationsPage.tsx`,
  `components/NotificationParts.tsx`, `lib/push-open.ts`; phone `features/activity/ActivityScreen.tsx`,
  `features/links/logic.ts`

## Context

A computer the agents think on can go away: a host restarts it, a person's laptop loses its network, a runner stops.
The app showed a banner ("Computador desconectado") only to whoever had it open. Nobody else heard, so a workspace
whose agents answer outside the app (a webhook from a chat service, a routine at night) could wait for an hour without
anyone knowing. A run whose CLI failed once for a moment, and a webhook call whose runs failed in a burst, were lost
the same way.

## Decision

1. **Down.** Each socket close queues two checks (`machine.down_notice`): 10 minutes and 30 minutes later. Still away
   then, its outage began 10 minutes ago or more: who configures the workspace hears it (`computer_down`, inbox and
   push), and who connected a computer they brought. Once per outage (the row's key is the outage's start). From 30
   minutes, an email too, to those whose `computers` notices are on (self-hosted servers send it when they send
   email).
2. **An outage.** The last close, joined with every close before it the computer came back from for less than 30
   minutes, so a computer that flaps is one outage told once. An outage a "back" was told for is over: the next close
   starts another.
3. **Back.** At the computer's next hello, before what waited goes on: only the people told it was down hear it
   (`computer_back`), with how long it was away and the runs and webhook calls that waited; the "down" row is done. By
   email only to those emailed it was down.
4. **Never by plan.** No notice for a computer in standby (ADR 0161: it shows as online), for one the operator is
   moving to another host (`PUT …/moving`, `moving_at`: its hello on the new host ends it, `false` calls it off, and
   after 2 hours it counts as down again), nor in a workspace held, suspended or being deleted. A computer a person
   brought counts only while a run waits for it: one put away for the night is no outage.
5. **Retries.** A webhook call whose run failed goes back with a wait before its next run (1 minute, then 5, its line
   held meanwhile), so a few minutes of a computer, a sign-in or our server failing don't use its three runs. A
   computer turn whose CLI failed before anything ran (`cli_failed`, `cli_closed`, never one that refused to start)
   tries once more in the same run.

## Consequences

- When the server itself is down nobody can be told: that is the host's monitoring, not this.
- A computer whose closes rotated out of its last ten (`MACHINE_DISCONNECTS_KEPT`) may start a new outage early.
