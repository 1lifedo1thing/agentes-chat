import { type SheetDetent, TrueSheet } from "@lodev09/react-native-true-sheet";
import { useNavigation } from "expo-router";
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Keyboard,
  Platform,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { hintBack } from "./hints";
import { sheetColors } from "./palette";
import { ThemeColorsOverride, useTheme } from "./theme";

export interface SheetProps {
  open: boolean;
  /** The person closed it (a flick down, the scrim, Android's back): the owner sets `open` to false. */
  onClose: () => void;
  children?: ReactNode;
  /**
   * Once the sheet is gone from the screen. Something the system presents (the photo library, the camera) must wait
   * for it: presented over a sheet still leaving, iOS dismisses it with the sheet, and its answer never comes.
   */
  onGone?: () => void;
  /** Pinned over the content while it scrolls (a picker's bar and its search). */
  header?: ReactNode;
}

/** iOS 26 draws its sheets in Liquid Glass when no color is given; before it, and on Android, the sheet's own gray. */
const GLASS = Platform.OS === "ios" && Number.parseInt(String(Platform.Version), 10) >= 26;

/**
 * The bottom sheet (no dialogs on the phone): the system's own, through TrueSheet (iOS's sheet presentation, Android's
 * Material bottom sheet). The system draws it, its grabber and corners, dims the screen, drags it, and lifts it over
 * the keyboard; it takes its content's height, up to the screen's. A sheet presented while another is up stacks over
 * it, as the system's sheets do. Its content is on the sheet's colors (`sheetColors`) and scrolls.
 */
export function Sheet({ open, onClose, children, onGone, header }: SheetProps) {
  const ref = useRef<TrueSheet>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  // Under a header the content starts right away; alone, it leaves the grabber its room.
  const body = useSheetBody(header ? 8 : 24);
  const props = useSheetProps({ open, onClose, onGone, ref });
  return (
    <TrueSheet
      ref={ref}
      {...props}
      scrollableRef={scroll}
      {...(header ? { header: <View style={styles.header}>{header}</View> } : {})}
    >
      <SheetContent>
        <ScrollView
          ref={scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={body}
        >
          {children}
        </ScrollView>
      </SheetContent>
    </TrueSheet>
  );
}

/**
 * The look every sheet of the app shares, the ones a screen opens and the ones that are routes: the system's grabber
 * (named for screen readers) and corners, and Liquid Glass on iOS 26 or the sheet's gray.
 */
function useSheetLook() {
  const { colors, scheme } = useTheme();
  const { t } = useTranslation();
  const inside = useMemo(() => sheetColors(colors, scheme), [colors, scheme]);
  return useMemo(
    () => ({
      grabber: true,
      ...(GLASS ? {} : { backgroundColor: inside.grouped }),
      accessibilityOptions: { grabberLabel: t("mobile.a11y.grabber") },
    }),
    [inside, t],
  );
}

/**
 * The options of a sheet that is a route (`Sheet.Screen` in `app/(app)/_layout.tsx`), on `Sheet`'s look. `detents`:
 * the fractions of the screen it may rest at, or `"auto"` for its content's height; one with fixed heights fills them.
 * Its content tells the sheet which view scrolls (`useRouteSheetScrollable`).
 */
export function useRouteSheetOptions() {
  const look = useSheetLook();
  return useCallback(
    (detents: SheetDetent[]) => ({
      ...look,
      detents,
      ...(detents.includes("auto") ? {} : { style: styles.fill }),
    }),
    [look],
  );
}

/** A route sheet's content: its scroll view is the sheet's own (dragging at its top moves the sheet, the keyboard insets it). */
export function useRouteSheetScrollable(ref: RefObject<ScrollViewInstance | null>) {
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({ scrollableRef: ref } as never);
  }, [navigation, ref]);
}

/**
 * What every sheet a screen opens shares, for `<TrueSheet>`: content-sized, `Sheet`'s look, Android's back (an open ⓘ
 * goes with the sheet), and `open` driving present and dismiss with `onClose` when the person closes it and `onGone`
 * once it is off the screen.
 */
export function useSheetProps({
  open,
  onClose,
  onGone,
  ref,
  presentOnMount = false,
}: {
  open: boolean;
  onClose: () => void;
  onGone?: (() => void) | undefined;
  ref: RefObject<TrueSheet | null>;
  /** Present as it mounts (a sheet pushed over another), rather than when `open` turns true. */
  presentOnMount?: boolean;
}) {
  const look = useSheetLook();
  const shown = useRef(presentOnMount);
  const openRef = useRef(open);
  openRef.current = open;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const goneRef = useRef(onGone);
  goneRef.current = onGone;

  useEffect(() => {
    if (presentOnMount) return;
    if (open) {
      if (shown.current) return;
      shown.current = true;
      // The screen's own field (the composer) lets go of the keyboard first. Kept, iOS gave the keyboard back when
      // the sheet closed and the composer stayed under it.
      Keyboard.dismiss();
      void ref.current?.present();
    } else if (shown.current) {
      void ref.current?.dismiss();
    }
  }, [open, presentOnMount, ref]);

  return {
    ...look,
    detents: ["auto" as const],
    ...(presentOnMount ? { initialDetentIndex: 0 } : {}),
    onDidDismiss: () => {
      shown.current = false;
      // Closed by the person: its owner hears it. Closed by its owner: nothing to tell.
      if (openRef.current) closeRef.current();
      goneRef.current?.();
    },
    // Android's back takes the sheet away, and an ⓘ open in it with it.
    onBackPress: () => {
      hintBack();
    },
  };
}

/**
 * A sheet's content: gestures need their own root in the sheet's window, and it reads the sheet's colors. `fill` for a
 * sheet of fixed heights, whose content fills them.
 */
export function SheetContent({ children, fill = false }: { children: ReactNode; fill?: boolean }) {
  const { colors, scheme } = useTheme();
  const inside = useMemo(() => sheetColors(colors, scheme), [colors, scheme]);
  return (
    <GestureHandlerRootView style={fill ? styles.fill : undefined}>
      <ThemeColorsOverride colors={inside}>{children}</ThemeColorsOverride>
    </GestureHandlerRootView>
  );
}

/** The padding of a sheet's content: 18 at the sides, `top` (room for the grabber), room over the screen's bottom edge. */
export function useSheetBody(top = 24): ViewStyle {
  const insets = useSafeAreaInsets();
  return { paddingHorizontal: 18, paddingTop: top, paddingBottom: 24 + Math.max(0, insets.bottom - 8) };
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // The header spans the sheet, under the grabber's room.
  header: { paddingTop: 24 },
});
