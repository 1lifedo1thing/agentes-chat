import { useHeaderHeight } from "expo-router/react-navigation";
import type { ReactElement, ReactNode } from "react";
import { Platform, type RefreshControlProps, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BAR_TITLE_FROM, BAR_TITLE_TO, LargeTitleHead, useLargeTitleScroll } from "@/ui";
import { FadingHeaderTitle } from "@/ui/cover";
import { useColors } from "./hooks";
import { FocusLive, PushedHeader } from "./parts";

/**
 * A pushed screen with a large title (Issues, Drive): the title in Funnel Display is part of the content and
 * scrolls away; the bar's own title fades in as it goes, over a bar the content scrolls under (the system
 * glass on iOS 26). The same shape as the tabs' `LargeTitleScreen` (the same title, fade and settling), without the
 * tab bar's room. `collapsed` folds the large title away (a search field under it took the focus, as the system's
 * search bar does); content that should slide up with it carries a `LinearTransition` layout.
 */
export function PushedLargeTitle({
  title,
  right,
  refreshControl,
  onScrollBeginDrag,
  bottomInset = 24,
  collapsed = false,
  grouped = false,
  keyboard = false,
  dock,
  children,
}: {
  title: string;
  right?: ReactNode;
  refreshControl?: ReactElement<RefreshControlProps>;
  onScrollBeginDrag?: () => void;
  /** Room under the content (a bottom bar over it needs more). */
  bottomInset?: number;
  /** The large title folded away (a search in progress). */
  collapsed?: boolean;
  /** The grouped gray background with white cards on it (Dashboards), as `LargeTitleScreen`'s. */
  grouped?: boolean;
  /** A field in the content or the dock: the content makes room for the keyboard and drags it away. */
  keyboard?: boolean;
  /** What stays at the screen's bottom over the content (a widget's "Ask for a change"), absolutely placed. */
  dock?: ReactNode;
  children?: ReactNode;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  // iOS insets the scroll view by the bar (automatic adjustment): at rest the offset is minus its height.
  const scroll = useLargeTitleScroll(Platform.OS === "ios" ? headerHeight : 0, { snap: !collapsed });
  return (
    <View style={[styles.screen, { backgroundColor: grouped ? c.grouped : c.bg }]}>
      <PushedHeader
        title={<FadingHeaderTitle y={scroll.y} from={BAR_TITLE_FROM} to={BAR_TITLE_TO} text={title} />}
        right={right}
        solid={false}
        grouped={grouped}
      />
      <FocusLive>
        <Animated.ScrollView
          ref={scroll.ref}
          onScroll={scroll.onScroll}
          onScrollBeginDrag={onScrollBeginDrag}
          onScrollEndDrag={scroll.onScrollEndDrag}
          onMomentumScrollEnd={scroll.onMomentumScrollEnd}
          scrollEventThrottle={16}
          contentInsetAdjustmentBehavior="automatic"
          refreshControl={refreshControl}
          keyboardDismissMode={keyboard ? "interactive" : "on-drag"}
          automaticallyAdjustKeyboardInsets={keyboard}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: insets.bottom + bottomInset }}
        >
          <LargeTitleHead y={scroll.y} title={title} collapsed={collapsed} />
          {children}
        </Animated.ScrollView>
      </FocusLive>
      {dock}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
});
