# 0228. Quiet when nobody looks, and CLIs held to what works

- Status: Accepted
- Date: 2026-11-24
- Amends: ADR 0036 (the desktop window keeps running the site out of sight), ADR 0070 (the sounds' audio context),
  ADR 0025 and ADR 0059 (what a computer reports about its CLIs and their sign-ins)
- Issues: #949, #1278 (the app at rest); #680, #739, #691, #1133 (CLI turns that fail without saying why)
- Code: ui `packages/ui/src/sight.ts` (`watchSight`, `sight`, `onSight`, `IDLE_MS`, `<html data-sight>`),
  `agent/live.ts` (`agentMotion`, `wakeLiveAgents`), `components/Avatar.tsx`, `sky/engine.ts`; web `main.tsx`,
  `desktop.css` (`html[data-sight="away"|"hidden"]`), `lib/sounds.ts` (`releaseLater`); providers
  `packages/providers/src/cli-floors.ts` (`CLI_FLOORS`, `cliVersionProblem`, `CLI_UPDATE_COMMAND`); adapters
  `machine-protocol.ts` (`model_unavailable`, `empty_answer`, Codex's `loggedIn`/`authMethod`/`plan`); engine
  `brains/select.ts` (`cli_outdated`), `brains/claude-code.ts`, `brains/codex.ts`, `brains/failure-causes.ts`,
  `runs.ts`, `executor.ts`, `brain-settings.ts`, `right-hand.ts`; db `schema/machines.ts` (type only); runner
  `apps/server/runner/codex-sign-in.ts`, `codex-account.ts`, `accounts.ts`, `executors.ts`, `daemon.ts`, `brain.ts`;
  web `components/ai/CliMissing.tsx`, `ConnectAiSteps.tsx`, `pages/agent/brain/BrainDialog.tsx`; phone
  `features/ai/ConnectAiSteps.tsx`, `features/right-hand/SettingsCard.tsx`

## Context

People reported the desktop app heavy at rest. On a Windows laptop left alone, its web view used about 117% of one
core and kept the GPU process busy (#949); on a Mac the output device showed as playing for as long as the app was
open (#1278). The causes were in the site the window loads (ADR 0036), not in the window:

- The agent avatars' shared loop asked for every frame of the screen (144 a second on a 144 Hz display) as long as
  any avatar was mounted, and redrew every visible agent at rest about 12 times a second for its blinks and turns.
  The sidebar always shows agents, so it never stopped.
- The window keeps running its page hidden and in the background (throttling is off so conversations stay live), so
  that loop and the stylesheets' endless loops (typing dots, pulses, shimmers) went on with nobody looking. Only the
  skies stopped, and only Linux's software renderer stopped the loops.
- The sounds' audio context, once switched on by the first click, stayed running: it held the device and fed it
  silence.

At the same time, turns on a computer's CLIs failed in ways nobody could act on: a CLI too old for what we pass it,
a model the sign-in doesn't serve ending the turn with a code, a CLI that ended with nothing, and Codex signed in with
an API key never counting as signed in (#680).

## Decision

### 1. One "is anyone looking" state

`watchSight` (started once by the web app) follows the page's visibility, the window's focus, the pointer and the
person's input, and says one of `hidden` (out of sight), `away` (another window has the focus and the pointer isn't
over this one), `idle` (in sight, no key, click, touch, wheel or pointer move for two minutes) or `present`. The
pointer over the window counts as looking: a window on a second screen, watched while typing in another. `<html
data-sight>` carries it to the stylesheets. Everything that moves on its own follows it:

- **Skies** stand still whenever it isn't `present` (they had their own focus checks and idle timer; both are gone).
- **Agents** (`agentMotion`): present, an agent at work, waiting on someone, making a face or following the gaze
  moves at the full rate, and one under the pointer at rest's rate; an agent at rest or asleep is drawn once in its
  still pose (reduced motion's). Idle, only an agent at work moves: one waiting on someone who isn't at the computer
  would move for hours. Away or hidden, none moves. With nothing moving the loop stops and asks for no frame; a state
  change, the pointer, an avatar scrolling into view or someone looking again starts it.
- **Stylesheet loops** end their round while `away` or `hidden` (`animation-iteration-count: 1`, as the software
  renderer already did); what plays once still plays. Not when merely `idle`: someone reading while an agent works
  still sees it working.

### 2. Audio only to play

The audio context is suspended 1.5 s after the last sound ends and resumed to play the next one. The first click or
key still switches audio on (the browsers' rule); after that the app turns it on by itself. A sound that would start
more than a second late doesn't play.

### 3. A version floor per CLI, judged on the server

`CLI_FLOORS` names, per CLI, the oldest version the code needs and versions known to be broken for us. The server
judges the versions the runner already reports, so changing the list takes a server deploy, never a runner release.
Claude Code is held below 2.1.206 (every command of a turn goes through our permission prompt tool, which crashed on
a cold start before it) and Codex below 0.164.0 (a chat turn turns off that version's features by name). A version
line with no number in it is never held back.

A CLI under its floor shows as `cli_outdated` with the floor and how to update it. Claude Code and Codex offer
"Update" through the installer that already installs them (it brings the newest version); the others show the
command. A run for it waits (wait code `cli_outdated`) without sending the turn, and resumes when the runner reports
the update.

### 4. Failures that say what to do

Two causes join a provider failure: `model_unavailable` (the sign-in or its endpoint doesn't serve the model) and
`empty_answer` (the CLI ended its turn with nothing). Claude Code's runner reports the first itself; for every CLI the
server also reads both from the CLI's own words, so older runners need no update, and a server that doesn't know a
cause drops it. A model refused before any work gets one retry on the CLI's default model in a fresh session; the
refusal is remembered per sign-in for 10 minutes (6 hours for a ChatGPT plan's model list) so it isn't picked again.
A model that can't be retried reads as the provider's "model unavailable", and an empty turn as "ask again, or update
the program".

### 5. Codex's own sign-in from Codex

The runner reads how the computer's own Codex is signed in from Codex's app-server (`account/read`, no token refresh):
a ChatGPT sign-in with its plan, an API key, or a model provider of the person's own config that needs no OpenAI
sign-in. `codex login status` is the fallback, believed only when it reports a sign-in (it now accepts an API key).
The server offers that Codex as the computer's own account, as it does for Claude Code.

## Consequences

- At rest the app draws nothing: no frame loop, no stylesheet loop out of sight, no audio device held. The fix ships
  with the server (the desktop window loads the site), so no desktop release is needed.
- Agents at rest no longer blink or turn on their own; they come alive at work, waiting on you, reacting, or under the
  pointer.
- A CLI too old for us stops failing turns: its agents wait and the person gets one action to fix it.
- Not done here: the loading screen's own avatar loop and minimum time (`apps/desktop`, a desktop release), the
  window's throttling setting (the page now stops its own motion instead), pinning and downloading the CLIs
  ourselves, and reading sign-ins through each CLI's protocol beyond Codex.
