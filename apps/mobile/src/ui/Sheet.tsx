import BottomSheet, {
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
  BottomSheetHandle,
  type BottomSheetHandleProps,
  BottomSheetScrollView,
  useBottomSheetInternal,
} from "@gorhom/bottom-sheet";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  findNodeHandle,
  Keyboard,
  Modal,
  Platform,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { concentricRadius, displayCornerRadius } from "./display-corner";
import { hintBackOr, hintTouches } from "./hints";
import { sheetColors } from "./palette";
import { ThemeColorsOverride, useTheme } from "./theme";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  children?: ReactNode;
  /**
   * Once the sheet is gone from the screen (slid out and its window dismissed). Something the system presents (the
   * photo library, the camera) must wait for it: presented over a sheet still leaving, iOS dismisses it with the
   * sheet, and its answer never comes.
   */
  onGone?: () => void;
  /**
   * Pinned over the content while it scrolls (a picker's bar and its search): it drags the sheet as the grabber does,
   * and a tap still reaches what is in it.
   */
  header?: ReactNode;
}

export interface SheetFrameProps {
  open: boolean;
  /** The person closed it (the scrim, a flick down, Android's back): the owner sets `open` to false. */
  onClose: () => void;
  onGone?: (() => void) | undefined;
  /** Android's back, when it means more than closing (a sheet with pages goes back a page first). */
  onBack?: (() => void) | undefined;
  header?: ReactNode;
  /**
   * The sheet's height without its grabber, for content that can't be measured from outside (pages, each sized to
   * what it shows): null while it isn't known yet, and the sheet waits for it. Left out, the content's own height.
   */
  height?: number | null;
  children: ReactNode;
}

/** After the sheet's window closes, the time iOS takes to dismiss it before something else may be presented. */
const GONE_MS = 80;
/** How far the sheet floats from the screen's edges. */
const INSET = 8;
/** The sheet's top corners (and the least for its bottom ones). */
const RADIUS = 34;
/** The sheet's width with the phone sideways: a form as wide as the phone is hard to read. */
const WIDE_WIDTH = 560;
/** The tallest a sheet gets, as a share of the window's height. */
const MAX_HEIGHT = 0.86;
/** The grabber's strip: 12 over the bar, the bar's 5, 10 under it. */
export const SHEET_GRABBER_HEIGHT = 27;

/** What the drag strip shows under the grabber: the sheet's pinned header, read by the strip (a stable component). */
const HeaderContext = createContext<ReactNode>(null);

/**
 * The bottom sheet (no dialogs on the phone), @gorhom/bottom-sheet in a window of its own over the whole screen: it
 * floats 8 points from the edges, its bottom corners following the screen's curve, on the sheet's own colors (as the
 * system's sheets, `sheetColors`), with a grabber to drag down and a scrim to tap away. Keyboard-aware: with the
 * keyboard up it rises over it, and its content scrolls. The window keeps the sheet in the React tree where it is
 * opened, so its content reads that screen's contexts.
 */
export function SheetFrame({ open, onClose, onGone, onBack, header, height, children }: SheetFrameProps) {
  const { colors, scheme, shadows, reducedMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height: windowHeight } = useWindowDimensions();
  const inside = useMemo(() => sheetColors(colors, scheme), [colors, scheme]);
  const bottomRadius = concentricRadius(
    displayCornerRadius(Platform.OS === "ios" ? "ios" : "android", width, windowHeight, insets.bottom),
    INSET,
    RADIUS,
  );
  const room = width - 2 * Math.max(insets.left, insets.right);
  const sheetWidth = width > windowHeight ? Math.min(WIDE_WIDTH, room) : width - 2 * INSET;
  const maxHeight = Math.round(windowHeight * MAX_HEIGHT);
  const fixed = height !== undefined;
  const snap = fixed && height !== null ? Math.min(height + SHEET_GRABBER_HEIGHT, maxHeight) : null;

  const ref = useRef<BottomSheet>(null);
  const [mounted, setMounted] = useState(open);
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  const openRef = useRef(open);
  openRef.current = open;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  // A sheet sized from outside slides in once its height is known.
  const shown = useRef(false);

  useEffect(() => {
    if (open) {
      if (mountedRef.current) {
        // Opened again while it slid out: it comes back.
        if (shown.current) ref.current?.snapToIndex(0);
        return;
      }
      // The screen's own field (the composer) lets go of the keyboard first. Kept, iOS gave the keyboard back when
      // the sheet closed and the composer stayed under it.
      Keyboard.dismiss();
      setMounted(true);
    } else if (mountedRef.current) {
      ref.current?.close();
    }
  }, [open]);

  useEffect(() => {
    if (!fixed || !mounted || !open || snap === null || shown.current) return;
    shown.current = true;
    ref.current?.snapToIndex(0);
  }, [fixed, mounted, open, snap]);

  const wasMounted = useRef(mounted);
  // Gone, the window still dismisses for a moment on iOS: what follows waits for that too.
  useEffect(() => {
    if (wasMounted.current && !mounted) setTimeout(() => goneRef.current?.(), GONE_MS);
    wasMounted.current = mounted;
  }, [mounted]);

  const fixedRef = useRef(fixed);
  fixedRef.current = fixed;
  // Slid all the way out: by the person (the owner hears it), or because the owner closed it. A sheet that waits for
  // its height starts closed, and the library reports that start as a close: it counts only once the sheet was shown.
  const closed = useCallback(() => {
    if (fixedRef.current && !shown.current) return;
    shown.current = false;
    if (openRef.current) closeRef.current();
    setMounted(false);
  }, []);

  const backdrop = useCallback(
    (props: BottomSheetBackdropProps) => <SheetScrim {...props} color={colors.scrim} />,
    [colors.scrim],
  );

  if (!mounted) return null;
  const sheetStyle: ViewStyle = { marginHorizontal: (width - sheetWidth) / 2, boxShadow: shadows.e3 };
  return (
    // Both ways, or iOS aborts: a window's default is portrait, and a view lying down shares no orientation with it.
    <Modal
      transparent
      visible
      animationType="none"
      statusBarTranslucent
      supportedOrientations={["portrait", "landscape"]}
      onRequestClose={hintBackOr(onBack ?? onClose)}
    >
      {/* Gestures in a window of its own need their own root, and a tap in it away from an open ⓘ closes it. */}
      <GestureHandlerRootView style={styles.fill} {...hintTouches}>
        <HeaderContext.Provider value={header ?? null}>
          <BottomSheet
            ref={ref}
            // Measured content slides in as it mounts; a height from outside waits for its first measure.
            index={fixed ? -1 : 0}
            animateOnMount={!fixed}
            {...(fixed
              ? { enableDynamicSizing: false, snapPoints: [snap ?? 1] }
              : { enableDynamicSizing: true, maxDynamicContentSize: maxHeight })}
            enablePanDownToClose
            onClose={closed}
            detached
            bottomInset={INSET}
            topInset={insets.top + INSET}
            style={sheetStyle}
            backgroundStyle={{
              backgroundColor: inside.grouped,
              borderTopLeftRadius: RADIUS,
              borderTopRightRadius: RADIUS,
              borderBottomLeftRadius: bottomRadius,
              borderBottomRightRadius: bottomRadius,
            }}
            handleComponent={SheetGrabber}
            backdropComponent={backdrop}
            keyboardBehavior="interactive"
            keyboardBlurBehavior="restore"
            android_keyboardInputMode="adjustResize"
            // A sideways swipe is the page's (back to the one before), never the sheet's.
            failOffsetX={[-12, 12]}
            overrideReduceMotion={reducedMotion ? ReduceMotion.Always : ReduceMotion.System}
          >
            <ThemeColorsOverride colors={inside}>
              {fixed ? (
                // Pages slide under the sheet's bottom corners, never past them.
                <View
                  style={[
                    styles.fill,
                    styles.clip,
                    { borderBottomLeftRadius: bottomRadius, borderBottomRightRadius: bottomRadius },
                  ]}
                >
                  {children}
                </View>
              ) : (
                children
              )}
            </ThemeColorsOverride>
            <SheetKeyboard />
          </BottomSheet>
        </HeaderContext.Provider>
      </GestureHandlerRootView>
    </Modal>
  );
}

