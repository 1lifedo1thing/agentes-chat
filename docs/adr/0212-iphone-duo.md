# 0212. The iPhone Duo: one phone app that adapts to both screens

- Status: Accepted
- Date: 2026-11-20
- Code: side insets `useSideInsets` in `apps/mobile/src/ui/navigation.tsx` (the screen option presets);
  orientation `apps/mobile/src/lib/orientation.ts` (`homeOrientation`, `followScreens`, `holdOrientation`, used by
  `src/features/computer/useSideways.ts`); two panes `src/ui/two-pane.ts` (`paneFrames`, `WIDE_MIN`) and
  `src/ui/TwoPane.tsx` (`TwoPane`, `useWide`, `DuoProvider`, mounted in `src/providers/AppProviders.tsx`); the native
  module `apps/mobile/modules/duo-layout` (`DuoRegionsView`); the iOS build `.github/workflows/ios.yml`; tests
  `apps/mobile/test/two-pane.test.ts`

## Context

The iPhone Duo folds. Closed, the app runs on its outer display, a phone screen whose side controls sit along one
edge. Open, it runs on the inner display, as wide as a small tablet; partially folded like a book, the curve through
the middle of that display reads poorly and is hard to tap, and iOS describes it as a reserved region of the
"division" kind. The phone app was made for one portrait phone screen: locked upright, one pane at a time, and with
nothing kept clear of a display's sides.

## Decision

1. **One app that adapts, by size class.** Compact width (the outer display, every other iPhone) shows the app as it
   was; regular width (the inner display) shows more of it. No feature depends on a pose (book, tabletop, tent) or on
   the hinge's angle, so everything works the same way on whichever screen, and on Android's large screens too.
2. **Side insets in the screen presets.** The option presets every stack uses (`usePushedOptions`, the tabs' large
   title options, the first run's and the links' screens) pad the content by the window's left and right safe-area
   insets (`useSideInsets`), while its background still fills behind them: the outer display's side controls, a notch
   in landscape. A screen that places its own controls by those insets (an agent's computer) takes none from the
   preset.
3. **Free orientation on a large screen.** The app stays upright on a phone's screen and turns freely on a screen
   whose shortest side is 600 points or more (`LARGE_SCREEN`), which people hold and set down every way; opening or
   closing the device moves the app to the other screen's rule. A screen that holds an orientation of its own (the
   agent's computer, ADR 0098) keeps it while it shows.
4. **Two panes on regular width, split at the fold.** Screens that are a list and its detail (Conversations first)
   show both side by side on a regular-width window, as on the web: the list takes 40% of the width, from 300 to 380
   points, then a hairline, then the detail. When the device is folded like a book, the split moves so the fold falls
   between the panes: the list ends where the fold's region starts and the detail starts where it ends, with nothing
   in the curve (`paneFrames`). Each pane clips its content. A fold at an edge of the row or outside it divides
   nothing, and a fold across the panes (the device folded like a laptop) leaves the split as it is: lists and
   conversations scroll across it, as the system's own lists do.
5. **A small native module reads the fold and the size class**, since React Native exposes neither the reserved
   regions nor the size class. `modules/duo-layout` is a local Expo module, iOS only, with one transparent view nobody
   can touch (`DuoRegionsView`). It reads `reservedRegions(kind: .division, options: .includeInactive)` in
   `updateConstraints()`, where UIKit tracks the regions read and runs it again when they change, picks the first
   region taller than wide that crosses the view, and sends `onRegions` (`{ wide, fold: { x, y, width, height, active }
   | null }`, in the view's own points) only when the size class or that region changed. One such view fills the root
   for `useWide`; each `TwoPane` has its own, so the fold comes in the row's own points. Only an active region moves
   the panes. Where there is no module (Android, a build from before) or before it reports, the window's width decides:
   two panes from 600 points (`WIDE_MIN`), and no fold.
6. **The system's own pieces wherever they exist.** Navigation stays the system's stacks, tabs, sheets and menus, and a
   screen's header buttons are native header items, so the system keeps them clear of the outer display's side
   controls and moves its presentations around the fold; the app reads regions only for the two panes it lays out
   itself.
7. **A screen shown in a pane draws its own bar.** A pane is not a navigation screen, so `PushedHeader` asks `usePane()`:
   outside a pane it sets the native header as before; inside one (`Pane`, `usePaneHeader`) the pane draws the same
   title, line and actions as our icon buttons in one capsule, with no back button (the list is beside it), and gives
   the screen its width and bar height. Any screen built on `PushedHeader` can be a detail pane without changes.
8. **Opening and closing keeps the place.** The conversation open in the split is kept per workspace (`split.ts`).
   Folding to the narrow screen pushes it as a page; unfolding with a conversation on top moves it into the split.
   The draft stays (the composer's own store) and so does the message read last (`reading-place.ts`), which the next
   screen opens at without a highlight: the same message, not the exact pixel.
9. **Xcode 27 for the iOS 27.1 SDK.** The reserved regions are iOS 27.1 API, in the SDK of Xcode 27.1 (Swift 6.4), so
   the iOS build runs on an Xcode 27 runner and takes its newest Xcode. The call is behind `#if compiler(>=6.4)` and
   `if #available(iOS 27.1, *)`: an older Xcode builds the view without it (no fold, the size class still read), and
   iOS before 27.1 runs it the same way.

## Consequences

- The module reaches phones only with a new native build; the JavaScript falls back to the window's width until then.
- Xcode 27.0 has Swift 6.4 but not the iOS 27.1 SDK, so it can't build the module: the iOS build needs Xcode 27.1 or
  later. Xcode 26.4 to 26.6 have Swift 6.3, which the check leaves out.
- On Android a large screen gets two panes by its width, with no fold read; a native fold reader there is a separate
  decision.
- A new list-and-detail screen adopts `TwoPane` and `useWide` rather than measuring the window or the fold itself.
