# 0226. Confirming from an outside chat surface: a PIN, and page links with short lives

- Status: Accepted
- Date: 2026-11-24
- Extends: ADR 0187 (outside chat surfaces; its §6 refusals and its "Later"), ADR 0015 (approvals)
- Code: db `packages/db/src/schema/surfaces.ts` (`surface_links.pin_hash`, `pin_failures`, `pin_locked_until`;
  `surface_page_links`), migration 0340; engine `packages/engine/src/surfaces/turn.ts` (`surfaceGate`, called by the
  tool gateway), `pages.ts` (`mintPageLink`, `openSurfacePage`, `checkPin`, `decideOnSurfacePage`, `emailPinReset`,
  `resetSurfacePin`, `prunePageLinks`), `deliveries.ts` (an approval's card opens its page); the `surface_pin_reset`
  email; routes `apps/server/src/routes/app/surfaces.ts` (`/surface-page/open`, `/surface-page/decide`,
  `/surface-page/forgot-pin`, `/surface-pin-reset`); web `apps/web/src/pages/SurfacePage.tsx` (`/surface-page`) and
  `SurfacePinResetPage` (`/email-undo?kind=surface-pin`)

## Context

ADR 0187 §6 refuses, on a surface turn, everything that needs a person's say or that deletes, sends, pays, or changes
roles, budgets or money: what someone types on a chat app proves nothing about who typed it, and a card can't be
answered there. People asked from the chat app are told to open the app, which they mostly don't have open. The
operator's design for the chat service settled the rest: a six-digit PIN, chosen the first time one is needed, typed
in a hidden field and never in the chat; three wrong ones lock it for 15 minutes; a forgotten one is reset by email.
Links to our pages open once within 10 minutes, then stay open for an hour (an agent's screen 30 minutes, control 15),
and end early on an unlink, a password change or lost access. A chat app keeps a sent button forever, so the short
first open is what makes an old message safe.

The chat app's own native form (where the chat app offers one) waits on the chat app's business verification. A page
of ours works with any chat app on the day the bridge is on, and stays as the fallback once a native form exists.

## Decision

### 1. What a surface turn confirms instead of refusing
`surfaceGate` replaces `surfaceRefusal`. On the right hand's own surface turn (the run's latest person message came
through the bridge), a call of class `approval`, `sends_deletes_pays` or `roles_budgets_money` becomes an approval
request instead of a refusal:
- An act that would run without asking anyone in the app (its level, "Aprovar sempre", an allowed merge repository,
  a routine's own job) asks the person behind the turn alone: `approvers` names them, `requesterDecides` and
  `required` true, so neither an admin nor someone covering them decides it in the app in their place. The PIN stands
  in for the person's own say, never for someone else's: no rule or level skips it.
- An act that asks someone anyway asks them as usual; the person decides it only if the app's rule lets them.
Cards and blocks, and routines that post elsewhere or act for another agent, stay refused. An agent the right hand
asked or told is still refused (no person stands behind its turn). The turn's "# Where you are" line tells the model
to call the tool and say in one line that the person confirms it on the page.

### 2. A page link
`surface_page_links` (`org_id`, `link_id` cascading with the surface link, `user_id`, `kind`, `target_id`,
`token_hash`, `browser_hash`, `created_at`, `opened_at`). The token is 32 random bytes, kept only as its SHA-256.
- Minted when a delivery is listed: the card of an approval the person decides now (`card.kind = "approval"`)
  carries `PUBLIC_URL/surface-page?token=…` instead of the app's link to the message. Other cards, and an approval
  that waits on someone else, keep the app's link. A
  delivery listed twice carries two links; each opens in one browser only.
- The page posts its token (`POST /api/app/surface-page/open`); a GET of the page opens nothing, so a chat app's
  link preview, which only fetches, spends nothing. The first open must come within 10 minutes of minting
  (`PAGE_FIRST_OPEN_MS`). It sets an HttpOnly, SameSite=Strict cookie scoped to `/api/app/surface-page` holding a
  random secret, whose hash is `browser_hash`; from then on only that browser reopens it
  (`surface.page_elsewhere`), until its kind's time from the first open runs out (`PAGE_OPEN_MS`: `confirm` 60
  minutes, `screen` 30, `control` 15; `surface.page_gone`).
- It ends early with the surface link (an unlink from either side, the emailed undo, a new password, "This wasn't
  me", a block, a deleted account: they all delete the link, and the page row cascades), when the person leaves the
  workspace, and when they can no longer see what it shows (`getApproval`'s visibility). Rows are pruned after a day.
- 30 calls per 10 minutes per IP address on the page's routes.

### 3. The PIN
Six digits, on the surface link (`pin_hash`, Bun's argon2id; `pin_failures`; `pin_locked_until`), never in the
chat, the logs or the service. Kept when the same sender moves to another workspace; a new sender or a new link starts
without one, so a new password (which ends the link) clears it too.
- `confirm` page: approving takes the PIN; with none set, the PIN typed (twice, on the page) becomes it. Refusing
  takes none. Who may decide is `decideApproval`'s rule, unchanged.
- Three wrong ones in a row lock approving for 15 minutes (`surface.pin_locked` with `until`); a right one resets the
  count. Each try is counted before its hash is checked, so tries sent at once never get past three.
- "Forgot your PIN?", from the browser that opened the page: an email (`surface_pin_reset`) with a link to
  `/email-undo?kind=surface-pin&token=`, once, within an hour; only that page's button clears the PIN and its lock
  (mail scanners open links). 3 emails an hour per IP address, and 3 an hour for the person whatever the address. Offered only where the server sends email
  (`pin.resetByEmail`); elsewhere unlinking and linking again in the app clears it.

### 4. Not built here
- The `screen` and `control` pages: their lifetimes are set (§2), and a control link will open only after the PIN, but
  showing an agent's live screen outside a signed-in session needs the screen stream to accept a page link instead
  of a session. Until then those links aren't minted and the app's own link stays.
- The chat app's native form for the PIN, which waits on its business verification. It will post to the same
  check (`checkPin`) through the bridge.
- Billing and payment links: paying stays by email, never through a page link from the chat.

## Consequences

- A person on the chat app can now delete, send, change roles and settings, merge or deploy through the right hand
  after typing their PIN on a page of ours, where before they had to open the app.
- A stolen bridge token still can't decide anything once the person has a PIN: it sees page links, but the PIN is
  never sent through it. A person who forwards a fresh page link lets the first browser to open it see the request;
  approving there still takes the PIN. Until the person has chosen a PIN, though, whoever opens a page first (someone
  holding the phone, a forwarded link, the bridge's token) chooses it: the first choice proves nothing more than the
  chat does.
- Self-hosters with a bridge get the same pages; nothing changes without `SURFACE_BRIDGE_TOKEN`.