/** One page of content that scrolls: what most sheets are. */
export function Sheet({ open, onClose, children, onGone, header }: SheetProps) {
  const body = useSheetBody();
  return (
    <SheetFrame open={open} onClose={onClose} onGone={onGone} header={header}>
      <BottomSheetScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={body}
      >
        {children}
      </BottomSheetScrollView>
    </SheetFrame>
  );
}

/** The padding of a sheet's content: 18 at the sides, and room over the screen's bottom edge. */
export function useSheetBody(): ViewStyle {
  const insets = useSafeAreaInsets();
  return { paddingHorizontal: 18, paddingBottom: 24 + Math.max(0, insets.bottom - INSET) };
}

/** The drag strip: the system's grabber (36 × 5, round ends) and the sheet's pinned header under it, which drags too. */
function SheetGrabber(props: BottomSheetHandleProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const header = useContext(HeaderContext);
  return (
    <BottomSheetHandle
      {...props}
      style={[styles.grab, header ? styles.grabOverHeader : null]}
      indicatorStyle={[styles.grabBar, { backgroundColor: colors.grabber }]}
      // With a header in it, its buttons and field are reached one by one; alone, the strip is the grabber.
      accessible={!header}
      accessibilityLabel={t("mobile.a11y.grabber")}
    >
      {header ? <View style={styles.header}>{header}</View> : null}
    </BottomSheetHandle>
  );
}

function SheetScrim({ color, ...props }: BottomSheetBackdropProps & { color: string }) {
  const { t } = useTranslation();
  return (
    <BottomSheetBackdrop
      {...props}
      appearsOnIndex={0}
      disappearsOnIndex={-1}
      opacity={1}
      pressBehavior="close"
      style={[props.style, { backgroundColor: color }]}
      accessibilityLabel={t("mobile.a11y.closeSheet")}
    />
  );
}

/**
 * The sheet rises over the keyboard only once it knows which of its fields took it (its own `BottomSheetTextInput`
 * says so on focus). Every field in a sheet is ours or React Native's, so the focused one is told here as the
 * keyboard comes, and the sheet replays the keyboard it held back.
 */
function SheetKeyboard() {
  const { animatedKeyboardState } = useBottomSheetInternal();
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => {
      const focused = TextInput.State.currentlyFocusedInput();
      const target = focused ? findNodeHandle(focused) : null;
      if (target) animatedKeyboardState.set((s) => ({ ...s, target }));
    });
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => {
      animatedKeyboardState.set((s) => ({ ...s, target: undefined }));
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [animatedKeyboardState]);
  return null;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  clip: { overflow: "hidden" },
  // The whole strip over the content drags, its top edge included.
  grab: { alignItems: "center", paddingTop: 12, paddingBottom: 10 },
  // The header brings its own room under it.
  grabOverHeader: { paddingBottom: 0 },
  grabBar: { width: 36, height: 5, borderRadius: 2.5 },
  // The header spans the sheet under the grabber (the strip centers its bar).
  header: { alignSelf: "stretch", marginTop: 10 },
});
