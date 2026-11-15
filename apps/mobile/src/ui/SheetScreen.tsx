import { type ReactNode, useRef } from "react";
import { ScrollView, type ScrollViewInstance, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouteSheetScrollable } from "./Sheet";
import { SheetSurface } from "./SheetSurface";

export interface SheetScreenProps {
  children?: ReactNode;
  /** For a sheet sized to its content (`"auto"`): the sheet ends where the content does on every screen size. */
  fit?: boolean;
}

/**
 * The content of a route sheet (`useRouteSheetOptions`): the system draws the sheet, its grabber, the drag to dismiss
 * and the dimmed screen behind. This is the scrolling body, the sheet's own scroll view (dragging at its top edge moves
 * the sheet, the keyboard insets it), filling a sheet of fixed heights, or sized to its rows with `fit`.
 */
export function SheetScreen({ children, fit }: SheetScreenProps) {
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollViewInstance>(null);
  useRouteSheetScrollable(scroll);
  return (
    <SheetSurface fit={fit}>
      <ScrollView
        ref={scroll}
        style={fit ? undefined : styles.fill}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.in, { paddingBottom: 24 + Math.max(0, insets.bottom - 8) }]}
      >
        {children}
      </ScrollView>
    </SheetSurface>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  in: { paddingHorizontal: 18, paddingTop: 24, gap: 12 },
});
