import { type ErrorBoundaryProps, type NativeStackNavigationOptions, Stack } from "expo-router";
import { useMemo } from "react";
import { isStill } from "@/features/links/landing";
import { ScreenError } from "@/features/shared/ScreenError";
import { coverBarOptions, usePushedOptions, useScrollUnderPushedOptions, useTheme } from "@/ui";

/** A link straight to a pushed screen still has the tabs under it (the back button works). */
export const unstable_settings = { anchor: "(tabs)" };

/** A screen that breaks while drawing shows what happened and a way back, instead of closing the app. */
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ScreenError {...props} />;
}

/**
 * The app's screens under its sheets: the native tabs, and the screens pushed over them with the platform's push (the
 * tab bar hides there; the native back button and the edge swipe go back), Você and its screens among them. The
 * sheets present over all of it (`../_layout.tsx`). Header options are set here so the first frame of a push already
 * has its bar; `PushedHeader` fills in the title and actions.
 *
 * Every screen is pushed with its bar over content that scrolls under it unless it is listed in `own`: a new route
 * never ships without a bar and a way back. A screen opened in place (`stillHref`: the start screen at launch) comes
 * in without its slide.
 */
export default function MainStack() {
  const { colors } = useTheme();
  const pushed = usePushedOptions();
  const scrollUnder = useScrollUnderPushedOptions();
  const screenOptions = useMemo(() => {
    const base: NativeStackNavigationOptions = {
      headerShown: false,
      contentStyle: { backgroundColor: colors.bg },
      gestureEnabled: true,
    };
    // Pushed with the opaque bar: lists and composers lay out below it.
    const solid = { ...base, ...pushed };
    // The default: pushed, its content scrolling under the bar.
    const page = { ...solid, ...scrollUnder };
    // Over a full-bleed cover (a sky): a clear bar, the back button over the art.
    const cover = { ...solid, ...coverBarOptions };
    // Screens that only find where to go and replace themselves: no bar, no slide.
    const bare = { ...base, animation: "none" as const };
    const modal = { ...base, presentation: "fullScreenModal" as const };
    const own: Record<string, NativeStackNavigationOptions> = {
      "(tabs)": base,
      "chat/[channelId]": solid,
      "block/[id]": solid,
      "wiki-map": solid,
      "agent/[id]": cover,
      "connectors/[id]": cover,
      // Você: a pushed page with a clear bar over its sky; its screens pushed over it on the grouped gray.
      "me/index": cover,
      // On the sign-in's ruler: its own sky and back circle, no bar.
      "me/team-server": base,
      "me/scan": base,
      "connectors/oauth": bare,
      // A bare link to a browser request: finds its conversation and replaces itself with it.
      "handoff/[id]": bare,
      // A web link that needs a lookup or another workspace first: the bar's back is the way out of a slow one.
      link: { ...solid, animation: "none" },
      // Connect an AI: pushed screens, one question each, on the grouped gray (its bar counts the steps).
      "connect-ai": { ...page, contentStyle: { backgroundColor: colors.grouped } },
      images: {
        ...base,
        presentation: "transparentModal",
        animation: "fade",
        contentStyle: { backgroundColor: "transparent" },
      },
      // A file: pushed with its bar opaque over the file itself (a web view lays out below it, as a block does).
      "file/[id]": solid,
      "computer/[agentId]": modal,
      "browser-profile/[profileId]": modal,
    };
    return ({ route }: { route: { name: string; params?: object } }): NativeStackNavigationOptions => {
      const options = own[route.name] ?? page;
      return isStill(route.params) ? { ...options, animation: "none" } : options;
    };
  }, [colors, pushed, scrollUnder]);
  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}
